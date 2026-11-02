//! GitLab accounts and the Reviews list, against a small fake GitLab server on localhost.

use std::io::{BufRead, BufReader, Write};
use std::net::TcpListener;
use std::path::Path;
use std::process::Command;
use std::sync::{Arc, Mutex, MutexGuard};

use branchline_lib::forge::accounts::{self, Access, ForgeKind};
use branchline_lib::forge::{gitlab, is_account_page, review_requests, review_source};
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
        p if p.starts_with("/api/v4/projects/group%2Fsub%2Fapp/merge_requests?") => {
            serde_json::json!([mr(11, 1, "group/sub/app!1"), mr(11, 2, "group/sub/app!2")])
                .to_string()
        }
        p if p.starts_with("/api/v4/merge_requests?") => {
            serde_json::json!([mr(11, 1, "group/sub/app!1"), mr(12, 9, "other/lib!9")]).to_string()
        }
        "/api/v4/projects/11/merge_requests/1" => r#"{"head_pipeline":{"status":"failed"}}"#.into(),
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
    let err = review_requests(&path(&t), false).unwrap_err().to_string();
    assert!(err.contains("Settings > Accounts"), "{err}");

    gitlab::connect(&url, TOKEN).unwrap();
    let list = review_requests(&path(&t), false).unwrap();
    assert_eq!(list.project.as_deref(), Some("group/sub/app"));
    assert!(!list.truncated);
    assert_eq!(list.items.len(), 2);
    let first = &list.items[0];
    assert_eq!(first.iid, 1);
    assert_eq!(first.project_path, "group/sub/app");
    assert_eq!(first.author.name, "Tom Jansen");
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
    assert!(query.contains("reviewer_username=ada"), "{query}");
}

#[test]
fn lists_merge_requests_in_all_projects() {
    let _g = serial();
    let (url, _) = fake_gitlab(gitlab_route);
    gitlab::connect(&url, TOKEN).unwrap();
    let t = repo(&[("origin", format!("{url}/group/sub/app.git"))]);
    let list = review_requests(&path(&t), true).unwrap();
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
    let err = review_requests(&path(&gone), false)
        .unwrap_err()
        .to_string();
    assert!(err.contains("could not find the project gone/app"), "{err}");
    let err = review_requests(&path(&gone), true).unwrap_err().to_string();
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
