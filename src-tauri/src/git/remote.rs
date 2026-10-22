//! Remotes and network operations: fetch, pull and push.
//!
//! * Remote names from the UI must match a configured remote, and branch names
//!   are validated and passed as full refs, so neither can be read as an option.
//! * Credentials embedded in remote URLs are never sent to the UI: URLs and Git
//!   output are redacted first.
//! * Git never prompts: `GIT_TERMINAL_PROMPT=0` (set by the runner) for HTTPS,
//!   and `ssh -o BatchMode=yes` for SSH unless the user configured their own SSH
//!   command. Credential helpers and SSH agents keep working.
//! * Progress is streamed to the caller line by line; operations can be cancelled.

use std::collections::HashMap;
use std::path::Path;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use serde::{Deserialize, Serialize};

use super::branches::validate_branch_name;
use super::ops::write_lock;
use super::repository::{inspect, resolve_root, HeadState};
use super::runner::{
    classify_failure, run_git, run_git_streaming, run_git_with, CancelToken, GitOutput, RunOptions,
    StreamOptions, DEFAULT_TIMEOUT,
};
use crate::error::GitError;

/// Upper bound for one network operation. Users can cancel earlier at any time.
pub const NETWORK_TIMEOUT: Duration = Duration::from_secs(30 * 60);

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteInfo {
    pub name: String,
    /// Fetch URL with any credentials removed.
    pub url: String,
    /// Push URL when it differs from the fetch URL (credentials removed).
    pub push_url: Option<String>,
}

/// One progress update parsed from Git's stderr.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    /// For example "Receiving objects" or "Resolving deltas".
    pub phase: String,
    pub percent: Option<u8>,
    /// For example "450/1000, 1.20 MiB | 2.00 MiB/s".
    pub detail: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PullMode {
    /// Only fast-forward; refuse when the branches have diverged.
    FastForward,
    Merge,
    Rebase,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PushRequest {
    /// Local branch to push.
    pub branch: String,
    /// Remote to push to. `None` pushes to the branch's upstream.
    pub remote: Option<String>,
    /// Record the pushed branch as upstream (`--set-upstream`).
    #[serde(default)]
    pub set_upstream: bool,
    /// Force with lease: only overwrite the remote branch if it still is where
    /// our remote-tracking branch says it is.
    #[serde(default)]
    pub force: bool,
}

/// What a network operation changed, for a short confirmation in the UI.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteOutcome {
    /// Remote-tracking refs and tags updated by a fetch (including the fetch inside pull).
    pub updated_refs: u32,
    /// The pull stopped with conflicts that need to be resolved.
    pub conflicts: bool,
    /// The push or pull had nothing to do.
    pub up_to_date: bool,
    /// `remote/branch` that was pushed to or pulled from.
    pub target: Option<String>,
    /// Pull with autostash: the stashed changes could not be reapplied cleanly
    /// and are kept in the stash list, so nothing is lost.
    pub stash_kept: bool,
}

// ---------------------------------------------------------------- redaction

/// Remove credentials from every URL in `text`: `https://user:token@host/x` becomes
/// `https://***@host/x`. SSH-style `git@host:path` addresses carry no secret and stay.
pub fn redact(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(i) = rest.find("://") {
        let (head, tail) = rest.split_at(i + 3);
        out.push_str(head);
        let end = tail
            .find(|c: char| c == '/' || c.is_whitespace() || c == '\'' || c == '"')
            .unwrap_or(tail.len());
        let authority = &tail[..end];
        match authority.rfind('@') {
            Some(at) => {
                out.push_str("***");
                out.push_str(&authority[at..]);
            }
            None => out.push_str(authority),
        }
        rest = &tail[end..];
    }
    out.push_str(rest);
    out
}

// ---------------------------------------------------------------- remotes

/// Parse `git config -z --get-regexp '^remote\..*\.(url|pushurl)$'`.
pub fn parse_remotes(output: &[u8]) -> Vec<RemoteInfo> {
    let text = String::from_utf8_lossy(output);
    let mut order: Vec<String> = Vec::new();
    let mut urls: HashMap<String, (Option<String>, Option<String>)> = HashMap::new();
    for record in text.split('\0') {
        let Some((key, value)) = record.split_once('\n') else {
            continue;
        };
        let Some(rest) = key.strip_prefix("remote.") else {
            continue;
        };
        let Some((name, field)) = rest.rsplit_once('.') else {
            continue;
        };
        if name.is_empty() {
            continue;
        }
        if !urls.contains_key(name) {
            order.push(name.to_string());
        }
        let entry = urls.entry(name.to_string()).or_default();
        // The first URL wins, as in Git.
        match field {
            "url" if entry.0.is_none() => entry.0 = Some(value.to_string()),
            "pushurl" if entry.1.is_none() => entry.1 = Some(value.to_string()),
            _ => {}
        }
    }
    order
        .into_iter()
        .filter_map(|name| {
            let (url, push) = urls.remove(&name)?;
            let url = redact(&url?);
            let push_url = push.map(|p| redact(&p)).filter(|p| *p != url);
            Some(RemoteInfo {
                name,
                url,
                push_url,
            })
        })
        .collect()
}

