//! History, refs, commit details and committing against real repositories.

use std::fs;
use std::path::Path;
use std::process::Command;

use branchline_lib::git::commit::{commit, commit_draft, CommitRequest};
use branchline_lib::git::diff::{commit_diff, DiffOptions, LineKind};
use branchline_lib::git::log::{commit_details, list_refs, log_page, refs_fingerprint, RefKind};
use branchline_lib::git::repository::inspect;
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
    git(d, &["config", "user.name", "Tess Ter"]);
    git(d, &["config", "user.email", "tess@example.com"]);
    git(d, &["config", "commit.gpgsign", "false"]);
    git(d, &["config", "tag.gpgsign", "false"]);
    t
}

fn commit_file(d: &Path, name: &str, content: &str, msg: &str) -> String {
    let p = d.join(name);
    if let Some(parent) = p.parent() {
        fs::create_dir_all(parent).unwrap();
    }
    fs::write(p, content).unwrap();
    git(d, &["add", "-A"]);
    git(d, &["commit", "-q", "-m", msg]);
    git(d, &["rev-parse", "HEAD"])
}

fn s(p: &Path) -> String {
    p.to_str().unwrap().to_string()
}

fn req(message: &str, amend: bool) -> CommitRequest {
    CommitRequest {
        message: message.into(),
        amend,
    }
}

#[test]
fn pages_through_history_newest_first() {
    let r = repo();
    let d = r.path();
    for i in 0..25 {
        commit_file(d, "f.txt", &format!("{i}\n"), &format!("commit {i}"));
    }
    let p1 = log_page(d, 0, 10, None).unwrap();
    let p2 = log_page(d, 10, 10, None).unwrap();
    let p3 = log_page(d, 20, 10, None).unwrap();
    assert_eq!((p1.commits.len(), p1.has_more), (10, true));
    assert_eq!((p2.commits.len(), p2.has_more), (10, true));
    assert_eq!((p3.commits.len(), p3.has_more), (5, false));
    assert_eq!(p1.commits[0].summary, "commit 24");
    assert_eq!(p3.commits[4].summary, "commit 0");
    assert!(p3.commits[4].parents.is_empty());
    // Each commit's parent is the next one in the list.
    assert_eq!(p1.commits[0].parents, vec![p1.commits[1].oid.clone()]);
    assert_eq!(p1.commits[9].parents, vec![p2.commits[0].oid.clone()]);
    assert_eq!(p1.commits[0].author_name, "Tess Ter");
}

#[test]
fn includes_branches_merges_tags_and_remotes() {
    let r = repo();
    let d = r.path();
    commit_file(d, "a.txt", "a\n", "base");
    git(d, &["checkout", "-q", "-b", "feature"]);
    let feature = commit_file(d, "b.txt", "b\n", "feature work");
    git(d, &["checkout", "-q", "main"]);
    commit_file(d, "c.txt", "c\n", "main work");
    git(d, &["merge", "-q", "--no-edit", "--no-ff", "feature"]);
    git(d, &["checkout", "-q", "-b", "unmerged"]);
    let side = commit_file(d, "d.txt", "d\n", "not merged anywhere");
    git(d, &["checkout", "-q", "main"]);
    git(d, &["tag", "-a", "v1.0", "-m", "release", "HEAD"]);
    git(d, &["tag", "light", &feature]);

    let remote = TempDir::new().unwrap();
    git(remote.path(), &["init", "-q", "--bare", "-b", "main"]);
    git(d, &["remote", "add", "origin", &s(remote.path())]);
    git(d, &["push", "-q", "origin", "main"]);
    git(d, &["fetch", "-q", "origin"]);
    git(d, &["remote", "set-head", "origin", "main"]);

    let page = log_page(d, 0, 100, None).unwrap();
    assert_eq!(page.commits.len(), 5);
    let merge = page
        .commits
        .iter()
        .find(|c| c.parents.len() == 2)
        .expect("merge commit present");
    assert!(merge.summary.starts_with("Merge branch"));
    assert!(
        page.commits.iter().any(|c| c.oid == side),
        "unmerged branch commits are included"
    );
    // Children always come before their parents.
    for (i, c) in page.commits.iter().enumerate() {
        for p in &c.parents {
            let pi = page.commits.iter().position(|x| &x.oid == p).unwrap();
            assert!(pi > i, "{} listed before its child", p);
        }
    }

    let refs = list_refs(d).unwrap();
    let head = git(d, &["rev-parse", "HEAD"]);
    let find = |name: &str| refs.iter().find(|r| r.name == name).unwrap();
    assert_eq!(find("main").kind, RefKind::Branch);
    assert_eq!(find("origin/main").kind, RefKind::Remote);
    assert_eq!(find("v1.0").oid, head, "annotated tags are peeled");
    assert_eq!(find("light").oid, feature);
    assert!(!refs.iter().any(|r| r.name.ends_with("/HEAD")));
}

