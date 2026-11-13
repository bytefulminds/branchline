//! Bitbucket Cloud accounts and pull requests, against a small fake Bitbucket API on
//! localhost and real Git repositories (one of them a fork).

use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::net::TcpListener;
use std::path::Path;
use std::process::Command;
use std::sync::{Arc, Mutex, MutexGuard, OnceLock};

use branchline_lib::forge::accounts::{self, Access, Account, ForgeKind};
use branchline_lib::forge::{
    bitbucket, open_request, review_requests, review_source, RequestFilter,
};
use branchline_lib::secrets;
use tempfile::TempDir;

const EMAIL: &str = "ada@example.com";
const TOKEN: &str = "ATATT-test-token";
/// `ada@example.com:ATATT-test-token`, as Basic credentials.
const AUTH: &str = "Basic YWRhQGV4YW1wbGUuY29tOkFUQVRULXRlc3QtdG9rZW4=";
const ME: &str = "{ada-uuid}";

fn serial() -> MutexGuard<'static, ()> {
    static LOCK: Mutex<()> = Mutex::new(());
    let guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    secrets::use_memory_store();
    for a in accounts::list() {
        accounts::remove(a.kind, &a.url).unwrap();
    }
    guard
}

type Seen = Arc<Mutex<Vec<String>>>;

/// Serve `route(path)` when the Basic credentials are right, 401 otherwise.
fn fake_bitbucket(route: fn(&str) -> (u16, String)) -> (String, Seen) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let seen: Seen = Arc::default();
    let log = seen.clone();
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(mut stream) = stream else { break };
            let mut reader = BufReader::new(stream.try_clone().unwrap());
            let mut request_line = String::new();
            if reader.read_line(&mut request_line).is_err() {
                continue;
            }
            let mut auth = None;
            loop {
                let mut header = String::new();
                if reader.read_line(&mut header).is_err() || header.trim().is_empty() {
                    break;
                }
                if let Some((k, v)) = header.split_once(':') {
                    if k.eq_ignore_ascii_case("authorization") {
                        auth = Some(v.trim().to_string());
                    }
                }
            }
            let path = request_line
                .split_whitespace()
                .nth(1)
                .unwrap_or("")
                .to_string();
            log.lock().unwrap().push(path.clone());
            let (status, body) = if auth.as_deref() == Some(AUTH) {
                route(&path)
            } else {
                (401, r#"{"type":"error"}"#.into())
            };
            let _ = write!(
                stream,
                "HTTP/1.1 {status} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
        }
    });
    (url, seen)
}

fn git(dir: &Path, args: &[&str]) -> String {
    let o = Command::new("git")
        .args(args)
        .current_dir(dir)
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .output()
        .unwrap();
    assert!(
        o.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&o.stderr)
    );
    String::from_utf8_lossy(&o.stdout).trim().to_string()
}

fn user(uuid: &str, nick: &str) -> serde_json::Value {
    serde_json::json!({ "uuid": uuid, "nickname": nick, "display_name": nick.to_uppercase() })
}

/// The commits the fake API reports: (target tip, same-repo head, fork head), short.
static SHAS: OnceLock<Mutex<(String, String, String)>> = OnceLock::new();

fn pr(
    id: u64,
    author: &str,
    reviewers: &[&str],
    source_repo: &str,
    branch: &str,
) -> serde_json::Value {
    let (target, head, fork_head) = SHAS.get_or_init(Default::default).lock().unwrap().clone();
    serde_json::json!({
        "id": id,
        "title": format!("Change {id}"),
        "description": "Adds the greeting.",
        "author": user(&format!("{{{author}-uuid}}"), author),
        "source": { "branch": { "name": branch },
                    "commit": { "hash": if source_repo == "acme/app" { head } else { fork_head } },
                    "repository": { "full_name": source_repo } },
        "destination": { "branch": { "name": "main" }, "commit": { "hash": target },
                         "repository": { "full_name": "acme/app" } },
        "participants": reviewers.iter().map(|r| serde_json::json!({
            "user": user(&format!("{{{r}-uuid}}"), r), "role": "REVIEWER", "approved": *r == "ada"
        })).collect::<Vec<_>>(),
        "draft": id == 2,
        "comment_count": 3,
        "created_on": "2026-11-01T10:00:00+00:00",
        "updated_on": "2026-11-02T10:00:00+00:00",
        "links": { "html": { "href": format!("https://bitbucket.org/acme/app/pull-requests/{id}") } }
    })
}

