//! Sparse direct-protocol world writer.
//!
//! The library's `McStructureFile::write_to_world_blocking` builds one placement
//! per cell of the structure's bounding box — void cells included — and clones a
//! full palette entry for each of them, then materializes 4096 owned palette
//! entries for every subchunk it writes (all-void subchunks included). For a
//! 74M-cell box carrying 14.5M real blocks that costs ~43 s of placement building
//! plus ~99 s of chunk writing, and gigabytes of allocation.
//!
//! This path walks the payload once with palette *indices*: the JS encoder emits
//! records grouped by chunk, so one chunk is in memory at a time, and only the
//! subchunks that actually received a block are encoded. Everything the game
//! reads back — subchunk palettes, the biome record that carries the height map,
//! `FinalizedState` and `Version` — still goes through the library's public
//! types, so the on-disk format stays the library's.
//!
//! Only placements without rotation or mirroring use this path; the library
//! writer still owns directional-state transforms.

use bedrock_world::{
    block_storage_index, BedrockWorld, BedrockWorldError, Biome2d, Biome3d, BlockPalette,
    BlockState, Chunk, ChunkKey, ChunkPos, ChunkRecord, ChunkRecordTag, ChunkVersion, Dimension,
    McStructurePaletteEntry, NbtReader, NbtTag, NbtWriter, Result, SubChunk, SubChunkFormat,
    WorldStorageHandle, WorldTransaction,
};
use indexmap::IndexMap;
use std::{collections::{BTreeMap, HashSet}, io::Read};

/// Cells in one 16x16x16 subchunk.
const BLOCKS_PER_SUBCHUNK: usize = 4096;
/// Subchunk payload version written for new records.
const SUBCHUNK_FORMAT_VERSION: u8 = 8;
/// Bedrock block-state version used when a palette entry carries none.
const DEFAULT_BLOCK_VERSION: i32 = 18_002_711;
const AIR_BLOCK_NAME: &str = "minecraft:air";
/// Chunk count between LevelDB commits.
const COMMITS_PER_BATCH: usize = 16;
/// Palette index of air in the payload palette; `UNSET` means "nothing written".
const AIR_INDEX: i32 = 0;
const UNSET: i32 = -1;
/// `FinalizedState` value the library writes for edited chunks.
const FINALIZED_STATE: i32 = 2;
/// Version byte used when the world has none yet (current `LevelChunk` format).
const DEFAULT_CHUNK_VERSION: u8 = 42;

pub struct DirectWriteResult {
    /// Bounding-box volume, reported as `regionCells` by the CLI. Kept under the
    /// wire name `placedBlocks` because the TypeScript side already maps it there.
    pub box_blocks: usize,
    pub affected_chunks: Vec<ChunkPos>,
    pub initialized_chunks: usize,
    pub chunk_version: u8,
    /// What the writer replaced, computed from the chunk it read before writing.
    pub overwrites: Option<Analysis>,
    /// Read-back of the committed chunks, when the caller asked for it.
    pub verification: Option<Analysis>,
}

/// Which extra reports the writer produces. Both read the same accumulator, so
/// callers that only need one pay for one.
#[derive(Default, Clone, Copy)]
pub struct WriteOptions {
    pub initialize_empty_chunks: bool,
    pub report_overwrites: bool,
    pub verify: bool,
    pub patch_existing: bool,
}

/// Header and palette of a `BLKWRDIR` payload, read before any world is opened so
/// a malformed payload never touches a world.
pub struct Payload<R: Read> {
    reader: StreamReader<R>,
    size: [i32; 3],
    palette: Vec<McStructurePaletteEntry>,
}

impl<R: Read> Payload<R> {
    pub fn read(input: R) -> Result<Self> {
        let mut reader = StreamReader::new(input);
        if reader.bytes::<8>()? != *b"BLKWRDIR" {
            return Err(BedrockWorldError::Validation(
                "invalid direct structure magic".into(),
            ));
        }
        if reader.u32()? != 1 {
            return Err(BedrockWorldError::Validation(
                "unsupported direct structure version".into(),
            ));
        }
        let size = [reader.i32()?, reader.i32()?, reader.i32()?];
        let block_version = reader.i32()?;
        let palette_count = usize::try_from(reader.u32()?).map_err(|_| {
            BedrockWorldError::Validation("palette count overflowed".into())
        })?;
        let mut palette = Vec::with_capacity(palette_count + 1);
        palette.push(McStructurePaletteEntry::air());
        for _ in 0..palette_count {
            let name = reader.string()?;
            let state_count = usize::try_from(reader.u32()?).map_err(|_| {
                BedrockWorldError::Validation("state count overflowed".into())
            })?;
            let mut states = BTreeMap::new();
            for _ in 0..state_count {
                let key = reader.string()?;
                let value = match reader.u8()? {
                    0 => NbtTag::String(reader.string()?),
                    1 => NbtTag::Int(reader.i32()?),
                    2 => NbtTag::Byte(if reader.u8()? == 0 { 0 } else { 1 }),
                    _ => {
                        return Err(BedrockWorldError::Validation(
                            "invalid direct state value type".into(),
                        ));
                    }
                };
                states.insert(key, value);
            }
            palette.push(McStructurePaletteEntry {
                name,
                states,
                version: Some(block_version),
            });
        }
        Ok(Self {
            reader,
            size,
            palette,
        })
    }
}

/// One differing cell in an analysis pass.
pub struct Sample {
    pub x: i32,
    pub y: i32,
    pub z: i32,
    pub expected: String,
    pub current: Option<String>,
}

/// Result of comparing a direct payload against the target chunks.
#[derive(Default)]
pub struct Analysis {
    pub cells: usize,
    pub matched: usize,
    /// Current block is solid but differs from the payload (or is cleared).
    pub different: usize,
    /// Payload expects a solid block where the world has air.
    pub empty: usize,
    pub by_block: BTreeMap<String, usize>,
    pub samples: Vec<Sample>,
}

