//! Hosting services: accounts, and the merge requests (pull requests) to look at.
//!
//! Everything outside this module works with the service-neutral types here; each service
//! (GitLab and Bitbucket Cloud now, GitHub later) is a module behind `connect`, `token_page`
//! and `review_requests`, chosen by the account's `ForgeKind`.

pub mod accounts;
pub mod bitbucket;
pub mod gitlab;
pub mod remote;

use serde::{Deserialize, Serialize};

use crate::error::GitError;
use crate::git::remote::list_remotes;
use accounts::{Account, ForgeKind};
use remote::{parse_remote, url_host};

/// Which open requests to list.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RequestFilter {
    /// You are asked to review them.
    ReviewRequested,
    /// You opened them.
    CreatedByYou,
    /// Everything open in the project (not available for all projects at once).
    AllOpen,
}

/// A person on the hosting service, as shown in lists.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Person {
    pub name: String,
    pub username: String,
}

/// A merge request (GitLab) or pull request (GitHub, Bitbucket) in the Reviews list.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MergeRequest {
    /// GitLab's project id; 0 on services that name projects only by path (Bitbucket).
    pub project_id: u64,
    /// `group/project`.
    pub project_path: String,
    pub iid: u64,
    pub title: String,
    pub web_url: String,
    pub author: Person,
    pub reviewers: Vec<Person>,
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

/// A commit in a merge request, newest first.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RequestCommit {
    pub oid: String,
    pub title: String,
    pub author_name: String,
    /// ISO 8601.
    pub created_at: String,
}

/// Where a comment thread sits in the diff: a line on the new side (`new_line`), or for a
/// removed line only on the old side (`old_line`).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NotePosition {
    pub path: String,
    pub old_path: Option<String>,
    pub old_line: Option<u32>,
    pub new_line: Option<u32>,
    /// The comment was made on an older version of the merge request, so its line numbers
    /// may not match the diff shown.
    pub outdated: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Note {
    pub author: Person,
    /// Markdown as written.
    pub body: String,
    pub created_at: String,
}

/// A comment thread: on a line of the diff, or on the merge request as a whole.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Thread {
    pub id: String,
    pub position: Option<NotePosition>,
    pub resolved: Option<bool>,
    pub notes: Vec<Note>,
}

/// Everything needed to read a merge request in Branchline.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RequestDetail {
    pub request: MergeRequest,
    pub description: String,
    /// The diff is `base` (merge base with the target branch) to `head` (newest commit).
    pub base: String,
    pub head: String,
    pub commits: Vec<RequestCommit>,
    pub threads: Vec<Thread>,
    /// Files changed from `base` to `head`, computed from the local repository.
    pub files: Vec<crate::git::log::CommitFile>,
    /// Files that would conflict when merged into the target branch, from a local trial
    /// merge (Bitbucket, which does not report conflicts). `None` when not checked or Git
    /// could not tell; GitLab reports conflicts itself in `request.has_conflicts`.
    pub conflict_files: Option<Vec<String>>,
}

/// The project on a hosting service that an open repository belongs to.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewSource {
    /// Name of the Git remote, for example `origin` or `upstream`.
    pub remote: String,
    pub host: String,
    /// `group/project` on that host.
    pub project: String,
    /// The connected account for that host, if any.
    pub account: Option<Account>,
}

/// Pick the remote whose merge requests a reviewer wants: `upstream` first (in a fork the
/// merge requests are on the original project), then `origin`, then any other, preferring
/// remotes on a host with a connected account.
pub fn review_source(repo: &str) -> Result<Option<ReviewSource>, GitError> {
    let mut candidates: Vec<ReviewSource> = list_remotes(repo)?
        .into_iter()
        .filter_map(|r| {
            let loc = parse_remote(&r.url)?;
            Some(ReviewSource {
                account: accounts::for_host(&loc.host),
                remote: r.name,
                host: loc.host,
                project: loc.path,
            })
        })
        .collect();
    let rank = |s: &ReviewSource| {
        (
            s.account.is_none(),
            match s.remote.as_str() {
                "upstream" => 0,
                "origin" => 1,
                _ => 2,
            },
        )
    };
    candidates.sort_by_key(rank);
    Ok(candidates.into_iter().next())
}

/// The list shown in the Reviews view.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewList {
    pub account: Account,
    /// The project that was searched, or `None` for all projects.
    pub project: Option<String>,
    pub items: Vec<MergeRequest>,
    /// More merge requests exist than were listed.
    pub truncated: bool,
}

/// Check a token with the service and remember the account (token in the credential
/// store). `login` is the email address Bitbucket signs in with; GitLab does not use it.
pub fn connect(
    kind: ForgeKind,
    url: &str,
    login: Option<&str>,
    token: &str,
) -> Result<Account, GitError> {
    match kind {
        ForgeKind::Gitlab => gitlab::connect(url, token),
        ForgeKind::Bitbucket => bitbucket::connect(url, login.unwrap_or(""), token),
    }
}

/// The service's page for making a token, with Branchline's name and scopes filled in.
pub fn token_page(kind: ForgeKind, url: &str) -> Result<String, GitError> {
    match kind {
        ForgeKind::Gitlab => gitlab::token_page(url),
        ForgeKind::Bitbucket => Ok(bitbucket::TOKEN_PAGE.to_string()),
    }
}

