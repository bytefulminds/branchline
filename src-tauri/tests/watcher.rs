//! The watcher must react to real changes but never to Branchline's own reads.

use std::fs;
use std::path::Path;
use std::process::Command;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::thread::sleep;
use std::time::Duration;

use branchline_lib::git::diff::{file_diff, DiffArea};
use branchline_lib::git::ops::stage_files;
use branchline_lib::git::repository::{inspect, resolve_paths};
use branchline_lib::watcher::spawn_watcher;
use tempfile::TempDir;

fn git(dir: &Path, args: &[&str]) {
    let ok = Command::new("git")
        .args(args)
        .current_dir(dir)
        .env("GIT_AUTHOR_NAME", "T")
        .env("GIT_AUTHOR_EMAIL", "t@e")
        .env("GIT_COMMITTER_NAME", "T")
        .env("GIT_COMMITTER_EMAIL", "t@e")
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .status()
        .unwrap()
        .success();
    assert!(ok, "git {args:?}");
}

const SETTLE: Duration = Duration::from_millis(600);

#[test]
fn reacts_to_changes_but_not_to_reads() {
    let tmp = TempDir::new().unwrap();
    let d = tmp.path();
    git(d, &["init", "-q", "-b", "main"]);
    fs::write(d.join(".gitignore"), "target/\n").unwrap();
    fs::write(d.join("a.txt"), "one\n").unwrap();
    git(d, &["add", "-A"]);
    git(d, &["commit", "-q", "-m", "init"]);
    fs::write(d.join("a.txt"), "two\n").unwrap();
    fs::create_dir_all(d.join("target")).unwrap();

    let repo = d.to_str().unwrap().to_string();
    let (root, git_dir) = resolve_paths(&repo).unwrap();
    let count = Arc::new(AtomicUsize::new(0));
    let c = Arc::clone(&count);
    let _handle = spawn_watcher(
        root.clone(),
        git_dir,
        Duration::from_millis(100),
        move || {
            c.fetch_add(1, Ordering::SeqCst);
        },
    )
    .unwrap();
    sleep(SETTLE);
    count.store(0, Ordering::SeqCst);

    // Branchline's own reads: status, diffs. These must not trigger refreshes.
    for _ in 0..10 {
        inspect(&repo).unwrap();
        file_diff(&root, "a.txt", None, DiffArea::Unstaged, false).unwrap();
    }
    sleep(SETTLE);
    assert_eq!(count.load(Ordering::SeqCst), 0, "reads triggered a refresh");

    // Ignored paths do not count either.
    fs::write(d.join("target/build.log"), "noise").unwrap();
    sleep(SETTLE);
    assert_eq!(
        count.load(Ordering::SeqCst),
        0,
        "ignored path triggered a refresh"
    );

    // A real edit is reported once, after the burst settles.
    for i in 0..5 {
        fs::write(d.join("a.txt"), format!("edit {i}\n")).unwrap();
    }
    sleep(SETTLE);
    assert_eq!(
        count.load(Ordering::SeqCst),
        1,
        "one debounced event per burst"
    );

    // Staging changes the index, which also matters.
    stage_files(&repo, &["a.txt".into()]).unwrap();
    sleep(SETTLE);
    assert!(
        count.load(Ordering::SeqCst) >= 2,
        "index change not reported"
    );
}