#[test]
fn empty_and_orphan_repositories() {
    let r = repo();
    let d = r.path();
    let page = log_page(d, 0, 50, None).unwrap();
    assert!(page.commits.is_empty());
    assert!(!page.has_more);

    commit_file(d, "a.txt", "a\n", "on main");
    git(d, &["checkout", "-q", "--orphan", "fresh"]);
    // HEAD is unborn, but main still has history.
    let page = log_page(d, 0, 50, None).unwrap();
    assert_eq!(page.commits.len(), 1);
}

#[test]
fn commit_details_lists_files_against_first_parent() {
    let r = repo();
    let d = r.path();
    let root = commit_file(d, "keep.txt", "1\n2\n3\n", "root");
    fs::write(d.join("old name.txt"), "rename me please, enough text\n").unwrap();
    fs::write(d.join("bye.txt"), "bye\n").unwrap();
    git(d, &["add", "-A"]);
    git(d, &["commit", "-q", "-m", "prepare"]);
    fs::write(d.join("keep.txt"), "1\ntwo\n3\n4\n").unwrap();
    git(d, &["mv", "old name.txt", "new name.txt"]);
    fs::remove_file(d.join("bye.txt")).unwrap();
    fs::write(d.join("img.bin"), [0u8, 1, 2, 0]).unwrap();
    git(d, &["add", "-A"]);
    git(
        d,
        &[
            "commit",
            "-q",
            "-m",
            "Big change\n\nWith a body.\n# not a comment",
        ],
    );
    let oid = git(d, &["rev-parse", "HEAD"]);

    let det = commit_details(d, &oid[..10]).unwrap();
    assert_eq!(det.oid, oid);
    assert_eq!(det.message, "Big change\n\nWith a body.\n# not a comment");
    assert_eq!(det.author_email, "tess@example.com");
    let file = |p: &str| det.files.iter().find(|f| f.path == p).unwrap();
    assert_eq!(file("keep.txt").status, "M");
    assert_eq!(
        (file("keep.txt").additions, file("keep.txt").deletions),
        (Some(2), Some(1))
    );
    assert_eq!(file("new name.txt").status, "R");
    assert_eq!(
        file("new name.txt").original_path.as_deref(),
        Some("old name.txt")
    );
    assert_eq!(file("bye.txt").status, "D");
    assert!(file("img.bin").binary);

    let root_det = commit_details(d, &root).unwrap();
    assert!(root_det.parents.is_empty());
    assert_eq!(root_det.files.len(), 1);
    assert_eq!(root_det.files[0].status, "A");

    let diff = commit_diff(d, &oid, "keep.txt", None, false, &DiffOptions::default()).unwrap();
    assert_eq!((diff.additions, diff.deletions), (2, 1));
    assert!(!diff.supports_partial);
    let root_diff =
        commit_diff(d, &root, "keep.txt", None, false, &DiffOptions::default()).unwrap();
    assert_eq!(root_diff.change.as_deref(), Some("new"));
    assert!(root_diff.hunks[0]
        .lines
        .iter()
        .all(|l| l.kind == LineKind::Add));
    let renamed = commit_diff(
        d,
        &oid,
        "new name.txt",
        Some("old name.txt"),
        false,
        &DiffOptions::default(),
    )
    .unwrap();
    assert_eq!(renamed.change.as_deref(), Some("renamed"));
}

#[test]
fn rejects_option_like_commit_ids() {
    let r = repo();
    let d = r.path();
    commit_file(d, "a", "a\n", "a");
    for bad in ["--output=/tmp/pwn", "HEAD", "main", "HEAD~1"] {
        assert_eq!(commit_details(d, bad).unwrap_err().kind(), "invalidPath");
        assert_eq!(
            commit_diff(d, bad, "a", None, false, &DiffOptions::default())
                .unwrap_err()
                .kind(),
            "invalidPath"
        );
    }
}

