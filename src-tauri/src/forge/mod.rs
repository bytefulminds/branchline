//! Hosting services (GitLab for now): accounts, and the merge requests waiting for you.

pub mod accounts;
pub mod gitlab;
pub mod remote;

use serde::Serialize;

use crate::error::GitError;
use crate::git::remote::list_remotes;
use accounts::Account;
use remote::{parse_remote, url_host};

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
    pub items: Vec<gitlab::MergeRequest>,
    /// More merge requests exist than were listed.
    pub truncated: bool,
}

/// Merge requests waiting for your review in the repository's project, or with
/// `all_projects`, everywhere on that server.
pub fn review_requests(repo: &str, all_projects: bool) -> Result<ReviewList, GitError> {
    let source = review_source(repo)?
        .ok_or_else(|| GitError::Forge("This repository has no remote on GitLab.".into()))?;
    let account = source.account.clone().ok_or_else(|| {
        GitError::Forge(format!(
            "Connect your account on {} in Settings > Accounts to see its merge requests.",
            source.host
        ))
    })?;
    let project = (!all_projects).then_some(source.project.as_str());
    let items = gitlab::review_requests(&account, project)?;
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
