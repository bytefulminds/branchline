//! Integration tests for diffs and staging operations on real repositories.

use std::fs;
use std::path::Path;
use std::process::Command;

use branchline_lib::git::diff::{file_diff, DiffArea, FileDiff, LineKind};
use branchline_lib::git::ops::{
    apply_lines, discard_files, stage_files, unstage_files, LineAction, LineRequest,
};
use branchline_lib::git::patch::HunkSelection;
use branchline_lib::git::repository::inspect;
use branchline_lib::git::status::ChangeKind;
use tempfile::TempDir;

fn git(dir: &Path, args: &[&str]) -> String {
    let out = Command::new("git")
        .args(args)
        .current_dir(dir)
        .env("GIT_AUTHOR_NAME", "T")
        .env("GIT_AUTHOR_EMAIL", "t@example.com")
        .env("GIT_COMMITTER_NAME", "T")
        .env("GIT_COMMITTER_EMAIL", "t@example.com")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env(
            "GIT_CONFIG_GLOBAL",
            if cfg!(windows) { "NUL" } else { "/dev/null" },
        )
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8_lossy(&out.stdout).into_owned()
}

fn repo() -> TempDir {
    let t = TempDir::new().unwrap();
    git(t.path(), &["init", "-q", "-b", "main"]);
    git(t.path(), &["config", "core.autocrlf", "false"]);
    t
}

fn commit(dir: &Path, name: &str, content: &[u8]) {
    let p = dir.join(name);
    if let Some(parent) = p.parent() {
        fs::create_dir_all(parent).unwrap();
    }
    fs::write(p, content).unwrap();
    git(dir, &["add", "--", name]);
    git(dir, &["commit", "-q", "-m", name]);
}

fn s(p: &Path) -> String {
    p.to_str().unwrap().to_string()
}

/// Content of `name` in the index.
fn index(dir: &Path, name: &str) -> String {
    git(dir, &["show", &format!(":{name}")])
}

fn worktree(dir: &Path, name: &str) -> String {
    fs::read_to_string(dir.join(name)).unwrap()
}

fn diff(dir: &Path, name: &str, area: DiffArea) -> FileDiff {
    file_diff(dir, name, None, area, false).unwrap()
}

/// Index of the first change line in hunk 0 whose content equals `text`.
fn line_index(d: &FileDiff, hunk: usize, kind: LineKind, text: &str) -> usize {
    d.hunks[hunk]
        .lines
        .iter()
        .position(|l| l.kind == kind && l.content == text)
        .unwrap_or_else(|| panic!("{kind:?} {text:?} not in {:?}", d.hunks[hunk].lines))
}

fn lines(path: &str, action: LineAction, d: &FileDiff, sel: Vec<HunkSelection>) -> LineRequest {
    LineRequest {
        path: path.into(),
        action,
        fingerprint: d.fingerprint.clone(),
        selections: sel,
    }
}

const BASE: &str = "1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n11\n12\n13\n14\n15\n";

#[test]
fn whole_file_stage_unstage_and_discard() {
    let r = repo();
    let d = r.path();
    commit(d, "a.txt", b"one\n");
    commit(d, "gone.txt", b"bye\n");
    fs::write(d.join("a.txt"), "two\n").unwrap();
    fs::remove_file(d.join("gone.txt")).unwrap();
    fs::write(d.join("new.txt"), "hi\n").unwrap();

    stage_files(
        &s(d),
        &["a.txt".into(), "gone.txt".into(), "new.txt".into()],
    )
    .unwrap();
    let info = inspect(&s(d)).unwrap();
    assert!(info
        .changes
        .iter()
        .all(|c| c.worktree_status.is_none() && c.index_status.is_some()));
    assert_eq!(index(d, "a.txt"), "two\n");

    unstage_files(&s(d), &["a.txt".into(), "new.txt".into()]).unwrap();
    let info = inspect(&s(d)).unwrap();
    let a = info.changes.iter().find(|c| c.path == "a.txt").unwrap();
    assert_eq!(
        (a.index_status, a.worktree_status),
        (None, Some(ChangeKind::Modified))
    );
    let n = info.changes.iter().find(|c| c.path == "new.txt").unwrap();
    assert_eq!(n.worktree_status, Some(ChangeKind::Untracked));

    discard_files(&s(d), &["a.txt".into(), "new.txt".into()]).unwrap();
    assert_eq!(worktree(d, "a.txt"), "one\n");
    assert!(!d.join("new.txt").exists());
    // The staged deletion is untouched.
    let info = inspect(&s(d)).unwrap();
    assert_eq!(info.changes.len(), 1);
    assert_eq!(info.changes[0].index_status, Some(ChangeKind::Deleted));
}

