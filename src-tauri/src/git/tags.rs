//! Tags: list, create (lightweight or annotated) and delete.
//!
//! Names are validated like branch names and always passed after `--`; targets
//! are commit ids validated as hexadecimal. Pushing and deleting tags on a
//! remote lives in `remote.rs`, next to the other network operations.

use std::path::Path;

use serde::Serialize;

use super::log::validate_oid;
use super::ops::write_lock;
use super::repository::resolve_root;
use super::runner::{run_git, run_git_with, RunOptions, DEFAULT_TIMEOUT};
use crate::error::GitError;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TagInfo {
    pub name: String,
    /// The commit (or other object) the tag points at, after peeling annotated tags.
    pub target: String,
    /// The target is a commit (tags can also point at trees or blobs).
    pub is_commit: bool,
    pub annotated: bool,
    /// Subject of the annotated tag's message, or of the target commit for lightweight tags.
    pub subject: String,
    /// Tagger for annotated tags; `None` for lightweight tags.
    pub tagger: Option<String>,
    /// Tag date for annotated tags, commit date for lightweight tags (seconds since the epoch).
    pub time: i64,
}

const FORMAT: &str = "--format=%(refname:strip=2)%00%(objecttype)%00%(objectname)%00%(*objecttype)%00%(*objectname)%00%(contents:subject)%00%(taggername)%00%(creatordate:unix)";

/// Parse `for-each-ref` output produced with [`FORMAT`].
pub fn parse_tags(output: &[u8]) -> Vec<TagInfo> {
    String::from_utf8_lossy(output)
        .lines()
        .filter_map(|line| {
            let f: Vec<&str> = line.splitn(8, '\0').collect();
            if f.len() != 8 || f[0].is_empty() {
                return None;
            }
            let annotated = f[1] == "tag";
            let (target, target_type) = if annotated {
                (f[4], f[3])
            } else {
                (f[2], f[1])
            };
            Some(TagInfo {
                name: f[0].to_string(),
                target: target.to_string(),
                is_commit: target_type == "commit",
                annotated,
                subject: f[5].to_string(),
                tagger: (annotated && !f[6].is_empty()).then(|| f[6].to_string()),
                time: f[7].trim().parse().unwrap_or(0),
            })
        })
        .collect()
}

/// All tags, newest first.
pub fn list_tags(repo: &str) -> Result<Vec<TagInfo>, GitError> {
    let root = resolve_root(repo)?;
    let out = run_git(
        &root,
        &["for-each-ref", "--sort=-creatordate", FORMAT, "refs/tags"],
        DEFAULT_TIMEOUT,
    )?;
    Ok(parse_tags(&out.stdout))
}

pub fn validate_tag_name(root: &Path, name: &str) -> Result<(), GitError> {
    let invalid = |why: &str| Err(GitError::InvalidTagName(why.to_string()));
    if name.trim().is_empty() {
        return invalid("Enter a tag name.");
    }
    if name != name.trim() || name.contains(char::is_whitespace) {
        return invalid("Tag names cannot contain spaces.");
    }
    if name.starts_with('-') {
        return invalid("Tag names cannot start with a dash.");
    }
    if name == "HEAD" || name == "@" {
        return invalid("This name is reserved by Git.");
    }
    let refname = format!("refs/tags/{name}");
    match run_git(root, &["check-ref-format", &refname], DEFAULT_TIMEOUT) {
        Ok(_) => Ok(()),
        Err(GitError::GitFailed { .. }) => invalid(
            "Not a valid tag name. Avoid `..`, `~`, `^`, `:`, `?`, `*`, `[`, `\\`, a trailing `.lock` and leading or trailing `/` or `.`.",
        ),
        Err(e) => Err(e),
    }
}

fn tag_exists(root: &Path, name: &str) -> Result<bool, GitError> {
    let out = run_git_with(
        root,
        &[
            "rev-parse",
            "--verify",
            "--quiet",
            &format!("refs/tags/{name}"),
        ],
        &RunOptions {
            ok_codes: &[0, 1],
            ..RunOptions::default()
        },
    )?;
    Ok(out.code == 0)
}

/// Why `name` cannot be used for a new tag, or `None` when it can.
pub fn check_tag_name(repo: &str, name: &str) -> Result<Option<String>, GitError> {
    let root = resolve_root(repo)?;
    match validate_tag_name(&root, name) {
        Err(GitError::InvalidTagName(why)) => return Ok(Some(why)),
        Err(e) => return Err(e),
        Ok(()) => {}
    }
    Ok(tag_exists(&root, name)?.then(|| format!("A tag named {name} already exists.")))
}

/// Create a tag at `target` (a commit id). A non-empty `message` makes it annotated.
pub fn create_tag(repo: &str, name: &str, target: &str, message: &str) -> Result<(), GitError> {
    let root = resolve_root(repo)?;
    validate_tag_name(&root, name)?;
    validate_oid(target)?;
    let _guard = write_lock();
    if tag_exists(&root, name)? {
        return Err(GitError::InvalidTagName(format!(
            "A tag named {name} already exists."
        )));
    }
    let message = message.trim();
    let message_arg = format!("--message={message}");
    let mut args = vec!["tag"];
    if !message.is_empty() {
        args.push("--annotate");
        args.push(&message_arg);
    }
    args.extend_from_slice(&["--", name, target]);
    let out = run_git_with(
        &root,
        &args,
        &RunOptions {
            ok_codes: &[0, 128],
            ..RunOptions::default()
        },
    )?;
    if out.code != 0 {
        let stderr = out.stderr;
        if stderr.contains("Please tell me who you are")
            || stderr.contains("unable to auto-detect email")
        {
            return Err(GitError::IdentityMissing { detail: stderr });
        }
        return Err(GitError::GitFailed { code: 128, stderr });
    }
    Ok(())
}

/// Delete a local tag. The commit it pointed at is not affected.
pub fn delete_tag(repo: &str, name: &str) -> Result<(), GitError> {
    let root = resolve_root(repo)?;
    validate_tag_name(&root, name)?;
    let _guard = write_lock();
    if !tag_exists(&root, name)? {
        return Err(GitError::Stale);
    }
    run_git(&root, &["tag", "--delete", "--", name], DEFAULT_TIMEOUT)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_lightweight_and_annotated_tags() {
        let out = b"v2\0tag\0t2\0commit\0c2\0Release 2\0Ann\x001700000000\n\
v1\0commit\0c1\0\0\0Fix login\0\x001600000000\n\
tree-tag\0tree\0t9\0\0\0\0\x000\n";
        let tags = parse_tags(out);
        assert_eq!(tags.len(), 3);
        assert_eq!(tags[0].name, "v2");
        assert!(tags[0].annotated);
        assert_eq!(tags[0].target, "c2");
        assert!(tags[0].is_commit);
        assert_eq!(tags[0].tagger.as_deref(), Some("Ann"));
        assert!(!tags[1].annotated);
        assert_eq!(tags[1].target, "c1");
        assert_eq!(tags[1].subject, "Fix login");
        assert_eq!(tags[1].tagger, None);
        assert!(!tags[2].is_commit);
    }
}
