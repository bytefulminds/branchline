//! Stash save, apply, pop and drop against real repositories.

use std::fs;
use std::path::Path;
use std::process::Command;

use branchline_lib::git::repository::inspect;
use branchline_lib::git::stash::{apply, drop, list_stashes, save};
use tempfile::TempDir;

fn git(dir: &Path, args: &[&str]) -> String {
    let out = Command::new("git")
        .args(args)
        .current_dir(dir)
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

fn repo() -> TempDir {
    let t = TempDir::new().unwrap();
    let d = t.path();
    git(d, &["init", "-q", "-b", "main"]);
    git(d, &["config", "user.name", "T"]);
    git(d, &["config", "user.email", "t@example.com"]);
    git(d, &["config", "commit.gpgsign", "false"]);
    fs::write(d.join("a.txt"), "one\ntwo\nthree\n").unwrap();
    fs::write(d.join("b.txt"), "b\n").unwrap();
    git(d, &["add", "-A"]);
    git(d, &["commit", "-q", "-m", "first"]);
    t
}

fn s(p: &Path) -> String {
    p.to_str().unwrap().to_string()
}

fn status(d: &Path) -> String {
    git(d, &["status", "--porcelain"])
}

#[test]
fn save_apply_pop_and_drop_round_trip() {
    let t = repo();
    let d = t.path();
    fs::write(d.join("a.txt"), "one\nTWO\nthree\n").unwrap();
    git(d, &["add", "a.txt"]);
    fs::write(d.join("b.txt"), "b changed\n").unwrap();
    fs::write(d.join("new.txt"), "untracked\n").unwrap();
    let before = status(d);
    assert_eq!(before, "M  a.txt\n M b.txt\n?? new.txt");

    save(&s(d), "my work", true).unwrap();
    assert_eq!(status(d), "", "everything was stashed, untracked files too");
    let list = list_stashes(&s(d)).unwrap();
    assert_eq!(list.len(), 1);
    assert_eq!(list[0].message, "my work");
    assert_eq!(list[0].branch.as_deref(), Some("main"));
    assert!(!list[0].auto_message);
    assert!(list[0].untracked_oid.is_some());
    assert_eq!(inspect(&s(d)).unwrap().stash_count, 1);

    // Apply restores staged and unstaged changes separately and keeps the stash.
    let outcome = apply(&s(d), 0, &list[0].oid, false).unwrap();
    assert!(!outcome.conflicts);
    assert_eq!(status(d), before);
    assert_eq!(list_stashes(&s(d)).unwrap().len(), 1);

    git(d, &["reset", "-q", "--hard"]);
    git(d, &["clean", "-q", "-fd"]);
    apply(&s(d), 0, &list[0].oid, true).unwrap();
    assert_eq!(status(d), before);
    assert!(
        list_stashes(&s(d)).unwrap().is_empty(),
        "pop removes the stash"
    );

    save(&s(d), "", true).unwrap();
    let auto = &list_stashes(&s(d)).unwrap()[0];
    assert!(auto.auto_message, "Git generated the message");
    drop(&s(d), 0, &auto.oid).unwrap();
    assert!(list_stashes(&s(d)).unwrap().is_empty());
    assert_eq!(inspect(&s(d)).unwrap().stash_count, 0);
}

#[test]
fn untracked_files_stay_unless_included_and_empty_saves_are_refused() {
    let t = repo();
    let d = t.path();
    fs::write(d.join("new.txt"), "untracked\n").unwrap();
    let err = save(&s(d), "x", false).unwrap_err();
    assert_eq!(err.kind(), "unsupported");

    fs::write(d.join("a.txt"), "changed\n").unwrap();
    save(&s(d), "tracked only", false).unwrap();
    assert_eq!(status(d), "?? new.txt");
    assert!(list_stashes(&s(d)).unwrap()[0].untracked_oid.is_none());

    git(d, &["clean", "-q", "-fd"]);
    assert_eq!(save(&s(d), "", true).unwrap_err().kind(), "unsupported");
}

#[test]
fn messages_are_never_read_as_options() {
    let t = repo();
    let d = t.path();
    fs::write(d.join("a.txt"), "changed\n").unwrap();
    save(&s(d), "--include-untracked -p", true).unwrap();
    assert_eq!(
        list_stashes(&s(d)).unwrap()[0].message,
        "--include-untracked -p"
    );
}

#[test]
fn a_shifted_index_is_refused_instead_of_touching_another_stash() {
    let t = repo();
    let d = t.path();
    fs::write(d.join("a.txt"), "first change\n").unwrap();
    save(&s(d), "older", true).unwrap();
    fs::write(d.join("a.txt"), "second change\n").unwrap();
    save(&s(d), "newer", true).unwrap();
    let list = list_stashes(&s(d)).unwrap();
    assert_eq!(list[0].message, "newer");
    let older = list[1].clone();

    // The UI still thinks "older" is at index 0 (for example after a stash from a terminal).
    assert_eq!(drop(&s(d), 0, &older.oid).unwrap_err().kind(), "stale");
    assert_eq!(
        apply(&s(d), 0, &older.oid, true).unwrap_err().kind(),
        "stale"
    );
    assert_eq!(list_stashes(&s(d)).unwrap().len(), 2, "nothing was dropped");
    assert_eq!(drop(&s(d), 7, &older.oid).unwrap_err().kind(), "stale");
    assert!(drop(&s(d), 1, "not-an-oid").is_err());

    drop(&s(d), 1, &older.oid).unwrap();
    let left = list_stashes(&s(d)).unwrap();
    assert_eq!(left.len(), 1);
    assert_eq!(left[0].message, "newer");
}

#[test]
fn pop_with_conflicts_keeps_the_stash() {
    let t = repo();
    let d = t.path();
    fs::write(d.join("a.txt"), "one\nSTASHED\nthree\n").unwrap();
    save(&s(d), "conflicting", true).unwrap();
    fs::write(d.join("a.txt"), "one\nCOMMITTED\nthree\n").unwrap();
    git(d, &["commit", "-qam", "change the same line"]);

    let oid = list_stashes(&s(d)).unwrap()[0].oid.clone();
    let outcome = apply(&s(d), 0, &oid, true).unwrap();
    assert!(outcome.conflicts);
    assert!(outcome.kept);
    assert_eq!(list_stashes(&s(d)).unwrap().len(), 1, "the stash is kept");
    let info = inspect(&s(d)).unwrap();
    assert!(info.changes.iter().any(|c| c.conflict.is_some()));
}

#[test]
fn local_changes_in_the_way_are_reported_and_kept() {
    let t = repo();
    let d = t.path();
    fs::write(d.join("a.txt"), "one\nSTASHED\nthree\n").unwrap();
    fs::write(d.join("new.txt"), "stashed new file\n").unwrap();
    save(&s(d), "work", true).unwrap();
    let oid = list_stashes(&s(d)).unwrap()[0].oid.clone();

    fs::write(d.join("a.txt"), "one\nLOCAL\nthree\n").unwrap();
    let err = apply(&s(d), 0, &oid, true).unwrap_err();
    assert_eq!(err.kind(), "checkoutConflict", "{err:?}");
    assert_eq!(
        fs::read_to_string(d.join("a.txt")).unwrap(),
        "one\nLOCAL\nthree\n"
    );

    // An untracked file in the stash that now exists again.
    git(d, &["checkout", "-q", "--", "a.txt"]);
    fs::write(d.join("new.txt"), "a different new file\n").unwrap();
    let err = apply(&s(d), 0, &oid, false).unwrap_err();
    assert_eq!(err.kind(), "checkoutConflict", "{err:?}");
    assert_eq!(
        fs::read_to_string(d.join("new.txt")).unwrap(),
        "a different new file\n"
    );
    assert_eq!(list_stashes(&s(d)).unwrap().len(), 1);
}

#[test]
fn files_with_conflicts_cannot_be_stashed() {
    let t = repo();
    let d = t.path();
    git(d, &["switch", "-q", "-c", "other"]);
    fs::write(d.join("a.txt"), "one\nOTHER\nthree\n").unwrap();
    git(d, &["commit", "-qam", "other"]);
    git(d, &["switch", "-q", "main"]);
    fs::write(d.join("a.txt"), "one\nMAIN\nthree\n").unwrap();
    git(d, &["commit", "-qam", "main"]);
    let _ = Command::new("git")
        .args(["merge", "-q", "other"])
        .current_dir(d)
        .output();
    let err = save(&s(d), "", true).unwrap_err();
    assert_eq!(err.kind(), "unsupported", "{err:?}");
}
