//! Safe execution of the native Git CLI.
//!
//! * Arguments are always passed as a vector, never through a shell.
//! * Interactive prompts are disabled so a command can never hang waiting for input.
//! * Repository-controlled settings that can execute programs during read-only
//!   operations (for example `core.fsmonitor`) are overridden.
//! * Every invocation has a timeout; the child process is killed when it expires.

use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, OnceLock};
use std::thread;
use std::time::{Duration, Instant};

use crate::error::GitError;

/// Default timeout for local, read-only Git commands.
pub const DEFAULT_TIMEOUT: Duration = Duration::from_secs(30);

/// Options applied to every Git invocation, before the subcommand.
const GLOBAL_ARGS: &[&str] = &[
    "--no-optional-locks",
    "-c",
    "core.fsmonitor=false",
    "-c",
    "core.quotepath=false",
    "-c",
    "color.ui=false",
    "-c",
    "log.showSignature=false",
];

/// Environment variables that would redirect Git away from the repository we ask for.
const SCRUBBED_ENV: &[&str] = &[
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_INDEX_FILE",
    "GIT_OBJECT_DIRECTORY",
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_NAMESPACE",
    "GIT_CEILING_DIRECTORIES",
];

#[derive(Debug)]
pub struct GitOutput {
    pub stdout: Vec<u8>,
    pub stderr: String,
    /// Exit code (always one of the accepted codes).
    pub code: i32,
}

/// Per-invocation options for [`run_git_with`].
#[derive(Debug, Clone)]
pub struct RunOptions<'a> {
    pub timeout: Duration,
    /// Bytes written to the child's stdin (for example a patch for `git apply`).
    pub stdin: Option<&'a [u8]>,
    /// Exit codes treated as success. `git diff --no-index` exits 1 when files differ.
    pub ok_codes: &'a [i32],
    /// Kill the process and fail with [`GitError::OutputTooLarge`] beyond this many stdout bytes.
    pub max_output: Option<usize>,
}

impl Default for RunOptions<'_> {
    fn default() -> Self {
        RunOptions {
            timeout: DEFAULT_TIMEOUT,
            stdin: None,
            ok_codes: &[0],
            max_output: None,
        }
    }
}

impl GitOutput {
    pub fn stdout_string(&self) -> String {
        String::from_utf8_lossy(&self.stdout).into_owned()
    }
}

/// Locate the Git executable once per process.
///
/// GUI applications on macOS start with a minimal PATH, so well-known install
/// locations are checked in addition to PATH.
pub fn git_binary() -> Result<&'static Path, GitError> {
    static GIT: OnceLock<Option<PathBuf>> = OnceLock::new();
    GIT.get_or_init(find_git)
        .as_deref()
        .ok_or(GitError::GitNotFound)
}

fn find_git() -> Option<PathBuf> {
    let exe = if cfg!(windows) { "git.exe" } else { "git" };
    if let Some(paths) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&paths) {
            let candidate = dir.join(exe);
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    let fallbacks: &[&str] = if cfg!(windows) {
        &[
            r"C:\Program Files\Git\cmd\git.exe",
            r"C:\Program Files (x86)\Git\cmd\git.exe",
        ]
    } else {
        &[
            "/opt/homebrew/bin/git",
            "/usr/local/bin/git",
            "/usr/bin/git",
        ]
    };
    fallbacks.iter().map(PathBuf::from).find(|p| p.is_file())
}

/// Run `git <GLOBAL_ARGS> <args>` in `cwd`.
///
/// Returns the output on exit status 0, otherwise a classified [`GitError`].
pub fn run_git(cwd: &Path, args: &[&str], timeout: Duration) -> Result<GitOutput, GitError> {
    run_git_with(
        cwd,
        args,
        &RunOptions {
            timeout,
            ..RunOptions::default()
        },
    )
}

