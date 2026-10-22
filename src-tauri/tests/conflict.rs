//! The three-way view of a conflicted file and saving its resolution.

use std::fs;
use std::path::Path;
use std::process::Command;

use branchline_lib::git::conflict::{
    load, resolve_with_side, resolve_with_text, ChangeSide, MergeSegment, ResolveSide,
};
use branchline_lib::git::integrate::{step, Step};
use branchline_lib::git::repository::{inspect, RepoOperation};
use branchline_lib::git::status::ConflictKind;
use tempfile::TempDir;

fn git_status(dir: &Path, args: &[&str]) -> (bool, String) {
    let out = Command::new("git")
        .args(args)
        .current_dir(dir)
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_EDITOR", ":")
        .output()
        .unwrap();
    (
        out.status.success(),
        String::from_utf8_lossy(&out.stdout).trim().to_string(),
    )
}

fn git(dir: &Path, args: &[&str]) -> String {
    let (ok, out) = git_status(dir, args);
    assert!(ok, "git {args:?} failed");
    out
}

fn write(d: &Path, name: &str, content: &[u8]) {
    fs::write(d.join(name), content).unwrap();
}

fn commit(d: &Path, name: &str, content: &str, msg: &str) {
    write(d, name, content.as_bytes());
    git(d, &["add", "-A"]);
    git(d, &["commit", "-q", "-m", msg]);
}

fn s(p: &Path) -> String {
    p.to_str().unwrap().to_string()
}

fn repo() -> TempDir {
    let t = TempDir::new().unwrap();
    let d = t.path();
    git(d, &["init", "-q", "-b", "main"]);
    git(d, &["config", "user.name", "T"]);
    git(d, &["config", "user.email", "t@example.com"]);
    git(d, &["config", "commit.gpgsign", "false"]);
    git(d, &["config", "core.autocrlf", "false"]);
    t
}

const BASE: &str = "one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten\n";

/// main and feature both change the file; `git merge feature` stops with a conflict.
fn merge_conflict() -> TempDir {
    let t = repo();
    let d = t.path();
    commit(d, "f.txt", BASE, "base");
    git(d, &["switch", "-q", "-c", "feature"]);
    commit(
        d,
        "f.txt",
        &BASE.replace("six", "SIX (feature)").replace("nine", "NINE"),
        "feature edits",
    );
    git(d, &["switch", "-q", "main"]);
    commit(
        d,
        "f.txt",
        &BASE.replace("two", "TWO").replace("six", "SIX (main)"),
        "main edits",
    );
    let (ok, _) = git_status(d, &["merge", "feature"]);
    assert!(!ok, "the merge should stop with a conflict");
    t
}

fn joined(lines: &[String]) -> String {
    lines.concat()
}

/// The text with ours or theirs taken for every change.
fn take(segments: &[MergeSegment], ours: bool) -> String {
    segments
        .iter()
        .map(|s| match s {
            MergeSegment::Same { lines } => joined(lines),
            MergeSegment::Change {
                ours: o, theirs: t, ..
            } => joined(if ours { o } else { t }),
        })
        .collect()
}

fn unmerged(d: &Path) -> String {
    git(d, &["ls-files", "-u"])
}

#[test]
fn a_merge_conflict_is_split_into_changes_and_conflicts() {
    let t = merge_conflict();
    let d = t.path();
    let file = load(&s(d), "f.txt").unwrap();
    assert_eq!(file.conflict, ConflictKind::BothModified);
    assert!(file.base_exists && file.unmergeable.is_none());
    assert_eq!(file.ours.label, "main");
    assert_eq!(file.ours.role, "Current branch");
    assert_eq!(file.theirs.label, "feature");
    assert_eq!(
        file.theirs.commit.as_ref().map(|c| c.summary.as_str()),
        Some("feature edits")
    );

    let segments = file.segments.unwrap();
    let changes: Vec<(ChangeSide, String, String)> = segments
        .iter()
        .filter_map(|s| match s {
            MergeSegment::Change {
                change,
                ours,
                theirs,
                ..
            } => Some((*change, joined(ours), joined(theirs))),
            MergeSegment::Same { .. } => None,
        })
        .collect();
    assert_eq!(
        changes,
        vec![
            (ChangeSide::Ours, "TWO\n".into(), "two\n".into()),
            (
                ChangeSide::Conflict,
                "SIX (main)\n".into(),
                "SIX (feature)\n".into()
            ),
            (ChangeSide::Theirs, "nine\n".into(), "NINE\n".into()),
        ]
    );
    // Each side can be rebuilt exactly from the segments.
    assert_eq!(take(&segments, true), git(d, &["show", ":2:f.txt"]) + "\n");
    assert_eq!(take(&segments, false), git(d, &["show", ":3:f.txt"]) + "\n");
}

