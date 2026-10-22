//! Worktrees: more working folders for one repository, each with its own
//! checked-out branch (`git worktree`).
//!
//! * Paths come from Git (`git worktree list --porcelain`); a path from the UI
//!   is only used after it matches one of them, except for a new worktree,
//!   whose folder is checked first (absolute, parent exists, empty or missing,
//!   outside the repository).
//! * The main worktree and the one open in Branchline are never removed.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::branches::{list_branches, start_ref, validate_branch_name, StartPoint};
use super::ops::write_lock;
use super::repository::resolve_root;
use super::runner::{run_git, run_git_with, RunOptions, DEFAULT_TIMEOUT};
use crate::error::GitError;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeInfo {
    pub path: String,
    /// Folder name, for display.
    pub name: String,
    pub head: Option<String>,
    /// Checked-out branch (short name); `None` when detached.
    pub branch: Option<String>,
    pub detached: bool,
    pub bare: bool,
    /// Set when locked; the reason may be empty.
    pub locked: Option<String>,
    /// Set when Git considers the worktree stale (its folder is gone).
    pub prunable: Option<String>,
    /// The repository's original working tree.
    pub is_main: bool,
    /// The worktree open in Branchline.
    pub is_current: bool,
    /// Number of changed files, when the folder could be inspected.
    pub changes: Option<u32>,
}

/// What a new worktree checks out.
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum WorktreeTarget {
    /// Create `name` at `start` and check it out.
    NewBranch { name: String, start: StartPoint },
    /// Check out an existing local branch.
    Branch { name: String },
    /// Detached HEAD at `start`.
    Detached { start: StartPoint },
}

#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct RawWorktree {
    pub path: String,
    pub head: Option<String>,
    pub branch: Option<String>,
    pub detached: bool,
    pub bare: bool,
    pub locked: Option<String>,
    pub prunable: Option<String>,
}

/// Parse `git worktree list --porcelain` (records separated by blank lines).
pub fn parse_worktrees(text: &str) -> Vec<RawWorktree> {
    let mut list = Vec::new();
    let mut current: Option<RawWorktree> = None;
    for line in text.lines() {
        if line.is_empty() {
            list.extend(current.take());
            continue;
        }
        let (key, value) = line.split_once(' ').unwrap_or((line, ""));
        if key == "worktree" {
            list.extend(current.take());
            current = Some(RawWorktree {
                path: value.to_string(),
                ..RawWorktree::default()
            });
            continue;
        }
        let Some(w) = current.as_mut() else {
            continue;
        };
        match key {
            "HEAD" => w.head = Some(value.to_string()),
            "branch" => {
                w.branch = Some(
                    value
                        .strip_prefix("refs/heads/")
                        .unwrap_or(value)
                        .to_string(),
                )
            }
            "detached" => w.detached = true,
            "bare" => w.bare = true,
            "locked" => w.locked = Some(value.to_string()),
            "prunable" => w.prunable = Some(value.to_string()),
            _ => {}
        }
    }
    list.extend(current);
    list
}

pub(crate) fn canonical(path: &Path) -> PathBuf {
    let p = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    strip_verbatim(p)
}

/// `canonicalize` on Windows returns `\\?\C:\...`; Git reports `C:/...`.
fn strip_verbatim(path: PathBuf) -> PathBuf {
    #[cfg(windows)]
    {
        let s = path.to_string_lossy();
        if let Some(rest) = s.strip_prefix(r"\\?\") {
            return PathBuf::from(rest);
        }
    }
    path
}

fn same_path(a: &Path, b: &Path) -> bool {
    canonical(a) == canonical(b)
}

fn raw_list(root: &Path) -> Result<Vec<RawWorktree>, GitError> {
    let out = run_git(root, &["worktree", "list", "--porcelain"], DEFAULT_TIMEOUT)?;
    Ok(parse_worktrees(&out.stdout_string()))
}

/// Branches checked out in worktrees other than `root`, with their folder.
pub fn branches_elsewhere(root: &Path) -> Vec<(String, String)> {
    raw_list(root)
        .unwrap_or_default()
        .into_iter()
        .filter(|w| !same_path(Path::new(&w.path), root))
        .filter_map(|w| Some((w.branch?, w.path)))
        .collect()
}

fn count_changes(path: &Path) -> Option<u32> {
    let out = run_git_with(
        path,
        &["status", "--porcelain", "-z", "--untracked-files=normal"],
        &RunOptions {
            timeout: DEFAULT_TIMEOUT,
            ..RunOptions::default()
        },
    )
    .ok()?;
    Some(count_status_records(&out.stdout))
}

