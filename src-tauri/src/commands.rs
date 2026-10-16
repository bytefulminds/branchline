//! Tauri IPC commands. Each command moves blocking Git work off the async
//! runtime with `spawn_blocking`, so the webview and event loop stay responsive.

use tauri::ipc::Channel;

use crate::error::GitError;
use crate::git::branches::{self, BranchList, StartPoint};
use crate::git::commit::{self, CommitDraft, CommitRequest};
use crate::git::diff::{self, DiffArea, FileDiff};
use crate::git::log::{self, CommitDetails, LogPage, RefInfo};
use crate::git::ops::{self, LineRequest};
use crate::git::remote::{self, Progress, PullMode, PushRequest, RemoteInfo, RemoteOutcome};
use crate::git::repository::{self, RepositoryInfo};
use crate::git::runner::{self, GitVersion};
use crate::git::stash::{self, StashInfo, StashOutcome};
use crate::git::tags::{self, TagInfo};

async fn blocking<T, F>(f: F) -> Result<T, GitError>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, GitError> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| GitError::Internal(format!("background task failed: {e}")))?
}

/// Report the Git executable Branchline will use and its version.
#[tauri::command]
pub async fn git_version() -> Result<GitVersion, GitError> {
    blocking(runner::git_version).await
}

/// Inspect the repository containing `path`.
#[tauri::command]
pub async fn inspect_repository(path: String) -> Result<RepositoryInfo, GitError> {
    blocking(move || repository::inspect(&path)).await
}

/// Diff of one file. `force` loads diffs above the soft size limit.
#[tauri::command]
pub async fn file_diff(
    repo: String,
    path: String,
    original_path: Option<String>,
    area: DiffArea,
    force: Option<bool>,
) -> Result<FileDiff, GitError> {
    blocking(move || {
        let root = repository::resolve_root(&repo)?;
        diff::file_diff(
            &root,
            &path,
            original_path.as_deref(),
            area,
            force.unwrap_or(false),
        )
    })
    .await
}

/// Run a write operation, then return the refreshed repository state.
async fn write_then_inspect<F>(repo: String, op: F) -> Result<RepositoryInfo, GitError>
where
    F: FnOnce(&str) -> Result<(), GitError> + Send + 'static,
{
    blocking(move || {
        op(&repo)?;
        repository::inspect(&repo)
    })
    .await
}

#[tauri::command]
pub async fn stage_files(repo: String, paths: Vec<String>) -> Result<RepositoryInfo, GitError> {
    write_then_inspect(repo, move |r| ops::stage_files(r, &paths)).await
}

#[tauri::command]
pub async fn unstage_files(repo: String, paths: Vec<String>) -> Result<RepositoryInfo, GitError> {
    write_then_inspect(repo, move |r| ops::unstage_files(r, &paths)).await
}

#[tauri::command]
pub async fn discard_files(repo: String, paths: Vec<String>) -> Result<RepositoryInfo, GitError> {
    write_then_inspect(repo, move |r| ops::discard_files(r, &paths)).await
}

/// Stage, unstage or discard selected hunks or lines.
#[tauri::command]
pub async fn apply_lines(repo: String, request: LineRequest) -> Result<RepositoryInfo, GitError> {
    write_then_inspect(repo, move |r| ops::apply_lines(r, &request)).await
}

/// One page of history (newest first).
#[tauri::command]
pub async fn log_page(repo: String, skip: usize, limit: usize) -> Result<LogPage, GitError> {
    blocking(move || log::log_page(&repository::resolve_root(&repo)?, skip, limit)).await
}

#[tauri::command]
pub async fn list_refs(repo: String) -> Result<Vec<RefInfo>, GitError> {
    blocking(move || log::list_refs(&repository::resolve_root(&repo)?)).await
}

#[tauri::command]
pub async fn commit_details(repo: String, oid: String) -> Result<CommitDetails, GitError> {
    blocking(move || log::commit_details(&repository::resolve_root(&repo)?, &oid)).await
}

#[tauri::command]
pub async fn commit_file_diff(
    repo: String,
    oid: String,
    path: String,
    original_path: Option<String>,
    force: Option<bool>,
) -> Result<FileDiff, GitError> {
    blocking(move || {
        let root = repository::resolve_root(&repo)?;
        diff::commit_diff(
            &root,
            &oid,
            &path,
            original_path.as_deref(),
            force.unwrap_or(false),
        )
    })
    .await
}

#[tauri::command]
pub async fn commit_draft(repo: String) -> Result<CommitDraft, GitError> {
    blocking(move || commit::commit_draft(&repo)).await
}

/// Create (or amend) a commit, then return the refreshed repository.
#[tauri::command]
pub async fn create_commit(
    repo: String,
    request: CommitRequest,
) -> Result<RepositoryInfo, GitError> {
    write_then_inspect(repo, move |r| commit::commit(r, &request).map(|_| ())).await
}

