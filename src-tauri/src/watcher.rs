//! Repository file watching.
//!
//! Emits a debounced `repository-changed` event when the working tree or the
//! parts of the Git directory that affect status (index, HEAD, refs, operation
//! markers) change. Paths ignored by the root `.gitignore` or
//! `.git/info/exclude` are filtered out so build output does not cause refreshes.
//!
//! Read-only events (file opened, read or closed, access-time updates) are
//! ignored. Without that, the reads `git status` itself performs would trigger
//! another refresh, forever.

use std::path::{Path, PathBuf};
use std::sync::mpsc::{channel, RecvTimeoutError};
use std::sync::{Mutex, RwLock};
use std::thread;
use std::time::Duration;

use ignore::gitignore::{Gitignore, GitignoreBuilder};
use notify::event::{AccessKind, MetadataKind, ModifyKind};
use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use tauri::{AppHandle, Emitter};

use crate::error::GitError;
use crate::git::repository::resolve_paths;

pub const EVENT: &str = "repository-changed";
const DEBOUNCE: Duration = Duration::from_millis(250);

/// Files and directories inside the Git directory whose changes affect what Branchline shows.
const GIT_DIR_RELEVANT: &[&str] = &[
    "index",
    "HEAD",
    "packed-refs",
    "refs",
    "MERGE_HEAD",
    "CHERRY_PICK_HEAD",
    "REVERT_HEAD",
    "BISECT_LOG",
    "rebase-merge",
    "rebase-apply",
];

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangePayload {
    pub repo: String,
}

pub struct Filter {
    root: PathBuf,
    git_dir: PathBuf,
    ignore: RwLock<Gitignore>,
}

fn build_ignore(root: &Path, git_dir: &Path) -> Gitignore {
    let mut b = GitignoreBuilder::new(root);
    let _ = b.add(root.join(".gitignore"));
    let _ = b.add(git_dir.join("info").join("exclude"));
    b.build().unwrap_or_else(|_| Gitignore::empty())
}

impl Filter {
    pub fn new(root: PathBuf, git_dir: PathBuf) -> Self {
        let ignore = RwLock::new(build_ignore(&root, &git_dir));
        Filter {
            root,
            git_dir,
            ignore,
        }
    }

    /// Whether a change at `path` can affect repository status.
    pub fn is_relevant(&self, path: &Path) -> bool {
        if let Ok(rel) = path.strip_prefix(&self.git_dir) {
            let first = rel
                .components()
                .next()
                .map(|c| c.as_os_str().to_string_lossy().into_owned());
            return match first {
                Some(name) => GIT_DIR_RELEVANT.contains(&name.as_str()),
                None => false,
            };
        }
        let Ok(rel) = path.strip_prefix(&self.root) else {
            return false;
        };
        if rel.as_os_str().is_empty() {
            return false;
        }
        if rel == Path::new(".gitignore") {
            *self.ignore.write().unwrap_or_else(|e| e.into_inner()) =
                build_ignore(&self.root, &self.git_dir);
            return true;
        }
        let is_dir = path.is_dir();
        let ignore = self.ignore.read().unwrap_or_else(|e| e.into_inner());
        !ignore.matched_path_or_any_parents(rel, is_dir).is_ignore()
    }
}

/// Whether an event kind can change what `git status` reports.
pub fn is_change(kind: &EventKind) -> bool {
    match kind {
        EventKind::Access(AccessKind::Close(notify::event::AccessMode::Write)) => true,
        EventKind::Access(_) => false,
        EventKind::Modify(ModifyKind::Metadata(MetadataKind::AccessTime)) => false,
        EventKind::Other => false,
        _ => true,
    }
}

/// A running watcher. Dropping it stops watching and ends the debounce thread.
pub struct WatchHandle {
    pub root: PathBuf,
    _watcher: RecommendedWatcher,
}

