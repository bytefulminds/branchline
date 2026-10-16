//! Stashes: save, list, apply, pop and drop.
//!
//! Entries are addressed by index *and* commit id. Indexes shift whenever a
//! stash is added or removed (also from a terminal), so every operation first
//! checks that `stash@{index}` still is the commit the user looked at, and
//! fails with [`GitError::Stale`] otherwise. It never applies or drops a
//! different stash than the one shown.

use std::path::Path;

use serde::Serialize;

use super::diff::fingerprint;
use super::log::validate_oid;
use super::ops::write_lock;
use super::repository::resolve_root;
use super::runner::{run_git, run_git_with, RunOptions, DEFAULT_TIMEOUT};

/// Options for stash commands that change files. They take no paths from the UI,
/// and `--include-untracked` needs Git's internal pathspec magic to clean up.
fn stash_options(ok_codes: &'static [i32]) -> RunOptions<'static> {
    RunOptions {
        ok_codes,
        pathspec_magic: true,
        ..RunOptions::default()
    }
}
use crate::error::GitError;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StashInfo {
    /// Position in the stash list (`stash@{index}`); 0 is the newest.
    pub index: u32,
    pub oid: String,
    /// The user's message, or the commit summary Git recorded for an unnamed stash.
    pub message: String,
    /// Branch the stash was made on; `None` for a detached HEAD.
    pub branch: Option<String>,
    /// Git generated the message (`WIP on main: ...`); the user gave none.
    pub auto_message: bool,
    /// Seconds since the Unix epoch.
    pub time: i64,
    /// Commit holding untracked files, when the stash includes them.
    pub untracked_oid: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StashOutcome {
    /// Applying produced conflicts; they are in the working tree now.
    pub conflicts: bool,
    /// A pop with conflicts keeps the stash, so nothing is lost.
    pub kept: bool,
}

/// Split a stash reflog subject into (branch, message, auto).
///
/// * `On main: fix login` - saved with a message
/// * `WIP on main: 1a2b3c4 Last commit` - saved without one
/// * `On (no branch): ...` - detached HEAD
pub fn parse_subject(subject: &str) -> (Option<String>, String, bool) {
    let (rest, auto) = match subject.strip_prefix("WIP on ") {
        Some(r) => (r, true),
        None => (subject.strip_prefix("On ").unwrap_or(subject), false),
    };
    match rest.split_once(": ") {
        Some((branch, message)) => {
            let branch = (branch != "(no branch)").then(|| branch.to_string());
            (branch, message.to_string(), auto)
        }
        None => (None, subject.to_string(), auto),
    }
}

/// Parse `git stash list --format=%H%x1f%ct%x1f%P%x1f%gs`.
pub fn parse_stashes(output: &str) -> Vec<StashInfo> {
    output
        .lines()
        .filter(|l| !l.is_empty())
        .enumerate()
        .filter_map(|(i, line)| {
            let f: Vec<&str> = line.splitn(4, '\u{1f}').collect();
            if f.len() != 4 {
                return None;
            }
            let parents: Vec<&str> = f[2].split_whitespace().collect();
            let (branch, message, auto_message) = parse_subject(f[3]);
            Some(StashInfo {
                index: i as u32,
                oid: f[0].to_string(),
                message,
                branch,
                auto_message,
                time: f[1].trim().parse().unwrap_or(0),
                untracked_oid: parents.get(2).map(|s| s.to_string()),
            })
        })
        .collect()
}

fn stash_list_output(root: &Path) -> Result<String, GitError> {
    Ok(run_git(
        root,
        &["stash", "list", "--format=%H%x1f%ct%x1f%P%x1f%gs"],
        DEFAULT_TIMEOUT,
    )?
    .stdout_string())
}

pub fn list_stashes(repo: &str) -> Result<Vec<StashInfo>, GitError> {
    let root = resolve_root(repo)?;
    Ok(parse_stashes(&stash_list_output(&root)?))
}

/// Number of stashes and a fingerprint of the list, for cheap change detection.
pub fn stash_summary(root: &Path) -> Result<(u32, String), GitError> {
    let out = run_git(root, &["stash", "list", "--format=%H"], DEFAULT_TIMEOUT)?;
    let count = out.stdout.iter().filter(|b| **b == b'\n').count() as u32;
    Ok((count, fingerprint(&out.stdout)))
}

/// Resolve `stash@{index}` and require it to be `oid`.
fn checked_ref(root: &Path, index: u32, oid: &str) -> Result<String, GitError> {
    validate_oid(oid)?;
    let name = format!("stash@{{{index}}}");
    let out = run_git_with(
        root,
        &[
            "rev-parse",
            "--verify",
            "--quiet",
            &format!("{name}^{{commit}}"),
        ],
        &RunOptions {
            // 128: the index is past the end of the list.
            ok_codes: &[0, 1, 128],
            ..RunOptions::default()
        },
    )?;
    let actual = out.stdout_string();
    let actual = actual.trim();
    if out.code != 0 || actual != oid {
        return Err(GitError::Stale);
    }
    Ok(name)
}

/// Stash uncommitted changes. Untracked files are included unless `include_untracked` is false.
pub fn save(repo: &str, message: &str, include_untracked: bool) -> Result<(), GitError> {
    let root = resolve_root(repo)?;
    let _guard = write_lock();
    let message = message.trim();
    let message_arg = format!("--message={message}");
    let mut args = vec!["stash", "push"];
    if include_untracked {
        args.push("--include-untracked");
    }
    if !message.is_empty() {
        args.push(&message_arg);
    }
    let out = run_git_with(&root, &args, &stash_options(&[0, 1]))?;
    let text = format!("{}\n{}", out.stdout_string(), out.stderr);
    if text.contains("No local changes to save") {
        return Err(GitError::Unsupported(if include_untracked {
            "There are no changes to stash.".into()
        } else {
            "There are no changes to stash. Include untracked files to stash new files.".into()
        }));
    }
    if out.code != 0 {
        if text.contains("needs merge") || text.contains("could not write index") {
            return Err(GitError::Unsupported(
                "Resolve the conflicts first; files with conflicts cannot be stashed.".into(),
            ));
        }
        return Err(GitError::GitFailed {
            code: out.code,
            stderr: out.stderr,
        });
    }
    Ok(())
}

/// Files listed by Git after "would be overwritten" or "already exists" messages.
fn blocking_files(text: &str) -> Vec<String> {
    let mut files: Vec<String> = text
        .lines()
        .filter(|l| l.starts_with('\t'))
        .map(|l| l.trim().to_string())
        .collect();
    for line in text.lines() {
        if let Some(path) = line.strip_suffix(" already exists, no checkout") {
            files.push(path.trim().to_string());
        }
    }
    files
}

/// Apply a stash; with `pop`, remove it afterwards unless applying produced conflicts.
///
/// Staged and unstaged changes are restored separately (`--index`) when possible.
pub fn apply(repo: &str, index: u32, oid: &str, pop: bool) -> Result<StashOutcome, GitError> {
    let root = resolve_root(repo)?;
    let _guard = write_lock();
    let name = checked_ref(&root, index, oid)?;
    let verb = if pop { "pop" } else { "apply" };
    let run = |with_index: bool| {
        let mut args = vec!["stash", verb];
        if with_index {
            args.push("--index");
        }
        args.push(&name);
        run_git_with(&root, &args, &stash_options(&[0, 1, 128]))
    };
    let mut out = run(true)?;
    let mut text = format!("{}\n{}", out.stdout_string(), out.stderr);
    if out.code != 0 && text.contains("Conflicts in index") {
        // The staged part cannot be restored separately; apply everything as unstaged.
        out = run(false)?;
        text = format!("{}\n{}", out.stdout_string(), out.stderr);
    }
    if out.code == 0 {
        return Ok(StashOutcome::default());
    }
    if text.contains("CONFLICT") {
        return Ok(StashOutcome {
            conflicts: true,
            kept: pop,
        });
    }
    if text.contains("would be overwritten")
        || text.contains("already exists, no checkout")
        || text.contains("could not restore untracked files")
    {
        return Err(GitError::CheckoutConflict {
            files: blocking_files(&text),
            detail: text.trim().to_string(),
        });
    }
    Err(GitError::GitFailed {
        code: out.code,
        stderr: text.trim().to_string(),
    })
}

/// Delete a stash. Its changes are gone afterwards (Git keeps the commit until garbage collection).
pub fn drop(repo: &str, index: u32, oid: &str) -> Result<(), GitError> {
    let root = resolve_root(repo)?;
    let _guard = write_lock();
    let name = checked_ref(&root, index, oid)?;
    run_git_with(
        &root,
        &["stash", "drop", "--quiet", &name],
        &stash_options(&[0]),
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_stash_subjects() {
        assert_eq!(
            parse_subject("On develop: WIP: longer README"),
            (Some("develop".into()), "WIP: longer README".into(), false)
        );
        assert_eq!(
            parse_subject("WIP on main: 1a2b3c4 Add login"),
            (Some("main".into()), "1a2b3c4 Add login".into(), true)
        );
        assert_eq!(
            parse_subject("On (no branch): try"),
            (None, "try".into(), false)
        );
        assert_eq!(
            parse_subject("feature/x: with: colons"),
            (Some("feature/x".into()), "with: colons".into(), false)
        );
    }

    #[test]
    fn parses_stash_list() {
        let out = "aaa\u{1f}1700000000\u{1f}p1 p2 p3\u{1f}On main: one\nbbb\u{1f}1600000000\u{1f}p1 p2\u{1f}WIP on dev: abc two\n";
        let list = parse_stashes(out);
        assert_eq!(list.len(), 2);
        assert_eq!(list[0].index, 0);
        assert_eq!(list[0].untracked_oid.as_deref(), Some("p3"));
        assert_eq!(list[1].index, 1);
        assert_eq!(list[1].branch.as_deref(), Some("dev"));
        assert!(list[1].auto_message);
        assert_eq!(list[1].untracked_oid, None);
    }
}
