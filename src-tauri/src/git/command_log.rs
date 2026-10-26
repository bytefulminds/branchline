//! A record of the Git commands Branchline runs, for the Git console.
//!
//! Every call through the runner is recorded with its arguments, folder, exit code, duration
//! and output, so users can see what Branchline did and why something failed (for example
//! the output of a failing hook). The log lives in memory only: it is never written to disk
//! and is gone when Branchline quits.
//!
//! Limits keep it small: the newest [`MAX_ENTRIES`] commands, and per command the first
//! [`MAX_STDOUT`] bytes of standard output and [`MAX_STDERR`] bytes of error output.
//! Credentials in URLs are removed from arguments and output before they are stored.

use std::path::Path;
use std::sync::Mutex;
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use serde::Serialize;

use super::remote::redact;
use super::runner::GitOutput;
use crate::error::GitError;

pub const MAX_ENTRIES: usize = 500;
pub const MAX_STDOUT: usize = 8 * 1024;
pub const MAX_STDERR: usize = 32 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandEntry {
    /// Stable id of this command.
    pub id: u64,
    /// Changes whenever the entry changes (started, then finished); see [`since`].
    pub seq: u64,
    /// Start time, milliseconds since the Unix epoch.
    pub started_at: u64,
    /// `None` while the command runs.
    pub duration_ms: Option<u64>,
    /// Folder the command ran in.
    pub cwd: String,
    /// Arguments after `git`, without the safety options Branchline adds to every call.
    pub args: Vec<String>,
    /// The command only reads (status, log, diff...); used to hide routine refreshes.
    pub read_only: bool,
    /// `None` while running, or when Git did not finish (timeout, cancelled, not started).
    pub exit_code: Option<i32>,
    /// `None` while running.
    pub ok: Option<bool>,
    /// Why the command did not finish normally (timeout, cancelled, could not start).
    pub error: Option<String>,
    pub stdout: String,
    pub stdout_bytes: usize,
    pub stderr: String,
    pub stderr_bytes: usize,
    /// Bytes Branchline sent on standard input (patches, commit messages); not stored.
    pub stdin_bytes: Option<usize>,
}

struct Log {
    next_id: u64,
    seq: u64,
    entries: std::collections::VecDeque<CommandEntry>,
}

static LOG: Mutex<Log> = Mutex::new(Log {
    next_id: 1,
    seq: 0,
    entries: std::collections::VecDeque::new(),
});

fn lock() -> std::sync::MutexGuard<'static, Log> {
    LOG.lock().unwrap_or_else(|e| e.into_inner())
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or_default()
}

/// The subcommand, skipping options that come before it (`-c key=value`, `-C dir`).
fn subcommand<'a>(args: &[&'a str]) -> (Option<&'a str>, Vec<&'a str>) {
    let mut i = 0;
    while i < args.len() {
        match args[i] {
            "-c" | "-C" => i += 2,
            a if a.starts_with('-') => i += 1,
            a => return (Some(a), args[i + 1..].to_vec()),
        }
    }
    (None, Vec::new())
}

/// Whether a command only reads. Unknown commands count as changes, so they stay visible.
pub fn is_read_only(args: &[&str]) -> bool {
    let (Some(sub), rest) = subcommand(args) else {
        return true; // `git --version`
    };
    let has = |flags: &[&str]| rest.iter().any(|a| flags.iter().any(|f| a.starts_with(f)));
    let positional: Vec<&&str> = rest.iter().filter(|a| !a.starts_with('-')).collect();
    match sub {
        "status" | "rev-parse" | "log" | "show" | "diff" | "diff-tree" | "diff-index"
        | "diff-files" | "for-each-ref" | "cat-file" | "ls-files" | "ls-tree" | "rev-list"
        | "merge-base" | "show-ref" | "describe" | "version" | "check-ref-format"
        | "check-ignore" | "check-attr" | "name-rev" | "blame" | "grep" | "var" | "ls-remote"
        | "count-objects" | "shortlog" => true,
        "config" => has(&["--get", "--list", "-l"]),
        "branch" => has(&[
            "--list",
            "--format",
            "--show-current",
            "--contains",
            "--merged",
        ]),
        "tag" => has(&["-l", "--list"]),
        "symbolic-ref" => positional.len() <= 1 && !has(&["-d", "--delete"]),
        "worktree" | "stash" => matches!(positional.first().map(|s| **s), Some("list" | "show")),
        "remote" => matches!(
            positional.first().map(|s| **s),
            None | Some("get-url" | "show")
        ),
        _ => false,
    }
}

