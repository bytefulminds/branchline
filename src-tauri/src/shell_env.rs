//! The PATH from the user's login shell, for Git and the programs its hooks start.
//!
//! On macOS an app started from the Dock or Finder gets a minimal PATH
//! (`/usr/bin:/bin:/usr/sbin:/sbin`), and Linux desktop launchers often leave out what
//! shell profiles add. Git hooks then cannot find tools such as `node`, `npx` (Husky,
//! lint-staged) or `python` that work in a terminal.
//!
//! At startup Branchline asks the login shell once for its PATH (`$SHELL -ilc env`, in the
//! background, at most a few seconds) and puts those folders in front of its own PATH for
//! every Git command and every editor or terminal it starts. If the shell cannot be asked,
//! nothing changes. Windows keeps PATH system-wide, so there this does nothing.

use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::Duration;

/// How long the login shell may take to print its environment.
pub const TIMEOUT: Duration = Duration::from_secs(5);

const START: &str = "__BRANCHLINE_ENV_START__";
const END: &str = "__BRANCHLINE_ENV_END__";

static SHELL_PATH: OnceLock<Option<OsString>> = OnceLock::new();

/// Start asking the shell in the background, so the answer is usually ready before the
/// first commit or push.
pub fn init_in_background() {
    std::thread::spawn(|| {
        let _ = merged_path();
    });
}

/// Use `path` instead of asking the shell (tests, or when the caller knows better).
/// Returns false when the PATH was already settled.
pub fn init_with(path: Option<OsString>) -> bool {
    SHELL_PATH.set(path).is_ok()
}

/// PATH for child processes: the shell's folders first, then Branchline's own, without
/// duplicates. `None` when there is nothing to add (keep the inherited PATH).
pub fn merged_path() -> Option<&'static OsStr> {
    SHELL_PATH
        .get_or_init(|| {
            let shell = login_shell()?;
            let found = ask_shell(&shell, TIMEOUT)?;
            merge(&found, std::env::var_os("PATH").as_deref())
        })
        .as_deref()
}

#[cfg(unix)]
fn login_shell() -> Option<PathBuf> {
    let shell = std::env::var_os("SHELL").map(PathBuf::from)?;
    (shell.is_absolute() && shell.is_file()).then_some(shell)
}

#[cfg(not(unix))]
fn login_shell() -> Option<PathBuf> {
    None
}

/// Run the shell as an interactive login shell and read PATH from `env`. The output is
/// framed by markers, so whatever profiles print (greetings, prompts) is ignored.
#[cfg(unix)]
pub fn ask_shell(shell: &Path, timeout: Duration) -> Option<OsString> {
    use std::io::Read;
    use std::os::unix::process::CommandExt;
    use std::process::{Command, Stdio};
    use std::time::Instant;

    let script = format!("printf '\\n{START}\\n'; /usr/bin/env; printf '\\n{END}\\n'");
    let mut child = Command::new(shell)
        .args(["-i", "-l", "-c", &script])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        // Lets profiles skip slow parts, and keeps tools from prompting.
        .env("BRANCHLINE_RESOLVING_SHELL_ENV", "1")
        .env("GIT_TERMINAL_PROMPT", "0")
        .process_group(0)
        .spawn()
        .ok()?;
    let mut stdout = child.stdout.take()?;
    let reader = std::thread::spawn(move || {
        let mut out = Vec::new();
        let _ = stdout.by_ref().take(1024 * 1024).read_to_end(&mut out);
        out
    });
    let deadline = Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(20)),
            _ => {
                if let Ok(pid) = i32::try_from(child.id()) {
                    // SAFETY: plain syscall on the process group created above.
                    unsafe {
                        libc::kill(-pid, libc::SIGKILL);
                    }
                }
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    }
    let out = reader.join().ok()?;
    parse_path(&String::from_utf8_lossy(&out)).map(OsString::from)
}

#[cfg(not(unix))]
pub fn ask_shell(_shell: &Path, _timeout: Duration) -> Option<OsString> {
    None
}

/// PATH from `env` output between the markers.
pub fn parse_path(output: &str) -> Option<String> {
    let start = output.find(START)? + START.len();
    let end = output[start..].find(END)? + start;
    output[start..end]
        .lines()
        .find_map(|l| l.strip_prefix("PATH="))
        .map(str::trim)
        .filter(|p| !p.is_empty())
        .map(str::to_string)
}

/// `shell` folders first, then `current` ones not already there. `None` when the result
/// adds nothing to `current`.
pub fn merge(shell: &OsStr, current: Option<&OsStr>) -> Option<OsString> {
    let mut seen = std::collections::HashSet::new();
    let mut dirs: Vec<PathBuf> = Vec::new();
    let current: Vec<PathBuf> = current
        .map(|c| std::env::split_paths(c).collect())
        .unwrap_or_default();
    for dir in std::env::split_paths(shell).chain(current.iter().cloned()) {
        if dir.as_os_str().is_empty() || !dir.is_absolute() {
            continue;
        }
        if seen.insert(dir.clone()) {
            dirs.push(dir);
        }
    }
    if dirs.iter().all(|d| current.contains(d)) {
        return None;
    }
    std::env::join_paths(dirs).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_path_between_markers_and_ignores_profile_noise() {
        let out = format!(
            "Welcome back!\nPATH=/fake/noise\n{START}\nHOME=/Users/ada\nPATH=/opt/homebrew/bin:/usr/bin\nTERM=dumb\n{END}\nbye\n"
        );
        assert_eq!(
            parse_path(&out).as_deref(),
            Some("/opt/homebrew/bin:/usr/bin")
        );
        assert_eq!(parse_path("PATH=/x"), None);
    }

    #[cfg(unix)]
    #[test]
    fn puts_shell_folders_first_without_duplicates() {
        let merged = merge(
            OsStr::new("/opt/homebrew/bin:/usr/bin:relative:/opt/homebrew/bin"),
            Some(OsStr::new("/usr/bin:/bin")),
        );
        assert_eq!(
            merged.as_deref(),
            Some(OsStr::new("/opt/homebrew/bin:/usr/bin:/bin"))
        );
        // Nothing new: keep the inherited PATH.
        assert_eq!(
            merge(OsStr::new("/bin"), Some(OsStr::new("/usr/bin:/bin"))),
            None
        );
    }
}
