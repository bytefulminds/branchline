//! Hosting services: accounts, and the merge requests (pull requests) to look at.
//!
//! Everything outside this module works with the service-neutral types here; each service
//! (GitLab now, GitHub and Bitbucket later) is a module behind `connect`, `token_page` and
//! `review_requests`, chosen by the account's `ForgeKind`.

pub mod accounts;
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
/// store). Each service gets its own module; GitHub and Bitbucket are planned.
pub fn connect(kind: ForgeKind, url: &str, token: &str) -> Result<Account, GitError> {
    match kind {
        ForgeKind::Gitlab => gitlab::connect(url, token),
    }
}

/// The service's page for making a token, with Branchline's name and scopes filled in.
pub fn token_page(kind: ForgeKind, url: &str) -> Result<String, GitError> {
    match kind {
        ForgeKind::Gitlab => gitlab::token_page(url),
    }
}

/// Open requests in the repository's project, or with `all_projects` everywhere on that
/// server, filtered on your role.
pub fn review_requests(
    repo: &str,
    all_projects: bool,
    filter: RequestFilter,
) -> Result<ReviewList, GitError> {
    let source = review_source(repo)?.ok_or_else(|| {
        GitError::Forge("This repository has no remote on a supported hosting service.".into())
    })?;
    let account = source.account.clone().ok_or_else(|| {
        GitError::Forge(format!(
            "Connect your account on {} in Settings > Accounts to see its merge requests.",
            source.host
        ))
    })?;
    if all_projects && filter == RequestFilter::AllOpen {
        return Err(GitError::Forge(
            "Choose one project to see all of its open merge requests.".into(),
        ));
    }
    let project = (!all_projects).then_some(source.project.as_str());
    let items = match account.kind {
        ForgeKind::Gitlab => gitlab::requests(&account, project, filter)?,
    };
    Ok(ReviewList {
        truncated: items.len() >= gitlab::MAX_REVIEWS,
        account,
        project: project.map(str::to_string),
        items,
    })
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
