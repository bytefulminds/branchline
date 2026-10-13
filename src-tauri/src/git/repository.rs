//! Repository inspection: resolves a user-selected folder to a repository and
//! returns its HEAD state, upstream tracking and working-tree changes.

use std::path::{Path, PathBuf};
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use serde::Serialize;

use super::runner::{run_git, DEFAULT_TIMEOUT};
use super::status::{parse_status, FileChange};
use crate::error::GitError;

/// Upper bound on the number of changed paths returned to the UI in one payload.
pub const MAX_CHANGES: usize = 10_000;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum HeadState {
    /// HEAD points at a branch that has at least one commit.
    Branch { name: String, oid: String },
    /// HEAD points directly at a commit.
    Detached { oid: String },
    /// HEAD points at a branch without commits (new repository or orphan branch).
    Unborn { name: String },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpstreamInfo {
    pub name: String,
    pub ahead: u32,
    pub behind: u32,
    /// The configured upstream branch no longer exists.
    pub gone: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitSummary {
    pub oid: String,
    pub short_oid: String,
    pub summary: String,
    pub author_name: String,
    /// Author date, strict ISO 8601.
    pub author_date: String,
}

/// An in-progress multi-step operation detected from the Git directory.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum RepoOperation {
    Merge,
    Rebase,
    CherryPick,
    Revert,
    Bisect,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepositoryInfo {
    /// Absolute path of the working tree root.
    pub path: String,
    /// Folder name of the working tree root.
    pub name: String,
    /// Absolute path of the Git directory.
    pub git_dir: String,
    pub head: HeadState,
    pub upstream: Option<UpstreamInfo>,
    pub head_commit: Option<CommitSummary>,
    pub operation: Option<RepoOperation>,
    pub changes: Vec<FileChange>,
    /// Total number of changed paths reported by Git (may exceed `changes.len()`).
    pub total_changes: usize,
    pub truncated: bool,
    /// Milliseconds since the Unix epoch when inspection finished.
    pub inspected_at: u64,
    /// Wall-clock time the inspection took, in milliseconds.
    pub duration_ms: u64,
}

/// Validate a user-supplied path before handing it to Git.
pub fn validate_path(raw: &str) -> Result<PathBuf, GitError> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(GitError::EmptyPath);
    }
    if trimmed.contains('\0') {
        return Err(GitError::PathNotFound(trimmed.replace('\0', "")));
    }
    let path = Path::new(trimmed);
    if !path.is_absolute() {
        return Err(GitError::RelativePath(trimmed.to_string()));
    }
    let canonical =
        std::fs::canonicalize(path).map_err(|_| GitError::PathNotFound(trimmed.into()))?;
    if !canonical.is_dir() {
        return Err(GitError::NotADirectory(trimmed.into()));
    }
    Ok(strip_verbatim(canonical))
}

