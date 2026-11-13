//! Branch management against real repositories.

use std::fs;
use std::path::Path;
use std::process::Command;

use branchline_lib::git::branches::{
    checkout_detached, checkout_remote_branch, create_branch, delete_branch, delete_gone_branches,
    gone_branches, list_branches, rename_branch, switch_branch, validate_branch_name, StartPoint,
};
use branchline_lib::git::repository::{inspect, HeadState};
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
    commit(d, "a.txt", "a\n", "first");
    t
}

fn commit(d: &Path, name: &str, content: &str, msg: &str) -> String {
    fs::write(d.join(name), content).unwrap();
    git(d, &["add", "-A"]);
    git(d, &["commit", "-q", "-m", msg]);
    git(d, &["rev-parse", "HEAD"])
}

fn s(p: &Path) -> String {
    p.to_str().unwrap().to_string()
}

fn head_name(d: &Path) -> String {
    match inspect(&s(d)).unwrap().head {
        HeadState::Branch { name, .. } => name,
        other => format!("{other:?}"),
    }
}

#[test]
fn create_switch_rename_delete() {
    let r = repo();
    let d = r.path();
    create_branch(&s(d), "feature/login", &StartPoint::Head, false).unwrap();
    assert_eq!(head_name(d), "main", "create without checkout stays");
    create_branch(&s(d), "work", &StartPoint::Head, true).unwrap();
    assert_eq!(head_name(d), "work");

    switch_branch(&s(d), "feature/login").unwrap();
    assert_eq!(head_name(d), "feature/login");

    rename_branch(&s(d), "feature/login", "feature/sign-in").unwrap();
    assert_eq!(head_name(d), "feature/sign-in");

    let list = list_branches(d).unwrap();
    let names: Vec<_> = list.local.iter().map(|b| b.name.as_str()).collect();
    assert_eq!(names, vec!["feature/sign-in", "main", "work"]);
    assert!(list.local[0].is_current);
    assert_eq!(list.local[1].tip_summary, "first");

    // The current branch cannot be deleted.
    assert_eq!(
        delete_branch(&s(d), "feature/sign-in", false)
            .unwrap_err()
            .kind(),
        "unsupported"
    );
    delete_branch(&s(d), "work", false).unwrap();
    assert!(!list_branches(d)
        .unwrap()
        .local
        .iter()
        .any(|b| b.name == "work"));
}

#[test]
fn unmerged_branches_need_force() {
    let r = repo();
    let d = r.path();
    create_branch(&s(d), "experiment", &StartPoint::Head, true).unwrap();
    commit(d, "b.txt", "b\n", "unmerged work");
    switch_branch(&s(d), "main").unwrap();
    let err = delete_branch(&s(d), "experiment", false).unwrap_err();
    assert_eq!(err.kind(), "notMerged");
    assert!(list_branches(d)
        .unwrap()
        .local
        .iter()
        .any(|b| b.name == "experiment"));
    delete_branch(&s(d), "experiment", true).unwrap();
    assert!(!list_branches(d)
        .unwrap()
        .local
        .iter()
        .any(|b| b.name == "experiment"));
}

#[test]
fn validates_names() {
    let r = repo();
    let d = r.path();
    for bad in [
        "", " x", "a b", "-x", "--force", "HEAD", "a..b", "x.lock", "@{-1}", "a:b", "x/",
    ] {
        let err = validate_branch_name(d, bad).unwrap_err();
        assert_eq!(err.kind(), "invalidBranchName", "{bad:?}");
    }
    for good in ["feature/x", "fix-123", "ünïcode", "release/2.0"] {
        validate_branch_name(d, good).unwrap();
    }
    create_branch(&s(d), "dup", &StartPoint::Head, false).unwrap();
    assert_eq!(
        create_branch(&s(d), "dup", &StartPoint::Head, false)
            .unwrap_err()
            .kind(),
        "invalidBranchName"
    );
    assert_eq!(
        rename_branch(&s(d), "dup", "main").unwrap_err().kind(),
        "invalidBranchName"
    );
}

