use anvil_nbt::{
    anvil::encode::RegionWriter,
    nbt::{NbtTag, encode::write_named_tag},
};
use flate2::{Compression, write::GzEncoder};
use serde::Deserialize;
use serde_json::json;
use std::{
    collections::{BTreeMap, HashMap},
    env,
    fs::{self, File},
    io::{self, Read},
    path::{Path, PathBuf},
    process,
    time::{SystemTime, UNIX_EPOCH},
};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Payload {
    version: u32,
    name: String,
    game_version: String,
    data_version: i32,
    seed: i64,
    spawn: [i32; 3],
    palette: Vec<BlockState>,
    blocks: Vec<[i32; 4]>,
}

#[derive(Clone, Deserialize)]
struct BlockState {
    name: String,
    properties: BTreeMap<String, String>,
}

struct Chunk {
    sections: BTreeMap<i8, Vec<usize>>,
}

fn compound(entries: impl IntoIterator<Item = (impl Into<String>, NbtTag)>) -> NbtTag {
    NbtTag::Compound(
        entries
            .into_iter()
            .map(|(key, value)| (key.into(), value))
            .collect(),
    )
}

fn parse_args() -> PathBuf {
    let mut args = env::args().skip(1);
    if args.next().as_deref() != Some("--output") {
        eprintln!("usage: blockwright-java-export --output WORLD_DIRECTORY");
        process::exit(2);
    }
    let output = args.next().map(PathBuf::from).unwrap_or_else(|| {
        eprintln!("missing output path");
        process::exit(2);
    });
    if args.next().is_some() {
        eprintln!("unexpected argument");
        process::exit(2);
    }
    output
}

fn state_tag(state: &BlockState) -> NbtTag {
    let mut entries = vec![("Name", NbtTag::String(state.name.clone()))];
    if !state.properties.is_empty() {
        entries.push((
            "Properties",
            compound(
                state
                    .properties
                    .iter()
                    .map(|(key, value)| (key.clone(), NbtTag::String(value.clone()))),
            ),
        ));
    }
    compound(entries)
}

fn packed_block_states(values: &[usize], palette_len: usize) -> Vec<i64> {
    if palette_len <= 1 {
        return Vec::new();
    }
    let bits = (usize::BITS - (palette_len - 1).leading_zeros()).max(4) as usize;
    let per_long = 64 / bits;
    let mut packed = vec![0u64; values.len().div_ceil(per_long)];
    for (index, value) in values.iter().enumerate() {
        packed[index / per_long] |= (*value as u64) << ((index % per_long) * bits);
    }
    packed.into_iter().map(|value| value as i64).collect()
}

fn section_tag(section_y: i8, values: &[usize], global_palette: &[BlockState]) -> NbtTag {
    let mut local_palette = vec![BlockState {
        name: "minecraft:air".into(),
        properties: BTreeMap::new(),
    }];
    let mut local_ids: HashMap<usize, usize> = HashMap::new();
    let mut local_values = Vec::with_capacity(4096);
    for global_id in values {
        let local_id =
            if *global_id == usize::MAX || global_palette[*global_id].name == "minecraft:air" {
                0
            } else if let Some(id) = local_ids.get(global_id) {
                *id
            } else {
                let id = local_palette.len();
                local_palette.push(global_palette[*global_id].clone());
                local_ids.insert(*global_id, id);
                id
            };
        local_values.push(local_id);
    }
    let mut block_states = vec![(
        "palette",
        NbtTag::List(local_palette.iter().map(state_tag).collect()),
    )];
    let packed = packed_block_states(&local_values, local_palette.len());
    if !packed.is_empty() {
        block_states.push(("data", NbtTag::LongArray(packed)));
    }
    compound([
        ("Y", NbtTag::Byte(section_y)),
        ("block_states", compound(block_states)),
        (
            "biomes",
            compound([(
                "palette",
                NbtTag::List(vec![NbtTag::String("minecraft:plains".into())]),
            )]),
        ),
    ])
}

