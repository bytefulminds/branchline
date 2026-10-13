//! Tauri IPC commands. Each command moves blocking Git work off the async
//! runtime with `spawn_blocking`, so the webview and event loop stay responsive.

use crate::error::GitError;
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
