//! Tokens and keys in the system's credential store, never in a settings file.
//!
//! macOS Keychain, Windows Credential Manager, or the Secret Service on Linux (GNOME Keyring,
//! KWallet). Every entry is stored under the service name "Branchline" with a key such as
//! `gitlab:https://gitlab.com`. Tests use an in-memory store instead.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

use crate::error::GitError;

const SERVICE: &str = "Branchline";

enum Backend {
    System,
    Memory(Mutex<HashMap<String, String>>),
}

static BACKEND: OnceLock<Backend> = OnceLock::new();

/// Values already read from or written to the system store in this run. macOS asks for
/// permission each time an app it does not recognize reads the Keychain (every new
/// unsigned build), so Branchline reads each entry at most once per run.
static CACHE: OnceLock<Mutex<HashMap<String, Option<String>>>> = OnceLock::new();

fn cache() -> std::sync::MutexGuard<'static, HashMap<String, Option<String>>> {
    CACHE
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .unwrap_or_else(|e| e.into_inner())
}

fn backend() -> &'static Backend {
    BACKEND.get_or_init(|| Backend::System)
}

/// Keep secrets in memory for this process only (tests). Returns false when the store was
/// already chosen.
pub fn use_memory_store() -> bool {
    BACKEND
        .set(Backend::Memory(Mutex::new(HashMap::new())))
        .is_ok()
}

fn unavailable(e: impl std::fmt::Display) -> GitError {
    GitError::Forge(format!(
        "Branchline could not use the system's password store ({e}). On Linux, a keyring \
         service such as GNOME Keyring or KWallet has to be running."
    ))
}

/// Save `value` under `key`, replacing an earlier value.
pub fn set(key: &str, value: &str) -> Result<(), GitError> {
    match backend() {
        Backend::Memory(m) => {
            m.lock()
                .unwrap_or_else(|e| e.into_inner())
                .insert(key.to_string(), value.to_string());
            Ok(())
        }
        Backend::System => {
            system::set(key, value)?;
            cache().insert(key.to_string(), Some(value.to_string()));
            Ok(())
        }
    }
}

/// Whether a value is stored under `key`.
pub fn exists(key: &str) -> Result<bool, GitError> {
    Ok(get(key)?.is_some())
}

/// The value under `key`, or `None` when there is none.
pub fn get(key: &str) -> Result<Option<String>, GitError> {
    match backend() {
        Backend::Memory(m) => Ok(m
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(key)
            .cloned()),
        Backend::System => {
            if let Some(cached) = cache().get(key) {
                return Ok(cached.clone());
            }
            let value = system::get(key)?;
            cache().insert(key.to_string(), value.clone());
            Ok(value)
        }
    }
}

/// Remove the value under `key`; removing a missing value is fine.
pub fn delete(key: &str) -> Result<(), GitError> {
    match backend() {
        Backend::Memory(m) => {
            m.lock().unwrap_or_else(|e| e.into_inner()).remove(key);
            Ok(())
        }
        Backend::System => {
            system::delete(key)?;
            cache().insert(key.to_string(), None);
            Ok(())
        }
    }
}

#[cfg(any(target_os = "macos", windows, unix))]
mod system {
    use super::{unavailable, SERVICE};
    use crate::error::GitError;

    fn entry(key: &str) -> Result<keyring::Entry, GitError> {
        keyring::Entry::new(SERVICE, key).map_err(unavailable)
    }

    pub fn set(key: &str, value: &str) -> Result<(), GitError> {
        entry(key)?.set_password(value).map_err(unavailable)
    }

    pub fn get(key: &str) -> Result<Option<String>, GitError> {
        match entry(key)?.get_password() {
            Ok(v) => Ok(Some(v)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(unavailable(e)),
        }
    }

    pub fn delete(key: &str) -> Result<(), GitError> {
        match entry(key)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(unavailable(e)),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn memory_store_round_trips() {
        use_memory_store();
        set("gitlab:https://example.test", "glpat-1").unwrap();
        assert_eq!(
            get("gitlab:https://example.test").unwrap().as_deref(),
            Some("glpat-1")
        );
        delete("gitlab:https://example.test").unwrap();
        delete("gitlab:https://example.test").unwrap();
        assert_eq!(get("gitlab:https://example.test").unwrap(), None);
    }
}
