//! Tauri IPC commands. Each command moves blocking Git work off the async
//! runtime with `spawn_blocking`, so the webview and event loop stay responsive.

use tauri::ipc::Channel;

use crate::error::GitError;
use crate::git::branches::{self, BranchList, StartPoint};
use crate::git::commit::{self, CommitDraft, CommitRequest};
use crate::git::conflict::{self, ConflictFile, ResolveSide};
use crate::git::create;
use crate::git::diff::{self, DiffArea, FileDiff};
use crate::git::identity::{self, ConfigScope, Identity, IdentityValues};
use crate::git::integrate::{self, IntegrateOutcome, MergeRequest, Step};
use crate::git::log::{self, CommitDetails, LogFilter, LogPage, RefInfo};
use crate::git::ops::{self, LineRequest};
use crate::git::rebase_plan::{self, PlanCommit, PlanStep};
use crate::git::remote::{self, Progress, PullMode, PushRequest, RemoteInfo, RemoteOutcome};
use crate::git::repository::{self, RepositoryInfo};
use crate::git::runner::{self, GitVersion};
use crate::git::stash::{self, StashInfo, StashOutcome};
use crate::git::tags::{self, TagInfo};
use crate::git::worktrees::{self, WorktreeInfo, WorktreeTarget};
use crate::settings::{self, Settings};

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