/// Count files in `git status --porcelain -z` output. A rename or copy is one
/// file but two records (the new path, then the original path).
pub fn count_status_records(out: &[u8]) -> u32 {
    let mut records = out.split(|b| *b == 0).filter(|r| !r.is_empty());
    let mut n = 0;
    while let Some(r) = records.next() {
        n += 1;
        if matches!(r.first(), Some(b'R' | b'C')) {
            records.next();
        }
    }
    n
}

pub fn list(repo: &str) -> Result<Vec<WorktreeInfo>, GitError> {
    let root = resolve_root(repo)?;
    let raw = raw_list(&root)?;
    Ok(raw
        .into_iter()
        .enumerate()
        .map(|(i, w)| {
            let path = PathBuf::from(&w.path);
            let exists = w.prunable.is_none() && !w.bare && path.is_dir();
            WorktreeInfo {
                name: path
                    .file_name()
                    .map(|n| n.to_string_lossy().into_owned())
                    .unwrap_or_else(|| w.path.clone()),
                is_main: i == 0,
                is_current: same_path(&path, &root),
                changes: if exists { count_changes(&path) } else { None },
                path: w.path,
                head: w.head,
                branch: w.branch,
                detached: w.detached,
                bare: w.bare,
                locked: w.locked,
                prunable: w.prunable,
            }
        })
        .collect())
}

/// Check the folder for a new worktree and return it as Git should receive it.
fn check_new_path(root: &Path, raw: &str) -> Result<PathBuf, GitError> {
    let target = super::paths::new_folder(raw)?;
    if target.starts_with(canonical(root)) {
        return Err(GitError::InvalidPath(
            "Choose a folder outside the repository.".into(),
        ));
    }
    Ok(target)
}

/// Map Git's "branch is checked out in another worktree" refusal to a clear error.
pub(crate) fn branch_in_use_error(e: GitError) -> GitError {
    let GitError::GitFailed { stderr, .. } = &e else {
        return e;
    };
    for marker in ["used by worktree at '", "checked out at '"] {
        if let Some(i) = stderr.find(marker) {
            let path = stderr[i + marker.len()..]
                .split('\'')
                .next()
                .unwrap_or_default()
                .to_string();
            let branch = stderr[..i]
                .rsplit_once('\'')
                .and_then(|(head, _)| head.rsplit_once('\''))
                .map(|(_, b)| b.to_string())
                .unwrap_or_default();
            return GitError::BranchInWorktree { branch, path };
        }
    }
    e
}

/// Create a worktree at `path`. Returns the folder as created.
pub fn add(repo: &str, path: &str, target: &WorktreeTarget) -> Result<String, GitError> {
    let root = resolve_root(repo)?;
    let _guard = write_lock();
    let dest = check_new_path(&root, path)?;
    let dest_str = dest.to_string_lossy().into_owned();
    let mut args: Vec<String> = vec!["worktree".into(), "add".into()];
    match target {
        WorktreeTarget::NewBranch { name, start } => {
            validate_branch_name(&root, name)?;
            if list_branches(&root)?.local.iter().any(|b| &b.name == name) {
                return Err(GitError::InvalidBranchName(format!(
                    "A branch named {name} already exists."
                )));
            }
            let start = start_ref(&root, start)?;
            args.extend([
                "-b".into(),
                name.clone(),
                "--".into(),
                dest_str.clone(),
                start,
            ]);
        }
        WorktreeTarget::Branch { name } => {
            if !list_branches(&root)?.local.iter().any(|b| &b.name == name) {
                return Err(GitError::Unsupported(format!(
                    "There is no local branch named {name}."
                )));
            }
            if let Some((_, path)) = raw_list(&root)?
                .into_iter()
                .filter_map(|w| Some((w.branch?, w.path)))
                .find(|(b, _)| b == name)
            {
                return Err(GitError::BranchInWorktree {
                    branch: name.clone(),
                    path,
                });
            }
            args.extend(["--".into(), dest_str.clone(), name.clone()]);
        }
        WorktreeTarget::Detached { start } => {
            let start = start_ref(&root, start)?;
            args.extend(["--detach".into(), "--".into(), dest_str.clone(), start]);
        }
    }
    let refs: Vec<&str> = args.iter().map(String::as_str).collect();
    run_git(&root, &refs, DEFAULT_TIMEOUT).map_err(branch_in_use_error)?;
    Ok(dest_str)
}

/// Find a worktree by path; it must be one Git lists.
fn find(root: &Path, path: &str) -> Result<(usize, RawWorktree), GitError> {
    raw_list(root)?
        .into_iter()
        .enumerate()
        .find(|(_, w)| w.path == path || same_path(Path::new(&w.path), Path::new(path)))
        .ok_or(GitError::Stale)
}

