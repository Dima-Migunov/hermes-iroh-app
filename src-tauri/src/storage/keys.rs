use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use iroh::SecretKey;

use crate::errors::AppError;
use crate::storage::atomic_file::write_file_atomic;

pub const KEY_BYTES: usize = 32;

#[derive(Debug, Clone)]
pub struct ClientIdentity {
    pub node_id: String,
    pub secret_key: SecretKey,
}

impl ClientIdentity {
    pub fn ephemeral() -> Self {
        let secret_key = SecretKey::generate();
        Self {
            node_id: secret_key.public().to_string(),
            secret_key,
        }
    }
}

pub struct KeyStore {
    file_path: PathBuf,
}

impl KeyStore {
    pub fn new(file_path: impl Into<PathBuf>) -> Self {
        Self {
            file_path: file_path.into(),
        }
    }

    pub fn load(&self) -> Result<ClientIdentity, AppError> {
        match fs::read(&self.file_path) {
            Ok(existing) => self.load_existing(&existing),
            Err(error) if error.kind() == io::ErrorKind::NotFound => self.create(),
            Err(error) => Err(AppError::identity(format!(
                "The client key at {} could not be read. Restore it from backup, or deliberately remove it to generate a new identity. ({error})",
                self.file_path.display()
            ))),
        }
    }

    fn load_existing(&self, existing: &[u8]) -> Result<ClientIdentity, AppError> {
        if existing.len() != KEY_BYTES {
            return Err(AppError::identity(format!(
                "The client key at {} is invalid: expected {KEY_BYTES} bytes but found {}. The file was left unchanged. Restore it from backup, or deliberately remove it to generate a new identity.",
                self.file_path.display(),
                existing.len()
            )));
        }

        let mut bytes = [0u8; KEY_BYTES];
        bytes.copy_from_slice(existing);
        Ok(to_identity(SecretKey::from_bytes(&bytes)))
    }

    fn create(&self) -> Result<ClientIdentity, AppError> {
        let secret_key = SecretKey::generate();
        let bytes = secret_key.to_bytes();

        write_file_atomic(&self.file_path, &bytes, Some(0o600)).map_err(|error| {
            AppError::identity(format!(
                "A new client key could not be written to {}. Check the directory permissions. ({error})",
                self.file_path.display()
            ))
        })?;

        Ok(to_identity(secret_key))
    }
}

fn to_identity(secret_key: SecretKey) -> ClientIdentity {
    ClientIdentity {
        node_id: secret_key.public().to_string(),
        secret_key,
    }
}

pub fn load_identity(data_dir: &Path) -> Result<ClientIdentity, AppError> {
    KeyStore::new(crate::storage::data_dir::client_key_path(data_dir)).load()
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
    fn creates_a_32_byte_key_on_first_launch_with_owner_only_permissions() {
        let directory = temporary_directory();
        let file_path = directory.join("client.key");
        let store = KeyStore::new(&file_path);

        let identity = store.load().expect("identity");

        assert_eq!(fs::read(&file_path).expect("read").len(), KEY_BYTES);
        assert_eq!(identity.secret_key.to_bytes().len(), KEY_BYTES);
        assert!(!identity.node_id.is_empty());

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = fs::metadata(&file_path)
                .expect("metadata")
                .permissions()
                .mode()
                & 0o777;
            assert_eq!(mode, 0o600);
        }
    }

    #[test]
    fn loads_the_same_identity_on_later_launches() {
        let directory = temporary_directory();
        let file_path = directory.join("client.key");

        let first = KeyStore::new(&file_path).load().expect("first");
        let second = KeyStore::new(&file_path).load().expect("second");

        assert_eq!(second.node_id, first.node_id);
        assert_eq!(second.secret_key.to_bytes(), first.secret_key.to_bytes());
    }

    #[test]
    fn rejects_a_malformed_key_without_overwriting_it() {
        let directory = temporary_directory();
        let file_path = directory.join("client.key");
        let malformed = vec![7u8; 31];
        fs::write(&file_path, &malformed).expect("seed");

        let error = KeyStore::new(&file_path).load().expect_err("invalid");
        assert_eq!(error.code, crate::errors::ErrorCode::Identity);
        assert_eq!(fs::read(&file_path).expect("read"), malformed);
    }

    #[test]
    fn reports_an_unreadable_key_path_without_replacing_it() {
        let directory = temporary_directory();
        let file_path = directory.join("client.key");
        fs::create_dir(&file_path).expect("directory");

        let store = KeyStore::new(&file_path);
        let error = store.load().expect_err("unreadable");
        assert_eq!(error.code, crate::errors::ErrorCode::Identity);
        assert!(fs::metadata(&file_path).expect("metadata").is_dir());
    }

    #[test]
    fn creates_distinct_ephemeral_identities_without_touching_disk() {
        let first = ClientIdentity::ephemeral();
        let second = ClientIdentity::ephemeral();

        assert_ne!(first.node_id, second.node_id);
        assert_eq!(first.secret_key.to_bytes().len(), KEY_BYTES);
    }

    #[test]
    fn loads_a_fixed_32_byte_key_reproducibly() {
        let directory = temporary_directory();
        let file_path = directory.join("client.key");
        let bytes: Vec<u8> = (0u8..32).collect();
        fs::write(&file_path, &bytes).expect("seed");

        let first = KeyStore::new(&file_path).load().expect("first");
        let second = KeyStore::new(&file_path).load().expect("second");

        assert_eq!(first.node_id, second.node_id);
        let mut expected = [0u8; KEY_BYTES];
        expected.copy_from_slice(&bytes);
        assert_eq!(
            first.node_id,
            SecretKey::from_bytes(&expected).public().to_string()
        );
    }
}