/// Build the hardened `git` command: global options, environment and pipes.
fn git_command(cwd: &Path, args: &[&str]) -> Result<Command, GitError> {
    let git = git_binary()?;
    let mut cmd = Command::new(git);
    cmd.args(GLOBAL_ARGS)
        .args(args)
        .current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_ASKPASS", "")
        .env("SSH_ASKPASS", "")
        .env("GCM_INTERACTIVE", "never")
        // Paths from the UI are file names, never glob patterns (`*.txt` is a real file name).
        .env("GIT_LITERAL_PATHSPECS", "1")
        .env("LC_ALL", "C")
        .env("LANGUAGE", "C");
    for key in SCRUBBED_ENV {
        cmd.env_remove(key);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    Ok(cmd)
}

fn spawn(cmd: &mut Command) -> Result<std::process::Child, GitError> {
    cmd.spawn().map_err(|e| match e.kind() {
        std::io::ErrorKind::NotFound => GitError::GitNotFound,
        _ => GitError::Internal(format!("failed to start git: {e}")),
    })
}

/// Run Git with explicit options. See [`RunOptions`].
pub fn run_git_with(
    cwd: &Path,
    args: &[&str],
    opts: &RunOptions<'_>,
) -> Result<GitOutput, GitError> {
    let mut cmd = git_command(cwd, args)?;
    cmd.stdin(if opts.stdin.is_some() {
        Stdio::piped()
    } else {
        Stdio::null()
    });

    let mut child = spawn(&mut cmd)?;

    // Feed stdin from its own thread so a child that writes before reading cannot deadlock.
    let stdin_thread = match (opts.stdin, child.stdin.take()) {
        (Some(data), Some(mut pipe)) => {
            let data = data.to_vec();
            Some(thread::spawn(move || {
                let _ = pipe.write_all(&data);
                // Dropping the pipe closes stdin.
            }))
        }
        _ => None,
    };

    // Drain both pipes on their own threads so a large output can never deadlock.
    let overflow = Arc::new(AtomicBool::new(false));
    let mut stdout_pipe = child.stdout.take().expect("stdout is piped");
    let mut stderr_pipe = child.stderr.take().expect("stderr is piped");
    let limit = opts.max_output;
    let overflow_flag = Arc::clone(&overflow);
    let stdout_thread = thread::spawn(move || {
        let mut buf = Vec::new();
        let mut chunk = [0u8; 64 * 1024];
        loop {
            match stdout_pipe.read(&mut chunk) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    buf.extend_from_slice(&chunk[..n]);
                    if limit.is_some_and(|max| buf.len() > max) {
                        overflow_flag.store(true, Ordering::SeqCst);
                        break;
                    }
                }
            }
        }
        buf
    });
    let stderr_thread = thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = stderr_pipe.read_to_end(&mut buf);
        buf
    });

    let deadline = Instant::now() + opts.timeout;
    let status = loop {
        if overflow.load(Ordering::SeqCst) {
            let _ = child.kill();
            let _ = child.wait();
            return Err(GitError::OutputTooLarge {
                limit_bytes: opts.max_output.unwrap_or_default() as u64,
            });
        }
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if Instant::now() >= deadline => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(GitError::Timeout {
                    seconds: opts.timeout.as_secs(),
                });
            }
            Ok(None) => thread::sleep(Duration::from_millis(2)),
            Err(e) => return Err(GitError::Internal(format!("failed to wait for git: {e}"))),
        }
    };

    if let Some(t) = stdin_thread {
        let _ = t.join();
    }
    let stdout = stdout_thread.join().unwrap_or_default();
    if overflow.load(Ordering::SeqCst) {
        return Err(GitError::OutputTooLarge {
            limit_bytes: opts.max_output.unwrap_or_default() as u64,
        });
    }
    let stderr = String::from_utf8_lossy(&stderr_thread.join().unwrap_or_default())
        .trim()
        .to_string();

    let code = status.code().unwrap_or(-1);
    if opts.ok_codes.contains(&code) {
        Ok(GitOutput {
            stdout,
            stderr,
            code,
        })
    } else {
        Err(classify_failure(code, stderr))
    }
}

/// Cancels a running [`run_git_streaming`] call from another thread.
#[derive(Debug, Clone, Default)]
pub struct CancelToken(Arc<AtomicBool>);

impl CancelToken {
    pub fn cancel(&self) {
        self.0.store(true, Ordering::SeqCst);
    }
    pub fn is_cancelled(&self) -> bool {
        self.0.load(Ordering::SeqCst)
    }
}

/// Options for [`run_git_streaming`].
#[derive(Debug, Clone, Default)]
pub struct StreamOptions {
    pub timeout: Duration,
    /// Extra environment variables (for example `GIT_SSH_COMMAND`).
    pub env: Vec<(String, String)>,
    pub cancel: CancelToken,
}

