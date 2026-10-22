//! Three-way view of one conflicted file, and saving its resolution.
//!
//! The view is built from the index stages Git keeps for an unmerged path:
//! stage 1 is the common base, stage 2 "ours" (the current side) and stage 3
//! "theirs" (the incoming side). Git's own diff (`histogram`, no context lines)
//! compares the base with each side, and the changes are grouped into segments:
//! text that is the same everywhere, changes made on one side only, the same
//! change made on both sides, and conflicts. The frontend lets the user take
//! changes into the result and saves it with [`resolve_with_text`].
//!
//! Every save checks a fingerprint of the stages and the working-tree file, so a
//! resolution never overwrites a file that changed after the editor opened it.

use std::collections::hash_map::DefaultHasher;
use std::collections::BTreeMap;
use std::hash::{Hash, Hasher};
use std::path::Path;

use serde::{Deserialize, Serialize};

use super::ops::write_lock;
use super::paths::validate_relative;
use super::repository::{detect_operation, resolve_paths, RepoOperation};
use super::runner::{run_git, run_git_with, RunOptions, DEFAULT_TIMEOUT};
use super::status::ConflictKind;
use crate::error::GitError;

/// Larger versions are offered as whole-file choices only.
pub const MAX_MERGE_BYTES: u64 = 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitRef {
    pub oid: String,
    pub summary: String,
}

/// One side of the conflict, named for the operation in progress.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConflictSide {
    /// Short name, for example the branch name or "Stashed changes".
    pub label: String,
    /// What this side is, for example "Current branch" or "Commit being cherry-picked".
    pub role: String,
    pub commit: Option<CommitRef>,
    /// False when this side deleted the file.
    pub exists: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ChangeSide {
    /// Changed on our side only.
    Ours,
    /// Changed on their side only.
    Theirs,
    /// Changed the same way on both sides.
    Both,
    /// Changed differently on both sides.
    Conflict,
}

/// A run of lines in the three-way view. Lines keep their line endings, so
/// joining them gives the exact text.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum MergeSegment {
    Same {
        lines: Vec<String>,
    },
    Change {
        change: ChangeSide,
        base: Vec<String>,
        ours: Vec<String>,
        theirs: Vec<String>,
    },
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConflictFile {
    pub path: String,
    pub conflict: ConflictKind,
    pub ours: ConflictSide,
    pub theirs: ConflictSide,
    pub base_exists: bool,
    /// The three-way view, when the versions are text that can be merged line by line.
    pub segments: Option<Vec<MergeSegment>>,
    /// Why only whole-file choices are offered (binary, too large, deleted on one side…).
    pub unmergeable: Option<String>,
    /// Passed back when saving, to detect changes made in the meantime.
    pub fingerprint: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ResolveSide {
    /// Keep our version (deletes the file if our side deleted it).
    Ours,
    /// Keep their version (deletes the file if their side deleted it).
    Theirs,
    /// Delete the file.
    Delete,
}

/// A change between the base and one side: half-open line ranges.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Hunk {
    pub base: (usize, usize),
    pub side: (usize, usize),
}

#[derive(Debug, Clone)]
struct Stage {
    mode: String,
    oid: String,
}

/// Split text into lines, each keeping its line ending.
pub fn split_lines(text: &str) -> Vec<String> {
    text.split_inclusive('\n').map(str::to_string).collect()
}

fn parse_range(spec: &str) -> Option<(usize, usize)> {
    let (start, len) = match spec.split_once(',') {
        Some((s, l)) => (s.parse::<usize>().ok()?, l.parse::<usize>().ok()?),
        None => (spec.parse::<usize>().ok()?, 1),
    };
    // With no lines, `start` is the line *before* the change.
    let begin = if len == 0 {
        start
    } else {
        start.checked_sub(1)?
    };
    Some((begin, begin + len))
}