fn remotes_at(root: &Path) -> Result<Vec<RemoteInfo>, GitError> {
    let out = run_git_with(
        root,
        &[
            "config",
            "-z",
            "--get-regexp",
            r"^remote\..*\.(url|pushurl)$",
        ],
        &RunOptions {
            // Exit code 1: no remotes configured.
            ok_codes: &[0, 1],
            ..RunOptions::default()
        },
    )?;
    Ok(parse_remotes(&out.stdout))
}

pub fn list_remotes(repo: &str) -> Result<Vec<RemoteInfo>, GitError> {
    let root = resolve_root(repo)?;
    remotes_at(&root)
}

/// Accept only names of configured remotes.
fn require_remote(root: &Path, name: &str) -> Result<(), GitError> {
    if remotes_at(root)?.iter().any(|r| r.name == name) {
        Ok(())
    } else {
        Err(GitError::Unsupported(format!(
            "There is no remote named \"{name}\"."
        )))
    }
}

// ---------------------------------------------------------------- managing remotes

/// Validate a remote name: Git's own rules, plus no leading dash or dot and no spaces.
pub fn validate_remote_name(root: &Path, name: &str) -> Result<(), GitError> {
    let invalid = |why: &str| Err(GitError::InvalidRemote(why.to_string()));
    if name.is_empty() {
        return invalid("Enter a name, for example origin or upstream.");
    }
    if name.contains(char::is_whitespace) {
        return invalid("Remote names cannot contain spaces.");
    }
    if name.starts_with('-') || name.starts_with('.') {
        return invalid("Remote names cannot start with a dash or a dot.");
    }
    let probe = format!("refs/remotes/{name}/HEAD");
    match run_git(root, &["check-ref-format", &probe], DEFAULT_TIMEOUT) {
        Ok(_) => Ok(()),
        Err(GitError::GitFailed { .. }) => {
            invalid("Not a valid remote name. Avoid `..`, `~`, `^`, `:`, `?`, `*`, `[` and `\\`.")
        }
        Err(e) => Err(e),
    }
}

/// Validate a remote URL or path before it is stored in the configuration.
pub fn validate_remote_url(url: &str) -> Result<(), GitError> {
    let invalid = |why: &str| Err(GitError::InvalidRemote(why.to_string()));
    if url.trim().is_empty() {
        return invalid("Enter the address of the repository.");
    }
    if url != url.trim() || url.chars().any(char::is_control) {
        return invalid("The address cannot contain spaces at the ends or line breaks.");
    }
    if url.starts_with('-') {
        return invalid("The address cannot start with a dash.");
    }
    if url.to_ascii_lowercase().starts_with("ext::") {
        return invalid("Remote helpers that run commands (ext::) are not allowed.");
    }
    if let Some(i) = url.find("://") {
        let authority = url[i + 3..].split('/').next().unwrap_or("");
        if let Some((userinfo, _)) = authority.rsplit_once('@') {
            if userinfo.contains(':') {
                return invalid(
                    "Leave the password or token out of the address; Git asks your credential helper for it.",
                );
            }
        }
    }
    Ok(())
}

/// Add a remote.
pub fn add_remote(repo: &str, name: &str, url: &str) -> Result<(), GitError> {
    let root = resolve_root(repo)?;
    let _guard = write_lock();
    validate_remote_name(&root, name)?;
    validate_remote_url(url)?;
    if remotes_at(&root)?.iter().any(|r| r.name == name) {
        return Err(GitError::InvalidRemote(format!(
            "A remote named {name} already exists."
        )));
    }
    run_git(&root, &["remote", "add", "--", name, url], DEFAULT_TIMEOUT)?;
    Ok(())
}