/// How one payload cell compares with the block currently in the world.
enum Probe {
    Matched,
    /// Current block is solid but differs; carries its name.
    Different(String),
    Empty,
}

/// Decoded subchunks for one chunk, parsed lazily once per subchunk.
struct ChunkBlocks {
    subchunks: BTreeMap<i8, Option<SubChunk>>,
    /// Cached once per chunk: legacy terrain makes `Chunk::get_block` the only
    /// source of truth below Y 128, and parsing it for every cell is expensive.
    legacy_terrain: Option<bool>,
    /// A guarded deployment verifies properties as well as block names.
    exact: bool,
}

impl Default for ChunkBlocks {
    fn default() -> Self {
        Self {
            subchunks: BTreeMap::new(),
            legacy_terrain: None,
            exact: false,
        }
    }
}

impl ChunkBlocks {
    /// Compare one cell without cloning its block state. The palette path hands
    /// out a borrowed state, so a matching cell costs no allocation at all; the
    /// name is only materialized for a differing block.
    fn classify(&mut self, chunk: &Chunk, x: u8, y: i32, z: u8, expected: &McStructurePaletteEntry) -> Result<Probe> {
        let subchunk_y = i8::try_from(y.div_euclid(16))
            .map_err(|_| BedrockWorldError::Validation("world y is not a subchunk index".into()))?;
        if !self.subchunks.contains_key(&subchunk_y) {
            let parsed = chunk.get_subchunk(subchunk_y)?;
            self.subchunks.insert(subchunk_y, parsed);
        }
        if let Some(Some(subchunk)) = self.subchunks.get(&subchunk_y) {
            let local_y = u8::try_from(y.rem_euclid(16)).map_err(|_| {
                BedrockWorldError::Validation("world y is not a subchunk offset".into())
            })?;
            if let Some(state) = subchunk.block_state_at(x, local_y, z) {
                return Ok(self.classify_state(state, expected));
            }
            // A subchunk can also carry legacy ids; those need the full lookup.
            if subchunk.legacy_block_id_at(x, local_y, z).is_some() {
                return self.legacy_probe(chunk, x, y, z, expected);
            }
        }
        // An absent layer below Y 128 may still hold legacy terrain. Once that is
        // ruled out the cell is air: going through `get_block` here would build
        // an "unsupported chunk format" error for every empty cell.
        if !self.has_legacy_terrain(chunk, y)? {
            return Ok(classify_name(AIR_BLOCK_NAME, &expected.name));
        }
        self.legacy_probe(chunk, x, y, z, expected)
    }

    fn has_legacy_terrain(&mut self, chunk: &Chunk, y: i32) -> Result<bool> {
        if !(0..=127).contains(&y) {
            return Ok(false);
        }
        if let Some(known) = self.legacy_terrain {
            return Ok(known);
        }
        let known = chunk.legacy_terrain()?.is_some();
        self.legacy_terrain = Some(known);
        Ok(known)
    }

    fn classify_state(&self, state: &BlockState, expected: &McStructurePaletteEntry) -> Probe {
        if self.exact && state.name == expected.name && !states_match(state, expected) {
            Probe::Different(state.name.clone())
        } else {
            classify_name(&state.name, &expected.name)
        }
    }

    fn legacy_probe(&self, chunk: &Chunk, x: u8, y: i32, z: u8, expected: &McStructurePaletteEntry) -> Result<Probe> {
        match chunk.get_block(
            x,
            i16::try_from(y)
                .map_err(|_| BedrockWorldError::Validation("world y does not fit i16".into()))?,
            z,
        ) {
            Ok(state) => Ok(self.classify_state(&state, expected)),
            Err(error)
                if matches!(
                    error.kind(),
                    bedrock_world::BedrockWorldErrorKind::UnsupportedChunkFormat
                ) =>
            {
                Ok(classify_name(AIR_BLOCK_NAME, &expected.name))
            }
            Err(error) => Err(error),
        }
    }
}

/// Compare every cell the accumulator writes with the chunk it applies to.
/// Used both for the pre-write overwrite report and for the post-write readback,
/// so a single pass can answer either question.
fn compare_chunk(
    chunk: &Chunk,
    accumulator: &ChunkAccumulator,
    palette: &[McStructurePaletteEntry],
    stats: &mut Analysis,
    blocks: &mut ChunkBlocks,
) -> Result<()> {
    for (&subchunk_y, layer) in &accumulator.layers {
        for (index, &palette_index) in layer.iter().enumerate() {
            if palette_index == UNSET {
                continue;
            }
            let Some(entry) = usize::try_from(palette_index)
                .ok()
                .and_then(|index| palette.get(index))
            else {
                continue;
            };
            // `block_storage_index` is x*256 + z*16 + y.
            let local_x = u8::try_from(index / 256).unwrap_or(0);
            let local_z = u8::try_from((index % 256) / 16).unwrap_or(0);
            let local_y = u8::try_from(index % 16).unwrap_or(0);
            let world_y = i32::from(subchunk_y) * 16 + i32::from(local_y);
            stats.cells += 1;
            match blocks.classify(chunk, local_x, world_y, local_z, entry)? {
                Probe::Matched => stats.matched += 1,
                Probe::Different(name) => {
                    stats.different += 1;
                    *stats.by_block.entry(name.clone()).or_default() += 1;
                    if stats.samples.len() < 16 {
                        stats.samples.push(Sample {
                            x: chunk.pos.x * 16 + i32::from(local_x),
                            y: world_y,
                            z: chunk.pos.z * 16 + i32::from(local_z),
                            expected: entry.name.clone(),
                            current: Some(name),
                        });
                    }
                }
                Probe::Empty => {
                    stats.empty += 1;
                    if stats.samples.len() < 16 {
                        stats.samples.push(Sample {
                            x: chunk.pos.x * 16 + i32::from(local_x),
                            y: world_y,
                            z: chunk.pos.z * 16 + i32::from(local_z),
                            expected: entry.name.clone(),
                            current: None,
                        });
                    }
                }
            }
        }
    }
    Ok(())
}