#[test]
fn commits_staged_changes_and_validates() {
    let r = repo();
    let d = r.path();
    // Nothing staged, no commits yet.
    assert_eq!(
        commit(&s(d), &req("x", false)).unwrap_err().kind(),
        "unsupported"
    );
    assert_eq!(
        commit(&s(d), &req("x", true)).unwrap_err().kind(),
        "unsupported",
        "nothing to amend"
    );
    let draft = commit_draft(&s(d)).unwrap();
    assert_eq!(draft.author.unwrap().email, "tess@example.com");
    assert!(!draft.can_amend);

    fs::write(d.join("a.txt"), "a\n").unwrap();
    git(d, &["add", "a.txt"]);
    assert_eq!(
        commit(&s(d), &req("   \n  ", false)).unwrap_err().kind(),
        "unsupported",
        "empty message"
    );
    let before = refs_fingerprint(d).unwrap();
    let oid = commit(
        &s(d),
        &req("First commit\r\n\r\n# kept literally\r\n", false),
    )
    .unwrap();
    assert_eq!(git(d, &["rev-parse", "HEAD"]), oid);
    assert_eq!(
        git(d, &["log", "-1", "--format=%B"]),
        "First commit\n\n# kept literally"
    );
    assert_ne!(refs_fingerprint(d).unwrap(), before);
    assert!(inspect(&s(d)).unwrap().changes.is_empty());

    // Amend changes the message (and may add staged changes) without adding a commit.
    fs::write(d.join("b.txt"), "b\n").unwrap();
    git(d, &["add", "b.txt"]);
    let draft = commit_draft(&s(d)).unwrap();
    assert_eq!(
        draft.head_message.as_deref(),
        Some("First commit\n\n# kept literally")
    );
    commit(&s(d), &req("First commit, amended", true)).unwrap();
    assert_eq!(git(d, &["rev-list", "--count", "HEAD"]), "1");
    assert_eq!(
        git(d, &["log", "-1", "--format=%s"]),
        "First commit, amended"
    );
    assert_eq!(
        git(d, &["show", "--format=", "--name-only", "HEAD"]),
        "a.txt\nb.txt"
    );
}

#[test]
fn merge_commit_uses_prepared_message_and_blocks_on_conflicts() {
    let r = repo();
    let d = r.path();
    commit_file(d, "c.txt", "base\n", "base");
    git(d, &["checkout", "-q", "-b", "other"]);
    commit_file(d, "c.txt", "other\n", "other");
    git(d, &["checkout", "-q", "main"]);
    commit_file(d, "c.txt", "main\n", "main");
    let _ = Command::new("git")
        .args(["merge", "other"])
        .current_dir(d)
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .output();

    let draft = commit_draft(&s(d)).unwrap();
    assert!(draft
        .prepared_message
        .as_deref()
        .unwrap()
        .starts_with("Merge branch 'other'"));
    assert!(!draft.prepared_message.unwrap().contains('#'));

    assert_eq!(
        commit(&s(d), &req("Merge", false)).unwrap_err().kind(),
        "unsupported",
        "conflicts must be resolved first"
    );
    fs::write(d.join("c.txt"), "resolved\n").unwrap();
    git(d, &["add", "c.txt"]);
    commit(&s(d), &req("Merge branch 'other'", false)).unwrap();
    assert_eq!(inspect(&s(d)).unwrap().operation, None);
    let parents = git(d, &["log", "-1", "--format=%P"]);
    assert_eq!(parents.split_whitespace().count(), 2);
}

#[test]
fn missing_identity_is_reported() {
    let r = repo();
    let d = r.path();
    git(d, &["config", "--unset", "user.name"]);
    git(d, &["config", "--unset", "user.email"]);
    git(d, &["config", "user.useConfigOnly", "true"]);
    fs::write(d.join("a.txt"), "a\n").unwrap();
    git(d, &["add", "a.txt"]);
    // A global identity on the test machine would mask the problem; isolate it.
    std::env::set_var("GIT_CONFIG_GLOBAL", "/dev/null");
    std::env::set_var("GIT_CONFIG_NOSYSTEM", "1");
    let err = commit(&s(d), &req("x", false)).unwrap_err();
    assert_eq!(err.kind(), "identityMissing", "{err:?}");
    assert!(commit_draft(&s(d)).unwrap().author.is_none());
}

#[test]
fn failing_hook_is_reported_with_its_output() {
    let r = repo();
    let d = r.path();
    commit_file(d, "a", "a\n", "a");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let hook = d.join(".git/hooks/pre-commit");
        fs::write(&hook, "#!/bin/sh\necho 'lint failed: fix it' >&2\nexit 1\n").unwrap();
        fs::set_permissions(&hook, fs::Permissions::from_mode(0o755)).unwrap();
        fs::write(d.join("a"), "b\n").unwrap();
        git(d, &["add", "a"]);
        let err = commit(&s(d), &req("x", false)).unwrap_err();
        assert_eq!(err.kind(), "commitFailed");
        assert!(err.detail().unwrap().contains("lint failed"));
    }
}