fn route(path: &str) -> (u16, String) {
    let (path, query) = path.split_once('?').unwrap_or((path, ""));
    let json = |v: serde_json::Value| (200, v.to_string());
    match path {
        "/2.0/user" => json(user(ME, "ada")),
        "/2.0/repositories/acme/app/pullrequests" => {
            assert!(
                query.contains("state=OPEN") && query.contains("values.participants"),
                "{query}"
            );
            json(serde_json::json!({ "values": [
                pr(1, "bob", &["ada"], "acme/app", "feature"),
                pr(2, "ada", &["bob"], "acme/app", "feature"),
                pr(3, "cy", &[], "acme/app", "feature"),
            ]}))
        }
        // Removed by Bitbucket in April 2026 (CHANGE-2770), as it answers today.
        "/2.0/pullrequests/%7Bada-uuid%7D" => (
            404,
            r#"{"type":"error","error":{"message":"There is no API hosted at this URL."}}"#.into(),
        ),
        "/2.0/user/workspaces" => json(serde_json::json!({ "values": [
            { "administrator": false, "workspace": { "slug": "acme", "name": "Acme" } },
            { "administrator": true, "workspace": { "slug": "ada-home", "name": "Ada" } },
            { "administrator": false, "workspace": { "slug": "gone", "name": "Gone" } }
        ]})),
        "/2.0/workspaces/acme/pullrequests/%7Bada-uuid%7D" => {
            assert!(query.contains("state=OPEN"), "{query}");
            json(serde_json::json!({ "values": [pr(2, "ada", &["bob"], "acme/app", "feature")] }))
        }
        "/2.0/workspaces/ada-home/pullrequests/%7Bada-uuid%7D" => {
            let mut newer = pr(7, "ada", &[], "acme/app", "feature");
            newer["destination"]["repository"]["full_name"] = "ada-home/notes".into();
            newer["updated_on"] = "2026-11-05T10:00:00+00:00".into();
            json(serde_json::json!({ "values": [newer] }))
        }
        // A workspace you lost access to does not hide the others.
        "/2.0/workspaces/gone/pullrequests/%7Bada-uuid%7D" => (403, r#"{"type":"error"}"#.into()),
        p if p.ends_with("/statuses") => {
            json(serde_json::json!({ "values": [{ "state": "SUCCESSFUL" }] }))
        }
        "/2.0/repositories/acme/app/pullrequests/1" => {
            json(pr(1, "bob", &["ada"], "acme/app", "feature"))
        }
        "/2.0/repositories/acme/app/pullrequests/4" => json(pr(4, "me", &["ada"], "me/app", "fix")),
        p if p.ends_with("/commits") => json(serde_json::json!({ "values": [
            { "hash": "a".repeat(40), "message": "Add greeting\n\nLonger text", "date": "2026-11-01T10:00:00+00:00",
              "author": { "raw": "Bob <bob@example.com>" } }
        ]})),
        p if p.ends_with("/comments") && !query.contains("page=2") => {
            json(serde_json::json!({
                "values": [
                    { "id": 10, "content": { "raw": "Why hello?" }, "created_on": "2026-11-01T11:00:00Z",
                      "user": user("{bob-uuid}", "bob"), "inline": { "path": "greet.txt", "to": 2 } }
                ],
                // The next page is followed on the same API only.
                "next": "http://elsewhere.example/2.0/x?page=2"
            }))
        }
        _ => (404, r#"{"type":"error"}"#.into()),
    }
}

#[test]
fn connects_with_email_and_api_token() {
    let _g = serial();
    let dir = TempDir::new().unwrap();
    accounts::init(dir.path().join("accounts.json"));
    let (url, seen) = fake_bitbucket(route);

    let err = bitbucket::connect(&url, EMAIL, "wrong")
        .unwrap_err()
        .to_string();
    assert!(err.contains("Atlassian"), "{err}");
    let err = bitbucket::connect(&url, "ada", TOKEN)
        .unwrap_err()
        .to_string();
    assert!(err.contains("email address"), "{err}");
    let err = bitbucket::connect("https://bitbucket.example.com", EMAIL, TOKEN)
        .unwrap_err()
        .to_string();
    assert!(err.contains("Bitbucket Cloud"), "{err}");
    assert!(accounts::list().is_empty());

    let account = bitbucket::connect(&url, &format!(" {EMAIL} "), &format!("{TOKEN}\n")).unwrap();
    assert_eq!(account.kind, ForgeKind::Bitbucket);
    assert_eq!(account.host, "127.0.0.1");
    assert_eq!(account.username, "ada");
    assert_eq!(account.name, "ADA");
    assert_eq!(account.uid.as_deref(), Some(ME));
    assert_eq!(account.access, Access::Unknown);
    assert_eq!(account.token().unwrap(), format!("{EMAIL}:{TOKEN}"));
    assert!(seen.lock().unwrap().iter().all(|p| !p.contains(TOKEN)));
    let file = fs::read_to_string(dir.path().join("accounts.json")).unwrap();
    assert!(file.contains("\"kind\": \"bitbucket\""), "{file}");
    assert!(!file.contains(TOKEN) && !file.contains(EMAIL));
}

#[test]
fn lists_pull_requests_of_the_repository_by_role() {
    let _g = serial();
    let (url, seen) = fake_bitbucket(route);
    bitbucket::connect(&url, EMAIL, TOKEN).unwrap();
    let t = TempDir::new().unwrap();
    git(t.path(), &["init", "-q", "-b", "main"]);
    git(
        t.path(),
        &["remote", "add", "origin", &format!("{url}/acme/app.git")],
    );
    let repo = t.path().to_str().unwrap();

    let list = review_requests(repo, false, RequestFilter::ReviewRequested).unwrap();
    assert_eq!(list.project.as_deref(), Some("acme/app"));
    assert_eq!(list.items.len(), 1);
    let pr = &list.items[0];
    assert_eq!((pr.iid, pr.project_path.as_str()), (1, "acme/app"));
    assert_eq!(pr.author.name, "BOB");
    assert_eq!(pr.reviewers[0].username, "ada");
    assert_eq!(pr.approved_by_you, Some(true));
    assert_eq!(pr.pipeline.as_deref(), Some("success"));
    assert_eq!(pr.web_url, "https://bitbucket.org/acme/app/pull-requests/1");

    let mine = review_requests(repo, false, RequestFilter::CreatedByYou).unwrap();
    assert_eq!(
        mine.items.iter().map(|p| p.iid).collect::<Vec<_>>(),
        vec![2]
    );
    assert!(mine.items[0].draft);
    let all = review_requests(repo, false, RequestFilter::AllOpen).unwrap();
    assert_eq!(all.items.len(), 3);

    // Across all repositories: yours, by user id; to review needs a repository.
    // Bitbucket removed the cross-workspace endpoint, so each workspace is asked; newest first.
    let everywhere = review_requests(repo, true, RequestFilter::CreatedByYou).unwrap();
    let found: Vec<(String, u64)> = everywhere
        .items
        .iter()
        .map(|p| (p.project_path.clone(), p.iid))
        .collect();
    assert_eq!(
        found,
        vec![
            ("ada-home/notes".to_string(), 7),
            ("acme/app".to_string(), 2)
        ]
    );
    assert!(seen
        .lock()
        .unwrap()
        .iter()
        .all(|p| !p.starts_with("/2.0/pullrequests/")));
    let err = review_requests(repo, true, RequestFilter::ReviewRequested)
        .unwrap_err()
        .to_string();
    assert!(err.contains("per repository"), "{err}");
}

#[test]
fn opens_pull_requests_from_a_branch_and_from_a_fork() {
    let _g = serial();
    let _ = branchline_lib::shell_env::init_with(None);
    let (url, seen) = fake_bitbucket(route);

    // The "server": acme/app with main and feature, and the fork me/app with fix. main moves
    // on after feature branched off, so the diff starts at the merge base, not main's tip.
    let t = TempDir::new().unwrap();
    let seed = t.path().join("seed");
    fs::create_dir(&seed).unwrap();
    git(&seed, &["init", "-q", "-b", "main"]);
    git(&seed, &["config", "user.name", "T"]);
    git(&seed, &["config", "user.email", "t@example.com"]);
    git(&seed, &["config", "commit.gpgsign", "false"]);
    fs::write(seed.join("greet.txt"), "hi\n").unwrap();
    git(&seed, &["add", "."]);
    git(&seed, &["commit", "-qm", "Initial"]);
    let base = git(&seed, &["rev-parse", "HEAD"]);
    let bare = t.path().join("app.git");
    let fork = t.path().join("fork.git");
    for b in [&bare, &fork] {
        git(
            t.path(),
            &[
                "clone",
                "-q",
                "--bare",
                seed.to_str().unwrap(),
                b.to_str().unwrap(),
            ],
        );
    }
    let work = t.path().join("work");
    git(
        t.path(),
        &[
            "clone",
            "-q",
            bare.to_str().unwrap(),
            work.to_str().unwrap(),
        ],
    );

    git(&seed, &["switch", "-q", "-c", "feature"]);
    fs::write(seed.join("greet.txt"), "hi\nhello there\n").unwrap();
    git(&seed, &["commit", "-qam", "Add greeting"]);
    let head = git(&seed, &["rev-parse", "HEAD"]);
    git(&seed, &["switch", "-q", "-c", "fix", &base]);
    fs::write(seed.join("other.txt"), "fixed\n").unwrap();
    git(&seed, &["add", "."]);
    git(&seed, &["commit", "-qm", "Fix"]);
    let fork_head = git(&seed, &["rev-parse", "HEAD"]);
    git(&seed, &["switch", "-q", "main"]);
    fs::write(seed.join("later.txt"), "later\n").unwrap();
    // main changes the line feature/x adds under, so merging feature would conflict.
    fs::write(seed.join("greet.txt"), "hey\n").unwrap();
    git(&seed, &["add", "."]);
    git(&seed, &["commit", "-qm", "Later on main"]);
    let target = git(&seed, &["rev-parse", "HEAD"]);
    git(
        &seed,
        &["push", "-q", bare.to_str().unwrap(), "main", "feature"],
    );
    git(&seed, &["push", "-q", fork.to_str().unwrap(), "fix"]);
    // Bitbucket reports abbreviated hashes.
    *SHAS.get_or_init(Default::default).lock().unwrap() = (
        target[..12].to_string(),
        head[..12].to_string(),
        fork_head[..12].to_string(),
    );

    let remote_url = format!("{url}/acme/app.git");
    let fork_url = format!("{url}/me/app.git");
    git(&work, &["remote", "set-url", "origin", &remote_url]);
    git(
        &work,
        &[
            "config",
            &format!("url.{}.insteadOf", bare.display()),
            &remote_url,
        ],
    );
    git(
        &work,
        &[
            "config",
            &format!("url.{}.insteadOf", fork.display()),
            &fork_url,
        ],
    );

    bitbucket::connect(&url, EMAIL, TOKEN).unwrap();
    let repo = work.to_str().unwrap();
    let detail = open_request(repo, 0, 1, "pr-op", &mut |_| {}).unwrap();
    assert_eq!(detail.base, base);
    assert_eq!(detail.head, head);
    assert_eq!(detail.description, "Adds the greeting.");
    assert_eq!(detail.commits[0].title, "Add greeting");
    assert_eq!(detail.commits[0].author_name, "Bob");
    assert_eq!(detail.files.len(), 1);
    assert_eq!(detail.files[0].path, "greet.txt");
    // Bitbucket does not report conflicts; the trial merge with the target finds them.
    assert_eq!(detail.conflict_files, Some(vec!["greet.txt".to_string()]));
    assert!(detail.request.has_conflicts);
    assert_eq!(
        git(
            &work,
            &["rev-parse", "refs/branchline/pull-requests/1/head"]
        ),
        head
    );
    assert!(!git(&work, &["branch", "-a"]).contains("pull-requests"));
    assert_eq!(detail.threads.len(), 1);
    let pos = detail.threads[0].position.as_ref().unwrap();
    assert_eq!((pos.path.as_str(), pos.new_line), ("greet.txt", Some(2)));
    // The `next` link to another host was not followed.
    assert!(seen.lock().unwrap().iter().all(|p| !p.contains("page=2")));

    let fork_detail = open_request(repo, 0, 4, "pr-op-2", &mut |_| {}).unwrap();
    assert_eq!(fork_detail.head, fork_head);
    assert_eq!(fork_detail.base, base);
    assert_eq!(fork_detail.files[0].path, "other.txt");
    assert_eq!(fork_detail.conflict_files, Some(vec![]));
    assert!(!fork_detail.request.has_conflicts);
}

#[test]
fn matches_remotes_on_bitbucket_s_ssh_host() {
    let _g = serial();
    // Bitbucket Cloud moved SSH to ssh.bitbucket.org; the account is on bitbucket.org.
    accounts::upsert(Account {
        kind: ForgeKind::Bitbucket,
        url: bitbucket::CLOUD_URL.into(),
        host: "bitbucket.org".into(),
        id: 0,
        uid: Some(ME.into()),
        username: "ada".into(),
        name: "Ada".into(),
        access: Access::Unknown,
    })
    .unwrap();
    for remote in [
        "git@ssh.bitbucket.org:acme/app.git",
        "ssh://git@altssh.bitbucket.org:443/acme/app.git",
        "git@bitbucket.org:acme/app.git",
    ] {
        let t = TempDir::new().unwrap();
        git(t.path(), &["init", "-q", "-b", "main"]);
        git(t.path(), &["remote", "add", "origin", remote]);
        let source = review_source(t.path().to_str().unwrap()).unwrap().unwrap();
        assert_eq!(source.host, "bitbucket.org", "{remote}");
        assert_eq!(source.project, "acme/app");
        assert_eq!(
            source.account.map(|a| a.kind),
            Some(ForgeKind::Bitbucket),
            "{remote}"
        );
    }

    // A remote Branchline cannot match says so, instead of only pointing at repositories.
    let t = TempDir::new().unwrap();
    git(t.path(), &["init", "-q", "-b", "main"]);
    git(
        t.path(),
        &[
            "remote",
            "add",
            "origin",
            "git@no-such-alias-here:acme/app.git",
        ],
    );
    let err = review_requests(
        t.path().to_str().unwrap(),
        false,
        RequestFilter::ReviewRequested,
    )
    .unwrap_err()
    .to_string();
    assert!(err.contains("no-such-alias-here"), "{err}");
}
