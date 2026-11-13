//! Bitbucket Cloud REST API (2.0): check an API token, list and read pull requests.
//!
//! Bitbucket Cloud signs in with the Atlassian account's email address and an API token
//! (HTTP Basic). Both are kept together in the credential store, go only to Bitbucket's API
//! in the `Authorization` header, and never reach the frontend. Pull requests have no refs
//! of their own, so their branches are fetched instead (see `git::remote::fetch_pull_request`).
//!
//! `scripts/check-bitbucket.mjs` tries each request made here against the real API (the
//! tests use a fake server); add new requests there too.

use std::collections::HashMap;
use std::time::Duration;

use serde::Deserialize;

use super::accounts::{self, Access, Account, ForgeKind};
use super::{
    MergeRequest, Note, NotePosition, Person, RequestCommit, RequestDetail, RequestFilter, Thread,
};
use crate::ai::{agent, is_loopback};
use crate::error::GitError;
use crate::git::command_log;
use crate::secrets;

/// The only Bitbucket Branchline connects to; a server on this computer is allowed for tests.
pub const CLOUD_URL: &str = "https://bitbucket.org";
const CLOUD_API: &str = "https://api.bitbucket.org";
/// At most this many pull requests are listed (newest activity first).
pub const MAX_REVIEWS: usize = 50;
/// Pages of comments read per pull request (100 each).
const COMMENT_PAGES: usize = 5;
/// Extra calls per pull request (build status) run this many at a time.
const PARALLEL: usize = 6;
/// Workspaces asked for your pull requests across Bitbucket (each one call).
const MAX_WORKSPACES: usize = 20;
/// Where Atlassian API tokens are made.
pub const TOKEN_PAGE: &str = "https://id.atlassian.com/manage-profile/security/api-tokens";

fn forge(msg: impl Into<String>) -> GitError {
    GitError::Forge(msg.into())
}

/// Check and normalize the address: Bitbucket Cloud, or `http://` on this computer (tests).
pub fn server_url(raw: &str) -> Result<String, GitError> {
    let url = raw.trim().trim_end_matches('/');
    let lower = url.to_ascii_lowercase();
    if lower.is_empty()
        || matches!(
            lower.as_str(),
            "https://bitbucket.org" | "https://www.bitbucket.org" | "bitbucket.org"
        )
    {
        return Ok(CLOUD_URL.to_string());
    }
    if lower.starts_with("http://")
        && is_loopback(url)
        && !url.contains(['@', '?', '#', ' '])
        && url[7..].split('/').next().is_some_and(|h| !h.is_empty())
    {
        return Ok(url.to_string());
    }
    Err(forge(
        "Branchline works with Bitbucket Cloud (https://bitbucket.org). Bitbucket Data Center \
         is not supported yet.",
    ))
}

/// The API's root for an account address: api.bitbucket.org, or the test server itself.
fn api_root(url: &str) -> &str {
    if url == CLOUD_URL {
        CLOUD_API
    } else {
        url
    }
}

/// `email:token`, Base64 encoded, for the `Authorization: Basic` header.
fn basic(credentials: &str) -> String {
    const ABC: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let bytes = credentials.as_bytes();
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let n = (chunk[0] as u32) << 16
            | (*chunk.get(1).unwrap_or(&0) as u32) << 8
            | *chunk.get(2).unwrap_or(&0) as u32;
        for i in 0..4 {
            if i <= chunk.len() {
                out.push(ABC[(n >> (18 - 6 * i) & 63) as usize] as char);
            } else {
                out.push('=');
            }
        }
    }
    out
}

struct Response {
    status: u16,
    body: String,
    retry_after: Option<String>,
    scopes: Option<String>,
}

fn get(root: &str, credentials: &str, path: &str) -> Result<Response, GitError> {
    request(root, credentials, path, false)
}

fn get_routine(root: &str, credentials: &str, path: &str) -> Result<Response, GitError> {
    request(root, credentials, path, true)
}

/// A GET request to `/2.0{path}`, recorded in the Git console (without the credentials).
fn request(root: &str, credentials: &str, path: &str, routine: bool) -> Result<Response, GitError> {
    let path = format!("/2.0{path}");
    let running = command_log::start_request("Bitbucket", root, "GET", &path, routine);
    let result = send(root, credentials, &path);
    command_log::finish_request(
        running,
        match &result {
            Ok(r) => Ok((r.status, r.body.as_str())),
            Err(e) => Err(e.to_string()),
        },
    );
    result
}

