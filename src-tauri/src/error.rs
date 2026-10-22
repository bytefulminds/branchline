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

    #[error("{0}")]
    InvalidBranchName(String),

    #[error("{0}")]
    InvalidTagName(String),

    #[error("The remote already has a different tag with this name. Delete it on the remote first if you want to replace it.")]
    TagConflict { detail: String },

    #[error("Your local changes would be overwritten. Commit or stash them first.")]
    CheckoutConflict { files: Vec<String>, detail: String },

    #[error("The branch {branch} has commits that are not merged anywhere else.")]
    NotMerged { branch: String },

    #[error("The operation was cancelled.")]
    Cancelled,

    #[error("Git could not sign in to the remote. Check your credentials, token or SSH key.")]
    AuthFailed { detail: String },

    #[error("The remote's SSH host key is not trusted yet. Connect to it once from a terminal (for example with `ssh -T git@host`) to verify and save the key.")]
    HostKeyUnverified { detail: String },

    #[error("Could not reach the remote. Check your network connection and the remote URL.")]
    NetworkFailed { detail: String },

    #[error("The remote repository was not found, or you do not have access to it.")]
    RemoteNotFound { detail: String },

    #[error("The remote has commits that you do not have. Pull first, then push again.")]
    PushRejected { detail: String },

    #[error("The remote branch changed since you last fetched. Fetch, review the new commits and try again.")]
    StaleLease { detail: String },

    #[error(
        "The remote refused the push, for example because of branch protection or a server hook."
    )]
    RemoteRejected { detail: String },

    #[error("{branch} has no upstream branch to pull from or push to.")]
    NoUpstream { branch: String },

    #[error("Your branch and its upstream have diverged, so a fast-forward is not possible. Pull with merge or rebase instead.")]
    Diverged { detail: String },

    #[error("{branch} is checked out in another worktree ({path}). Open that worktree instead.")]
    BranchInWorktree { branch: String, path: String },

    #[error("This worktree has uncommitted or untracked files.")]
    WorktreeDirty { path: String },

    #[error("{0}")]
    InvalidRemote(String),

    /// The AI model server (Ollama) failed or is not set up; the message says why.
    #[error("{0}")]
    Ai(String),

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
            GitError::InvalidBranchName(_) => "invalidBranchName",
            GitError::InvalidTagName(_) => "invalidTagName",
            GitError::TagConflict { .. } => "tagConflict",
            GitError::CheckoutConflict { .. } => "checkoutConflict",
            GitError::NotMerged { .. } => "notMerged",
            GitError::Cancelled => "cancelled",
            GitError::AuthFailed { .. } => "authFailed",
            GitError::HostKeyUnverified { .. } => "hostKeyUnverified",
            GitError::NetworkFailed { .. } => "networkFailed",
            GitError::RemoteNotFound { .. } => "remoteNotFound",
            GitError::PushRejected { .. } => "pushRejected",
            GitError::StaleLease { .. } => "staleLease",
            GitError::RemoteRejected { .. } => "remoteRejected",
            GitError::NoUpstream { .. } => "noUpstream",
            GitError::Diverged { .. } => "diverged",
            GitError::BranchInWorktree { .. } => "branchInWorktree",
            GitError::WorktreeDirty { .. } => "worktreeDirty",
            GitError::InvalidRemote(_) => "invalidRemote",
            GitError::Ai(_) => "ai",
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
            | GitError::CommitFailed { detail }
            | GitError::CheckoutConflict { detail, .. }
            | GitError::AuthFailed { detail }
            | GitError::HostKeyUnverified { detail }
            | GitError::NetworkFailed { detail }
            | GitError::RemoteNotFound { detail }
            | GitError::PushRejected { detail }
            | GitError::StaleLease { detail }
            | GitError::RemoteRejected { detail }
            | GitError::TagConflict { detail }
            | GitError::Diverged { detail } => Some(detail.as_str()),
            // The folder, so the UI can offer to open or clean up that worktree.
            GitError::BranchInWorktree { path, .. } | GitError::WorktreeDirty { path } => {
                Some(path.as_str())
            }
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
