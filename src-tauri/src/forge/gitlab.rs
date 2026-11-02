//! GitLab REST API (v4): check a token, list merge requests waiting for a review.
//!
//! Only the server address the user connected is contacted. The token goes in the
//! `PRIVATE-TOKEN` header, never in a URL, and never reaches the frontend.

use std::time::Duration;

use serde::{Deserialize, Serialize};

use super::accounts::{self, Access, Account, ForgeKind};
use crate::ai::{agent, is_loopback};
use crate::error::GitError;
use crate::secrets;

/// At most this many merge requests are listed (newest activity first).
pub const MAX_REVIEWS: usize = 50;
/// Extra calls per merge request (pipeline and approvals) run this many at a time.
const PARALLEL: usize = 6;

fn forge(msg: impl Into<String>) -> GitError {
    GitError::Forge(msg.into())
}

/// Check and normalize a GitLab address: `https://` (or `http://` for a server on this
/// computer), a host, an optional port and path (for GitLab installed under a path), and
/// no credentials, query or fragment.
pub fn server_url(raw: &str) -> Result<String, GitError> {
    let url = raw.trim().trim_end_matches('/');
    if url.is_empty() {
        return Err(forge(
            "Enter the address of your GitLab server, for example https://gitlab.com.",
        ));
    }
    let lower = url.to_ascii_lowercase();
    let rest = if let Some(r) = lower.strip_prefix("https://") {
        r
    } else if let Some(r) = lower.strip_prefix("http://") {
        if !is_loopback(url) {
            return Err(forge(
                "Use an https:// address, so the token is never sent unencrypted.",
            ));
        }
        r
    } else {
        return Err(forge("The address must start with https://."));
    };
    let host = rest.split('/').next().unwrap_or("");
    if host.is_empty() || rest.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return Err(forge(
            "The address is missing a host name, or contains spaces.",
        ));
    }
    if rest.contains('@') {
        return Err(forge(
            "Leave user names and passwords out of the address; the token goes in its own field.",
        ));
    }
    if rest.contains(['?', '#']) {
        return Err(forge(
            "Use only the server address, for example https://gitlab.example.com.",
        ));
    }
    Ok(url.to_string())
}

/// Where to make a personal access token, with the name and scope filled in.
pub fn token_page(raw_url: &str) -> Result<String, GitError> {
    let url = server_url(raw_url)?;
    Ok(format!(
        "{url}/-/user_settings/personal_access_tokens?name=Branchline&scopes=api"
    ))
}

struct Response {
    status: u16,
    body: String,
    retry_after: Option<String>,
}

fn get(base: &str, token: &str, path_and_query: &str) -> Result<Response, GitError> {
    let agent = agent(base, Duration::from_secs(15), Duration::from_secs(30));
    let url = format!("{base}/api/v4{path_and_query}");
    let mut res = agent
        .get(&url)
        .header("PRIVATE-TOKEN", token)
        .header("Accept", "application/json")
        .call()
        .map_err(|e| unreachable(base, e))?;
    let status = res.status().as_u16();
    let retry_after = res
        .headers()
        .get("retry-after")
        .and_then(|v| v.to_str().ok())
        .map(str::to_string);
    let body = res
        .body_mut()
        .with_config()
        .limit(8 * 1024 * 1024)
        .read_to_string()
        .map_err(|e| unreachable(base, e))?;
    Ok(Response {
        status,
        body,
        retry_after,
    })
}

fn unreachable(base: &str, err: ureq::Error) -> GitError {
    match err {
        ureq::Error::Timeout(_) => forge(format!(
            "GitLab at {base} did not answer in time. Try again in a moment."
        )),
        ureq::Error::HostNotFound => forge(format!(
            "Could not find the server {base}. Check the address in Settings > Accounts."
        )),
        _ => forge(format!(
            "Could not reach GitLab at {base}. Check your network connection and the address."
        )),
    }
}

/// Turn an unsuccessful status into a message that says what to do.
fn status_error(res: &Response, what: &str) -> GitError {
    match res.status {
        401 => forge(
            "GitLab did not accept the token. It may be incomplete, expired or revoked; \
             make a new one and connect the account again in Settings > Accounts.",
        ),
        403 => forge(format!(
            "The token is not allowed to read {what}. Give it the read_api or api scope."
        )),
        404 => forge(format!(
            "GitLab could not find {what}, or your account has no access to it."
        )),
        429 => forge(match &res.retry_after {
            Some(s) => format!("GitLab is limiting requests. Try again in {s} seconds."),
            None => "GitLab is limiting requests. Try again in a minute.".into(),
        }),
        300..=399 => forge(
            "GitLab answered with a redirect. Check that the address is the server's own \
             address (with https://).",
        ),
        s if s >= 500 => forge(format!(
            "GitLab had a problem (status {s}). Try again later."
        )),
        s => forge(format!("GitLab refused the request (status {s}).")),
    }
}

