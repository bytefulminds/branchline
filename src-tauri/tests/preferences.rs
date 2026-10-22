//! Settings that reach Git: identity and signing per repository, and diff options.

use std::fs;
use std::path::Path;
use std::process::Command;

use branchline_lib::git::diff::{commit_diff, file_diff_with, DiffArea, DiffOptions, LineKind};
use branchline_lib::git::identity::{get_identity, set_identity, ConfigScope, IdentityValues};
use tempfile::TempDir;

fn git(dir: &Path, args: &[&str]) -> String {
    let out = Command::new("git")
        .args(args)
        .current_dir(dir)
        .env("GIT_CONFIG_NOSYSTEM", "1")
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
    git(d, &["config", "user.name", "Repo Person"]);
    git(d, &["config", "user.email", "repo@example.com"]);
    t
}

fn s(p: &Path) -> String {
    p.to_str().unwrap().to_string()
}

#[test]
fn repository_identity_and_signing_round_trip() {
    let t = repo();
    let d = t.path();
    let id = get_identity(Some(&s(d))).unwrap();
    let local = id.repository.unwrap();
    assert_eq!(local.name, "Repo Person");
    assert_eq!(local.email, "repo@example.com");
    assert!(!local.sign_commits);

    set_identity(
        ConfigScope::Repository,
        Some(&s(d)),
        &IdentityValues {
            name: "Ada Lovelace".into(),
            email: "ada@example.com".into(),
            sign_commits: true,
            signing_format: "ssh".into(),
            signing_key: "~/.ssh/id_ed25519.pub".into(),
        },
    )
    .unwrap();
    assert_eq!(git(d, &["config", "--local", "user.name"]), "Ada Lovelace");
    assert_eq!(git(d, &["config", "--local", "commit.gpgsign"]), "true");
    assert_eq!(git(d, &["config", "--local", "gpg.format"]), "ssh");

    // Empty values are removed, so the global values apply again.
    set_identity(
        ConfigScope::Repository,
        Some(&s(d)),
        &IdentityValues::default(),
    )
    .unwrap();
    let local = get_identity(Some(&s(d))).unwrap().repository.unwrap();
    assert_eq!(local, IdentityValues::default());
}

#[test]
fn identity_values_are_checked() {
    let t = repo();
    let d = t.path();
    let bad = [
        IdentityValues {
            name: "Ada\n[core]\n\tsshCommand = evil".into(),
            ..IdentityValues::default()
        },
        IdentityValues {
            email: "not-an-email".into(),
            ..IdentityValues::default()
        },
        IdentityValues {
            signing_format: "pgp2".into(),
            ..IdentityValues::default()
        },
    ];
    for v in &bad {
        assert!(
            set_identity(ConfigScope::Repository, Some(&s(d)), v).is_err(),
            "{v:?}"
        );
    }
    assert_eq!(git(d, &["config", "--local", "user.name"]), "Repo Person");
    assert!(set_identity(ConfigScope::Repository, None, &IdentityValues::default()).is_err());
}

#[test]
fn diff_options_change_context_and_whitespace_but_not_staging() {
    let t = repo();
    let d = t.path();
    let lines: String = (1..=20).map(|i| format!("line {i}\n")).collect();
    fs::write(d.join("f.txt"), &lines).unwrap();
    git(d, &["add", "-A"]);
    git(d, &["commit", "-q", "-m", "base"]);
    let changed = lines
        .replace("line 10\n", "LINE 10\n")
        .replace("line 15\n", "line  15\n");
    fs::write(d.join("f.txt"), &changed).unwrap();

    let normal = file_diff_with(
        d,
        "f.txt",
        None,
        DiffArea::Unstaged,
        false,
        &DiffOptions::default(),
    )
    .unwrap();
    assert!(normal.supports_partial);
    assert_eq!(normal.additions, 2);

    let quiet = DiffOptions {
        context: 0,
        ignore_whitespace: true,
    };
    let diff = file_diff_with(d, "f.txt", None, DiffArea::Unstaged, false, &quiet).unwrap();
    assert_eq!(diff.additions, 1, "the whitespace-only change is hidden");
    assert!(!diff.supports_partial, "line staging needs the full diff");
    let context: usize = diff
        .hunks
        .iter()
        .flat_map(|h| &h.lines)
        .filter(|l| l.kind == LineKind::Context)
        .count();
    assert_eq!(context, 0);

    git(d, &["commit", "-q", "-am", "change"]);
    let oid = git(d, &["rev-parse", "HEAD"]);
    let wide = DiffOptions {
        context: 10,
        ignore_whitespace: false,
    };
    let diff = commit_diff(d, &oid, "f.txt", None, false, &wide).unwrap();
    assert_eq!(
        diff.hunks.len(),
        1,
        "wide context merges both changes into one hunk"
    );
}
