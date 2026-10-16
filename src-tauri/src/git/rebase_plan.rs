//! Interactive rebase: reorder, reword, squash, fixup and drop commits.
//!
//! Branchline builds the rebase plan itself and hands it to `git rebase -i`
//! through `GIT_SEQUENCE_EDITOR`, which only copies the prepared plan into
//! place. The plan's path is passed in an environment variable, never as part
//! of a shell command, so unusual folder names cannot inject anything.
//!
//! * The plan must name every commit after `base` exactly once; dropping is
//!   explicit. Ranges with merge commits are refused (they cannot be replayed
//!   faithfully without `--rebase-merges`).
//! * Rewording is `pick` followed by `exec git commit --amend -F <file>`: the
//!   message is written to a file in the Git directory and its path is quoted
//!   for the shell. The files are removed when the rebase ends.
//! * Squash keeps both messages, fixup keeps the earlier one; no editor opens.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::integrate::{conclude, git, ready, IntegrateOutcome};
use super::log::validate_oid;
use super::ops::write_lock;
use super::repository::{inspect, resolve_paths, HeadState};
use super::runner::{run_git_with, RunOptions};
use crate::error::GitError;

/// Most commits Branchline offers to rebase interactively at once.
pub const MAX_PLAN: usize = 300;

const MESSAGE_PREFIX: &str = "branchline-reword-";
const PLAN_FILE: &str = "branchline-rebase-plan";

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanCommit {
    pub oid: String,
    pub summary: String,
    /// Full message, used as the starting point for rewording.
    pub message: String,
    pub author_name: String,
    /// Seconds since the Unix epoch.
    pub author_time: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum PlanAction {
    Pick,
    Reword,
    Squash,
    Fixup,
    Drop,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanStep {
    pub oid: String,
    pub action: PlanAction,
    /// New message for `reword`.
    #[serde(default)]
    pub message: Option<String>,
}

/// Commits after `base` up to HEAD, oldest first, as a starting plan.
pub fn plan_commits(repo: &str, base: &str) -> Result<Vec<PlanCommit>, GitError> {
    let (root, _) = resolve_paths(repo)?;
    validate_oid(base)?;
    let commits = range(&root, base)?;
    Ok(commits)
}

fn range(root: &Path, base: &str) -> Result<Vec<PlanCommit>, GitError> {
    let ancestor = git(root, &["merge-base", "--is-ancestor", base, "HEAD"])?;
    if ancestor.code != 0 {
        return Err(GitError::Unsupported(
            "That commit is not part of the current branch.".into(),
        ));
    }
    let limit = format!("--max-count={}", MAX_PLAN + 1);
    let range = format!("{base}..HEAD");
    let out = run_git_with(
        root,
        &[
            "log",
            "--reverse",
            &limit,
            "--format=%H%x00%P%x00%an%x00%at%x00%B%x1e",
            &range,
            "--",
        ],
        &RunOptions::default(),
    )?;
    let text = out.stdout_string();
    let mut commits = Vec::new();
    for record in text.split('\u{1e}') {
        let record = record.trim_start_matches('\n');
        if record.is_empty() {
            continue;
        }
        let f: Vec<&str> = record.splitn(5, '\0').collect();
        if f.len() != 5 {
            continue;
        }
        if f[1].split_whitespace().count() > 1 {
            return Err(GitError::Unsupported(
                "The range contains merge commits, which interactive rebase cannot reorder. Choose a later starting commit.".into(),
            ));
        }
        let message = f[4].trim_end().to_string();
        commits.push(PlanCommit {
            oid: f[0].to_string(),
            summary: message.lines().next().unwrap_or("").to_string(),
            message,
            author_name: f[2].to_string(),
            author_time: f[3].trim().parse().unwrap_or(0),
        });
    }
    if commits.len() > MAX_PLAN {
        return Err(GitError::Unsupported(format!(
            "More than {MAX_PLAN} commits; choose a later starting commit."
        )));
    }
    if commits.is_empty() {
        return Err(GitError::Unsupported(
            "There are no commits after that one on the current branch.".into(),
        ));
    }
    Ok(commits)
}

/// Quote a string for POSIX `sh` (used for paths in `exec` lines).
pub fn shell_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\"'\"'"))
}