/// `canonicalize` on Windows returns `\\?\C:\...` paths; present them normally.
fn strip_verbatim(path: PathBuf) -> PathBuf {
    #[cfg(windows)]
    {
        let s = path.to_string_lossy();
        if let Some(rest) = s.strip_prefix(r"\\?\UNC\") {
            return PathBuf::from(format!(r"\\{rest}"));
        }
        if let Some(rest) = s.strip_prefix(r"\\?\") {
            return PathBuf::from(rest);
        }
    }
    path
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn lines(bytes: &[u8]) -> Vec<String> {
    String::from_utf8_lossy(bytes)
        .lines()
        .map(|l| l.trim_end_matches('\r').to_string())
        .collect()
}

/// Resolve the working tree root and Git directory for `dir`.
fn resolve(dir: &Path) -> Result<(PathBuf, PathBuf), GitError> {
    let out = run_git(
        dir,
        &[
            "rev-parse",
            "--is-bare-repository",
            "--is-inside-git-dir",
            "--absolute-git-dir",
        ],
        DEFAULT_TIMEOUT,
    )?;
    let l = lines(&out.stdout);
    let [bare, inside_git_dir, git_dir, ..] = l.as_slice() else {
        return Err(GitError::Parse(format!("rev-parse returned {l:?}")));
    };
    if bare == "true" {
        return Err(GitError::BareRepository);
    }
    if inside_git_dir == "true" {
        return Err(GitError::InsideGitDir);
    }
    let git_dir = PathBuf::from(git_dir);

    let out = run_git(dir, &["rev-parse", "--show-toplevel"], DEFAULT_TIMEOUT)?;
    let top = lines(&out.stdout)
        .into_iter()
        .next()
        .filter(|s| !s.is_empty())
        .ok_or_else(|| GitError::Parse("rev-parse --show-toplevel returned nothing".into()))?;
    Ok((PathBuf::from(top), git_dir))
}

fn head_commit(root: &Path) -> Result<CommitSummary, GitError> {
    let out = run_git(
        root,
        &[
            "show",
            "-s",
            "--no-color",
            "--format=%H%x00%h%x00%an%x00%aI%x00%s",
            "HEAD",
            "--",
        ],
        DEFAULT_TIMEOUT,
    )?;
    let text = out.stdout_string();
    let mut parts = text.trim_end_matches(['\n', '\r']).splitn(5, '\0');
    let mut next = || parts.next().map(str::to_string);
    match (next(), next(), next(), next(), next()) {
        (Some(oid), Some(short_oid), Some(author_name), Some(author_date), Some(summary)) => {
            Ok(CommitSummary {
                oid,
                short_oid,
                summary,
                author_name,
                author_date,
            })
        }
        _ => Err(GitError::Parse(format!(
            "unexpected commit format: {text:?}"
        ))),
    }
}

/// Detect an in-progress operation from marker files in the Git directory.
pub fn detect_operation(git_dir: &Path) -> Option<RepoOperation> {
    if git_dir.join("rebase-merge").is_dir() || git_dir.join("rebase-apply").is_dir() {
        Some(RepoOperation::Rebase)
    } else if git_dir.join("MERGE_HEAD").is_file() {
        Some(RepoOperation::Merge)
    } else if git_dir.join("CHERRY_PICK_HEAD").is_file() {
        Some(RepoOperation::CherryPick)
    } else if git_dir.join("REVERT_HEAD").is_file() {
        Some(RepoOperation::Revert)
    } else if git_dir.join("BISECT_LOG").is_file() {
        Some(RepoOperation::Bisect)
    } else {
        None
    }
}

/// Inspect the repository containing `raw_path`.
pub fn inspect(raw_path: &str) -> Result<RepositoryInfo, GitError> {
    let started = Instant::now();
    let dir = validate_path(raw_path)?;
    let (root, git_dir) = resolve(&dir)?;

    let status = run_git(
        &root,
        &[
            "status",
            "--porcelain=v2",
            "--branch",
            "-z",
            "--untracked-files=all",
            "--find-renames",
        ],
        DEFAULT_TIMEOUT,
    )?;
    let summary = parse_status(&status.stdout)?;
    let branch = summary.branch;

    let head = match (&branch.head, &branch.oid) {
        (Some(name), Some(oid)) => HeadState::Branch {
            name: name.clone(),
            oid: oid.clone(),
        },
        (Some(name), None) => HeadState::Unborn { name: name.clone() },
        (None, Some(oid)) => HeadState::Detached { oid: oid.clone() },
        (None, None) => return Err(GitError::Parse("status reported no HEAD".into())),
    };

    let upstream = branch.upstream.map(|name| match branch.ahead_behind {
        Some((ahead, behind)) => UpstreamInfo {
            name,
            ahead,
            behind,
            gone: false,
        },
        None => UpstreamInfo {
            name,
            ahead: 0,
            behind: 0,
            gone: true,
        },
    });

    let head_commit = match head {
        HeadState::Unborn { .. } => None,
        _ => Some(head_commit(&root)?),
    };

    let total_changes = summary.changes.len();
    let mut changes = summary.changes;
    let truncated = total_changes > MAX_CHANGES;
    changes.truncate(MAX_CHANGES);

    let name = root
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| root.display().to_string());

    Ok(RepositoryInfo {
        path: root.display().to_string(),
        name,
        git_dir: git_dir.display().to_string(),
        operation: detect_operation(&git_dir),
        head,
        upstream,
        head_commit,
        changes,
        total_changes,
        truncated,
        inspected_at: now_ms(),
        duration_ms: started.elapsed().as_millis() as u64,
    })
}