fn send(root: &str, credentials: &str, path: &str) -> Result<Response, GitError> {
    let agent = agent(root, Duration::from_secs(15), Duration::from_secs(30));
    let mut res = agent
        .get(&format!("{root}{path}"))
        .header("Authorization", &format!("Basic {}", basic(credentials)))
        .header("Accept", "application/json")
        .call()
        .map_err(unreachable)?;
    let header = |name: &str| {
        res.headers()
            .get(name)
            .and_then(|v| v.to_str().ok())
            .map(str::to_string)
    };
    let status = res.status().as_u16();
    let retry_after = header("retry-after");
    let scopes = header("x-oauth-scopes");
    let body = res
        .body_mut()
        .with_config()
        .limit(8 * 1024 * 1024)
        .read_to_string()
        .map_err(unreachable)?;
    Ok(Response {
        status,
        body,
        retry_after,
        scopes,
    })
}

fn unreachable(err: ureq::Error) -> GitError {
    match err {
        ureq::Error::Timeout(_) => {
            forge("Bitbucket did not answer in time. Try again in a moment.")
        }
        _ => forge("Could not reach Bitbucket. Check your network connection."),
    }
}

/// Turn an unsuccessful status into a message that says what to do. `scope` is what the
/// token needs for this call.
fn status_error(res: &Response, what: &str, scope: &str) -> GitError {
    match res.status {
        401 => forge(
            "Bitbucket did not accept the email address and API token. Use your Atlassian \
             account's email (not your Bitbucket user name) and an API token with scopes; it \
             may also have expired. Connect the account again in Settings > Accounts.",
        ),
        403 => forge(format!(
            "The API token is not allowed to read {what}. Give it the {scope} scope, or check \
             that your account has access."
        )),
        // Bitbucket answers this way for APIs it no longer offers (for example the
        // cross-workspace ones removed in April 2026), whatever the credentials.
        404 if res.body.contains("no API hosted at this URL") => forge(format!(
            "Bitbucket no longer offers the request for {what}. Branchline needs an update for \
             this; please report it."
        )),
        404 => forge(format!(
            "Bitbucket could not find {what}, or your account has no access to it."
        )),
        429 => forge(match &res.retry_after {
            Some(s) => format!("Bitbucket is limiting requests. Try again in {s} seconds."),
            None => "Bitbucket is limiting requests. Try again in a minute.".into(),
        }),
        s if s >= 500 => forge(format!(
            "Bitbucket had a problem (status {s}). Try again later."
        )),
        s => forge(format!("Bitbucket refused the request (status {s}).")),
    }
}

fn json<T: for<'de> Deserialize<'de>>(res: &Response) -> Result<T, GitError> {
    serde_json::from_str(&res.body)
        .map_err(|_| forge("Bitbucket sent an answer Branchline does not understand."))
}

#[derive(Deserialize, Default, Clone)]
#[serde(default)]
struct ApiUser {
    uuid: String,
    nickname: String,
    display_name: String,
}

