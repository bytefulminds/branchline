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