/// Check the plan against the commits it rewrites and build the todo text.
/// Returns the todo and the reword messages to write (file name, message).
pub fn build_todo(
    commits: &[PlanCommit],
    plan: &[PlanStep],
    git_dir: &Path,
) -> Result<(String, Vec<(PathBuf, String)>), GitError> {
    let invalid = |why: String| Err(GitError::Unsupported(why));
    if plan.len() != commits.len() {
        return invalid(
            "The plan does not match the commits on the branch. Reload and try again.".into(),
        );
    }
    for c in commits {
        if plan.iter().filter(|s| s.oid == c.oid).count() != 1 {
            return invalid(
                "The plan does not match the commits on the branch. Reload and try again.".into(),
            );
        }
    }
    let kept: Vec<&PlanStep> = plan
        .iter()
        .filter(|s| s.action != PlanAction::Drop)
        .collect();
    if kept.is_empty() {
        return invalid("Keep at least one commit, or reset the branch instead.".into());
    }
    if matches!(kept[0].action, PlanAction::Squash | PlanAction::Fixup) {
        return invalid(
            "The first commit to keep cannot be squashed or fixed up: there is nothing before it to combine with.".into(),
        );
    }

    let mut todo = String::new();
    let mut messages = Vec::new();
    for step in plan {
        validate_oid(&step.oid)?;
        match step.action {
            PlanAction::Pick => todo.push_str(&format!("pick {}\n", step.oid)),
            PlanAction::Squash => todo.push_str(&format!("squash {}\n", step.oid)),
            PlanAction::Fixup => todo.push_str(&format!("fixup {}\n", step.oid)),
            PlanAction::Drop => todo.push_str(&format!("drop {}\n", step.oid)),
            PlanAction::Reword => {
                let message = step.message.as_deref().unwrap_or("").trim();
                if message.is_empty() {
                    return invalid("A reworded commit needs a message.".into());
                }
                let file = git_dir.join(format!("{MESSAGE_PREFIX}{}.txt", messages.len() + 1));
                todo.push_str(&format!("pick {}\n", step.oid));
                todo.push_str(&format!(
                    "exec git commit --amend --no-verify --cleanup=strip --file={}\n",
                    shell_quote(&file.to_string_lossy())
                ));
                messages.push((file, format!("{message}\n")));
            }
        }
    }
    Ok((todo, messages))
}

/// Remove reword message files and the plan left in the Git directory.
pub fn remove_message_files(root: &Path) {
    let Ok((_, git_dir)) = resolve_paths(&root.to_string_lossy()) else {
        return;
    };
    let _ = std::fs::remove_file(git_dir.join(PLAN_FILE));
    if let Ok(entries) = std::fs::read_dir(&git_dir) {
        for entry in entries.flatten() {
            if entry
                .file_name()
                .to_string_lossy()
                .starts_with(MESSAGE_PREFIX)
            {
                let _ = std::fs::remove_file(entry.path());
            }
        }
    }
}

