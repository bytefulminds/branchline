//! Worktrees: list, add, remove, lock and prune against real repositories.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use branchline_lib::git::branches::{
    delete_branch, list_branches_with_worktrees, switch_branch, StartPoint,
};
use branchline_lib::git::repository::{inspect, HeadState};
use branchline_lib::git::worktrees::{add, list, prune, remove, set_locked, WorktreeTarget};
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

fn s(p: &Path) -> String {
    p.to_str().unwrap().to_string()
}

/// A temporary folder holding `repo/` (main, plus branch `feature`) and room for worktrees.
struct Fixture {
    _dir: TempDir,
    base: PathBuf,
    repo: PathBuf,
}

impl Fixture {
    fn new() -> Self {
        let dir = TempDir::new().unwrap();
        let base = fs::canonicalize(dir.path()).unwrap();
        let repo = base.join("repo");
        fs::create_dir(&repo).unwrap();
        git(&repo, &["init", "-q", "-b", "main"]);
        git(&repo, &["config", "user.name", "T"]);
        git(&repo, &["config", "user.email", "t@example.com"]);
        fs::write(repo.join("a.txt"), "a\n").unwrap();
        git(&repo, &["add", "-A"]);
        git(&repo, &["commit", "-q", "-m", "base"]);
        git(&repo, &["branch", "feature"]);
        Fixture {
            _dir: dir,
            base,
            repo,
        }
    }
    fn r(&self) -> String {
        s(&self.repo)
    }
    fn at(&self, name: &str) -> String {
        s(&self.base.join(name))
    }
}

fn new_branch(name: &str) -> WorktreeTarget {
    WorktreeTarget::NewBranch {
        name: name.into(),
        start: StartPoint::Head,
    }
}

#[test]
fn adds_and_lists_worktrees() {
    let f = Fixture::new();
    let only = list(&f.r()).unwrap();
    assert_eq!(only.len(), 1);
    assert!(only[0].is_main && only[0].is_current);
    assert_eq!(only[0].branch.as_deref(), Some("main"));

    let created = add(&f.r(), &f.at("repo-fix"), &new_branch("fix/login")).unwrap();
    assert_eq!(created, f.at("repo-fix"));
    add(
        &f.r(),
        &f.at("repo feature"),
        &WorktreeTarget::Branch {
            name: "feature".into(),
        },
    )
    .unwrap();
    let head = git(&f.repo, &["rev-parse", "HEAD"]);
    add(
        &f.r(),
        &f.at("repo-detached"),
        &WorktreeTarget::Detached {
            start: StartPoint::Commit { oid: head.clone() },
        },
    )
    .unwrap();
    fs::write(f.base.join("repo-fix").join("new.txt"), "x").unwrap();

    let all = list(&f.r()).unwrap();
    assert_eq!(all.len(), 4);
    let by = |name: &str| all.iter().find(|w| w.name == name).unwrap();
    assert_eq!(by("repo-fix").branch.as_deref(), Some("fix/login"));
    assert_eq!(by("repo-fix").changes, Some(1));
    assert!(!by("repo-fix").is_current && !by("repo-fix").is_main);
    assert_eq!(by("repo feature").branch.as_deref(), Some("feature"));
    assert!(by("repo-detached").detached);
    assert_eq!(by("repo-detached").head.as_deref(), Some(head.as_str()));
    assert_eq!(by("repo").changes, Some(0));

    // Branches in other worktrees say where.
    let branches = list_branches_with_worktrees(&f.repo).unwrap();
    let feature = branches.local.iter().find(|b| b.name == "feature").unwrap();
    assert_eq!(
        feature.worktree_path.as_deref(),
        Some(f.at("repo feature").as_str())
    );
    let main = branches.local.iter().find(|b| b.name == "main").unwrap();
    assert_eq!(main.worktree_path, None, "main is checked out here");
}

#[test]
fn a_branch_checked_out_elsewhere_names_that_worktree() {
    let f = Fixture::new();
    let target = WorktreeTarget::Branch {
        name: "feature".into(),
    };
    add(&f.r(), &f.at("wt1"), &target).unwrap();

    let err = add(&f.r(), &f.at("wt2"), &target).unwrap_err();
    assert_eq!(err.kind(), "branchInWorktree");
    assert_eq!(err.detail(), Some(f.at("wt1").as_str()));
    assert!(!f.base.join("wt2").exists());

    let err = switch_branch(&f.r(), "feature").unwrap_err();
    assert_eq!(err.kind(), "branchInWorktree", "{err:?}");
    assert!(err.to_string().contains("feature"), "{err}");
    let err = delete_branch(&f.r(), "feature", true).unwrap_err();
    assert_eq!(err.kind(), "branchInWorktree", "{err:?}");
}

