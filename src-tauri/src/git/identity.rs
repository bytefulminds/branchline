//! Who commits: `user.name` and `user.email`, plus commit signing, read and
//! written in the global Git configuration or in one repository.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::repository::resolve_root;
use super::runner::{run_git_with, RunOptions};
use crate::error::GitError;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ConfigScope {
    /// `~/.gitconfig`: every repository.
    Global,
    /// `.git/config` of one repository; overrides the global values.
    Repository,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct IdentityValues {
    pub name: String,
    pub email: String,
    /// `commit.gpgSign`.
    pub sign_commits: bool,
    /// `gpg.format`: `openpgp` (default), `ssh` or `x509`; empty means unset.
    pub signing_format: String,
    /// `user.signingKey`: a key id, or for SSH the public key or its file.
    pub signing_key: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Identity {
    pub global: IdentityValues,
    /// Values set in the repository itself (empty when none, or no repository).
    pub repository: Option<IdentityValues>,
}

const KEYS: [&str; 5] = [
    "user.name",
    "user.email",
    "commit.gpgsign",
    "gpg.format",
    "user.signingkey",
];

fn scope_flag(scope: ConfigScope) -> &'static str {
    match scope {
        ConfigScope::Global => "--global",
        ConfigScope::Repository => "--local",
    }
}

fn get(cwd: &Path, scope: ConfigScope, key: &str) -> Result<String, GitError> {
    let out = run_git_with(
        cwd,
        &["config", scope_flag(scope), "--get", key],
        &RunOptions {
            // 1: not set.
            ok_codes: &[0, 1],
            ..RunOptions::default()
        },
    )?;
    Ok(out.stdout_string().trim().to_string())
}

fn read(cwd: &Path, scope: ConfigScope) -> Result<IdentityValues, GitError> {
    Ok(IdentityValues {
        name: get(cwd, scope, KEYS[0])?,
        email: get(cwd, scope, KEYS[1])?,
        sign_commits: get(cwd, scope, KEYS[2])? == "true",
        signing_format: get(cwd, scope, KEYS[3])?,
        signing_key: get(cwd, scope, KEYS[4])?,
    })
}

/// A folder to run global `git config` in, outside any repository.
fn neutral_dir() -> PathBuf {
    std::env::temp_dir()
}

pub fn get_identity(repo: Option<&str>) -> Result<Identity, GitError> {
    let global = read(&neutral_dir(), ConfigScope::Global)?;
    let repository = match repo {
        Some(r) => Some(read(&resolve_root(r)?, ConfigScope::Repository)?),
        None => None,
    };
    Ok(Identity { global, repository })
}

fn check(value: &str, what: &str) -> Result<(), GitError> {
    if value.chars().any(char::is_control) {
        return Err(GitError::Unsupported(format!(
            "The {what} cannot contain line breaks or control characters."
        )));
    }
    if value.len() > 1000 {
        return Err(GitError::Unsupported(format!("The {what} is too long.")));
    }
    Ok(())
}

/// Write the values; empty values are removed from that scope so the other
/// scope (or Git's default) applies.
pub fn set_identity(
    scope: ConfigScope,
    repo: Option<&str>,
    values: &IdentityValues,
) -> Result<(), GitError> {
    let cwd = match (scope, repo) {
        (ConfigScope::Repository, Some(r)) => resolve_root(r)?,
        (ConfigScope::Repository, None) => {
            return Err(GitError::Unsupported("Open a repository first.".into()))
        }
        (ConfigScope::Global, Some(r)) => resolve_root(r)?,
        (ConfigScope::Global, None) => neutral_dir(),
    };
    let name = values.name.trim();
    let email = values.email.trim();
    let format = values.signing_format.trim();
    let key = values.signing_key.trim();
    check(name, "name")?;
    check(email, "email address")?;
    check(key, "signing key")?;
    if !email.is_empty() && !email.contains('@') {
        return Err(GitError::Unsupported(
            "That does not look like an email address.".into(),
        ));
    }
    if !["", "openpgp", "ssh", "x509"].contains(&format) {
        return Err(GitError::Unsupported("Unknown signing format.".into()));
    }
    let sign = if values.sign_commits { "true" } else { "" };
    for (k, v) in KEYS.iter().zip([name, email, sign, format, key]) {
        let flag = scope_flag(scope);
        let args: Vec<&str> = if v.is_empty() {
            vec!["config", flag, "--unset-all", k]
        } else {
            vec!["config", flag, "--replace-all", k, v]
        };
        run_git_with(
            &cwd,
            &args,
            &RunOptions {
                // 5: unsetting a key that is not set.
                ok_codes: &[0, 5],
                ..RunOptions::default()
            },
        )?;
    }
    Ok(())
}
