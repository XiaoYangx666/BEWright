use bedrock_world::{
    BedrockWorld, ChunkKey, ChunkPos, ChunkRecordTag, Dimension, McStructureFile,
    McStructurePaletteEntry, McStructurePlacement, McStructureRotation, McStructureSize, NbtTag,
    OpenOptions, WriteGuard,
};
use serde_json::json;
use std::{
    collections::BTreeMap,
    env,
    io::{self, Read},
    path::PathBuf,
    process,
};

mod direct;

/// World-write counts reported to the CLI, identical for both write paths.
struct Outcome {
    touched_chunks: usize,
    /// Bounding-box volume; the CLI reports this as `regionCells`.
    placed_blocks: usize,
    initialized_chunks: usize,
    chunk_version: u8,
}

#[derive(Debug)]
struct Args {
    world: PathBuf,
    structure: Option<PathBuf>,
    direct_stdin: bool,
    analyze: bool,
    skip_empty_chunks: bool,
    x: i32,
    y: i32,
    z: i32,
    dimension: i32,
    rotation: McStructureRotation,
    mirror_x: bool,
    mirror_z: bool,
}

fn usage() -> ! {
    eprintln!(
        "usage: blockwright-world place --world PATH (--structure FILE | --direct-stdin) --x N --y N --z N [--dimension N] [--rotation 0|90|180|270] [--mirror-x] [--mirror-z] [--skip-empty-chunks] [--analyze]"
    );
    process::exit(2);
}

fn parse() -> Args {
    let mut input = env::args().skip(1);
    if input.next().as_deref() != Some("place") {
        usage();
    }
    let mut world = None;
    let mut structure = None;
    let mut direct_stdin = false;
    let mut analyze = false;
    let mut skip_empty_chunks = false;
    let (mut x, mut y, mut z, mut dimension) = (None, None, None, 0);
    let mut rotation = McStructureRotation::None;
    let (mut mirror_x, mut mirror_z) = (false, false);
    while let Some(flag) = input.next() {
        let value =
            |input: &mut std::iter::Skip<env::Args>| input.next().unwrap_or_else(|| usage());
        match flag.as_str() {
            "--world" => world = Some(PathBuf::from(value(&mut input))),
            "--structure" => structure = Some(PathBuf::from(value(&mut input))),
            "--direct-stdin" => direct_stdin = true,
            "--analyze" => analyze = true,
            "--skip-empty-chunks" => skip_empty_chunks = true,
            "--x" => x = value(&mut input).parse().ok(),
            "--y" => y = value(&mut input).parse().ok(),
            "--z" => z = value(&mut input).parse().ok(),
            "--dimension" => dimension = value(&mut input).parse().unwrap_or_else(|_| usage()),
            "--rotation" => {
                rotation = match value(&mut input).as_str() {
                    "0" => McStructureRotation::None,
                    "90" => McStructureRotation::Clockwise90,
                    "180" => McStructureRotation::Rotate180,
                    "270" => McStructureRotation::CounterClockwise90,
                    _ => usage(),
                }
            }
            "--mirror-x" => mirror_x = true,
            "--mirror-z" => mirror_z = true,
            _ => usage(),
        }
    }
    if direct_stdin == structure.is_some() {
        usage();
    }
    if analyze && !direct_stdin {
        usage();
    }
    Args {
        world: world.unwrap_or_else(|| usage()),
        structure,
        direct_stdin,
        analyze,
        skip_empty_chunks,
        x: x.unwrap_or_else(|| usage()),
        y: y.unwrap_or_else(|| usage()),
        z: z.unwrap_or_else(|| usage()),
        dimension,
        rotation,
        mirror_x,
        mirror_z,
    }
}

struct DirectReader {
    bytes: Vec<u8>,
    offset: usize,
}

impl DirectReader {
    fn new(bytes: Vec<u8>) -> Self {
        Self { bytes, offset: 0 }
    }
    fn take(&mut self, count: usize) -> bedrock_world::Result<&[u8]> {
        let end = self.offset.checked_add(count).ok_or_else(|| {
            bedrock_world::BedrockWorldError::Validation("direct input length overflowed".into())
        })?;
        if end > self.bytes.len() {
            return Err(bedrock_world::BedrockWorldError::Validation(
                "truncated direct structure input".into(),
            ));
        }
        let result = &self.bytes[self.offset..end];
        self.offset = end;
        Ok(result)
    }
    fn u8(&mut self) -> bedrock_world::Result<u8> {
        Ok(self.take(1)?[0])
    }
    fn u32(&mut self) -> bedrock_world::Result<u32> {
        Ok(u32::from_le_bytes(self.take(4)?.try_into().unwrap()))
    }
    fn i32(&mut self) -> bedrock_world::Result<i32> {
        Ok(i32::from_le_bytes(self.take(4)?.try_into().unwrap()))
    }
    fn string(&mut self) -> bedrock_world::Result<String> {
        let len = usize::try_from(self.u32()?).map_err(|_| {
            bedrock_world::BedrockWorldError::Validation("direct string length overflowed".into())
        })?;
        String::from_utf8(self.take(len)?.to_vec()).map_err(|_| {
            bedrock_world::BedrockWorldError::Validation(
                "direct structure contains invalid UTF-8".into(),
            )
        })
    }
}

