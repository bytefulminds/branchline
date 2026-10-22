//! Searching and filtering history against a real repository.

use std::fs;
use std::path::Path;
use std::process::Command;

use branchline_lib::git::log::{log_page, LogFilter};
use tempfile::TempDir;

fn git_env(dir: &Path, args: &[&str], env: &[(&str, &str)]) -> String {
    let out = Command::new("git")
        .args(args)
        .current_dir(dir)
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .envs(env.iter().copied())
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

fn git(dir: &Path, args: &[&str]) -> String {
    git_env(dir, args, &[])
}

/// Commit `name` with this author and day, returning the commit id.
fn commit(d: &Path, name: &str, msg: &str, author: &str, day: &str) -> String {
    let p = d.join(name);
    fs::create_dir_all(p.parent().unwrap()).unwrap();
    fs::write(&p, format!("{msg}\n")).unwrap();
    git(d, &["add", "-A"]);
    let date = format!("{day}T12:00:00");
    let email = format!("{}@example.com", author.to_lowercase());
    git_env(
        d,
        &["commit", "-q", "-m", msg],
        &[
            ("GIT_AUTHOR_NAME", author),
            ("GIT_AUTHOR_EMAIL", &email),
            ("GIT_AUTHOR_DATE", &date),
            ("GIT_COMMITTER_DATE", &date),
        ],
    );
    git(d, &["rev-parse", "HEAD"])
}

struct Fixture {
    _dir: TempDir,
    ids: Vec<String>,
}

/// main: a (Ann, src), b (Bob, docs), c (Ann, src); feature (from b): d (Cas, src/deep).
fn fixture() -> Fixture {
    let t = TempDir::new().unwrap();
    let d = t.path();
    git(d, &["init", "-q", "-b", "main"]);
    git(d, &["config", "user.name", "Tess"]);
    git(d, &["config", "user.email", "tess@example.com"]);
    git(d, &["config", "commit.gpgsign", "false"]);
    let a = commit(d, "src/app.rs", "Add login screen", "Ann", "2026-01-10");
    let b = commit(d, "docs/guide.md", "Write the guide", "Bob", "2026-02-10");
    git(d, &["checkout", "-q", "-b", "feature"]);
    let dd = commit(d, "src/deep/x.rs", "Fix LOGIN crash", "Cas", "2026-03-10");
    git(d, &["checkout", "-q", "main"]);
    let c = commit(d, "src/app.rs", "Tidy app", "Ann", "2026-04-10");
    Fixture {
        _dir: t,
        ids: vec![a, b, c, dd],
    }
}

fn find(f: &Fixture, filter: LogFilter) -> Vec<String> {
    let page = log_page(f._dir.path(), 0, 100, Some(&filter)).unwrap();
    assert_eq!(page.total, page.commits.len());
    page.commits.into_iter().map(|c| c.summary).collect()
}

#[test]
fn empty_filter_lists_everything() {
    let f = fixture();
    let page = log_page(f._dir.path(), 0, 100, Some(&LogFilter::default())).unwrap();
    assert_eq!(page.total, 4);
}

#[test]
fn text_matches_message_author_or_commit_id() {
    let f = fixture();
    let text = |t: &str| LogFilter {
        text: t.into(),
        ..LogFilter::default()
    };
    // Case-insensitive, across all branches, newest first.
    assert_eq!(
        find(&f, text("login")),
        vec!["Fix LOGIN crash", "Add login screen"]
    );
    // Author name or email.
    assert_eq!(find(&f, text("bob")), vec!["Write the guide"]);
    assert_eq!(
        find(&f, text("ann@example")),
        vec!["Tidy app", "Add login screen"]
    );
    // Start of a commit id.
    assert_eq!(find(&f, text(&f.ids[1][..8])), vec!["Write the guide"]);
    // Not a pattern: regex characters are literal.
    assert!(find(&f, text("log.n")).is_empty());
}

#[test]
fn limits_combine_with_each_other_and_the_text() {
    let f = fixture();
    let author = LogFilter {
        author: "ann".into(),
        ..LogFilter::default()
    };
    assert_eq!(
        find(&f, author.clone()),
        vec!["Tidy app", "Add login screen"]
    );
    // Author AND text, even though the text also matches other authors.
    assert_eq!(
        find(
            &f,
            LogFilter {
                text: "login".into(),
                ..author
            }
        ),
        vec!["Add login screen"]
    );
    // A folder includes everything below it; a trailing slash is fine.
    assert_eq!(
        find(
            &f,
            LogFilter {
                path: "src/".into(),
                ..LogFilter::default()
            }
        ),
        vec!["Tidy app", "Fix LOGIN crash", "Add login screen"]
    );
    // Dates are inclusive days.
    assert_eq!(
        find(
            &f,
            LogFilter {
                since: "2026-02-10".into(),
                until: "2026-03-10".into(),
                ..LogFilter::default()
            }
        ),
        vec!["Fix LOGIN crash", "Write the guide"]
    );
    // The current branch leaves out the feature branch.
    assert_eq!(
        find(
            &f,
            LogFilter {
                text: "login".into(),
                current_branch: true,
                ..LogFilter::default()
            }
        ),
        vec!["Add login screen"]
    );
}

#[test]
fn pages_through_results() {
    let f = fixture();
    let filter = LogFilter {
        path: "src".into(),
        ..LogFilter::default()
    };
    let first = log_page(f._dir.path(), 0, 2, Some(&filter)).unwrap();
    let rest = log_page(f._dir.path(), 2, 2, Some(&filter)).unwrap();
    assert_eq!(
        (first.commits.len(), first.has_more, first.total),
        (2, true, 3)
    );
    assert_eq!((rest.commits.len(), rest.has_more), (1, false));
    assert_eq!(rest.commits[0].oid, f.ids[0]);
}

#[test]
fn rejects_bad_input() {
    let f = fixture();
    let bad = [
        LogFilter {
            path: "../outside".into(),
            ..LogFilter::default()
        },
        LogFilter {
            since: "last week".into(),
            ..LogFilter::default()
        },
        LogFilter {
            text: "a\nb".into(),
            ..LogFilter::default()
        },
        LogFilter {
            author: "x".repeat(201),
            ..LogFilter::default()
        },
    ];
    for filter in bad {
        assert!(
            log_page(f._dir.path(), 0, 10, Some(&filter)).is_err(),
            "{filter:?}"
        );
    }
    // Options are never read from the text.
    let page = log_page(
        f._dir.path(),
        0,
        10,
        Some(&LogFilter {
            text: "--all".into(),
            ..LogFilter::default()
        }),
    )
    .unwrap();
    assert_eq!(page.total, 0);
}
