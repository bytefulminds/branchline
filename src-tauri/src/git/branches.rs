//! Branch listing and management: create, switch, rename and delete.
//!
//! Branch names from the UI are validated with `git check-ref-format` plus
//! extra rules (no leading dash, not `HEAD`), and always passed after `--` or as
//! full ref names, so they can never be read as options, paths or revisions.

use std::path::Path;

use serde::{Deserialize, Serialize};

use super::log::validate_oid;
use super::ops::write_lock;
use super::repository::resolve_root;
use super::runner::{run_git, DEFAULT_TIMEOUT};
use crate::error::GitError;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchInfo {
    /// Short name: `main`, or `origin/main` for remote branches.
    pub name: String,
    pub remote: Option<String>,
    pub oid: String,
    pub is_current: bool,
    /// Upstream short name for local branches (`origin/main`).
    pub upstream: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    /// The configured upstream no longer exists.
    pub upstream_gone: bool,
    /// Committer time of the tip, seconds since the Unix epoch.
    pub tip_time: i64,
    pub tip_summary: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchList {
    pub local: Vec<BranchInfo>,
    pub remote: Vec<BranchInfo>,
}

/// Parse `%(upstream:track,nobracket)`: `ahead 2, behind 1`, `gone`, or empty.
pub fn parse_track(track: &str) -> (u32, u32, bool) {
    if track.trim() == "gone" {
        return (0, 0, true);
    }
    let (mut ahead, mut behind) = (0, 0);
    for part in track.split(',') {
        let mut words = part.split_whitespace();
        match (words.next(), words.next().and_then(|n| n.parse().ok())) {
            (Some("ahead"), Some(n)) => ahead = n,
            (Some("behind"), Some(n)) => behind = n,
            _ => {}
        }
    }
    (ahead, behind, false)
}

pub fn parse_branches(output: &[u8]) -> BranchList {
    let text = String::from_utf8_lossy(output);
    let mut list = BranchList {
        local: Vec::new(),
        remote: Vec::new(),
    };
    for line in text.lines() {
        let f: Vec<&str> = line.splitn(7, '\0').collect();
        if f.len() != 7 {
            continue;
        }
        let (refname, oid, upstream, track, head, time, summary) =
            (f[0], f[1], f[2], f[3], f[4], f[5], f[6]);
        let tip_time = time.trim().parse().unwrap_or(0);
        if let Some(name) = refname.strip_prefix("refs/heads/") {
            let (ahead, behind, gone) = parse_track(track);
            list.local.push(BranchInfo {
                name: name.to_string(),
                remote: None,
                oid: oid.to_string(),
                is_current: head == "*",
                upstream: upstream
                    .strip_prefix("refs/remotes/")
                    .map(str::to_string)
                    .filter(|s| !s.is_empty()),
                ahead,
                behind,
                upstream_gone: gone,
                tip_time,
                tip_summary: summary.to_string(),
            });
        } else if let Some(name) = refname.strip_prefix("refs/remotes/") {
            if name.ends_with("/HEAD") {
                continue;
            }
            let remote = name.split('/').next().unwrap_or_default().to_string();
            list.remote.push(BranchInfo {
                name: name.to_string(),
                remote: Some(remote),
                oid: oid.to_string(),
                is_current: false,
                upstream: None,
                ahead: 0,
                behind: 0,
                upstream_gone: false,
                tip_time,
                tip_summary: summary.to_string(),
            });
        }
    }
    list
}

pub fn list_branches(root: &Path) -> Result<BranchList, GitError> {
    let out = run_git(
        root,
        &[
            "for-each-ref",
            "--format=%(refname)%00%(objectname)%00%(upstream)%00%(upstream:track,nobracket)%00%(HEAD)%00%(committerdate:unix)%00%(contents:subject)",
            "refs/heads",
            "refs/remotes",
        ],
        DEFAULT_TIMEOUT,
    )?;
    Ok(parse_branches(&out.stdout))
}

/// Validate a new local branch name. Returns a user-facing reason when invalid.
pub fn validate_branch_name(root: &Path, name: &str) -> Result<(), GitError> {
    let invalid = |why: &str| Err(GitError::InvalidBranchName(why.to_string()));
    if name.trim().is_empty() {
        return invalid("Enter a branch name.");
    }
    if name != name.trim() || name.contains(char::is_whitespace) {
        return invalid("Branch names cannot contain spaces.");
    }
    if name.starts_with('-') {
        return invalid("Branch names cannot start with a dash.");
    }
    if name == "HEAD" || name == "@" {
        return invalid("This name is reserved by Git.");
    }
    let refname = format!("refs/heads/{name}");
    match run_git(root, &["check-ref-format", &refname], DEFAULT_TIMEOUT) {
        Ok(_) => Ok(()),
        Err(GitError::GitFailed { .. }) => invalid(
            "Not a valid branch name. Avoid `..`, `~`, `^`, `:`, `?`, `*`, `[`, `\\`, a trailing `.lock` and leading or trailing `/` or `.`.",
        ),
        Err(e) => Err(e),
    }
}

fn find_local<'a>(list: &'a BranchList, name: &str) -> Result<&'a BranchInfo, GitError> {
    list.local
        .iter()
        .find(|b| b.name == name)
        .ok_or_else(|| GitError::Unsupported(format!("There is no local branch named {name}.")))
}

