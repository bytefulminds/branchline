//! Integration tests against real, temporary Git repositories.

use std::fs;
use std::path::Path;
use std::process::Command;

use branchline_lib::git::repository::{inspect, HeadState, RepoOperation};
use branchline_lib::git::runner::git_version;
use branchline_lib::git::status::{ChangeKind, ConflictKind};
use tempfile::TempDir;

/// Run git for test setup with an isolated identity and config.
fn git(dir: &Path, args: &[&str]) -> String {
    let out = Command::new("git")
        .args(args)
        .current_dir(dir)
        .env("GIT_AUTHOR_NAME", "Test Author")
        .env("GIT_AUTHOR_EMAIL", "author@example.com")
        .env("GIT_COMMITTER_NAME", "Test Author")
        .env("GIT_COMMITTER_EMAIL", "author@example.com")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env(
            "GIT_CONFIG_GLOBAL",
            if cfg!(windows) { "NUL" } else { "/dev/null" },
        )
        .output()
        .expect("git runs");
    assert!(
        out.status.success(),
        "git {:?} failed: {}",
        args,
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

fn init_repo() -> TempDir {
    let tmp = TempDir::new().unwrap();
    git(tmp.path(), &["init", "-q", "-b", "main"]);
    git(tmp.path(), &["config", "commit.gpgsign", "false"]);
    tmp
}

fn commit_file(dir: &Path, name: &str, content: &str, msg: &str) {
    let p = dir.join(name);
    if let Some(parent) = p.parent() {
        fs::create_dir_all(parent).unwrap();
    }
    fs::write(p, content).unwrap();
    git(dir, &["add", "--", name]);
    git(dir, &["commit", "-q", "-m", msg]);
}

fn path_str(p: &Path) -> String {
    p.to_str().unwrap().to_string()
}

fn find<'a>(
    info: &'a branchline_lib::git::repository::RepositoryInfo,
    path: &str,
) -> &'a branchline_lib::git::status::FileChange {
    info.changes
        .iter()
        .find(|c| c.path == path)
        .unwrap_or_else(|| panic!("{path} not in {:?}", info.changes))
}

#[test]
fn reports_git_version() {
    let v = git_version().expect("git is installed");
    assert!(v.major >= 2);
}

#[test]
fn empty_repository_is_unborn() {
    let repo = init_repo();
    let info = inspect(&path_str(repo.path())).unwrap();
    assert_eq!(
        info.head,
        HeadState::Unborn {
            name: "main".into()
        }
    );
    assert!(info.head_commit.is_none());
    assert!(info.changes.is_empty());
    assert!(info.upstream.is_none());
    assert_eq!(info.operation, None);
}

#[test]
fn clean_repository_with_commit() {
    let repo = init_repo();
    commit_file(repo.path(), "README.md", "hello\n", "Initial commit");
    let info = inspect(&path_str(repo.path())).unwrap();
    match &info.head {
        HeadState::Branch { name, oid } => {
            assert_eq!(name, "main");
            assert_eq!(oid.len(), 40);
        }
        other => panic!("unexpected head {other:?}"),
    }
    let commit = info.head_commit.as_ref().unwrap();
    assert_eq!(commit.summary, "Initial commit");
    assert_eq!(commit.author_name, "Test Author");
    assert!(info.changes.is_empty());
    assert_eq!(info.total_changes, 0);
    assert!(!info.truncated);
}

#[test]
fn dirty_staged_untracked_and_deleted() {
    let repo = init_repo();
    let d = repo.path();
    commit_file(d, "a.txt", "a\n", "add a");
    commit_file(d, "b.txt", "b\n", "add b");
    commit_file(d, "c.txt", "c\n", "add c");

    fs::write(d.join("a.txt"), "a changed\n").unwrap(); // unstaged modification
    fs::write(d.join("b.txt"), "b staged\n").unwrap();
    git(d, &["add", "b.txt"]); // staged modification
    fs::remove_file(d.join("c.txt")).unwrap(); // unstaged deletion
    fs::write(d.join("new.txt"), "new\n").unwrap();
    git(d, &["add", "new.txt"]);
    fs::write(d.join("new.txt"), "new and changed\n").unwrap(); // staged add + unstaged modify
    fs::create_dir_all(d.join("nested/deeper")).unwrap();
    fs::write(d.join("nested/deeper/untracked.txt"), "?\n").unwrap();

    let info = inspect(&path_str(d)).unwrap();
    assert_eq!(info.changes.len(), 5);

    let a = find(&info, "a.txt");
    assert_eq!(
        (a.index_status, a.worktree_status),
        (None, Some(ChangeKind::Modified))
    );
    let b = find(&info, "b.txt");
    assert_eq!(
        (b.index_status, b.worktree_status),
        (Some(ChangeKind::Modified), None)
    );
    let c = find(&info, "c.txt");
    assert_eq!(c.worktree_status, Some(ChangeKind::Deleted));
    let n = find(&info, "new.txt");
    assert_eq!(
        (n.index_status, n.worktree_status),
        (Some(ChangeKind::Added), Some(ChangeKind::Modified))
    );
    // --untracked-files=all lists individual files inside new directories.
    let u = find(&info, "nested/deeper/untracked.txt");
    assert_eq!(u.worktree_status, Some(ChangeKind::Untracked));
}