fn classify_name(current: &str, expected: &str) -> Probe {
    if current == expected {
        Probe::Matched
    } else if current == AIR_BLOCK_NAME {
        Probe::Empty
    } else {
        Probe::Different(current.to_string())
    }
}

fn states_match(state: &BlockState, expected: &McStructurePaletteEntry) -> bool {
    state.states.len() == expected.states.len() && state.states.iter().all(|(key, value)| {
        expected.states.get(key).is_some_and(|other| {
            value == other || match (value, other) {
                (NbtTag::Byte(a), NbtTag::Int(b)) => i32::from(*a) == *b,
                (NbtTag::Short(a), NbtTag::Int(b)) => i32::from(*a) == *b,
                _ => false,
            }
        })
    })
}

/// Compares every cell of a direct payload with the target world without writing.
///
/// This keeps the read-back proportional to the actual placed cells: the old
/// `.mcstructure` route materialized and parsed the whole bounding box first.
pub fn analyze<S: WorldStorageHandle>(
    world: &BedrockWorld<S>,
    placement: (i32, i32, i32, Dimension),
    payload: &mut Payload<impl Read>,
) -> Result<Analysis> {
    let (origin_x, origin_y, origin_z, dimension) = placement;
    let block_count = usize::try_from(payload.reader.u32()?)
        .map_err(|_| BedrockWorldError::Validation("block count overflowed".into()))?;
    let mut analysis = Analysis::default();
    let mut current: Option<(ChunkPos, Chunk)> = None;
    let mut blocks = ChunkBlocks::default();
    for _ in 0..block_count {
        let x = i32::try_from(payload.reader.u32()?)
            .map_err(|_| BedrockWorldError::Validation("direct x coordinate overflowed".into()))?;
        let y = i32::try_from(payload.reader.u32()?)
            .map_err(|_| BedrockWorldError::Validation("direct y coordinate overflowed".into()))?;
        let z = i32::try_from(payload.reader.u32()?)
            .map_err(|_| BedrockWorldError::Validation("direct z coordinate overflowed".into()))?;
        let palette_index = usize::try_from(payload.reader.u32()?)
            .map_err(|_| BedrockWorldError::Validation("direct palette index overflowed".into()))?;
        if palette_index == 0 || palette_index >= payload.palette.len() {
            return Err(BedrockWorldError::Validation(
                "direct palette index is out of range".into(),
            ));
        }
        let expected = &payload.palette[palette_index];
        let world_x = origin_x
            .checked_add(x)
            .ok_or_else(|| BedrockWorldError::Validation("world x overflowed".into()))?;
        let world_y = origin_y
            .checked_add(y)
            .ok_or_else(|| BedrockWorldError::Validation("world y overflowed".into()))?;
        let world_z = origin_z
            .checked_add(z)
            .ok_or_else(|| BedrockWorldError::Validation("world z overflowed".into()))?;
        let chunk_pos = ChunkPos {
            x: world_x.div_euclid(16),
            z: world_z.div_euclid(16),
            dimension,
        };
        if current.as_ref().map(|(pos, _)| *pos) != Some(chunk_pos) {
            current = Some((chunk_pos, world.get_chunk_blocking(chunk_pos)?));
            blocks = ChunkBlocks::default();
        }
        let (_, chunk) = current.as_ref().expect("current chunk");
        let probe = blocks.classify(
            chunk,
            world_x.rem_euclid(16) as u8,
            world_y,
            world_z.rem_euclid(16) as u8,
            expected,
        )?;
        analysis.cells += 1;
        match probe {
            Probe::Matched => analysis.matched += 1,
            Probe::Different(name) => {
                analysis.different += 1;
                *analysis.by_block.entry(name.clone()).or_default() += 1;
                if analysis.samples.len() < 16 {
                    analysis.samples.push(Sample {
                        x: world_x,
                        y: world_y,
                        z: world_z,
                        expected: expected.name.clone(),
                        current: Some(name),
                    });
                }
            }
            Probe::Empty => {
                analysis.empty += 1;
                if analysis.samples.len() < 16 {
                    analysis.samples.push(Sample {
                        x: world_x,
                        y: world_y,
                        z: world_z,
                        expected: expected.name.clone(),
                        current: None,
                    });
                }
            }
        }
    }
    Ok(analysis)
}