/// Map Git's "your local changes would be overwritten" refusal to a clear error.
fn checkout_error(e: GitError) -> GitError {
    match e {
        GitError::GitFailed { stderr, .. }
            if stderr.contains("would be overwritten by checkout")
                || stderr.contains("Please commit your changes or stash them") =>
        {
            let files = stderr
                .lines()
                .filter(|l| l.starts_with('\t'))
                .map(|l| l.trim().to_string())
                .collect();
            GitError::CheckoutConflict {
                files,
                detail: stderr,
            }
        }
        other => other,
    }
}

/// Where a new branch starts: a commit id or an existing branch.
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum StartPoint {
    Head,
    Commit { oid: String },
    Branch { name: String },
}

pub(crate) fn start_ref(root: &Path, start: &StartPoint) -> Result<String, GitError> {
    Ok(match start {
        StartPoint::Head => "HEAD".to_string(),
        StartPoint::Commit { oid } => validate_oid(oid)?.to_string(),
        StartPoint::Branch { name } => {
            let list = list_branches(root)?;
            if list.local.iter().any(|b| &b.name == name) {
                format!("refs/heads/{name}")
            } else if list.remote.iter().any(|b| &b.name == name) {
                format!("refs/remotes/{name}")
            } else {
                return Err(GitError::Unsupported(format!(
                    "There is no branch named {name}."
                )));
            }
        }
    })
}

pub fn create_branch(
    repo: &str,
    name: &str,
    start: &StartPoint,
    checkout: bool,
) -> Result<(), GitError> {
    let root = resolve_root(repo)?;
    let _guard = write_lock();
    validate_branch_name(&root, name)?;
    if list_branches(&root)?.local.iter().any(|b| b.name == name) {
        return Err(GitError::InvalidBranchName(format!(
            "A branch named {name} already exists."
        )));
    }
    let start = start_ref(&root, start)?;
    if checkout {
        run_git(
            &root,
            &["checkout", "-q", "-b", name, &start, "--"],
            DEFAULT_TIMEOUT,
        )
        .map_err(checkout_error)?;
    } else {
        run_git(&root, &["branch", "--", name, &start], DEFAULT_TIMEOUT)?;
    }
    Ok(())
}

/// Switch to a local branch.
pub fn switch_branch(repo: &str, name: &str) -> Result<(), GitError> {
    let root = resolve_root(repo)?;
    let _guard = write_lock();
    let list = list_branches(&root)?;
    let branch = find_local(&list, name)?;
    if branch.is_current {
        return Ok(());
    }
    // Trailing `--` makes Git treat the name as a branch even if a file has the same name.
    run_git(&root, &["checkout", "-q", name, "--"], DEFAULT_TIMEOUT).map_err(checkout_error)?;
    Ok(())
}