/// Hunks from `git diff -U0` output.
pub fn parse_hunks(diff: &str) -> Result<Vec<Hunk>, GitError> {
    let mut hunks = Vec::new();
    for line in diff.lines().filter(|l| l.starts_with("@@ ")) {
        let mut parts = line.split(' ');
        let old = parts.nth(1).and_then(|s| s.strip_prefix('-'));
        let new = parts.next().and_then(|s| s.strip_prefix('+'));
        let (Some(base), Some(side)) = (old.and_then(parse_range), new.and_then(parse_range))
        else {
            return Err(GitError::Parse(format!("unexpected hunk header: {line}")));
        };
        hunks.push(Hunk { base, side });
    }
    Ok(hunks)
}

/// Group the changes of both sides against the base into segments (the classic
/// diff3 algorithm). Changes that overlap or touch form one segment.
pub fn build_segments(
    base: &[String],
    ours: &[String],
    theirs: &[String],
    ours_hunks: &[Hunk],
    theirs_hunks: &[Hunk],
) -> Result<Vec<MergeSegment>, GitError> {
    let bad = || GitError::Parse("diff does not match the file versions".into());
    let mut segments = Vec::new();
    let (mut i, mut j) = (0, 0);
    let mut pos = 0usize;
    let (mut off_o, mut off_t) = (0isize, 0isize);
    let shift = |n: usize, off: isize| -> Option<usize> { n.checked_add_signed(off) };

    loop {
        let lo = match (ours_hunks.get(i), theirs_hunks.get(j)) {
            (None, None) => break,
            (Some(a), None) => a.base.0,
            (None, Some(b)) => b.base.0,
            (Some(a), Some(b)) => a.base.0.min(b.base.0),
        };
        if lo < pos || lo > base.len() {
            return Err(bad());
        }
        if lo > pos {
            segments.push(MergeSegment::Same {
                lines: base[pos..lo].to_vec(),
            });
        }
        let (start_i, start_j) = (i, j);
        let mut hi = lo;
        loop {
            let mut grew = false;
            while let Some(h) = ours_hunks.get(i).filter(|h| h.base.0 <= hi) {
                hi = hi.max(h.base.1);
                i += 1;
                grew = true;
            }
            while let Some(h) = theirs_hunks.get(j).filter(|h| h.base.0 <= hi) {
                hi = hi.max(h.base.1);
                j += 1;
                grew = true;
            }
            if !grew {
                break;
            }
        }
        if hi > base.len() {
            return Err(bad());
        }
        let o_start = shift(lo, off_o).ok_or_else(bad)?;
        for h in &ours_hunks[start_i..i] {
            off_o += (h.side.1 - h.side.0) as isize - (h.base.1 - h.base.0) as isize;
        }
        let o_end = shift(hi, off_o).ok_or_else(bad)?;
        let t_start = shift(lo, off_t).ok_or_else(bad)?;
        for h in &theirs_hunks[start_j..j] {
            off_t += (h.side.1 - h.side.0) as isize - (h.base.1 - h.base.0) as isize;
        }
        let t_end = shift(hi, off_t).ok_or_else(bad)?;
        if o_start > o_end || o_end > ours.len() || t_start > t_end || t_end > theirs.len() {
            return Err(bad());
        }
        let o = ours[o_start..o_end].to_vec();
        let t = theirs[t_start..t_end].to_vec();
        let change = match (i > start_i, j > start_j) {
            (true, false) => ChangeSide::Ours,
            (false, true) => ChangeSide::Theirs,
            _ if o == t => ChangeSide::Both,
            _ => ChangeSide::Conflict,
        };
        segments.push(MergeSegment::Change {
            change,
            base: base[lo..hi].to_vec(),
            ours: o,
            theirs: t,
        });
        pos = hi;
    }
    if pos < base.len() {
        segments.push(MergeSegment::Same {
            lines: base[pos..].to_vec(),
        });
    }
    Ok(segments)
}

fn git(root: &Path, args: &[&str]) -> Result<Vec<u8>, GitError> {
    Ok(run_git(root, args, DEFAULT_TIMEOUT)?.stdout)
}

fn text(bytes: Vec<u8>) -> String {
    String::from_utf8_lossy(&bytes).trim().to_string()
}

