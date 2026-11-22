//! A pushed branch rewritten in Branchline needs a force push, pinned to the remote commit it
//! was rewritten from.

use std::fs;
use std::path::Path;
use std::process::Command;

use branchline_lib::git::integrate::{reset_to, ResetMode};
use branchline_lib::git::rebase_plan::{interactive_rebase, PlanAction, PlanStep};
use branchline_lib::git::remote::{fetch, push, PushRequest};
use branchline_lib::git::repository::inspect;
use branchline_lib::git::rewrite::bring_in_pushed;
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

fn setup_user(d: &Path) {
    git(d, &["config", "user.name", "T"]);
    git(d, &["config", "user.email", "t@example.com"]);
    git(d, &["config", "commit.gpgsign", "false"]);
}

fn commit(d: &Path, name: &str, msg: &str) -> String {
    fs::write(d.join(name), format!("{msg}\n")).unwrap();
    git(d, &["add", "-A"]);
    git(d, &["commit", "-q", "-m", msg]);
    git(d, &["rev-parse", "HEAD"])
}

fn s(p: &Path) -> String {
    p.to_str().unwrap().to_string()
}

fn push_req(force: bool, lease: Option<String>) -> PushRequest {
    PushRequest {
        branch: "main".into(),
        remote: None,
        set_upstream: false,
        force,
        follow_tags: false,
        lease,
    }
}

/// A clone with base, a, b pushed to origin; plus a second clone for a teammate.
fn setup() -> (TempDir, std::path::PathBuf, std::path::PathBuf) {
    let t = TempDir::new().unwrap();
    let remote = t.path().join("remote.git");
    let me = t.path().join("me");
    let mate = t.path().join("mate");
    git(
        t.path(),
        &[
            "init",
            "-q",
            "--bare",
            "-b",
            "main",
            remote.to_str().unwrap(),
        ],
    );
    git(
        t.path(),
        &[
            "clone",
            "-q",
            remote.to_str().unwrap(),
            me.to_str().unwrap(),
        ],
    );
    setup_user(&me);
    git(&me, &["switch", "-q", "-c", "main"]);
    commit(&me, "base.txt", "base");
    commit(&me, "a.txt", "a");
    commit(&me, "b.txt", "b");
    git(&me, &["push", "-q", "-u", "origin", "main"]);
    git(
        t.path(),
        &[
            "clone",
            "-q",
            remote.to_str().unwrap(),
            mate.to_str().unwrap(),
        ],
    );
    setup_user(&mate);
    (t, me, mate)
}

#[test]
fn a_reset_of_a_pushed_branch_asks_for_a_pinned_force_push() {
    let (_t, me, _mate) = setup();
    let remote_tip = git(&me, &["rev-parse", "HEAD"]);
    assert!(inspect(&s(&me)).unwrap().rewrite.is_none());

    let base = git(&me, &["rev-parse", "HEAD~2"]);
    reset_to(&s(&me), &base, ResetMode::Hard).unwrap();
    let info = inspect(&s(&me)).unwrap().rewrite.expect("rewritten");
    assert_eq!(info.lease, remote_tip);
    assert_eq!((info.replaced, info.pushed_since), (2, 0));

    // A plain push is refused; the pinned force push goes through and clears the record.
    assert!(push(&s(&me), &push_req(false, None), "p1", &mut |_| {}).is_err());
    push(
        &s(&me),
        &push_req(true, Some(info.lease)),
        "p2",
        &mut |_| {},
    )
    .unwrap();
    assert!(inspect(&s(&me)).unwrap().rewrite.is_none());
    assert_eq!(
        git(&me, &["ls-remote", "origin", "main"])
            .split_whitespace()
            .next(),
        Some(base.as_str())
    );
}

#[test]
fn a_push_after_the_rewrite_is_kept_even_when_it_was_fetched() {
    let (_t, me, mate) = setup();
    // Drop "a" from main.
    let base = git(&me, &["rev-parse", "HEAD~2"]);
    let a = git(&me, &["rev-parse", "HEAD~1"]);
    let b = git(&me, &["rev-parse", "HEAD"]);
    let plan = vec![
        PlanStep {
            oid: a,
            action: PlanAction::Drop,
            message: None,
        },
        PlanStep {
            oid: b,
            action: PlanAction::Pick,
            message: None,
        },
    ];
    interactive_rebase(&s(&me), &base, &plan, false).unwrap();
    let lease = inspect(&s(&me)).unwrap().rewrite.unwrap().lease;

    // Meanwhile a teammate pushes, and we fetch it.
    git(&mate, &["pull", "-q"]);
    commit(&mate, "c.txt", "c from mate");
    git(&mate, &["push", "-q"]);
    fetch(&s(&me), None, "f1", &mut |_| {}).unwrap();
    let info = inspect(&s(&me)).unwrap().rewrite.unwrap();
    assert_eq!((info.replaced, info.pushed_since), (2, 1));

    // A plain lease would pass now; the pinned one refuses.
    let err = push(&s(&me), &push_req(true, Some(lease)), "p1", &mut |_| {}).unwrap_err();
    assert_eq!(err.kind(), "staleLease", "{err}");

    // Bring their commit in, then force push with the new lease.
    bring_in_pushed(&s(&me)).unwrap();
    let info = inspect(&s(&me)).unwrap().rewrite.unwrap();
    assert_eq!(info.pushed_since, 0);
    push(
        &s(&me),
        &push_req(true, Some(info.lease)),
        "p2",
        &mut |_| {},
    )
    .unwrap();
    let files = git(&me, &["ls-tree", "--name-only", "origin/main"]);
    assert!(files.contains("c.txt"), "{files}");
    assert!(!files.contains("a.txt"), "{files}");
}

#[test]
fn nothing_is_recorded_when_the_remote_has_commits_the_branch_lacks() {
    let (_t, me, mate) = setup();
    git(&mate, &["pull", "-q"]);
    commit(&mate, "c.txt", "c from mate");
    git(&mate, &["push", "-q"]);
    fetch(&s(&me), None, "f1", &mut |_| {}).unwrap();
    // Behind the remote: rewriting does not offer to overwrite the teammate's commit.
    let base = git(&me, &["rev-parse", "HEAD~1"]);
    reset_to(&s(&me), &base, ResetMode::Soft).unwrap();
    assert!(inspect(&s(&me)).unwrap().rewrite.is_none());
}
