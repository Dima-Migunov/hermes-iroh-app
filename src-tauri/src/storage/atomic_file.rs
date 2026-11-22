use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::Path;

use uuid::Uuid;

pub fn write_file_atomic(path: &Path, data: &[u8], mode: Option<u32>) -> io::Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }

    let file_name = path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| "file".to_owned());
    let temporary_path = path.with_file_name(format!("{file_name}.{}.tmp", Uuid::new_v4()));

    let result = (|| {
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            if let Some(mode) = mode {
                use std::os::unix::fs::OpenOptionsExt;
                options.mode(mode);
            }
        }
        #[cfg(not(unix))]
        let _ = mode;

        let mut file = options.open(&temporary_path)?;
        file.write_all(data)?;
        file.sync_all()?;
        drop(file);
        fs::rename(&temporary_path, path)
    })();

    if result.is_err() {
        let _ = fs::remove_file(&temporary_path);
    }

    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;

    fn temporary_directory() -> PathBuf {
        tempfile::tempdir().expect("temp dir").keep()
    }

    #[test]
    fn writes_a_file_and_creates_parent_directories() {
        let directory = temporary_directory();
        let path = directory.join("nested/config.json");

        write_file_atomic(&path, b"hello", None).expect("write");

        assert_eq!(fs::read(&path).expect("read"), b"hello");
    }

    #[test]
    fn replaces_an_existing_file_atomically() {
        let directory = temporary_directory();
        let path = directory.join("config.json");
        fs::write(&path, b"old").expect("seed");

        write_file_atomic(&path, b"new", None).expect("replace");

        assert_eq!(fs::read(&path).expect("read"), b"new");
    }

    #[test]
    fn applies_the_requested_mode_on_unix() {
        let directory = temporary_directory();
        let path = directory.join("client.key");

        write_file_atomic(&path, &[7u8; 32], Some(0o600)).expect("write");

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = fs::metadata(&path).expect("metadata").permissions().mode() & 0o777;
            assert_eq!(mode, 0o600);
        }
    }
}
