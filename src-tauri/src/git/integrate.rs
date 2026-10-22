//! Merge, rebase, cherry-pick and revert, and continuing, skipping or aborting
//! one that stopped with conflicts.
//!
//! * Sources are a local or remote branch (resolved to its full ref) or a
//!   commit id; nothing from the UI reaches Git as a revision expression.
//! * Git never opens an editor: merges and reverts use `--no-edit`, and
//!   `GIT_EDITOR`/`GIT_SEQUENCE_EDITOR` are a no-op for every command here,
//!   so prepared messages are kept as they are.
//! * Stopping with conflicts is a result (`conflicts: true`), not a failure:
//!   the user resolves them and continues, or aborts to get back to where
//!   they started.

use std::path::Path;

use serde::{Deserialize, Serialize};

use super::branches::{start_ref, StartPoint};
use super::log::validate_oid;
use super::ops::write_lock;
use super::repository::{inspect, resolve_root, HeadState, RepoOperation, RepositoryInfo};
use super::runner::{run_git_with, GitOutput, RunOptions};
use crate::error::GitError;

/// Editors are disabled: `:` is a no-op in the shell Git uses to start them.
const NO_EDITOR: &[(&str, &str)] = &[("GIT_EDITOR", ":"), ("GIT_SEQUENCE_EDITOR", ":")];

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IntegrateOutcome {
    /// Stopped with conflicts; the operation is in progress until continued or aborted.
    pub conflicts: bool,
    /// Nothing to do (already merged, already up to date, or already applied).
    pub up_to_date: bool,
    /// The merge only moved the branch forward; no merge commit was made.
    pub fast_forward: bool,
    /// Commits left out of a cherry-pick because their changes are already on the branch.
    pub skipped: usize,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MergeRequest {
    /// Branch or commit to merge into the current branch.
    pub source: StartPoint,
    /// Always create a merge commit, even when a fast-forward is possible.
    #[serde(default)]
    pub no_ff: bool,
    /// Stash local changes first and reapply them afterwards.
    #[serde(default)]
    pub autostash: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Step {
    Continue,
    Skip,
    Abort,
}

pub(crate) fn git(root: &Path, args: &[&str]) -> Result<GitOutput, GitError> {
    run_git_with(
        root,
        args,
        &RunOptions {
            // 2: `git merge` reports a merge strategy that refused to run
            // (for example because of staged changes) with status 2.
            ok_codes: &[0, 1, 2, 128],
            env: NO_EDITOR,
            ..RunOptions::default()
        },
    )
}

fn text(out: &GitOutput) -> String {
    format!("{}\n{}", out.stdout_string(), out.stderr)
}

/// The repository must be on a commit and not in the middle of another operation.
pub(crate) fn ready(repo: &str) -> Result<RepositoryInfo, GitError> {
    let info = inspect(repo)?;
    if let Some(op) = info.operation {
        return Err(GitError::Unsupported(format!(
            "Finish or abort the {} in progress first.",
            operation_name(op)
        )));
    }
    if let HeadState::Unborn { .. } = info.head {
        return Err(GitError::Unsupported(
            "Create the first commit before merging or rebasing.".into(),
        ));
    }
    Ok(info)
}

fn operation_name(op: RepoOperation) -> &'static str {
    match op {
        RepoOperation::Merge => "merge",
        RepoOperation::Rebase => "rebase",
        RepoOperation::CherryPick => "cherry-pick",
        RepoOperation::Revert => "revert",
        RepoOperation::Bisect => "bisect",
    }
}

fn files_in(text: &str) -> Vec<String> {
    text.lines()
        .filter(|l| l.starts_with('\t'))
        .map(|l| l.trim().to_string())
        .collect()
}

/// Turn a failed command into an outcome (stopped with conflicts) or a specific error.
pub(crate) fn conclude(repo: &str, out: &GitOutput) -> Result<IntegrateOutcome, GitError> {
    let all = text(out);
    if out.code == 0 {
        return Ok(IntegrateOutcome {
            up_to_date: all.contains("Already up to date") || all.contains("is up to date"),
            fast_forward: all.contains("Fast-forward"),
            ..IntegrateOutcome::default()
        });
    }
    if inspect(repo)?.operation.is_some() && all.contains("CONFLICT") {
        return Ok(IntegrateOutcome {
            conflicts: true,
            ..IntegrateOutcome::default()
        });
    }
    let detail = all.trim().to_string();
    let lower = all.to_ascii_lowercase();
    if lower.contains("would be overwritten")
        || lower.contains("untracked working tree files would be")
        || lower.contains("you have unstaged changes")
        || lower.contains("your index contains uncommitted changes")
    {
        return Err(GitError::CheckoutConflict {
            files: files_in(&all),
            detail,
        });
    }
    if lower.contains("please tell me who you are") || lower.contains("unable to auto-detect email")
    {
        return Err(GitError::IdentityMissing { detail });
    }
    if lower.contains("refusing to merge unrelated histories") {
        return Err(GitError::Unsupported(
            "These branches have no history in common, so Git refuses to merge them.".into(),
        ));
    }
    if inspect(repo)?.operation.is_some() {
        // Stopped for another reason (for example a hook); the operation can be
        // continued or aborted from the banner.
        return Ok(IntegrateOutcome {
            conflicts: true,
            ..IntegrateOutcome::default()
        });
    }
    Err(GitError::GitFailed {
        code: out.code,
        stderr: detail,
    })
}

/// Use the short branch name when it means exactly that branch, so Git writes its
/// usual message ("Merge branch 'feature'"). Otherwise keep the full ref, which is
/// never ambiguous.
fn display_ref(root: &Path, full: String) -> Result<String, GitError> {
    let short = full
        .strip_prefix("refs/heads/")
        .or_else(|| full.strip_prefix("refs/remotes/"));
    let Some(short) = short.filter(|s| !s.starts_with('-')) else {
        return Ok(full);
    };
    let out = git(root, &["rev-parse", "--symbolic-full-name", short])?;
    if out.code == 0 && out.stderr.trim().is_empty() && out.stdout_string().trim() == full {
        Ok(short.to_string())
    } else {
        Ok(full)
    }
}

fn parent_count(root: &Path, oid: &str) -> Result<usize, GitError> {
    let out = git(root, &["rev-list", "--parents", "-n", "1", oid, "--"])?;
    if out.code != 0 {
        return Err(GitError::Unsupported(format!("Unknown commit {oid}.")));
    }
    Ok(out
        .stdout_string()
        .split_whitespace()
        .count()
        .saturating_sub(1))
}

/// Merge a branch or commit into the current branch.
pub fn merge(repo: &str, request: &MergeRequest) -> Result<IntegrateOutcome, GitError> {
    let root = resolve_root(repo)?;
    let _guard = write_lock();
    ready(repo)?;
    if matches!(request.source, StartPoint::Head) {
        return Err(GitError::Unsupported(
            "Choose a branch or commit to merge.".into(),
        ));
    }
    let source = display_ref(&root, start_ref(&root, &request.source)?)?;
    let mut args = vec!["merge", "--no-edit"];
    if request.no_ff {
        args.push("--no-ff");
    }
    if request.autostash {
        args.push("--autostash");
    }
    args.push(&source);
    let out = git(&root, &args)?;
    conclude(repo, &out)
}

/// Rebase the current branch onto a branch or commit.
pub fn rebase(
    repo: &str,
    onto: &StartPoint,
    autostash: bool,
) -> Result<IntegrateOutcome, GitError> {
    let root = resolve_root(repo)?;
    let _guard = write_lock();
    let info = ready(repo)?;
    if !matches!(info.head, HeadState::Branch { .. }) {
        return Err(GitError::Unsupported(
            "Switch to a branch first; a detached HEAD cannot be rebased.".into(),
        ));
    }
    if matches!(onto, StartPoint::Head) {
        return Err(GitError::Unsupported(
            "Choose a branch or commit to rebase onto.".into(),
        ));
    }
    let target = start_ref(&root, onto)?;
    let mut args = vec!["rebase"];
    if autostash {
        args.push("--autostash");
    }
    args.push(&target);
    let out = git(&root, &args)?;
    conclude(repo, &out)
}

/// Most commits picked in one go; more is almost certainly a mistake in the selection.
pub const MAX_PICK: usize = 100;

/// The step stopped because the commit has no changes left on this branch.
fn now_empty(out: &GitOutput) -> bool {
    let all = text(out);
    out.code != 0 && (all.contains("is now empty") || all.contains("nothing to commit"))
}

fn short(oid: &str) -> &str {
    &oid[..oid.len().min(7)]
}

/// Run a cherry-pick of `count` commits. Commits whose changes are already on the
/// branch are skipped (Git would otherwise stop on each one), and the sequence goes on.
fn pick(
    repo: &str,
    root: &Path,
    args: &[&str],
    count: usize,
) -> Result<IntegrateOutcome, GitError> {
    let mut out = git(root, args)?;
    let mut skipped = 0;
    while now_empty(&out)
        && skipped < count
        && inspect(repo)?.operation == Some(RepoOperation::CherryPick)
    {
        skipped += 1;
        out = git(root, &["cherry-pick", "--skip"])?;
    }
    let mut outcome = conclude(repo, &out)?;
    outcome.skipped = skipped;
    outcome.up_to_date = skipped == count;
    Ok(outcome)
}

/// Apply the changes of one commit on top of the current branch.
pub fn cherry_pick(repo: &str, oid: &str) -> Result<IntegrateOutcome, GitError> {
    let root = resolve_root(repo)?;
    validate_oid(oid)?;
    let _guard = write_lock();
    ready(repo)?;
    let mut args = vec!["cherry-pick"];
    // A merge commit is picked relative to its first parent (the branch it was merged into).
    if parent_count(&root, oid)? > 1 {
        args.extend_from_slice(&["-m", "1"]);
    }
    args.push(oid);
    pick(repo, &root, &args, 1)
}

/// Apply the changes of several commits on top of the current branch, in the order
/// given (the caller sends them oldest first). Stops at the first conflict; Continue
/// then carries on with the rest.
pub fn cherry_pick_many(repo: &str, oids: &[String]) -> Result<IntegrateOutcome, GitError> {
    if oids.is_empty() {
        return Err(GitError::Unsupported(
            "Choose the commits to cherry-pick.".into(),
        ));
    }
    if oids.len() > MAX_PICK {
        return Err(GitError::Unsupported(format!(
            "Cherry-pick at most {MAX_PICK} commits at a time."
        )));
    }
    let mut seen = std::collections::HashSet::new();
    for oid in oids {
        validate_oid(oid)?;
        if !seen.insert(oid.as_str()) {
            return Err(GitError::Unsupported(format!(
                "Commit {} is selected twice.",
                short(oid)
            )));
        }
    }
    if let [oid] = oids {
        return cherry_pick(repo, oid);
    }
    let root = resolve_root(repo)?;
    let _guard = write_lock();
    ready(repo)?;
    for oid in oids {
        if parent_count(&root, oid)? > 1 {
            return Err(GitError::Unsupported(format!(
                "Commit {} is a merge commit. Cherry-pick merge commits one at a time.",
                short(oid)
            )));
        }
    }
    let mut args = vec!["cherry-pick"];
    args.extend(oids.iter().map(String::as_str));
    pick(repo, &root, &args, oids.len())
}

/// Create a commit that undoes one commit.
pub fn revert(repo: &str, oid: &str) -> Result<IntegrateOutcome, GitError> {
    let root = resolve_root(repo)?;
    validate_oid(oid)?;
    let _guard = write_lock();
    ready(repo)?;
    let mut args = vec!["revert", "--no-edit"];
    if parent_count(&root, oid)? > 1 {
        args.extend_from_slice(&["-m", "1"]);
    }
    args.push(oid);
    let out = git(&root, &args)?;
    let all = text(&out);
    if out.code != 0 && all.contains("nothing to commit") {
        git(&root, &["revert", "--skip"])?;
        return Ok(IntegrateOutcome {
            up_to_date: true,
            ..IntegrateOutcome::default()
        });
    }
    conclude(repo, &out)
}

/// Continue, skip or abort the operation in progress.
pub fn step(repo: &str, step: Step) -> Result<IntegrateOutcome, GitError> {
    let root = resolve_root(repo)?;
    let _guard = write_lock();
    let info = inspect(repo)?;
    let Some(op) = info.operation else {
        return Err(GitError::Stale);
    };
    let unresolved = info.changes.iter().filter(|c| c.conflict.is_some()).count();
    if step == Step::Continue && unresolved > 0 {
        return Err(GitError::Unsupported(format!(
            "Resolve {} first.",
            if unresolved == 1 {
                "the conflicted file".to_string()
            } else {
                format!("the {unresolved} conflicted files")
            }
        )));
    }
    let args: &[&str] = match (op, step) {
        // `--cleanup=strip` drops Git's "# Conflicts:" comment lines, which are
        // otherwise kept when no editor runs.
        (RepoOperation::Merge, Step::Continue) => &["commit", "--no-edit", "--cleanup=strip"],
        (RepoOperation::Merge, Step::Abort) => &["merge", "--abort"],
        (RepoOperation::Rebase, Step::Continue) => &["rebase", "--continue"],
        (RepoOperation::Rebase, Step::Skip) => &["rebase", "--skip"],
        (RepoOperation::Rebase, Step::Abort) => &["rebase", "--abort"],
        (RepoOperation::CherryPick, Step::Continue) => &["cherry-pick", "--continue"],
        (RepoOperation::CherryPick, Step::Skip) => &["cherry-pick", "--skip"],
        (RepoOperation::CherryPick, Step::Abort) => &["cherry-pick", "--abort"],
        (RepoOperation::Revert, Step::Continue) => &["revert", "--continue"],
        (RepoOperation::Revert, Step::Skip) => &["revert", "--skip"],
        (RepoOperation::Revert, Step::Abort) => &["revert", "--abort"],
        (RepoOperation::Bisect, Step::Abort) => &["bisect", "reset"],
        (op, _) => {
            return Err(GitError::Unsupported(format!(
                "That is not possible during a {}.",
                operation_name(op)
            )))
        }
    };
    let out = git(&root, args)?;
    if inspect(repo)?.operation.is_none() {
        super::rebase_plan::remove_message_files(&root);
    }
    if out.code == 0 {
        return Ok(IntegrateOutcome::default());
    }
    let all = text(&out);
    if all.contains("did you forget to use 'git add'")
        || all.contains("nothing to commit")
        || all.contains("is now empty")
    {
        return Err(GitError::Unsupported(
            "This step has no changes left (they are already on the branch). Skip it instead."
                .into(),
        ));
    }
    if all.contains("pre-commit") || all.contains("hook") {
        return Err(GitError::CommitFailed {
            detail: all.trim().to_string(),
        });
    }
    conclude(repo, &out)
}