fn chunk_tag(cx: i32, cz: i32, chunk: &Chunk, palette: &[BlockState], data_version: i32) -> NbtTag {
    let sections = chunk
        .sections
        .iter()
        .map(|(y, values)| section_tag(*y, values, palette))
        .collect();
    compound([
        ("DataVersion", NbtTag::Int(data_version)),
        ("xPos", NbtTag::Int(cx)),
        ("yPos", NbtTag::Int(-4)),
        ("zPos", NbtTag::Int(cz)),
        ("Status", NbtTag::String("minecraft:full".into())),
        ("LastUpdate", NbtTag::Long(0)),
        ("InhabitedTime", NbtTag::Long(0)),
        ("isLightOn", NbtTag::Byte(0)),
        ("sections", NbtTag::List(sections)),
        ("block_entities", NbtTag::List(Vec::new())),
        ("block_ticks", NbtTag::List(Vec::new())),
        ("fluid_ticks", NbtTag::List(Vec::new())),
        ("PostProcessing", NbtTag::List(Vec::new())),
        ("Heightmaps", compound(Vec::<(String, NbtTag)>::new())),
        (
            "structures",
            compound([
                ("starts", compound(Vec::<(String, NbtTag)>::new())),
                ("References", compound(Vec::<(String, NbtTag)>::new())),
            ]),
        ),
    ])
}

fn level_data(payload: &Payload) -> NbtTag {
    let last_played = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0);
    compound([(
        "Data",
        compound([
            ("DataVersion", NbtTag::Int(payload.data_version)),
            (
                "Version",
                compound([
                    ("Id", NbtTag::Int(payload.data_version)),
                    ("Name", NbtTag::String(payload.game_version.clone())),
                    ("Series", NbtTag::String("main".into())),
                    ("Snapshot", NbtTag::Byte(0)),
                ]),
            ),
            ("LevelName", NbtTag::String(payload.name.clone())),
            (
                "spawn",
                compound([
                    ("pos", NbtTag::IntArray(payload.spawn.to_vec())),
                    ("pitch", NbtTag::Float(0.0)),
                    ("yaw", NbtTag::Float(0.0)),
                    ("dimension", NbtTag::String("minecraft:overworld".into())),
                ]),
            ),
            (
                "difficulty_settings",
                compound([
                    ("hardcore", NbtTag::Byte(0)),
                    ("locked", NbtTag::Byte(0)),
                    ("difficulty", NbtTag::String("normal".into())),
                ]),
            ),
            ("GameType", NbtTag::Int(1)),
            ("allowCommands", NbtTag::Byte(1)),
            ("initialized", NbtTag::Byte(1)),
            ("version", NbtTag::Int(19133)),
            ("Time", NbtTag::Long(0)),
            ("LastPlayed", NbtTag::Long(last_played)),
            (
                "DataPacks",
                compound([
                    (
                        "Enabled",
                        NbtTag::List(vec![NbtTag::String("vanilla".into())]),
                    ),
                    ("Disabled", NbtTag::List(Vec::new())),
                ]),
            ),
        ]),
    )])
}

fn dimension(generator: NbtTag, kind: &str) -> NbtTag {
    compound([
        ("type", NbtTag::String(kind.into())),
        ("generator", generator),
    ])
}

fn noise_generator(settings: &str, biome_source: NbtTag) -> NbtTag {
    compound([
        ("type", NbtTag::String("minecraft:noise".into())),
        ("biome_source", biome_source),
        ("settings", NbtTag::String(settings.into())),
    ])
}