/// Rename a remote and/or change its addresses. `url` and `push_url` are the
/// values shown to the user: an unchanged (redacted) value is left alone, so a
/// stored credential is never replaced by `***`. An empty `push_url` removes a
/// separate push address.
pub fn edit_remote(
    repo: &str,
    name: &str,
    new_name: &str,
    url: &str,
    push_url: &str,
) -> Result<(), GitError> {
    let root = resolve_root(repo)?;
    let _guard = write_lock();
    let current = remotes_at(&root)?
        .into_iter()
        .find(|r| r.name == name)
        .ok_or_else(|| GitError::Unsupported(format!("There is no remote named \"{name}\".")))?;
    if url != current.url {
        validate_remote_url(url)?;
    }
    let push_changed = push_url != current.push_url.as_deref().unwrap_or("");
    if push_changed && !push_url.is_empty() {
        validate_remote_url(push_url)?;
    }
    let mut name = name.to_string();
    if new_name != name {
        validate_remote_name(&root, new_name)?;
        if remotes_at(&root)?.iter().any(|r| r.name == new_name) {
            return Err(GitError::InvalidRemote(format!(
                "A remote named {new_name} already exists."
            )));
        }
        run_git(
            &root,
            &["remote", "rename", "--", &name, new_name],
            DEFAULT_TIMEOUT,
        )?;
        name = new_name.to_string();
    }
    if url != current.url {
        run_git(
            &root,
            &["remote", "set-url", "--", &name, url],
            DEFAULT_TIMEOUT,
        )?;
    }
    if push_changed {
        if push_url.is_empty() {
            let key = format!("remote.{name}.pushurl");
            run_git_with(
                &root,
                &["config", "--unset-all", &key],
                &RunOptions {
                    // 5: the key was not set.
                    ok_codes: &[0, 5],
                    ..RunOptions::default()
                },
            )?;
        } else {
            let key = format!("remote.{name}.pushurl");
            run_git(
                &root,
                &["config", "--replace-all", &key, push_url],
                DEFAULT_TIMEOUT,
            )?;
        }
    }
    Ok(())
}

/// Remove a remote and its remote-tracking branches. Local branches stay; their
/// upstream setting is removed by Git.
pub fn remove_remote(repo: &str, name: &str) -> Result<(), GitError> {
    let root = resolve_root(repo)?;
    let _guard = write_lock();
    require_remote(&root, name)?;
    run_git(&root, &["remote", "remove", "--", name], DEFAULT_TIMEOUT)?;
    Ok(())
}

// ---------------------------------------------------------------- progress

/// Parse a progress line such as `remote: Counting objects:  50% (5/10)` or
/// `Receiving objects:  45% (450/1000), 1.20 MiB | 2.00 MiB/s`.
pub fn parse_progress(line: &str) -> Option<Progress> {
    let line = line.trim().strip_prefix("remote:").unwrap_or(line).trim();
    let (phase, rest) = line.split_once(':')?;
    let phase = phase.trim();
    let rest = rest.trim().trim_end_matches(", done.").trim();
    if phase.is_empty()
        || phase.len() > 40
        || !phase.chars().all(|c| c.is_ascii_alphabetic() || c == ' ')
    {
        return None;
    }
    if !rest.starts_with(|c: char| c.is_ascii_digit()) {
        return None;
    }
    let percent = rest
        .split_once('%')
        .and_then(|(n, _)| n.trim().parse::<u8>().ok())
        .filter(|p| *p <= 100);
    let detail = match rest.split_once('%') {
        Some((_, after)) if percent.is_some() => {
            let d = after.trim().trim_start_matches('(').replacen(')', "", 1);
            let d = d.trim().trim_start_matches(',').trim().to_string();
            (!d.is_empty()).then_some(d)
        }
        _ => Some(rest.to_string()),
    };
    Some(Progress {
        phase: phase.to_string(),
        percent,
        detail,
    })
}

/// Lines that never help explain a failure: progress, advice (`hint:`), and
/// fetch bookkeeping (`From <url>`, ` * branch main -> FETCH_HEAD`).
fn is_noise(line: &str) -> bool {
    let trimmed = line.trim();
    trimmed.is_empty()
        || parse_progress(line).is_some()
        || trimmed.starts_with("hint:")
        || line.starts_with("From ")
        || line.starts_with("To ")
        || (line.starts_with(' ') && line.contains(" -> ") && !trimmed.starts_with('!'))
}

/// Git's stderr without noise and with credentials removed, for error details.
fn clean_detail(stderr: &str) -> String {
    let lines: Vec<&str> = stderr.lines().filter(|l| !is_noise(l)).collect();
    redact(lines.join("\n").trim())
}

// ---------------------------------------------------------------- errors

