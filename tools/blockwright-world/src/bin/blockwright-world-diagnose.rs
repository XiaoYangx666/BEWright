use bedrock_world::{BedrockWorld, ChunkPos, ChunkRecordTag, Dimension, OpenOptions};
use serde_json::json;
use std::{env, path::PathBuf, process};

fn main() {
    let args: Vec<_> = env::args().skip(1).collect();
    let value = |flag: &str| {
        args.iter()
            .position(|arg| arg == flag)
            .and_then(|i| args.get(i + 1))
            .cloned()
            .unwrap_or_else(|| {
                eprintln!("missing {flag}");
                process::exit(2)
            })
    };
    let number = |flag: &str| {
        value(flag).parse::<i32>().unwrap_or_else(|_| {
            eprintln!("invalid {flag}");
            process::exit(2)
        })
    };
    let world =
        BedrockWorld::open_blocking(PathBuf::from(value("--world")), OpenOptions::default())
            .unwrap_or_else(|e| {
                eprintln!("{e}");
                process::exit(1)
            });
    let mut rows = Vec::new();
    for x in number("--min-x")..number("--max-x") {
        for z in number("--min-z")..number("--max-z") {
            let pos = ChunkPos {
                x,
                z,
                dimension: Dimension::Overworld,
            };
            let chunk = world.get_chunk_blocking(pos).unwrap();
            let subchunks = chunk
                .records
                .iter()
                .filter(|r| r.key.tag == ChunkRecordTag::SubChunkPrefix)
                .count();
            rows.push(json!({"x":x,"z":z,"version":chunk.version,"subchunks":subchunks,"records":chunk.records.len(),"finalized":chunk.records.iter().any(|r|r.key.tag==ChunkRecordTag::FinalizedState)}));
        }
    }
    println!("{}", json!({"chunks":rows}));
}
