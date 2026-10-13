//! Parser for `git status --porcelain=v2 --branch -z`.
//!
//! Format reference: <https://git-scm.com/docs/git-status#_porcelain_format_version_2>.
//! With `-z`, records are NUL-terminated and paths are emitted verbatim
//! (no quoting), so filenames with spaces, quotes or non-ASCII characters
//! are preserved. A rename/copy record (`2`) is followed by a second NUL
//! terminated record containing the original path.

use serde::Serialize;

use crate::error::GitError;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ChangeKind {
    Added,
    Modified,
    Deleted,
    Renamed,
    Copied,
    TypeChanged,
    Untracked,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ConflictKind {
    BothDeleted,
    AddedByUs,
    DeletedByThem,
    AddedByThem,
    DeletedByUs,
    BothAdded,
    BothModified,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileChange {
    /// Path relative to the repository root, using `/` separators.
    pub path: String,
    /// Source path for renames and copies.
    pub original_path: Option<String>,
    /// Change recorded in the index (staged).
    pub index_status: Option<ChangeKind>,
    /// Change in the working tree that is not staged.
    pub worktree_status: Option<ChangeKind>,
    /// Set for unmerged (conflicted) paths.
    pub conflict: Option<ConflictKind>,
    pub is_submodule: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct BranchHeader {
    /// `None` when the branch has no commits yet (`(initial)`).
    pub oid: Option<String>,
    /// `None` when HEAD is detached.
    pub head: Option<String>,
    pub upstream: Option<String>,
    /// `Some((ahead, behind))` when the upstream exists.
    pub ahead_behind: Option<(u32, u32)>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct StatusSummary {
    pub branch: BranchHeader,
    pub changes: Vec<FileChange>,
}

fn change_kind(c: u8) -> Result<Option<ChangeKind>, GitError> {
    Ok(match c {
        b'.' => None,
        b'M' => Some(ChangeKind::Modified),
        b'A' => Some(ChangeKind::Added),
        b'D' => Some(ChangeKind::Deleted),
        b'R' => Some(ChangeKind::Renamed),
        b'C' => Some(ChangeKind::Copied),
        b'T' => Some(ChangeKind::TypeChanged),
        // `U` only appears in unmerged records, handled separately.
        other => {
            return Err(GitError::Parse(format!(
                "unknown status code '{}'",
                other as char
            )))
        }
    })
}

fn conflict_kind(xy: &[u8]) -> Result<ConflictKind, GitError> {
    Ok(match xy {
        b"DD" => ConflictKind::BothDeleted,
        b"AU" => ConflictKind::AddedByUs,
        b"UD" => ConflictKind::DeletedByThem,
        b"UA" => ConflictKind::AddedByThem,
        b"DU" => ConflictKind::DeletedByUs,
        b"AA" => ConflictKind::BothAdded,
        b"UU" => ConflictKind::BothModified,
        other => {
            return Err(GitError::Parse(format!(
                "unknown conflict code '{}'",
                String::from_utf8_lossy(other)
            )))
        }
    })
}

/// Split a record into at most `n` space-separated fields; the last field
/// keeps any embedded spaces (it is the path).
fn fields(record: &str, n: usize) -> Result<Vec<&str>, GitError> {
    let parts: Vec<&str> = record.splitn(n, ' ').collect();
    if parts.len() != n {
        return Err(GitError::Parse(format!(
            "malformed status record: {record:?}"
        )));
    }
    Ok(parts)
}

fn xy_of(field: &str) -> Result<[u8; 2], GitError> {
    let b = field.as_bytes();
    if b.len() != 2 {
        return Err(GitError::Parse(format!("malformed XY field: {field:?}")));
    }
    Ok([b[0], b[1]])
}

pub fn parse_status(output: &[u8]) -> Result<StatusSummary, GitError> {
    let mut summary = StatusSummary::default();
    let mut records = output
        .split(|b| *b == 0)
        .filter(|r| !r.is_empty())
        .map(|r| String::from_utf8_lossy(r).into_owned());

    while let Some(record) = records.next() {
        let tag = record.as_bytes()[0];
        match tag {
            b'#' => parse_header(&record, &mut summary.branch)?,
            b'1' => {
                let f = fields(&record, 9)?;
                let xy = xy_of(f[1])?;
                summary.changes.push(FileChange {
                    path: f[8].to_string(),
                    original_path: None,
                    index_status: change_kind(xy[0])?,
                    worktree_status: change_kind(xy[1])?,
                    conflict: None,
                    is_submodule: f[2].starts_with('S'),
                });
            }
            b'2' => {
                let f = fields(&record, 10)?;
                let xy = xy_of(f[1])?;
                let original = records
                    .next()
                    .ok_or_else(|| GitError::Parse("rename record without original path".into()))?;
                summary.changes.push(FileChange {
                    path: f[9].to_string(),
                    original_path: Some(original),
                    index_status: change_kind(xy[0])?,
                    worktree_status: change_kind(xy[1])?,
                    conflict: None,
                    is_submodule: f[2].starts_with('S'),
                });
            }
            b'u' => {
                let f = fields(&record, 11)?;
                let xy = xy_of(f[1])?;
                summary.changes.push(FileChange {
                    path: f[10].to_string(),
                    original_path: None,
                    index_status: None,
                    worktree_status: None,
                    conflict: Some(conflict_kind(&xy)?),
                    is_submodule: f[2].starts_with('S'),
                });
            }
            b'?' => {
                let path = record.strip_prefix("? ").ok_or_else(|| {
                    GitError::Parse(format!("malformed untracked record: {record:?}"))
                })?;
                summary.changes.push(FileChange {
                    path: path.to_string(),
                    original_path: None,
                    index_status: None,
                    worktree_status: Some(ChangeKind::Untracked),
                    conflict: None,
                    is_submodule: false,
                });
            }
            // Ignored files are only listed with --ignored, which we do not request.
            b'!' => {}
            _ => {
                return Err(GitError::Parse(format!(
                    "unknown status record: {record:?}"
                )))
            }
        }
    }
    Ok(summary)
}

fn parse_header(record: &str, branch: &mut BranchHeader) -> Result<(), GitError> {
    let Some(rest) = record.strip_prefix("# ") else {
        return Ok(());
    };
    let (key, value) = rest.split_once(' ').unwrap_or((rest, ""));
    match key {
        "branch.oid" => {
            branch.oid = (value != "(initial)").then(|| value.to_string());
        }
        "branch.head" => {
            branch.head = (value != "(detached)").then(|| value.to_string());
        }
        "branch.upstream" => branch.upstream = Some(value.to_string()),
        "branch.ab" => {
            let mut it = value.split(' ');
            let ahead = it.next().and_then(|v| v.strip_prefix('+'));
            let behind = it.next().and_then(|v| v.strip_prefix('-'));
            match (ahead.map(str::parse), behind.map(str::parse)) {
                (Some(Ok(a)), Some(Ok(b))) => branch.ahead_behind = Some((a, b)),
                _ => return Err(GitError::Parse(format!("malformed branch.ab: {value:?}"))),
            }
        }
        // Unknown headers (e.g. `# stash N` on newer Git) are ignored for forward compatibility.
        _ => {}
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn z(records: &[&str]) -> Vec<u8> {
        let mut out = Vec::new();
        for r in records {
            out.extend_from_slice(r.as_bytes());
            out.push(0);
        }
        out
    }

    #[test]
    fn parses_branch_headers() {
        let s = parse_status(&z(&[
            "# branch.oid 1234567890abcdef1234567890abcdef12345678",
            "# branch.head main",
            "# branch.upstream origin/main",
            "# branch.ab +2 -3",
        ]))
        .unwrap();
        assert_eq!(
            s.branch.oid.as_deref(),
            Some("1234567890abcdef1234567890abcdef12345678")
        );
        assert_eq!(s.branch.head.as_deref(), Some("main"));
        assert_eq!(s.branch.upstream.as_deref(), Some("origin/main"));
        assert_eq!(s.branch.ahead_behind, Some((2, 3)));
        assert!(s.changes.is_empty());
    }

    #[test]
    fn parses_initial_and_detached() {
        let s = parse_status(&z(&["# branch.oid (initial)", "# branch.head main"])).unwrap();
        assert_eq!(s.branch.oid, None);
        assert_eq!(s.branch.head.as_deref(), Some("main"));

        let s = parse_status(&z(&["# branch.oid abc", "# branch.head (detached)"])).unwrap();
        assert_eq!(s.branch.head, None);
    }

    #[test]
    fn parses_ordinary_changes_with_spaces_in_path() {
        let s = parse_status(&z(&[
            "1 M. N... 100644 100644 100644 aaa bbb src/with space.txt",
            "1 .D N... 100644 100644 000000 aaa aaa gone.rs",
            "1 AM N... 000000 100644 100644 000 bbb new file.md",
        ]))
        .unwrap();
        assert_eq!(s.changes.len(), 3);
        assert_eq!(s.changes[0].path, "src/with space.txt");
        assert_eq!(s.changes[0].index_status, Some(ChangeKind::Modified));
        assert_eq!(s.changes[0].worktree_status, None);
        assert_eq!(s.changes[1].worktree_status, Some(ChangeKind::Deleted));
        assert_eq!(s.changes[2].path, "new file.md");
        assert_eq!(s.changes[2].index_status, Some(ChangeKind::Added));
        assert_eq!(s.changes[2].worktree_status, Some(ChangeKind::Modified));
    }

    #[test]
    fn parses_rename_with_original_path_record() {
        let s = parse_status(&z(&[
            "2 R. N... 100644 100644 100644 aaa aaa R100 new name.txt",
            "old name.txt",
            "? after.txt",
        ]))
        .unwrap();
        assert_eq!(s.changes.len(), 2);
        assert_eq!(s.changes[0].path, "new name.txt");
        assert_eq!(s.changes[0].original_path.as_deref(), Some("old name.txt"));
        assert_eq!(s.changes[0].index_status, Some(ChangeKind::Renamed));
        assert_eq!(s.changes[1].path, "after.txt");
    }

    #[test]
    fn parses_unmerged_and_untracked() {
        let s = parse_status(&z(&[
            "u UU N... 100644 100644 100644 100644 a b c conflict.txt",
            "u AA N... 000000 100644 100644 100644 a b c both added.txt",
            "? untracked dir/file \u{e9}.txt",
            "! ignored.log",
        ]))
        .unwrap();
        assert_eq!(s.changes.len(), 3);
        assert_eq!(s.changes[0].conflict, Some(ConflictKind::BothModified));
        assert_eq!(s.changes[1].conflict, Some(ConflictKind::BothAdded));
        assert_eq!(s.changes[1].path, "both added.txt");
        assert_eq!(s.changes[2].path, "untracked dir/file \u{e9}.txt");
        assert_eq!(s.changes[2].worktree_status, Some(ChangeKind::Untracked));
    }

    #[test]
    fn detects_submodules() {
        let s = parse_status(&z(&["1 .M SC.. 160000 160000 160000 aaa aaa vendor/lib"])).unwrap();
        assert!(s.changes[0].is_submodule);
    }

    #[test]
    fn rejects_malformed_records() {
        assert!(parse_status(&z(&["1 M. N..."])).is_err());
        assert!(parse_status(&z(&["2 R. N... 1 1 1 a a R100 new"])).is_err());
        assert!(parse_status(&z(&["# branch.ab nope"])).is_err());
        assert!(parse_status(&z(&["X what"])).is_err());
    }

    #[test]
    fn ignores_unknown_headers_and_empty_output() {
        assert_eq!(parse_status(b"").unwrap(), StatusSummary::default());
        let s = parse_status(&z(&["# stash 3"])).unwrap();
        assert_eq!(s, StatusSummary::default());
    }
}
