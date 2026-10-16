//! Interactive rebase plans against real repositories.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use branchline_lib::git::integrate::{step, Step};
use branchline_lib::git::rebase_plan::{interactive_rebase, plan_commits, PlanAction, PlanStep};
use branchline_lib::git::repository::{inspect, RepoOperation};
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

/// base, then c1..c4 each adding file<i>.txt. Returns (tempdir, repo path, base, [c1..c4]).
fn repo_in(name: &str) -> (TempDir, PathBuf, String, Vec<String>) {
    let t = TempDir::new().unwrap();
    let d = t.path().join(name);
    fs::create_dir(&d).unwrap();
    git(&d, &["init", "-q", "-b", "main"]);
    git(&d, &["config", "user.name", "T"]);
    git(&d, &["config", "user.email", "t@example.com"]);
    git(&d, &["config", "commit.gpgsign", "false"]);
    fs::write(d.join("base.txt"), "base\n").unwrap();
    git(&d, &["add", "-A"]);
    git(&d, &["commit", "-q", "-m", "base"]);
    let base = git(&d, &["rev-parse", "HEAD"]);
    let mut commits = Vec::new();
    for i in 1..=4 {
        fs::write(d.join(format!("file{i}.txt")), format!("{i}\n")).unwrap();
        git(&d, &["add", "-A"]);
        git(&d, &["commit", "-q", "-m", &format!("commit {i}")]);
        commits.push(git(&d, &["rev-parse", "HEAD"]));
    }
    (t, d, base, commits)
}

fn plan(steps: &[(&str, PlanAction)]) -> Vec<PlanStep> {
    steps
        .iter()
        .map(|(oid, action)| PlanStep {
            oid: oid.to_string(),
            action: *action,
            message: None,
        })
        .collect()
}

fn subjects(d: &Path) -> Vec<String> {
    git(d, &["log", "--format=%s", "--reverse", "HEAD"])
        .lines()
        .map(str::to_string)
        .collect()
}

fn leftover_files(d: &Path) -> Vec<String> {
    fs::read_dir(d.join(".git"))
        .unwrap()
        .flatten()
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|n| n.starts_with("branchline-"))
        .collect()
}

#[test]
fn lists_the_commits_after_the_base_oldest_first() {
    let (_t, d, base, c) = repo_in("r");
    let commits = plan_commits(&s(&d), &base).unwrap();
    let oids: Vec<_> = commits.iter().map(|c| c.oid.clone()).collect();
    assert_eq!(oids, c);
    assert_eq!(commits[0].summary, "commit 1");
    assert_eq!(commits[0].author_name, "T");

    // A commit that is not below HEAD, and a range with a merge, are refused.
    git(&d, &["switch", "-q", "-c", "side", &base]);
    fs::write(d.join("side.txt"), "s\n").unwrap();
    git(&d, &["add", "-A"]);
    git(&d, &["commit", "-q", "-m", "side"]);
    let side = git(&d, &["rev-parse", "HEAD"]);
    git(&d, &["switch", "-q", "main"]);
    assert_eq!(
        plan_commits(&s(&d), &side).unwrap_err().kind(),
        "unsupported"
    );
    git(&d, &["merge", "-q", "--no-ff", "-m", "merge side", "side"]);
    let err = plan_commits(&s(&d), &base).unwrap_err();
    assert!(err.to_string().contains("merge commits"), "{err}");
    assert!(
        plan_commits(&s(&d), "HEAD~2").is_err(),
        "only commit ids are accepted"
    );
}

#[test]
fn reorders_rewords_squashes_fixes_up_and_drops() {
    // Unusual folder name: the reword file path goes through the shell quoted.
    let (_t, d, base, c) = repo_in("it's a $HOME repo");
    let mut steps = plan(&[
        (&c[3], PlanAction::Pick),
        (&c[0], PlanAction::Reword),
        (&c[1], PlanAction::Fixup),
        (&c[2], PlanAction::Drop),
    ]);
    steps[1].message = Some("First, reworded\n\nWith a body.".into());
    let out = interactive_rebase(&s(&d), &base, &steps, false).unwrap();
    assert!(!out.conflicts);
    assert_eq!(subjects(&d), ["base", "commit 4", "First, reworded"]);
    assert_eq!(
        git(&d, &["log", "-1", "--format=%B"]),
        "First, reworded\n\nWith a body."
    );
    // commit 2 was folded into the reworded commit, commit 3 is gone.
    assert!(d.join("file2.txt").exists() && !d.join("file3.txt").exists());
    assert_eq!(
        git(&d, &["show", "--name-only", "--format=", "HEAD"]),
        "file1.txt\nfile2.txt"
    );
    assert!(leftover_files(&d).is_empty(), "{:?}", leftover_files(&d));

    // Squash keeps both messages.
    let (_t2, d2, base2, c2) = repo_in("squash");
    let steps = plan(&[
        (&c2[0], PlanAction::Pick),
        (&c2[1], PlanAction::Squash),
        (&c2[2], PlanAction::Pick),
        (&c2[3], PlanAction::Pick),
    ]);
    interactive_rebase(&s(&d2), &base2, &steps, false).unwrap();
    assert_eq!(subjects(&d2), ["base", "commit 1", "commit 3", "commit 4"]);
    assert_eq!(
        git(&d2, &["log", "-1", "--format=%B", "HEAD~2"]),
        "commit 1\n\ncommit 2"
    );
}