/// Index stages of an unmerged path; empty when the path is not conflicted.
fn stages(root: &Path, path: &str) -> Result<BTreeMap<u8, Stage>, GitError> {
    let out = git(root, &["ls-files", "-u", "-z", "--", path])?;
    let mut map = BTreeMap::new();
    for record in out.split(|b| *b == 0).filter(|r| !r.is_empty()) {
        let record = String::from_utf8_lossy(record);
        let Some((meta, name)) = record.split_once('\t') else {
            continue;
        };
        if name != path {
            continue;
        }
        let mut f = meta.split(' ');
        if let (Some(mode), Some(oid), Some(stage)) = (f.next(), f.next(), f.next()) {
            if let Ok(stage) = stage.parse::<u8>() {
                map.insert(
                    stage,
                    Stage {
                        mode: mode.to_string(),
                        oid: oid.to_string(),
                    },
                );
            }
        }
    }
    Ok(map)
}

fn conflict_kind(stages: &BTreeMap<u8, Stage>) -> ConflictKind {
    match (
        stages.contains_key(&1),
        stages.contains_key(&2),
        stages.contains_key(&3),
    ) {
        (true, true, true) => ConflictKind::BothModified,
        (false, true, true) => ConflictKind::BothAdded,
        (true, true, false) => ConflictKind::DeletedByThem,
        (true, false, true) => ConflictKind::DeletedByUs,
        (false, true, false) => ConflictKind::AddedByUs,
        (false, false, true) => ConflictKind::AddedByThem,
        _ => ConflictKind::BothDeleted,
    }
}

/// Fingerprint of the conflict: the stages plus the working-tree file.
fn fingerprint(root: &Path, path: &str, stages: &BTreeMap<u8, Stage>) -> String {
    let mut hasher = DefaultHasher::new();
    for (n, s) in stages {
        (n, &s.mode, &s.oid).hash(&mut hasher);
    }
    match std::fs::symlink_metadata(root.join(path)) {
        Ok(meta) if meta.is_file() => std::fs::read(root.join(path)).ok().hash(&mut hasher),
        Ok(meta) => meta.file_type().is_symlink().hash(&mut hasher),
        Err(_) => "missing".hash(&mut hasher),
    }
    format!("{:016x}", hasher.finish())
}

fn commit_ref(root: &Path, rev: &str) -> Option<CommitRef> {
    let out = run_git_with(
        root,
        &["log", "-1", "--format=%H%x00%s", rev, "--"],
        &RunOptions {
            ok_codes: &[0, 128],
            ..RunOptions::default()
        },
    )
    .ok()?;
    if out.code != 0 {
        return None;
    }
    let line = out.stdout_string();
    let (oid, summary) = line.trim_end().split_once('\0')?;
    Some(CommitRef {
        oid: oid.to_string(),
        summary: summary.to_string(),
    })
}

fn current_branch(root: &Path) -> String {
    run_git_with(
        root,
        &["symbolic-ref", "-q", "--short", "HEAD"],
        &RunOptions {
            ok_codes: &[0, 1, 128],
            ..RunOptions::default()
        },
    )
    .map(|o| o.stdout_string().trim().to_string())
    .ok()
    .filter(|s| !s.is_empty())
    .unwrap_or_else(|| "HEAD".into())
}

