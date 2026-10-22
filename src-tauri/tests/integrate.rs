//! Merge, rebase, cherry-pick and revert, with continue, skip and abort.

use std::fs;
use std::path::Path;
use std::process::Command;

use branchline_lib::git::branches::StartPoint;
use branchline_lib::git::integrate::{
    cherry_pick, cherry_pick_many, merge, rebase, revert, step, MergeRequest, Step, MAX_PICK,
};
use branchline_lib::git::repository::{inspect, RepoOperation};
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

fn write(d: &Path, name: &str, content: &str) {
    fs::write(d.join(name), content).unwrap();
}

fn commit(d: &Path, name: &str, content: &str, msg: &str) -> String {
    write(d, name, content);
    git(d, &["add", "-A"]);
    git(d, &["commit", "-q", "-m", msg]);
    git(d, &["rev-parse", "HEAD"])
}

fn s(p: &Path) -> String {
    p.to_str().unwrap().to_string()
}

/// main: base. feature (from base): adds feature.txt. main then adds main.txt.
fn repo() -> TempDir {
    let t = TempDir::new().unwrap();
    let d = t.path();
    git(d, &["init", "-q", "-b", "main"]);
    git(d, &["config", "user.name", "T"]);
    git(d, &["config", "user.email", "t@example.com"]);
    git(d, &["config", "commit.gpgsign", "false"]);
    commit(d, "a.txt", "one\ntwo\nthree\n", "base");
    git(d, &["switch", "-q", "-c", "feature"]);
    commit(d, "feature.txt", "feature\n", "feature work");
    git(d, &["switch", "-q", "main"]);
    t
}

fn branch(name: &str) -> StartPoint {
    StartPoint::Branch { name: name.into() }
}

fn merge_req(name: &str) -> MergeRequest {
    MergeRequest {
        source: branch(name),
        no_ff: false,
        autostash: false,
    }
}

fn parents(d: &Path) -> usize {
    git(d, &["rev-list", "--parents", "-n1", "HEAD"])
        .split(' ')
        .count()
        - 1
}

fn operation(d: &Path) -> Option<RepoOperation> {
    inspect(&s(d)).unwrap().operation
}

/// Make main and feature edit the same line of a.txt.
fn conflicting(d: &Path) {
    git(d, &["switch", "-q", "feature"]);
    commit(d, "a.txt", "one\nFEATURE\nthree\n", "feature edits a");
    git(d, &["switch", "-q", "main"]);
    commit(d, "a.txt", "one\nMAIN\nthree\n", "main edits a");
}

#[test]
fn merge_fast_forwards_or_creates_a_merge_commit() {
    let t = repo();
    let d = t.path();
    let out = merge(&s(d), &merge_req("feature")).unwrap();
    assert!(out.fast_forward && !out.conflicts);
    assert_eq!(
        git(d, &["rev-parse", "HEAD"]),
        git(d, &["rev-parse", "feature"])
    );

    let again = merge(&s(d), &merge_req("feature")).unwrap();
    assert!(again.up_to_date);

    git(d, &["reset", "-q", "--hard", "HEAD~1"]);
    let out = merge(
        &s(d),
        &MergeRequest {
            no_ff: true,
            ..merge_req("feature")
        },
    )
    .unwrap();
    assert!(!out.fast_forward);
    assert_eq!(parents(d), 2, "--no-ff always makes a merge commit");
}

#[test]
fn merge_conflicts_can_be_aborted_or_continued() {
    let t = repo();
    let d = t.path();
    conflicting(d);
    let before = git(d, &["rev-parse", "HEAD"]);

    let out = merge(&s(d), &merge_req("feature")).unwrap();
    assert!(out.conflicts);
    assert_eq!(operation(d), Some(RepoOperation::Merge));
    // Another operation cannot start meanwhile.
    assert_eq!(
        merge(&s(d), &merge_req("feature")).unwrap_err().kind(),
        "unsupported"
    );
    // Continue is refused while conflicts remain.
    assert_eq!(
        step(&s(d), Step::Continue).unwrap_err().kind(),
        "unsupported"
    );

    step(&s(d), Step::Abort).unwrap();
    assert_eq!(operation(d), None);
    assert_eq!(git(d, &["rev-parse", "HEAD"]), before);
    assert_eq!(git(d, &["status", "--porcelain"]), "");

    merge(&s(d), &merge_req("feature")).unwrap();
    write(d, "a.txt", "one\nBOTH\nthree\n");
    git(d, &["add", "a.txt"]);
    step(&s(d), Step::Continue).unwrap();
    assert_eq!(operation(d), None);
    assert_eq!(parents(d), 2);
    assert_eq!(
        git(d, &["log", "-1", "--format=%B"]),
        "Merge branch 'feature'",
        "Git's usual message, without its conflict comments"
    );
}

