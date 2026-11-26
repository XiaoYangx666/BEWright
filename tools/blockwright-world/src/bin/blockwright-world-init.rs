use bedrock_leveldb::{Db, OpenOptions};
use std::{env, path::PathBuf, process};
fn main() {
    let world = PathBuf::from(
        env::args()
            .nth(1)
            .expect("usage: blockwright-world-init NEW_WORLD"),
    );
    let db = world.join("db");
    if !world.join("level.dat").is_file() || db.exists() {
        eprintln!("Requires level.dat and a db path that does not exist");
        process::exit(2);
    }
    match Db::open(
        &db,
        OpenOptions {
            create_if_missing: true,
            error_if_exists: true,
            ..OpenOptions::default()
        },
    ) {
        Ok(storage) => {
            drop(storage);
            println!("{{\"ok\":true}}");
        }
        Err(error) => {
            eprintln!("{error}");
            process::exit(1);
        }
    }
}