fn read_trimmed(path: &Path) -> Option<String> {
    std::fs::read_to_string(path)
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

/// Name of the branch being merged, from Git's prepared merge message.
pub fn merged_name(merge_msg: &str) -> Option<String> {
    let first = merge_msg.lines().next()?;
    let rest = first
        .strip_prefix("Merge branch '")
        .or_else(|| first.strip_prefix("Merge remote-tracking branch '"))?;
    Some(rest.split('\'').next()?.to_string())
}

/// Names and commits for both sides, depending on the operation in progress.
fn sides(root: &Path, git_dir: &Path) -> (ConflictSide, ConflictSide) {
    let side = |label: String, role: &str, commit: Option<CommitRef>| ConflictSide {
        label,
        role: role.to_string(),
        commit,
        exists: true,
    };
    let short = |c: &Option<CommitRef>| {
        c.as_ref()
            .map(|c| format!("commit {}", &c.oid[..7.min(c.oid.len())]))
    };
    match detect_operation(git_dir) {
        Some(RepoOperation::Merge) => {
            let theirs = commit_ref(root, "MERGE_HEAD");
            let label = read_trimmed(&git_dir.join("MERGE_MSG"))
                .and_then(|m| merged_name(&m))
                .or_else(|| short(&theirs))
                .unwrap_or_else(|| "Merged changes".into());
            (
                side(
                    current_branch(root),
                    "Current branch",
                    commit_ref(root, "HEAD"),
                ),
                side(label, "Being merged", theirs),
            )
        }
        Some(RepoOperation::Rebase) => {
            let dir = if git_dir.join("rebase-merge").is_dir() {
                git_dir.join("rebase-merge")
            } else {
                git_dir.join("rebase-apply")
            };
            let branch = read_trimmed(&dir.join("head-name"))
                .map(|h| h.trim_start_matches("refs/heads/").to_string())
                .filter(|h| h != "detached HEAD")
                .unwrap_or_else(|| "Your commit".into());
            let onto = read_trimmed(&dir.join("onto"))
                .and_then(|oid| {
                    run_git_with(
                        root,
                        &["name-rev", "--name-only", "--no-undefined", &oid],
                        &RunOptions {
                            ok_codes: &[0, 128],
                            ..RunOptions::default()
                        },
                    )
                    .ok()
                    .filter(|o| o.code == 0)
                    .map(|o| o.stdout_string().trim().to_string())
                })
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| "Upstream".into());
            (
                side(onto, "Rebasing onto", commit_ref(root, "HEAD")),
                side(
                    branch,
                    "Commit being rebased",
                    commit_ref(root, "REBASE_HEAD"),
                ),
            )
        }
        Some(RepoOperation::CherryPick) => {
            let theirs = commit_ref(root, "CHERRY_PICK_HEAD");
            (
                side(
                    current_branch(root),
                    "Current branch",
                    commit_ref(root, "HEAD"),
                ),
                side(
                    short(&theirs).unwrap_or_else(|| "Picked commit".into()),
                    "Commit being cherry-picked",
                    theirs,
                ),
            )
        }
        Some(RepoOperation::Revert) => {
            let theirs = commit_ref(root, "REVERT_HEAD");
            (
                side(
                    current_branch(root),
                    "Current branch",
                    commit_ref(root, "HEAD"),
                ),
                side(
                    short(&theirs)
                        .map(|s| format!("Undo {s}"))
                        .unwrap_or_else(|| "Revert".into()),
                    "Commit being reverted (undone)",
                    theirs,
                ),
            )
        }
        // Applying a stash (also after a pull with autostash).
        _ => (
            side(
                current_branch(root),
                "Current branch",
                commit_ref(root, "HEAD"),
            ),
            side("Stashed changes".into(), "Changes being reapplied", None),
        ),
    }
}

/// Read a stage as text, or say why it cannot be merged line by line.
fn stage_text(root: &Path, stage: &Stage) -> Result<Result<String, String>, GitError> {
    match stage.mode.as_str() {
        "160000" => return Ok(Err("This is a submodule.".into())),
        "120000" => return Ok(Err("This is a symbolic link.".into())),
        _ => {}
    }
    let size: u64 = text(git(root, &["cat-file", "-s", &stage.oid])?)
        .parse()
        .unwrap_or(u64::MAX);
    if size > MAX_MERGE_BYTES {
        return Ok(Err(format!(
            "A version is larger than {} MB.",
            MAX_MERGE_BYTES / (1024 * 1024)
        )));
    }
    let bytes = git(root, &["cat-file", "blob", &stage.oid])?;
    if bytes.iter().take(8000).any(|b| *b == 0) {
        return Ok(Err("This is a binary file.".into()));
    }
    match String::from_utf8(bytes) {
        Ok(s) => Ok(Ok(s)),
        Err(_) => Ok(Err("This file is not UTF-8 text.".into())),
    }
}

