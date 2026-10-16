//! Unified diff retrieval and parsing for a single file.
//!
//! Diffs are requested with flags that neutralize user configuration which
//! would change the output format (`diff.noprefix`, `diff.relative`, external
//! diff drivers, textconv). Raw line bytes are kept alongside the display text
//! so partial-staging patches are rebuilt byte-for-byte.

use std::path::Path;

use serde::{Deserialize, Serialize};

use super::paths::validate_relative;
use super::runner::{run_git_with, RunOptions, DEFAULT_TIMEOUT};
use crate::error::GitError;

/// Diffs larger than this are not parsed unless the user asks for them.
pub const SOFT_LIMIT_BYTES: usize = 2 * 1024 * 1024;
pub const SOFT_LIMIT_LINES: usize = 20_000;
/// Hard cap even when the user asks to see a large diff.
pub const HARD_LIMIT_BYTES: usize = 32 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DiffArea {
    /// Index to working tree.
    Unstaged,
    /// HEAD (or empty tree) to index.
    Staged,
    /// A file Git does not track yet.
    Untracked,
    /// An unmerged path; shown as the working-tree content with conflict markers.
    Conflicted,
    /// A file changed by a commit, relative to the commit's first parent.
    Commit,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum LineKind {
    Context,
    Add,
    Delete,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffLine {
    pub kind: LineKind,
    /// Display text (lossy UTF-8, trailing CR removed).
    pub content: String,
    pub old_line: Option<u32>,
    pub new_line: Option<u32>,
    /// Followed by `\ No newline at end of file`.
    pub no_newline: bool,
    /// The line ends with CRLF.
    pub crlf: bool,
    /// Exact line bytes after the +/-/space prefix, without the trailing LF.
    #[serde(skip)]
    pub raw: Vec<u8>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffHunk {
    pub header: String,
    pub old_start: u32,
    pub old_lines: u32,
    pub new_start: u32,
    pub new_lines: u32,
    /// Function or section context Git prints after the range.
    pub section: String,
    pub lines: Vec<DiffLine>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ParsedFile {
    /// Header lines before the first hunk (`diff --git`, `index`, `---`, `+++`, modes, renames).
    pub header: Vec<Vec<u8>>,
    pub hunks: Vec<DiffHunk>,
    pub is_binary: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileDiff {
    pub path: String,
    pub original_path: Option<String>,
    pub area: DiffArea,
    pub hunks: Vec<DiffHunk>,
    pub is_binary: bool,
    /// The diff exceeded the soft limit and was not parsed (`force` loads it).
    pub too_large: bool,
    pub size_bytes: u64,
    pub additions: u32,
    pub deletions: u32,
    pub old_mode: Option<String>,
    pub new_mode: Option<String>,
    /// `new`, `deleted`, `renamed`, `copied` or null.
    pub change: Option<String>,
    /// Hunk and line staging is possible for this diff.
    pub supports_partial: bool,
    /// Conflicted file still contains conflict markers.
    pub has_conflict_markers: bool,
    /// Identifies this exact diff; partial operations are rejected when it changed.
    pub fingerprint: String,
    #[serde(skip)]
    pub parsed: ParsedFile,
}

/// FNV-1a, stable across runs and platforms.
pub fn fingerprint(bytes: &[u8]) -> String {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for b in bytes {
        hash ^= u64::from(*b);
        hash = hash.wrapping_mul(0x0100_0000_01b3);
    }
    format!("{hash:016x}")
}

fn parse_range(s: &str) -> Option<(u32, u32)> {
    match s.split_once(',') {
        Some((start, count)) => Some((start.parse().ok()?, count.parse().ok()?)),
        None => Some((s.parse().ok()?, 1)),
    }
}

/// Parse `@@ -a,b +c,d @@ section`.
fn parse_hunk_header(line: &str) -> Option<(u32, u32, u32, u32, String)> {
    let rest = line.strip_prefix("@@ -")?;
    let (old, rest) = rest.split_once(" +")?;
    let (new, rest) = rest.split_once(" @@")?;
    let (os, ol) = parse_range(old)?;
    let (ns, nl) = parse_range(new)?;
    Some((os, ol, ns, nl, rest.trim_start().to_string()))
}

fn display(raw: &[u8]) -> (String, bool) {
    let crlf = raw.last() == Some(&b'\r');
    let body = if crlf { &raw[..raw.len() - 1] } else { raw };
    (String::from_utf8_lossy(body).into_owned(), crlf)
}

/// Parse the unified diff of a single file section. Content after the first
/// file section (if any) is parsed as further sections and returned separately.
pub fn parse_unified(output: &[u8]) -> Result<Vec<ParsedFile>, GitError> {
    let mut files: Vec<ParsedFile> = Vec::new();
    let mut lines = output.split(|b| *b == b'\n').peekable();
    // A trailing newline produces one empty final element; drop it.
    let mut all: Vec<&[u8]> = Vec::new();
    while let Some(l) = lines.next() {
        if lines.peek().is_none() && l.is_empty() {
            break;
        }
        all.push(l);
    }

    let mut i = 0;
    while i < all.len() {
        let line = all[i];
        if !line.starts_with(b"diff ") {
            // Tolerate leading noise; Git does not emit any with our flags.
            i += 1;
            continue;
        }
        let mut file = ParsedFile::default();
        file.header.push(line.to_vec());
        i += 1;
        // Header until the first hunk or the next file.
        while i < all.len() && !all[i].starts_with(b"@@ ") && !all[i].starts_with(b"diff ") {
            let l = all[i];
            if l.starts_with(b"Binary files ") || l.starts_with(b"GIT binary patch") {
                file.is_binary = true;
            }
            file.header.push(l.to_vec());
            i += 1;
        }
        // Hunks.
        while i < all.len() && all[i].starts_with(b"@@ ") {
            let header = String::from_utf8_lossy(all[i]).into_owned();
            let (old_start, old_lines, new_start, new_lines, section) = parse_hunk_header(&header)
                .ok_or_else(|| GitError::Parse(format!("bad hunk header: {header}")))?;
            i += 1;
            let mut hunk = DiffHunk {
                header,
                old_start,
                old_lines,
                new_start,
                new_lines,
                section,
                lines: Vec::new(),
            };
            let (mut old_left, mut new_left) = (old_lines, new_lines);
            let (mut old_no, mut new_no) = (old_start, new_start);
            while i < all.len() && (old_left > 0 || new_left > 0) {
                let l = all[i];
                let (kind, body): (LineKind, &[u8]) = match l.first() {
                    Some(b' ') => (LineKind::Context, &l[1..]),
                    Some(b'+') => (LineKind::Add, &l[1..]),
                    Some(b'-') => (LineKind::Delete, &l[1..]),
                    // `diff.suppressBlankEmpty` prints empty context lines without the space.
                    None => (LineKind::Context, l),
                    Some(b'\\') => {
                        if let Some(prev) = hunk.lines.last_mut() {
                            prev.no_newline = true;
                        }
                        i += 1;
                        continue;
                    }
                    Some(_) => {
                        return Err(GitError::Parse(format!(
                            "unexpected diff line: {}",
                            String::from_utf8_lossy(l)
                        )))
                    }
                };
                let (content, crlf) = display(body);
                let (old_line, new_line) = match kind {
                    LineKind::Context => {
                        old_left = old_left.saturating_sub(1);
                        new_left = new_left.saturating_sub(1);
                        old_no += 1;
                        new_no += 1;
                        (Some(old_no - 1), Some(new_no - 1))
                    }
                    LineKind::Delete => {
                        old_left = old_left.saturating_sub(1);
                        old_no += 1;
                        (Some(old_no - 1), None)
                    }
                    LineKind::Add => {
                        new_left = new_left.saturating_sub(1);
                        new_no += 1;
                        (None, Some(new_no - 1))
                    }
                };
                hunk.lines.push(DiffLine {
                    kind,
                    content,
                    old_line,
                    new_line,
                    no_newline: false,
                    crlf,
                    raw: body.to_vec(),
                });
                i += 1;
            }
            // A trailing "\ No newline at end of file" after the last counted line.
            if i < all.len() && all[i].first() == Some(&b'\\') {
                if let Some(prev) = hunk.lines.last_mut() {
                    prev.no_newline = true;
                }
                i += 1;
            }
            file.hunks.push(hunk);
        }
        files.push(file);
    }
    Ok(files)
}

fn header_value(header: &[Vec<u8>], prefix: &str) -> Option<String> {
    header.iter().find_map(|l| {
        l.strip_prefix(prefix.as_bytes())
            .map(|v| String::from_utf8_lossy(v).trim().to_string())
    })
}

fn has_header(header: &[Vec<u8>], prefix: &str) -> bool {
    header.iter().any(|l| l.starts_with(prefix.as_bytes()))
}

/// Path of the `+++ b/...` side, used to pick the right section when a
/// rename is shown as two sections.
fn new_side_path(file: &ParsedFile) -> Option<String> {
    let v = header_value(&file.header, "+++ ")?;
    let v = v.trim_matches('"');
    v.strip_prefix("b/").map(str::to_string)
}

pub const DIFF_FLAGS: &[&str] = &[
    "--no-color",
    "--no-ext-diff",
    "--no-textconv",
    "--no-relative",
    "--src-prefix=a/",
    "--dst-prefix=b/",
    "--unified=3",
];

fn conflict_view(root: &Path, path: &str, area: DiffArea) -> Result<FileDiff, GitError> {
    let full = root.join(path);
    let meta = std::fs::symlink_metadata(&full).ok();
    let mut lines = Vec::new();
    let mut size = 0u64;
    let mut binary = false;
    let mut too_large = false;
    if let Some(meta) = meta.filter(|m| m.is_file()) {
        size = meta.len();
        if size as usize > SOFT_LIMIT_BYTES {
            too_large = true;
        } else {
            let bytes = std::fs::read(&full)
                .map_err(|e| GitError::Internal(format!("cannot read {path}: {e}")))?;
            binary = bytes.iter().take(8000).any(|b| *b == 0);
            if !binary {
                let mut n = 0;
                for raw in bytes.split(|b| *b == b'\n') {
                    n += 1;
                    let (content, crlf) = display(raw);
                    lines.push(DiffLine {
                        kind: LineKind::Context,
                        content,
                        old_line: None,
                        new_line: Some(n),
                        no_newline: false,
                        crlf,
                        raw: raw.to_vec(),
                    });
                }
                if bytes.ends_with(b"\n") {
                    lines.pop();
                }
            }
        }
    }
    let has_markers = lines.iter().any(|l| {
        l.content.starts_with("<<<<<<< ")
            || l.content.starts_with(">>>>>>> ")
            || l.content == "======="
    });
    let count = lines.len() as u32;
    Ok(FileDiff {
        path: path.to_string(),
        original_path: None,
        area,
        hunks: if lines.is_empty() {
            Vec::new()
        } else {
            vec![DiffHunk {
                header: String::new(),
                old_start: 0,
                old_lines: 0,
                new_start: 1,
                new_lines: count,
                section: String::new(),
                lines,
            }]
        },
        is_binary: binary,
        too_large,
        size_bytes: size,
        additions: 0,
        deletions: 0,
        old_mode: None,
        new_mode: None,
        change: None,
        supports_partial: false,
        has_conflict_markers: has_markers,
        fingerprint: String::new(),
        parsed: ParsedFile::default(),
    })
}

/// Load the diff of one file in one area.
pub fn file_diff(
    root: &Path,
    path: &str,
    original_path: Option<&str>,
    area: DiffArea,
    force: bool,
) -> Result<FileDiff, GitError> {
    validate_relative(path)?;
    if let Some(o) = original_path {
        validate_relative(o)?;
    }
    if area == DiffArea::Conflicted {
        return conflict_view(root, path, area);
    }

    let mut args: Vec<&str> = vec!["diff"];
    match area {
        DiffArea::Untracked => {
            args.push("--no-index");
            args.extend_from_slice(DIFF_FLAGS);
            args.extend_from_slice(&["--", "/dev/null", path]);
        }
        DiffArea::Staged | DiffArea::Unstaged => {
            if area == DiffArea::Staged {
                args.push("--cached");
            }
            args.extend_from_slice(DIFF_FLAGS);
            args.push("-M");
            args.push("--");
            if let Some(o) = original_path {
                args.push(o);
            }
            args.push(path);
        }
        DiffArea::Conflicted | DiffArea::Commit => {
            return Err(GitError::Unsupported(
                "Use the conflict or commit diff functions for this area.".into(),
            ))
        }
    }

    let limit = if force {
        HARD_LIMIT_BYTES
    } else {
        SOFT_LIMIT_BYTES
    };
    let out = match run_git_with(
        root,
        &args,
        &RunOptions {
            timeout: DEFAULT_TIMEOUT,
            // `--no-index` exits 1 when the files differ.
            ok_codes: if area == DiffArea::Untracked {
                &[0, 1]
            } else {
                &[0]
            },
            max_output: Some(limit),
            stdin: None,
            pathspec_magic: false,
        },
    ) {
        Ok(out) => out,
        Err(GitError::OutputTooLarge { .. }) if !force => {
            return Ok(empty_diff(path, original_path, area, true, limit as u64));
        }
        Err(e) => return Err(e),
    };

    diff_from_raw(out.stdout, path, original_path, area, force)
}

/// Load the diff of `path` in commit `oid` (relative to its first parent).
pub fn commit_diff(
    root: &Path,
    oid: &str,
    path: &str,
    original_path: Option<&str>,
    force: bool,
) -> Result<FileDiff, GitError> {
    let limit = if force {
        HARD_LIMIT_BYTES
    } else {
        SOFT_LIMIT_BYTES
    };
    match super::log::commit_file_diff_raw(root, oid, path, original_path, limit) {
        Ok(raw) => diff_from_raw(raw, path, original_path, DiffArea::Commit, force),
        Err(GitError::OutputTooLarge { .. }) if !force => Ok(empty_diff(
            path,
            original_path,
            DiffArea::Commit,
            true,
            limit as u64,
        )),
        Err(e) => Err(e),
    }
}

/// Turn raw `git diff` output for one file into a [`FileDiff`].
fn diff_from_raw(
    raw: Vec<u8>,
    path: &str,
    original_path: Option<&str>,
    area: DiffArea,
    force: bool,
) -> Result<FileDiff, GitError> {
    let line_count = raw.iter().filter(|b| **b == b'\n').count();
    if !force && line_count > SOFT_LIMIT_LINES {
        return Ok(empty_diff(
            path,
            original_path,
            area,
            true,
            raw.len() as u64,
        ));
    }
    let sections = parse_unified(&raw)?;
    let parsed = if sections.len() > 1 {
        sections
            .iter()
            .find(|f| new_side_path(f).as_deref() == Some(path))
            .cloned()
            .unwrap_or_else(|| sections[0].clone())
    } else {
        sections.into_iter().next().unwrap_or_default()
    };

    let change = if has_header(&parsed.header, "new file mode") {
        Some("new")
    } else if has_header(&parsed.header, "deleted file mode") {
        Some("deleted")
    } else if has_header(&parsed.header, "rename from") {
        Some("renamed")
    } else if has_header(&parsed.header, "copy from") {
        Some("copied")
    } else {
        None
    };
    let old_mode = header_value(&parsed.header, "old mode ")
        .or_else(|| header_value(&parsed.header, "deleted file mode "));
    let new_mode = header_value(&parsed.header, "new mode ")
        .or_else(|| header_value(&parsed.header, "new file mode "));

    let (mut additions, mut deletions) = (0, 0);
    for line in parsed.hunks.iter().flat_map(|h| &h.lines) {
        match line.kind {
            LineKind::Add => additions += 1,
            LineKind::Delete => deletions += 1,
            LineKind::Context => {}
        }
    }

    let supports_partial = !parsed.is_binary
        && !parsed.hunks.is_empty()
        && matches!(area, DiffArea::Staged | DiffArea::Unstaged)
        && !matches!(change, Some("renamed") | Some("copied"));

    Ok(FileDiff {
        path: path.to_string(),
        original_path: original_path.map(str::to_string),
        area,
        hunks: parsed.hunks.clone(),
        is_binary: parsed.is_binary,
        too_large: false,
        size_bytes: raw.len() as u64,
        additions,
        deletions,
        old_mode,
        new_mode,
        change: change.map(str::to_string),
        supports_partial,
        has_conflict_markers: false,
        fingerprint: fingerprint(&raw),
        parsed,
    })
}

fn empty_diff(
    path: &str,
    original_path: Option<&str>,
    area: DiffArea,
    too_large: bool,
    size: u64,
) -> FileDiff {
    FileDiff {
        path: path.to_string(),
        original_path: original_path.map(str::to_string),
        area,
        hunks: Vec::new(),
        is_binary: false,
        too_large,
        size_bytes: size,
        additions: 0,
        deletions: 0,
        old_mode: None,
        new_mode: None,
        change: None,
        supports_partial: false,
        has_conflict_markers: false,
        fingerprint: String::new(),
        parsed: ParsedFile::default(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SIMPLE: &str = "diff --git a/f.txt b/f.txt
index 1111111..2222222 100644
--- a/f.txt
+++ b/f.txt
@@ -1,4 +1,4 @@ fn main()
 one
-two
+TWO
 three
 four
@@ -10,2 +10,3 @@
 ten
+ten and a half
 eleven
";

    #[test]
    fn parses_hunks_and_line_numbers() {
        let files = parse_unified(SIMPLE.as_bytes()).unwrap();
        assert_eq!(files.len(), 1);
        let f = &files[0];
        assert_eq!(f.header.len(), 4);
        assert_eq!(f.hunks.len(), 2);
        let h = &f.hunks[0];
        assert_eq!(
            (h.old_start, h.old_lines, h.new_start, h.new_lines),
            (1, 4, 1, 4)
        );
        assert_eq!(h.section, "fn main()");
        assert_eq!(h.lines[1].kind, LineKind::Delete);
        assert_eq!(h.lines[1].old_line, Some(2));
        assert_eq!(h.lines[2].kind, LineKind::Add);
        assert_eq!(h.lines[2].new_line, Some(2));
        assert_eq!(h.lines[3].old_line, Some(3));
        assert_eq!(h.lines[3].new_line, Some(3));
        let h2 = &f.hunks[1];
        assert_eq!(h2.lines[1].content, "ten and a half");
        assert_eq!(h2.lines[1].new_line, Some(11));
        assert_eq!(h2.lines[2].old_line, Some(11));
    }

    #[test]
    fn handles_no_newline_markers_and_crlf() {
        let diff = b"diff --git a/f b/f\n--- a/f\n+++ b/f\n@@ -1 +1 @@\n-old\r\n\\ No newline at end of file\n+new\n";
        let f = &parse_unified(diff).unwrap()[0];
        let lines = &f.hunks[0].lines;
        assert!(lines[0].no_newline);
        assert!(lines[0].crlf);
        assert_eq!(lines[0].content, "old");
        assert_eq!(lines[0].raw, b"old\r");
        assert!(!lines[1].no_newline);
    }

    #[test]
    fn treats_bare_empty_lines_as_context() {
        // diff.suppressBlankEmpty=true
        let diff = b"diff --git a/f b/f\n--- a/f\n+++ b/f\n@@ -1,3 +1,3 @@\n a\n\n-b\n+c\n";
        let h = &parse_unified(diff).unwrap()[0].hunks[0];
        assert_eq!(h.lines.len(), 4);
        assert_eq!(h.lines[1].kind, LineKind::Context);
        assert_eq!(h.lines[1].content, "");
    }

    #[test]
    fn detects_binary_and_new_files() {
        let diff = b"diff --git a/img.png b/img.png\nnew file mode 100644\nindex 0000000..abc\nBinary files /dev/null and b/img.png differ\n";
        let f = &parse_unified(diff).unwrap()[0];
        assert!(f.is_binary);
        assert!(f.hunks.is_empty());
        assert!(has_header(&f.header, "new file mode"));
    }

    #[test]
    fn splits_multiple_sections() {
        let diff = format!("{SIMPLE}diff --git a/g b/g\n--- a/g\n+++ b/g\n@@ -1 +1 @@\n-x\n+y\n");
        let files = parse_unified(diff.as_bytes()).unwrap();
        assert_eq!(files.len(), 2);
        assert_eq!(new_side_path(&files[1]).as_deref(), Some("g"));
    }

    #[test]
    fn rejects_garbage_in_hunks() {
        let diff = b"diff --git a/f b/f\n--- a/f\n+++ b/f\n@@ -1 +1 @@\n?what\n";
        assert!(parse_unified(diff).is_err());
        let diff = b"diff --git a/f b/f\n@@ nonsense @@\n";
        assert!(parse_unified(diff).is_err());
    }

    #[test]
    fn fingerprint_is_stable() {
        assert_eq!(fingerprint(b"abc"), fingerprint(b"abc"));
        assert_ne!(fingerprint(b"abc"), fingerprint(b"abd"));
        assert_eq!(fingerprint(b""), "cbf29ce484222325");
    }
}