#[test]
fn an_ambiguous_branch_name_is_merged_by_its_full_ref() {
    let t = repo();
    let d = t.path();
    // A tag with the same name as the branch, on a different commit.
    git(d, &["tag", "feature", "main"]);
    merge(&s(d), &merge_req("feature")).unwrap();
    assert!(
        d.join("feature.txt").exists(),
        "the branch was merged, not the tag"
    );
}

#[test]
fn local_changes_in_the_way_block_until_stashed() {
    let t = repo();
    let d = t.path();
    git(d, &["switch", "-q", "feature"]);
    commit(
        d,
        "a.txt",
        "one\ntwo\nthree\nfour\n",
        "feature appends to a",
    );
    git(d, &["switch", "-q", "main"]);
    write(d, "a.txt", "ONE\ntwo\nthree\n");

    let err = merge(&s(d), &merge_req("feature")).unwrap_err();
    assert_eq!(err.kind(), "checkoutConflict", "{err:?}");
    let err = rebase(&s(d), &branch("feature"), false).unwrap_err();
    assert_eq!(err.kind(), "checkoutConflict", "{err:?}");
    assert_eq!(
        fs::read_to_string(d.join("a.txt")).unwrap(),
        "ONE\ntwo\nthree\n"
    );

    let out = merge(
        &s(d),
        &MergeRequest {
            autostash: true,
            ..merge_req("feature")
        },
    )
    .unwrap();
    assert!(!out.conflicts);
    assert_eq!(
        fs::read_to_string(d.join("a.txt")).unwrap(),
        "ONE\ntwo\nthree\nfour\n"
    );
}

#[test]
fn staged_changes_in_the_way_are_reported_too() {
    let t = repo();
    let d = t.path();
    git(d, &["switch", "-q", "feature"]);
    commit(
        d,
        "a.txt",
        "one\ntwo\nthree\nfour\n",
        "feature appends to a",
    );
    git(d, &["switch", "-q", "main"]);
    commit(d, "main.txt", "m\n", "main work");
    // Staged, not just modified: Git's merge strategy refuses with exit status 2.
    write(d, "a.txt", "ONE\ntwo\nthree\n");
    git(d, &["add", "a.txt"]);
    let err = merge(&s(d), &merge_req("feature")).unwrap_err();
    assert_eq!(err.kind(), "checkoutConflict", "{err:?}");
    assert_eq!(git(d, &["status", "--porcelain"]), "M  a.txt");

    merge(
        &s(d),
        &MergeRequest {
            autostash: true,
            ..merge_req("feature")
        },
    )
    .unwrap();
    assert_eq!(parents(d), 2);
    assert_eq!(
        fs::read_to_string(d.join("a.txt")).unwrap(),
        "ONE\ntwo\nthree\nfour\n"
    );
}

#[test]
fn rebase_reports_progress_and_can_continue_skip_or_abort() {
    let t = repo();
    let d = t.path();
    git(d, &["switch", "-q", "feature"]);
    commit(d, "a.txt", "one\nFEATURE\nthree\n", "feature edits a");
    commit(d, "b.txt", "b\n", "feature adds b");
    git(d, &["switch", "-q", "main"]);
    commit(d, "a.txt", "one\nMAIN\nthree\n", "main edits a");
    git(d, &["switch", "-q", "feature"]);
    let original = git(d, &["rev-parse", "HEAD"]);

    let out = rebase(&s(d), &branch("main"), false).unwrap();
    assert!(out.conflicts);
    let info = inspect(&s(d)).unwrap();
    assert_eq!(info.operation, Some(RepoOperation::Rebase));
    let progress = info.operation_progress.expect("progress");
    assert_eq!(progress.total, 3);
    assert_eq!(progress.branch.as_deref(), Some("feature"));

    step(&s(d), Step::Abort).unwrap();
    assert_eq!(git(d, &["rev-parse", "HEAD"]), original);
    assert_eq!(git(d, &["branch", "--show-current"]), "feature");

    // Resolve and continue: the editor must not open (the test would hang).
    rebase(&s(d), &branch("main"), false).unwrap();
    write(d, "a.txt", "one\nBOTH\nthree\n");
    git(d, &["add", "a.txt"]);
    let out = step(&s(d), Step::Continue).unwrap();
    assert!(!out.conflicts);
    assert_eq!(operation(d), None);
    assert_eq!(git(d, &["branch", "--show-current"]), "feature");
    assert_eq!(git(d, &["rev-list", "--merges", "--count", "HEAD"]), "0");
    assert_eq!(
        git(d, &["merge-base", "HEAD", "main"]),
        git(d, &["rev-parse", "main"])
    );

    // Skip drops the conflicting commit.
    git(d, &["reset", "-q", "--hard", &original]);
    rebase(&s(d), &branch("main"), false).unwrap();
    step(&s(d), Step::Skip).unwrap();
    assert_eq!(operation(d), None);
    assert_eq!(
        fs::read_to_string(d.join("a.txt")).unwrap(),
        "one\nMAIN\nthree\n"
    );
    assert!(d.join("b.txt").exists());
}