/// Map a failed network command to a specific error.
pub fn classify_remote_failure(code: i32, stderr: &str) -> GitError {
    let detail = clean_detail(stderr);
    let lower = stderr.to_ascii_lowercase();
    let has = |needles: &[&str]| needles.iter().any(|n| lower.contains(n));

    if has(&[
        "host key verification failed",
        "remote host identification has changed",
        "no matching host key",
    ]) {
        GitError::HostKeyUnverified { detail }
    } else if has(&[
        "authentication failed",
        "could not read username",
        "could not read password",
        "terminal prompts disabled",
        "permission denied (publickey",
        "permission denied, please try again",
        "invalid username or password",
        "access denied",
        "returned error: 401",
        "returned error: 403",
    ]) {
        GitError::AuthFailed { detail }
    } else if has(&[
        "repository not found",
        "does not appear to be a git repository",
        "' does not exist",
        "returned error: 404",
        "not found\n",
    ]) {
        GitError::RemoteNotFound { detail }
    } else if has(&[
        "could not resolve host",
        "could not resolve hostname",
        "connection refused",
        "connection timed out",
        "operation timed out",
        "timed out after",
        "network is unreachable",
        "no route to host",
        "failed to connect",
        "connection reset",
        "unable to access",
        "could not read from remote repository",
        "the remote end hung up",
    ]) {
        GitError::NetworkFailed { detail }
    } else {
        match classify_failure(code, detail.clone()) {
            GitError::GitFailed { code, .. } => GitError::GitFailed {
                code,
                stderr: detail,
            },
            other => other,
        }
    }
}

// ---------------------------------------------------------------- execution

/// Marks a repository as busy with a network operation until dropped.
pub(crate) struct NetworkGuard(std::path::PathBuf);

fn busy_repos() -> &'static Mutex<std::collections::HashSet<std::path::PathBuf>> {
    static BUSY: OnceLock<Mutex<std::collections::HashSet<std::path::PathBuf>>> = OnceLock::new();
    BUSY.get_or_init(Default::default)
}

impl Drop for NetworkGuard {
    fn drop(&mut self) {
        busy_repos()
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&self.0);
    }
}

/// One network operation per repository at a time; it can run for minutes.
pub(crate) fn network_lock(root: &Path) -> Result<NetworkGuard, GitError> {
    let mut busy = busy_repos().lock().unwrap_or_else(|e| e.into_inner());
    if !busy.insert(root.to_path_buf()) {
        return Err(GitError::Locked {
            detail: "Another fetch, pull or push is still running.".into(),
        });
    }
    Ok(NetworkGuard(root.to_path_buf()))
}

/// Running operations by id, so the UI can cancel them.
fn registry() -> &'static Mutex<HashMap<String, CancelToken>> {
    static OPS: OnceLock<Mutex<HashMap<String, CancelToken>>> = OnceLock::new();
    OPS.get_or_init(Default::default)
}

/// Cancel the operation started with `op_id`. Unknown ids are ignored (it may have finished).
pub fn cancel(op_id: &str) {
    if let Some(token) = registry()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(op_id)
    {
        token.cancel();
    }
}

struct Registration(String);
impl Drop for Registration {
    fn drop(&mut self) {
        registry()
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&self.0);
    }
}

fn register(op_id: &str) -> (CancelToken, Registration) {
    let token = CancelToken::default();
    registry()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(op_id.to_string(), token.clone());
    (token, Registration(op_id.to_string()))
}

/// Environment for commands that talk to a remote.
///
/// SSH runs in batch mode so it fails instead of waiting for a password or
/// host-key prompt nobody can answer, unless the user chose their own SSH
/// command (`GIT_SSH_COMMAND`, `GIT_SSH` or `core.sshCommand`), which wins.
pub(crate) fn network_env(root: &Path) -> Vec<(String, String)> {
    if std::env::var_os("GIT_SSH_COMMAND").is_some() || std::env::var_os("GIT_SSH").is_some() {
        return Vec::new();
    }
    let configured = run_git_with(
        root,
        &["config", "--get", "core.sshCommand"],
        &RunOptions {
            ok_codes: &[0, 1],
            ..RunOptions::default()
        },
    )
    .map(|o| !o.stdout_string().trim().is_empty())
    .unwrap_or(false);
    if configured {
        Vec::new()
    } else {
        vec![("GIT_SSH_COMMAND".into(), "ssh -o BatchMode=yes".into())]
    }
}

pub(crate) fn run_network(
    root: &Path,
    args: &[&str],
    op_id: &str,
    on_progress: &mut dyn FnMut(Progress),
) -> Result<GitOutput, GitError> {
    let (cancel, _registration) = register(op_id);
    let opts = StreamOptions {
        timeout: NETWORK_TIMEOUT,
        env: network_env(root),
        cancel,
    };
    // Git repaints the same line many times; forward only visible changes.
    let mut last: Option<(String, Option<u8>)> = None;
    run_git_streaming(root, args, &opts, &mut |line| {
        if let Some(p) = parse_progress(line) {
            let key = (p.phase.clone(), p.percent);
            if last.as_ref() != Some(&key) {
                last = Some(key);
                on_progress(p);
            }
        }
    })
}

/// Count ref updates in fetch output (` * [new branch]  x -> origin/x`, `   a..b  main -> origin/main`).
pub fn count_ref_updates(stderr: &str) -> u32 {
    stderr
        .lines()
        .filter(|l| {
            let b = l.as_bytes();
            b.len() > 3
                && b[0] == b' '
                && matches!(b[1], b' ' | b'*' | b'+' | b'-' | b't')
                && b[2] == b' '
                && l.contains(" -> ")
        })
        .count() as u32
}