#[tauri::command]
pub async fn list_branches(repo: String) -> Result<BranchList, GitError> {
    blocking(move || branches::list_branches(&repository::resolve_root(&repo)?)).await
}

/// Live validation for branch name inputs; resolves to an error message or null.
#[tauri::command]
pub async fn check_branch_name(repo: String, name: String) -> Result<Option<String>, GitError> {
    blocking(move || {
        let root = repository::resolve_root(&repo)?;
        match branches::validate_branch_name(&root, &name) {
            Ok(()) => Ok(None),
            Err(GitError::InvalidBranchName(why)) => Ok(Some(why)),
            Err(e) => Err(e),
        }
    })
    .await
}

#[tauri::command]
pub async fn create_branch(
    repo: String,
    name: String,
    start: StartPoint,
    checkout: bool,
) -> Result<RepositoryInfo, GitError> {
    write_then_inspect(repo, move |r| {
        branches::create_branch(r, &name, &start, checkout)
    })
    .await
}

#[tauri::command]
pub async fn switch_branch(repo: String, name: String) -> Result<RepositoryInfo, GitError> {
    write_then_inspect(repo, move |r| branches::switch_branch(r, &name)).await
}

#[tauri::command]
pub async fn checkout_remote_branch(
    repo: String,
    remote_branch: String,
) -> Result<RepositoryInfo, GitError> {
    write_then_inspect(repo, move |r| {
        branches::checkout_remote_branch(r, &remote_branch).map(|_| ())
    })
    .await
}

#[tauri::command]
pub async fn checkout_detached(repo: String, oid: String) -> Result<RepositoryInfo, GitError> {
    write_then_inspect(repo, move |r| branches::checkout_detached(r, &oid)).await
}

#[tauri::command]
pub async fn rename_branch(
    repo: String,
    old: String,
    new: String,
) -> Result<RepositoryInfo, GitError> {
    write_then_inspect(repo, move |r| branches::rename_branch(r, &old, &new)).await
}

#[tauri::command]
pub async fn delete_branch(
    repo: String,
    name: String,
    force: bool,
) -> Result<RepositoryInfo, GitError> {
    write_then_inspect(repo, move |r| branches::delete_branch(r, &name, force)).await
}

/// Watch `repo` for changes; emits `repository-changed` events.
/// Setting up a recursive watch can take a moment on large trees, so it runs off the main thread.
/// Result of a fetch, pull or push: what changed, plus the refreshed repository.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteResult {
    pub outcome: RemoteOutcome,
    pub repo: RepositoryInfo,
}

#[tauri::command]
pub async fn list_remotes(repo: String) -> Result<Vec<RemoteInfo>, GitError> {
    blocking(move || remote::list_remotes(&repo)).await
}

/// Fetch one remote, or all remotes when `remote` is null. Progress is streamed on `on_progress`.
#[tauri::command]
pub async fn fetch_remote(
    repo: String,
    remote: Option<String>,
    op_id: String,
    on_progress: Channel<Progress>,
) -> Result<RemoteResult, GitError> {
    blocking(move || {
        let outcome = remote::fetch(&repo, remote.as_deref(), &op_id, &mut |p| {
            let _ = on_progress.send(p);
        })?;
        Ok(RemoteResult {
            outcome,
            repo: repository::inspect(&repo)?,
        })
    })
    .await
}

/// Pull the current branch from its upstream.
#[tauri::command]
pub async fn pull_branch(
    repo: String,
    mode: PullMode,
    autostash: Option<bool>,
    op_id: String,
    on_progress: Channel<Progress>,
) -> Result<RemoteResult, GitError> {
    blocking(move || {
        let outcome = remote::pull(&repo, mode, autostash.unwrap_or(false), &op_id, &mut |p| {
            let _ = on_progress.send(p);
        })?;
        Ok(RemoteResult {
            outcome,
            repo: repository::inspect(&repo)?,
        })
    })
    .await
}

#[tauri::command]
pub async fn push_branch(
    repo: String,
    request: PushRequest,
    op_id: String,
    on_progress: Channel<Progress>,
) -> Result<RemoteResult, GitError> {
    blocking(move || {
        let outcome = remote::push(&repo, &request, &op_id, &mut |p| {
            let _ = on_progress.send(p);
        })?;
        Ok(RemoteResult {
            outcome,
            repo: repository::inspect(&repo)?,
        })
    })
    .await
}

#[tauri::command]
pub async fn list_stashes(repo: String) -> Result<Vec<StashInfo>, GitError> {
    blocking(move || stash::list_stashes(&repo)).await
}

#[tauri::command]
pub async fn save_stash(
    repo: String,
    message: String,
    include_untracked: bool,
) -> Result<RepositoryInfo, GitError> {
    write_then_inspect(repo, move |r| stash::save(r, &message, include_untracked)).await
}