/// Watch `root` (and `git_dir` when it lives elsewhere) and call `on_change`
/// once per burst of relevant changes, after `debounce` of quiet.
pub fn spawn_watcher<F>(
    root: PathBuf,
    git_dir: PathBuf,
    debounce: Duration,
    on_change: F,
) -> Result<WatchHandle, GitError>
where
    F: Fn() + Send + 'static,
{
    let filter = Filter::new(root.clone(), git_dir.clone());
    let (tx, rx) = channel::<()>();
    let mut watcher = notify::recommended_watcher(move |res: notify::Result<Event>| {
        if let Ok(event) = res {
            if is_change(&event.kind) && event.paths.iter().any(|p| filter.is_relevant(p)) {
                let _ = tx.send(());
            }
        }
    })
    .map_err(|e| GitError::Internal(format!("cannot start file watcher: {e}")))?;

    // Trailing debounce: wait for a quiet period, then report once.
    thread::Builder::new()
        .name("branchline-watch".into())
        .spawn(move || {
            while rx.recv().is_ok() {
                loop {
                    match rx.recv_timeout(debounce) {
                        Ok(()) => continue,
                        Err(RecvTimeoutError::Timeout) => break,
                        Err(RecvTimeoutError::Disconnected) => return,
                    }
                }
                on_change();
            }
        })
        .map_err(|e| GitError::Internal(format!("cannot start watcher thread: {e}")))?;

    watcher
        .watch(&root, RecursiveMode::Recursive)
        .map_err(|e| GitError::Internal(format!("cannot watch {}: {e}", root.display())))?;
    if !git_dir.starts_with(&root) {
        // Linked worktrees and submodules keep their Git directory elsewhere.
        let _ = watcher.watch(&git_dir, RecursiveMode::Recursive);
    }
    Ok(WatchHandle {
        root,
        _watcher: watcher,
    })
}

#[derive(Default)]
pub struct WatcherState(pub Mutex<Option<WatchHandle>>);

/// Start watching `repo`, replacing any previous watcher.
pub fn watch(app: AppHandle, state: &WatcherState, repo: &str) -> Result<(), GitError> {
    let (root, git_dir) = resolve_paths(repo)?;
    let mut current = state.0.lock().unwrap_or_else(|e| e.into_inner());
    if current.as_ref().is_some_and(|w| w.root == root) {
        return Ok(());
    }
    // Drop the old watcher before creating a new one.
    *current = None;
    let payload = ChangePayload {
        repo: root.display().to_string(),
    };
    *current = Some(spawn_watcher(root, git_dir, DEBOUNCE, move || {
        let _ = app.emit(EVENT, payload.clone());
    })?);
    Ok(())
}

pub fn unwatch(state: &WatcherState) {
    *state.0.lock().unwrap_or_else(|e| e.into_inner()) = None;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn read_only_events_are_not_changes() {
        use notify::event::{AccessMode, CreateKind, DataChange, RemoveKind};
        assert!(!is_change(&EventKind::Access(AccessKind::Open(
            AccessMode::Read
        ))));
        assert!(!is_change(&EventKind::Access(AccessKind::Close(
            AccessMode::Read
        ))));
        assert!(!is_change(&EventKind::Access(AccessKind::Read)));
        assert!(!is_change(&EventKind::Modify(ModifyKind::Metadata(
            MetadataKind::AccessTime
        ))));
        assert!(is_change(&EventKind::Access(AccessKind::Close(
            AccessMode::Write
        ))));
        assert!(is_change(&EventKind::Create(CreateKind::File)));
        assert!(is_change(&EventKind::Remove(RemoveKind::Any)));
        assert!(is_change(&EventKind::Modify(ModifyKind::Data(
            DataChange::Any
        ))));
        assert!(is_change(&EventKind::Modify(ModifyKind::Name(
            notify::event::RenameMode::Any
        ))));
    }

    #[test]
    fn filters_git_internals_and_ignored_paths() {
        let tmp = tempfile::TempDir::new().unwrap();
        let root = tmp.path().to_path_buf();
        let git_dir = root.join(".git");
        std::fs::create_dir_all(git_dir.join("info")).unwrap();
        std::fs::write(root.join(".gitignore"), "target/\n*.log\n").unwrap();
        std::fs::write(git_dir.join("info/exclude"), "secret.txt\n").unwrap();
        std::fs::create_dir_all(root.join("target/debug")).unwrap();
        let f = Filter::new(root.clone(), git_dir.clone());

        assert!(f.is_relevant(&root.join("src/main.rs")));
        assert!(f.is_relevant(&git_dir.join("index")));
        assert!(f.is_relevant(&git_dir.join("HEAD")));
        assert!(f.is_relevant(&git_dir.join("refs/heads/main")));
        assert!(f.is_relevant(&git_dir.join("MERGE_HEAD")));
        assert!(!f.is_relevant(&git_dir.join("index.lock")));
        assert!(!f.is_relevant(&git_dir.join("objects/ab/cdef")));
        assert!(!f.is_relevant(&git_dir.join("logs/HEAD")));
        assert!(!f.is_relevant(&root.join("target/debug/app")));
        assert!(!f.is_relevant(&root.join("build.log")));
        assert!(!f.is_relevant(&root.join("secret.txt")));
        assert!(!f.is_relevant(Path::new("/somewhere/else")));

        // Editing .gitignore is relevant and reloads the rules.
        std::fs::write(root.join(".gitignore"), "").unwrap();
        assert!(f.is_relevant(&root.join(".gitignore")));
        assert!(f.is_relevant(&root.join("build.log")));
    }
}