#[test]
fn a_step_without_changes_left_is_dropped_or_skipped() {
    // Rebase: Git drops a commit whose changes are already on the new base.
    let t = repo();
    let d = t.path();
    conflicting(d);
    git(d, &["switch", "-q", "feature"]);
    rebase(&s(d), &branch("main"), false).unwrap();
    write(d, "a.txt", "one\nMAIN\nthree\n");
    git(d, &["add", "a.txt"]);
    step(&s(d), Step::Continue).unwrap();
    assert_eq!(operation(d), None);
    assert_eq!(
        git(d, &["rev-list", "--count", "main..HEAD"]),
        "1",
        "only feature.txt's commit remains"
    );

    // Cherry-pick: Git stops instead, and Branchline suggests Skip.
    let t = repo();
    let d = t.path();
    conflicting(d);
    let picked = git(d, &["rev-parse", "feature"]);
    cherry_pick(&s(d), &picked).unwrap();
    write(d, "a.txt", "one\nMAIN\nthree\n");
    git(d, &["add", "a.txt"]);
    let err = step(&s(d), Step::Continue).unwrap_err();
    assert_eq!(err.kind(), "unsupported", "{err:?}");
    assert!(err.to_string().contains("Skip"), "{err}");
    step(&s(d), Step::Skip).unwrap();
    assert_eq!(operation(d), None);
}

#[test]
fn cherry_pick_and_revert() {
    let t = repo();
    let d = t.path();
    let picked = git(d, &["rev-parse", "feature"]);
    cherry_pick(&s(d), &picked).unwrap();
    assert!(d.join("feature.txt").exists());
    assert_eq!(git(d, &["log", "-1", "--format=%s"]), "feature work");

    // Picking it again changes nothing and leaves no operation behind.
    let again = cherry_pick(&s(d), &picked).unwrap();
    assert!(again.up_to_date, "{again:?}");
    assert_eq!(operation(d), None);

    let head = git(d, &["rev-parse", "HEAD"]);
    revert(&s(d), &head).unwrap();
    assert!(!d.join("feature.txt").exists());
    assert!(git(d, &["log", "-1", "--format=%s"]).starts_with("Revert \"feature work\""));
}

#[test]
fn cherry_pick_conflicts_continue_with_the_original_message() {
    let t = repo();
    let d = t.path();
    conflicting(d);
    let picked = git(d, &["rev-parse", "feature"]);
    let out = cherry_pick(&s(d), &picked).unwrap();
    assert!(out.conflicts);
    assert_eq!(operation(d), Some(RepoOperation::CherryPick));
    write(d, "a.txt", "one\nBOTH\nthree\n");
    git(d, &["add", "a.txt"]);
    step(&s(d), Step::Continue).unwrap();
    assert_eq!(operation(d), None);
    assert_eq!(git(d, &["log", "-1", "--format=%s"]), "feature edits a");
}

#[test]
fn merge_commits_are_picked_and_reverted_against_their_first_parent() {
    let t = repo();
    let d = t.path();
    commit(d, "main.txt", "m\n", "main work");
    merge(
        &s(d),
        &MergeRequest {
            no_ff: true,
            ..merge_req("feature")
        },
    )
    .unwrap();
    let merge_commit = git(d, &["rev-parse", "HEAD"]);
    revert(&s(d), &merge_commit).unwrap();
    assert!(
        !d.join("feature.txt").exists(),
        "the merged-in changes are undone"
    );
    assert!(d.join("main.txt").exists());

    git(d, &["switch", "-q", "-c", "other", "HEAD~2"]);
    cherry_pick(&s(d), &merge_commit).unwrap();
    assert!(d.join("feature.txt").exists());
}

#[test]
fn inputs_are_validated() {
    let t = repo();
    let d = t.path();
    for name in ["nope", "--abort", "main~1"] {
        assert_eq!(
            merge(&s(d), &merge_req(name)).unwrap_err().kind(),
            "unsupported",
            "{name}"
        );
    }
    for oid in ["HEAD", "--abort", "main"] {
        assert!(cherry_pick(&s(d), oid).is_err(), "{oid}");
        assert!(revert(&s(d), oid).is_err(), "{oid}");
    }
    assert_eq!(step(&s(d), Step::Continue).unwrap_err().kind(), "stale");
    git(d, &["switch", "-q", "--detach", "HEAD"]);
    assert_eq!(
        rebase(&s(d), &branch("feature"), false).unwrap_err().kind(),
        "unsupported"
    );
}