/// Remove a worktree's folder and its administrative files. The branch stays.
pub fn remove(repo: &str, path: &str, force: bool) -> Result<(), GitError> {
    let root = resolve_root(repo)?;
    let _guard = write_lock();
    let (index, w) = find(&root, path)?;
    if index == 0 {
        return Err(GitError::Unsupported(
            "The main worktree cannot be removed.".into(),
        ));
    }
    if same_path(Path::new(&w.path), &root) {
        return Err(GitError::Unsupported(
            "This worktree is open in Branchline. Open another one first.".into(),
        ));
    }
    if let Some(reason) = &w.locked {
        return Err(GitError::Unsupported(if reason.is_empty() {
            "This worktree is locked. Unlock it first.".into()
        } else {
            format!("This worktree is locked ({reason}). Unlock it first.")
        }));
    }
    if w.prunable.is_some() || !Path::new(&w.path).exists() {
        // The folder is gone already; only Git's records remain.
        run_git(&root, &["worktree", "prune"], DEFAULT_TIMEOUT)?;
        return Ok(());
    }
    let mut args = vec!["worktree", "remove"];
    if force {
        args.push("--force");
    }
    args.extend(["--", w.path.as_str()]);
    match run_git(&root, &args, DEFAULT_TIMEOUT) {
        Err(GitError::GitFailed { stderr, .. })
            if stderr.contains("contains modified or untracked files") =>
        {
            Err(GitError::WorktreeDirty { path: w.path })
        }
        other => other.map(|_| ()),
    }
}

/// Lock (keep Git from pruning it, for example on removable media) or unlock a worktree.
pub fn set_locked(repo: &str, path: &str, locked: bool, reason: &str) -> Result<(), GitError> {
    let root = resolve_root(repo)?;
    let _guard = write_lock();
    let (index, w) = find(&root, path)?;
    if index == 0 {
        return Err(GitError::Unsupported(
            "The main worktree cannot be locked.".into(),
        ));
    }
    if locked == w.locked.is_some() {
        return Ok(());
    }
    let reason = reason.trim();
    let mut args = vec!["worktree", if locked { "lock" } else { "unlock" }];
    if locked && !reason.is_empty() {
        args.extend(["--reason", reason]);
    }
    args.extend(["--", w.path.as_str()]);
    run_git(&root, &args, DEFAULT_TIMEOUT)?;
    Ok(())
}

/// Forget worktrees whose folders were deleted. Returns how many were removed.
pub fn prune(repo: &str) -> Result<usize, GitError> {
    let root = resolve_root(repo)?;
    let _guard = write_lock();
    let before = raw_list(&root)?.len();
    run_git(&root, &["worktree", "prune"], DEFAULT_TIMEOUT)?;
    Ok(before.saturating_sub(raw_list(&root)?.len()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_porcelain_records() {
        let text = "worktree /r\nHEAD aaa\nbranch refs/heads/main\n\nworktree /r-x\nHEAD bbb\ndetached\nlocked on usb\n\nworktree /gone\nHEAD ccc\nbranch refs/heads/feature/a\nprunable gitdir file points to non-existent location\n\nworktree /plain\nHEAD ddd\nbranch refs/heads/b\nlocked\n";
        let list = parse_worktrees(text);
        assert_eq!(list.len(), 4);
        assert_eq!(list[0].branch.as_deref(), Some("main"));
        assert!(list[1].detached && list[1].branch.is_none());
        assert_eq!(list[1].locked.as_deref(), Some("on usb"));
        assert_eq!(list[2].branch.as_deref(), Some("feature/a"));
        assert!(list[2].prunable.is_some());
        assert_eq!(list[3].locked.as_deref(), Some(""));
    }

    #[test]
    fn counts_renames_once() {
        assert_eq!(
            count_status_records(b"R  new.md\0old.md\0 M a.txt\0?? b.txt\0"),
            3
        );
        assert_eq!(count_status_records(b""), 0);
    }

    #[test]
    fn maps_branch_in_use_errors() {
        for stderr in [
            "fatal: 'feat' is already used by worktree at '/tmp/wt feat'",
            "fatal: 'feat' is already checked out at '/tmp/wt feat'",
            "error: cannot delete branch 'feat' used by worktree at '/tmp/wt feat'",
            "error: Cannot delete branch 'feat' checked out at '/tmp/wt feat'",
        ] {
            let e = branch_in_use_error(GitError::GitFailed {
                code: 128,
                stderr: stderr.into(),
            });
            match e {
                GitError::BranchInWorktree { branch, path } => {
                    assert_eq!(branch, "feat");
                    assert_eq!(path, "/tmp/wt feat");
                }
                other => panic!("{other:?}"),
            }
        }
    }
}
