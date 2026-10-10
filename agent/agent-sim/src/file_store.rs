//! A development stand-in for the host's DPAPI-backed secret store: one plain file per secret
//! under the data folder. A real host never uses this.

use agent_core::{Error, Result, SecretStore, SecretString};
use std::fs;
use std::path::PathBuf;

pub struct FileSecretStore {
    dir: PathBuf,
}

impl FileSecretStore {
    pub fn new(dir: PathBuf) -> Self {
        Self { dir }
    }

    fn path(&self, name: &str) -> Result<PathBuf> {
        let ok = !name.is_empty()
            && name
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-');
        if !ok {
            return Err(Error::Secret("bad name".into()));
        }
        Ok(self.dir.join(format!("{name}.secret")))
    }
}

impl SecretStore for FileSecretStore {
    fn get(&self, name: &str) -> Result<Option<SecretString>> {
        match fs::read_to_string(self.path(name)?) {
            Ok(text) => Ok(Some(SecretString::new(text.trim()))),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(e.into()),
        }
    }

    fn set(&self, name: &str, value: &SecretString) -> Result<()> {
        fs::create_dir_all(&self.dir)?;
        fs::write(self.path(name)?, value.expose())?;
        Ok(())
    }

    fn remove(&self, name: &str) -> Result<()> {
        match fs::remove_file(self.path(name)?) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(e.into()),
        }
    }
}