/// Check the email address and token with Bitbucket, then remember the account (both in
/// the credential store). Replaces an earlier Bitbucket account.
pub fn connect(raw_url: &str, email: &str, token: &str) -> Result<Account, GitError> {
    let url = server_url(raw_url)?;
    let email = email.trim();
    let token = token.trim();
    if email.is_empty() || !email.contains('@') || email.contains(':') {
        return Err(forge(
            "Enter the email address of your Atlassian account; Bitbucket signs in with it.",
        ));
    }
    if token.is_empty() {
        return Err(forge("Paste the API token from your Atlassian account."));
    }
    if token.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return Err(forge(
            "The token contains spaces or line breaks. Copy it again from Atlassian.",
        ));
    }
    let credentials = format!("{email}:{token}");
    let res = get(api_root(&url), &credentials, "/user")?;
    if res.status != 200 {
        return Err(status_error(
            &res,
            "your user profile",
            "read:user:bitbucket",
        ));
    }
    let user: ApiUser = json(&res)?;
    // API tokens do not always say their scopes; when they do, use them.
    let access = match res.scopes.as_deref() {
        Some(s) if s.contains("write:pullrequest") || s.contains("pullrequest:write") => {
            Access::Write
        }
        Some(s) if s.contains("pullrequest") => Access::Read,
        _ => Access::Unknown,
    };
    let host = super::remote::url_host(&url).unwrap_or_default();
    let account = Account {
        kind: ForgeKind::Bitbucket,
        url,
        host,
        id: 0,
        uid: Some(user.uuid.clone()).filter(|u| !u.is_empty()),
        name: if user.display_name.is_empty() {
            user.nickname.clone()
        } else {
            user.display_name
        },
        username: user.nickname,
        access,
    };
    secrets::set(&account.secret_key(), &credentials)?;
    accounts::upsert(account.clone())?;
    Ok(account)
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct Href {
    href: String,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct Links {
    html: Href,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct Name {
    name: String,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct Hash {
    hash: String,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct Repository {
    full_name: String,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct Endpoint {
    branch: Name,
    commit: Option<Hash>,
    repository: Option<Repository>,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct Participant {
    user: Option<ApiUser>,
    role: String,
    approved: bool,
}

#[derive(Deserialize)]
struct ApiPullRequest {
    id: u64,
    #[serde(default)]
    title: String,
    #[serde(default)]
    description: String,
    #[serde(default)]
    author: Option<ApiUser>,
    #[serde(default)]
    source: Endpoint,
    #[serde(default)]
    destination: Endpoint,
    #[serde(default)]
    reviewers: Vec<ApiUser>,
    #[serde(default)]
    participants: Vec<Participant>,
    #[serde(default)]
    draft: bool,
    #[serde(default)]
    comment_count: u64,
    #[serde(default)]
    created_on: String,
    #[serde(default)]
    updated_on: String,
    #[serde(default)]
    links: Links,
}

#[derive(Deserialize)]
struct Page<T> {
    #[serde(default = "Vec::new")]
    values: Vec<T>,
    #[serde(default)]
    next: Option<String>,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct Status {
    state: String,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct CommitAuthor {
    raw: String,
    user: Option<ApiUser>,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct ApiCommit {
    hash: String,
    message: String,
    date: String,
    author: CommitAuthor,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct Content {
    raw: String,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct Inline {
    path: String,
    from: Option<u32>,
    to: Option<u32>,
    outdated: bool,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct Parent {
    id: u64,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct ApiComment {
    id: u64,
    content: Content,
    user: Option<ApiUser>,
    created_on: String,
    deleted: bool,
    pending: bool,
    inline: Option<Inline>,
    parent: Option<Parent>,
    resolution: Option<serde_json::Value>,
}

fn person(u: &ApiUser) -> Person {
    Person {
        name: if u.display_name.is_empty() {
            u.nickname.clone()
        } else {
            u.display_name.clone()
        },
        username: if u.nickname.is_empty() {
            u.display_name.clone()
        } else {
            u.nickname.clone()
        },
    }
}

fn is_me(account: &Account, u: &ApiUser) -> bool {
    match &account.uid {
        Some(uid) if !u.uuid.is_empty() => u.uuid == *uid,
        _ => !u.nickname.is_empty() && u.nickname.eq_ignore_ascii_case(&account.username),
    }
}

/// Reviewers: those asked, plus participants with the reviewer role.
fn reviewers(p: &ApiPullRequest) -> Vec<&ApiUser> {
    let mut out: Vec<&ApiUser> = p.reviewers.iter().collect();
    for part in &p.participants {
        if let Some(u) = &part.user {
            if part.role == "REVIEWER" && !out.iter().any(|r| r.uuid == u.uuid) {
                out.push(u);
            }
        }
    }
    out
}

fn to_request(account: &Account, p: &ApiPullRequest, project: Option<&str>) -> MergeRequest {
    let project_path = p
        .destination
        .repository
        .as_ref()
        .map(|r| r.full_name.clone())
        .filter(|f| !f.is_empty())
        .or_else(|| project.map(str::to_string))
        .unwrap_or_default();
    MergeRequest {
        project_id: 0,
        project_path,
        iid: p.id,
        title: p.title.clone(),
        web_url: p.links.html.href.clone(),
        author: p.author.as_ref().map(person).unwrap_or(Person {
            name: "Former user".into(),
            username: String::new(),
        }),
        reviewers: reviewers(p).into_iter().map(person).collect(),
        source_branch: p.source.branch.name.clone(),
        target_branch: p.destination.branch.name.clone(),
        draft: p.draft,
        created_at: p.created_on.clone(),
        updated_at: p.updated_on.clone(),
        comments: p.comment_count,
        pipeline: None,
        approved_by_you: Some(
            p.participants
                .iter()
                .any(|x| x.approved && x.user.as_ref().is_some_and(|u| is_me(account, u))),
        ),
        has_conflicts: false,
    }
}

/// Build statuses of a pull request as one pipeline state.
fn pipeline(statuses: &[Status]) -> Option<String> {
    let has = |s: &str| statuses.iter().any(|x| x.state == s);
    if statuses.is_empty() {
        None
    } else if has("FAILED") {
        Some("failed".into())
    } else if has("INPROGRESS") {
        Some("running".into())
    } else if has("STOPPED") {
        Some("canceled".into())
    } else {
        Some("success".into())
    }
}

/// `workspace/repo` as URL path segments; anything else is refused.
fn repo_path(project: &str) -> Result<String, GitError> {
    let ok = project.split('/').count() == 2
        && project.split('/').all(|p| {
            !p.is_empty()
                && p != "."
                && p != ".."
                && p.bytes()
                    .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.'))
        });
    if ok {
        Ok(project.to_string())
    } else {
        Err(forge(format!(
            "{project} does not look like a Bitbucket repository (workspace/repository)."
        )))
    }
}

/// Percent-encode a user id such as `{1a2b...}` for a URL path.
fn encode(s: &str) -> String {
    s.bytes()
        .map(|b| {
            if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.') {
                (b as char).to_string()
            } else {
                format!("%{b:02X}")
            }
        })
        .collect()
}

/// Read up to `pages` pages of a list, following Bitbucket's `next` links on the same API.
fn pages<T: for<'de> Deserialize<'de>>(
    root: &str,
    credentials: &str,
    first: &str,
    pages: usize,
    what: &str,
    scope: &str,
) -> Result<Vec<T>, GitError> {
    let mut out = Vec::new();
    let mut path = Some(first.to_string());
    let prefix = format!("{root}/2.0");
    for _ in 0..pages {
        let Some(p) = path.take() else { break };
        let res = get(root, credentials, &p)?;
        if res.status != 200 {
            return Err(status_error(&res, what, scope));
        }
        let page: Page<T> = json(&res)?;
        out.extend(page.values);
        path = page
            .next
            .and_then(|n| n.strip_prefix(&prefix).map(str::to_string));
    }
    Ok(out)
}

/// A pull request with its description, commits and comment threads, plus the project its
/// changes come from (a fork, or the same repository). `base` and `head` are the target and
/// source commits as Bitbucket reports them; the caller fetches them and works out the range.
pub fn detail(
    account: &Account,
    project: &str,
    id: u64,
) -> Result<(RequestDetail, String), GitError> {
    let credentials = account.token()?;
    let root = api_root(&account.url);
    let base = format!("/repositories/{}/pullrequests/{id}", repo_path(project)?);
    let what = format!("pull request #{id}");
    let scope = "read:pullrequest:bitbucket";
    let res = get(root, &credentials, &base)?;
    if res.status != 200 {
        return Err(status_error(&res, &what, scope));
    }
    let p: ApiPullRequest = json(&res)?;
    let (Some(head), Some(target)) = (
        p.source
            .commit
            .as_ref()
            .map(|c| c.hash.clone())
            .filter(|h| !h.is_empty()),
        p.destination
            .commit
            .as_ref()
            .map(|c| c.hash.clone())
            .filter(|h| !h.is_empty()),
    ) else {
        return Err(forge(
            "Bitbucket did not say which commits this pull request holds.",
        ));
    };
    let source_project = p
        .source
        .repository
        .as_ref()
        .map(|r| r.full_name.clone())
        .filter(|f| !f.is_empty())
        .unwrap_or_else(|| project.to_string());
    let mut request = to_request(account, &p, Some(project));

    let commits = pages::<ApiCommit>(
        root,
        &credentials,
        &format!("{base}/commits?pagelen=100"),
        1,
        &what,
        scope,
    )?
    .into_iter()
    .map(|c| RequestCommit {
        title: c.message.lines().next().unwrap_or("").trim().to_string(),
        author_name: c
            .author
            .user
            .as_ref()
            .map(|u| person(u).name)
            .filter(|n| !n.is_empty())
            .unwrap_or_else(|| {
                c.author
                    .raw
                    .split('<')
                    .next()
                    .unwrap_or("")
                    .trim()
                    .to_string()
            }),
        oid: c.hash,
        created_at: c.date,
    })
    .collect();

    let comments = pages::<ApiComment>(
        root,
        &credentials,
        &format!("{base}/comments?pagelen=100"),
        COMMENT_PAGES,
        &what,
        scope,
    )?;
    let threads = to_threads(comments);

    if let Ok(r) = get_routine(root, &credentials, &format!("{base}/statuses?pagelen=25")) {
        if r.status == 200 {
            if let Ok(page) = json::<Page<Status>>(&r) {
                request.pipeline = pipeline(&page.values);
            }
        }
    }

    Ok((
        RequestDetail {
            request,
            description: p.description,
            base: target,
            head,
            commits,
            threads,
            files: Vec::new(),
            conflict_files: None,
        },
        source_project,
    ))
}

/// Comments as threads: replies go under the first comment of their chain. Deleted and
/// pending (unpublished) comments are left out.
fn to_threads(comments: Vec<ApiComment>) -> Vec<Thread> {
    let parent: HashMap<u64, u64> = comments
        .iter()
        .filter_map(|c| c.parent.as_ref().map(|p| (c.id, p.id)))
        .collect();
    let root_of = |mut id: u64| {
        for _ in 0..100 {
            match parent.get(&id) {
                Some(p) => id = *p,
                None => break,
            }
        }
        id
    };
    let by_id: HashMap<u64, &ApiComment> = comments.iter().map(|c| (c.id, c)).collect();
    let mut order: Vec<u64> = Vec::new();
    let mut notes: HashMap<u64, Vec<Note>> = HashMap::new();
    let mut sorted: Vec<&ApiComment> = comments.iter().collect();
    sorted.sort_by(|a, b| a.created_on.cmp(&b.created_on).then(a.id.cmp(&b.id)));
    for c in sorted {
        if c.deleted || c.pending || c.content.raw.trim().is_empty() {
            continue;
        }
        let root = root_of(c.id);
        if !notes.contains_key(&root) {
            order.push(root);
        }
        notes.entry(root).or_default().push(Note {
            author: c.user.as_ref().map(person).unwrap_or(Person {
                name: "Former user".into(),
                username: String::new(),
            }),
            body: c.content.raw.clone(),
            created_at: c.created_on.clone(),
        });
    }
    order
        .into_iter()
        .map(|root| {
            let first = by_id.get(&root);
            let inline = first
                .and_then(|c| c.inline.as_ref())
                .filter(|i| !i.path.is_empty());
            Thread {
                id: root.to_string(),
                position: inline.map(|i| NotePosition {
                    path: i.path.clone(),
                    old_path: None,
                    // A comment on a removed line has only the old line ("from").
                    old_line: if i.to.is_none() { i.from } else { None },
                    new_line: i.to,
                    outdated: i.outdated,
                }),
                resolved: inline.map(|_| first.is_some_and(|c| c.resolution.is_some())),
                notes: notes.remove(&root).unwrap_or_default(),
            }
        })
        .collect()
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct Slug {
    slug: String,
}

/// One entry of `/2.0/user/workspaces`: the workspace, and your access to it.
#[derive(Deserialize, Default)]
#[serde(default)]
struct WorkspaceAccess {
    workspace: Option<Slug>,
    slug: String,
}

/// Your open pull requests in every workspace you belong to, newest activity first.
/// Bitbucket removed the cross-workspace `/2.0/pullrequests/{user}` in April 2026
/// (CHANGE-2770), so this asks each workspace (`/2.0/workspaces/{workspace}/pullrequests/{user}`).
fn yours_everywhere(
    account: &Account,
    credentials: &str,
    fields: &str,
) -> Result<Vec<ApiPullRequest>, GitError> {
    let root = api_root(&account.url);
    let workspaces: Vec<String> = pages::<WorkspaceAccess>(
        root,
        credentials,
        "/user/workspaces?pagelen=100",
        1,
        "your workspaces",
        "read:workspace:bitbucket",
    )?
    .into_iter()
    .map(|w| w.workspace.map(|s| s.slug).unwrap_or(w.slug))
    .filter(|s| repo_path(&format!("{s}/x")).is_ok())
    .take(MAX_WORKSPACES)
    .collect();
    let who = encode(
        &account
            .uid
            .clone()
            .unwrap_or_else(|| account.username.clone()),
    );
    let mut found: Vec<Result<Vec<ApiPullRequest>, GitError>> = Vec::new();
    for chunk in workspaces.chunks(PARALLEL) {
        std::thread::scope(|s| {
            let running: Vec<_> = chunk
                .iter()
                .map(|w| {
                    let who = &who;
                    s.spawn(move || {
                        pages::<ApiPullRequest>(
                            root,
                            credentials,
                            &format!(
                                "/workspaces/{w}/pullrequests/{who}?state=OPEN&sort=-updated_on&pagelen={MAX_REVIEWS}&{fields}"
                            ),
                            1,
                            &format!("your pull requests in {w}"),
                            "read:pullrequest:bitbucket",
                        )
                    })
                })
                .collect();
            for r in running {
                found.push(r.join().unwrap_or_else(|_| Ok(Vec::new())));
            }
        });
    }
    // One workspace that refuses (no access any more) should not hide the others.
    let mut list = Vec::new();
    let mut first_error = None;
    for r in found {
        match r {
            Ok(items) => list.extend(items),
            Err(e) => {
                first_error.get_or_insert(e);
            }
        }
    }
    if list.is_empty() {
        if let Some(e) = first_error {
            return Err(e);
        }
    }
    list.sort_by(|a, b| b.updated_on.cmp(&a.updated_on));
    Ok(list)
}

/// Open pull requests in one repository (`workspace/repo`), filtered on your role; or, with
/// `None`, the ones you created anywhere. Newest activity first.
pub fn requests(
    account: &Account,
    project: Option<&str>,
    filter: RequestFilter,
) -> Result<Vec<MergeRequest>, GitError> {
    let credentials = account.token()?;
    let root = api_root(&account.url);
    // Reviewers and participants are left out of lists unless asked for.
    let fields = "fields=%2Bvalues.reviewers%2C%2Bvalues.participants";
    let list: Vec<ApiPullRequest> = match project {
        Some(p) => pages(
            root,
            &credentials,
            &format!(
                "/repositories/{}/pullrequests?state=OPEN&sort=-updated_on&pagelen={MAX_REVIEWS}&{fields}",
                repo_path(p)?
            ),
            1,
            &format!("the pull requests of {p}"),
            "read:pullrequest:bitbucket",
        )?,
        None => match filter {
            RequestFilter::CreatedByYou => yours_everywhere(account, &credentials, fields)?,
            _ => {
                return Err(forge(
                    "Bitbucket lists pull requests to review per repository. Open a repository \
                     from Bitbucket in Branchline to see the ones waiting for you.",
                ))
            }
        },
    };
    let mut items: Vec<MergeRequest> = list
        .iter()
        .filter(|p| {
            project.is_none()
                || match filter {
                    RequestFilter::ReviewRequested => {
                        reviewers(p).iter().any(|u| is_me(account, u))
                    }
                    RequestFilter::CreatedByYou => {
                        p.author.as_ref().is_some_and(|u| is_me(account, u))
                    }
                    RequestFilter::AllOpen => true,
                }
        })
        .take(MAX_REVIEWS)
        .map(|p| to_request(account, p, project))
        .collect();

    // Build status needs a call each; failures leave it unknown.
    for chunk in items.chunks_mut(PARALLEL) {
        std::thread::scope(|s| {
            for pr in chunk.iter_mut() {
                let credentials = &credentials;
                s.spawn(move || {
                    let Ok(repo) = repo_path(&pr.project_path) else {
                        return;
                    };
                    let path = format!(
                        "/repositories/{repo}/pullrequests/{}/statuses?pagelen=25",
                        pr.iid
                    );
                    if let Ok(r) = get_routine(root, credentials, &path) {
                        if r.status == 200 {
                            if let Ok(page) = json::<Page<Status>>(&r) {
                                pr.pipeline = pipeline(&page.values);
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
    fn only_bitbucket_cloud_or_a_local_test_server() {
        assert_eq!(server_url("").unwrap(), CLOUD_URL);
        assert_eq!(server_url(" https://bitbucket.org/ ").unwrap(), CLOUD_URL);
        assert_eq!(
            server_url("http://127.0.0.1:7990").unwrap(),
            "http://127.0.0.1:7990"
        );
        assert!(server_url("https://bitbucket.example.com").is_err());
        assert!(server_url("http://bitbucket.org").is_err());
        assert_eq!(api_root(CLOUD_URL), "https://api.bitbucket.org");
    }

    #[test]
    fn encodes_basic_credentials() {
        assert_eq!(basic("me@example.com:tok"), "bWVAZXhhbXBsZS5jb206dG9r");
        assert_eq!(basic("a"), "YQ==");
        assert_eq!(basic("ab"), "YWI=");
        assert_eq!(basic("abc"), "YWJj");
    }

    #[test]
    fn checks_repository_paths() {
        assert_eq!(repo_path("acme/lumen.app").unwrap(), "acme/lumen.app");
        assert!(repo_path("acme/../x").is_err());
        assert!(repo_path("acme/sub/x").is_err());
        assert!(repo_path("acme/x?y").is_err());
    }

    #[test]
    fn groups_comments_into_threads() {
        let comments: Vec<ApiComment> = serde_json::from_value(serde_json::json!([
            {"id": 1, "content": {"raw": "Why 20?"}, "created_on": "2026-01-01T10:00:00Z",
             "user": {"display_name": "Ann", "nickname": "ann", "uuid": "{a}"},
             "inline": {"path": "src/a.ts", "from": null, "to": 20}},
            {"id": 2, "content": {"raw": "Fixed"}, "created_on": "2026-01-01T11:00:00Z",
             "parent": {"id": 1}, "user": {"display_name": "Bo", "nickname": "bo"}},
            {"id": 3, "content": {"raw": "Thanks"}, "created_on": "2026-01-01T12:00:00Z",
             "parent": {"id": 2}},
            {"id": 4, "content": {"raw": "Looks good"}, "created_on": "2026-01-01T09:00:00Z"},
            {"id": 5, "content": {"raw": "gone"}, "deleted": true, "created_on": "2026-01-01T09:30:00Z"},
            {"id": 6, "content": {"raw": "Removed on purpose?"}, "created_on": "2026-01-01T13:00:00Z",
             "inline": {"path": "src/b.ts", "from": 7, "to": null}, "resolution": {"type": "resolved"}}
        ]))
        .unwrap();
        let threads = to_threads(comments);
        assert_eq!(threads.len(), 3);
        assert_eq!(threads[0].id, "4");
        assert_eq!(threads[0].position, None);
        assert_eq!(threads[0].resolved, None);
        assert_eq!(threads[1].notes.len(), 3);
        let pos = threads[1].position.as_ref().unwrap();
        assert_eq!((pos.new_line, pos.old_line), (Some(20), None));
        assert_eq!(threads[1].resolved, Some(false));
        let pos = threads[2].position.as_ref().unwrap();
        assert_eq!((pos.new_line, pos.old_line), (None, Some(7)));
        assert_eq!(threads[2].resolved, Some(true));
    }

    #[test]
    fn says_when_bitbucket_no_longer_offers_a_request() {
        let res = |body: &str| Response {
            status: 404,
            body: body.into(),
            retry_after: None,
            scopes: None,
        };
        let removed = status_error(
            &res(r#"{"error":{"message":"There is no API hosted at this URL."}}"#),
            "your pull requests",
            "read:pullrequest:bitbucket",
        );
        assert!(
            removed.to_string().contains("no longer offers"),
            "{removed}"
        );
        let missing = status_error(&res("{}"), "pull request #4", "read:pullrequest:bitbucket");
        assert!(missing.to_string().contains("could not find"), "{missing}");
    }

    #[test]
    fn sums_up_build_statuses() {
        let s = |v: &[&str]| -> Vec<Status> {
            v.iter()
                .map(|x| Status {
                    state: x.to_string(),
                })
                .collect()
        };
        assert_eq!(pipeline(&s(&[])), None);
        assert_eq!(
            pipeline(&s(&["SUCCESSFUL", "FAILED"])).as_deref(),
            Some("failed")
        );
        assert_eq!(
            pipeline(&s(&["SUCCESSFUL", "INPROGRESS"])).as_deref(),
            Some("running")
        );
        assert_eq!(pipeline(&s(&["SUCCESSFUL"])).as_deref(), Some("success"));
    }
}