#[test]
fn discard_keeps_staged_content() {
    let r = repo();
    let d = r.path();
    commit(d, "f.txt", b"base\n");
    fs::write(d.join("f.txt"), "staged\n").unwrap();
    git(d, &["add", "f.txt"]);
    fs::write(d.join("f.txt"), "staged plus more\n").unwrap();
    discard_files(&s(d), &["f.txt".into()]).unwrap();
    assert_eq!(worktree(d, "f.txt"), "staged\n");
    assert_eq!(index(d, "f.txt"), "staged\n");
}

#[test]
fn discard_refuses_unsafe_requests() {
    let r = repo();
    let d = r.path();
    commit(d, "f.txt", b"base\n");
    fs::write(d.join("f.txt"), "staged\n").unwrap();
    git(d, &["add", "f.txt"]);
    // Only staged changes: nothing unstaged to discard.
    assert_eq!(
        discard_files(&s(d), &["f.txt".into()]).unwrap_err().kind(),
        "unsupported"
    );
    // Clean or unknown files.
    assert_eq!(
        discard_files(&s(d), &["nope.txt".into()])
            .unwrap_err()
            .kind(),
        "unsupported"
    );
    // Escapes are rejected before Git runs.
    for bad in ["../x", "/etc/passwd", ".git/config"] {
        assert_eq!(
            discard_files(&s(d), &[bad.into()]).unwrap_err().kind(),
            "invalidPath"
        );
    }
    assert_eq!(stage_files(&s(d), &[]).unwrap_err().kind(), "invalidPath");
}

#[test]
fn unstage_in_repository_without_commits() {
    let r = repo();
    let d = r.path();
    fs::write(d.join("first.txt"), "x\n").unwrap();
    stage_files(&s(d), &["first.txt".into()]).unwrap();
    assert_eq!(
        inspect(&s(d)).unwrap().changes[0].index_status,
        Some(ChangeKind::Added)
    );
    unstage_files(&s(d), &["first.txt".into()]).unwrap();
    assert_eq!(
        inspect(&s(d)).unwrap().changes[0].worktree_status,
        Some(ChangeKind::Untracked)
    );
}

#[test]
fn glob_like_names_are_literal() {
    let r = repo();
    let d = r.path();
    commit(d, "base", b"x\n");
    for n in ["*.txt", "a.txt", "-dash.txt", "[ab].txt"] {
        fs::write(d.join(n), "x\n").unwrap();
    }
    stage_files(
        &s(d),
        &["*.txt".into(), "-dash.txt".into(), "[ab].txt".into()],
    )
    .unwrap();
    let info = inspect(&s(d)).unwrap();
    let a = info.changes.iter().find(|c| c.path == "a.txt").unwrap();
    assert_eq!(
        a.worktree_status,
        Some(ChangeKind::Untracked),
        "a.txt must not match *.txt"
    );
    for n in ["*.txt", "-dash.txt", "[ab].txt"] {
        let c = info.changes.iter().find(|c| c.path == n).unwrap();
        assert_eq!(c.index_status, Some(ChangeKind::Added), "{n}");
    }
}

#[test]
fn diffs_for_each_area() {
    let r = repo();
    let d = r.path();
    commit(d, "f.txt", BASE.as_bytes());
    fs::write(d.join("f.txt"), BASE.replacen("1\n2\n", "1\ntwo\n", 1)).unwrap();
    git(d, &["add", "f.txt"]);
    fs::write(
        d.join("f.txt"),
        BASE.replacen("1\n2\n", "1\ntwo\n", 1)
            .replace("14\n", "fourteen\n"),
    )
    .unwrap();
    fs::write(d.join("new file.md"), "a\nb\n").unwrap();

    let staged = diff(d, "f.txt", DiffArea::Staged);
    assert_eq!((staged.additions, staged.deletions), (1, 1));
    assert!(staged.supports_partial);
    assert_eq!(staged.hunks[0].lines[1].content, "2");

    let unstaged = diff(d, "f.txt", DiffArea::Unstaged);
    assert_eq!((unstaged.additions, unstaged.deletions), (1, 1));
    assert_eq!(unstaged.hunks[0].new_start, 11);
    assert_ne!(staged.fingerprint, unstaged.fingerprint);

    let untracked = diff(d, "new file.md", DiffArea::Untracked);
    assert_eq!(untracked.change.as_deref(), Some("new"));
    assert_eq!(untracked.additions, 2);
    assert!(!untracked.supports_partial);
}

