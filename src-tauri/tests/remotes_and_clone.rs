//! Managing remotes, cloning and creating repositories.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use branchline_lib::git::branches::list_branches;
use branchline_lib::git::create::{clone, init};
use branchline_lib::git::remote::{add_remote, edit_remote, list_remotes, remove_remote};
use branchline_lib::git::repository::{inspect, HeadState};
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

struct Fixture {
    _dir: TempDir,
    base: PathBuf,
}

impl Fixture {
    /// `origin.git` (bare, with one commit on main and a branch `dev`) and `repo` (a clone).
    fn new() -> Self {
        let dir = TempDir::new().unwrap();
        let base = fs::canonicalize(dir.path()).unwrap();
        let seed = base.join("seed");
        fs::create_dir(&seed).unwrap();
        git(&seed, &["init", "-q", "-b", "main"]);
        git(&seed, &["config", "user.name", "T"]);
        git(&seed, &["config", "user.email", "t@example.com"]);
        fs::write(seed.join("a.txt"), "a\n").unwrap();
        git(&seed, &["add", "-A"]);
        git(&seed, &["commit", "-q", "-m", "first"]);
        git(&seed, &["branch", "dev"]);
        git(&base, &["clone", "-q", "--bare", "seed", "origin.git"]);
        git(&base, &["clone", "-q", "origin.git", "repo"]);
        Fixture { _dir: dir, base }
    }
    fn path(&self, name: &str) -> String {
        s(&self.base.join(name))
    }
}

#[test]
fn adds_edits_and_removes_remotes() {
    let f = Fixture::new();
    let repo = f.path("repo");
    let up = f.path("origin.git");

    add_remote(&repo, "upstream", &up).unwrap();
    let names: Vec<String> = list_remotes(&repo)
        .unwrap()
        .into_iter()
        .map(|r| r.name)
        .collect();
    assert_eq!(names, ["origin", "upstream"]);
    assert_eq!(
        add_remote(&repo, "upstream", &up).unwrap_err().kind(),
        "invalidRemote"
    );

    // Rename and set a separate push address in one go.
    edit_remote(
        &repo,
        "upstream",
        "mirror",
        &up,
        "ssh://git@example.com/x.git",
    )
    .unwrap();
    let mirror = list_remotes(&repo)
        .unwrap()
        .into_iter()
        .find(|r| r.name == "mirror")
        .unwrap();
    assert_eq!(mirror.url, up);
    // Shown without the user part, which can be a token.
    assert_eq!(
        mirror.push_url.as_deref(),
        Some("ssh://***@example.com/x.git")
    );
    // Clearing the push address removes it.
    edit_remote(&repo, "mirror", "mirror", &up, "").unwrap();
    assert_eq!(
        git(
            &f.base.join("repo"),
            &["config", "--get-all", "remote.mirror.url"]
        ),
        up
    );
    assert!(list_remotes(&repo)
        .unwrap()
        .iter()
        .all(|r| r.push_url.is_none()));

    // Removing a remote drops its remote-tracking branches.
    git(&f.base.join("repo"), &["fetch", "-q", "mirror"]);
    assert!(list_branches(&f.base.join("repo"))
        .unwrap()
        .remote
        .iter()
        .any(|b| b.name == "mirror/dev"));
    remove_remote(&repo, "mirror").unwrap();
    assert!(list_branches(&f.base.join("repo"))
        .unwrap()
        .remote
        .iter()
        .all(|b| b.remote.as_deref() != Some("mirror")));
    assert_eq!(
        remove_remote(&repo, "mirror").unwrap_err().kind(),
        "unsupported"
    );
}

#[test]
fn a_redacted_url_is_never_written_back() {
    let f = Fixture::new();
    let repo = f.path("repo");
    let dir = f.base.join("repo");
    git(
        &dir,
        &[
            "remote",
            "set-url",
            "origin",
            "https://me:secret@example.com/r.git",
        ],
    );
    let shown = list_remotes(&repo).unwrap().remove(0);
    assert_eq!(shown.url, "https://***@example.com/r.git");
    // Saving the dialog unchanged (only renaming) keeps the real URL.
    edit_remote(&repo, "origin", "github", &shown.url, "").unwrap();
    assert_eq!(
        git(&dir, &["config", "--get", "remote.github.url"]),
        "https://me:secret@example.com/r.git"
    );
}

