//! The Git console log records real commands, their output and failures.

use std::fs;
use std::path::Path;
use std::process::Command;

use branchline_lib::git::command_log::{since, CommandEntry, MAX_STDOUT};
use branchline_lib::git::runner::{run_git, run_git_with, RunOptions, DEFAULT_TIMEOUT};
use tempfile::TempDir;

fn git(dir: &Path, args: &[&str]) {
    let out = Command::new("git")
        .args(args)
        .current_dir(dir)
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .output()
        .unwrap();
    assert!(out.status.success(), "git {args:?}");
}

fn repo() -> TempDir {
    let t = TempDir::new().unwrap();
    let d = t.path();
    git(d, &["init", "-q", "-b", "main"]);
    git(d, &["config", "user.name", "T"]);
    git(d, &["config", "user.email", "t@example.com"]);
    git(d, &["config", "commit.gpgsign", "false"]);
    t
}

/// Entries for this test's folder only (tests run in parallel and share the log).
fn entries(dir: &Path) -> Vec<CommandEntry> {
    let cwd = dir.display().to_string();
    since(0).into_iter().filter(|e| e.cwd == cwd).collect()
}

#[cfg(unix)]
#[test]
fn records_a_failing_hook_with_its_output() {
    use std::os::unix::fs::PermissionsExt;
    let t = repo();
    let d = t.path();
    let hook = d.join(".git/hooks/pre-commit");
    fs::write(
        &hook,
        "#!/bin/sh\necho 'lint: 2 problems in app.py' >&2\nexit 1\n",
    )
    .unwrap();
    fs::set_permissions(&hook, fs::Permissions::from_mode(0o755)).unwrap();
    fs::write(d.join("app.py"), "x = 1\n").unwrap();
    run_git(d, &["add", "app.py"], DEFAULT_TIMEOUT).unwrap();
    let message = b"Add app";
    let err = run_git_with(
        d,
        &["commit", "-F", "-"],
        &RunOptions {
            stdin: Some(message),
            ..RunOptions::default()
        },
    )
    .unwrap_err();
    assert!(!err.to_string().is_empty());

    let log = entries(d);
    let add = log.iter().find(|e| e.args == ["add", "app.py"]).unwrap();
    assert_eq!(
        (add.ok, add.exit_code, add.read_only),
        (Some(true), Some(0), false)
    );
    let commit = log
        .iter()
        .find(|e| e.args.first().map(String::as_str) == Some("commit"))
        .unwrap();
    assert_eq!(commit.ok, Some(false));
    assert!(
        commit.stderr.contains("lint: 2 problems in app.py"),
        "{commit:?}"
    );
    assert_eq!(commit.stdin_bytes, Some(message.len()));
    assert!(commit.duration_ms.is_some());
    assert!(commit.seq > add.seq);
    // Newer entries only.
    let later: Vec<_> = since(add.seq).into_iter().map(|e| e.id).collect();
    assert!(later.contains(&commit.id) && !later.contains(&add.id));
}

#[test]
fn accepted_exit_codes_count_as_success_and_output_is_capped() {
    let t = repo();
    let d = t.path();
    fs::write(d.join("a.txt"), "a\n".repeat(20_000)).unwrap();
    fs::write(d.join("b.txt"), "b\n").unwrap();
    run_git_with(
        d,
        &["diff", "--no-index", "--", "a.txt", "b.txt"],
        &RunOptions {
            ok_codes: &[0, 1],
            ..RunOptions::default()
        },
    )
    .unwrap();
    let diff = entries(d)
        .into_iter()
        .find(|e| e.args[0] == "diff")
        .unwrap();
    assert_eq!(
        (diff.ok, diff.exit_code, diff.read_only),
        (Some(true), Some(1), true)
    );
    assert!(diff.stdout.len() <= MAX_STDOUT);
    assert!(diff.stdout_bytes > MAX_STDOUT);
}

#[test]
fn removes_credentials_from_arguments_and_output() {
    let t = repo();
    let d = t.path();
    let _ = run_git(
        d,
        &[
            "remote",
            "add",
            "origin",
            "https://ada:s3cret@example.invalid/x.git",
        ],
        DEFAULT_TIMEOUT,
    );
    let log = entries(d);
    let add = log
        .iter()
        .find(|e| e.args.first().map(String::as_str) == Some("remote"))
        .unwrap();
    assert_eq!(add.args[3], "https://***@example.invalid/x.git");
    assert!(!format!("{log:?}").contains("s3cret"));
}
