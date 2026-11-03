//! GitLab accounts and the Reviews list, against a small fake GitLab server on localhost.

use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::net::TcpListener;
use std::path::Path;
use std::process::Command;
use std::sync::{Arc, Mutex, MutexGuard};

use branchline_lib::forge::accounts::{self, Access, ForgeKind};
use branchline_lib::forge::{
    gitlab, is_account_page, open_request, review_requests, review_source, RequestFilter,
};
use branchline_lib::git::command_log;
use branchline_lib::secrets;
use tempfile::TempDir;

const TOKEN: &str = "glpat-test-token";

/// Accounts and secrets are process-wide, so these tests take turns.
fn serial() -> MutexGuard<'static, ()> {
    static LOCK: Mutex<()> = Mutex::new(());
    let guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    secrets::use_memory_store();
    for a in accounts::list() {
        accounts::remove(a.kind, &a.url).unwrap();
    }
    guard
}

/// One request as the fake server saw it: request line and the PRIVATE-TOKEN header.
type Seen = Arc<Mutex<Vec<(String, Option<String>)>>>;
type Route = fn(&str, Option<&str>) -> (u16, String, &'static str);

/// Serve `route(path, token)` = (status, body, extra headers). Returns the base URL.
fn fake_gitlab(route: Route) -> (String, Seen) {
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
            let mut token = None;
            loop {
                let mut header = String::new();
                if reader.read_line(&mut header).is_err() || header.trim().is_empty() {
                    break;
                }
                if let Some((k, v)) = header.split_once(':') {
                    if k.eq_ignore_ascii_case("private-token") {
                        token = Some(v.trim().to_string());
                    }
                }
            }
            let path = request_line
                .split_whitespace()
                .nth(1)
                .unwrap_or("")
                .to_string();
            log.lock()
                .unwrap()
                .push((request_line.trim().to_string(), token.clone()));
            let (status, body, extra) = route(&path, token.as_deref());
            let _ = write!(
                stream,
                "HTTP/1.1 {status} X\r\nContent-Type: application/json\r\n{extra}Content-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
        }
    });
    (url, seen)
}

fn git(dir: &Path, args: &[&str]) {
    let out = Command::new("git")
        .args(args)
        .current_dir(dir)
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .output()
        .unwrap();
    assert!(out.status.success(), "git {args:?}");
}

/// A repository whose remotes point at the fake server.
fn repo(remotes: &[(&str, String)]) -> TempDir {
    let t = TempDir::new().unwrap();
    git(t.path(), &["init", "-q", "-b", "main"]);
    for (name, url) in remotes {
        git(t.path(), &["remote", "add", name, url]);
    }
    t
}

fn path(t: &TempDir) -> String {
    t.path().to_str().unwrap().to_string()
}

const USER: &str = r#"{"id":7,"username":"ada","name":"Ada Lovelace"}"#;

/// A merge request by `author` with `reviewers`, given as (id, username).
fn mr_by(
    project_id: u64,
    iid: u64,
    full: &str,
    author: (u64, &str),
    reviewers: &[(u64, &str)],
) -> serde_json::Value {
    let mut m = mr(project_id, iid, full);
    m["author"] = serde_json::json!({ "id": author.0, "username": author.1, "name": author.1 });
    m["reviewers"] = reviewers
        .iter()
        .map(|(id, u)| serde_json::json!({ "id": id, "username": u, "name": u }))
        .collect();
    m
}

fn mr(project_id: u64, iid: u64, full: &str) -> serde_json::Value {
    serde_json::json!({
        "project_id": project_id,
        "iid": iid,
        "title": format!("Change {iid}"),
        "web_url": format!("https://gitlab.example/{full}"),
        "author": { "username": "tom", "name": "Tom Jansen" },
        "source_branch": "feature/x",
        "target_branch": "main",
        "draft": iid == 2,
        "created_at": "2026-10-30T09:00:00.000Z",
        "updated_at": "2026-11-01T10:00:00.000Z",
        "user_notes_count": 3,
        "has_conflicts": false,
        "references": { "full": full }
    })
}