#[test]
fn remote_names_and_addresses_are_checked() {
    let f = Fixture::new();
    let repo = f.path("repo");
    for name in ["", "-x", ".hidden", "a b", "a..b", "x~1"] {
        assert_eq!(
            add_remote(&repo, name, "https://example.com/r.git")
                .unwrap_err()
                .kind(),
            "invalidRemote",
            "{name:?}"
        );
    }
    for url in [
        "",
        " https://example.com/r.git",
        "--upload-pack=touch /tmp/x",
        "ext::sh -c touch% /tmp/pwned",
        "https://user:token@example.com/r.git",
        "https://example.com/r.git\nother",
    ] {
        assert_eq!(
            add_remote(&repo, "x", url).unwrap_err().kind(),
            "invalidRemote",
            "{url:?}"
        );
    }
    // Usernames without a password are fine (SSH and some HTTPS hosts use them).
    add_remote(&repo, "ssh", "ssh://git@example.com/r.git").unwrap();
    add_remote(&repo, "scp", "git@example.com:team/r.git").unwrap();
}

#[test]
fn clones_into_a_new_or_empty_folder() {
    let f = Fixture::new();
    let mut updates = 0;
    let dest = clone(
        &f.path("origin.git"),
        &f.path("copy"),
        "clone-1",
        &mut |_| updates += 1,
    )
    .unwrap();
    assert_eq!(dest, f.path("copy"));
    let info = inspect(&dest).unwrap();
    assert!(matches!(info.head, HeadState::Branch { ref name, .. } if name == "main"));
    assert_eq!(list_remotes(&dest).unwrap()[0].name, "origin");

    fs::create_dir(f.base.join("empty")).unwrap();
    clone(
        &f.path("origin.git"),
        &f.path("empty"),
        "clone-2",
        &mut |_| {},
    )
    .unwrap();
    assert!(f.base.join("empty").join("a.txt").exists());

    // Not into a folder with files.
    let err = clone(
        &f.path("origin.git"),
        &f.path("repo"),
        "clone-3",
        &mut |_| {},
    )
    .unwrap_err();
    assert_eq!(err.kind(), "invalidPath");
}

#[test]
fn a_failed_clone_leaves_nothing_behind() {
    let f = Fixture::new();
    let err = clone(
        &f.path("nope.git"),
        &f.path("broken"),
        "clone-4",
        &mut |_| {},
    )
    .unwrap_err();
    assert_eq!(err.kind(), "remoteNotFound", "{err:?}");
    assert!(!f.base.join("broken").exists());

    fs::create_dir(f.base.join("kept")).unwrap();
    clone(&f.path("nope.git"), &f.path("kept"), "clone-5", &mut |_| {}).unwrap_err();
    assert!(
        f.base.join("kept").is_dir(),
        "an existing empty folder stays"
    );
    assert_eq!(fs::read_dir(f.base.join("kept")).unwrap().count(), 0);

    for url in ["--upload-pack=x", "ext::sh -c x", ""] {
        assert_eq!(
            clone(url, &f.path("bad"), "clone-6", &mut |_| {})
                .unwrap_err()
                .kind(),
            "invalidRemote"
        );
    }
}

#[test]
fn creates_repositories() {
    let f = Fixture::new();
    // A new folder, with a chosen first branch.
    let dest = init(&f.path("fresh"), "trunk").unwrap();
    let info = inspect(&dest).unwrap();
    assert!(matches!(info.head, HeadState::Unborn { ref name } if name == "trunk"));

    // An existing folder with files keeps them, untracked.
    let docs = f.base.join("docs");
    fs::create_dir(&docs).unwrap();
    fs::write(docs.join("notes.md"), "hi").unwrap();
    init(&s(&docs), "").unwrap();
    assert_eq!(inspect(&s(&docs)).unwrap().total_changes, 1);

    // Not twice, not on a file, not with a bad branch name.
    assert_eq!(init(&s(&docs), "").unwrap_err().kind(), "invalidPath");
    assert_eq!(
        init(&s(&docs.join("notes.md")), "").unwrap_err().kind(),
        "invalidPath"
    );
    assert_eq!(
        init(&f.path("other"), "bad name").unwrap_err().kind(),
        "invalidBranchName"
    );
    assert_eq!(init("relative", "").unwrap_err().kind(), "invalidPath");
}