#[test]
fn binary_and_large_diffs() {
    let r = repo();
    let d = r.path();
    commit(d, "img.bin", &[0u8, 1, 2, 3, 0, 255]);
    fs::write(d.join("img.bin"), [0u8, 9, 9, 9, 0, 255]).unwrap();
    let bin = diff(d, "img.bin", DiffArea::Unstaged);
    assert!(bin.is_binary);
    assert!(!bin.supports_partial);

    let big: String = (0..30_000).map(|i| format!("line {i}\n")).collect();
    fs::write(d.join("big.txt"), &big).unwrap();
    let soft = diff(d, "big.txt", DiffArea::Untracked);
    assert!(soft.too_large);
    assert!(soft.hunks.is_empty());
    let forced = file_diff(d, "big.txt", None, DiffArea::Untracked, true).unwrap();
    assert!(!forced.too_large);
    assert_eq!(forced.additions, 30_000);
}

#[test]
fn conflicted_file_shows_markers() {
    let r = repo();
    let d = r.path();
    commit(d, "c.txt", b"base\n");
    git(d, &["checkout", "-q", "-b", "other"]);
    commit(d, "c.txt", b"other\n");
    git(d, &["checkout", "-q", "main"]);
    commit(d, "c.txt", b"main\n");
    let _ = Command::new("git")
        .args(["merge", "other"])
        .current_dir(d)
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_COMMITTER_NAME", "T")
        .env("GIT_COMMITTER_EMAIL", "t@e")
        .output();
    let c = diff(d, "c.txt", DiffArea::Conflicted);
    assert!(c.has_conflict_markers);
    assert!(!c.supports_partial);
    assert!(c.hunks[0].lines.iter().any(|l| l.content == "======="));
    // Discarding a conflicted file is refused.
    assert_eq!(
        discard_files(&s(d), &["c.txt".into()]).unwrap_err().kind(),
        "unsupported"
    );
    // Staging marks it resolved.
    stage_files(&s(d), &["c.txt".into()]).unwrap();
    assert!(inspect(&s(d))
        .unwrap()
        .changes
        .iter()
        .all(|c| c.conflict.is_none()));
}

#[test]
fn stage_one_hunk_of_two() {
    let r = repo();
    let d = r.path();
    commit(d, "f.txt", BASE.as_bytes());
    let changed = BASE
        .replacen("1\n2\n", "1\ntwo\n", 1)
        .replace("14\n", "fourteen\n");
    fs::write(d.join("f.txt"), &changed).unwrap();
    let u = diff(d, "f.txt", DiffArea::Unstaged);
    assert_eq!(u.hunks.len(), 2);

    apply_lines(
        &s(d),
        &lines(
            "f.txt",
            LineAction::Stage,
            &u,
            vec![HunkSelection {
                hunk: 1,
                lines: None,
            }],
        ),
    )
    .unwrap();
    assert_eq!(index(d, "f.txt"), BASE.replace("14\n", "fourteen\n"));
    assert_eq!(worktree(d, "f.txt"), changed);
}