/// Three commits on feature after `feature work`: f1, f2, f3 (oldest first).
fn three_on_feature(d: &Path) -> Vec<String> {
    git(d, &["switch", "-q", "feature"]);
    let ids = (1..=3)
        .map(|i| commit(d, &format!("f{i}.txt"), "x\n", &format!("f{i}")))
        .collect();
    git(d, &["switch", "-q", "main"]);
    ids
}

#[test]
fn several_commits_are_picked_in_the_order_given() {
    let t = repo();
    let d = t.path();
    let ids = three_on_feature(d);
    // Oldest first, but leave f2 out and pick f3 before f1 to check the order is kept.
    let out = cherry_pick_many(&s(d), &[ids[2].clone(), ids[0].clone()]).unwrap();
    assert!(
        !out.conflicts && !out.up_to_date && out.skipped == 0,
        "{out:?}"
    );
    assert_eq!(git(d, &["log", "-2", "--format=%s"]), "f1\nf3");
    assert!(!d.join("f2.txt").exists());
    assert_eq!(operation(d), None);
}

#[test]
fn commits_already_on_the_branch_are_skipped() {
    let t = repo();
    let d = t.path();
    let ids = three_on_feature(d);
    cherry_pick(&s(d), &ids[1]).unwrap();
    let before = git(d, &["rev-list", "--count", "HEAD"]);

    let out = cherry_pick_many(&s(d), &ids).unwrap();
    assert_eq!(out.skipped, 1, "{out:?}");
    assert!(!out.up_to_date);
    assert_eq!(operation(d), None);
    assert_eq!(git(d, &["log", "-3", "--format=%s"]), "f3\nf1\nf2");
    let after: usize = git(d, &["rev-list", "--count", "HEAD"]).parse().unwrap();
    assert_eq!(after, before.parse::<usize>().unwrap() + 2);

    // Everything is there now: nothing to do, nothing left in progress.
    let again = cherry_pick_many(&s(d), &ids).unwrap();
    assert!(again.up_to_date && again.skipped == 3, "{again:?}");
    assert_eq!(operation(d), None);
}

#[test]
fn a_conflict_stops_the_sequence_and_continue_picks_the_rest() {
    let t = repo();
    let d = t.path();
    conflicting(d);
    git(d, &["switch", "-q", "feature"]);
    commit(d, "after.txt", "after\n", "after the conflict");
    git(d, &["switch", "-q", "main"]);
    let ids: Vec<String> = git(d, &["rev-list", "--reverse", "main..feature"])
        .lines()
        .map(String::from)
        .collect();
    assert_eq!(ids.len(), 3);

    let out = cherry_pick_many(&s(d), &ids).unwrap();
    assert!(out.conflicts, "{out:?}");
    assert_eq!(operation(d), Some(RepoOperation::CherryPick));
    assert!(
        d.join("feature.txt").exists(),
        "the first commit was applied"
    );
    assert!(!d.join("after.txt").exists());

    write(d, "a.txt", "one\nBOTH\nthree\n");
    git(d, &["add", "a.txt"]);
    step(&s(d), Step::Continue).unwrap();
    assert_eq!(operation(d), None);
    assert!(
        d.join("after.txt").exists(),
        "the rest was applied after continuing"
    );
    assert_eq!(
        git(d, &["log", "-3", "--format=%s"]),
        "after the conflict\nfeature edits a\nfeature work"
    );
}

#[test]
fn several_commits_are_validated_before_anything_runs() {
    let t = repo();
    let d = t.path();
    let ids = three_on_feature(d);
    let head = git(d, &["rev-parse", "HEAD"]);
    let unsupported = |oids: Vec<String>| {
        let err = cherry_pick_many(&s(d), &oids).unwrap_err();
        assert_eq!(err.kind(), "unsupported", "{err:?}");
        err.to_string()
    };
    assert!(unsupported(vec![]).contains("Choose"));
    assert!(unsupported(vec![ids[0].clone(), ids[0].clone()]).contains("twice"));
    assert!(unsupported(vec![ids[0].clone(); MAX_PICK + 1]).contains("at most"));
    for bad in ["--abort", "HEAD", "main"] {
        assert!(
            cherry_pick_many(&s(d), &[ids[0].clone(), bad.into()]).is_err(),
            "{bad}"
        );
    }

    // A merge commit among several is refused; nothing is applied.
    commit(d, "main.txt", "m\n", "main work");
    git(d, &["merge", "-q", "--no-ff", "--no-edit", "feature"]);
    let merge_commit = git(d, &["rev-parse", "HEAD"]);
    git(d, &["switch", "-q", "-c", "other", &head]);
    assert!(unsupported(vec![ids[0].clone(), merge_commit]).contains("merge commit"));
    assert!(!d.join("f1.txt").exists());
    assert_eq!(operation(d), None);
}