fn json<T: for<'de> Deserialize<'de>>(res: &Response) -> Result<T, GitError> {
    serde_json::from_str(&res.body).map_err(|_| {
        forge(
            "This address does not look like a GitLab server. Check the address in \
             Settings > Accounts.",
        )
    })
}

#[derive(Deserialize)]
struct User {
    username: String,
    #[serde(default)]
    name: String,
}

#[derive(Deserialize)]
struct TokenInfo {
    #[serde(default)]
    scopes: Vec<String>,
}

/// Check the token against the server, then remember the account (token in the
/// credential store). Replaces an earlier account for the same server.
pub fn connect(raw_url: &str, token: &str) -> Result<Account, GitError> {
    let url = server_url(raw_url)?;
    let token = token.trim();
    if token.is_empty() {
        return Err(forge("Paste the personal access token from GitLab."));
    }
    if token.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return Err(forge(
            "The token contains spaces or line breaks. Copy it again from GitLab.",
        ));
    }
    let res = get(&url, token, "/user")?;
    if res.status != 200 {
        return Err(status_error(&res, "your user profile"));
    }
    let user: User = json(&res)?;
    // Personal, project and group access tokens can say their own scopes (GitLab 15.5+).
    let access = match get(&url, token, "/personal_access_tokens/self") {
        Ok(r) if r.status == 200 => {
            let scopes = json::<TokenInfo>(&r).map(|t| t.scopes).unwrap_or_default();
            if scopes.iter().any(|s| s == "api") {
                Access::Write
            } else if scopes.iter().any(|s| s == "read_api") {
                Access::Read
            } else {
                return Err(forge(
                    "The token cannot read merge requests. Give it the api scope (or read_api \
                     to only read them).",
                ));
            }
        }
        _ => Access::Unknown,
    };
    let host = super::remote::url_host(&url).unwrap_or_default();
    let account = Account {
        kind: ForgeKind::Gitlab,
        url,
        host,
        name: if user.name.is_empty() {
            user.username.clone()
        } else {
            user.name
        },
        username: user.username,
        access,
    };
    secrets::set(&account.secret_key(), token)?;
    accounts::upsert(account.clone())?;
    Ok(account)
}

/// A person on GitLab, as shown in lists.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Person {
    pub name: String,
    pub username: String,
}

/// A merge request in the Reviews list.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MergeRequest {
    pub project_id: u64,
    /// `group/project`.
    pub project_path: String,
    pub iid: u64,
    pub title: String,
    pub web_url: String,
    pub author: Person,
    pub source_branch: String,
    pub target_branch: String,
    pub draft: bool,
    /// ISO 8601 times as GitLab sends them.
    pub created_at: String,
    pub updated_at: String,
    pub comments: u64,
    /// Latest pipeline status (`success`, `failed`, `running`, ...), when known.
    pub pipeline: Option<String>,
    /// Whether you already approved it; `None` when GitLab did not say.
    pub approved_by_you: Option<bool>,
    pub has_conflicts: bool,
}

#[derive(Deserialize)]
struct ApiMergeRequest {
    project_id: u64,
    iid: u64,
    title: String,
    web_url: String,
    author: ApiPerson,
    source_branch: String,
    target_branch: String,
    #[serde(default)]
    draft: bool,
    #[serde(default)]
    work_in_progress: bool,
    created_at: String,
    updated_at: String,
    #[serde(default)]
    user_notes_count: u64,
    #[serde(default)]
    has_conflicts: bool,
    #[serde(default)]
    references: Option<References>,
}

#[derive(Deserialize)]
struct ApiPerson {
    username: String,
    #[serde(default)]
    name: String,
}

#[derive(Deserialize)]
struct References {
    #[serde(default)]
    full: String,
}

#[derive(Deserialize)]
struct Details {
    #[serde(default)]
    head_pipeline: Option<Pipeline>,
}

#[derive(Deserialize)]
struct Pipeline {
    status: String,
}

#[derive(Deserialize)]
struct Approvals {
    #[serde(default)]
    approved_by: Vec<ApprovedBy>,
}

#[derive(Deserialize)]
struct ApprovedBy {
    user: ApiPerson,
}