#[test]
fn stage_unstage_and_discard_single_lines() {
    let r = repo();
    let d = r.path();
    commit(d, "f.txt", b"a\nb\nc\n");
    fs::write(d.join("f.txt"), "a\nB\nc\nd\n").unwrap();

    // Stage only the added "d".
    let u = diff(d, "f.txt", DiffArea::Unstaged);
    let idx = line_index(&u, 0, LineKind::Add, "d");
    apply_lines(
        &s(d),
        &lines(
            "f.txt",
            LineAction::Stage,
            &u,
            vec![HunkSelection {
                hunk: 0,
                lines: Some(vec![idx]),
            }],
        ),
    )
    .unwrap();
    assert_eq!(index(d, "f.txt"), "a\nb\nc\nd\n");

    // Stage "B" replacing "b" (both lines).
    let u = diff(d, "f.txt", DiffArea::Unstaged);
    let del = line_index(&u, 0, LineKind::Delete, "b");
    let add = line_index(&u, 0, LineKind::Add, "B");
    apply_lines(
        &s(d),
        &lines(
            "f.txt",
            LineAction::Stage,
            &u,
            vec![HunkSelection {
                hunk: 0,
                lines: Some(vec![del, add]),
            }],
        ),
    )
    .unwrap();
    assert_eq!(index(d, "f.txt"), "a\nB\nc\nd\n");

    // Unstage only the "d" line.
    let st = diff(d, "f.txt", DiffArea::Staged);
    let idx = line_index(&st, 0, LineKind::Add, "d");
    apply_lines(
        &s(d),
        &lines(
            "f.txt",
            LineAction::Unstage,
            &st,
            vec![HunkSelection {
                hunk: 0,
                lines: Some(vec![idx]),
            }],
        ),
    )
    .unwrap();
    assert_eq!(index(d, "f.txt"), "a\nB\nc\n");
    assert_eq!(worktree(d, "f.txt"), "a\nB\nc\nd\n");

    // Discard the unstaged "d" from the working tree.
    let u = diff(d, "f.txt", DiffArea::Unstaged);
    let idx = line_index(&u, 0, LineKind::Add, "d");
    apply_lines(
        &s(d),
        &lines(
            "f.txt",
            LineAction::Discard,
            &u,
            vec![HunkSelection {
                hunk: 0,
                lines: Some(vec![idx]),
            }],
        ),
    )
    .unwrap();
    assert_eq!(worktree(d, "f.txt"), "a\nB\nc\n");
}

#[test]
fn stale_selection_is_rejected() {
    let r = repo();
    let d = r.path();
    commit(d, "f.txt", b"a\n");
    fs::write(d.join("f.txt"), "b\n").unwrap();
    let u = diff(d, "f.txt", DiffArea::Unstaged);
    fs::write(d.join("f.txt"), "c\n").unwrap();
    let err = apply_lines(
        &s(d),
        &lines(
            "f.txt",
            LineAction::Stage,
            &u,
            vec![HunkSelection {
                hunk: 0,
                lines: None,
            }],
        ),
    )
    .unwrap_err();
    assert_eq!(err.kind(), "stale");
    assert_eq!(index(d, "f.txt"), "a\n");
}

#[test]
fn partial_new_and_deleted_files() {
    let r = repo();
    let d = r.path();
    commit(d, "old.txt", b"x\ny\nz\n");
    // Partially unstage a newly added file.
    fs::write(d.join("new.txt"), "1\n2\n3\n").unwrap();
    git(d, &["add", "new.txt"]);
    let st = diff(d, "new.txt", DiffArea::Staged);
    assert_eq!(st.change.as_deref(), Some("new"));
    let idx = line_index(&st, 0, LineKind::Add, "2");
    apply_lines(
        &s(d),
        &lines(
            "new.txt",
            LineAction::Unstage,
            &st,
            vec![HunkSelection {
                hunk: 0,
                lines: Some(vec![idx]),
            }],
        ),
    )
    .unwrap();
    assert_eq!(index(d, "new.txt"), "1\n3\n");

    // Partially stage a deletion.
    fs::remove_file(d.join("old.txt")).unwrap();
    let u = diff(d, "old.txt", DiffArea::Unstaged);
    assert_eq!(u.change.as_deref(), Some("deleted"));
    let idx = line_index(&u, 0, LineKind::Delete, "y");
    apply_lines(
        &s(d),
        &lines(
            "old.txt",
            LineAction::Stage,
            &u,
            vec![HunkSelection {
                hunk: 0,
                lines: Some(vec![idx]),
            }],
        ),
    )
    .unwrap();
    assert_eq!(index(d, "old.txt"), "x\nz\n");

    // Unstaging the whole new file makes it untracked again.
    let st = diff(d, "new.txt", DiffArea::Staged);
    apply_lines(
        &s(d),
        &lines(
            "new.txt",
            LineAction::Unstage,
            &st,
            vec![HunkSelection {
                hunk: 0,
                lines: None,
            }],
        ),
    )
    .unwrap();
    let info = inspect(&s(d)).unwrap();
    let n = info.changes.iter().find(|c| c.path == "new.txt").unwrap();
    assert_eq!(n.worktree_status, Some(ChangeKind::Untracked));
}