#[test]
fn staged_rename_reports_original_path() {
    let repo = init_repo();
    let d = repo.path();
    commit_file(
        d,
        "old name.txt",
        "same content for rename detection\n",
        "add",
    );
    git(d, &["mv", "old name.txt", "new name.txt"]);
    let info = inspect(&path_str(d)).unwrap();
    let r = find(&info, "new name.txt");
    assert_eq!(r.index_status, Some(ChangeKind::Renamed));
    assert_eq!(r.original_path.as_deref(), Some("old name.txt"));
}

#[test]
fn unusual_filenames_are_preserved() {
    let repo = init_repo();
    let d = repo.path();
    commit_file(d, "base.txt", "x\n", "base");
    let names = [
        "with space.txt",
        "quote\"d.txt",
        "ünïcødé ✓.txt",
        "-leading-dash.txt",
        "semi;colon&amp.txt",
    ];
    for n in names {
        fs::write(d.join(n), "x\n").unwrap();
    }
    #[cfg(unix)]
    fs::write(d.join("tab\there.txt"), "x\n").unwrap();

    let info = inspect(&path_str(d)).unwrap();
    for n in names {
        assert_eq!(find(&info, n).worktree_status, Some(ChangeKind::Untracked));
    }
    #[cfg(unix)]
    assert!(info.changes.iter().any(|c| c.path == "tab\there.txt"));
}

#[test]
fn detached_head() {
    let repo = init_repo();
    let d = repo.path();
    commit_file(d, "a.txt", "1\n", "one");
    commit_file(d, "a.txt", "2\n", "two");
    let first = git(d, &["rev-parse", "HEAD~1"]);
    git(d, &["checkout", "-q", "--detach", &first]);
    let info = inspect(&path_str(d)).unwrap();
    assert_eq!(info.head, HeadState::Detached { oid: first });
    assert_eq!(info.head_commit.unwrap().summary, "one");
}

#[test]
fn subdirectory_resolves_to_repository_root() {
    let repo = init_repo();
    let d = repo.path();
    commit_file(d, "src/lib/mod.rs", "\n", "add");
    let info = inspect(&path_str(&d.join("src/lib"))).unwrap();
    let expected = fs::canonicalize(d).unwrap();
    assert_eq!(
        fs::canonicalize(&info.path).unwrap(),
        expected,
        "path should be the repository root"
    );
    assert_eq!(info.name, expected.file_name().unwrap().to_string_lossy());
}

#[test]
fn upstream_ahead_and_behind() {
    let remote = TempDir::new().unwrap();
    git(remote.path(), &["init", "-q", "--bare", "-b", "main"]);
    let repo = init_repo();
    let d = repo.path();
    commit_file(d, "a.txt", "1\n", "one");
    git(d, &["remote", "add", "origin", &path_str(remote.path())]);
    git(d, &["push", "-q", "-u", "origin", "main"]);

    // A second clone pushes a commit, making us behind after fetch.
    let other = TempDir::new().unwrap();
    git(
        other.path(),
        &["clone", "-q", &path_str(remote.path()), "."],
    );
    git(other.path(), &["config", "commit.gpgsign", "false"]);
    commit_file(other.path(), "b.txt", "b\n", "remote change");
    git(other.path(), &["push", "-q", "origin", "main"]);

    commit_file(d, "c.txt", "c\n", "local 1");
    commit_file(d, "d.txt", "d\n", "local 2");
    git(d, &["fetch", "-q", "origin"]);

    let info = inspect(&path_str(d)).unwrap();
    let up = info.upstream.unwrap();
    assert_eq!(up.name, "origin/main");
    assert_eq!((up.ahead, up.behind, up.gone), (2, 1, false));
}

#[test]
fn gone_upstream_is_reported() {
    let repo = init_repo();
    let d = repo.path();
    commit_file(d, "a.txt", "1\n", "one");
    git(d, &["config", "branch.main.remote", "origin"]);
    git(d, &["config", "branch.main.merge", "refs/heads/main"]);
    git(d, &["remote", "add", "origin", "/nonexistent/remote"]);
    let info = inspect(&path_str(d)).unwrap();
    let up = info.upstream.unwrap();
    assert!(up.gone);
}

