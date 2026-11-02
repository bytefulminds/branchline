//! Connected accounts on hosting services, without their tokens.
//!
//! The list lives in `accounts.json` next to the settings file; each account's token is in
//! the system's credential store (see `secrets`).

use std::path::{Path, PathBuf};
use std::sync::{OnceLock, RwLock};

use serde::{Deserialize, Serialize};

use crate::error::GitError;
use crate::secrets;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ForgeKind {
    Gitlab,
}

/// What the token may do, as far as Branchline could tell.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Access {
    /// Read merge requests only (`read_api`).
    Read,
    /// Read, comment and approve (`api`).
    Write,
    /// The server did not say (older GitLab).
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Account {
    pub kind: ForgeKind,
    /// Server address, for example `https://gitlab.com` (no trailing slash).
    pub url: String,
    /// Lowercase host name of `url`, used to match remotes.
    pub host: String,
    /// The user's id on the server (0 for accounts saved before Branchline kept it).
    #[serde(default)]
    pub id: u64,
    pub username: String,
    pub name: String,
    pub access: Access,
}

impl Account {
    pub fn secret_key(&self) -> String {
        secret_key(self.kind, &self.url)
    }

    /// The account's token from the credential store.
    pub fn token(&self) -> Result<String, GitError> {
        secrets::get(&self.secret_key())?.ok_or_else(|| {
            GitError::Forge(format!(
                "The token for {} is missing from the system's password store. Connect the \
                 account again in Settings > Accounts.",
                self.url
            ))
        })
    }
}

pub fn secret_key(kind: ForgeKind, url: &str) -> String {
    match kind {
        ForgeKind::Gitlab => format!("gitlab:{url}"),
    }
}

#[derive(Default, Serialize, Deserialize)]
struct File {
    #[serde(default)]
    accounts: Vec<Account>,
}

struct Store {
    path: Option<PathBuf>,
    accounts: Vec<Account>,
}

fn store() -> &'static RwLock<Store> {
    static STORE: OnceLock<RwLock<Store>> = OnceLock::new();
    STORE.get_or_init(|| {
        RwLock::new(Store {
            path: None,
            accounts: Vec::new(),
        })
    })
}

fn load_file(path: &Path) -> Vec<Account> {
    std::fs::read(path)
        .ok()
        .and_then(|b| serde_json::from_slice::<File>(&b).ok())
        .map(|f| f.accounts)
        .unwrap_or_default()
}

fn save_file(path: &Path, accounts: &[Account]) -> Result<(), GitError> {
    let io = |e: std::io::Error| GitError::Internal(format!("cannot save accounts: {e}"));
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(io)?;
    }
    let json = serde_json::to_vec_pretty(&File {
        accounts: accounts.to_vec(),
    })
    .map_err(|e| GitError::Internal(format!("cannot save accounts: {e}")))?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, json).map_err(io)?;
    std::fs::rename(&tmp, path).map_err(io)
}

/// Load the accounts file once at startup (or in tests, from a temporary folder).
pub fn init(path: PathBuf) {
    let accounts = load_file(&path);
    let mut s = store().write().unwrap_or_else(|e| e.into_inner());
    s.path = Some(path);
    s.accounts = accounts;
}

pub fn list() -> Vec<Account> {
    store()
        .read()
        .unwrap_or_else(|e| e.into_inner())
        .accounts
        .clone()
}

/// Add an account, or replace the one with the same server address.
pub fn upsert(account: Account) -> Result<(), GitError> {
    let mut s = store().write().unwrap_or_else(|e| e.into_inner());
    s.accounts
        .retain(|a| !(a.kind == account.kind && a.url == account.url));
    s.accounts.push(account);
    s.accounts.sort_by(|a, b| a.url.cmp(&b.url));
    match &s.path {
        Some(p) => save_file(p, &s.accounts),
        None => Ok(()),
    }
}

/// Remove the account with this server address and its token. Unknown addresses are fine.
pub fn remove(kind: ForgeKind, url: &str) -> Result<(), GitError> {
    secrets::delete(&secret_key(kind, url))?;
    let mut s = store().write().unwrap_or_else(|e| e.into_inner());
    s.accounts.retain(|a| !(a.kind == kind && a.url == url));
    match &s.path {
        Some(p) => save_file(p, &s.accounts),
        None => Ok(()),
    }
}

/// The account for a host name, if one is connected.
pub fn for_host(host: &str) -> Option<Account> {
    let host = host.to_ascii_lowercase();
    list().into_iter().find(|a| a.host == host)
}