fn world_gen_settings_data(payload: &Payload) -> NbtTag {
    let overworld = dimension(
        compound([
            ("type", NbtTag::String("minecraft:flat".into())),
            (
                "settings",
                compound([
                    (
                        "layers",
                        NbtTag::List(vec![
                            compound([
                                ("block", NbtTag::String("minecraft:bedrock".into())),
                                ("height", NbtTag::Int(1)),
                            ]),
                            compound([
                                ("block", NbtTag::String("minecraft:dirt".into())),
                                ("height", NbtTag::Int(2)),
                            ]),
                            compound([
                                ("block", NbtTag::String("minecraft:grass_block".into())),
                                ("height", NbtTag::Int(1)),
                            ]),
                        ]),
                    ),
                    ("features", NbtTag::Byte(0)),
                    ("lakes", NbtTag::Byte(0)),
                    ("structure_overrides", NbtTag::List(Vec::new())),
                    ("biome", NbtTag::String("minecraft:plains".into())),
                ]),
            ),
        ]),
        "minecraft:overworld",
    );
    let nether = dimension(
        noise_generator(
            "minecraft:nether",
            compound([
                ("type", NbtTag::String("minecraft:multi_noise".into())),
                ("preset", NbtTag::String("minecraft:nether".into())),
            ]),
        ),
        "minecraft:the_nether",
    );
    let end = dimension(
        noise_generator(
            "minecraft:end",
            compound([("type", NbtTag::String("minecraft:the_end".into()))]),
        ),
        "minecraft:the_end",
    );
    compound([
        ("DataVersion", NbtTag::Int(payload.data_version)),
        (
            "data",
            compound([
                ("generate_structures", NbtTag::Byte(1)),
                ("seed", NbtTag::Long(payload.seed)),
                (
                    "dimensions",
                    compound([
                        ("minecraft:the_nether", nether),
                        ("minecraft:overworld", overworld),
                        ("minecraft:the_end", end),
                    ]),
                ),
                ("bonus_chest", NbtTag::Byte(0)),
            ]),
        ),
    ])
}

fn write_world(
    root: &Path,
    payload: &Payload,
) -> Result<(usize, usize), Box<dyn std::error::Error>> {
    fs::create_dir(root)?;
    fs::write(root.join("session.lock"), [0xe2, 0x98, 0x83])?;
    let level = File::create(root.join("level.dat"))?;
    let mut gzip = GzEncoder::new(level, Compression::default());
    write_named_tag(&mut gzip, "", &level_data(payload))?;
    gzip.finish()?;
    fs::copy(root.join("level.dat"), root.join("level.dat_old"))?;
    let data_dir = root.join("data").join("minecraft");
    fs::create_dir_all(&data_dir)?;
    let settings = File::create(data_dir.join("world_gen_settings.dat"))?;
    let mut settings_gzip = GzEncoder::new(settings, Compression::default());
    write_named_tag(&mut settings_gzip, "", &world_gen_settings_data(payload))?;
    settings_gzip.finish()?;
    let region_dir = root
        .join("dimensions")
        .join("minecraft")
        .join("overworld")
        .join("region");
    fs::create_dir_all(&region_dir)?;
    let mut chunks: BTreeMap<(i32, i32), Chunk> = BTreeMap::new();
    for [x, y, z, palette_id] in &payload.blocks {
        if *y < -64 || *y >= 320 {
            return Err(format!("block Y {y} is outside -64..319").into());
        }
        let palette_id = usize::try_from(*palette_id).map_err(|_| "negative palette index")?;
        if palette_id >= payload.palette.len() {
            return Err(format!("palette index {palette_id} is out of range").into());
        }
        let cx = x.div_euclid(16);
        let cz = z.div_euclid(16);
        let sy = y.div_euclid(16) as i8;
        let chunk = chunks.entry((cx, cz)).or_insert_with(|| Chunk {
            sections: BTreeMap::new(),
        });
        let section = chunk
            .sections
            .entry(sy)
            .or_insert_with(|| vec![usize::MAX; 4096]);
        let index = (y.rem_euclid(16) * 256 + z.rem_euclid(16) * 16 + x.rem_euclid(16)) as usize;
        section[index] = palette_id;
    }
    let mut regions: BTreeMap<(i32, i32), Vec<(i32, i32, String, NbtTag)>> = BTreeMap::new();
    for ((cx, cz), chunk) in &chunks {
        regions
            .entry((cx.div_euclid(32), cz.div_euclid(32)))
            .or_default()
            .push((
                *cx,
                *cz,
                String::new(),
                chunk_tag(*cx, *cz, chunk, &payload.palette, payload.data_version),
            ));
    }
    for ((rx, rz), region_chunks) in &regions {
        let file = File::create(region_dir.join(format!("r.{rx}.{rz}.mca")))?;
        RegionWriter::new(file).write_all_chunks(region_chunks)?;
    }
    Ok((chunks.len(), regions.len()))
}

