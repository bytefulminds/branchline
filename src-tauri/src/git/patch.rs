//! Build patches for partial (hunk and line) staging, unstaging and discarding.
//!
//! Forward patches are applied as-is (stage: index -> index + selection).
//! Reverse patches are applied with `git apply -R` (unstage, discard).
//!
//! For an unselected change line the rules are:
//!
//! | mode    | unselected `-`     | unselected `+`     |
//! |---------|--------------------|--------------------|
//! | forward | becomes context    | dropped            |
//! | reverse | dropped            | becomes context    |
//!
//! so the patch's "old" side (forward) or "new" side (reverse) always matches
//! the target file exactly.

use serde::Deserialize;

use super::diff::{LineKind, ParsedFile};
use crate::error::GitError;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Direction {
    Forward,
    Reverse,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HunkSelection {
    pub hunk: usize,
    /// Indices into the hunk's lines; `None` selects every change line.
    pub lines: Option<Vec<usize>>,
}

fn rewrite_side(line: &[u8], from: &str, to: &str) -> Vec<u8> {
    // `+++ b/path` -> `--- a/path`, preserving C-quoting (`"b/..."`).
    let rest = &line[4..];
    let (quote, body) = match rest.first() {
        Some(b'"') => (true, &rest[1..]),
        _ => (false, rest),
    };
    let body = body.strip_prefix(from.as_bytes()).unwrap_or(body);
    let mut out = Vec::new();
    out.extend_from_slice(if to == "a/" { b"--- " } else { b"+++ " });
    if quote {
        out.push(b'"');
    }
    out.extend_from_slice(to.as_bytes());
    out.extend_from_slice(body);
    out
}

/// Make a creation/deletion header describe a modification, used when only
/// part of a new or deleted file is selected.
fn modification_header(header: &[Vec<u8>]) -> Vec<Vec<u8>> {
    let plus = header.iter().find(|l| l.starts_with(b"+++ ")).cloned();
    let minus = header.iter().find(|l| l.starts_with(b"--- ")).cloned();
    let mut out = Vec::new();
    for l in header {
        if l.starts_with(b"new file mode")
            || l.starts_with(b"deleted file mode")
            || l.starts_with(b"index ")
        {
            continue;
        }
        if l.as_slice() == b"--- /dev/null" {
            if let Some(p) = &plus {
                out.push(rewrite_side(p, "b/", "a/"));
                continue;
            }
        }
        if l.as_slice() == b"+++ /dev/null" {
            if let Some(m) = &minus {
                out.push(rewrite_side(m, "a/", "b/"));
                continue;
            }
        }
        out.push(l.clone());
    }
    out
}

/// Build the patch text for `selections` of `file`.
pub fn build_patch(
    file: &ParsedFile,
    selections: &[HunkSelection],
    direction: Direction,
) -> Result<Vec<u8>, GitError> {
    if file.is_binary {
        return Err(GitError::Unsupported(
            "Binary files can only be staged as a whole.".into(),
        ));
    }
    if selections.is_empty() {
        return Err(GitError::Unsupported("Nothing is selected.".into()));
    }

    let mut sorted: Vec<&HunkSelection> = selections.iter().collect();
    sorted.sort_by_key(|s| s.hunk);
    sorted.dedup_by_key(|s| s.hunk);

    let total_changes: usize = file
        .hunks
        .iter()
        .map(|h| {
            h.lines
                .iter()
                .filter(|l| l.kind != LineKind::Context)
                .count()
        })
        .sum();

    let mut body: Vec<u8> = Vec::new();
    let mut selected_changes = 0usize;
    // Running (new - old) difference of the hunks emitted so far.
    let mut delta: i64 = 0;

    for sel in sorted {
        let hunk = file.hunks.get(sel.hunk).ok_or_else(|| {
            GitError::Unsupported(format!("Hunk {} does not exist.", sel.hunk + 1))
        })?;
        let chosen: Option<std::collections::HashSet<usize>> =
            sel.lines.as_ref().map(|v| v.iter().copied().collect());
        if let Some(c) = &chosen {
            if let Some(bad) = c.iter().find(|i| **i >= hunk.lines.len()) {
                return Err(GitError::Unsupported(format!(
                    "Line {bad} is outside the hunk."
                )));
            }
        }
        let is_selected = |i: usize| chosen.as_ref().map_or(true, |c| c.contains(&i));

        let mut out_lines: Vec<(u8, &[u8], bool)> = Vec::new();
        let mut hunk_changes = 0usize;
        for (i, line) in hunk.lines.iter().enumerate() {
            let selected = is_selected(i);
            let prefix = match (line.kind, selected, direction) {
                (LineKind::Context, _, _) => Some(b' '),
                (LineKind::Add, true, _) => Some(b'+'),
                (LineKind::Delete, true, _) => Some(b'-'),
                (LineKind::Delete, false, Direction::Forward) => Some(b' '),
                (LineKind::Add, false, Direction::Forward) => None,
                (LineKind::Delete, false, Direction::Reverse) => None,
                (LineKind::Add, false, Direction::Reverse) => Some(b' '),
            };
            if line.kind != LineKind::Context && selected {
                hunk_changes += 1;
            }
            if let Some(p) = prefix {
                out_lines.push((p, &line.raw, line.no_newline));
            }
        }
        if hunk_changes == 0 {
            continue;
        }
        selected_changes += hunk_changes;

        let old_count = out_lines.iter().filter(|(p, ..)| *p != b'+').count() as i64;
        let new_count = out_lines.iter().filter(|(p, ..)| *p != b'-').count() as i64;
        let (old_start, new_start) = match direction {
            // The old side is the target: keep its position.
            Direction::Forward => {
                let old_start = if hunk.old_lines == 0 && old_count > 0 {
                    1
                } else {
                    i64::from(hunk.old_start)
                };
                let new_start = if new_count == 0 {
                    (old_start + delta - 1).max(0)
                } else {
                    (old_start + delta).max(1)
                };
                (old_start, new_start)
            }
            // The new side is the target: keep its position.
            Direction::Reverse => {
                let new_start = if hunk.new_lines == 0 && new_count > 0 {
                    1
                } else {
                    i64::from(hunk.new_start)
                };
                let old_start = if old_count == 0 {
                    (new_start - delta - 1).max(0)
                } else {
                    (new_start - delta).max(1)
                };
                (old_start, new_start)
            }
        };
        delta += new_count - old_count;

        body.extend_from_slice(
            format!("@@ -{old_start},{old_count} +{new_start},{new_count} @@\n").as_bytes(),
        );
        let last = out_lines.len().saturating_sub(1);
        for (idx, (prefix, raw, no_newline)) in out_lines.iter().enumerate() {
            body.push(*prefix);
            body.extend_from_slice(raw);
            body.push(b'\n');
            // A missing final newline is only meaningful on a hunk's last line
            // of that side; keep the marker where Git put it.
            if *no_newline && (idx == last || *prefix != b' ') {
                body.extend_from_slice(b"\\ No newline at end of file\n");
            }
        }
    }

    if selected_changes == 0 {
        return Err(GitError::Unsupported(
            "The selection contains no added or removed lines.".into(),
        ));
    }

    let header = if selected_changes == total_changes {
        file.header.clone()
    } else {
        modification_header(&file.header)
    };
    let mut patch = Vec::new();
    for l in &header {
        patch.extend_from_slice(l);
        patch.push(b'\n');
    }
    patch.extend_from_slice(&body);
    Ok(patch)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::diff::parse_unified;

    fn parsed(s: &str) -> ParsedFile {
        parse_unified(s.as_bytes()).unwrap().remove(0)
    }

    const MIXED: &str = "diff --git a/f b/f
index 1..2 100644
--- a/f
+++ b/f
@@ -1,3 +1,3 @@
 a
-b
+B
 c
";

    #[test]
    fn whole_hunk_keeps_original_shape() {
        let f = parsed(MIXED);
        let p = build_patch(
            &f,
            &[HunkSelection {
                hunk: 0,
                lines: None,
            }],
            Direction::Forward,
        )
        .unwrap();
        assert_eq!(String::from_utf8(p).unwrap(), MIXED);
    }

    #[test]
    fn forward_partial_turns_unselected_delete_into_context() {
        let f = parsed(MIXED);
        // Select only the added line (index 2).
        let p = build_patch(
            &f,
            &[HunkSelection {
                hunk: 0,
                lines: Some(vec![2]),
            }],
            Direction::Forward,
        )
        .unwrap();
        let s = String::from_utf8(p).unwrap();
        assert!(s.ends_with("@@ -1,3 +1,4 @@\n a\n b\n+B\n c\n"), "{s}");
        assert!(
            s.starts_with("diff --git a/f b/f\n--- a/f\n+++ b/f\n"),
            "{s}"
        );
    }

    #[test]
    fn reverse_partial_turns_unselected_add_into_context() {
        let f = parsed(MIXED);
        // Select only the deleted line (index 1).
        let p = build_patch(
            &f,
            &[HunkSelection {
                hunk: 0,
                lines: Some(vec![1]),
            }],
            Direction::Reverse,
        )
        .unwrap();
        let s = String::from_utf8(p).unwrap();
        // Old side a,b,B,c (4 lines); new side a,B,c (3 lines) matches the index.
        assert!(s.ends_with("@@ -1,4 +1,3 @@\n a\n-b\n B\n c\n"), "{s}");
    }

    #[test]
    fn partial_new_file_becomes_a_modification() {
        let f = parsed(
            "diff --git a/n b/n\nnew file mode 100644\nindex 0000000..1234567\n--- /dev/null\n+++ b/n\n@@ -0,0 +1,3 @@\n+x\n+y\n+z\n",
        );
        let p = build_patch(
            &f,
            &[HunkSelection {
                hunk: 0,
                lines: Some(vec![1]),
            }],
            Direction::Reverse,
        )
        .unwrap();
        let s = String::from_utf8(p).unwrap();
        assert_eq!(
            s,
            "diff --git a/n b/n\n--- a/n\n+++ b/n\n@@ -1,2 +1,3 @@\n x\n+y\n z\n"
        );
    }

    #[test]
    fn rejects_empty_and_context_only_selections() {
        let f = parsed(MIXED);
        assert!(build_patch(&f, &[], Direction::Forward).is_err());
        assert!(build_patch(
            &f,
            &[HunkSelection {
                hunk: 0,
                lines: Some(vec![0, 3])
            }],
            Direction::Forward
        )
        .is_err());
        assert!(build_patch(
            &f,
            &[HunkSelection {
                hunk: 5,
                lines: None
            }],
            Direction::Forward
        )
        .is_err());
        assert!(build_patch(
            &f,
            &[HunkSelection {
                hunk: 0,
                lines: Some(vec![99])
            }],
            Direction::Forward
        )
        .is_err());
    }
}