/// Diff display options from the settings.
fn diff_options() -> diff::DiffOptions {
    let editor = settings::current().editor;
    diff::DiffOptions {
        context: editor.diff_context,
        ignore_whitespace: editor.ignore_whitespace,
    }
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
        diff::file_diff_with(
            &root,
            &path,
            original_path.as_deref(),
            area,
            force.unwrap_or(false),
            &diff_options(),
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
pub async fn log_page(
    repo: String,
    skip: usize,
    limit: usize,
    filter: Option<LogFilter>,
) -> Result<LogPage, GitError> {
    blocking(move || {
        log::log_page(
            &repository::resolve_root(&repo)?,
            skip,
            limit,
            filter.as_ref(),
        )
    })
    .await
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
            &diff_options(),
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
    blocking(move || branches::list_branches_with_worktrees(&repository::resolve_root(&repo)?))
        .await
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
        let prune = settings::current().git.prune_on_fetch;
        let outcome = remote::fetch_with(&repo, remote.as_deref(), prune, &op_id, &mut |p| {
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
    mut request: PushRequest,
    op_id: String,
    on_progress: Channel<Progress>,
) -> Result<RemoteResult, GitError> {
    request.follow_tags = settings::current().git.push_follow_tags;
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

/// Result of a merge, rebase, cherry-pick, revert or continue/skip/abort, plus the refreshed repository.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IntegrateResult {
    pub outcome: IntegrateOutcome,
    pub repo: RepositoryInfo,
}

async fn integrate_then_inspect<F>(repo: String, op: F) -> Result<IntegrateResult, GitError>
where
    F: FnOnce(&str) -> Result<IntegrateOutcome, GitError> + Send + 'static,
{
    blocking(move || {
        let outcome = op(&repo)?;
        Ok(IntegrateResult {
            outcome,
            repo: repository::inspect(&repo)?,
        })
    })
    .await
}

#[tauri::command]
pub async fn merge_into_current(
    repo: String,
    request: MergeRequest,
) -> Result<IntegrateResult, GitError> {
    integrate_then_inspect(repo, move |r| integrate::merge(r, &request)).await
}

#[tauri::command]
pub async fn rebase_current(
    repo: String,
    onto: StartPoint,
    autostash: bool,
) -> Result<IntegrateResult, GitError> {
    integrate_then_inspect(repo, move |r| integrate::rebase(r, &onto, autostash)).await
}

#[tauri::command]
pub async fn cherry_pick(repo: String, oid: String) -> Result<IntegrateResult, GitError> {
    integrate_then_inspect(repo, move |r| integrate::cherry_pick(r, &oid)).await
}

/// Cherry-pick several commits, in the order given (oldest first).
#[tauri::command]
pub async fn cherry_pick_many(
    repo: String,
    oids: Vec<String>,
) -> Result<IntegrateResult, GitError> {
    integrate_then_inspect(repo, move |r| integrate::cherry_pick_many(r, &oids)).await
}

#[tauri::command]
pub async fn revert_commit(repo: String, oid: String) -> Result<IntegrateResult, GitError> {
    integrate_then_inspect(repo, move |r| integrate::revert(r, &oid)).await
}

/// Commits after `base` on the current branch, oldest first, for an interactive rebase.
#[tauri::command]
pub async fn rebase_plan_commits(repo: String, base: String) -> Result<Vec<PlanCommit>, GitError> {
    blocking(move || rebase_plan::plan_commits(&repo, &base)).await
}

/// Rewrite the commits after `base` according to `plan` (reorder, reword, squash, fixup, drop).
#[tauri::command]
pub async fn interactive_rebase(
    repo: String,
    base: String,
    plan: Vec<PlanStep>,
    autostash: bool,
) -> Result<IntegrateResult, GitError> {
    integrate_then_inspect(repo, move |r| {
        rebase_plan::interactive_rebase(r, &base, &plan, autostash)
    })
    .await
}

/// Three-way view of one conflicted file, for the merge editor.
#[tauri::command]
pub async fn conflict_file(repo: String, path: String) -> Result<ConflictFile, GitError> {
    blocking(move || conflict::load(&repo, &path)).await
}

/// Save the merge editor's result as the resolved file and mark it as resolved.
#[tauri::command]
pub async fn resolve_conflict_text(
    repo: String,
    path: String,
    content: String,
    fingerprint: String,
) -> Result<RepositoryInfo, GitError> {
    blocking(move || {
        conflict::resolve_with_text(&repo, &path, &content, &fingerprint)?;
        repository::inspect(&repo)
    })
    .await
}

/// Resolve a conflicted file by keeping one side's version, or by deleting it.
#[tauri::command]
pub async fn resolve_conflict_side(
    repo: String,
    path: String,
    side: ResolveSide,
    fingerprint: String,
) -> Result<RepositoryInfo, GitError> {
    blocking(move || {
        conflict::resolve_with_side(&repo, &path, side, &fingerprint)?;
        repository::inspect(&repo)
    })
    .await
}

#[tauri::command]
pub async fn list_worktrees(repo: String) -> Result<Vec<WorktreeInfo>, GitError> {
    blocking(move || worktrees::list(&repo)).await
}

/// Create a worktree; returns its folder.
#[tauri::command]
pub async fn add_worktree(
    repo: String,
    path: String,
    target: WorktreeTarget,
) -> Result<String, GitError> {
    blocking(move || worktrees::add(&repo, &path, &target)).await
}

#[tauri::command]
pub async fn remove_worktree(repo: String, path: String, force: bool) -> Result<(), GitError> {
    blocking(move || worktrees::remove(&repo, &path, force)).await
}

#[tauri::command]
pub async fn lock_worktree(
    repo: String,
    path: String,
    locked: bool,
    reason: String,
) -> Result<(), GitError> {
    blocking(move || worktrees::set_locked(&repo, &path, locked, &reason)).await
}

/// Forget worktrees whose folders were deleted; returns how many.
#[tauri::command]
pub async fn prune_worktrees(repo: String) -> Result<usize, GitError> {
    blocking(move || worktrees::prune(&repo)).await
}

#[tauri::command]
pub async fn add_remote(repo: String, name: String, url: String) -> Result<(), GitError> {
    blocking(move || remote::add_remote(&repo, &name, &url)).await
}

/// Rename a remote and/or change its addresses (unchanged values are left alone).
#[tauri::command]
pub async fn edit_remote(
    repo: String,
    name: String,
    new_name: String,
    url: String,
    push_url: String,
) -> Result<(), GitError> {
    blocking(move || remote::edit_remote(&repo, &name, &new_name, &url, &push_url)).await
}

#[tauri::command]
pub async fn remove_remote(repo: String, name: String) -> Result<(), GitError> {
    blocking(move || remote::remove_remote(&repo, &name)).await
}

/// Clone `url` into a new or empty folder; returns the folder. Progress streams
/// to `on_progress`; `op_id` can be passed to `cancel_remote_operation`.
#[tauri::command]
pub async fn clone_repository(
    url: String,
    dest: String,
    op_id: String,
    on_progress: Channel<Progress>,
) -> Result<String, GitError> {
    blocking(move || {
        create::clone(&url, &dest, &op_id, &mut |p| {
            let _ = on_progress.send(p);
        })
    })
    .await
}

/// Create a repository in a folder; returns the folder.
#[tauri::command]
pub async fn init_repository(path: String, branch: String) -> Result<String, GitError> {
    blocking(move || create::init(&path, &branch)).await
}

#[tauri::command]
pub fn get_settings() -> Settings {
    settings::current()
}

/// Save all settings; returns them as stored (values are clamped to valid ranges).
#[tauri::command]
pub async fn save_settings(value: Settings) -> Result<Settings, GitError> {
    blocking(move || settings::update(value)).await
}

/// Name, email and signing, globally and (when `repo` is given) in that repository.
#[tauri::command]
pub async fn get_identity(repo: Option<String>) -> Result<Identity, GitError> {
    blocking(move || identity::get_identity(repo.as_deref())).await
}

#[tauri::command]
pub async fn set_identity(
    scope: ConfigScope,
    repo: Option<String>,
    values: IdentityValues,
) -> Result<(), GitError> {
    blocking(move || identity::set_identity(scope, repo.as_deref(), &values)).await
}

/// Open a file (or the repository when `path` is null) in the configured editor.
#[tauri::command]
pub async fn open_in_editor(repo: String, path: Option<String>) -> Result<(), GitError> {
    let editor = settings::current().editor.external_editor;
    blocking(move || crate::open::open_in_editor(&repo, path.as_deref(), &editor)).await
}

#[tauri::command]
pub async fn open_terminal(repo: String) -> Result<(), GitError> {
    let terminal = settings::current().editor.terminal;
    blocking(move || crate::open::open_terminal(&repo, &terminal)).await
}

/// Show a file (or the repository when `path` is null) in Finder, Explorer or the file manager.
#[tauri::command]
pub async fn reveal_in_file_manager(repo: String, path: Option<String>) -> Result<(), GitError> {
    blocking(move || crate::open::reveal(&repo, path.as_deref())).await
}

/// Continue, skip or abort the merge, rebase, cherry-pick or revert in progress.
#[tauri::command]
pub async fn operation_step(repo: String, step: Step) -> Result<IntegrateResult, GitError> {
    integrate_then_inspect(repo, move |r| integrate::step(r, step)).await
}

/// Git commands Branchline ran that started or finished after `since` (0 for all).
#[tauri::command]
pub fn git_command_log(since: u64) -> Vec<crate::git::command_log::CommandEntry> {
    crate::git::command_log::since(since)
}

/// Empty the Git console.
#[tauri::command]
pub fn clear_git_command_log() {
    crate::git::command_log::clear();
}

/// Connect to an Ollama server and list its models (the Test connection button).
#[tauri::command]
pub async fn ai_server_info(url: String) -> Result<crate::ai::ServerInfo, GitError> {
    blocking(move || crate::ai::server_info(&url)).await
}

/// Suggest a commit message for the staged changes with the model chosen in
/// Settings. The message so far streams to `on_text`; cancel with
/// `cancel_remote_operation(op_id)`.
#[tauri::command]
pub async fn suggest_commit_message(
    repo: String,
    op_id: String,
    on_text: Channel<String>,
) -> Result<String, GitError> {
    blocking(move || {
        let cfg = settings::current().ai;
        crate::ai::suggest_commit_message(&repo, &cfg, &op_id, &mut |text| {
            let _ = on_text.send(text.to_string());
        })
    })
    .await
}

/// Connected accounts on hosting services (without tokens).
#[tauri::command]
pub fn forge_accounts() -> Vec<crate::forge::accounts::Account> {
    crate::forge::accounts::list()
}

/// Check a token with a hosting service and remember the account; the token goes to the
/// system's credential store and never comes back to the frontend.
#[tauri::command]
pub async fn connect_account(
    kind: crate::forge::accounts::ForgeKind,
    url: String,
    token: String,
) -> Result<crate::forge::accounts::Account, GitError> {
    blocking(move || crate::forge::connect(kind, &url, &token)).await
}

/// Forget an account and delete its token.
#[tauri::command]
pub async fn disconnect_account(
    kind: crate::forge::accounts::ForgeKind,
    url: String,
) -> Result<(), GitError> {
    blocking(move || crate::forge::accounts::remove(kind, &url)).await
}

/// The hosting service project the repository belongs to, and whether its account is connected.
#[tauri::command]
pub async fn review_source(repo: String) -> Result<Option<crate::forge::ReviewSource>, GitError> {
    blocking(move || crate::forge::review_source(&repo)).await
}

/// Open merge requests to review, created by you, or all open ones; in this repository's
/// project or (except all open ones) everywhere on the server.
#[tauri::command]
pub async fn review_requests(
    repo: String,
    all_projects: bool,
    filter: crate::forge::RequestFilter,
) -> Result<crate::forge::ReviewList, GitError> {
    blocking(move || crate::forge::review_requests(&repo, all_projects, filter)).await
}

/// Open a page of a connected account's server (a merge request) in the browser.
#[tauri::command]
pub fn open_forge_page(app: tauri::AppHandle, url: String) -> Result<(), GitError> {
    use tauri_plugin_opener::OpenerExt;
    if !crate::forge::is_account_page(&url) {
        return Err(GitError::Forge(
            "Branchline only opens pages of the servers you connected.".into(),
        ));
    }
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|e| GitError::Internal(format!("cannot open the browser: {e}")))
}

/// Open the service's page for making a token, with name and scope filled in.
#[tauri::command]
pub fn open_token_page(
    app: tauri::AppHandle,
    kind: crate::forge::accounts::ForgeKind,
    url: String,
) -> Result<(), GitError> {
    use tauri_plugin_opener::OpenerExt;
    let page = crate::forge::token_page(kind, &url)?;
    app.opener()
        .open_url(page, None::<&str>)
        .map_err(|e| GitError::Internal(format!("cannot open the browser: {e}")))
}

/// Cancel a running fetch, pull, push, clone or suggestion. Unknown ids are ignored.
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
/// Whether the app was started to measure startup (`--measure-startup=<file>`).
#[tauri::command]
pub fn measure_mode() -> bool {
    crate::measure::output().is_some()
}

/// Milliseconds since the process started.
#[tauri::command]
pub fn measure_elapsed() -> f64 {
    crate::measure::elapsed_ms()
}

/// Write the timing report and quit. Does nothing unless started in measure mode.
#[tauri::command]
pub fn finish_measurement(
    app: tauri::AppHandle,
    report: serde_json::Value,
) -> Result<(), GitError> {
    let Some(path) = crate::measure::output() else {
        return Ok(());
    };
    crate::measure::write_report(&path, report)
        .map_err(|e| GitError::Internal(format!("cannot write {}: {e}", path.display())))?;
    app.exit(0);
    Ok(())
}

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