fn hunks(
    root: &Path,
    from: Option<&Stage>,
    to: &Stage,
    to_len: usize,
) -> Result<Vec<Hunk>, GitError> {
    let Some(from) = from else {
        // No base (added on both sides): everything is new.
        return Ok(if to_len == 0 {
            Vec::new()
        } else {
            vec![Hunk {
                base: (0, 0),
                side: (0, to_len),
            }]
        });
    };
    if from.oid == to.oid {
        return Ok(Vec::new());
    }
    let out = git(
        root,
        &[
            "diff",
            "--no-color",
            "--no-ext-diff",
            "--no-textconv",
            "--unified=0",
            "--diff-algorithm=histogram",
            &from.oid,
            &to.oid,
        ],
    )?;
    parse_hunks(&String::from_utf8_lossy(&out))
}

/// The three-way view of one conflicted file.
pub fn load(repo: &str, path: &str) -> Result<ConflictFile, GitError> {
    let (root, git_dir) = resolve_paths(repo)?;
    let path = validate_relative(path)?;
    let stages = stages(&root, path)?;
    if stages.is_empty() {
        return Err(GitError::Unsupported(format!(
            "{path} is no longer conflicted."
        )));
    }
    let (mut ours, mut theirs) = sides(&root, &git_dir);
    ours.exists = stages.contains_key(&2);
    theirs.exists = stages.contains_key(&3);
    let mut file = ConflictFile {
        path: path.to_string(),
        conflict: conflict_kind(&stages),
        ours,
        theirs,
        base_exists: stages.contains_key(&1),
        segments: None,
        unmergeable: None,
        fingerprint: fingerprint(&root, path, &stages),
    };
    let (Some(o), Some(t)) = (stages.get(&2), stages.get(&3)) else {
        file.unmergeable = Some(if file.ours.exists {
            format!("{} deleted this file.", file.theirs.label)
        } else if file.theirs.exists {
            format!("{} deleted this file.", file.ours.label)
        } else {
            "Both sides deleted this file.".into()
        });
        return Ok(file);
    };
    let base_stage = stages.get(&1);
    let mut texts = Vec::new();
    for stage in [base_stage, Some(o), Some(t)].into_iter().flatten() {
        match stage_text(&root, stage)? {
            Ok(s) => texts.push(s),
            Err(reason) => {
                file.unmergeable = Some(reason);
                return Ok(file);
            }
        }
    }
    let theirs_text = texts.pop().unwrap_or_default();
    let ours_text = texts.pop().unwrap_or_default();
    let base_text = texts.pop().unwrap_or_default();
    let (base, ours_lines, theirs_lines) = (
        split_lines(&base_text),
        split_lines(&ours_text),
        split_lines(&theirs_text),
    );
    let ho = hunks(&root, base_stage, o, ours_lines.len())?;
    let ht = hunks(&root, base_stage, t, theirs_lines.len())?;
    file.segments = Some(build_segments(&base, &ours_lines, &theirs_lines, &ho, &ht)?);
    Ok(file)
}

/// Refuse to write through a symbolic link anywhere on the way to `path`.
fn check_no_symlinks(root: &Path, path: &str) -> Result<(), GitError> {
    let mut current = root.to_path_buf();
    for part in path.split('/') {
        current.push(part);
        match std::fs::symlink_metadata(&current) {
            Ok(meta) if meta.file_type().is_symlink() => {
                return Err(GitError::Unsupported(format!(
                    "{path} goes through a symbolic link; resolve it with Use ours or Use theirs."
                )))
            }
            Ok(meta) if meta.is_dir() && current == root.join(path) => {
                return Err(GitError::InvalidPath(path.to_string()))
            }
            _ => {}
        }
    }
    Ok(())
}

/// Lock, find the stages and make sure nothing changed since the editor opened.
fn prepare(
    repo: &str,
    path: &str,
    expected: &str,
) -> Result<(std::path::PathBuf, BTreeMap<u8, Stage>), GitError> {
    let (root, _) = resolve_paths(repo)?;
    let stages = stages(&root, path)?;
    if stages.is_empty() {
        return Err(GitError::Unsupported(format!(
            "{path} is no longer conflicted."
        )));
    }
    if fingerprint(&root, path, &stages) != expected {
        return Err(GitError::Unsupported(format!(
            "{path} changed after the merge editor opened it. Open it again to see the current state."
        )));
    }
    Ok((root, stages))
}