#[test]
fn missing_final_newline_and_crlf() {
    let r = repo();
    let d = r.path();
    commit(d, "nl.txt", b"a\nb");
    fs::write(d.join("nl.txt"), "a\nb\nc").unwrap();
    let u = diff(d, "nl.txt", DiffArea::Unstaged);
    apply_lines(
        &s(d),
        &lines(
            "nl.txt",
            LineAction::Stage,
            &u,
            vec![HunkSelection {
                hunk: 0,
                lines: None,
            }],
        ),
    )
    .unwrap();
    assert_eq!(index(d, "nl.txt"), "a\nb\nc");

    commit(d, "crlf.txt", b"one\r\ntwo\r\nthree\r\n");
    fs::write(d.join("crlf.txt"), "one\r\nTWO\r\nthree\r\nfour\r\n").unwrap();
    let u = diff(d, "crlf.txt", DiffArea::Unstaged);
    assert!(u.hunks[0].lines.iter().all(|l| l.crlf));
    let idx = line_index(&u, 0, LineKind::Add, "four");
    apply_lines(
        &s(d),
        &lines(
            "crlf.txt",
            LineAction::Stage,
            &u,
            vec![HunkSelection {
                hunk: 0,
                lines: Some(vec![idx]),
            }],
        ),
    )
    .unwrap();
    assert_eq!(index(d, "crlf.txt"), "one\r\ntwo\r\nthree\r\nfour\r\n");
}

#[test]
fn locked_index_is_reported() {
    let r = repo();
    let d = r.path();
    commit(d, "f.txt", b"a\n");
    fs::write(d.join("f.txt"), "b\n").unwrap();
    fs::write(d.join(".git/index.lock"), "").unwrap();
    let err = stage_files(&s(d), &["f.txt".into()]).unwrap_err();
    assert_eq!(err.kind(), "locked", "{err:?}");
}

#[test]
fn renamed_files_are_whole_file_only() {
    let r = repo();
    let d = r.path();
    commit(d, "a.txt", b"same content for detection\n");
    git(d, &["mv", "a.txt", "b.txt"]);
    let st = file_diff(d, "b.txt", Some("a.txt"), DiffArea::Staged, false).unwrap();
    assert_eq!(st.change.as_deref(), Some("renamed"));
    assert!(!st.supports_partial);
    unstage_files(&s(d), &["a.txt".into(), "b.txt".into()]).unwrap();
    let info = inspect(&s(d)).unwrap();
    assert!(info.changes.iter().all(|c| c.index_status.is_none()));
}

/// Small deterministic PRNG (xorshift) so the randomized test is reproducible.
struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }
    fn below(&mut self, n: u64) -> u64 {
        self.next() % n
    }
}

/// Expected file after applying a selection, computed independently of the patch builder.
/// `keep_add`/`keep_del` decide which change lines end up in the result.
fn expected_after(
    side_lines: &[String],
    d: &FileDiff,
    chosen: &[Vec<bool>],
    from_old_side: bool,
) -> String {
    let mut out = Vec::new();
    let mut pos = 1u32; // next unconsumed line of the side we copy from
    for (h, hunk) in d.hunks.iter().enumerate() {
        let start = if from_old_side {
            hunk.old_start
        } else {
            hunk.new_start
        };
        while pos < start {
            out.push(side_lines[(pos - 1) as usize].clone());
            pos += 1;
        }
        for (i, l) in hunk.lines.iter().enumerate() {
            let sel = chosen[h][i];
            let (keep, consumes) = match (l.kind, from_old_side) {
                (LineKind::Context, _) => (true, true),
                // Forward (stage): result = old side with selected changes applied.
                (LineKind::Delete, true) => (!sel, true),
                (LineKind::Add, true) => (sel, false),
                // Reverse (unstage/discard): result = new side with selected changes undone.
                (LineKind::Add, false) => (!sel, true),
                (LineKind::Delete, false) => (sel, false),
            };
            if keep {
                out.push(l.content.clone());
            }
            if consumes {
                pos += 1;
            }
        }
    }
    while (pos as usize) <= side_lines.len() {
        out.push(side_lines[(pos - 1) as usize].clone());
        pos += 1;
    }
    out.iter().map(|l| format!("{l}\n")).collect()
}