/// Validate the read-only deployment plan after acquiring the writable DB handle.
/// Secondary blocks and block entities require their own editing semantics.
pub fn check_expected<S: WorldStorageHandle>(
    world: &BedrockWorld<S>,
    (origin_x, origin_y, origin_z, dimension): (i32, i32, i32, Dimension),
    payload: &mut Payload<impl Read>,
) -> Result<()> {
    let mut current = None;
    let mut subchunks = BTreeMap::new();
    let mut entities = HashSet::new();
    for _ in 0..payload.reader.u32()? {
        let mut coordinate = |origin: i32, size: i32| {
            let offset = payload.reader.u32()?;
            i32::try_from(offset).ok().filter(|value| *value < size)
                .and_then(|value| origin.checked_add(value))
                .ok_or_else(|| BedrockWorldError::Validation("invalid expected cell coordinate".into()))
        };
        let x = coordinate(origin_x, payload.size[0])?;
        let y = coordinate(origin_y, payload.size[1])?;
        let z = coordinate(origin_z, payload.size[2])?;
        let expected = payload.palette.get(payload.reader.u32()? as usize)
            .ok_or_else(|| BedrockWorldError::Validation("invalid expected cell palette index".into()))?;
        let pos = ChunkPos { x: x.div_euclid(16), z: z.div_euclid(16), dimension };
        if current.as_ref().map(|(pos, _)| *pos) != Some(pos) {
            let chunk = world.get_chunk_blocking(pos)?;
            subchunks.clear();
            entities.clear();
            for record in &chunk.records {
                if record.key.tag == ChunkRecordTag::LegacyTerrain {
                    return Err(BedrockWorldError::Validation("deployment requires modern paletted chunks".into()));
                }
                if record.key.tag != ChunkRecordTag::BlockEntity { continue; }
                let mut bytes = record.value.as_ref();
                while !bytes.is_empty() {
                    let (nbt, consumed) = NbtReader::new(bytes).parse_root_with_consumed()?;
                    let coordinates = match nbt {
                        NbtTag::Compound(values) => match (values.get("x"), values.get("y"), values.get("z")) {
                            (Some(NbtTag::Int(x)), Some(NbtTag::Int(y)), Some(NbtTag::Int(z))) => Some((*x, *y, *z)),
                            _ => None,
                        },
                        _ => None,
                    };
                    entities.insert(coordinates.ok_or_else(|| BedrockWorldError::Validation("block entity has no position".into()))?);
                    bytes = &bytes[consumed..];
                }
            }
            current = Some((pos, chunk));
        }
        let (_, chunk) = current.as_ref().expect("current chunk");
        if entities.contains(&(x, y, z)) {
            return Err(BedrockWorldError::Validation(format!("deployment would replace a block entity at {x},{y},{z}")));
        }
        let sub_y = i8::try_from(y.div_euclid(16))
            .map_err(|_| BedrockWorldError::Validation("invalid expected subchunk height".into()))?;
        if let std::collections::btree_map::Entry::Vacant(slot) = subchunks.entry(sub_y) {
            slot.insert(chunk.get_subchunk(sub_y)?);
        }
        let (lx, ly, lz) = (x.rem_euclid(16) as u8, y.rem_euclid(16) as u8, z.rem_euclid(16) as u8);
        let actual = match &subchunks[&sub_y] {
            Some(subchunk) => {
                let SubChunkFormat::Paletted { storages, .. } = &subchunk.format else {
                    return Err(BedrockWorldError::Validation("deployment requires modern paletted subchunks".into()));
                };
                if storages.len() > 2 {
                    return Err(BedrockWorldError::Validation("cannot merge a subchunk with more than two layers".into()));
                }
                if storages.iter().skip(1).any(|layer| layer.block_state_at(lx, ly, lz).is_some_and(|s| s.name != AIR_BLOCK_NAME)) {
                    return Err(BedrockWorldError::Validation(format!("deployment would replace a secondary block at {x},{y},{z}")));
                }
                storages.first().and_then(|layer| layer.block_state_at(lx, ly, lz))
            }
            None => None,
        };
        let matches = actual.map_or(expected.name == AIR_BLOCK_NAME, |state| {
            state.name == expected.name && states_match(state, expected)
        });
        if !matches {
            return Err(BedrockWorldError::Validation(format!("world changed after deployment planning at {x},{y},{z}")));
        }
    }
    Ok(())
}

