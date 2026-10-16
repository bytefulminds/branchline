//! Fetch, pull and push against real local remotes (bare repositories).

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, Instant};

use branchline_lib::git::remote::{
    cancel, fetch, list_remotes, pull, push, Progress, PullMode, PushRequest,
};
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

fn configure(d: &Path) {
    git(d, &["config", "user.name", "T"]);
    git(d, &["config", "user.email", "t@example.com"]);
    git(d, &["config", "commit.gpgsign", "false"]);
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

/// A bare remote plus two clones, `a` (the user) and `b` (a teammate).
struct Setup {
    _tmp: TempDir,
    remote: PathBuf,
    a: PathBuf,
    b: PathBuf,
}

fn setup() -> Setup {
    let tmp = TempDir::new().unwrap();
    let root = tmp.path();
    let seed = root.join("seed");
    fs::create_dir(&seed).unwrap();
    git(&seed, &["init", "-q", "-b", "main"]);
    configure(&seed);
    commit(&seed, "a.txt", "one\ntwo\nthree\n", "first");
    let remote = root.join("remote.git");
    git(root, &["clone", "-q", "--bare", "seed", "remote.git"]);
    for name in ["a", "b"] {
        git(root, &["clone", "-q", "remote.git", name]);
        configure(&root.join(name));
    }
    Setup {
        remote,
        a: root.join("a"),
        b: root.join("b"),
        _tmp: tmp,
    }
}

fn no_progress() -> impl FnMut(Progress) {
    |_| {}
}

fn upstream_counts(d: &Path) -> (u32, u32) {
    let up = inspect(&s(d)).unwrap().upstream.expect("upstream");
    (up.ahead, up.behind)
}

#[test]
fn fetch_updates_tracking_refs_and_prunes_deleted_branches() {
    let t = setup();
    commit(&t.b, "b.txt", "b\n", "teammate work");
    git(&t.b, &["push", "-q", "origin", "main", "main:feature"]);

    let outcome = fetch(&s(&t.a), None, "f1", &mut no_progress()).unwrap();
    assert_eq!(outcome.updated_refs, 2);
    assert!(!outcome.up_to_date);
    assert_eq!(upstream_counts(&t.a), (0, 1));
    assert!(git(&t.a, &["branch", "-r"]).contains("origin/feature"));

    // Nothing new: reported as up to date.
    let again = fetch(&s(&t.a), Some("origin"), "f2", &mut no_progress()).unwrap();
    assert!(again.up_to_date);
    assert_eq!(again.target.as_deref(), Some("origin"));

    // A branch deleted on the remote disappears locally (prune).
    git(&t.b, &["push", "-q", "origin", "--delete", "feature"]);
    fetch(&s(&t.a), Some("origin"), "f3", &mut no_progress()).unwrap();
    assert!(!git(&t.a, &["branch", "-r"]).contains("origin/feature"));
}

#[test]
fn fetch_rejects_unknown_remotes_and_option_like_names() {
    let t = setup();
    for name in ["upstream", "--upload-pack=touch /tmp/pwned", "-v"] {
        let err = fetch(&s(&t.a), Some(name), "f", &mut no_progress()).unwrap_err();
        assert_eq!(err.kind(), "unsupported", "{name}");
    }
    git(&t.a, &["remote", "remove", "origin"]);
    assert_eq!(
        fetch(&s(&t.a), None, "f", &mut no_progress())
            .unwrap_err()
            .kind(),
        "unsupported"
    );
}

#[test]
fn pull_fast_forwards_and_reports_up_to_date() {
    let t = setup();
    let tip = commit(&t.b, "b.txt", "b\n", "teammate work");
    git(&t.b, &["push", "-q"]);

    let outcome = pull(
        &s(&t.a),
        PullMode::FastForward,
        false,
        "p1",
        &mut no_progress(),
    )
    .unwrap();
    assert!(!outcome.up_to_date);
    assert!(!outcome.conflicts);
    assert_eq!(outcome.target.as_deref(), Some("origin/main"));
    assert_eq!(git(&t.a, &["rev-parse", "HEAD"]), tip);

    let again = pull(
        &s(&t.a),
        PullMode::FastForward,
        false,
        "p2",
        &mut no_progress(),
    )
    .unwrap();
    assert!(again.up_to_date);
}

#[test]
fn diverged_branches_need_merge_or_rebase() {
    let t = setup();
    commit(&t.b, "b.txt", "b\n", "teammate work");
    git(&t.b, &["push", "-q"]);
    commit(&t.a, "c.txt", "c\n", "my work");

    let err = pull(
        &s(&t.a),
        PullMode::FastForward,
        false,
        "p",
        &mut no_progress(),
    )
    .unwrap_err();
    assert_eq!(err.kind(), "diverged");
    assert_eq!(
        upstream_counts(&t.a),
        (1, 1),
        "nothing changed after a refused pull"
    );

    let outcome = pull(&s(&t.a), PullMode::Merge, false, "p", &mut no_progress()).unwrap();
    assert!(!outcome.conflicts);
    let parents = git(&t.a, &["rev-list", "--parents", "-n1", "HEAD"]);
    assert_eq!(parents.split(' ').count(), 3, "a merge commit was created");
    assert_eq!(upstream_counts(&t.a), (2, 0));
}

#[test]
fn pull_with_rebase_keeps_history_linear() {
    let t = setup();
    commit(&t.b, "b.txt", "b\n", "teammate work");
    git(&t.b, &["push", "-q"]);
    commit(&t.a, "c.txt", "c\n", "my work");

    pull(&s(&t.a), PullMode::Rebase, false, "p", &mut no_progress()).unwrap();
    assert_eq!(git(&t.a, &["rev-list", "--merges", "--count", "HEAD"]), "0");
    assert_eq!(upstream_counts(&t.a), (1, 0));
    assert_eq!(git(&t.a, &["log", "-1", "--format=%s"]), "my work");
}

#[test]
fn pull_conflicts_are_reported_not_failed() {
    let t = setup();
    commit(&t.b, "a.txt", "one\nTEAMMATE\nthree\n", "teammate edit");
    git(&t.b, &["push", "-q"]);
    commit(&t.a, "a.txt", "one\nMINE\nthree\n", "my edit");

    let outcome = pull(&s(&t.a), PullMode::Merge, false, "p", &mut no_progress()).unwrap();
    assert!(outcome.conflicts);
    let info = inspect(&s(&t.a)).unwrap();
    assert!(info.operation.is_some());
    assert!(info.changes.iter().any(|c| c.conflict.is_some()));

    // While the merge is in progress, another pull is refused up front.
    let err = pull(&s(&t.a), PullMode::Merge, false, "p", &mut no_progress()).unwrap_err();
    assert_eq!(err.kind(), "unsupported");
}

#[test]
fn pull_refuses_to_overwrite_local_changes() {
    let t = setup();
    commit(&t.b, "a.txt", "one\nTEAMMATE\nthree\n", "teammate edit");
    git(&t.b, &["push", "-q"]);
    fs::write(t.a.join("a.txt"), "one\nuncommitted\nthree\n").unwrap();

    let err = pull(
        &s(&t.a),
        PullMode::FastForward,
        false,
        "p",
        &mut no_progress(),
    )
    .unwrap_err();
    assert_eq!(err.kind(), "checkoutConflict");
    assert_eq!(
        fs::read_to_string(t.a.join("a.txt")).unwrap(),
        "one\nuncommitted\nthree\n"
    );
}

#[test]
fn pull_needs_a_branch_with_an_upstream() {
    let t = setup();
    git(&t.a, &["switch", "-q", "-c", "local-only"]);
    assert_eq!(
        pull(
            &s(&t.a),
            PullMode::FastForward,
            false,
            "p",
            &mut no_progress()
        )
        .unwrap_err()
        .kind(),
        "noUpstream"
    );
    git(&t.a, &["switch", "-q", "--detach", "main"]);
    assert_eq!(
        pull(
            &s(&t.a),
            PullMode::FastForward,
            false,
            "p",
            &mut no_progress()
        )
        .unwrap_err()
        .kind(),
        "unsupported"
    );
}

fn push_req(branch: &str) -> PushRequest {
    PushRequest {
        branch: branch.into(),
        remote: None,
        set_upstream: false,
        force: false,
    }
}

#[test]
fn push_to_upstream_and_publish_new_branch() {
    let t = setup();
    let tip = commit(&t.a, "c.txt", "c\n", "my work");
    let outcome = push(&s(&t.a), &push_req("main"), "u1", &mut no_progress()).unwrap();
    assert_eq!(outcome.target.as_deref(), Some("origin/main"));
    assert!(!outcome.up_to_date);
    assert_eq!(git(&t.remote, &["rev-parse", "main"]), tip);
    assert_eq!(upstream_counts(&t.a), (0, 0));

    let again = push(&s(&t.a), &push_req("main"), "u2", &mut no_progress()).unwrap();
    assert!(again.up_to_date);

    // A branch without upstream needs a remote; with set_upstream it gets tracking.
    git(&t.a, &["switch", "-q", "-c", "topic"]);
    commit(&t.a, "t.txt", "t\n", "topic work");
    assert_eq!(
        push(&s(&t.a), &push_req("topic"), "u3", &mut no_progress())
            .unwrap_err()
            .kind(),
        "noUpstream"
    );
    let publish = PushRequest {
        remote: Some("origin".into()),
        set_upstream: true,
        ..push_req("topic")
    };
    let outcome = push(&s(&t.a), &publish, "u4", &mut no_progress()).unwrap();
    assert_eq!(outcome.target.as_deref(), Some("origin/topic"));
    assert_eq!(
        inspect(&s(&t.a)).unwrap().upstream.unwrap().name,
        "origin/topic"
    );

    // Pushing a branch that is not checked out works too.
    git(&t.a, &["switch", "-q", "main"]);
    commit(&t.a, "d.txt", "d\n", "more");
    git(&t.a, &["switch", "-q", "topic"]);
    push(&s(&t.a), &push_req("main"), "u5", &mut no_progress()).unwrap();
    assert_eq!(
        git(&t.remote, &["rev-parse", "main"]),
        git(&t.a, &["rev-parse", "main"])
    );
}

#[test]
fn rejected_push_and_force_with_lease() {
    let t = setup();
    commit(&t.b, "b.txt", "b\n", "teammate work");
    git(&t.b, &["push", "-q"]);
    let mine = commit(&t.a, "c.txt", "c\n", "my work");

    let err = push(&s(&t.a), &push_req("main"), "u", &mut no_progress()).unwrap_err();
    assert_eq!(err.kind(), "pushRejected");

    // Our remote-tracking branch is outdated: the lease protects the teammate's commit.
    let force = PushRequest {
        force: true,
        ..push_req("main")
    };
    let err = push(&s(&t.a), &force, "u", &mut no_progress()).unwrap_err();
    assert_eq!(err.kind(), "staleLease");
    assert_ne!(git(&t.remote, &["rev-parse", "main"]), mine);

    // After fetching (the user has now seen the teammate's commit), force is allowed.
    fetch(&s(&t.a), None, "f", &mut no_progress()).unwrap();
    push(&s(&t.a), &force, "u", &mut no_progress()).unwrap();
    assert_eq!(git(&t.remote, &["rev-parse", "main"]), mine);
}

#[test]
fn push_validates_branch_and_remote() {
    let t = setup();
    for branch in ["-f", "nope", "main:refs/heads/other"] {
        let err = push(&s(&t.a), &push_req(branch), "u", &mut no_progress()).unwrap_err();
        assert!(
            matches!(err.kind(), "invalidBranchName" | "unsupported"),
            "{branch}: {}",
            err.kind()
        );
    }
    let req = PushRequest {
        remote: Some("--receive-pack=evil".into()),
        ..push_req("main")
    };
    assert_eq!(
        push(&s(&t.a), &req, "u", &mut no_progress())
            .unwrap_err()
            .kind(),
        "unsupported"
    );
}

#[test]
fn network_failures_are_classified() {
    let t = setup();
    git(
        &t.a,
        &["remote", "add", "missing", "/definitely/not/here.git"],
    );
    let err = fetch(&s(&t.a), Some("missing"), "n1", &mut no_progress()).unwrap_err();
    assert_eq!(err.kind(), "remoteNotFound", "{err:?}");

    // Port 1 on localhost refuses connections immediately; no real network is used.
    git(
        &t.a,
        &[
            "remote",
            "add",
            "closed",
            "https://user:secret@127.0.0.1:1/x.git",
        ],
    );
    let err = fetch(&s(&t.a), Some("closed"), "n2", &mut no_progress()).unwrap_err();
    assert_eq!(err.kind(), "networkFailed", "{err:?}");
    assert!(!err.detail().unwrap_or("").contains("secret"));
}

#[test]
fn remote_urls_are_listed_without_credentials() {
    let t = setup();
    git(
        &t.a,
        &[
            "remote",
            "add",
            "private",
            "https://me:hunter2@git.example.com/r.git",
        ],
    );
    let remotes = list_remotes(&s(&t.a)).unwrap();
    let names: Vec<_> = remotes.iter().map(|r| r.name.as_str()).collect();
    assert_eq!(names, ["origin", "private"]);
    assert_eq!(remotes[1].url, "https://***@git.example.com/r.git");
    assert!(!format!("{remotes:?}").contains("hunter2"));
}

#[cfg(unix)]
#[test]
fn a_hanging_fetch_can_be_cancelled() {
    let t = setup();
    // An SSH command that never answers stands in for an unresponsive server.
    git(
        &t.a,
        &["remote", "add", "slow", "ssh://example.invalid/r.git"],
    );
    // A distinctive duration, so the check below finds only this test's process.
    git(&t.a, &["config", "core.sshCommand", "sleep 37;"]);

    let started = Instant::now();
    std::thread::spawn(|| {
        std::thread::sleep(Duration::from_millis(400));
        cancel("slow-op");
    });
    let err = fetch(&s(&t.a), Some("slow"), "slow-op", &mut no_progress()).unwrap_err();
    assert_eq!(err.kind(), "cancelled");
    assert!(
        started.elapsed() < Duration::from_secs(5),
        "returned after {:?}",
        started.elapsed()
    );

    // The helper process (standing in for ssh) was stopped too, not left behind.
    std::thread::sleep(Duration::from_millis(200));
    let leftover = Command::new("pgrep")
        .args(["-x", "sleep"])
        .output()
        .unwrap();
    let survivors: Vec<String> = String::from_utf8_lossy(&leftover.stdout)
        .lines()
        .filter(|pid| {
            fs::read_to_string(format!("/proc/{pid}/cmdline"))
                .map(|c| c.contains("37"))
                // Without /proc (macOS), fall back to `ps`.
                .unwrap_or_else(|_| {
                    let ps = Command::new("ps")
                        .args(["-o", "args=", "-p", pid])
                        .output()
                        .unwrap();
                    String::from_utf8_lossy(&ps.stdout).contains("sleep 37")
                })
        })
        .map(str::to_string)
        .collect();
    assert!(survivors.is_empty(), "helper still running: {survivors:?}");

    // The next operation is not blocked by the cancelled one.
    fetch(&s(&t.a), Some("origin"), "next", &mut no_progress()).unwrap();
}

#[test]
fn pull_with_autostash_reapplies_local_changes() {
    let t = setup();
    commit(&t.b, "a.txt", "one\ntwo\nthree\nfour\n", "teammate appends");
    git(&t.b, &["push", "-q"]);
    let tip = git(&t.b, &["rev-parse", "HEAD"]);
    fs::write(t.a.join("a.txt"), "ONE\ntwo\nthree\n").unwrap();
    fs::write(t.a.join("notes.txt"), "untracked\n").unwrap();

    // Without autostash Git refuses, because the pull would overwrite a.txt.
    let err = pull(&s(&t.a), PullMode::Merge, false, "p", &mut no_progress()).unwrap_err();
    assert_eq!(err.kind(), "checkoutConflict");

    let outcome = pull(&s(&t.a), PullMode::Merge, true, "p", &mut no_progress()).unwrap();
    assert!(!outcome.conflicts && !outcome.stash_kept);
    assert_eq!(git(&t.a, &["rev-parse", "HEAD"]), tip);
    assert_eq!(
        fs::read_to_string(t.a.join("a.txt")).unwrap(),
        "ONE\ntwo\nthree\nfour\n",
        "both the pulled and the local change are there"
    );
    assert!(t.a.join("notes.txt").exists());
    assert_eq!(
        git(&t.a, &["stash", "list"]),
        "",
        "the temporary stash is gone"
    );
}

#[test]
fn autostash_that_cannot_be_reapplied_is_kept() {
    let t = setup();
    commit(&t.b, "a.txt", "one\nTEAMMATE\nthree\n", "teammate edit");
    git(&t.b, &["push", "-q"]);
    fs::write(t.a.join("a.txt"), "one\nMINE\nthree\n").unwrap();

    let outcome = pull(
        &s(&t.a),
        PullMode::FastForward,
        true,
        "p",
        &mut no_progress(),
    )
    .unwrap();
    assert!(outcome.stash_kept, "{outcome:?}");
    assert!(outcome.conflicts);
    assert_eq!(
        git(&t.a, &["stash", "list"]).lines().count(),
        1,
        "nothing is lost"
    );
}

#[test]
fn autostash_during_a_conflicted_merge_is_held_until_the_merge_is_committed() {
    let t = setup();
    commit(&t.b, "a.txt", "one\nTEAMMATE\nthree\n", "teammate edit");
    git(&t.b, &["push", "-q"]);
    commit(&t.a, "a.txt", "one\nMINE\nthree\n", "my edit");
    fs::write(t.a.join("other.txt"), "work in progress\n").unwrap();
    git(&t.a, &["add", "other.txt"]);

    let outcome = pull(&s(&t.a), PullMode::Merge, true, "p", &mut no_progress()).unwrap();
    assert!(outcome.conflicts);
    let info = inspect(&s(&t.a)).unwrap();
    assert!(
        info.held_changes,
        "Git holds the local changes during the merge"
    );
    assert!(!t.a.join("other.txt").exists());

    fs::write(t.a.join("a.txt"), "one\nBOTH\nthree\n").unwrap();
    git(&t.a, &["add", "a.txt"]);
    branchline_lib::git::commit::commit(
        &s(&t.a),
        &branchline_lib::git::commit::CommitRequest {
            message: "Merge".into(),
            amend: false,
        },
    )
    .unwrap();
    let info = inspect(&s(&t.a)).unwrap();
    assert!(!info.held_changes);
    assert_eq!(
        fs::read_to_string(t.a.join("other.txt")).unwrap(),
        "work in progress\n",
        "committing the merge in Branchline brings the changes back"
    );
}
