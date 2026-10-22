//! Validation of repository-relative paths received from the UI.

use crate::error::GitError;

/// Accept only plain repository-relative paths (as reported by `git status`):
/// no absolute paths, no `..` components, nothing inside `.git`.
pub fn validate_relative(path: &str) -> Result<&str, GitError> {
    let invalid = || GitError::InvalidPath(path.to_string());
    if path.is_empty() || path.contains('\0') {
        return Err(invalid());
    }
    let bytes = path.as_bytes();
    let absolute = path.starts_with('/')
        || path.starts_with('\\')
        || (bytes.len() >= 2 && bytes[1] == b':' && bytes[0].is_ascii_alphabetic());
    if absolute {
        return Err(invalid());
    }
    let mut components = path.split(['/', '\\']);
    if let Some(first) = components.clone().next() {
        if first.eq_ignore_ascii_case(".git") {
            return Err(invalid());
        }
    }
    if components.any(|c| c == "..") {
        return Err(invalid());
    }
    Ok(path)
}

/// Check a folder the user wants Git to create (a clone, a new repository, a
/// worktree): an absolute path whose parent exists, and that is missing or an
/// empty folder. Returns it with the parent's symbolic links resolved.
pub fn new_folder(raw: &str) -> Result<std::path::PathBuf, GitError> {
    use std::path::{Component, Path};
    let invalid = |why: &str| Err(GitError::InvalidPath(why.to_string()));
    let raw = raw.trim();
    if raw.is_empty() {
        return invalid("Choose a folder.");
    }
    if raw.contains('\0') {
        return invalid("The folder name contains an invalid character.");
    }
    let path = Path::new(raw);
    if !path.is_absolute() {
        return invalid("Use a full path, for example /Users/you/code/project.");
    }
    let Some(leaf) = path.file_name().filter(|n| !n.is_empty()) else {
        return invalid("Choose a folder name, not a drive or root folder.");
    };
    if path.components().any(|c| matches!(c, Component::ParentDir)) {
        return invalid("The path cannot contain `..`.");
    }
    let Some(parent) = path.parent().filter(|p| p.is_dir()) else {
        return invalid("The folder it goes in does not exist.");
    };
    let target = super::worktrees::canonical(parent).join(leaf);
    if let Ok(meta) = std::fs::symlink_metadata(&target) {
        let empty_dir = meta.is_dir()
            && std::fs::read_dir(&target)
                .map(|mut d| d.next().is_none())
                .unwrap_or(false);
        if !empty_dir {
            return invalid("That folder already exists and is not empty.");
        }
    }
    Ok(target)
}

pub fn validate_all(paths: &[String]) -> Result<Vec<&str>, GitError> {
    if paths.is_empty() {
        return Err(GitError::InvalidPath("no paths given".into()));
    }
    paths.iter().map(|p| validate_relative(p)).collect()
}

#[cfg(test)]
mod tests {
    use super::validate_relative;

    #[test]
    fn accepts_ordinary_paths() {
        for p in [
            "a.txt",
            "src/main.rs",
            "with space/ünï.md",
            "*.txt",
            "-dash",
            ".gitignore",
            "dir/.git-keep",
        ] {
            assert!(validate_relative(p).is_ok(), "{p}");
        }
    }

    #[test]
    fn rejects_escapes_and_git_internals() {
        for p in [
            "",
            "/etc/passwd",
            "\\\\server\\share",
            "C:\\x",
            "../x",
            "a/../../x",
            "a\\..\\x",
            ".git/config",
            ".GIT/hooks/pre-commit",
            "a\0b",
        ] {
            assert!(validate_relative(p).is_err(), "{p:?}");
        }
    }
}