/// Writes every record of the payload, one chunk at a time.
pub fn write<S: WorldStorageHandle>(
    world: &BedrockWorld<S>,
    placement: (i32, i32, i32, Dimension),
    payload: &mut Payload<impl Read>,
    options: WriteOptions,
) -> Result<DirectWriteResult> {
    let (origin_x, origin_y, origin_z, dimension) = placement;
    let (size_x, size_y, size_z) = (payload.size[0], payload.size[1], payload.size[2]);
    let block_count = usize::try_from(payload.reader.u32()?).map_err(|_| {
        BedrockWorldError::Validation("block count overflowed".into())
    })?;

    // The dense writer records every subchunk layer of the placement box,
    // including all-air ones. Keep that record set: a finalized chunk that is
    // missing a layer must not fall back to world generation.
    let layer_min = i8::try_from(origin_y.div_euclid(16)).map_err(|_| {
        BedrockWorldError::Validation("box minimum y is not a subchunk index".into())
    })?;
    let layer_max = i8::try_from((origin_y + size_y - 1).div_euclid(16)).map_err(|_| {
        BedrockWorldError::Validation("box maximum y is not a subchunk index".into())
    })?;
    let empty_layer = vec![UNSET; BLOCKS_PER_SUBCHUNK];

    let mut transaction = Some(world.transaction());
    let mut current: Option<(ChunkPos, ChunkAccumulator)> = None;
    let mut affected_chunks = Vec::new();
    let mut written = HashSet::new();
    let mut overwrites = options.report_overwrites.then(Analysis::default);
    let mut verification = options.verify.then(Analysis::default);
    // Chunks flushed since the last commit, kept so the readback can compare
    // what the world returns with the cells this pass asked for.
    let mut pending: Vec<(ChunkPos, ChunkAccumulator)> = Vec::new();
    let palette = &payload.palette;
    for _ in 0..block_count {
        let x = i32::try_from(payload.reader.u32()?).map_err(|_| {
            BedrockWorldError::Validation("direct x coordinate overflowed".into())
        })?;
        let y = i32::try_from(payload.reader.u32()?).map_err(|_| {
            BedrockWorldError::Validation("direct y coordinate overflowed".into())
        })?;
        let z = i32::try_from(payload.reader.u32()?).map_err(|_| {
            BedrockWorldError::Validation("direct z coordinate overflowed".into())
        })?;
        let palette_index = i32::try_from(payload.reader.u32()?).map_err(|_| {
            BedrockWorldError::Validation("direct palette index overflowed".into())
        })?;
        if palette_index <= AIR_INDEX || usize::try_from(palette_index).map_or(true, |index| index >= payload.palette.len())
        {
            return Err(BedrockWorldError::Validation(
                "direct palette index is out of range".into(),
            ));
        }
        let world_x = origin_x
            .checked_add(x)
            .ok_or_else(|| BedrockWorldError::Validation("world x overflowed".into()))?;
        let world_y = origin_y
            .checked_add(y)
            .ok_or_else(|| BedrockWorldError::Validation("world y overflowed".into()))?;
        let world_z = origin_z
            .checked_add(z)
            .ok_or_else(|| BedrockWorldError::Validation("world z overflowed".into()))?;
        let chunk = ChunkPos {
            x: world_x.div_euclid(16),
            z: world_z.div_euclid(16),
            dimension,
        };
        if current.as_ref().map(|(pos, _)| *pos) != Some(chunk) {
            if let Some((previous, accumulator)) = current.take() {
                flush_chunk(
                    world,
                    transaction.as_mut().expect("write transaction"),
                    previous,
                    &accumulator,
                    &palette,
                    (!options.patch_existing).then_some((layer_min, layer_max)),
                    &empty_layer,
                    &mut affected_chunks,
                    &mut overwrites,
                )?;
                if options.initialize_empty_chunks {
                    written.insert((previous.x, previous.z));
                }
                if options.verify {
                    pending.push((previous, accumulator));
                }
                if affected_chunks.len().is_multiple_of(COMMITS_PER_BATCH) {
                    commit_batch(
                        world,
                        &mut transaction,
                        &mut pending,
                        &palette,
                        &mut verification,
                        options.patch_existing,
                    )?;
                }
            }
            current = Some((chunk, ChunkAccumulator::default()));
        }
        let accumulator = &mut current.as_mut().expect("current chunk").1;
        accumulator.set(
            world_y.div_euclid(16),
            world_x.rem_euclid(16) as u8,
            world_y.rem_euclid(16) as u8,
            world_z.rem_euclid(16) as u8,
            palette_index,
        )?;
    }
    if let Some((previous, accumulator)) = current.take() {
        flush_chunk(
            world,
            transaction.as_mut().expect("write transaction"),
            previous,
            &accumulator,
            &palette,
            (!options.patch_existing).then_some((layer_min, layer_max)),
            &empty_layer,
            &mut affected_chunks,
            &mut overwrites,
        )?;
        if options.initialize_empty_chunks {
            written.insert((previous.x, previous.z));
        }
        if options.verify {
            pending.push((previous, accumulator));
        }
    }
    // Box columns that received no block still get their all-air layers, the same
    // set of chunks the dense writer touched.
    if options.initialize_empty_chunks {
        for chunk_x in origin_x.div_euclid(16)..=(origin_x + size_x - 1).div_euclid(16) {
            for chunk_z in origin_z.div_euclid(16)..=(origin_z + size_z - 1).div_euclid(16) {
                if written.contains(&(chunk_x, chunk_z)) {
                    continue;
                }
                flush_chunk(
                    world,
                    transaction.as_mut().expect("write transaction"),
                    ChunkPos {
                        x: chunk_x,
                        z: chunk_z,
                        dimension,
                    },
                    &ChunkAccumulator::default(),
                    &palette,
                    Some((layer_min, layer_max)),
                    &empty_layer,
                    &mut affected_chunks,
                    &mut overwrites,
                )?;
                if affected_chunks.len().is_multiple_of(COMMITS_PER_BATCH) {
                    commit_batch(
                        world,
                        &mut transaction,
                        &mut pending,
                        &palette,
                        &mut verification,
                        options.patch_existing,
                    )?;
                }
            }
        }
    }
    commit_batch(
        world,
        &mut transaction,
        &mut pending,
        &palette,
        &mut verification,
        options.patch_existing,
    )?;

    let chunk_version = affected_chunks
        .iter()
        .filter_map(|pos| world.get_chunk_blocking(*pos).ok()?.version)
        .next()
        .unwrap_or(DEFAULT_CHUNK_VERSION);
    let mut initialized_chunks = 0usize;
    let mut version_transaction = world.transaction();
    for pos in &affected_chunks {
        if world.get_chunk_blocking(*pos)?.version.is_none() {
            version_transaction.put_raw_record(
                &ChunkKey::new(*pos, ChunkRecordTag::Version),
                vec![chunk_version],
            );
            initialized_chunks += 1;
        }
    }
    version_transaction.commit()?;

    Ok(DirectWriteResult {
        box_blocks: usize::try_from(
            i64::from(size_x) * i64::from(size_y) * i64::from(size_z),
        )
        .unwrap_or(0),
        affected_chunks,
        initialized_chunks,
        chunk_version,
        overwrites,
        verification,
    })
}

/// Commit the open transaction, then read back every chunk it covered.
fn commit_batch<'a, S: WorldStorageHandle>(
    world: &'a BedrockWorld<S>,
    transaction: &mut Option<WorldTransaction<'a, S>>,
    pending: &mut Vec<(ChunkPos, ChunkAccumulator)>,
    palette: &[McStructurePaletteEntry],
    verification: &mut Option<Analysis>,
    exact: bool,
) -> Result<()> {
    transaction
        .take()
        .expect("write transaction")
        .commit()?;
    *transaction = Some(world.transaction());
    if let Some(stats) = verification.as_mut() {
        for (pos, accumulator) in pending.drain(..) {
            let chunk = world.get_chunk_blocking(pos)?;
            compare_chunk(
                &chunk,
                &accumulator,
                palette,
                stats,
                &mut ChunkBlocks { exact, ..ChunkBlocks::default() },
            )?;
        }
    } else {
        pending.clear();
    }
    Ok(())
}