fn random_edit(rng: &mut Rng, base: &[String]) -> Vec<String> {
    let mut lines = base.to_vec();
    let edits = 1 + rng.below(6);
    for e in 0..edits {
        let at = rng.below(lines.len() as u64 + 1) as usize;
        match rng.below(3) {
            0 if !lines.is_empty() && at < lines.len() => {
                lines.remove(at);
            }
            1 if at < lines.len() => lines[at] = format!("changed {e} {}", rng.below(1000)),
            _ => lines.insert(at, format!("inserted {e} {}", rng.below(1000))),
        }
    }
    lines
}

fn random_selection(rng: &mut Rng, d: &FileDiff) -> (Vec<HunkSelection>, Vec<Vec<bool>>) {
    let mut sels = Vec::new();
    let mut chosen = Vec::new();
    for (h, hunk) in d.hunks.iter().enumerate() {
        let mut flags = vec![false; hunk.lines.len()];
        let mut picked = Vec::new();
        for (i, l) in hunk.lines.iter().enumerate() {
            if l.kind != LineKind::Context && rng.below(2) == 0 {
                flags[i] = true;
                picked.push(i);
            }
        }
        if !picked.is_empty() {
            sels.push(HunkSelection {
                hunk: h,
                lines: Some(picked),
            });
        }
        chosen.push(flags);
    }
    (sels, chosen)
}

fn to_lines(s: &str) -> Vec<String> {
    s.lines().map(str::to_string).collect()
}

#[test]
fn randomized_partial_staging_matches_expected_content() {
    let mut rng = Rng(0x9e37_79b9_7f4a_7c15);
    let base: Vec<String> = (1..=40).map(|i| format!("line {i}")).collect();
    let base_text: String = base.iter().map(|l| format!("{l}\n")).collect();
    let r = repo();
    let d = r.path();
    commit(d, "f.txt", base_text.as_bytes());

    let mut checked = 0;
    for _ in 0..100 {
        // Reset to a clean state.
        git(d, &["reset", "-q", "--hard"]);
        let edited = random_edit(&mut rng, &base);
        let edited_text: String = edited.iter().map(|l| format!("{l}\n")).collect();
        fs::write(d.join("f.txt"), &edited_text).unwrap();

        // Stage a random selection.
        let u = diff(d, "f.txt", DiffArea::Unstaged);
        if u.hunks.is_empty() {
            continue;
        }
        let (sels, chosen) = random_selection(&mut rng, &u);
        if sels.is_empty() {
            continue;
        }
        let expected_index = expected_after(&base, &u, &chosen, true);
        apply_lines(&s(d), &lines("f.txt", LineAction::Stage, &u, sels)).unwrap();
        assert_eq!(index(d, "f.txt"), expected_index, "stage");
        assert_eq!(worktree(d, "f.txt"), edited_text);

        // Unstage a random selection of what is staged now.
        let st = diff(d, "f.txt", DiffArea::Staged);
        if !st.hunks.is_empty() {
            let (sels, chosen) = random_selection(&mut rng, &st);
            if !sels.is_empty() {
                let expected = expected_after(&to_lines(&expected_index), &st, &chosen, false);
                apply_lines(&s(d), &lines("f.txt", LineAction::Unstage, &st, sels)).unwrap();
                assert_eq!(index(d, "f.txt"), expected, "unstage");
            }
        }

        // Discard a random selection of the remaining unstaged changes.
        let u = diff(d, "f.txt", DiffArea::Unstaged);
        if !u.hunks.is_empty() {
            let (sels, chosen) = random_selection(&mut rng, &u);
            if !sels.is_empty() {
                let expected = expected_after(&edited, &u, &chosen, false);
                apply_lines(&s(d), &lines("f.txt", LineAction::Discard, &u, sels)).unwrap();
                assert_eq!(worktree(d, "f.txt"), expected, "discard");
            }
        }
        checked += 1;
    }
    assert!(checked > 50, "only {checked} iterations exercised");
}