fn clip(text: &str, max: usize) -> String {
    if text.len() <= max {
        return text.to_string();
    }
    let mut end = max;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    text[..end].to_string()
}

/// A command that has started; pass it to [`finish`].
pub struct Running {
    id: u64,
    started: Instant,
}

/// Record that a command started.
pub fn start(cwd: &Path, args: &[&str], stdin_bytes: Option<usize>) -> Running {
    let mut log = lock();
    let id = log.next_id;
    log.next_id += 1;
    log.seq += 1;
    let entry = CommandEntry {
        id,
        seq: log.seq,
        started_at: now_ms(),
        duration_ms: None,
        cwd: cwd.display().to_string(),
        args: args.iter().map(|a| redact(a)).collect(),
        read_only: is_read_only(args),
        exit_code: None,
        ok: None,
        error: None,
        stdout: String::new(),
        stdout_bytes: 0,
        stderr: String::new(),
        stderr_bytes: 0,
        stdin_bytes,
    };
    log.entries.push_back(entry);
    while log.entries.len() > MAX_ENTRIES {
        log.entries.pop_front();
    }
    Running {
        id,
        started: Instant::now(),
    }
}

/// Record how a command ended. `ok` says whether the caller accepts the exit code.
pub fn finish(running: Running, result: &Result<GitOutput, GitError>, ok: impl Fn(i32) -> bool) {
    let duration = running.started.elapsed().as_millis() as u64;
    let mut log = lock();
    log.seq += 1;
    let seq = log.seq;
    let Some(entry) = log.entries.iter_mut().rev().find(|e| e.id == running.id) else {
        return; // Dropped from the log while it ran.
    };
    entry.seq = seq;
    entry.duration_ms = Some(duration);
    match result {
        Ok(out) => {
            entry.exit_code = Some(out.code);
            entry.ok = Some(ok(out.code));
            entry.stdout_bytes = out.stdout.len();
            entry.stdout = redact(&String::from_utf8_lossy(
                &out.stdout[..out.stdout.len().min(MAX_STDOUT)],
            ));
            entry.stderr_bytes = out.stderr.len();
            entry.stderr = redact(&clip(&out.stderr, MAX_STDERR));
        }
        Err(e) => {
            entry.ok = Some(false);
            entry.error = Some(e.to_string());
            if let Some(detail) = e.detail() {
                entry.stderr_bytes = detail.len();
                entry.stderr = redact(&clip(detail, MAX_STDERR));
            }
        }
    }
}

/// Entries that started or finished after `seq` (0 for all), oldest first.
pub fn since(seq: u64) -> Vec<CommandEntry> {
    lock()
        .entries
        .iter()
        .filter(|e| e.seq > seq)
        .cloned()
        .collect()
}

/// Forget every entry (running commands still finish, but are no longer shown).
pub fn clear() {
    let mut log = lock();
    log.entries.clear();
    log.seq += 1;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_read_only_commands() {
        for read in [
            &["status", "--porcelain=v2"][..],
            &["-c", "x=y", "log", "-n", "5"],
            &["config", "--get", "user.name"],
            &["stash", "list"],
            &["worktree", "list", "--porcelain"],
            &["symbolic-ref", "--short", "HEAD"],
            &["remote", "-v"],
            &["--version"],
        ] {
            assert!(is_read_only(read), "{read:?} reads");
        }
        for write in [
            &["commit", "-F", "-"][..],
            &["config", "user.name", "Ada"],
            &["stash", "push"],
            &["symbolic-ref", "HEAD", "refs/heads/main"],
            &["remote", "add", "origin", "x"],
            &["push", "origin", "main"],
            &["frobnicate"],
        ] {
            assert!(!is_read_only(write), "{write:?} changes something");
        }
    }

    #[test]
    fn clips_at_character_boundaries() {
        assert_eq!(clip("héllo", 2), "h");
        assert_eq!(clip("abc", 10), "abc");
    }
}