/// One chunk's subchunk layers, as palette indices (`UNSET` where untouched).
struct ChunkAccumulator {
    layers: BTreeMap<i8, Vec<i32>>,
    touched: [bool; 256],
}

impl Default for ChunkAccumulator {
    fn default() -> Self {
        Self {
            layers: BTreeMap::new(),
            touched: [false; 256],
        }
    }
}

impl ChunkAccumulator {
    fn set(
        &mut self,
        subchunk_y: i32,
        local_x: u8,
        local_y: u8,
        local_z: u8,
        palette_index: i32,
    ) -> Result<()> {
        let subchunk_y = i8::try_from(subchunk_y).map_err(|_| {
            BedrockWorldError::Validation(format!(
                "world y cannot be represented as a subchunk index: {subchunk_y}"
            ))
        })?;
        let layer = self
            .layers
            .entry(subchunk_y)
            .or_insert_with(|| vec![UNSET; BLOCKS_PER_SUBCHUNK]);
        layer[block_storage_index(local_x, local_y, local_z)] = palette_index;
        self.touched[usize::from(local_z) * 16 + usize::from(local_x)] = true;
        Ok(())
    }
}

fn flush_chunk<S: WorldStorageHandle>(
    world: &BedrockWorld<S>,
    transaction: &mut WorldTransaction<'_, S>,
    pos: ChunkPos,
    accumulator: &ChunkAccumulator,
    palette: &[McStructurePaletteEntry],
    layers: Option<(i8, i8)>,
    empty_layer: &[i32],
    affected_chunks: &mut Vec<ChunkPos>,
    overwrites: &mut Option<Analysis>,
) -> Result<()> {
    let existing = world.get_chunk_blocking(pos)?;
    // The chunk is already in hand for the merge, so the overwrite report costs
    // one comparison instead of a second process and a second payload stream.
    if let Some(stats) = overwrites.as_mut() {
        compare_chunk(
            &existing,
            accumulator,
            palette,
            stats,
            &mut ChunkBlocks::default(),
        )?;
    }
    let layer_indices = match layers {
        Some((min, max)) => (min..=max).collect::<Vec<_>>(),
        None => accumulator.layers.keys().copied().collect(),
    };
    for subchunk_y in layer_indices {
        let layer = accumulator
            .layers
            .get(&subchunk_y)
            .map_or(empty_layer, Vec::as_slice);
        let bytes = encode_subchunk(
            palette,
            layer,
            existing.get_subchunk(subchunk_y)?.as_ref(),
        )?;
        transaction.put_raw_record(&ChunkKey::subchunk(pos, subchunk_y), bytes);
    }
    let (version, mut height_map) = read_height_map(&existing.records)?;
    update_height_map(
        pos,
        version,
        &existing,
        palette,
        &accumulator,
        &mut height_map,
    )?;
    let (tag, bytes) = encode_height_map(&existing.records, height_map)?;
    transaction.put_raw_record(&ChunkKey::new(pos, tag), bytes);
    transaction.put_raw_record(
        &ChunkKey::new(pos, ChunkRecordTag::FinalizedState),
        FINALIZED_STATE.to_le_bytes().to_vec(),
    );
    affected_chunks.push(pos);
    Ok(())
}

/// Packs one subchunk from payload palette indices, merging into the chunk that
/// is already there.
///
/// A payload cell that the model never wrote (VOID) keeps the world's existing
/// block instead of becoming air, and a cell the model did write replaces both
/// storage layers — so appending to a populated world neither erases terrain nor
/// leaves stale waterlogging behind a placed block.
fn encode_subchunk(
    palette: &[McStructurePaletteEntry],
    layer: &[i32],
    existing: Option<&SubChunk>,
) -> Result<Vec<u8>> {
    let storages = match existing.map(|subchunk| &subchunk.format) {
        Some(SubChunkFormat::Paletted { storages, .. }) => storages.as_slice(),
        Some(_) => {
            return Err(BedrockWorldError::UnsupportedChunkFormat(
                "existing subchunk is not a mergeable paletted format".to_string(),
            ));
        }
        None => &[],
    };
    let secondary_used = storages.get(1).is_some_and(|storage| {
        storage
            .states
            .iter()
            .any(|state| state.name != AIR_BLOCK_NAME)
    });

    let air = McStructurePaletteEntry::air();
    let mut states: Vec<PaletteRef> = vec![PaletteRef::Payload(&air)];
    let existing_primary = map_existing(storages.first(), &mut states)?;
    let mut payload_map = vec![u16::MAX; palette.len()];
    let mut indices = Vec::with_capacity(BLOCKS_PER_SUBCHUNK);
    for (cell, &global) in layer.iter().enumerate() {
        let local = if global > AIR_INDEX {
            let entry = &palette[usize::try_from(global).expect("checked by the caller")];
            if entry.name == AIR_BLOCK_NAME {
                0
            } else if payload_map[usize::try_from(global).expect("checked")] != u16::MAX {
                payload_map[usize::try_from(global).expect("checked")]
            } else {
                let index = push_state(&mut states, PaletteRef::Payload(entry))?;
                payload_map[usize::try_from(global).expect("checked")] = index;
                index
            }
        } else {
            existing_local_index(storages.first(), &existing_primary, cell)
        };
        indices.push(local);
    }

    let mut bytes = Vec::with_capacity(2 + BLOCKS_PER_SUBCHUNK * 2 + states.len() * 32);
    bytes.push(SUBCHUNK_FORMAT_VERSION);
    bytes.push(if secondary_used { 2 } else { 1 });
    bytes.extend_from_slice(&encode_layer(&states, &indices)?);

    if secondary_used {
        let storage = storages.get(1).expect("secondary storage");
        let mut secondary_states: Vec<PaletteRef> = vec![PaletteRef::Payload(&air)];
        let secondary_map = map_existing(Some(storage), &mut secondary_states)?;
        let mut secondary_indices = Vec::with_capacity(BLOCKS_PER_SUBCHUNK);
        for (cell, &global) in layer.iter().enumerate() {
            // Placing a block clears whatever occupied the second layer there.
            secondary_indices.push(if global > AIR_INDEX {
                0
            } else {
                existing_local_index(Some(storage), &secondary_map, cell)
            });
        }
        bytes.extend_from_slice(&encode_layer(&secondary_states, &secondary_indices)?);
    }
    Ok(bytes)
}