/// Result of applying a stash, plus the refreshed repository.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StashResult {
    pub outcome: StashOutcome,
    pub repo: RepositoryInfo,
}

/// Apply `stash@{index}` (which must still be `oid`); `pop` also removes it when it applies cleanly.
#[tauri::command]
pub async fn apply_stash(
    repo: String,
    index: u32,
    oid: String,
    pop: bool,
) -> Result<StashResult, GitError> {
    blocking(move || {
        let outcome = stash::apply(&repo, index, &oid, pop)?;
        Ok(StashResult {
            outcome,
            repo: repository::inspect(&repo)?,
        })
    })
    .await
}

#[tauri::command]
pub async fn drop_stash(repo: String, index: u32, oid: String) -> Result<RepositoryInfo, GitError> {
    write_then_inspect(repo, move |r| stash::drop(r, index, &oid)).await
}

#[tauri::command]
pub async fn list_tags(repo: String) -> Result<Vec<TagInfo>, GitError> {
    blocking(move || tags::list_tags(&repo)).await
}

/// Why `name` cannot be used for a new tag, or null when it can.
#[tauri::command]
pub async fn check_tag_name(repo: String, name: String) -> Result<Option<String>, GitError> {
    blocking(move || tags::check_tag_name(&repo, &name)).await
}

/// Create a tag at commit `target`; a non-empty `message` makes it annotated.
#[tauri::command]
pub async fn create_tag(
    repo: String,
    name: String,
    target: String,
    message: String,
) -> Result<RepositoryInfo, GitError> {
    write_then_inspect(repo, move |r| tags::create_tag(r, &name, &target, &message)).await
}

#[tauri::command]
pub async fn delete_tag(repo: String, name: String) -> Result<RepositoryInfo, GitError> {
    write_then_inspect(repo, move |r| tags::delete_tag(r, &name)).await
}

/// Push a tag to a remote, or delete it there (`delete`).
#[tauri::command]
pub async fn push_tag(
    repo: String,
    name: String,
    remote: String,
    delete: bool,
    op_id: String,
    on_progress: Channel<Progress>,
) -> Result<RemoteResult, GitError> {
    blocking(move || {
        let outcome = remote::push_tag(&repo, &name, &remote, delete, &op_id, &mut |p| {
            let _ = on_progress.send(p);
        })?;
        Ok(RemoteResult {
            outcome,
            repo: repository::inspect(&repo)?,
        })
    })
    .await
}

/// Cancel a running fetch, pull or push. Unknown ids are ignored.
#[tauri::command]
pub fn cancel_remote_operation(op_id: String) {
    remote::cancel(&op_id);
}

#[tauri::command]
pub async fn watch_repository(app: tauri::AppHandle, repo: String) -> Result<(), GitError> {
    blocking(move || {
        use tauri::Manager;
        let state = app.state::<crate::watcher::WatcherState>();
        crate::watcher::watch(app.clone(), &state, &repo)
    })
    .await
}

#[tauri::command]
pub fn unwatch_repository(state: tauri::State<'_, crate::watcher::WatcherState>) {
    crate::watcher::unwatch(&state);
}

/// Repository path passed on the command line (`branchline <path>`), if any.
///
/// Only the first non-flag argument is considered; it is validated by
/// `inspect_repository` like any other path the user picks.
#[tauri::command]
pub fn launch_repository_path() -> Option<String> {
    launch_path_from_args(std::env::args_os().skip(1))
}

pub fn launch_path_from_args<I: IntoIterator<Item = std::ffi::OsString>>(
    args: I,
) -> Option<String> {
    args.into_iter()
        .map(|a| a.to_string_lossy().into_owned())
        .find(|a| !a.starts_with('-') && !a.trim().is_empty())
        .map(|a| {
            let p = std::path::PathBuf::from(&a);
            if p.is_absolute() {
                a
            } else {
                std::env::current_dir()
                    .map(|cwd| cwd.join(p).display().to_string())
                    .unwrap_or(a)
            }
        })
}

#[cfg(test)]
mod tests {
    use super::launch_path_from_args;
    use std::ffi::OsString;

    #[test]
    fn picks_first_positional_argument() {
        let args = ["--flag", "/repo/path", "/other"].map(OsString::from);
        assert_eq!(launch_path_from_args(args), Some("/repo/path".into()));
        assert_eq!(launch_path_from_args(Vec::<OsString>::new()), None);
        assert_eq!(
            launch_path_from_args(["-psn_0_123"].map(OsString::from)),
            None
        );
    }

    #[test]
    fn resolves_relative_paths_against_cwd() {
        let got = launch_path_from_args(["repo"].map(OsString::from)).unwrap();
        assert!(std::path::Path::new(&got).is_absolute());
        assert!(got.ends_with("repo"));
    }
}
