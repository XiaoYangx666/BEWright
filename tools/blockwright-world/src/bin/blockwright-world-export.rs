use bedrock_world::{
    BedrockWorld, BedrockWorldError, Dimension, McStructureFile, McStructureSize, NbtTag,
    OpenOptions,
};
use serde::Deserialize;
use serde_json::json;
use std::{
    env,
    io::{self, Write},
    path::PathBuf,
    process,
};

#[derive(Deserialize)]
struct Region {
    min: [i32; 3],
    max: [i32; 3],
}

impl Region {
    fn read(
        &self,
        world: &BedrockWorld,
        dimension: Dimension,
    ) -> bedrock_world::Result<McStructureFile> {
        let edge = |axis: usize| {
            self.max[axis]
                .checked_sub(self.min[axis])
                .filter(|n| (1..=512).contains(n))
                .ok_or_else(|| {
                    BedrockWorldError::Validation("readback tile edge must be 1–512".into())
                })
        };
        let size = McStructureSize {
            x: edge(0)?,
            y: edge(1)?,
            z: edge(2)?,
        };
        if i64::from(size.x) * i64::from(size.y) * i64::from(size.z) > 2_000_000 {
            return Err(BedrockWorldError::Validation(
                "readback tile exceeds two million cells".into(),
            ));
        }
        let [x, y, z] = self.min;
        McStructureFile::from_world_region_blocking(world, dimension, x, y, z, size)
    }
}

fn requested_regions() -> bedrock_world::Result<Vec<Region>> {
    serde_json::from_reader(io::stdin().lock())
        .map_err(|error| BedrockWorldError::Validation(format!("invalid regions: {error}")))
}

/// Write one bounded frame: payload length, palette JSON length, palette,
/// then little-endian u16 indices in x/y/z order (palette entry 0 is air).
fn write_blocks(out: &mut impl Write, region: McStructureFile) -> bedrock_world::Result<()> {
    let mut palette = Vec::with_capacity(region.palette.len());
    for block in region.palette {
        let states = block
            .states
            .into_iter()
            .map(|(name, value)| {
                let value = match value {
                    NbtTag::Byte(value) => json!(value),
                    NbtTag::Short(value) => json!(value),
                    NbtTag::Int(value) => json!(value),
                    NbtTag::String(value) => json!(value),
                    _ => {
                        return Err(BedrockWorldError::Validation(format!(
                            "unsupported state {name} on {}",
                            block.name
                        )));
                    }
                };
                Ok((name, value))
            })
            .collect::<bedrock_world::Result<serde_json::Map<_, _>>>()?;
        palette.push(json!({ "name": block.name, "states": states }));
    }
    let palette = serde_json::to_vec(&palette).map_err(|error| {
        BedrockWorldError::Validation(format!("cannot encode block palette: {error}"))
    })?;
    let mut indices = Vec::with_capacity(region.primary_indices.len() * 2);
    for id in region.primary_indices {
        let index = if id == -1 {
            0
        } else {
            u16::try_from(id).map_err(|_| {
                BedrockWorldError::Validation("readback palette index exceeds u16".into())
            })?
        };
        indices.extend_from_slice(&index.to_le_bytes());
    }
    let length = 4 + palette.len() + indices.len();
    if length > 8 * 1024 * 1024 {
        return Err(BedrockWorldError::Validation(
            "readback frame exceeds 8 MiB".into(),
        ));
    }
    out.write_all(&(length as u32).to_le_bytes())?;
    out.write_all(&(palette.len() as u32).to_le_bytes())?;
    out.write_all(&palette)?;
    out.write_all(&indices)?;
    Ok(())
}

fn value(args: &[String], flag: &str) -> String {
    let index = args
        .iter()
        .position(|arg| arg == flag)
        .unwrap_or_else(|| usage());
    args.get(index + 1).cloned().unwrap_or_else(|| usage())
}
fn number(args: &[String], flag: &str) -> i32 {
    value(args, flag).parse().unwrap_or_else(|_| usage())
}
fn usage() -> ! {
    eprintln!(
        "usage: blockwright-world-export --world PATH --output FILE --x N --y N --z N --size-x N --size-y N --size-z N [--dimension N]\n       blockwright-world-export --world PATH --output DIRECTORY --regions-stdin [--dimension N]\n       blockwright-world-export --world PATH --blocks-stdin [--dimension N]"
    );
    process::exit(2);
}
fn main() {
    let args: Vec<_> = env::args().skip(1).collect();
    let world_path = PathBuf::from(value(&args, "--world"));
    let dimension = match args
        .iter()
        .position(|arg| arg == "--dimension")
        .map(|_| number(&args, "--dimension"))
        .unwrap_or(0)
    {
        0 => Dimension::Overworld,
        1 => Dimension::Nether,
        2 => Dimension::End,
        id => Dimension::Unknown(id),
    };
    let result = (|| -> bedrock_world::Result<()> {
        let world = BedrockWorld::open_blocking(&world_path, OpenOptions::default())?;
        if args.iter().any(|arg| arg == "--blocks-stdin") {
            let mut out = io::BufWriter::new(io::stdout().lock());
            for region in requested_regions()? {
                write_blocks(&mut out, region.read(&world, dimension)?)?;
            }
            out.flush()?;
            return Ok(());
        }
        let output = PathBuf::from(value(&args, "--output"));
        if args.iter().any(|arg| arg == "--regions-stdin") {
            let regions = requested_regions()?;
            for (index, region) in regions.iter().enumerate() {
                region
                    .read(&world, dimension)?
                    .write_to_path(&output.join(format!("{index}.mcstructure")))?;
            }
            println!("{}", json!({"ok":true,"regions":regions.len()}));
            return Ok(());
        }
        let size = McStructureSize {
            x: number(&args, "--size-x"),
            y: number(&args, "--size-y"),
            z: number(&args, "--size-z"),
        };
        let structure = McStructureFile::from_world_region_blocking(
            &world,
            dimension,
            number(&args, "--x"),
            number(&args, "--y"),
            number(&args, "--z"),
            size,
        )?;
        structure.write_to_path(&output)?;
        println!(
            "{}",
            json!({"ok":true,"output":output,"size":[size.x,size.y,size.z]})
        );
        Ok(())
    })();
    if let Err(error) = result {
        eprintln!(
            "{}",
            json!({"ok":false,"error":error.to_string(),"kind":format!("{:?}",error.kind())})
        );
        process::exit(1);
    }
}