#[test]
fn saving_the_result_resolves_the_file_and_the_merge_can_be_committed() {
    let t = merge_conflict();
    let d = t.path();
    let file = load(&s(d), "f.txt").unwrap();
    let result = BASE
        .replace("two", "TWO")
        .replace("six", "SIX (both)")
        .replace("nine", "NINE");
    resolve_with_text(&s(d), "f.txt", &result, &file.fingerprint).unwrap();
    assert_eq!(fs::read_to_string(d.join("f.txt")).unwrap(), result);
    assert_eq!(unmerged(d), "");
    assert_eq!(git(d, &["show", ":f.txt"]) + "\n", result);

    assert_eq!(
        inspect(&s(d)).unwrap().operation,
        Some(RepoOperation::Merge)
    );
    step(&s(d), Step::Continue).unwrap();
    assert_eq!(inspect(&s(d)).unwrap().operation, None);
    assert_eq!(fs::read_to_string(d.join("f.txt")).unwrap(), result);

    // Not conflicted any more.
    assert_eq!(load(&s(d), "f.txt").unwrap_err().kind(), "unsupported");
}

#[test]
fn a_file_changed_after_opening_is_not_overwritten() {
    let t = merge_conflict();
    let d = t.path();
    let file = load(&s(d), "f.txt").unwrap();
    write(d, "f.txt", b"edited elsewhere\n");
    let err = resolve_with_text(&s(d), "f.txt", "mine\n", &file.fingerprint).unwrap_err();
    assert_eq!(err.kind(), "unsupported");
    assert!(err.to_string().contains("changed after"), "{err}");
    assert_eq!(
        fs::read_to_string(d.join("f.txt")).unwrap(),
        "edited elsewhere\n"
    );
    let err = resolve_with_side(&s(d), "f.txt", ResolveSide::Ours, &file.fingerprint).unwrap_err();
    assert_eq!(err.kind(), "unsupported");

    // Opening it again gives a fresh fingerprint.
    let again = load(&s(d), "f.txt").unwrap();
    resolve_with_text(&s(d), "f.txt", "mine\n", &again.fingerprint).unwrap();
    assert_eq!(unmerged(d), "");
}

#[test]
fn whole_file_choices_keep_one_side() {
    for (side, expected) in [
        (ResolveSide::Ours, "SIX (main)"),
        (ResolveSide::Theirs, "SIX (feature)"),
    ] {
        let t = merge_conflict();
        let d = t.path();
        let file = load(&s(d), "f.txt").unwrap();
        resolve_with_side(&s(d), "f.txt", side, &file.fingerprint).unwrap();
        assert!(fs::read_to_string(d.join("f.txt"))
            .unwrap()
            .contains(expected));
        assert_eq!(unmerged(d), "");
    }
}

#[test]
fn a_file_deleted_on_one_side_offers_keep_or_delete() {
    let t = repo();
    let d = t.path();
    commit(d, "f.txt", BASE, "base");
    git(d, &["switch", "-q", "-c", "feature"]);
    git(d, &["rm", "-q", "f.txt"]);
    git(d, &["commit", "-q", "-m", "remove"]);
    git(d, &["switch", "-q", "main"]);
    commit(d, "f.txt", &BASE.replace("one", "ONE"), "edit");
    assert!(!git_status(d, &["merge", "feature"]).0);

    let file = load(&s(d), "f.txt").unwrap();
    assert_eq!(file.conflict, ConflictKind::DeletedByThem);
    assert!(file.ours.exists && !file.theirs.exists);
    assert!(file.segments.is_none());
    assert!(
        file.unmergeable.as_deref().unwrap().contains("deleted"),
        "{:?}",
        file.unmergeable
    );

    // Their side deleted it: keeping theirs deletes the file.
    resolve_with_side(&s(d), "f.txt", ResolveSide::Theirs, &file.fingerprint).unwrap();
    assert!(!d.join("f.txt").exists());
    assert_eq!(unmerged(d), "");
    assert_eq!(git(d, &["status", "--porcelain"]), "D  f.txt");
}