/// Rewrite the commits after `base` according to `plan`.
pub fn interactive_rebase(
    repo: &str,
    base: &str,
    plan: &[PlanStep],
    autostash: bool,
) -> Result<IntegrateOutcome, GitError> {
    let (root, git_dir) = resolve_paths(repo)?;
    validate_oid(base)?;
    let _guard = write_lock();
    let info = ready(repo)?;
    if !matches!(info.head, HeadState::Branch { .. }) {
        return Err(GitError::Unsupported(
            "Switch to a branch first; a detached HEAD cannot be rebased.".into(),
        ));
    }
    let commits = range(&root, base)?;
    let (todo, messages) = build_todo(&commits, plan, &git_dir)?;
    let io =
        |e: std::io::Error| GitError::Internal(format!("could not write the rebase plan: {e}"));
    for (file, message) in &messages {
        std::fs::write(file, message).map_err(io)?;
    }
    let plan_file = git_dir.join(PLAN_FILE);
    std::fs::write(&plan_file, &todo).map_err(io)?;

    let plan_path = plan_file.to_string_lossy().into_owned();
    let mut args = vec!["rebase", "--interactive", "--no-autosquash"];
    if autostash {
        args.push("--autostash");
    }
    args.push(base);
    let out = run_git_with(
        &root,
        &args,
        &RunOptions {
            ok_codes: &[0, 1, 128],
            env: &[
                // Copy the prepared plan over Git's todo file. The path comes from the
                // environment, so it is never interpreted by the shell.
                ("GIT_SEQUENCE_EDITOR", "cat \"$BRANCHLINE_REBASE_PLAN\" >"),
                ("BRANCHLINE_REBASE_PLAN", &plan_path),
                ("GIT_EDITOR", ":"),
            ],
            ..RunOptions::default()
        },
    )?;
    let outcome = conclude(repo, &out);
    if inspect(repo)?.operation.is_none() {
        remove_message_files(&root);
    }
    outcome
}

#[cfg(test)]
mod tests {
    use super::*;

    fn commit(oid: &str) -> PlanCommit {
        PlanCommit {
            oid: oid.into(),
            summary: oid.into(),
            message: oid.into(),
            author_name: "A".into(),
            author_time: 0,
        }
    }
    fn step(oid: &str, action: PlanAction) -> PlanStep {
        PlanStep {
            oid: oid.into(),
            action,
            message: None,
        }
    }
    const A: &str = "aaaaaaa1";
    const B: &str = "bbbbbbb2";
    const C: &str = "ccccccc3";

    #[test]
    fn quotes_paths_for_the_shell() {
        assert_eq!(shell_quote("/a b/c"), "'/a b/c'");
        assert_eq!(shell_quote("/it's $HOME"), "'/it'\"'\"'s $HOME'");
    }

    #[test]
    fn builds_a_todo_with_rewords_as_exec_amend() {
        let commits = [commit(A), commit(B), commit(C)];
        let plan = [
            step(C, PlanAction::Pick),
            PlanStep {
                message: Some("New words".into()),
                ..step(A, PlanAction::Reword)
            },
            step(B, PlanAction::Fixup),
        ];
        let (todo, messages) = build_todo(&commits, &plan, Path::new("/repo/.git")).unwrap();
        assert_eq!(
            todo,
            format!(
                "pick {C}\npick {A}\nexec git commit --amend --no-verify --cleanup=strip --file='/repo/.git/branchline-reword-1.txt'\nfixup {B}\n"
            )
        );
        assert_eq!(messages.len(), 1);
        assert_eq!(messages[0].1, "New words\n");
    }

    #[test]
    fn rejects_plans_that_do_not_match_or_cannot_work() {
        let commits = [commit(A), commit(B)];
        let dir = Path::new("/g");
        let err = |plan: &[PlanStep]| build_todo(&commits, plan, dir).unwrap_err().to_string();
        assert!(err(&[step(A, PlanAction::Pick)]).contains("does not match"));
        assert!(
            err(&[step(A, PlanAction::Pick), step(A, PlanAction::Pick)]).contains("does not match")
        );
        assert!(
            err(&[step(A, PlanAction::Drop), step(B, PlanAction::Drop)]).contains("at least one")
        );
        assert!(
            err(&[step(B, PlanAction::Squash), step(A, PlanAction::Pick)]).contains("first commit")
        );
        // A dropped first commit makes the next one the first to keep.
        assert!(
            err(&[step(A, PlanAction::Drop), step(B, PlanAction::Fixup)]).contains("first commit")
        );
        assert!(err(&[step(A, PlanAction::Reword), step(B, PlanAction::Pick)]).contains("message"));
    }
}