/// Save `content` as the resolved file and mark it as resolved.
pub fn resolve_with_text(
    repo: &str,
    path: &str,
    content: &str,
    expected: &str,
) -> Result<(), GitError> {
    let path = validate_relative(path)?;
    let _guard = write_lock();
    let (root, _) = prepare(repo, path, expected)?;
    check_no_symlinks(&root, path)?;
    let full = root.join(path);
    if let Some(parent) = full.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| GitError::Internal(format!("cannot create {}: {e}", parent.display())))?;
    }
    std::fs::write(&full, content.as_bytes())
        .map_err(|e| GitError::Internal(format!("cannot write {path}: {e}")))?;
    run_git(&root, &["add", "--", path], DEFAULT_TIMEOUT)?;
    Ok(())
}

/// Resolve by keeping one side's whole file, or by deleting the file.
pub fn resolve_with_side(
    repo: &str,
    path: &str,
    side: ResolveSide,
    expected: &str,
) -> Result<(), GitError> {
    let path = validate_relative(path)?;
    let _guard = write_lock();
    let (root, stages) = prepare(repo, path, expected)?;
    let keep = match side {
        ResolveSide::Ours => stages.contains_key(&2).then_some("--ours"),
        ResolveSide::Theirs => stages.contains_key(&3).then_some("--theirs"),
        ResolveSide::Delete => None,
    };
    match keep {
        Some(flag) => {
            run_git(&root, &["checkout", flag, "--", path], DEFAULT_TIMEOUT)?;
            run_git(&root, &["add", "--", path], DEFAULT_TIMEOUT)?;
        }
        None => {
            run_git(&root, &["rm", "-q", "--", path], DEFAULT_TIMEOUT)?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lines(s: &str) -> Vec<String> {
        split_lines(s)
    }

    #[test]
    fn parses_hunk_headers() {
        let diff = "diff --git a/x b/x\n@@ -3 +3 @@\n-a\n+b\n@@ -5,0 +6,2 @@\n+c\n+d\n@@ -8,2 +9,0 @@\n-e\n-f\n";
        assert_eq!(
            parse_hunks(diff).unwrap(),
            vec![
                Hunk {
                    base: (2, 3),
                    side: (2, 3)
                },
                Hunk {
                    base: (5, 5),
                    side: (5, 7)
                },
                Hunk {
                    base: (7, 9),
                    side: (9, 9)
                },
            ]
        );
        assert!(parse_hunks("@@ -x +1 @@\n").is_err());
    }

    #[test]
    fn groups_changes_into_segments() {
        let base = lines("1\n2\n3\n4\n5\n6\n");
        let ours = lines("1\nTWO\n3\n4\n5\n6\n");
        let theirs = lines("1\n2\n3\n4\nFIVE\n6\nseven\n");
        let ho = [Hunk {
            base: (1, 2),
            side: (1, 2),
        }];
        let ht = [
            Hunk {
                base: (4, 5),
                side: (4, 5),
            },
            Hunk {
                base: (6, 6),
                side: (6, 7),
            },
        ];
        let segs = build_segments(&base, &ours, &theirs, &ho, &ht).unwrap();
        assert_eq!(segs.len(), 6, "{segs:#?}");
        assert_eq!(
            segs[0],
            MergeSegment::Same {
                lines: lines("1\n")
            }
        );
        assert_eq!(
            segs[1],
            MergeSegment::Change {
                change: ChangeSide::Ours,
                base: lines("2\n"),
                ours: lines("TWO\n"),
                theirs: lines("2\n"),
            }
        );
        assert_eq!(
            segs[2],
            MergeSegment::Same {
                lines: lines("3\n4\n")
            }
        );
        assert!(matches!(
            &segs[3],
            MergeSegment::Change { change: ChangeSide::Theirs, theirs, .. } if theirs == &lines("FIVE\n")
        ));
        assert_eq!(
            segs[4],
            MergeSegment::Same {
                lines: lines("6\n")
            }
        );
        assert!(matches!(
            &segs[5],
            MergeSegment::Change { change: ChangeSide::Theirs, base, ours, theirs }
                if base.is_empty() && ours.is_empty() && theirs == &lines("seven\n")
        ));
    }

    #[test]
    fn overlapping_and_touching_changes_conflict_unless_equal() {
        let base = lines("a\nb\nc\nd\n");
        // Ours changes b, theirs changes b and c: overlap -> conflict.
        let ours = lines("a\nB\nc\nd\n");
        let theirs = lines("a\nx\ny\nd\n");
        let segs = build_segments(
            &base,
            &ours,
            &theirs,
            &[Hunk {
                base: (1, 2),
                side: (1, 2),
            }],
            &[Hunk {
                base: (1, 3),
                side: (1, 3),
            }],
        )
        .unwrap();
        assert_eq!(
            segs[1],
            MergeSegment::Change {
                change: ChangeSide::Conflict,
                base: lines("b\nc\n"),
                ours: lines("B\nc\n"),
                theirs: lines("x\ny\n"),
            }
        );

        // Both insert the same line at the same place -> Both.
        let ours = lines("a\nnew\nb\nc\nd\n");
        let segs = build_segments(
            &base,
            &ours,
            &ours,
            &[Hunk {
                base: (1, 1),
                side: (1, 2),
            }],
            &[Hunk {
                base: (1, 1),
                side: (1, 2),
            }],
        )
        .unwrap();
        assert!(matches!(
            &segs[1],
            MergeSegment::Change {
                change: ChangeSide::Both,
                ..
            }
        ));

        // Adjacent changes on different sides touch -> conflict, like Git.
        let ours = lines("A\nb\nc\nd\n");
        let theirs = lines("a\nB\nc\nd\n");
        let segs = build_segments(
            &base,
            &ours,
            &theirs,
            &[Hunk {
                base: (0, 1),
                side: (0, 1),
            }],
            &[Hunk {
                base: (1, 2),
                side: (1, 2),
            }],
        )
        .unwrap();
        assert!(matches!(
            &segs[0],
            MergeSegment::Change { change: ChangeSide::Conflict, base, .. } if base.len() == 2
        ));
    }

    #[test]
    fn segments_rebuild_each_side_exactly() {
        let base = lines("1\n2\n3\n4\n5\n6\n7\n8");
        let ours = lines("0\n1\n2\nthree\n4\n6\n7\n8\n");
        let theirs = lines("1\n2\n3\nfour\n4b\n5\n6\n8");
        let ho = [
            Hunk {
                base: (0, 0),
                side: (0, 1),
            },
            Hunk {
                base: (2, 3),
                side: (3, 4),
            },
            Hunk {
                base: (4, 5),
                side: (5, 5),
            },
            Hunk {
                base: (7, 8),
                side: (7, 8),
            },
        ];
        let ht = [
            Hunk {
                base: (3, 4),
                side: (3, 5),
            },
            Hunk {
                base: (6, 7),
                side: (7, 7),
            },
        ];
        let segs = build_segments(&base, &ours, &theirs, &ho, &ht).unwrap();
        // 0: base, 1: ours, 2: theirs.
        let side = |n: usize| -> String {
            segs.iter()
                .flat_map(|s| match s {
                    MergeSegment::Same { lines } => lines.clone(),
                    MergeSegment::Change {
                        base, ours, theirs, ..
                    } => [base, ours, theirs][n].clone(),
                })
                .collect()
        };
        assert_eq!(side(0), base.concat());
        assert_eq!(side(1), ours.concat());
        assert_eq!(side(2), theirs.concat());
    }

    #[test]
    fn rejects_hunks_that_do_not_fit() {
        let base = lines("a\n");
        assert!(build_segments(
            &base,
            &base,
            &base,
            &[Hunk {
                base: (3, 4),
                side: (3, 4)
            }],
            &[]
        )
        .is_err());
    }

    #[test]
    fn reads_the_merged_branch_name() {
        assert_eq!(
            merged_name("Merge branch 'feature/x' into main\n\n# Conflicts:"),
            Some("feature/x".into())
        );
        assert_eq!(
            merged_name("Merge remote-tracking branch 'origin/main'"),
            Some("origin/main".into())
        );
        assert_eq!(merged_name("Merge commit 'abc'"), None);
    }
}