// ---------------------------------------------------------------- fetch

/// Fetch one remote, or all remotes when `remote` is `None`, pruning deleted branches.
pub fn fetch(
    repo: &str,
    remote: Option<&str>,
    op_id: &str,
    on_progress: &mut dyn FnMut(Progress),
) -> Result<RemoteOutcome, GitError> {
    let root = resolve_root(repo)?;
    let _net = network_lock(&root)?;
    let mut args = vec!["fetch", "--progress", "--prune"];
    match remote {
        Some(name) => {
            require_remote(&root, name)?;
            args.push("--");
            args.push(name);
        }
        None => {
            if remotes_at(&root)?.is_empty() {
                return Err(GitError::Unsupported(
                    "This repository has no remotes to fetch from.".into(),
                ));
            }
            args.push("--all");
        }
    }
    let out = run_network(&root, &args, op_id, on_progress)?;
    if out.code != 0 {
        return Err(classify_remote_failure(out.code, &out.stderr));
    }
    let updated = count_ref_updates(&out.stderr);
    Ok(RemoteOutcome {
        updated_refs: updated,
        up_to_date: updated == 0,
        target: remote.map(str::to_string),
        ..RemoteOutcome::default()
    })
}

// ---------------------------------------------------------------- pull

struct Upstream {
    remote: String,
    /// Full ref on the remote, `refs/heads/main`.
    merge_ref: String,
    /// Short tracking name, `origin/main`.
    short: String,
    exists: bool,
}

/// Upstream of a local branch, or `None` when it has none.
fn upstream_of(root: &Path, branch: &str) -> Result<Option<Upstream>, GitError> {
    let full = format!("refs/heads/{branch}");
    let out = run_git(
        root,
        &[
            "for-each-ref",
            "--format=%(upstream:remotename)%00%(upstream:remoteref)%00%(upstream:short)%00%(upstream)",
            &full,
        ],
        DEFAULT_TIMEOUT,
    )?;
    let text = out.stdout_string();
    let line = text.lines().next().unwrap_or("");
    let f: Vec<&str> = line.split('\0').collect();
    if f.len() != 4 || f[0].is_empty() || f[1].is_empty() {
        return Ok(None);
    }
    let tracking = f[3];
    let exists = !tracking.is_empty()
        && run_git_with(
            root,
            &["rev-parse", "--verify", "--quiet", tracking],
            &RunOptions {
                ok_codes: &[0, 1],
                ..RunOptions::default()
            },
        )?
        .code
            == 0;
    Ok(Some(Upstream {
        remote: f[0].to_string(),
        merge_ref: f[1].to_string(),
        short: f[2].to_string(),
        exists,
    }))
}

fn current_branch(repo: &str) -> Result<String, GitError> {
    let info = inspect(repo)?;
    if info.operation.is_some() {
        return Err(GitError::Unsupported(
            "Finish or abort the operation in progress (merge, rebase, ...) first.".into(),
        ));
    }
    match info.head {
        HeadState::Branch { name, .. } => Ok(name),
        HeadState::Unborn { name } => {
            Err(GitError::Unsupported(format!("{name} has no commits yet.")))
        }
        HeadState::Detached { .. } => Err(GitError::Unsupported(
            "You are not on a branch (detached HEAD). Switch to a branch first.".into(),
        )),
    }
}

