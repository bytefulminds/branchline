//! Creating and amending commits.

use std::path::Path;
use std::time::Duration;

use serde::{Deserialize, Serialize};

use super::repository::resolve_paths;
use super::runner::{run_git, run_git_with, RunOptions, DEFAULT_TIMEOUT};
use crate::error::GitError;

/// Hooks (`pre-commit`, `commit-msg`) may run linters or tests.
pub const COMMIT_TIMEOUT: Duration = Duration::from_secs(600);

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Identity {
    pub name: String,
    pub email: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitDraft {
    /// Who the commit will be attributed to; `None` when Git has no identity configured.
    pub author: Option<Identity>,
    /// Message of HEAD, used to prefill an amend.
    pub head_message: Option<String>,
    /// Prepared message of an in-progress merge, cherry-pick or revert.
    pub prepared_message: Option<String>,
    pub can_amend: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitRequest {
    pub message: String,
    #[serde(default)]
    pub amend: bool,
}

/// Parse `git var GIT_AUTHOR_IDENT` output: `Name <email> 1700000000 +0100`.
pub fn parse_ident(s: &str) -> Option<Identity> {
    let (name, rest) = s.split_once(" <")?;
    let (email, _) = rest.split_once('>')?;
    Some(Identity {
        name: name.trim().to_string(),
        email: email.trim().to_string(),
    })
}

/// Drop Git's `#` comment lines from a prepared message file.
fn strip_comments(msg: &str) -> String {
    msg.lines()
        .filter(|l| !l.starts_with('#'))
        .collect::<Vec<_>>()
        .join("\n")
        .trim()
        .to_string()
}

fn head_message(root: &Path) -> Option<String> {
    run_git(
        root,
        &["log", "-1", "--format=%B", "HEAD", "--"],
        DEFAULT_TIMEOUT,
    )
    .ok()
    .map(|o| o.stdout_string().trim_end().to_string())
}

pub fn commit_draft(repo: &str) -> Result<CommitDraft, GitError> {
    let (root, git_dir) = resolve_paths(repo)?;
    let author = run_git(&root, &["var", "GIT_AUTHOR_IDENT"], DEFAULT_TIMEOUT)
        .ok()
        .and_then(|o| parse_ident(o.stdout_string().trim()));
    let head = head_message(&root);
    let prepared = ["MERGE_MSG", "SQUASH_MSG"]
        .iter()
        .filter(|f| {
            // MERGE_MSG only matters while an operation is in progress.
            git_dir.join("MERGE_HEAD").exists()
                || git_dir.join("CHERRY_PICK_HEAD").exists()
                || git_dir.join("REVERT_HEAD").exists()
                || **f == "SQUASH_MSG"
        })
        .find_map(|f| std::fs::read_to_string(git_dir.join(f)).ok())
        .map(|m| strip_comments(&m))
        .filter(|m| !m.is_empty());
    Ok(CommitDraft {
        author,
        can_amend: head.is_some(),
        head_message: head,
        prepared_message: prepared,
    })
}

/// Normalize a message from the UI: CRLF to LF, trailing whitespace trimmed.
pub fn normalize_message(msg: &str) -> String {
    msg.replace("\r\n", "\n")
        .replace('\r', "\n")
        .trim_end()
        .to_string()
}

fn has_staged_changes(root: &Path) -> Result<bool, GitError> {
    // `--cached --quiet` exits 1 when something is staged. Before the first
    // commit it compares against the empty tree.
    match run_git_with(
        root,
        &["diff", "--cached", "--quiet", "--no-ext-diff"],
        &RunOptions {
            ok_codes: &[0, 1],
            ..RunOptions::default()
        },
    ) {
        Ok(out) => Ok(out.code == 1),
        Err(e) => Err(e),
    }
}

fn has_unmerged(root: &Path) -> Result<bool, GitError> {
    Ok(!run_git(root, &["ls-files", "-u", "-z"], DEFAULT_TIMEOUT)?
        .stdout
        .is_empty())
}

/// Create a commit from the index (or amend HEAD). Returns the new commit id.
pub fn commit(repo: &str, req: &CommitRequest) -> Result<String, GitError> {
    let (root, git_dir) = resolve_paths(repo)?;
    let _guard = super::ops::write_lock();
    let message = normalize_message(&req.message);
    if message.trim().is_empty() {
        return Err(GitError::Unsupported("Enter a commit message.".into()));
    }
    if req.amend && head_message(&root).is_none() {
        return Err(GitError::Unsupported(
            "There is no commit to amend yet.".into(),
        ));
    }
    if has_unmerged(&root)? {
        return Err(GitError::Unsupported(
            "Resolve all conflicts and mark them as resolved before committing.".into(),
        ));
    }
    let merging = git_dir.join("MERGE_HEAD").exists();
    if !req.amend && !merging && !has_staged_changes(&root)? {
        return Err(GitError::Unsupported(
            "Nothing is staged. Stage the changes you want to commit first.".into(),
        ));
    }

    let mut args = vec!["commit", "--file=-", "--cleanup=whitespace"];
    if req.amend {
        args.push("--amend");
    }
    let input = format!("{message}\n");
    let result = run_git_with(
        &root,
        &args,
        &RunOptions {
            timeout: COMMIT_TIMEOUT,
            stdin: Some(input.as_bytes()),
            ..RunOptions::default()
        },
    );
    match result {
        Ok(_) => {}
        Err(GitError::GitFailed { stderr, .. })
            if stderr.contains("Please tell me who you are")
                || stderr.contains("unable to auto-detect email address")
                || stderr.contains("empty ident name")
                || stderr.contains("no email was given")
                || stderr.contains("no name was given") =>
        {
            return Err(GitError::IdentityMissing { detail: stderr })
        }
        Err(GitError::GitFailed { stderr, code }) => {
            // Hook failures and signing problems are reported with Git's own output.
            return Err(GitError::CommitFailed {
                detail: if stderr.is_empty() {
                    format!("git commit exited with status {code}")
                } else {
                    stderr
                },
            });
        }
        Err(e) => return Err(e),
    }
    let head = run_git(&root, &["rev-parse", "HEAD"], DEFAULT_TIMEOUT)?;
    Ok(head.stdout_string().trim().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_identity() {
        assert_eq!(
            parse_ident("Mark Dang <mark@example.com> 1700000000 +0200"),
            Some(Identity {
                name: "Mark Dang".into(),
                email: "mark@example.com".into()
            })
        );
        assert_eq!(parse_ident("nonsense"), None);
    }

    #[test]
    fn normalizes_messages() {
        assert_eq!(
            normalize_message("Title\r\n\r\nBody  \r\n\n"),
            "Title\n\nBody"
        );
        assert_eq!(
            strip_comments("Merge x\n\n# Conflicts:\n#\ta.txt\n"),
            "Merge x"
        );
    }
}
