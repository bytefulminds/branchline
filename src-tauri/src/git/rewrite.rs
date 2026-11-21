//! Remembering that a pushed branch was rewritten here, so the next push can be a force push
//! that is safe.
//!
//! Before Branchline rewrites a branch (reset, edit message, move, drop, interactive rebase,
//! rebase, amend), it records where the branch's upstream was in the repository's own Git
//! configuration, as `branch.<name>.branchlineRewrittenFrom`. Git ignores keys it does not
//! know, renames them with the branch and removes them when the branch is deleted.
//!
//! A branch counts as rewritten while that recorded commit is no longer part of it. The force
//! push then uses `--force-with-lease=<branch>:<recorded commit>`: if anyone pushed after the
//! rewrite, the push is refused, even when those commits were fetched since (a plain lease
//! would let them be overwritten). The record is removed after a successful push.

use std::path::Path;

use serde::Serialize;

use super::integrate::{cherry_pick_many, IntegrateOutcome, MAX_PICK};
use super::log::validate_oid;
use super::repository::resolve_root;
use super::runner::{run_git_with, GitOutput, RunOptions};
use crate::error::GitError;

/// A pushed branch that was rewritten and needs a force push.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RewriteInfo {
    /// The upstream commit the branch was rewritten from: the lease for the force push.
    pub lease: String,
    /// Pushed commits that are no longer part of the branch.
    pub replaced: u32,
    /// Commits pushed by someone else after the rewrite (known from the last fetch).
    pub pushed_since: u32,
}

fn key(branch: &str) -> String {
    format!("branch.{branch}.branchlineRewrittenFrom")
}

fn git(root: &Path, args: &[&str]) -> Result<GitOutput, GitError> {
    run_git_with(
        root,
        args,
        &RunOptions {
            ok_codes: &[0, 1, 5, 128],
            ..RunOptions::default()
        },
    )
}

fn text(out: &GitOutput) -> Option<String> {
    let t = out.stdout_string().trim().to_string();
    (out.code == 0 && !t.is_empty()).then_some(t)
}

fn current_branch(root: &Path) -> Result<Option<String>, GitError> {
    Ok(text(&git(
        root,
        &["symbolic-ref", "--short", "-q", "HEAD"],
    )?))
}

fn upstream_tip(root: &Path) -> Result<Option<String>, GitError> {
    Ok(text(&git(
        root,
        &["rev-parse", "--verify", "-q", "@{upstream}^{commit}"],
    )?))
}

fn is_ancestor(root: &Path, a: &str, b: &str) -> Result<bool, GitError> {
    Ok(git(root, &["merge-base", "--is-ancestor", a, b])?.code == 0)
}

fn count(root: &Path, range: &str) -> Result<u32, GitError> {
    Ok(text(&git(root, &["rev-list", "--count", range, "--"])?)
        .and_then(|t| t.parse().ok())
        .unwrap_or(0))
}

/// The recorded upstream commit of `branch`, if any.
fn recorded(root: &Path, branch: &str) -> Result<Option<String>, GitError> {
    Ok(
        text(&git(root, &["config", "--local", "--get", &key(branch)])?)
            .filter(|o| validate_oid(o).is_ok()),
    )
}

/// Call before rewriting the current branch. Records its upstream commit when everything on
/// the upstream is part of the branch: then the force push afterwards only replaces your own
/// commits. When the upstream has commits the branch lacks, nothing is recorded, so a later
/// push asks you to pull first instead of offering to overwrite them.
pub fn remember_before_rewrite(root: &Path) -> Result<(), GitError> {
    let Some(branch) = current_branch(root)? else {
        return Ok(());
    };
    let Some(upstream) = upstream_tip(root)? else {
        return Ok(());
    };
    // An earlier rewrite that was not pushed yet keeps its record: that is the remote
    // commit the force push may replace.
    if let Some(earlier) = recorded(root, &branch)? {
        if !is_ancestor(root, &earlier, "HEAD")? {
            return Ok(());
        }
    }
    if is_ancestor(root, &upstream, "HEAD")? {
        git(root, &["config", "--local", &key(&branch), &upstream])?;
    } else {
        forget(root, &branch)?;
    }
    Ok(())
}

/// Drop the record, for example after the branch was pushed.
pub fn forget(root: &Path, branch: &str) -> Result<(), GitError> {
    git(root, &["config", "--local", "--unset-all", &key(branch)])?;
    Ok(())
}

/// Whether `branch` (checked out, with an upstream) was rewritten and needs a force push.
pub fn status(root: &Path, branch: &str) -> Result<Option<RewriteInfo>, GitError> {
    let Some(lease) = recorded(root, branch)? else {
        return Ok(None);
    };
    // The recorded commit is still part of the branch: nothing was rewritten (an aborted
    // rebase, or the rewrite was undone).
    if is_ancestor(root, &lease, "HEAD")? {
        return Ok(None);
    }
    let Some(upstream) = upstream_tip(root)? else {
        return Ok(None);
    };
    let head = text(&git(root, &["rev-parse", "HEAD"])?).unwrap_or_default();
    if upstream == head {
        return Ok(None);
    }
    Ok(Some(RewriteInfo {
        replaced: count(root, &format!("HEAD..{lease}"))?,
        pushed_since: count(root, &format!("{lease}..{upstream}"))?,
        lease,
    }))
}

/// Someone pushed after the rewrite: apply their new commits on top of the rewritten branch,
/// and move the record to the upstream as it is now, so the next force push keeps them.
pub fn bring_in_pushed(repo: &str) -> Result<IntegrateOutcome, GitError> {
    let root = resolve_root(repo)?;
    let branch = current_branch(&root)?
        .ok_or_else(|| GitError::Unsupported("Switch to the branch first.".into()))?;
    let lease = recorded(&root, &branch)?.ok_or_else(|| {
        GitError::Unsupported(format!("{branch} was not rewritten in Branchline."))
    })?;
    let upstream = upstream_tip(&root)?
        .ok_or_else(|| GitError::Unsupported(format!("{branch} has no upstream branch.")))?;
    let range = format!("{lease}..{upstream}");
    let out = git(&root, &["rev-list", "--reverse", "--parents", &range, "--"])?;
    let mut oids = Vec::new();
    for line in out.stdout_string().lines() {
        let mut ids = line.split_whitespace();
        let Some(oid) = ids.next() else { continue };
        if ids.count() > 1 {
            return Err(GitError::Unsupported(
                "The new commits on the remote include a merge. Pull or rebase by hand instead."
                    .into(),
            ));
        }
        oids.push(oid.to_string());
    }
    if oids.is_empty() {
        return Err(GitError::Unsupported(
            "Nobody pushed after your rewrite. Fetch to be sure, then force push.".into(),
        ));
    }
    if oids.len() > MAX_PICK {
        return Err(GitError::Unsupported(format!(
            "More than {MAX_PICK} commits were pushed since your rewrite. Rebase by hand instead."
        )));
    }
    git(&root, &["config", "--local", &key(&branch), &upstream])?;
    cherry_pick_many(repo, &oids)
}