#[test]
fn branch_from_commit_and_detached_checkout() {
    let r = repo();
    let d = r.path();
    let first = git(d, &["rev-parse", "HEAD"]);
    commit(d, "a.txt", "changed\n", "second");
    create_branch(
        &s(d),
        "from-first",
        &StartPoint::Commit { oid: first.clone() },
        false,
    )
    .unwrap();
    let list = list_branches(d).unwrap();
    assert_eq!(
        list.local
            .iter()
            .find(|b| b.name == "from-first")
            .unwrap()
            .oid,
        first
    );

    checkout_detached(&s(d), &first[..8]).unwrap();
    assert!(matches!(
        inspect(&s(d)).unwrap().head,
        HeadState::Detached { .. }
    ));
    assert_eq!(
        checkout_detached(&s(d), "--orphan").unwrap_err().kind(),
        "invalidPath"
    );
}

#[test]
fn branch_name_equal_to_a_file_name() {
    let r = repo();
    let d = r.path();
    // A file and a branch both called "docs".
    commit(d, "docs", "file\n", "add docs file");
    create_branch(&s(d), "docs", &StartPoint::Head, false).unwrap();
    switch_branch(&s(d), "docs").unwrap();
    assert_eq!(head_name(d), "docs");
    assert_eq!(fs::read_to_string(d.join("docs")).unwrap(), "file\n");
}

#[test]
fn switching_with_conflicting_changes_is_refused_safely() {
    let r = repo();
    let d = r.path();
    create_branch(&s(d), "other", &StartPoint::Head, true).unwrap();
    commit(d, "a.txt", "other version\n", "change on other");
    switch_branch(&s(d), "main").unwrap();
    fs::write(d.join("a.txt"), "my unsaved edit\n").unwrap();
    let err = switch_branch(&s(d), "other").unwrap_err();
    assert_eq!(err.kind(), "checkoutConflict", "{err:?}");
    match err {
        branchline_lib::error::GitError::CheckoutConflict { files, .. } => {
            assert_eq!(files, vec!["a.txt"])
        }
        _ => unreachable!(),
    }
    assert_eq!(head_name(d), "main");
    assert_eq!(
        fs::read_to_string(d.join("a.txt")).unwrap(),
        "my unsaved edit\n"
    );
}

#[test]
fn checks_out_remote_branches_with_tracking() {
    let remote = TempDir::new().unwrap();
    git(remote.path(), &["init", "-q", "--bare", "-b", "main"]);
    let r = repo();
    let d = r.path();
    git(d, &["remote", "add", "origin", &s(remote.path())]);
    create_branch(&s(d), "shared", &StartPoint::Head, true).unwrap();
    commit(d, "s.txt", "s\n", "shared work");
    git(d, &["push", "-q", "origin", "main", "shared"]);
    switch_branch(&s(d), "main").unwrap();
    delete_branch(&s(d), "shared", true).unwrap();
    git(d, &["fetch", "-q", "origin"]);

    let list = list_branches(d).unwrap();
    assert!(list.remote.iter().any(|b| b.name == "origin/shared"));
    let local = checkout_remote_branch(&s(d), "origin/shared").unwrap();
    assert_eq!(local, "shared");
    assert_eq!(head_name(d), "shared");
    let shared = list_branches(d)
        .unwrap()
        .local
        .into_iter()
        .find(|b| b.name == "shared")
        .unwrap();
    assert_eq!(shared.upstream.as_deref(), Some("origin/shared"));
    assert_eq!((shared.ahead, shared.behind), (0, 0));

    // Checking it out again just switches.
    switch_branch(&s(d), "main").unwrap();
    checkout_remote_branch(&s(d), "origin/shared").unwrap();
    assert_eq!(head_name(d), "shared");

    // A remote branch as start point.
    create_branch(
        &s(d),
        "from-remote",
        &StartPoint::Branch {
            name: "origin/main".into(),
        },
        false,
    )
    .unwrap();
    assert_eq!(
        create_branch(
            &s(d),
            "nope",
            &StartPoint::Branch {
                name: "origin/missing".into()
            },
            false
        )
        .unwrap_err()
        .kind(),
        "unsupported"
    );
}