fn read_direct_structure() -> bedrock_world::Result<McStructureFile> {
    let mut bytes = Vec::new();
    io::stdin()
        .read_to_end(&mut bytes)
        .map_err(|error| bedrock_world::BedrockWorldError::Io(error))?;
    let mut reader = DirectReader::new(bytes);
    if reader.take(8)? != b"BLKWRDIR" {
        return Err(bedrock_world::BedrockWorldError::Validation(
            "invalid direct structure magic".into(),
        ));
    }
    if reader.u32()? != 1 {
        return Err(bedrock_world::BedrockWorldError::Validation(
            "unsupported direct structure version".into(),
        ));
    }
    let size = McStructureSize::new(reader.i32()?, reader.i32()?, reader.i32()?)?;
    let block_version = reader.i32()?;
    let palette_count = usize::try_from(reader.u32()?).map_err(|_| {
        bedrock_world::BedrockWorldError::Validation("palette count overflowed".into())
    })?;
    let mut palette = Vec::with_capacity(palette_count + 1);
    palette.push(McStructurePaletteEntry::air());
    for _ in 0..palette_count {
        let name = reader.string()?;
        let state_count = usize::try_from(reader.u32()?).map_err(|_| {
            bedrock_world::BedrockWorldError::Validation("state count overflowed".into())
        })?;
        let mut states = BTreeMap::new();
        for _ in 0..state_count {
            let key = reader.string()?;
            let value = match reader.u8()? {
                0 => NbtTag::String(reader.string()?),
                1 => NbtTag::Int(reader.i32()?),
                2 => NbtTag::Byte(if reader.u8()? == 0 { 0 } else { 1 }),
                _ => {
                    return Err(bedrock_world::BedrockWorldError::Validation(
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
    let mut structure = McStructureFile::new_air(size, [0, 0, 0])?;
    structure.palette = palette;
    // Keep VOID distinct from explicit minecraft:air. The direct protocol only
    // sends occupied/explicit-air cells; omitted cells must remain untouched.
    structure.primary_indices.fill(-1);
    let block_count = usize::try_from(reader.u32()?).map_err(|_| {
        bedrock_world::BedrockWorldError::Validation("block count overflowed".into())
    })?;
    for _ in 0..block_count {
        let x = i32::try_from(reader.u32()?).map_err(|_| {
            bedrock_world::BedrockWorldError::Validation("direct x coordinate overflowed".into())
        })?;
        let y = i32::try_from(reader.u32()?).map_err(|_| {
            bedrock_world::BedrockWorldError::Validation("direct y coordinate overflowed".into())
        })?;
        let z = i32::try_from(reader.u32()?).map_err(|_| {
            bedrock_world::BedrockWorldError::Validation("direct z coordinate overflowed".into())
        })?;
        let palette_index = usize::try_from(reader.u32()?).map_err(|_| {
            bedrock_world::BedrockWorldError::Validation("direct palette index overflowed".into())
        })?;
        if palette_index == 0 || palette_index >= structure.palette.len() {
            return Err(bedrock_world::BedrockWorldError::Validation(
                "direct palette index is out of range".into(),
            ));
        }
        let index = size.index(x, y, z)?;
        structure.primary_indices[index] = i32::try_from(palette_index).map_err(|_| {
            bedrock_world::BedrockWorldError::Validation("palette index does not fit i32".into())
        })?;
    }
    if reader.offset != reader.bytes.len() {
        return Err(bedrock_world::BedrockWorldError::Validation(
            "trailing bytes in direct structure input".into(),
        ));
    }
    Ok(structure)
}

fn run(args: Args) -> bedrock_world::Result<()> {
    // The sparse path owns no directional-state transform, so a rotated or
    // mirrored placement keeps using the library writer.
    let sparse = args.direct_stdin
        && matches!(args.rotation, McStructureRotation::None)
        && !args.mirror_x
        && !args.mirror_z;
    if args.skip_empty_chunks && !sparse {
        usage();
    }
    // Parse (and validate) the payload before touching the world, so a malformed
    // payload never creates or edits one.
    let mut payload = if sparse {
        Some(direct::Payload::read(io::stdin().lock())?)
    } else {
        None
    };
    let structure = if sparse {
        None
    } else if args.direct_stdin {
        Some(read_direct_structure()?)
    } else {
        Some(McStructureFile::read_from_path(
            args.structure.as_ref().expect("structure path"),
        )?)
    };
    let world = BedrockWorld::open_blocking(
        &args.world,
        OpenOptions {
            read_only: false,
            ..OpenOptions::default()
        },
    )?;
    let dimension = match args.dimension {
        0 => Dimension::Overworld,
        1 => Dimension::Nether,
        2 => Dimension::End,
        id => Dimension::Unknown(id),
    };
    if args.analyze {
        let Some(payload) = payload.as_mut() else {
            usage()
        };
        if !matches!(args.rotation, McStructureRotation::None) || args.mirror_x || args.mirror_z {
            usage();
        }
        let analysis = direct::analyze(&world, (args.x, args.y, args.z, dimension), payload)?;
        let samples: Vec<_> = analysis
            .samples
            .iter()
            .map(|sample| {
                json!({
                    "x": sample.x,
                    "y": sample.y,
                    "z": sample.z,
                    "expected": sample.expected,
                    "current": sample.current,
                })
            })
            .collect();
        println!(
            "{}",
            json!({"ok":true,"analysis":{
                "cells":analysis.cells,
                "matched":analysis.matched,
                "different":analysis.different,
                "empty":analysis.empty,
                "byBlock":analysis.by_block,
                "samples":samples,
            }})
        );
        return Ok(());
    }
    let guard = WriteGuard::confirmed(&args.world, "place Blockwright structure");
    let outcome = if let Some(payload) = payload.as_mut() {
        let result = direct::write(
            &world,
            (args.x, args.y, args.z, dimension),
            payload,
            !args.skip_empty_chunks,
        )?;
        Outcome {
            touched_chunks: result.affected_chunks.len(),
            placed_blocks: result.box_blocks,
            initialized_chunks: result.initialized_chunks,
            chunk_version: result.chunk_version,
        }
    } else {
        let structure = structure.expect("non-sparse direct read");
        let result = structure.write_to_world_blocking(
            &world,
            McStructurePlacement {
                source_anchor: ChunkPos {
                    x: 0,
                    z: 0,
                    dimension,
                },
                target_anchor: ChunkPos {
                    x: args.x.div_euclid(16),
                    z: args.z.div_euclid(16),
                    dimension,
                },
                origin_y: args.y,
                rotation: args.rotation,
                mirror_x: args.mirror_x,
                mirror_z: args.mirror_z,
            },
            &guard,
            |progress| eprintln!("{progress:?}"),
        )?;
        // bedrock-world 0.4.0 writes subchunks, Data3D and FinalizedState for a new
        // chunk but currently omits the Version record. Bedrock ignores those
        // otherwise valid records and may regenerate the chunk, leaving only the
        // parts placed in chunks that already existed. Reuse the world's current
        // version byte, falling back to 42 (the current LevelChunk format).
        let chunk_version = result
            .affected_chunks
            .iter()
            .filter_map(|pos| world.get_chunk_blocking(*pos).ok()?.version)
            .next()
            .unwrap_or(42);
        let mut initialized_chunks = 0usize;
        let mut transaction = world.transaction();
        for pos in &result.affected_chunks {
            if world.get_chunk_blocking(*pos)?.version.is_none() {
                transaction.put_raw_record(
                    &ChunkKey::new(*pos, ChunkRecordTag::Version),
                    vec![chunk_version],
                );
                initialized_chunks += 1;
            }
        }
        transaction.commit()?;
        Outcome {
            touched_chunks: result.affected_chunks.len(),
            placed_blocks: result.placed_blocks,
            initialized_chunks,
            chunk_version,
        }
    };
    println!(
        "{}",
        json!({"ok":true,"touchedChunks":outcome.touched_chunks,"placedBlocks":outcome.placed_blocks,"initializedChunks":outcome.initialized_chunks,"chunkVersion":outcome.chunk_version})
    );
    Ok(())
}

fn main() {
    let args = parse();
    if let Err(error) = run(args) {
        eprintln!(
            "{}",
            json!({"ok":false,"error":error.to_string(),"kind":format!("{:?}", error.kind())})
        );
        process::exit(1);
    }
}
