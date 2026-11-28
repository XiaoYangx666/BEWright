use bedrock_world::{BedrockWorldError, Result};
use std::{fs, io, path::Path};

/// LevelDB keeps this file around so all editors lock the same inode.
pub fn lock_world(world: &Path) -> Result<fs::File> {
    let path = world.join("db").join("LOCK");
    fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(&path)
        .and_then(|file| {
            try_lock(&file)?;
            Ok(file)
        })
        .map_err(|error| {
            BedrockWorldError::Validation(format!(
                "cannot lock {}: {error}. Close Minecraft or BDS before writing this world",
                path.display()
            ))
        })
}

#[cfg(windows)]
fn try_lock(file: &fs::File) -> io::Result<()> {
    file.try_lock().map_err(io::Error::from)
}

#[cfg(unix)]
fn try_lock(file: &fs::File) -> io::Result<()> {
    use std::os::fd::AsRawFd;
    // The LevelDB POSIX env uses fcntl record locks; flock would not contend.
    let mut lock: libc::flock = unsafe { std::mem::zeroed() };
    lock.l_type = libc::F_WRLCK as _;
    lock.l_whence = libc::SEEK_SET as _;
    if unsafe { libc::fcntl(file.as_raw_fd(), libc::F_SETLK, &lock) } == -1 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

/// Copy under the same lock as the guarded write so this is a consistent
/// pre-deployment copy of the exact world we are about to mutate.
pub fn backup(world: &Path, destination: &Path) -> Result<()> {
    let result = (|| -> io::Result<()> {
        let parent = destination
            .parent()
            .ok_or_else(|| io::Error::other("missing backup parent"))?;
        let name = destination
            .file_name()
            .ok_or_else(|| io::Error::other("missing backup name"))?;
        let target = parent.canonicalize()?.join(name);
        let source = world.canonicalize()?;
        if target.starts_with(&source) {
            return Err(io::Error::other("backup directory is inside the world"));
        }
        fs::create_dir(&target)?;
        if let Err(error) = copy_directory(&source, &target, &source.join("db/LOCK")) {
            let _ = fs::remove_dir_all(&target);
            return Err(error);
        }
        Ok(())
    })();
    result.map_err(|error| {
        BedrockWorldError::Validation(format!(
            "creating backup {} failed: {error}",
            destination.display()
        ))
    })
}

fn copy_directory(source: &Path, target: &Path, lock: &Path) -> io::Result<()> {
    for entry in fs::read_dir(source)? {
        let entry = entry?;
        let from = entry.path();
        if from == lock {
            continue;
        }
        let to = target.join(entry.file_name());
        let kind = entry.file_type()?;
        if kind.is_dir() {
            fs::create_dir(&to)?;
            copy_directory(&from, &to, lock)?;
        } else if kind.is_file() {
            fs::copy(&from, &to)?;
        } else {
            return Err(io::Error::other(format!(
                "unsupported world file: {}",
                from.display()
            )));
        }
    }
    Ok(())
}