/// Pull the current branch from its upstream.
pub fn pull(
    repo: &str,
    mode: PullMode,
    autostash: bool,
    op_id: &str,
    on_progress: &mut dyn FnMut(Progress),
) -> Result<RemoteOutcome, GitError> {
    let root = resolve_root(repo)?;
    let _net = network_lock(&root)?;
    let _write = write_lock();
    let branch = current_branch(repo)?;
    let upstream = upstream_of(&root, &branch)?.ok_or(GitError::NoUpstream {
        branch: branch.clone(),
    })?;
    if !upstream.exists {
        // The tracking ref is missing (deleted on the remote and pruned); pulling would fail.
        return Err(GitError::NoUpstream { branch });
    }
    if autostash {
        let v = super::runner::git_version()?;
        if (v.major, v.minor) < (2, 27) {
            return Err(GitError::Unsupported(format!(
                "Stashing changes during a pull needs Git 2.27 or newer (found {}).",
                v.version
            )));
        }
    }
    let before = run_git(&root, &["rev-parse", "HEAD"], DEFAULT_TIMEOUT)?.stdout_string();

    let mode_args: &[&str] = match mode {
        PullMode::FastForward => &["--no-rebase", "--ff-only"],
        PullMode::Merge => &["--no-rebase"],
        PullMode::Rebase => &["--rebase"],
    };
    let mut args = vec!["pull", "--progress", "--no-edit"];
    args.extend_from_slice(mode_args);
    if autostash {
        // Stash uncommitted changes (also untracked files that would be in the way),
        // pull, then reapply them.
        args.push("--autostash");
    }
    // Explicit remote and branch, so the result never depends on push/merge defaults.
    args.push("--");
    args.push(&upstream.remote);
    args.push(&upstream.merge_ref);
    let out = run_network(&root, &args, op_id, on_progress)?;

    let target = Some(upstream.short.clone());
    let all_output = format!("{}\n{}", out.stdout_string(), out.stderr);
    // With --autostash, Git reports a reapply that did not go cleanly but keeps the stash.
    let stash_kept = autostash && all_output.contains("Applying autostash resulted in conflicts");
    let updated_refs = count_ref_updates(&out.stderr);
    if out.code != 0 {
        // A merge or rebase that stopped with conflicts is a result, not a failure.
        if inspect(repo)?.operation.is_some() {
            return Ok(RemoteOutcome {
                conflicts: true,
                target,
                updated_refs,
                up_to_date: false,
                stash_kept,
            });
        }
        if !stash_kept {
            return Err(classify_pull_failure(out.code, &out.stderr));
        }
    }
    let after = run_git(&root, &["rev-parse", "HEAD"], DEFAULT_TIMEOUT)?.stdout_string();
    Ok(RemoteOutcome {
        updated_refs,
        up_to_date: before == after,
        target,
        conflicts: stash_kept,
        stash_kept,
    })
}

fn classify_pull_failure(code: i32, stderr: &str) -> GitError {
    let detail = clean_detail(stderr);
    let lower = stderr.to_ascii_lowercase();
    if lower.contains("not possible to fast-forward") || lower.contains("diverging branches") {
        return GitError::Diverged { detail };
    }
    if lower.contains("would be overwritten by merge")
        || lower.contains("would be overwritten by checkout")
        || lower.contains("cannot pull with rebase")
        || lower.contains("your local changes")
        || lower.contains("untracked working tree files would be")
    {
        let files = stderr
            .lines()
            .filter(|l| l.starts_with('\t'))
            .map(|l| l.trim().to_string())
            .collect();
        return GitError::CheckoutConflict { files, detail };
    }
    if lower.contains("please tell me who you are") || lower.contains("unable to auto-detect email")
    {
        return GitError::IdentityMissing { detail };
    }
    classify_remote_failure(code, stderr)
}

// ---------------------------------------------------------------- push

/// Parse `git push --porcelain` output into a rejection, if any.
pub fn push_rejection(stdout: &str, stderr: &str) -> Option<GitError> {
    let detail = clean_detail(stderr);
    for line in stdout.lines() {
        let mut fields = line.split('\t');
        if fields.next() != Some("!") {
            continue;
        }
        let summary = fields.nth(1).unwrap_or("").to_ascii_lowercase();
        let detail = if detail.is_empty() {
            line.to_string()
        } else {
            detail.clone()
        };
        return Some(if summary.contains("already exists") {
            GitError::TagConflict { detail }
        } else if summary.contains("stale info") {
            GitError::StaleLease { detail }
        } else if summary.contains("remote rejected") {
            GitError::RemoteRejected { detail }
        } else if summary.contains("fetch first") || summary.contains("non-fast-forward") {
            GitError::PushRejected { detail }
        } else {
            GitError::RemoteRejected { detail }
        });
    }
    None
}

/// Push a tag to `remote`, or with `delete`, remove the tag there.
/// Never forces: a different tag with the same name on the remote is reported as
/// [`GitError::TagConflict`], not overwritten.
pub fn push_tag(
    repo: &str,
    name: &str,
    remote: &str,
    delete: bool,
    op_id: &str,
    on_progress: &mut dyn FnMut(Progress),
) -> Result<RemoteOutcome, GitError> {
    let root = resolve_root(repo)?;
    super::tags::validate_tag_name(&root, name)?;
    let _net = network_lock(&root)?;
    require_remote(&root, remote)?;
    let full = format!("refs/tags/{name}");
    let refspec = if delete {
        format!(":{full}")
    } else {
        let exists = run_git_with(
            &root,
            &["rev-parse", "--verify", "--quiet", &full],
            &RunOptions {
                ok_codes: &[0, 1],
                ..RunOptions::default()
            },
        )?
        .code
            == 0;
        if !exists {
            return Err(GitError::Stale);
        }
        format!("{full}:{full}")
    };
    let args = ["push", "--progress", "--porcelain", "--", remote, &refspec];
    let out = run_network(&root, &args, op_id, on_progress)?;
    let stdout = out.stdout_string();
    let target = Some(format!("{remote}/{name}"));
    // Git reports a tag that is already gone either as an error ("remote ref does not
    // exist") or, in newer versions, as a warning; either way the goal is reached.
    if delete
        && (out.stderr.contains("remote ref does not exist")
            || out.stderr.contains("deleting a non-existent ref"))
    {
        return Ok(RemoteOutcome {
            up_to_date: true,
            target,
            ..RemoteOutcome::default()
        });
    }
    if let Some(rejection) = push_rejection(&stdout, &out.stderr) {
        return Err(rejection);
    }
    if out.code != 0 {
        return Err(classify_remote_failure(out.code, &out.stderr));
    }
    Ok(RemoteOutcome {
        up_to_date: stdout.lines().any(|l| l.starts_with('=')),
        target,
        ..RemoteOutcome::default()
    })
}

