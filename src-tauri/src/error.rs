//! Error model shared by the Git service and the IPC layer.
//!
//! Errors are serialized to the frontend as `{ kind, message, detail }` so the
//! UI can choose a specific presentation per `kind` while still showing the
//! raw Git output (`detail`) when it helps the user.

use serde::ser::SerializeStruct;
use serde::{Serialize, Serializer};

#[derive(Debug, thiserror::Error)]
pub enum GitError {
    #[error("No path was provided.")]
    EmptyPath,

    #[error("The path does not exist: {0}")]
    PathNotFound(String),

    #[error("The path is not a directory: {0}")]
    NotADirectory(String),

    #[error("The path must be absolute: {0}")]
    RelativePath(String),

    #[error("This folder is not a Git repository.")]
    NotARepository { detail: String },

    #[error("Bare repositories are not supported yet. Open a repository with a working tree.")]
    BareRepository,

    #[error("Select the repository's working folder, not its .git directory.")]
    InsideGitDir,

    #[error("Git refused to open this repository because it is owned by another user.")]
    UnsafeRepository { detail: String },

    #[error("Git could not be found. Install Git and make sure it is available on your PATH.")]
    GitNotFound,

    #[error("Git {found} is too old. Branchline requires Git {required} or newer.")]
    GitTooOld { found: String, required: String },

    #[error("The Git command did not finish within {seconds} seconds.")]
    Timeout { seconds: u64 },

    #[error("Git exited with status {code}.")]
    GitFailed { code: i32, stderr: String },

    #[error("Another Git process is using this repository. Wait for it to finish and try again.")]
    Locked { detail: String },

    #[error("The output is larger than {limit_bytes} bytes.")]
    OutputTooLarge { limit_bytes: u64 },

    #[error("Invalid file path: {0}")]
    InvalidPath(String),

    #[error("The file changed since it was displayed. Review the updated changes and try again.")]
    Stale,

    #[error("{0}")]
    Unsupported(String),

    #[error("Git could not apply the selected changes.")]
    ApplyFailed { detail: String },

    #[error("Git does not know who you are. Set your name and email to commit.")]
    IdentityMissing { detail: String },

    #[error("The commit was not created.")]
    CommitFailed { detail: String },

    #[error("Unexpected Git output: {0}")]
    Parse(String),

    #[error("Internal error: {0}")]
    Internal(String),
}

impl GitError {
    pub fn kind(&self) -> &'static str {
        match self {
            GitError::EmptyPath => "emptyPath",
            GitError::PathNotFound(_) => "pathNotFound",
            GitError::NotADirectory(_) => "notADirectory",
            GitError::RelativePath(_) => "relativePath",
            GitError::NotARepository { .. } => "notARepository",
            GitError::BareRepository => "bareRepository",
            GitError::InsideGitDir => "insideGitDir",
            GitError::UnsafeRepository { .. } => "unsafeRepository",
            GitError::GitNotFound => "gitNotFound",
            GitError::GitTooOld { .. } => "gitTooOld",
            GitError::Timeout { .. } => "timeout",
            GitError::GitFailed { .. } => "gitFailed",
            GitError::Locked { .. } => "locked",
            GitError::OutputTooLarge { .. } => "outputTooLarge",
            GitError::InvalidPath(_) => "invalidPath",
            GitError::Stale => "stale",
            GitError::Unsupported(_) => "unsupported",
            GitError::ApplyFailed { .. } => "applyFailed",
            GitError::IdentityMissing { .. } => "identityMissing",
            GitError::CommitFailed { .. } => "commitFailed",
            GitError::Parse(_) => "parse",
            GitError::Internal(_) => "internal",
        }
    }

    /// Raw diagnostic output that may help the user (Git's stderr).
    pub fn detail(&self) -> Option<&str> {
        match self {
            GitError::NotARepository { detail }
            | GitError::UnsafeRepository { detail }
            | GitError::Locked { detail }
            | GitError::ApplyFailed { detail }
            | GitError::IdentityMissing { detail }
            | GitError::CommitFailed { detail } => Some(detail.as_str()),
            GitError::GitFailed { stderr, .. } => Some(stderr.as_str()),
            _ => None,
        }
        .filter(|s| !s.trim().is_empty())
    }
}

impl Serialize for GitError {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut s = serializer.serialize_struct("GitError", 3)?;
        s.serialize_field("kind", self.kind())?;
        s.serialize_field("message", &self.to_string())?;
        s.serialize_field("detail", &self.detail())?;
        s.end()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serializes_kind_message_and_detail() {
        let err = GitError::GitFailed {
            code: 128,
            stderr: "fatal: boom".into(),
        };
        let json = serde_json::to_value(&err).unwrap();
        assert_eq!(json["kind"], "gitFailed");
        assert_eq!(json["message"], "Git exited with status 128.");
        assert_eq!(json["detail"], "fatal: boom");
    }

    #[test]
    fn empty_detail_serializes_as_null() {
        let err = GitError::NotARepository {
            detail: "  ".into(),
        };
        let json = serde_json::to_value(&err).unwrap();
        assert!(json["detail"].is_null());
    }
}
