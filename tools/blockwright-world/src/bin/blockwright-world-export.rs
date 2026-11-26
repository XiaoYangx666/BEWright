use bedrock_world::{BedrockWorld, Dimension, McStructureFile, McStructureSize, OpenOptions};
use serde_json::json;
use std::{env, path::PathBuf, process};

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
        "usage: blockwright-world-export --world PATH --output FILE --x N --y N --z N --size-x N --size-y N --size-z N [--dimension N]"
    );
    process::exit(2);
}
fn main() {
    let args: Vec<_> = env::args().skip(1).collect();
    let world_path = PathBuf::from(value(&args, "--world"));
    let output = PathBuf::from(value(&args, "--output"));
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