#[test]
fn merge_conflict_is_detected() {
    let repo = init_repo();
    let d = repo.path();
    commit_file(d, "conflict.txt", "base\n", "base");
    git(d, &["checkout", "-q", "-b", "feature"]);
    commit_file(d, "conflict.txt", "feature\n", "feature change");
    git(d, &["checkout", "-q", "main"]);
    commit_file(d, "conflict.txt", "main\n", "main change");
    // The merge is expected to fail with a conflict.
    let status = Command::new("git")
        .args(["merge", "feature"])
        .current_dir(d)
        .env(
            "GIT_CONFIG_GLOBAL",
            if cfg!(windows) { "NUL" } else { "/dev/null" },
        )
        .env("GIT_COMMITTER_NAME", "T")
        .env("GIT_COMMITTER_EMAIL", "t@example.com")
        .env("GIT_AUTHOR_NAME", "T")
        .env("GIT_AUTHOR_EMAIL", "t@example.com")
        .output()
        .unwrap();
    assert!(!status.status.success());

    let info = inspect(&path_str(d)).unwrap();
    assert_eq!(info.operation, Some(RepoOperation::Merge));
    let c = find(&info, "conflict.txt");
    assert_eq!(c.conflict, Some(ConflictKind::BothModified));
}

#[test]
fn non_git_directory_is_rejected() {
    let tmp = TempDir::new().unwrap();
    // Make sure no parent of the temp dir is a repository for this assertion.
    let err = inspect(&path_str(tmp.path())).unwrap_err();
    assert!(
        matches!(err.kind(), "notARepository"),
        "unexpected error: {err:?}"
    );
}

#[test]
fn invalid_paths_are_rejected() {
    assert_eq!(inspect("").unwrap_err().kind(), "emptyPath");
    assert_eq!(inspect("   ").unwrap_err().kind(), "emptyPath");
    assert_eq!(inspect("relative/path").unwrap_err().kind(), "relativePath");

    let tmp = TempDir::new().unwrap();
    let missing = tmp.path().join("does-not-exist");
    assert_eq!(
        inspect(&path_str(&missing)).unwrap_err().kind(),
        "pathNotFound"
    );

    let file = tmp.path().join("file.txt");
    fs::write(&file, "x").unwrap();
    assert_eq!(
        inspect(&path_str(&file)).unwrap_err().kind(),
        "notADirectory"
    );
}

#[test]
fn bare_repository_is_rejected() {
    let tmp = TempDir::new().unwrap();
    git(tmp.path(), &["init", "-q", "--bare"]);
    assert_eq!(
        inspect(&path_str(tmp.path())).unwrap_err().kind(),
        "bareRepository"
    );
}

#[test]
fn git_directory_is_rejected() {
    let repo = init_repo();
    let err = inspect(&path_str(&repo.path().join(".git"))).unwrap_err();
    assert!(
        matches!(err.kind(), "insideGitDir" | "bareRepository"),
        "unexpected error: {err:?}"
    );
}

#[test]
fn repository_fsmonitor_hook_is_not_executed() {
    // A malicious repository could configure core.fsmonitor to run a program
    // during `git status`. Branchline overrides it, so the marker must not appear.
    let repo = init_repo();
    let d = repo.path();
    commit_file(d, "a.txt", "1\n", "one");
    let marker = d.join("pwned");
    #[cfg(unix)]
    {
        let script = d.join("hook.sh");
        fs::write(
            &script,
            format!("#!/bin/sh\ntouch '{}'\n", marker.display()),
        )
        .unwrap();
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&script, fs::Permissions::from_mode(0o755)).unwrap();
        git(d, &["config", "core.fsmonitor", &path_str(&script)]);
    }
    let _ = inspect(&path_str(d)).unwrap();
    assert!(!marker.exists(), "fsmonitor hook was executed");
}

#[test]
fn serializes_to_camel_case_contract() {
    let repo = init_repo();
    commit_file(repo.path(), "a.txt", "1\n", "one");
    fs::write(repo.path().join("a.txt"), "2\n").unwrap();
    let info = inspect(&path_str(repo.path())).unwrap();
    let json = serde_json::to_value(&info).unwrap();
    assert_eq!(json["head"]["kind"], "branch");
    assert_eq!(json["head"]["name"], "main");
    assert!(json["headCommit"]["shortOid"].is_string());
    assert!(json["gitDir"].is_string());
    assert_eq!(json["changes"][0]["worktreeStatus"], "modified");
    assert!(json["changes"][0]["indexStatus"].is_null());
    assert_eq!(json["totalChanges"], 1);
}