fn run(output: &Path) -> Result<serde_json::Value, Box<dyn std::error::Error>> {
    if output.exists() {
        return Err(format!("refusing to overwrite {}", output.display()).into());
    }
    let mut input = String::new();
    io::stdin().read_to_string(&mut input)?;
    let payload: Payload = serde_json::from_str(&input)?;
    if payload.version != 1 {
        return Err(format!("unsupported payload version {}", payload.version).into());
    }
    if payload.name.trim().is_empty() {
        return Err("world name must not be empty".into());
    }
    let parent = output.parent().unwrap_or_else(|| Path::new("."));
    fs::create_dir_all(parent)?;
    let file_name = output
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("world");
    let temp = parent.join(format!(".{file_name}.blockwright-tmp-{}", process::id()));
    if temp.exists() {
        return Err(format!("temporary path already exists: {}", temp.display()).into());
    }
    match write_world(&temp, &payload) {
        Ok((chunks, regions)) => {
            fs::rename(&temp, output)?;
            Ok(json!({
                "ok": true,
                "chunks": chunks,
                "regions": regions,
                "blocks": payload.blocks.len(),
                "dataVersion": payload.data_version
            }))
        }
        Err(error) => {
            let _ = fs::remove_dir_all(&temp);
            Err(error)
        }
    }
}

fn main() {
    let output = parse_args();
    match run(&output) {
        Ok(report) => println!("{report}"),
        Err(error) => {
            eprintln!("{}", json!({"ok": false, "error": error.to_string()}));
            process::exit(1);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use anvil_nbt::anvil::access::Region;

    #[test]
    fn writes_parseable_negative_and_positive_chunks() {
        let root = env::temp_dir().join(format!(
            "blockwright-java-export-test-{}-{}",
            process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let payload = Payload {
            version: 1,
            name: "Blockwright test".into(),
            game_version: "26.1.2".into(),
            data_version: 4790,
            seed: 7,
            spawn: [0, 1, 0],
            palette: vec![BlockState {
                name: "minecraft:stone".into(),
                properties: BTreeMap::new(),
            }],
            blocks: vec![[-1, -64, 16, 0], [0, 0, 0, 0]],
        };
        let (chunks, regions) = write_world(&root, &payload).unwrap();
        assert_eq!((chunks, regions), (2, 2));
        assert!(root.join("level.dat").is_file());
        assert!(root.join("level.dat_old").is_file());
        assert!(root
            .join("data/minecraft/world_gen_settings.dat")
            .is_file());
        let negative =
            Region::open(root.join("dimensions/minecraft/overworld/region/r.-1.0.mca")).unwrap();
        let (_, chunk) = negative.get_chunk_nbt(-1, 1).unwrap().unwrap();
        let NbtTag::Compound(root_tag) = chunk else {
            panic!("chunk root is not a compound")
        };
        assert_eq!(root_tag.get("xPos"), Some(&NbtTag::Int(-1)));
        assert_eq!(root_tag.get("zPos"), Some(&NbtTag::Int(1)));
        assert_eq!(root_tag.get("DataVersion"), Some(&NbtTag::Int(4790)));
        fs::remove_dir_all(root).unwrap();
    }
}
