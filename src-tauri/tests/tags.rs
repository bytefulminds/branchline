//! Tags against real repositories and a local bare remote.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use branchline_lib::git::remote::{push_tag, Progress};
use branchline_lib::git::tags::{check_tag_name, create_tag, delete_tag, list_tags};
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
    git(d, &["config", "user.name", "Tess Tagger"]);
    git(d, &["config", "user.email", "tess@example.com"]);
    git(d, &["config", "commit.gpgsign", "false"]);
    git(d, &["config", "tag.gpgsign", "false"]);
}

fn commit(d: &Path, msg: &str) -> String {
    fs::write(d.join("f.txt"), msg).unwrap();
    git(d, &["add", "-A"]);
    git(d, &["commit", "-q", "-m", msg]);
    git(d, &["rev-parse", "HEAD"])
}

fn s(p: &Path) -> String {
    p.to_str().unwrap().to_string()
}

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
    commit(&seed, "first");
    git(root, &["clone", "-q", "--bare", "seed", "remote.git"]);
    for name in ["a", "b"] {
        git(root, &["clone", "-q", "remote.git", name]);
        configure(&root.join(name));
    }
    Setup {
        remote: root.join("remote.git"),
        a: root.join("a"),
        b: root.join("b"),
        _tmp: tmp,
    }
}

fn no_progress() -> impl FnMut(Progress) {
    |_| {}
}

#[test]
fn create_list_and_delete_tags() {
    let t = setup();
    let first = git(&t.a, &["rev-parse", "HEAD"]);
    let second = commit(&t.a, "second");

    create_tag(&s(&t.a), "v1.0", &first, "").unwrap();
    create_tag(&s(&t.a), "v2.0", &second, "Release 2\n\nWith notes.").unwrap();

    let tags = list_tags(&s(&t.a)).unwrap();
    let names: Vec<_> = tags.iter().map(|t| t.name.as_str()).collect();
    assert_eq!(names.len(), 2);
    let v1 = tags.iter().find(|t| t.name == "v1.0").unwrap();
    let v2 = tags.iter().find(|t| t.name == "v2.0").unwrap();
    assert!(!v1.annotated);
    assert_eq!(v1.target, first);
    assert_eq!(
        v1.subject, "first",
        "lightweight tags show the commit subject"
    );
    assert!(v2.annotated);
    assert_eq!(
        v2.target, second,
        "annotated tags are peeled to their commit"
    );
    assert_eq!(v2.subject, "Release 2");
    assert_eq!(v2.tagger.as_deref(), Some("Tess Tagger"));
    assert!(v2.is_commit);

    delete_tag(&s(&t.a), "v1.0").unwrap();
    assert_eq!(list_tags(&s(&t.a)).unwrap().len(), 1);
    assert_eq!(
        git(&t.a, &["rev-parse", "HEAD"]),
        second,
        "commits are untouched"
    );
    assert_eq!(delete_tag(&s(&t.a), "v1.0").unwrap_err().kind(), "stale");
}

#[test]
fn names_are_validated_and_duplicates_refused() {
    let t = setup();
    let head = git(&t.a, &["rev-parse", "HEAD"]);
    for bad in [
        "",
        "has space",
        "-f",
        "--delete",
        "a..b",
        "x~1",
        "end.lock",
        "HEAD",
    ] {
        let err = create_tag(&s(&t.a), bad, &head, "").unwrap_err();
        assert_eq!(err.kind(), "invalidTagName", "{bad:?}");
        assert!(check_tag_name(&s(&t.a), bad).unwrap().is_some(), "{bad:?}");
    }
    assert_eq!(check_tag_name(&s(&t.a), "release/1.0").unwrap(), None);
    create_tag(&s(&t.a), "release/1.0", &head, "").unwrap();
    assert_eq!(
        check_tag_name(&s(&t.a), "release/1.0").unwrap().as_deref(),
        Some("A tag named release/1.0 already exists.")
    );
    assert_eq!(
        create_tag(&s(&t.a), "release/1.0", &head, "")
            .unwrap_err()
            .kind(),
        "invalidTagName"
    );
    // Targets must be commit ids, never revision expressions or options.
    for target in ["HEAD", "main~1", "--all"] {
        assert!(create_tag(&s(&t.a), "t", target, "").is_err(), "{target}");
    }
    // Messages are never read as options.
    create_tag(&s(&t.a), "msg", &head, "--force -d").unwrap();
    assert_eq!(list_tags(&s(&t.a)).unwrap()[0].subject, "--force -d");
}

#[test]
fn push_and_delete_tags_on_the_remote() {
    let t = setup();
    let head = git(&t.a, &["rev-parse", "HEAD"]);
    create_tag(&s(&t.a), "v1", &head, "One").unwrap();

    let outcome = push_tag(&s(&t.a), "v1", "origin", false, "t1", &mut no_progress()).unwrap();
    assert_eq!(outcome.target.as_deref(), Some("origin/v1"));
    assert!(!outcome.up_to_date);
    assert_eq!(git(&t.remote, &["tag"]), "v1");

    let again = push_tag(&s(&t.a), "v1", "origin", false, "t2", &mut no_progress()).unwrap();
    assert!(again.up_to_date);

    push_tag(&s(&t.a), "v1", "origin", true, "t3", &mut no_progress()).unwrap();
    assert_eq!(git(&t.remote, &["tag"]), "");
    // Deleting a tag that is already gone on the remote is fine.
    let gone = push_tag(&s(&t.a), "v1", "origin", true, "t4", &mut no_progress()).unwrap();
    assert!(gone.up_to_date);
}

#[test]
fn a_different_tag_on_the_remote_is_never_overwritten() {
    let t = setup();
    let theirs = commit(&t.b, "teammate");
    git(&t.b, &["push", "-q"]);
    git(&t.b, &["tag", "v1", &theirs]);
    git(&t.b, &["push", "-q", "origin", "v1"]);

    let mine = git(&t.a, &["rev-parse", "HEAD"]);
    create_tag(&s(&t.a), "v1", &mine, "").unwrap();
    let err = push_tag(&s(&t.a), "v1", "origin", false, "t", &mut no_progress()).unwrap_err();
    assert_eq!(err.kind(), "tagConflict", "{err:?}");
    assert_eq!(git(&t.remote, &["rev-parse", "v1"]), theirs);
}

#[test]
fn pushing_validates_names_remotes_and_existence() {
    let t = setup();
    for (name, remote) in [("-f", "origin"), ("v1", "--receive-pack=x"), ("v1", "nope")] {
        let err = push_tag(&s(&t.a), name, remote, false, "t", &mut no_progress()).unwrap_err();
        assert!(
            matches!(err.kind(), "invalidTagName" | "unsupported"),
            "{name} {remote}: {}",
            err.kind()
        );
    }
    let err = push_tag(
        &s(&t.a),
        "missing",
        "origin",
        false,
        "t",
        &mut no_progress(),
    )
    .unwrap_err();
    assert_eq!(err.kind(), "stale");
}