/// Most stderr kept for error reporting; progress output can be long.
const MAX_STREAM_STDERR: usize = 256 * 1024;
/// After Git exits, wait this long for helper processes to release the pipes.
const PIPE_GRACE: Duration = Duration::from_millis(500);

/// Run a long Git command (fetch, pull, push), reporting stderr line by line.
///
/// Git separates progress updates with `\r`; both `\r` and `\n` end a line here.
/// Unlike [`run_git_with`], any exit code is returned as `Ok`: the caller
/// classifies failures, because network commands need their own error kinds.
/// Cancellation and the timeout kill the process and return
/// [`GitError::Cancelled`] or [`GitError::Timeout`].
///
/// Helper processes (`ssh`, `git-remote-https`) may keep the pipes open briefly
/// after Git itself exits; reading stops after a short grace period so a
/// cancelled command always returns promptly.
pub fn run_git_streaming(
    cwd: &Path,
    args: &[&str],
    opts: &StreamOptions,
    on_line: &mut dyn FnMut(&str),
) -> Result<GitOutput, GitError> {
    use std::sync::mpsc;

    let mut cmd = git_command(cwd, args)?;
    for (key, value) in &opts.env {
        cmd.env(key, value);
    }
    // Own process group, so cancelling also stops helpers such as `ssh`.
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
    let mut child = spawn(&mut cmd)?;

    enum Event {
        Line(String),
        StderrDone,
        Stdout(Vec<u8>),
    }
    let (tx, rx) = mpsc::channel::<Event>();
    let mut stderr_pipe = child.stderr.take().expect("stderr is piped");
    let mut stdout_pipe = child.stdout.take().expect("stdout is piped");
    let tx_err = tx.clone();
    thread::spawn(move || {
        let mut pending = Vec::new();
        let mut chunk = [0u8; 8192];
        loop {
            match stderr_pipe.read(&mut chunk) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    for &b in &chunk[..n] {
                        if b == b'\r' || b == b'\n' {
                            if !pending.is_empty() {
                                let line = String::from_utf8_lossy(&pending).into_owned();
                                pending.clear();
                                if tx_err.send(Event::Line(line)).is_err() {
                                    return;
                                }
                            }
                        } else {
                            pending.push(b);
                        }
                    }
                }
            }
        }
        if !pending.is_empty() {
            let _ = tx_err.send(Event::Line(String::from_utf8_lossy(&pending).into_owned()));
        }
        let _ = tx_err.send(Event::StderrDone);
    });
    thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = stdout_pipe.read_to_end(&mut buf);
        let _ = tx.send(Event::Stdout(buf));
    });

    let deadline = Instant::now() + opts.timeout;
    let mut stderr = String::new();
    let mut stdout = Vec::new();
    let (mut stderr_done, mut stdout_done) = (false, false);
    let mut exited: Option<(std::process::ExitStatus, Instant)> = None;
    let mut killed_for: Option<GitError> = None;

    loop {
        match rx.recv_timeout(Duration::from_millis(50)) {
            Ok(Event::Line(line)) => {
                if stderr.len() < MAX_STREAM_STDERR {
                    stderr.push_str(&line);
                    stderr.push('\n');
                }
                on_line(&line);
            }
            Ok(Event::StderrDone) => stderr_done = true,
            Ok(Event::Stdout(buf)) => {
                stdout = buf;
                stdout_done = true;
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        }
        if stderr_done && stdout_done && exited.is_some() {
            break;
        }
        if exited.is_none() {
            if killed_for.is_none() {
                if opts.cancel.is_cancelled() {
                    kill_tree(&mut child);
                    killed_for = Some(GitError::Cancelled);
                } else if Instant::now() >= deadline {
                    kill_tree(&mut child);
                    killed_for = Some(GitError::Timeout {
                        seconds: opts.timeout.as_secs(),
                    });
                }
            }
            match child.try_wait() {
                Ok(Some(status)) => exited = Some((status, Instant::now())),
                Ok(None) => {}
                Err(e) => return Err(GitError::Internal(format!("failed to wait for git: {e}"))),
            }
        } else if let Some((_, at)) = exited {
            if at.elapsed() >= PIPE_GRACE {
                break;
            }
        }
    }
    let status = match exited {
        Some((status, _)) => status,
        None => child
            .wait()
            .map_err(|e| GitError::Internal(format!("failed to wait for git: {e}")))?,
    };
    if let Some(err) = killed_for {
        return Err(err);
    }
    Ok(GitOutput {
        stdout,
        stderr: stderr.trim_end().to_string(),
        code: status.code().unwrap_or(-1),
    })
}

