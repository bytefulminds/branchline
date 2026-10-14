//! Tauri IPC commands. Each command moves blocking Git work off the async
//! runtime with `spawn_blocking`, so the webview and event loop stay responsive.

use crate::error::GitError;
use crate::git::commit::{self, CommitDraft, CommitRequest};
use crate::git::diff::{self, DiffArea, FileDiff};
use crate::git::log::{self, CommitDetails, LogPage, RefInfo};
use crate::git::ops::{self, LineRequest};
use crate::git::repository::{self, RepositoryInfo};
use crate::git::runner::{self, GitVersion};

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

/// Watch `repo` for changes; emits `repository-changed` events.
/// Setting up a recursive watch can take a moment on large trees, so it runs off the main thread.
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