#[test]
fn a_conflicting_plan_stops_and_can_be_continued_or_aborted() {
    let (_t, d, base, _) = repo_in("conflict");
    // Two commits that edit the same line, in an order that cannot be swapped cleanly.
    fs::write(d.join("shared.txt"), "one\n").unwrap();
    git(&d, &["add", "-A"]);
    git(&d, &["commit", "-q", "-m", "shared one"]);
    let first = git(&d, &["rev-parse", "HEAD"]);
    fs::write(d.join("shared.txt"), "two\n").unwrap();
    git(&d, &["commit", "-qam", "shared two"]);
    let second = git(&d, &["rev-parse", "HEAD"]);
    let original = second.clone();
    let commits = plan_commits(&s(&d), &base).unwrap();
    let mut steps: Vec<PlanStep> = commits
        .iter()
        .map(|c| PlanStep {
            oid: c.oid.clone(),
            action: PlanAction::Pick,
            message: None,
        })
        .collect();
    // Swap the two shared commits and reword the later one.
    let n = steps.len();
    steps[n - 2].oid = second.clone();
    steps[n - 1].oid = first.clone();
    steps[n - 1].action = PlanAction::Reword;
    steps[n - 1].message = Some("Shared, reworded".into());

    let out = interactive_rebase(&s(&d), &base, &steps, false).unwrap();
    assert!(out.conflicts);
    assert_eq!(
        inspect(&s(&d)).unwrap().operation,
        Some(RepoOperation::Rebase)
    );
    assert!(
        !leftover_files(&d).is_empty(),
        "the reword message is kept until the end"
    );

    step(&s(&d), Step::Abort).unwrap();
    assert_eq!(git(&d, &["rev-parse", "HEAD"]), original);
    assert!(leftover_files(&d).is_empty());

    // Again, resolve each stop and continue: the reword is applied after the conflicts.
    interactive_rebase(&s(&d), &base, &steps, false).unwrap();
    for _ in 0..3 {
        if inspect(&s(&d)).unwrap().operation.is_none() {
            break;
        }
        fs::write(d.join("shared.txt"), "resolved\n").unwrap();
        git(&d, &["add", "shared.txt"]);
        let _ = step(&s(&d), Step::Continue);
    }
    assert_eq!(inspect(&s(&d)).unwrap().operation, None);
    assert_eq!(git(&d, &["log", "-1", "--format=%s"]), "Shared, reworded");
    assert!(leftover_files(&d).is_empty());
}

#[test]
fn a_stale_plan_is_refused() {
    let (_t, d, base, c) = repo_in("stale");
    let steps = plan(&[
        (&c[0], PlanAction::Pick),
        (&c[1], PlanAction::Pick),
        (&c[2], PlanAction::Pick),
        (&c[3], PlanAction::Pick),
    ]);
    // Someone commits after the plan was loaded.
    fs::write(d.join("late.txt"), "late\n").unwrap();
    git(&d, &["add", "-A"]);
    git(&d, &["commit", "-q", "-m", "late"]);
    let head = git(&d, &["rev-parse", "HEAD"]);
    let err = interactive_rebase(&s(&d), &base, &steps, false).unwrap_err();
    assert!(err.to_string().contains("does not match"), "{err}");
    assert_eq!(
        git(&d, &["rev-parse", "HEAD"]),
        head,
        "nothing was rewritten"
    );
    assert!(leftover_files(&d).is_empty());
}

#[test]
fn local_changes_block_until_stashed() {
    let (_t, d, base, c) = repo_in("dirty");
    fs::write(d.join("file1.txt"), "edited\n").unwrap();
    let steps = plan(&[
        (&c[1], PlanAction::Pick),
        (&c[0], PlanAction::Pick),
        (&c[2], PlanAction::Pick),
        (&c[3], PlanAction::Pick),
    ]);
    let err = interactive_rebase(&s(&d), &base, &steps, false).unwrap_err();
    assert_eq!(err.kind(), "checkoutConflict", "{err:?}");
    interactive_rebase(&s(&d), &base, &steps, true).unwrap();
    assert_eq!(subjects(&d)[1..3], ["commit 2", "commit 1"]);
    assert_eq!(fs::read_to_string(d.join("file1.txt")).unwrap(), "edited\n");
}
