//! Open files and folders in other applications: the user's editor, a terminal,
//! or the system file manager. Commands are started directly (no shell), with
//! the path as a separate argument, and are not waited for.

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use crate::error::GitError;
use crate::git::paths::validate_relative;
use crate::git::repository::resolve_root;

/// Split a command line like `code -n` or `"/Applications/My Editor.app/x" --wait`
/// into the program and its arguments. Quotes group words; there is no shell.
pub fn split_command(line: &str) -> Vec<String> {
    let mut parts = Vec::new();
    let mut current = String::new();
    let mut quote: Option<char> = None;
    let mut started = false;
    for c in line.chars() {
        match (quote, c) {
            (Some(q), c) if c == q => quote = None,
            (Some(_), c) => current.push(c),
            (None, '"' | '\'') => {
                quote = Some(c);
                started = true;
            }
            (None, c) if c.is_whitespace() => {
                if started || !current.is_empty() {
                    parts.push(std::mem::take(&mut current));
                    started = false;
                }
            }
            (None, c) => current.push(c),
        }
    }
    if started || !current.is_empty() {
        parts.push(current);
    }
    parts
}

fn spawn(program: &str, args: &[&str], cwd: Option<&Path>) -> Result<(), GitError> {
    let mut cmd = Command::new(program);
    cmd.args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    if let Some(dir) = cwd {
        cmd.current_dir(dir);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        if program.eq_ignore_ascii_case("explorer") {
            cmd.creation_flags(CREATE_NO_WINDOW);
        }
    }
    cmd.spawn().map(|_| ()).map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            GitError::Unsupported(format!(
                "Could not find \"{program}\". Check the command in Settings, or use its full path."
            ))
        } else {
            GitError::Internal(format!("cannot start {program}: {e}"))
        }
    })
}

/// Open `target` with the system's default application.
fn system_open(target: &Path) -> Result<(), GitError> {
    let t = target.to_string_lossy();
    if cfg!(target_os = "macos") {
        spawn("open", &["--", &t], None)
    } else if cfg!(windows) {
        spawn("explorer", &[&t], None)
    } else {
        spawn("xdg-open", &[&t], None)
    }
}

fn file_in_repo(repo: &str, path: &str) -> Result<(PathBuf, PathBuf), GitError> {
    let root = resolve_root(repo)?;
    let full = root.join(validate_relative(path)?);
    Ok((root, full))
}

/// Open a file of the repository in the configured editor (or the default app).
pub fn open_in_editor(repo: &str, path: Option<&str>, editor: &str) -> Result<(), GitError> {
    let (root, full) = match path {
        Some(p) => file_in_repo(repo, p)?,
        None => {
            let root = resolve_root(repo)?;
            (root.clone(), root)
        }
    };
    if !full.exists() {
        return Err(GitError::Unsupported(
            "That file is not in the working tree (it may be deleted).".into(),
        ));
    }
    let parts = split_command(editor);
    let Some((program, args)) = parts.split_first() else {
        return system_open(&full);
    };
    let target = full.to_string_lossy().into_owned();
    let mut all: Vec<&str> = args.iter().map(String::as_str).collect();
    all.push(&target);
    match spawn(program, &all, Some(&root)) {
        // GUI apps on macOS often lack the editor's command on PATH; try it as an app name.
        Err(_) if cfg!(target_os = "macos") && !program.contains('/') => {
            spawn("open", &["-a", program, "--", &target], None)
        }
        other => other,
    }
}

/// Open a terminal in the repository folder.
pub fn open_terminal(repo: &str, terminal: &str) -> Result<(), GitError> {
    let root = resolve_root(repo)?;
    let dir = root.to_string_lossy().into_owned();
    if cfg!(target_os = "macos") {
        let app = if terminal.is_empty() {
            "Terminal"
        } else {
            terminal
        };
        return spawn("open", &["-a", app, "--", &dir], None);
    }
    let parts = split_command(terminal);
    if let Some((program, args)) = parts.split_first() {
        let args: Vec<&str> = args.iter().map(String::as_str).collect();
        return spawn(program, &args, Some(&root));
    }
    if cfg!(windows) {
        return spawn("wt", &["-d", &dir], None)
            .or_else(|_| spawn("cmd", &["/c", "start", "cmd", "/k"], Some(&root)));
    }
    for candidate in [
        "x-terminal-emulator",
        "gnome-terminal",
        "konsole",
        "xfce4-terminal",
        "xterm",
    ] {
        if spawn(candidate, &[], Some(&root)).is_ok() {
            return Ok(());
        }
    }
    Err(GitError::Unsupported(
        "No terminal found. Set one in Settings.".into(),
    ))
}

/// Show a file (or the repository folder) in Finder, Explorer or the file manager.
pub fn reveal(repo: &str, path: Option<&str>) -> Result<(), GitError> {
    let (root, full) = match path {
        Some(p) => file_in_repo(repo, p)?,
        None => {
            let root = resolve_root(repo)?;
            (root.clone(), root)
        }
    };
    let target = if full.exists() { full } else { root };
    let t = target.to_string_lossy().into_owned();
    if cfg!(target_os = "macos") {
        spawn("open", &["-R", "--", &t], None)
    } else if cfg!(windows) {
        let arg = format!("/select,{t}");
        spawn("explorer", &[&arg], None)
    } else {
        let dir = if target.is_dir() {
            target
        } else {
            target.parent().map(Path::to_path_buf).unwrap_or(target)
        };
        system_open(&dir)
    }
}

#[cfg(test)]
mod tests {
    use super::split_command;

    #[test]
    fn splits_commands_without_a_shell() {
        assert_eq!(split_command(""), Vec::<String>::new());
        assert_eq!(split_command("code"), ["code"]);
        assert_eq!(split_command("  code   -n "), ["code", "-n"]);
        assert_eq!(
            split_command(r#""/Applications/My Editor.app/bin/ed" --wait"#),
            ["/Applications/My Editor.app/bin/ed", "--wait"]
        );
        assert_eq!(split_command("subl ''"), ["subl", ""]);
        // Shell syntax is just text.
        assert_eq!(split_command("vim; rm -rf ~"), ["vim;", "rm", "-rf", "~"]);
    }
}