#[test]
fn cleans_up_branches_whose_upstream_was_deleted_and_that_lose_nothing() {
    let t = repo();
    let d = t.path();
    let server = TempDir::new().unwrap();
    git(server.path(), &["init", "-q", "--bare", "-b", "main"]);
    git(d, &["remote", "add", "origin", &s(server.path())]);
    git(d, &["push", "-q", "-u", "origin", "main"]);

    // merged: published, merged into main on the server, then deleted there.
    git(d, &["switch", "-q", "-c", "merged"]);
    commit(d, "m.txt", "m\n", "merged work");
    git(d, &["push", "-q", "-u", "origin", "merged"]);
    git(d, &["switch", "-q", "main"]);
    git(
        d,
        &["merge", "-q", "--no-ff", "-m", "Merge merged", "merged"],
    );
    git(d, &["push", "-q", "origin", "main"]);
    // extra: published, then a commit that only exists here; deleted on the server.
    git(d, &["switch", "-q", "-c", "extra"]);
    commit(d, "e.txt", "e\n", "extra work");
    git(d, &["push", "-q", "-u", "origin", "extra"]);
    commit(d, "e.txt", "e2\n", "not pushed");
    // still: published and still on the server.
    git(d, &["switch", "-q", "-c", "still", "main"]);
    git(d, &["push", "-q", "-u", "origin", "still"]);
    // local: never published.
    git(d, &["switch", "-q", "-c", "local", "main"]);
    commit(d, "l.txt", "l\n", "local work");
    // current: published, deleted on the server, and checked out.
    git(d, &["switch", "-q", "-c", "current", "main"]);
    git(d, &["push", "-q", "-u", "origin", "current"]);
    for b in ["merged", "extra", "current"] {
        git(server.path(), &["branch", "-D", b]);
    }
    git(d, &["fetch", "-q", "--prune", "origin"]);

    let repo = s(d);
    let gone = gone_branches(&repo).unwrap();
    let names: Vec<_> = gone.iter().map(|b| b.name.as_str()).collect();
    assert_eq!(
        names,
        ["current", "extra", "merged"],
        "never published and still there are left out"
    );
    let by = |n: &str| gone.iter().find(|b| b.name == n).unwrap().clone();
    assert!(by("merged").removable());
    assert_eq!(by("merged").upstream, "origin/merged");
    // Deleted on the server without being merged: both its commits now exist only here.
    assert_eq!(by("extra").local_only, 2);
    assert!(!by("extra").removable());
    assert!(by("current").in_use);

    // Only what loses nothing is deleted, whatever is asked.
    let all: Vec<String> = ["merged", "extra", "current", "local", "still"]
        .iter()
        .map(|n| n.to_string())
        .collect();
    let deleted = delete_gone_branches(&repo, &all).unwrap();
    assert_eq!(deleted.len(), 1);
    assert_eq!(deleted[0].name, "merged");
    let left: Vec<_> = list_branches(d)
        .unwrap()
        .local
        .into_iter()
        .map(|b| b.name)
        .collect();
    assert!(!left.contains(&"merged".to_string()));
    for kept in ["extra", "current", "local", "still", "main"] {
        assert!(left.contains(&kept.to_string()), "{kept} is kept");
    }

    // Undo: the branch comes back on the same commit.
    create_branch(
        &repo,
        "merged",
        &StartPoint::Commit {
            oid: deleted[0].oid.clone(),
        },
        false,
    )
    .unwrap();
    assert_eq!(git(d, &["rev-parse", "merged"]), deleted[0].oid);
}
