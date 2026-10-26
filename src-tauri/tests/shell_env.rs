//! Hooks find the tools on the login shell's PATH (Husky calling `npx`, for example).
#![cfg(unix)]

use std::ffi::OsStr;
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::Path;
use std::process::Command;
use std::time::{Duration, Instant};

use branchline_lib::git::runner::{run_git, run_git_with, RunOptions, DEFAULT_TIMEOUT};
use branchline_lib::shell_env::{ask_shell, init_with, merge};
use tempfile::TempDir;

fn script(path: &Path, body: &str) {
    fs::write(path, format!("#!/bin/sh\n{body}\n")).unwrap();
    fs::set_permissions(path, fs::Permissions::from_mode(0o755)).unwrap();
}

#[test]
fn reads_path_from_a_chatty_login_shell() {
    let t = TempDir::new().unwrap();
    let shell = t.path().join("fake-shell");
    // Behaves like a login shell whose profile greets the user and extends PATH.
    script(
        &shell,
        "echo 'Last login: today'\nPATH=\"/opt/homebrew/bin:$HOME/.nvm/bin:$PATH\"\nexport PATH\neval \"$4\"",
    );
    let path = ask_shell(&shell, Duration::from_secs(5)).unwrap();
    let path = path.to_string_lossy();
    assert!(path.starts_with("/opt/homebrew/bin:"), "{path}");
    assert!(path.contains("/.nvm/bin"), "{path}");
}

#[test]
fn gives_up_on_a_shell_that_hangs() {
    let t = TempDir::new().unwrap();
    let shell = t.path().join("slow-shell");
    script(&shell, "sleep 30");
    let started = Instant::now();
    assert!(ask_shell(&shell, Duration::from_millis(300)).is_none());
    assert!(started.elapsed() < Duration::from_secs(5));
}

#[test]
fn a_husky_style_hook_finds_tools_on_the_shell_path() {
    let tools = TempDir::new().unwrap();
    // Stands in for npx installed by Homebrew or nvm: only on the shell's PATH.
    script(
        &tools.path().join("fake-npx"),
        "echo \"lint-staged ran\" >&2",
    );
    let shell_path = format!("{}:/usr/bin:/bin", tools.path().display());
    let merged = merge(OsStr::new(&shell_path), std::env::var_os("PATH").as_deref());
    assert!(
        init_with(merged),
        "the PATH must not be settled before this test"
    );

    let repo = TempDir::new().unwrap();
    let d = repo.path();
    let git = |args: &[&str]| {
        assert!(Command::new("git")
            .args(args)
            .current_dir(d)
            .status()
            .unwrap()
            .success());
    };
    git(&["init", "-q", "-b", "main"]);
    git(&["config", "user.name", "T"]);
    git(&["config", "user.email", "t@example.com"]);
    git(&["config", "commit.gpgsign", "false"]);
    // Like Husky: hooks in a tracked folder, found through core.hooksPath.
    fs::create_dir_all(d.join(".husky")).unwrap();
    script(&d.join(".husky/pre-commit"), "fake-npx lint-staged");
    git(&["config", "core.hooksPath", ".husky"]);
    fs::write(d.join("a.txt"), "a\n").unwrap();
    run_git(d, &["add", "a.txt"], DEFAULT_TIMEOUT).unwrap();

    let out = run_git_with(
        d,
        &["commit", "-F", "-"],
        &RunOptions {
            stdin: Some(b"Add a"),
            ..RunOptions::default()
        },
    )
    .expect("the hook finds fake-npx");
    assert!(out.stderr.contains("lint-staged ran"), "{}", out.stderr);
}