#[test]
fn new_worktree_folders_are_checked() {
    let f = Fixture::new();
    fs::create_dir(f.base.join("full")).unwrap();
    fs::write(f.base.join("full").join("x"), "x").unwrap();
    fs::create_dir(f.base.join("empty")).unwrap();
    let bad = [
        String::new(),
        "relative/path".into(),
        f.at("missing-parent/wt"),
        f.at("full"),
        f.at("repo/inside"),
        format!("{}/../escape", f.at("repo")),
    ];
    for path in &bad {
        let err = add(&f.r(), path, &new_branch("x")).unwrap_err();
        assert_eq!(err.kind(), "invalidPath", "{path}: {err:?}");
    }
    // An empty folder is fine.
    add(&f.r(), &f.at("empty"), &new_branch("x")).unwrap();

    for name in ["-x", "bad name", "a..b", "x"] {
        let err = add(&f.r(), &f.at("wt-b"), &new_branch(name)).unwrap_err();
        assert_eq!(err.kind(), "invalidBranchName", "{name}");
    }
    let err = add(
        &f.r(),
        &f.at("wt-c"),
        &WorktreeTarget::Branch {
            name: "nope".into(),
        },
    )
    .unwrap_err();
    assert_eq!(err.kind(), "unsupported");
}

#[test]
fn removing_keeps_the_branch_and_protects_changes() {
    let f = Fixture::new();
    add(&f.r(), &f.at("wt"), &new_branch("topic")).unwrap();
    fs::write(f.base.join("wt").join("work.txt"), "unsaved").unwrap();

    let err = remove(&f.r(), &f.at("wt"), false).unwrap_err();
    assert_eq!(err.kind(), "worktreeDirty");
    assert!(f.base.join("wt").join("work.txt").exists());

    remove(&f.r(), &f.at("wt"), true).unwrap();
    assert!(!f.base.join("wt").exists());
    assert_eq!(list(&f.r()).unwrap().len(), 1);
    assert_eq!(git(&f.repo, &["branch", "--list", "topic"]), "topic");

    // The main worktree, and the one that is open, are never removed.
    assert_eq!(
        remove(&f.r(), &f.r(), true).unwrap_err().kind(),
        "unsupported"
    );
    add(&f.r(), &f.at("wt2"), &new_branch("other")).unwrap();
    assert_eq!(
        remove(&f.at("wt2"), &f.at("wt2"), true).unwrap_err().kind(),
        "unsupported"
    );
    // Unknown folders are not touched.
    assert_eq!(
        remove(&f.r(), &f.at("nope"), true).unwrap_err().kind(),
        "stale"
    );
}

#[test]
fn locked_and_missing_worktrees() {
    let f = Fixture::new();
    add(&f.r(), &f.at("usb"), &new_branch("usb")).unwrap();
    set_locked(&f.r(), &f.at("usb"), true, "on a USB drive").unwrap();
    let w = list(&f.r())
        .unwrap()
        .into_iter()
        .find(|w| w.name == "usb")
        .unwrap();
    assert_eq!(w.locked.as_deref(), Some("on a USB drive"));
    let err = remove(&f.r(), &f.at("usb"), true).unwrap_err();
    assert!(err.to_string().contains("locked"), "{err}");
    set_locked(&f.r(), &f.at("usb"), false, "").unwrap();

    // Delete the folder behind Git's back: the worktree becomes stale.
    add(&f.r(), &f.at("gone1"), &new_branch("gone1")).unwrap();
    add(&f.r(), &f.at("gone2"), &new_branch("gone2")).unwrap();
    fs::remove_dir_all(f.base.join("gone1")).unwrap();
    fs::remove_dir_all(f.base.join("gone2")).unwrap();
    let all = list(&f.r()).unwrap();
    let gone = all.iter().find(|w| w.name == "gone1").unwrap();
    assert_eq!(gone.changes, None);
    remove(&f.r(), &f.at("gone1"), false).unwrap();
    assert_eq!(prune(&f.r()).unwrap(), 0, "removing gone1 pruned both");
    assert_eq!(list(&f.r()).unwrap().len(), 2);
}

#[test]
fn a_linked_worktree_opens_like_a_repository() {
    let f = Fixture::new();
    add(&f.r(), &f.at("linked"), &new_branch("linked")).unwrap();
    let info = inspect(&f.at("linked")).unwrap();
    assert!(matches!(info.head, HeadState::Branch { ref name, .. } if name == "linked"));
    let from_linked = list(&f.at("linked")).unwrap();
    assert_eq!(from_linked.len(), 2);
    assert!(from_linked[0].is_main && !from_linked[0].is_current);
    assert!(from_linked[1].is_current);
}