/// A palette entry from either the payload or the world being merged into.
#[derive(Clone, Copy)]
enum PaletteRef<'a> {
    Payload(&'a McStructurePaletteEntry),
    Existing(&'a BlockState),
}

impl PaletteRef<'_> {
    fn nbt(&self) -> NbtTag {
        let (name, states, version) = match self {
            Self::Payload(entry) => (&entry.name, &entry.states, entry.version),
            Self::Existing(state) => (&state.name, &state.states, state.version),
        };
        NbtTag::Compound(IndexMap::from([
            ("name".to_string(), NbtTag::String(name.clone())),
            (
                "states".to_string(),
                NbtTag::Compound(
                    states
                        .iter()
                        .map(|(key, value)| (key.clone(), value.clone()))
                        .collect(),
                ),
            ),
            (
                "version".to_string(),
                NbtTag::Int(version.unwrap_or(DEFAULT_BLOCK_VERSION)),
            ),
        ]))
    }
}

fn push_state<'a>(states: &mut Vec<PaletteRef<'a>>, state: PaletteRef<'a>) -> Result<u16> {
    let index = u16::try_from(states.len()).map_err(|_| {
        BedrockWorldError::Validation("subchunk palette is too large".into())
    })?;
    states.push(state);
    Ok(index)
}

/// Maps each existing storage palette index to a local one; air maps to nothing.
fn map_existing<'a>(
    storage: Option<&'a BlockPalette>,
    states: &mut Vec<PaletteRef<'a>>,
) -> Result<Vec<Option<u16>>> {
    let Some(storage) = storage else {
        return Ok(Vec::new());
    };
    let mut map = Vec::with_capacity(storage.states.len());
    for state in &storage.states {
        if state.name == AIR_BLOCK_NAME {
            map.push(None);
        } else {
            map.push(Some(push_state(states, PaletteRef::Existing(state))?));
        }
    }
    Ok(map)
}

/// Local palette index of the block already stored at `cell`, or air.
fn existing_local_index(
    storage: Option<&BlockPalette>,
    map: &[Option<u16>],
    cell: usize,
) -> u16 {
    let Some(storage) = storage else { return 0 };
    // Bedrock storage order is X-major: x * 256 + z * 16 + y.
    let (local_x, local_z, local_y) = (
        (cell / 256) as u8,
        ((cell / 16) % 16) as u8,
        (cell % 16) as u8,
    );
    storage
        .palette_index_at(local_x, local_y, local_z)
        .and_then(|index| map.get(usize::from(index)).copied().flatten())
        .unwrap_or(0)
}