/// Open requests in the repository's project, or with `all_projects` everywhere on that
/// server, filtered on your role.
pub fn review_requests(
    repo: &str,
    all_projects: bool,
    filter: RequestFilter,
) -> Result<ReviewList, GitError> {
    // The repository's own project when its host has a connected account; otherwise all
    // projects of the first connected account.
    let source = review_source(repo)?;
    // The repository's host, when no connected account matches it (for the messages below).
    let unmatched = source
        .as_ref()
        .filter(|s| s.account.is_none())
        .map(|s| s.host.clone());
    let (account, own_project) = match source.and_then(|s| s.account.map(|a| (a, s.project))) {
        Some((account, project)) => (account, Some(project)),
        None => {
            let account = accounts::list().into_iter().next().ok_or_else(|| {
                GitError::Forge(
                    "Connect your account in Settings > Accounts to see merge requests.".into(),
                )
            })?;
            (account, None)
        }
    };
    let all_projects = all_projects || own_project.is_none();
    if all_projects && filter == RequestFilter::AllOpen {
        return Err(GitError::Forge(format!(
            "Choose one project to see all of its open {}s.",
            account.kind.noun()
        )));
    }
    // Bitbucket lists requests to review per repository only: say why this one is not used.
    if own_project.is_none() && account.kind == ForgeKind::Bitbucket {
        if let (Some(host), RequestFilter::ReviewRequested) = (&unmatched, filter) {
            return Err(GitError::Forge(format!(
                "This repository's remote is on {host}, and none of your connected accounts is, \
                 so Branchline cannot list its pull requests. Bitbucket lists pull requests to \
                 review per repository; Created by you works across all of them."
            )));
        }
    }
    let project = own_project.as_deref().filter(|_| !all_projects);
    let (items, max) = match account.kind {
        ForgeKind::Gitlab => (
            gitlab::requests(&account, project, filter)?,
            gitlab::MAX_REVIEWS,
        ),
        ForgeKind::Bitbucket => (
            bitbucket::requests(&account, project, filter)?,
            bitbucket::MAX_REVIEWS,
        ),
    };
    Ok(ReviewList {
        truncated: items.len() >= max,
        account,
        project: project.map(str::to_string),
        items,
    })
}

/// Open a merge request of the repository's own project for reading: its details and
/// threads from the service, and its commits fetched into the repository (with the remote's
/// own credentials) so the diff is computed locally.
pub fn open_request(
    repo: &str,
    project_id: u64,
    iid: u64,
    op_id: &str,
    on_progress: &mut dyn FnMut(crate::git::remote::Progress),
) -> Result<RequestDetail, GitError> {
    let source = review_source(repo)?.ok_or_else(|| {
        GitError::Forge("This repository has no remote on a supported hosting service.".into())
    })?;
    let account = source.account.clone().ok_or_else(|| {
        GitError::Forge(format!(
            "Connect your account on {} in Settings > Accounts first.",
            source.host
        ))
    })?;
    let (mut detail, source_project) = match account.kind {
        ForgeKind::Gitlab => (gitlab::detail(&account, project_id, iid)?, None),
        ForgeKind::Bitbucket => {
            let (d, from) = bitbucket::detail(&account, &source.project, iid)?;
            (d, Some(from))
        }
    };
    if !detail
        .request
        .project_path
        .eq_ignore_ascii_case(&source.project)
    {
        return Err(GitError::Forge(format!(
            "This {} belongs to {}, not to the open repository ({}). Open it on the \
             website, or open that project's repository in Branchline.",
            account.kind.noun(),
            detail.request.project_path,
            source.project
        )));
    }
    match &source_project {
        None => crate::git::remote::fetch_merge_request(
            repo,
            &source.remote,
            iid,
            &detail.head,
            op_id,
            on_progress,
        )?,
        // No merge request refs: fetch the branches, then work out the range locally.
        Some(from) => {
            let (base, head, target) = crate::git::remote::fetch_pull_request(
                repo,
                &crate::git::remote::PullRequestFetch {
                    remote: &source.remote,
                    project: &source.project,
                    source_project: from,
                    source_branch: &detail.request.source_branch,
                    target_branch: &detail.request.target_branch,
                    id: iid,
                    head: &detail.head,
                    target: &detail.base,
                },
                op_id,
                on_progress,
            )?;
            // Bitbucket does not say whether it merges cleanly, so try the merge locally.
            detail.conflict_files = crate::git::remote::merge_conflicts(repo, &target, &head);
            detail.request.has_conflicts = detail
                .conflict_files
                .as_ref()
                .is_some_and(|f| !f.is_empty());
            detail.base = base;
            detail.head = head;
        }
    }
    let root = crate::git::repository::resolve_root(repo)?;
    detail.files = crate::git::log::range_files(&root, &detail.base, &detail.head)?;
    Ok(detail)
}

/// Whether a web page belongs to a connected account's server (so Branchline may open it
/// in the browser): same scheme, host and port as the account, and under its path.
pub fn is_account_page(url: &str) -> bool {
    let Some(host) = url_host(url) else {
        return false;
    };
    if url.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return false;
    }
    accounts::list().iter().any(|a| {
        a.host == host
            && url.len() > a.url.len()
            && url[..a.url.len()].eq_ignore_ascii_case(&a.url)
            && url[a.url.len()..].starts_with('/')
    })
}