/// Push a local branch. Without `remote`, it goes to the branch's upstream.
pub fn push(
    repo: &str,
    request: &PushRequest,
    op_id: &str,
    on_progress: &mut dyn FnMut(Progress),
) -> Result<RemoteOutcome, GitError> {
    let root = resolve_root(repo)?;
    validate_branch_name(&root, &request.branch)?;
    let _net = network_lock(&root)?;
    let local = format!("refs/heads/{}", request.branch);
    let exists = run_git_with(
        &root,
        &["rev-parse", "--verify", "--quiet", &local],
        &RunOptions {
            ok_codes: &[0, 1],
            ..RunOptions::default()
        },
    )?
    .code
        == 0;
    if !exists {
        return Err(GitError::Unsupported(format!(
            "There is no local branch named {}.",
            request.branch
        )));
    }

    let upstream = upstream_of(&root, &request.branch)?;
    let (remote, dest) = match (&request.remote, &upstream) {
        (Some(remote), Some(u)) if *remote == u.remote => (remote.clone(), u.merge_ref.clone()),
        (Some(remote), _) => (remote.clone(), local.clone()),
        (None, Some(u)) => (u.remote.clone(), u.merge_ref.clone()),
        (None, None) => {
            return Err(GitError::NoUpstream {
                branch: request.branch.clone(),
            })
        }
    };
    require_remote(&root, &remote)?;
    if !dest.starts_with("refs/heads/") {
        return Err(GitError::Unsupported(format!(
            "The upstream {dest} is not a branch."
        )));
    }

    let refspec = format!("{local}:{dest}");
    let lease = format!("--force-with-lease={dest}");
    let mut args = vec!["push", "--progress", "--porcelain"];
    if request.set_upstream {
        args.push("--set-upstream");
    }
    if request.force {
        args.push(&lease);
    }
    args.push("--");
    args.push(&remote);
    args.push(&refspec);
    let out = run_network(&root, &args, op_id, on_progress)?;
    let stdout = out.stdout_string();
    if let Some(rejection) = push_rejection(&stdout, &out.stderr) {
        return Err(rejection);
    }
    if out.code != 0 {
        return Err(classify_remote_failure(out.code, &out.stderr));
    }
    let up_to_date = stdout
        .lines()
        .any(|l| l.starts_with('=') && l.contains(&refspec));
    Ok(RemoteOutcome {
        up_to_date,
        target: Some(format!(
            "{remote}/{}",
            dest.trim_start_matches("refs/heads/")
        )),
        ..RemoteOutcome::default()
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redacts_credentials_in_urls() {
        assert_eq!(
            redact("https://user:s3cret@example.com/a.git"),
            "https://***@example.com/a.git"
        );
        assert_eq!(
            redact("fatal: unable to access 'https://ghp_TOKEN@github.com/o/r.git/': 403"),
            "fatal: unable to access 'https://***@github.com/o/r.git/': 403"
        );
        assert_eq!(redact("git@github.com:o/r.git"), "git@github.com:o/r.git");
        assert_eq!(
            redact("ssh://git@host:22/x and https://h/y"),
            "ssh://***@host:22/x and https://h/y"
        );
        assert_eq!(redact("no urls here"), "no urls here");
    }

    #[test]
    fn parses_remotes_in_config_order() {
        let raw = b"remote.origin.url\nhttps://u:p@h/o.git\0remote.up.stream.url\ngit@h:x.git\0remote.origin.pushurl\nhttps://h/push.git\0";
        let remotes = parse_remotes(raw);
        assert_eq!(remotes.len(), 2);
        assert_eq!(remotes[0].name, "origin");
        assert_eq!(remotes[0].url, "https://***@h/o.git");
        assert_eq!(remotes[0].push_url.as_deref(), Some("https://h/push.git"));
        assert_eq!(remotes[1].name, "up.stream");
        assert_eq!(remotes[1].push_url, None);
    }

    #[test]
    fn parses_progress_lines() {
        assert_eq!(
            parse_progress("Receiving objects:  45% (450/1000), 1.20 MiB | 2.00 MiB/s"),
            Some(Progress {
                phase: "Receiving objects".into(),
                percent: Some(45),
                detail: Some("450/1000, 1.20 MiB | 2.00 MiB/s".into()),
            })
        );
        assert_eq!(
            parse_progress("remote: Counting objects: 100% (10/10), done."),
            Some(Progress {
                phase: "Counting objects".into(),
                percent: Some(100),
                detail: Some("10/10".into()),
            })
        );
        assert_eq!(
            parse_progress("remote: Enumerating objects: 5, done."),
            Some(Progress {
                phase: "Enumerating objects".into(),
                percent: None,
                detail: Some("5".into()),
            })
        );
        assert_eq!(parse_progress("From ../remote"), None);
        assert_eq!(parse_progress(" * [new branch]      x -> origin/x"), None);
        assert_eq!(
            parse_progress("fatal: unable to access 'https://h/': 403"),
            None
        );
        assert_eq!(parse_progress("hint: Updates were rejected"), None);
    }

    #[test]
    fn classifies_network_failures() {
        let kind = |s: &str| classify_remote_failure(128, s).kind();
        assert_eq!(
            kind("fatal: could not read Username for 'https://github.com': terminal prompts disabled"),
            "authFailed"
        );
        assert_eq!(
            kind("git@github.com: Permission denied (publickey).\nfatal: Could not read from remote repository."),
            "authFailed"
        );
        assert_eq!(
            kind("Host key verification failed.\nfatal: Could not read from remote repository."),
            "hostKeyUnverified"
        );
        assert_eq!(
            kind("fatal: unable to access 'https://nope.invalid/x.git/': Could not resolve host: nope.invalid"),
            "networkFailed"
        );
        assert_eq!(
            kind("remote: Repository not found.\nfatal: repository 'https://github.com/o/x.git/' not found"),
            "remoteNotFound"
        );
        assert_eq!(
            kind("fatal: '/tmp/nope' does not appear to be a git repository\nfatal: Could not read from remote repository."),
            "remoteNotFound"
        );
        assert_eq!(kind("error: something else"), "gitFailed");
    }

    #[test]
    fn detail_drops_progress_and_secrets() {
        let err = classify_remote_failure(
            128,
            "Receiving objects:  10% (1/10)\nfatal: unable to access 'https://me:pw@h/x/': Failed to connect",
        );
        assert_eq!(err.kind(), "networkFailed");
        assert_eq!(
            err.detail(),
            Some("fatal: unable to access 'https://***@h/x/': Failed to connect")
        );
    }

    #[test]
    fn detail_keeps_the_reason_and_drops_advice() {
        let stderr = "From /srv/remote\n * branch            develop    -> FETCH_HEAD\nhint: Diverging branches can't be fast-forwarded, you need to either:\nhint:\nhint: \tgit merge --no-ff\nfatal: Not possible to fast-forward, aborting.";
        assert_eq!(
            clean_detail(stderr),
            "fatal: Not possible to fast-forward, aborting."
        );
        let push = "To /srv/remote.git\n ! [rejected]        main -> main (fetch first)\nerror: failed to push some refs to '/srv/remote.git'\nhint: Updates were rejected";
        assert_eq!(
            clean_detail(push),
            "! [rejected]        main -> main (fetch first)\nerror: failed to push some refs to '/srv/remote.git'"
        );
    }

    #[test]
    fn reads_push_rejections() {
        let rejected =
            "To ../r.git\n!\trefs/heads/main:refs/heads/main\t[rejected] (fetch first)\nDone\n";
        assert_eq!(push_rejection(rejected, "").unwrap().kind(), "pushRejected");
        let stale = "!\trefs/heads/main:refs/heads/main\t[rejected] (stale info)\n";
        assert_eq!(push_rejection(stale, "").unwrap().kind(), "staleLease");
        let hook =
            "!\trefs/heads/main:refs/heads/main\t[remote rejected] (pre-receive hook declined)\n";
        assert_eq!(push_rejection(hook, "").unwrap().kind(), "remoteRejected");
        let ok = "To ../r.git\n \trefs/heads/main:refs/heads/main\ta..b\nDone\n";
        assert!(push_rejection(ok, "").is_none());
    }

    #[test]
    fn counts_fetched_ref_updates() {
        let stderr = "From ../remote\n   a1..b2  develop    -> origin/develop\n * [new branch]      x -> origin/x\n - [deleted]         (none) -> origin/gone\n * [new tag]         v1 -> v1\n ! [rejected]        y -> origin/y  (non-fast-forward)\n";
        assert_eq!(count_ref_updates(stderr), 4);
        assert_eq!(count_ref_updates("Receiving objects: 100% (3/3), done."), 0);
    }
}
