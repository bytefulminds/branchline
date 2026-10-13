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

/// Run Git with explicit options. See [`RunOptions`].
pub fn run_git_with(
    cwd: &Path,
    args: &[&str],
    opts: &RunOptions<'_>,
) -> Result<GitOutput, GitError> {
    let git = git_binary()?;
    let mut cmd = Command::new(git);
    cmd.args(GLOBAL_ARGS)
        .args(args)
        .current_dir(cwd)
        .stdin(if opts.stdin.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
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

    let mut child = cmd.spawn().map_err(|e| match e.kind() {
        std::io::ErrorKind::NotFound => GitError::GitNotFound,
        _ => GitError::Internal(format!("failed to start git: {e}")),
    })?;

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
