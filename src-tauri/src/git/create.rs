//! Starting a repository: clone one from an address, or create a new one.

use std::path::{Component, Path, PathBuf};

use super::branches::validate_branch_name;
use super::paths::new_folder;
use super::remote::{
    classify_remote_failure, network_lock, run_network, validate_remote_url, Progress,
};
use super::runner::{run_git, DEFAULT_TIMEOUT};
use super::worktrees::canonical;
use crate::error::GitError;

/// Put the folder back the way it was after a failed or cancelled clone.
fn clean_up(dest: &Path, existed: bool) {
    if !existed {
        let _ = std::fs::remove_dir_all(dest);
    } else if let Ok(entries) = std::fs::read_dir(dest) {
        // It was empty before the clone started.
        for entry in entries.flatten() {
            let path = entry.path();
            let _ = if path.is_dir() && !path.is_symlink() {
                std::fs::remove_dir_all(&path)
            } else {
                std::fs::remove_file(&path)
            };
        }
    }
}

/// Clone `url` into `dest` (a new or empty folder). Returns the folder.
pub fn clone(
    url: &str,
    dest: &str,
    op_id: &str,
    on_progress: &mut dyn FnMut(Progress),
) -> Result<String, GitError> {
    validate_remote_url(url)?;
    let dest = new_folder(dest)?;
    let parent = dest
        .parent()
        .ok_or_else(|| GitError::InvalidPath("Choose a folder name.".into()))?
        .to_path_buf();
    let _net = network_lock(&dest)?;
    let existed = dest.exists();
    let dest_str = dest.to_string_lossy().into_owned();
    let result = run_network(
        &parent,
        &["clone", "--progress", "--", url, &dest_str],
        op_id,
        on_progress,
    );
    match result {
        Ok(out) if out.code == 0 => Ok(dest_str),
        Ok(out) => {
            clean_up(&dest, existed);
            Err(classify_remote_failure(out.code, &out.stderr))
        }
        Err(e) => {
            clean_up(&dest, existed);
            Err(e)
        }
    }
}

/// Create a repository in `path` (an existing folder, possibly with files, or a
/// new folder whose parent exists). `branch` names the first branch; Git's
/// default (`init.defaultBranch`) is used when it is empty.
pub fn init(path: &str, branch: &str) -> Result<String, GitError> {
    let invalid = |why: &str| Err(GitError::InvalidPath(why.to_string()));
    let raw = path.trim();
    if raw.is_empty() || raw.contains('\0') {
        return invalid("Choose a folder.");
    }
    let path = Path::new(raw);
    if !path.is_absolute() {
        return invalid("Use a full path, for example /Users/you/code/project.");
    }
    if path.components().any(|c| matches!(c, Component::ParentDir)) {
        return invalid("The path cannot contain `..`.");
    }
    let dest: PathBuf = if path.is_dir() {
        canonical(path)
    } else if path.exists() {
        return invalid("That is a file, not a folder.");
    } else {
        // A new folder: reuse the clone checks (parent exists, name is valid).
        let dest = new_folder(raw)?;
        std::fs::create_dir(&dest)
            .map_err(|e| GitError::Internal(format!("cannot create {}: {e}", dest.display())))?;
        dest
    };
    if dest.join(".git").exists() {
        return invalid("That folder is already a Git repository. Open it instead.");
    }
    run_git(&dest, &["init", "-q"], DEFAULT_TIMEOUT)?;
    let branch = branch.trim();
    if !branch.is_empty() {
        validate_branch_name(&dest, branch)?;
        let head = format!("refs/heads/{branch}");
        run_git(&dest, &["symbolic-ref", "HEAD", &head], DEFAULT_TIMEOUT)?;
    }
    Ok(dest.to_string_lossy().into_owned())
}