#[test]
fn binary_files_and_files_added_on_both_sides() {
    let t = repo();
    let d = t.path();
    commit(d, "base.txt", "x\n", "base");
    git(d, &["switch", "-q", "-c", "feature"]);
    write(d, "img.bin", b"\x00\x01feature");
    commit(d, "new.txt", "from feature\nshared\n", "feature adds");
    git(d, &["switch", "-q", "main"]);
    write(d, "img.bin", b"\x00\x01main");
    commit(d, "new.txt", "from main\nshared\n", "main adds");
    assert!(!git_status(d, &["merge", "feature"]).0);

    let bin = load(&s(d), "img.bin").unwrap();
    assert_eq!(bin.unmergeable.as_deref(), Some("This is a binary file."));
    resolve_with_side(&s(d), "img.bin", ResolveSide::Theirs, &bin.fingerprint).unwrap();
    assert_eq!(fs::read(d.join("img.bin")).unwrap(), b"\x00\x01feature");

    let added = load(&s(d), "new.txt").unwrap();
    assert_eq!(added.conflict, ConflictKind::BothAdded);
    assert!(!added.base_exists);
    let segments = added.segments.unwrap();
    assert_eq!(take(&segments, true), "from main\nshared\n");
    assert_eq!(take(&segments, false), "from feature\nshared\n");
    assert!(segments.iter().any(|s| matches!(
        s,
        MergeSegment::Change {
            change: ChangeSide::Conflict,
            ..
        }
    )));
}

#[test]
fn line_endings_and_a_missing_final_newline_are_kept() {
    let t = repo();
    let d = t.path();
    commit(d, "w.txt", "a\r\nb\r\nc", "base");
    git(d, &["switch", "-q", "-c", "feature"]);
    commit(d, "w.txt", "a\r\nB feature\r\nc", "feature");
    git(d, &["switch", "-q", "main"]);
    commit(d, "w.txt", "a\r\nB main\r\nc", "main");
    assert!(!git_status(d, &["merge", "feature"]).0);

    let file = load(&s(d), "w.txt").unwrap();
    let segments = file.segments.unwrap();
    assert_eq!(take(&segments, true), "a\r\nB main\r\nc");
    assert_eq!(
        segments.last(),
        Some(&MergeSegment::Same {
            lines: vec!["c".into()]
        })
    );
    resolve_with_text(&s(d), "w.txt", "a\r\nB both\r\nc", &file.fingerprint).unwrap();
    assert_eq!(fs::read(d.join("w.txt")).unwrap(), b"a\r\nB both\r\nc");
}

#[test]
fn rebase_cherry_pick_and_stash_sides_are_named() {
    // Rebase: ours is the branch rebased onto, theirs the commit being replayed.
    let t = merge_conflict();
    let d = t.path();
    git(d, &["merge", "--abort"]);
    git(d, &["switch", "-q", "feature"]);
    assert!(!git_status(d, &["rebase", "main"]).0);
    let file = load(&s(d), "f.txt").unwrap();
    assert_eq!(file.ours.label, "main");
    assert_eq!(file.ours.role, "Rebasing onto");
    assert_eq!(file.theirs.label, "feature");
    assert_eq!(
        file.theirs.commit.as_ref().map(|c| c.summary.as_str()),
        Some("feature edits")
    );
    git(d, &["rebase", "--abort"]);

    // Cherry-pick.
    git(d, &["switch", "-q", "main"]);
    assert!(!git_status(d, &["cherry-pick", "feature"]).0);
    let file = load(&s(d), "f.txt").unwrap();
    assert_eq!(file.ours.label, "main");
    assert!(
        file.theirs.label.starts_with("commit "),
        "{}",
        file.theirs.label
    );
    assert_eq!(file.theirs.role, "Commit being cherry-picked");
    git(d, &["cherry-pick", "--abort"]);

    // Stash: theirs are the stashed changes.
    write(d, "f.txt", BASE.replace("two", "stashed").as_bytes());
    git(d, &["stash", "-q"]);
    commit(d, "f.txt", &BASE.replace("two", "committed"), "conflicting");
    assert!(!git_status(d, &["stash", "pop"]).0);
    let file = load(&s(d), "f.txt").unwrap();
    assert_eq!(file.ours.label, "main");
    assert_eq!(file.theirs.label, "Stashed changes");
}

#[test]
fn paths_are_validated() {
    let t = merge_conflict();
    let d = t.path();
    for bad in ["../f.txt", ".git/config", "/etc/passwd", ""] {
        assert_eq!(load(&s(d), bad).unwrap_err().kind(), "invalidPath", "{bad}");
        assert_eq!(
            resolve_with_text(&s(d), bad, "x", "0").unwrap_err().kind(),
            "invalidPath",
            "{bad}"
        );
    }
    assert_eq!(
        load(&s(d), "missing.txt").unwrap_err().kind(),
        "unsupported"
    );
    assert_eq!(
        resolve_with_side(&s(d), "missing.txt", ResolveSide::Ours, "0")
            .unwrap_err()
            .kind(),
        "unsupported"
    );
}
