//! Working-tree operations: stage, unstage and discard, for whole files and
//! for selected hunks or lines.
//!
//! All operations hold a process-wide write lock so Branchline never runs two
//! index-modifying Git commands at once. Destructive operations re-read the
//! repository state first and only act on paths whose state matches what the
//! user saw.

use std::path::Path;
use std::sync::Mutex;

use serde::Deserialize;

use super::diff::{file_diff, DiffArea};
use super::patch::{build_patch, Direction, HunkSelection};
use super::paths::validate_all;
use super::repository::resolve_root;
use super::runner::{run_git, run_git_with, RunOptions, DEFAULT_TIMEOUT};
use super::status::{parse_status, ChangeKind};
use crate::error::GitError;

static WRITE_LOCK: Mutex<()> = Mutex::new(());

fn write_lock() -> std::sync::MutexGuard<'static, ()> {
    // A panic while holding the lock leaves no partial state we track; continue.
    WRITE_LOCK.lock().unwrap_or_else(|e| e.into_inner())
}

fn with_paths<'a>(base: &[&'a str], paths: &[&'a str]) -> Vec<&'a str> {
    let mut args = base.to_vec();
    args.push("--");
    args.extend_from_slice(paths);
    args
}

fn head_is_unborn(root: &Path) -> Result<bool, GitError> {
    match run_git(
        root,
        &["rev-parse", "--verify", "-q", "HEAD"],
        DEFAULT_TIMEOUT,
    ) {
        Ok(_) => Ok(false),
        Err(GitError::GitFailed { code: 1, .. }) => Ok(true),
        Err(e) => Err(e),
    }
}

/// Stage whole files (including deletions, untracked files and resolved conflicts).
pub fn stage_files(repo: &str, paths: &[String]) -> Result<(), GitError> {
    let root = resolve_root(repo)?;
    let paths = validate_all(paths)?;
    let _guard = write_lock();
    run_git(&root, &with_paths(&["add", "-A"], &paths), DEFAULT_TIMEOUT)?;
    Ok(())
}

/// Remove whole files from the index, keeping working-tree content.
pub fn unstage_files(repo: &str, paths: &[String]) -> Result<(), GitError> {
    let root = resolve_root(repo)?;
    let paths = validate_all(paths)?;
    let _guard = write_lock();
    if head_is_unborn(&root)? {
        run_git(
            &root,
            &with_paths(&["rm", "--cached", "-r", "-q", "--ignore-unmatch"], &paths),
            DEFAULT_TIMEOUT,
        )?;
    } else {
        run_git(
            &root,
            &with_paths(&["reset", "-q"], &paths),
            DEFAULT_TIMEOUT,
        )?;
    }
    Ok(())
}

/// Discard unstaged changes of whole files. Untracked files are deleted.
///
/// Every path must currently have unstaged changes; staged content is never touched.
pub fn discard_files(repo: &str, paths: &[String]) -> Result<(), GitError> {
    let root = resolve_root(repo)?;
    let paths = validate_all(paths)?;
    let _guard = write_lock();

    let status = run_git(
        &root,
        &[
            "status",
            "--porcelain=v2",
            "-z",
            "--untracked-files=all",
            "--no-renames",
        ],
        DEFAULT_TIMEOUT,
    )?;
    let summary = parse_status(&status.stdout)?;

    let mut tracked = Vec::new();
    let mut untracked = Vec::new();
    for p in &paths {
        let change = summary
            .changes
            .iter()
            .find(|c| c.path == *p)
            .ok_or_else(|| GitError::Unsupported(format!("{p} has no changes to discard.")))?;
        if change.conflict.is_some() {
            return Err(GitError::Unsupported(format!(
                "{p} has a merge conflict. Resolve it instead of discarding."
            )));
        }
        match change.worktree_status {
            Some(ChangeKind::Untracked) => untracked.push(*p),
            Some(_) => tracked.push(*p),
            None => {
                return Err(GitError::Unsupported(format!(
                    "{p} has no unstaged changes to discard."
                )))
            }
        }
    }

    if !tracked.is_empty() {
        // Restore from the index, so staged changes survive.
        run_git(
            &root,
            &with_paths(&["checkout", "-q"], &tracked),
            DEFAULT_TIMEOUT,
        )?;
    }
    if !untracked.is_empty() {
        run_git(
            &root,
            &with_paths(&["clean", "-f", "-q"], &untracked),
            DEFAULT_TIMEOUT,
        )?;
    }
    Ok(())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum LineAction {
    Stage,
    Unstage,
    Discard,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LineRequest {
    pub path: String,
    pub action: LineAction,
    /// Fingerprint of the diff the user selected from.
    pub fingerprint: String,
    pub selections: Vec<HunkSelection>,
}

/// Stage, unstage or discard selected hunks or lines of one file.
pub fn apply_lines(repo: &str, req: &LineRequest) -> Result<(), GitError> {
    let root = resolve_root(repo)?;
    let _guard = write_lock();

    let (area, direction, cached) = match req.action {
        LineAction::Stage => (DiffArea::Unstaged, Direction::Forward, true),
        LineAction::Unstage => (DiffArea::Staged, Direction::Reverse, true),
        LineAction::Discard => (DiffArea::Unstaged, Direction::Reverse, false),
    };
    // Recompute the diff now; never trust line content sent by the UI.
    let diff = file_diff(&root, &req.path, None, area, true)?;
    if diff.fingerprint != req.fingerprint {
        return Err(GitError::Stale);
    }
    if !diff.supports_partial {
        return Err(GitError::Unsupported(
            "Only whole-file operations are possible for this file.".into(),
        ));
    }
    let patch = build_patch(&diff.parsed, &req.selections, direction)?;

    let mut args = vec!["apply", "--recount", "--whitespace=nowarn"];
    if cached {
        args.push("--cached");
    }
    if direction == Direction::Reverse {
        args.push("--reverse");
    }
    args.push("-");
    match run_git_with(
        &root,
        &args,
        &RunOptions {
            timeout: DEFAULT_TIMEOUT,
            stdin: Some(&patch),
            ..RunOptions::default()
        },
    ) {
        Ok(_) => Ok(()),
        Err(GitError::GitFailed { stderr, .. }) => Err(GitError::ApplyFailed { detail: stderr }),
        Err(e) => Err(e),
    }
}