/// Percent-encode a project path for `/projects/:id` (`group/sub` becomes `group%2Fsub`).
pub fn encode_path(path: &str) -> String {
    let mut out = String::with_capacity(path.len() * 3);
    for b in path.bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~') {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

/// Open merge requests where the account is a reviewer: in one project (`group/project`)
/// or, with `None`, in every project the account can see. Newest activity first.
pub fn review_requests(
    account: &Account,
    project: Option<&str>,
) -> Result<Vec<MergeRequest>, GitError> {
    let token = account.token()?;
    let user = encode_path(&account.username);
    let query = format!(
        "state=opened&reviewer_username={user}&order_by=updated_at&sort=desc&per_page={MAX_REVIEWS}"
    );
    let (path, what) = match project {
        Some(p) => (
            format!("/projects/{}/merge_requests?{query}", encode_path(p)),
            format!("the project {p}"),
        ),
        None => (
            format!("/merge_requests?scope=all&{query}"),
            "your merge requests".to_string(),
        ),
    };
    let res = get(&account.url, &token, &path)?;
    if res.status != 200 {
        return Err(status_error(&res, &what));
    }
    let list: Vec<ApiMergeRequest> = json(&res)?;
    let mut items: Vec<MergeRequest> = list
        .into_iter()
        .take(MAX_REVIEWS)
        .map(|m| {
            let project_path = m
                .references
                .as_ref()
                .and_then(|r| r.full.rsplit_once('!').map(|(p, _)| p.to_string()))
                .filter(|p| !p.is_empty())
                .or_else(|| project.map(str::to_string))
                .unwrap_or_default();
            MergeRequest {
                project_id: m.project_id,
                project_path,
                iid: m.iid,
                title: m.title,
                web_url: m.web_url,
                author: Person {
                    name: if m.author.name.is_empty() {
                        m.author.username.clone()
                    } else {
                        m.author.name
                    },
                    username: m.author.username,
                },
                source_branch: m.source_branch,
                target_branch: m.target_branch,
                draft: m.draft || m.work_in_progress,
                created_at: m.created_at,
                updated_at: m.updated_at,
                comments: m.user_notes_count,
                pipeline: None,
                approved_by_you: None,
                has_conflicts: m.has_conflicts,
            }
        })
        .collect();

    // Pipeline and approvals need a call each; failures leave them unknown.
    for chunk in items.chunks_mut(PARALLEL) {
        std::thread::scope(|s| {
            for mr in chunk.iter_mut() {
                let token = &token;
                s.spawn(move || {
                    let base = format!("/projects/{}/merge_requests/{}", mr.project_id, mr.iid);
                    if let Ok(r) = get(&account.url, token, &base) {
                        if r.status == 200 {
                            if let Ok(d) = json::<Details>(&r) {
                                mr.pipeline = d.head_pipeline.map(|p| p.status);
                            }
                        }
                    }
                    if let Ok(r) = get(&account.url, token, &format!("{base}/approvals")) {
                        if r.status == 200 {
                            if let Ok(a) = json::<Approvals>(&r) {
                                mr.approved_by_you = Some(
                                    a.approved_by
                                        .iter()
                                        .any(|x| x.user.username == account.username),
                                );
                            }
                        }
                    }
                });
            }
        });
    }
    Ok(items)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn checks_server_addresses() {
        assert_eq!(
            server_url(" https://gitlab.com/ ").unwrap(),
            "https://gitlab.com"
        );
        assert_eq!(
            server_url("https://example.com/gitlab").unwrap(),
            "https://example.com/gitlab"
        );
        assert_eq!(
            server_url("http://localhost:8080").unwrap(),
            "http://localhost:8080"
        );
        assert!(server_url("http://gitlab.example.com").is_err());
        assert!(server_url("gitlab.com").is_err());
        assert!(server_url("https://me:pw@gitlab.com").is_err());
        assert!(server_url("https://gitlab.com/?x=1").is_err());
        assert!(server_url("").is_err());
    }

    #[test]
    fn encodes_project_paths() {
        assert_eq!(
            encode_path("group/sub/my.project"),
            "group%2Fsub%2Fmy.project"
        );
        assert_eq!(encode_path("a b"), "a%20b");
    }

    #[test]
    fn token_page_fills_in_name_and_scope() {
        assert_eq!(
            token_page("https://gitlab.com").unwrap(),
            "https://gitlab.com/-/user_settings/personal_access_tokens?name=Branchline&scopes=api"
        );
    }
}