/// Serializes one storage layer: bit width, packed indices, palette size, NBT.
fn encode_layer(states: &[PaletteRef<'_>], indices: &[u16]) -> Result<Vec<u8>> {
    let bits = bits_per_palette_index(states.len())?;
    let mut bytes = Vec::new();
    bytes.push(bits << 1);
    if bits > 0 {
        for word in pack_palette_indices(indices, bits)? {
            bytes.extend_from_slice(&word.to_le_bytes());
        }
        let length = i32::try_from(states.len()).map_err(|_| {
            BedrockWorldError::Validation("subchunk palette length does not fit i32".into())
        })?;
        bytes.extend_from_slice(&length.to_le_bytes());
    }
    for state in states {
        bytes.extend_from_slice(&NbtWriter::write_root(&state.nbt())?);
    }
    Ok(bytes)
}

fn bits_per_palette_index(palette_len: usize) -> Result<u8> {
    match palette_len {
        0 | 1 => Ok(0),
        2 => Ok(1),
        3..=4 => Ok(2),
        5..=8 => Ok(3),
        9..=16 => Ok(4),
        17..=32 => Ok(5),
        33..=64 => Ok(6),
        65..=256 => Ok(8),
        257..=4096 => Ok(16),
        _ => Err(BedrockWorldError::Validation(format!(
            "subchunk palette length exceeds 4096: {palette_len}"
        ))),
    }
}

fn pack_palette_indices(indices: &[u16], bits: u8) -> Result<Vec<u32>> {
    if bits == 0 {
        return Ok(Vec::new());
    }
    let values_per_word = usize::from(32 / bits);
    let mask = (1_u32 << bits) - 1;
    let mut words = vec![0_u32; indices.len().div_ceil(values_per_word)];
    for (index, value) in indices.iter().enumerate() {
        let value = u32::from(*value);
        if value > mask {
            return Err(BedrockWorldError::Validation(format!(
                "palette index {value} does not fit {bits} bits"
            )));
        }
        words[index / values_per_word] |= value << ((index % values_per_word) * usize::from(bits));
    }
    Ok(words)
}

/// The height map lives inside the biome record, so it is read back from there.
fn read_height_map(records: &[ChunkRecord]) -> Result<(ChunkVersion, Vec<i16>)> {
    for record in records {
        match record.key.tag {
            ChunkRecordTag::Data3D => {
                return Biome3d::parse(&record.value)
                    .map(|biome| (ChunkVersion::New, biome.height_map));
            }
            ChunkRecordTag::Data2D | ChunkRecordTag::Data2DLegacy => {
                return Biome2d::parse(&record.value)
                    .map(|biome| (ChunkVersion::Old, biome.height_map));
            }
            _ => {}
        }
    }
    Ok((ChunkVersion::New, vec![0; 256]))
}

fn encode_height_map(
    records: &[ChunkRecord],
    height_map: Vec<i16>,
) -> Result<(ChunkRecordTag, Vec<u8>)> {
    for record in records {
        match record.key.tag {
            ChunkRecordTag::Data3D => {
                let biome = Biome3d::parse(&record.value)?;
                return Ok((
                    ChunkRecordTag::Data3D,
                    Biome3d::new(height_map, biome.storages)?.encode()?,
                ));
            }
            ChunkRecordTag::Data2D | ChunkRecordTag::Data2DLegacy => {
                let biome = Biome2d::parse(&record.value)?;
                return Ok((
                    record.key.tag,
                    Biome2d::new(height_map, biome.biomes)?.encode()?,
                ));
            }
            _ => {}
        }
    }
    Ok((
        ChunkRecordTag::Data3D,
        Biome3d::new(height_map, Vec::new())?.encode()?,
    ))
}

/// Raises the height map of every column this chunk actually wrote a block in.
fn update_height_map(
    pos: ChunkPos,
    version: ChunkVersion,
    existing: &Chunk,
    palette: &[McStructurePaletteEntry],
    accumulator: &ChunkAccumulator,
    height_map: &mut [i16],
) -> Result<()> {
    let (min_y, max_y) = pos.y_range(version);
    let mut unresolved = accumulator.touched.iter().filter(|touched| **touched).count();
    let mut resolved = [false; 256];
    for subchunk_y in (min_y.div_euclid(16)..=max_y.div_euclid(16)).rev() {
        if unresolved == 0 {
            break;
        }
        let subchunk_y = i8::try_from(subchunk_y).map_err(|_| {
            BedrockWorldError::Validation(format!(
                "chunk {},{} has an invalid subchunk index",
                pos.x, pos.z
            ))
        })?;
        let updated = accumulator.layers.get(&subchunk_y);
        // Layers this write did not touch still hold blocks; only decode them when
        // a column is still unresolved, which never happens in a fresh world.
        let untouched = if updated.is_none() {
            existing.get_subchunk(subchunk_y)?
        } else {
            None
        };
        for local_z in 0..16_u8 {
            for local_x in 0..16_u8 {
                let column_index = usize::from(local_z) * 16 + usize::from(local_x);
                if !accumulator.touched[column_index] || resolved[column_index] {
                    continue;
                }
                for local_y in (0..16_u8).rev() {
                    let storage_index = block_storage_index(local_x, local_y, local_z);
                    let is_air = match updated {
                        Some(layer) => {
                            let global = layer[storage_index];
                            global <= AIR_INDEX
                                || palette
                                    .get(usize::try_from(global).unwrap_or(usize::MAX))
                                    .is_none_or(|entry| entry.name == AIR_BLOCK_NAME)
                        }
                        None => untouched
                            .as_ref()
                            .is_none_or(|subchunk| existing_cell_is_air(subchunk, local_x, local_y, local_z)),
                    };
                    if !is_air {
                        let surface_y = i32::from(subchunk_y) * 16 + i32::from(local_y);
                        height_map[column_index] = i16::try_from(surface_y - min_y).map_err(|_| {
                            BedrockWorldError::Validation(format!(
                                "chunk {},{} surface height {surface_y} is out of range",
                                pos.x, pos.z
                            ))
                        })?;
                        resolved[column_index] = true;
                        unresolved = unresolved.saturating_sub(1);
                        break;
                    }
                }
            }
        }
    }
    for (column_index, touched) in accumulator.touched.iter().enumerate() {
        if *touched && !resolved[column_index] {
            height_map[column_index] = 0;
        }
    }
    Ok(())
}

fn existing_cell_is_air(subchunk: &SubChunk, local_x: u8, local_y: u8, local_z: u8) -> bool {
    match &subchunk.format {
        SubChunkFormat::Paletted { storages, .. } => storages
            .iter()
            .take(2)
            .filter_map(|storage| storage.block_state_at(local_x, local_y, local_z))
            .all(|state| state.name == AIR_BLOCK_NAME),
        _ => true,
    }
}

/// Minimal exact-length reader over a pipe; the payload is consumed once.
struct StreamReader<R: Read> {
    inner: R,
}

impl<R: Read> StreamReader<R> {
    fn new(inner: R) -> Self {
        Self { inner }
    }
    fn bytes<const N: usize>(&mut self) -> Result<[u8; N]> {
        let mut buffer = [0_u8; N];
        self.inner
            .read_exact(&mut buffer)
            .map_err(BedrockWorldError::Io)?;
        Ok(buffer)
    }
    fn u8(&mut self) -> Result<u8> {
        Ok(self.bytes::<1>()?[0])
    }
    fn u32(&mut self) -> Result<u32> {
        Ok(u32::from_le_bytes(self.bytes::<4>()?))
    }
    fn i32(&mut self) -> Result<i32> {
        Ok(i32::from_le_bytes(self.bytes::<4>()?))
    }
    fn string(&mut self) -> Result<String> {
        let len = usize::try_from(self.u32()?).map_err(|_| {
            BedrockWorldError::Validation("direct string length overflowed".into())
        })?;
        let mut buffer = vec![0_u8; len];
        self.inner
            .read_exact(&mut buffer)
            .map_err(BedrockWorldError::Io)?;
        String::from_utf8(buffer).map_err(|_| {
            BedrockWorldError::Validation("direct structure contains invalid UTF-8".into())
        })
    }
}