/// Kill Git and, on Unix, every process it started (its process group).
/// On Windows only Git itself is killed; its helpers exit once their pipes close.
fn kill_tree(child: &mut std::process::Child) {
    #[cfg(unix)]
    {
        if let Ok(pid) = i32::try_from(child.id()) {
            // SAFETY: plain syscall; a negative pid addresses the process group
            // created for this child with `process_group(0)`.
            unsafe {
                libc::kill(-pid, libc::SIGKILL);
            }
        }
    }
    let _ = child.kill();
}

/// Map a failed Git invocation to a specific error using its (C locale) stderr.
pub fn classify_failure(code: i32, stderr: String) -> GitError {
    let lower = stderr.to_ascii_lowercase();
    if lower.contains("not a git repository") {
        GitError::NotARepository { detail: stderr }
    } else if lower.contains("dubious ownership") || lower.contains("unsafe repository") {
        GitError::UnsafeRepository { detail: stderr }
    } else if lower.contains("index.lock") && lower.contains("exists") {
        GitError::Locked { detail: stderr }
    } else {
        GitError::GitFailed { code, stderr }
    }
}

/// Minimum supported Git version (porcelain v2 `-z`, `--no-optional-locks`).
pub const MIN_GIT_VERSION: (u32, u32) = (2, 20);

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitVersion {
    pub version: String,
    pub major: u32,
    pub minor: u32,
    pub path: String,
}

/// Parse `git --version` output such as `git version 2.43.0` or
/// `git version 2.39.3 (Apple Git-146)` or `git version 2.45.1.windows.1`.
pub fn parse_version(output: &str) -> Option<(String, u32, u32)> {
    let rest = output.trim().strip_prefix("git version ")?;
    let version = rest.split_whitespace().next()?.to_string();
    let mut parts = version.split('.');
    let major = parts.next()?.parse().ok()?;
    let minor = parts
        .next()?
        .chars()
        .take_while(|c| c.is_ascii_digit())
        .collect::<String>()
        .parse()
        .ok()?;
    Some((version, major, minor))
}

pub fn git_version() -> Result<GitVersion, GitError> {
    let git = git_binary()?;
    let cwd = std::env::temp_dir();
    let out = run_git(&cwd, &["--version"], Duration::from_secs(10))?;
    let text = out.stdout_string();
    let (version, major, minor) =
        parse_version(&text).ok_or_else(|| GitError::Parse(format!("git --version: {text}")))?;
    if (major, minor) < MIN_GIT_VERSION {
        return Err(GitError::GitTooOld {
            found: version,
            required: format!("{}.{}", MIN_GIT_VERSION.0, MIN_GIT_VERSION.1),
        });
    }
    Ok(GitVersion {
        version,
        major,
        minor,
        path: git.display().to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_common_version_strings() {
        assert_eq!(
            parse_version("git version 2.43.0\n"),
            Some(("2.43.0".into(), 2, 43))
        );
        assert_eq!(
            parse_version("git version 2.39.3 (Apple Git-146)"),
            Some(("2.39.3".into(), 2, 39))
        );
        assert_eq!(
            parse_version("git version 2.45.1.windows.1"),
            Some(("2.45.1.windows.1".into(), 2, 45))
        );
        assert_eq!(parse_version("nonsense"), None);
    }

    #[test]
    fn classifies_common_failures() {
        assert_eq!(
            classify_failure(
                128,
                "fatal: not a git repository (or any of the parent directories): .git".into()
            )
            .kind(),
            "notARepository"
        );
        assert_eq!(
            classify_failure(
                128,
                "fatal: detected dubious ownership in repository".into()
            )
            .kind(),
            "unsafeRepository"
        );
        assert_eq!(
            classify_failure(
                128,
                "fatal: Unable to create '/r/.git/index.lock': File exists.".into()
            )
            .kind(),
            "locked"
        );
        assert_eq!(classify_failure(1, "error".into()).kind(), "gitFailed");
    }
}