fn gitlab_route(path: &str, token: Option<&str>) -> (u16, String, &'static str) {
    if token != Some(TOKEN) {
        return (401, r#"{"message":"401 Unauthorized"}"#.into(), "");
    }
    let body = match path {
        "/api/v4/user" => USER.to_string(),
        "/api/v4/personal_access_tokens/self" => r#"{"scopes":["api"]}"#.into(),
        // Every open merge request of the project; Branchline picks its own.
        p if p.starts_with("/api/v4/projects/group%2Fsub%2Fapp/merge_requests?") => {
            serde_json::json!([
                mr_by(11, 1, "group/sub/app!1", (3, "tom"), &[(7, "ada")]),
                // Same user, other spelling: matched by id.
                mr_by(11, 2, "group/sub/app!2", (3, "tom"), &[(7, "Ada")]),
                // Your own merge request, with yourself as reviewer.
                mr_by(11, 3, "group/sub/app!3", (7, "ada"), &[(7, "ada")]),
                mr_by(11, 4, "group/sub/app!4", (3, "tom"), &[(9, "bob")]),
            ])
            .to_string()
        }
        p if p.starts_with("/api/v4/merge_requests?") => {
            serde_json::json!([mr(11, 1, "group/sub/app!1"), mr(12, 9, "other/lib!9")]).to_string()
        }
        "/api/v4/projects/11/merge_requests/1" => {
            // A full merge request (as GitLab sends it), still without diff_refs.
            let mut m = mr(11, 1, "group/sub/app!1");
            m["head_pipeline"] = serde_json::json!({ "status": "failed" });
            m.to_string()
        }
        "/api/v4/projects/11/merge_requests/1/approvals" => {
            r#"{"approved_by":[{"user":{"username":"ada","name":"Ada"}}]}"#.into()
        }
        "/api/v4/projects/11/merge_requests/2" => r#"{"head_pipeline":null}"#.into(),
        "/api/v4/projects/11/merge_requests/2/approvals" => r#"{"approved_by":[]}"#.into(),
        // Older servers or other errors: extras stay unknown.
        _ => return (404, r#"{"message":"404 Not found"}"#.into(), ""),
    };
    (200, body, "")
}

#[test]
fn connects_with_a_valid_token_and_keeps_it_out_of_the_accounts_file() {
    let _g = serial();
    let dir = TempDir::new().unwrap();
    accounts::init(dir.path().join("accounts.json"));
    let (url, seen) = fake_gitlab(gitlab_route);

    let err = gitlab::connect(&url, "wrong").unwrap_err().to_string();
    assert!(err.contains("did not accept the token"), "{err}");
    assert!(accounts::list().is_empty());

    let account = gitlab::connect(&format!("{url}/"), &format!("  {TOKEN}\n")).unwrap();
    assert_eq!(account.url, url);
    assert_eq!(account.host, "127.0.0.1");
    assert_eq!(account.username, "ada");
    assert_eq!(account.name, "Ada Lovelace");
    assert_eq!(account.access, Access::Write);
    assert_eq!(accounts::list(), vec![account.clone()]);
    assert_eq!(account.token().unwrap(), TOKEN);
    // The token is sent in a header, never in the address.
    assert!(seen
        .lock()
        .unwrap()
        .iter()
        .all(|(line, _)| !line.contains(TOKEN)));
    let file = std::fs::read_to_string(dir.path().join("accounts.json")).unwrap();
    assert!(file.contains("\"username\": \"ada\""), "{file}");
    assert!(!file.contains(TOKEN));

    accounts::remove(ForgeKind::Gitlab, &url).unwrap();
    assert!(accounts::list().is_empty());
    assert!(secrets::get(&account.secret_key()).unwrap().is_none());
}

#[test]
fn tells_read_only_tokens_and_tokens_without_api_access_apart() {
    let _g = serial();
    let (read_only, _) = fake_gitlab(|path, _| match path {
        "/api/v4/user" => (200, USER.into(), ""),
        _ => (200, r#"{"scopes":["read_api","read_user"]}"#.into(), ""),
    });
    assert_eq!(
        gitlab::connect(&read_only, TOKEN).unwrap().access,
        Access::Read
    );
    let (no_api, _) = fake_gitlab(|path, _| match path {
        "/api/v4/user" => (200, USER.into(), ""),
        _ => (200, r#"{"scopes":["read_repository"]}"#.into(), ""),
    });
    let err = gitlab::connect(&no_api, TOKEN).unwrap_err().to_string();
    assert!(err.contains("api scope"), "{err}");
    // Servers that cannot tell (older GitLab) are fine.
    let (old, _) = fake_gitlab(|path, _| match path {
        "/api/v4/user" => (200, USER.into(), ""),
        _ => (404, "{}".into(), ""),
    });
    assert_eq!(
        gitlab::connect(&old, TOKEN).unwrap().access,
        Access::Unknown
    );
}

#[test]
fn refuses_unsafe_addresses_and_odd_servers() {
    let _g = serial();
    for bad in [
        "http://gitlab.example.com",
        "https://ada:pw@gitlab.com",
        "gitlab.com",
    ] {
        assert!(gitlab::connect(bad, TOKEN).is_err(), "{bad}");
    }
    let (html, _) = fake_gitlab(|_, _| (200, "<html>not gitlab</html>".into(), ""));
    let err = gitlab::connect(&html, TOKEN).unwrap_err().to_string();
    assert!(err.contains("does not look like a GitLab server"), "{err}");
    let closed = TcpListener::bind("127.0.0.1:0").unwrap();
    let addr = format!("http://{}", closed.local_addr().unwrap());
    drop(closed);
    let err = gitlab::connect(&addr, TOKEN).unwrap_err().to_string();
    assert!(err.contains("Could not reach GitLab"), "{err}");
}

#[test]
fn lists_merge_requests_to_review_in_the_repositorys_project() {
    let _g = serial();
    let (url, seen) = fake_gitlab(gitlab_route);
    let t = repo(&[("origin", format!("{url}/group/sub/app.git"))]);

    // Without an account the project is known, but there is nothing to list yet.
    let source = review_source(&path(&t)).unwrap().unwrap();
    assert_eq!(source.project, "group/sub/app");
    assert_eq!(source.remote, "origin");
    assert!(source.account.is_none());
    let err = review_requests(&path(&t), false, RequestFilter::ReviewRequested)
        .unwrap_err()
        .to_string();
    assert!(err.contains("Settings > Accounts"), "{err}");

    gitlab::connect(&url, TOKEN).unwrap();
    let list = review_requests(&path(&t), false, RequestFilter::ReviewRequested).unwrap();
    assert_eq!(list.project.as_deref(), Some("group/sub/app"));
    assert!(!list.truncated);
    let iids: Vec<u64> = list.items.iter().map(|m| m.iid).collect();
    assert_eq!(iids, [1, 2, 3], "picked by reviewer id, including your own");
    let first = &list.items[0];
    assert_eq!(first.project_path, "group/sub/app");
    assert_eq!(first.author.name, "tom");
    assert_eq!(first.reviewers[0].username, "ada");
    assert_eq!(first.comments, 3);
    assert_eq!(first.pipeline.as_deref(), Some("failed"));
    assert_eq!(first.approved_by_you, Some(true));
    let second = &list.items[1];
    assert!(second.draft);
    assert_eq!(second.pipeline, None);
    assert_eq!(second.approved_by_you, Some(false));

    let lines: Vec<String> = seen
        .lock()
        .unwrap()
        .iter()
        .map(|(l, _)| l.clone())
        .collect();
    let query = lines
        .iter()
        .find(|l| l.contains("/projects/group%2Fsub%2Fapp/merge_requests?"))
        .expect("asks for the project's merge requests");
    assert!(query.contains("state=opened"), "{query}");
    assert!(
        !query.contains("reviewer_username"),
        "filtered in Branchline: {query}"
    );

    let mine = review_requests(&path(&t), false, RequestFilter::CreatedByYou).unwrap();
    assert_eq!(mine.items.iter().map(|m| m.iid).collect::<Vec<_>>(), [3]);
    let all = review_requests(&path(&t), false, RequestFilter::AllOpen).unwrap();
    assert_eq!(all.items.len(), 4);
    let err = review_requests(&path(&t), true, RequestFilter::AllOpen)
        .unwrap_err()
        .to_string();
    assert!(err.contains("Choose one project"), "{err}");
}

#[test]
fn records_requests_in_the_git_console_without_the_token() {
    let _g = serial();
    let (url, _) = fake_gitlab(gitlab_route);
    gitlab::connect(&url, TOKEN).unwrap();
    let t = repo(&[("origin", format!("{url}/group/sub/app.git"))]);
    review_requests(&path(&t), false, RequestFilter::ReviewRequested).unwrap();
    let entries = command_log::since(0);
    let list = entries
        .iter()
        .find(|e| {
            e.program == "GitLab"
                && e.cwd == url
                && e.args
                    .get(1)
                    .is_some_and(|a| a.contains("group%2Fsub%2Fapp"))
        })
        .expect("the list request is in the console");
    assert_eq!(list.args[0], "GET");
    assert_eq!(list.exit_code, Some(200));
    assert_eq!(list.ok, Some(true));
    assert!(
        !list.read_only,
        "the list is shown with routine reads hidden"
    );
    assert!(list.stdout.contains("\"iid\":1"), "{}", list.stdout);
    // Details per row are routine.
    assert!(entries
        .iter()
        .any(|e| e.program == "GitLab" && e.read_only && e.args[1].ends_with("/approvals")));
    for e in entries
        .iter()
        .filter(|e| e.program == "GitLab" && e.cwd == url)
    {
        let all = format!("{} {:?} {} {}", e.cwd, e.args, e.stdout, e.stderr);
        assert!(!all.contains(TOKEN), "{all}");
    }
}

#[test]
fn lists_merge_requests_in_all_projects() {
    let _g = serial();
    let (url, _) = fake_gitlab(gitlab_route);
    gitlab::connect(&url, TOKEN).unwrap();
    let t = repo(&[("origin", format!("{url}/group/sub/app.git"))]);
    let list = review_requests(&path(&t), true, RequestFilter::ReviewRequested).unwrap();
    assert_eq!(list.project, None);
    let projects: Vec<&str> = list.items.iter().map(|m| m.project_path.as_str()).collect();
    assert_eq!(projects, ["group/sub/app", "other/lib"]);
    // Unknown extras (the fake has none for project 12) stay unknown.
    assert_eq!(list.items[1].pipeline, None);
    assert_eq!(list.items[1].approved_by_you, None);
}

#[test]
fn prefers_upstream_and_remotes_with_an_account() {
    let _g = serial();
    let (url, _) = fake_gitlab(gitlab_route);
    let t = repo(&[
        ("origin", format!("{url}/ada/app.git")),
        ("upstream", format!("{url}/group/sub/app.git")),
        ("github", "git@github.com:acme/app.git".to_string()),
    ]);
    assert_eq!(
        review_source(&path(&t)).unwrap().unwrap().remote,
        "upstream"
    );
    let elsewhere = repo(&[
        ("origin", "git@github.com:acme/app.git".to_string()),
        ("gitlab", format!("{url}/group/sub/app.git")),
    ]);
    // Before connecting: origin, by name. After: the remote with an account.
    assert_eq!(
        review_source(&path(&elsewhere)).unwrap().unwrap().remote,
        "origin"
    );
    gitlab::connect(&url, TOKEN).unwrap();
    assert_eq!(
        review_source(&path(&elsewhere)).unwrap().unwrap().remote,
        "gitlab"
    );
    let local = repo(&[("origin", "/srv/git/app.git".to_string())]);
    assert_eq!(review_source(&path(&local)).unwrap(), None);
}

#[test]
fn explains_missing_projects_and_rate_limits() {
    let _g = serial();
    let (url, _) = fake_gitlab(|path, _| match path {
        "/api/v4/user" => (200, USER.into(), ""),
        "/api/v4/personal_access_tokens/self" => (200, r#"{"scopes":["api"]}"#.into(), ""),
        p if p.starts_with("/api/v4/projects/gone%2Fapp/") => (404, "{}".into(), ""),
        _ => (429, "{}".into(), "Retry-After: 30\r\n"),
    });
    gitlab::connect(&url, TOKEN).unwrap();
    let gone = repo(&[("origin", format!("{url}/gone/app.git"))]);
    let err = review_requests(&path(&gone), false, RequestFilter::ReviewRequested)
        .unwrap_err()
        .to_string();
    assert!(err.contains("could not find the project gone/app"), "{err}");
    let err = review_requests(&path(&gone), true, RequestFilter::ReviewRequested)
        .unwrap_err()
        .to_string();
    assert!(err.contains("Try again in 30 seconds"), "{err}");
}

#[test]
fn opens_only_pages_of_connected_servers() {
    let _g = serial();
    let (url, _) = fake_gitlab(gitlab_route);
    gitlab::connect(&url, TOKEN).unwrap();
    assert!(is_account_page(&format!(
        "{url}/group/app/-/merge_requests/1"
    )));
    assert!(!is_account_page(&url));
    assert!(!is_account_page(&format!("{url}.evil.test/x")));
    assert!(!is_account_page("https://gitlab.com/group/app"));
    assert!(!is_account_page(&format!("{url}/a b")));
}

/// Commit ids for the merge request test's fake server: (base, head).
static MR_SHAS: std::sync::OnceLock<Mutex<(String, String)>> = std::sync::OnceLock::new();

fn detail_route(path: &str, token: Option<&str>) -> (u16, String, &'static str) {
    if token != Some(TOKEN) {
        return (401, "{}".into(), "");
    }
    let (base, head) = MR_SHAS.get().unwrap().lock().unwrap().clone();
    let body = match path {
        "/api/v4/user" => USER.to_string(),
        "/api/v4/personal_access_tokens/self" => r#"{"scopes":["api"]}"#.into(),
        "/api/v4/projects/11/merge_requests/3" => {
            let mut m = mr_by(11, 3, "group/sub/app!3", (3, "tom"), &[(7, "ada")]);
            m["description"] = "Adds the greeting.\n\n- one\n- two".into();
            m["diff_refs"] = serde_json::json!({ "base_sha": base, "head_sha": head, "start_sha": base });
            m["head_pipeline"] = serde_json::json!({ "status": "success" });
            m.to_string()
        }
        "/api/v4/projects/11/merge_requests/3/commits?per_page=100" => serde_json::json!([
            { "id": head, "title": "Add greeting", "author_name": "Tom", "created_at": "2026-11-01T10:00:00Z" }
        ])
        .to_string(),
        "/api/v4/projects/11/merge_requests/3/discussions?per_page=100" => serde_json::json!([
            { "id": "d1", "notes": [
                { "body": "Should this be translated?", "author": { "username": "ada", "name": "Ada" },
                  "created_at": "2026-11-01T11:00:00Z", "resolvable": true, "resolved": false,
                  "position": { "position_type": "text", "head_sha": head, "new_path": "greet.txt",
                                "old_path": "greet.txt", "new_line": 2, "old_line": null } },
                { "body": "Later, yes.", "author": { "username": "tom", "name": "Tom" },
                  "created_at": "2026-11-01T12:00:00Z", "resolvable": true, "resolved": false }
            ]},
            { "id": "d2", "notes": [
                { "body": "added 1 commit", "author": { "username": "tom", "name": "Tom" },
                  "created_at": "2026-11-01T10:00:00Z", "system": true }
            ]},
            { "id": "d3", "notes": [
                { "body": "Old remark", "author": { "username": "ada", "name": "Ada" },
                  "created_at": "2026-10-30T10:00:00Z", "resolvable": true, "resolved": true,
                  "position": { "position_type": "text", "head_sha": "0000000000000000000000000000000000000000",
                                "new_path": "greet.txt", "new_line": 1 } }
            ]},
            { "id": "d4", "notes": [
                { "body": "Looks good overall", "author": { "username": "ada", "name": "Ada" },
                  "created_at": "2026-11-01T13:00:00Z" }
            ]}
        ])
        .to_string(),
        "/api/v4/projects/11/merge_requests/3/approvals" => r#"{"approved_by":[]}"#.into(),
        _ => return (404, "{}".into(), ""),
    };
    (200, body, "")
}

fn out(dir: &Path, args: &[&str]) -> String {
    let o = Command::new("git")
        .args(args)
        .current_dir(dir)
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .output()
        .unwrap();
    assert!(o.status.success(), "git {args:?}");
    String::from_utf8_lossy(&o.stdout).trim().to_string()
}

#[test]
fn opens_a_merge_request_with_its_commits_files_and_threads() {
    let _g = serial();
    let _ = branchline_lib::shell_env::init_with(None);
    let (url, _) = fake_gitlab(detail_route);

    // The "server": a bare repository with main and, like GitLab, the merge request's
    // commits only under refs/merge-requests/3/head.
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
    let base = out(&seed, &["rev-parse", "HEAD"]);
    let bare = t.path().join("server.git");
    git(
        t.path(),
        &[
            "clone",
            "-q",
            "--bare",
            seed.to_str().unwrap(),
            bare.to_str().unwrap(),
        ],
    );
    // The reviewer's clone: origin looks like the GitLab project; Git fetches from the bare.
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
    let remote_url = format!("{url}/group/sub/app.git");
    git(&seed, &["switch", "-q", "-c", "feature"]);
    fs::write(seed.join("greet.txt"), "hi\nhello there\n").unwrap();
    git(&seed, &["commit", "-qam", "Add greeting"]);
    let head = out(&seed, &["rev-parse", "HEAD"]);
    git(
        &seed,
        &[
            "push",
            "-q",
            bare.to_str().unwrap(),
            "feature:refs/merge-requests/3/head",
        ],
    );
    *MR_SHAS.get_or_init(Default::default).lock().unwrap() = (base.clone(), head.clone());

    git(&work, &["remote", "set-url", "origin", &remote_url]);
    git(
        &work,
        &[
            "config",
            &format!("url.{}.insteadOf", bare.display()),
            &remote_url,
        ],
    );
    assert!(Command::new("git")
        .args(["cat-file", "-e", &format!("{head}^{{commit}}")])
        .current_dir(&work)
        .status()
        .map(|s| !s.success())
        .unwrap());

    gitlab::connect(&url, TOKEN).unwrap();
    let repo_path = work.to_str().unwrap();
    let detail = open_request(repo_path, 11, 3, "mr-op", &mut |_| {}).unwrap();
    assert_eq!(detail.base, base);
    assert_eq!(detail.head, head);
    assert_eq!(detail.request.iid, 3);
    assert_eq!(detail.request.pipeline.as_deref(), Some("success"));
    assert_eq!(detail.request.approved_by_you, Some(false));
    assert!(detail.description.starts_with("Adds the greeting."));
    assert_eq!(detail.commits.len(), 1);
    assert_eq!(detail.commits[0].title, "Add greeting");

    // Files and diff come from the local repository, after fetching the merge request ref.
    assert_eq!(detail.files.len(), 1);
    assert_eq!(detail.files[0].path, "greet.txt");
    assert_eq!(detail.files[0].additions, Some(1));
    assert_eq!(
        out(&work, &["rev-parse", "refs/branchline/merge-requests/3"]),
        head
    );
    // Not a branch, so not in Branches or History.
    assert!(!out(&work, &["branch", "-a"]).contains("merge-requests"));
    let root = branchline_lib::git::repository::resolve_root(repo_path).unwrap();
    let diff = branchline_lib::git::diff::range_diff(
        &root,
        &base,
        &head,
        "greet.txt",
        None,
        false,
        &Default::default(),
    )
    .unwrap();
    assert!(diff
        .hunks
        .iter()
        .flat_map(|h| &h.lines)
        .any(|l| l.content == "hello there" && l.new_line == Some(2)));

    // Threads: system notes left out; line threads placed; older versions marked outdated.
    assert_eq!(detail.threads.len(), 3);
    let line = &detail.threads[0];
    assert_eq!(line.notes.len(), 2);
    assert_eq!(line.resolved, Some(false));
    let pos = line.position.as_ref().unwrap();
    assert_eq!(
        (pos.path.as_str(), pos.new_line, pos.outdated),
        ("greet.txt", Some(2), false)
    );
    assert!(detail.threads[1].position.as_ref().unwrap().outdated);
    assert_eq!(detail.threads[1].resolved, Some(true));
    assert!(detail.threads[2].position.is_none());
    assert_eq!(detail.threads[2].resolved, None);

    // Opening again does not fetch: the commits are here.
    let before = command_log::since(0)
        .iter()
        .filter(|e| e.args.first().map(String::as_str) == Some("fetch"))
        .count();
    open_request(repo_path, 11, 3, "mr-op-2", &mut |_| {}).unwrap();
    let after = command_log::since(0)
        .iter()
        .filter(|e| e.args.first().map(String::as_str) == Some("fetch"))
        .count();
    assert_eq!(before, after);
}

#[test]
fn refuses_unprepared_merge_requests_and_other_projects() {
    let _g = serial();
    let (url, _) = fake_gitlab(gitlab_route);
    gitlab::connect(&url, TOKEN).unwrap();
    let t = repo(&[("origin", format!("{url}/group/sub/app.git"))]);
    // GitLab sends no diff_refs while it still computes the changes.
    let err = open_request(&path(&t), 11, 1, "op", &mut |_| {})
        .unwrap_err()
        .to_string();
    assert!(err.contains("not prepared"), "{err}");

    // Both fakes run on 127.0.0.1, and accounts are matched by host: use one at a time.
    accounts::remove(ForgeKind::Gitlab, &url).unwrap();
    let (url, _) = fake_gitlab(detail_route);
    MR_SHAS.get_or_init(Default::default);
    gitlab::connect(&url, TOKEN).unwrap();
    // Merge request 3 belongs to group/sub/app; this repository is another project.
    let other = repo(&[("origin", format!("{url}/other/lib.git"))]);
    let err = open_request(&path(&other), 11, 3, "op", &mut |_| {})
        .unwrap_err()
        .to_string();
    assert!(err.contains("belongs to group/sub/app"), "{err}");
}