/// Create a local branch tracking `remote_branch` (for example `origin/feature`) and switch to it.
/// If a local branch with that name already tracks it, switch to that instead.
pub fn checkout_remote_branch(repo: &str, remote_branch: &str) -> Result<String, GitError> {
    let root = resolve_root(repo)?;
    let _guard = write_lock();
    let list = list_branches(&root)?;
    let remote = list
        .remote
        .iter()
        .find(|b| b.name == remote_branch)
        .ok_or_else(|| {
            GitError::Unsupported(format!("There is no remote branch named {remote_branch}."))
        })?;
    let local_name = remote_branch
        .strip_prefix(&format!(
            "{}/",
            remote.remote.as_deref().unwrap_or_default()
        ))
        .unwrap_or(remote_branch)
        .to_string();
    if let Some(existing) = list.local.iter().find(|b| b.name == local_name) {
        if existing.upstream.as_deref() == Some(remote_branch) {
            if !existing.is_current {
                run_git(
                    &root,
                    &["checkout", "-q", &local_name, "--"],
                    DEFAULT_TIMEOUT,
                )
                .map_err(checkout_error)?;
            }
            return Ok(local_name);
        }
        return Err(GitError::InvalidBranchName(format!(
            "A local branch named {local_name} already exists and tracks something else."
        )));
    }
    validate_branch_name(&root, &local_name)?;
    let full = format!("refs/remotes/{remote_branch}");
    run_git(
        &root,
        &["checkout", "-q", "-b", &local_name, "--track", &full, "--"],
        DEFAULT_TIMEOUT,
    )
    .map_err(checkout_error)?;
    Ok(local_name)
}

/// Check out a commit without a branch (detached HEAD).
pub fn checkout_detached(repo: &str, oid: &str) -> Result<(), GitError> {
    let root = resolve_root(repo)?;
    let _guard = write_lock();
    validate_oid(oid)?;
    run_git(
        &root,
        &["checkout", "-q", "--detach", oid, "--"],
        DEFAULT_TIMEOUT,
    )
    .map_err(checkout_error)?;
    Ok(())
}

pub fn rename_branch(repo: &str, old: &str, new: &str) -> Result<(), GitError> {
    let root = resolve_root(repo)?;
    let _guard = write_lock();
    let list = list_branches(&root)?;
    find_local(&list, old)?;
    if old == new {
        return Ok(());
    }
    validate_branch_name(&root, new)?;
    if list.local.iter().any(|b| b.name == new) {
        return Err(GitError::InvalidBranchName(format!(
            "A branch named {new} already exists."
        )));
    }
    run_git(&root, &["branch", "-m", "--", old, new], DEFAULT_TIMEOUT)?;
    Ok(())
}

/// Delete a local branch. Without `force`, Git refuses to delete unmerged work
/// and Branchline reports [`GitError::NotMerged`] so the UI can ask first.
pub fn delete_branch(repo: &str, name: &str, force: bool) -> Result<(), GitError> {
    let root = resolve_root(repo)?;
    let _guard = write_lock();
    let list = list_branches(&root)?;
    let branch = find_local(&list, name)?;
    if branch.is_current {
        return Err(GitError::Unsupported(
            "You cannot delete the branch you are on. Switch to another branch first.".into(),
        ));
    }
    let flag = if force { "-D" } else { "-d" };
    match run_git(&root, &["branch", flag, "--", name], DEFAULT_TIMEOUT) {
        Ok(_) => Ok(()),
        Err(GitError::GitFailed { stderr, .. }) if stderr.contains("not fully merged") => {
            Err(GitError::NotMerged {
                branch: name.to_string(),
            })
        }
        Err(e) => Err(e),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_tracking_info() {
        assert_eq!(parse_track(""), (0, 0, false));
        assert_eq!(parse_track("ahead 2"), (2, 0, false));
        assert_eq!(parse_track("behind 5"), (0, 5, false));
        assert_eq!(parse_track("ahead 1, behind 3"), (1, 3, false));
        assert_eq!(parse_track("gone"), (0, 0, true));
    }

    #[test]
    fn parses_branch_listing() {
        let out = b"refs/heads/main\x00aaa\x00refs/remotes/origin/main\x00ahead 1, behind 2\x00*\x001700000000\x00Fix: things\nrefs/heads/old\x00bbb\x00refs/remotes/origin/old\x00gone\x00 \x001600000000\x00x\nrefs/remotes/origin/HEAD\x00aaa\x00\x00\x00 \x001\x00\nrefs/remotes/origin/main\x00ccc\x00\x00\x00 \x001700000001\x00Remote tip\n";
        let l = parse_branches(out);
        assert_eq!(l.local.len(), 2);
        assert!(l.local[0].is_current);
        assert_eq!(l.local[0].upstream.as_deref(), Some("origin/main"));
        assert_eq!((l.local[0].ahead, l.local[0].behind), (1, 2));
        assert!(l.local[1].upstream_gone);
        assert_eq!(l.remote.len(), 1, "origin/HEAD is skipped");
        assert_eq!(l.remote[0].remote.as_deref(), Some("origin"));
        assert_eq!(l.remote[0].tip_summary, "Remote tip");
    }
}
