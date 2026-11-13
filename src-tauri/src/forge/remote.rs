//! Which hosting service and project a Git remote points at.

use std::collections::HashMap;
use std::io::Read;
use std::process::{Command, Stdio};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

/// The host and project path of a remote, for example `gitlab.com` and `group/sub/project`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RemoteLocation {
    /// Lowercase host name, without user or port.
    pub host: String,
    /// Project path without a leading slash or `.git`; nested groups are kept.
    pub path: String,
}

/// Parse SSH (`git@host:group/project.git`, `ssh://git@host:2222/group/project.git`) and
/// HTTP(S) remote addresses. Local paths and other transports give `None`.
pub fn parse_remote(url: &str) -> Option<RemoteLocation> {
    let url = url.trim();
    let (host, path) = if let Some((scheme, rest)) = url.split_once("://") {
        if !matches!(
            scheme.to_ascii_lowercase().as_str(),
            "ssh" | "git+ssh" | "http" | "https"
        ) {
            return None;
        }
        let (authority, path) = rest.split_once('/')?;
        let host = authority.rsplit('@').next()?;
        let host = if let Some(v6) = host.strip_prefix('[') {
            v6.split(']').next()?
        } else {
            host.split(':').next()?
        };
        (host, path)
    } else {
        // scp-like: [user@]host:path, where the host has no slash before the colon.
        let (before, path) = url.split_once(':')?;
        if before.contains('/') || before.is_empty() || path.starts_with("//") {
            return None;
        }
        // A Windows drive letter such as C:\repo is a local path.
        if before.len() == 1 {
            return None;
        }
        (before.rsplit('@').next()?, path)
    };
    let path = path
        .trim_start_matches('/')
        .trim_end_matches('/')
        .trim_end_matches(".git")
        .trim_end_matches('/');
    let host = web_host(&host.to_ascii_lowercase()).to_string();
    if host.is_empty()
        || path.is_empty()
        || !path.contains('/')
        || path
            .split('/')
            .any(|p| p.is_empty() || p == "." || p == "..")
    {
        return None;
    }
    Some(RemoteLocation {
        host,
        path: path.to_string(),
    })
}

/// The web host for a hosting service's separate SSH host, so a remote such as
/// `git@ssh.bitbucket.org:team/app.git` matches the account on `bitbucket.org`. Bitbucket
/// Cloud moved SSH access to `ssh.bitbucket.org` in 2026; `altssh` hosts serve SSH on port
/// 443 for networks that block port 22.
pub fn web_host(host: &str) -> &str {
    match host {
        "ssh.bitbucket.org" | "altssh.bitbucket.org" => "bitbucket.org",
        "altssh.gitlab.com" => "gitlab.com",
        other => other,
    }
}

/// Whether Git reaches this remote over SSH (`git@host:path`, `ssh://...`), where the host
/// can be an alias from the SSH configuration.
pub fn is_ssh(url: &str) -> bool {
    let url = url.trim();
    match url.split_once("://") {
        Some((scheme, _)) => matches!(scheme.to_ascii_lowercase().as_str(), "ssh" | "git+ssh"),
        None => parse_remote(url).is_some(),
    }
}

/// The host an SSH host name really connects to, from the SSH configuration (`Host work` with
/// `HostName ssh.bitbucket.org` gives `bitbucket.org`), mapped to the service's web host. Asks
/// OpenSSH (`ssh -G`, which prints the configuration without connecting) once per host and
/// run. `None` when it is not an alias, or OpenSSH is not there to ask.
pub fn ssh_alias_host(host: &str) -> Option<String> {
    static CACHE: OnceLock<Mutex<HashMap<String, Option<String>>>> = OnceLock::new();
    let cache = CACHE.get_or_init(Default::default);
    if let Some(known) = cache.lock().unwrap_or_else(|e| e.into_inner()).get(host) {
        return known.clone();
    }
    let real = ssh_config_hostname(&[], host)
        .map(|h| web_host(&h).to_string())
        .filter(|h| h != host);
    cache
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(host.to_string(), real.clone());
    real
}

/// `hostname` from `ssh -G [extra] -- host`, lowercase. `extra` is for tests (`-F file`).
fn ssh_config_hostname(extra: &[&str], host: &str) -> Option<String> {
    // Only plain host names reach the command line.
    if host.is_empty()
        || host.starts_with('-')
        || !host
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'-' | b'_'))
    {
        return None;
    }
    let mut cmd = Command::new("ssh");
    cmd.args(extra)
        .args(["-G", "--", host])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    if let Some(path) = crate::shell_env::merged_path() {
        cmd.env("PATH", path);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let mut child = cmd.spawn().ok()?;
    // `ssh -G` answers at once; a configuration that runs slow commands is not waited for.
    let deadline = Instant::now() + Duration::from_secs(3);
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(10)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    }
    let mut out = String::new();
    child.stdout.take()?.read_to_string(&mut out).ok()?;
    out.lines()
        .find_map(|l| l.strip_prefix("hostname "))
        .map(|h| h.trim().to_ascii_lowercase())
        .filter(|h| !h.is_empty())
}

/// The host name of a web address (`https://gitlab.example.com:8443/x` gives
/// `gitlab.example.com`), lowercase.
pub fn url_host(url: &str) -> Option<String> {
    let rest = url.split_once("://")?.1;
    let authority = rest.split(['/', '?', '#']).next()?;
    let host = authority.rsplit('@').next()?;
    let host = if let Some(v6) = host.strip_prefix('[') {
        v6.split(']').next()?
    } else {
        host.split(':').next()?
    };
    (!host.is_empty()).then(|| host.to_ascii_lowercase())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn loc(host: &str, path: &str) -> Option<RemoteLocation> {
        Some(RemoteLocation {
            host: host.into(),
            path: path.into(),
        })
    }

    #[test]
    fn reads_ssh_and_https_remotes() {
        assert_eq!(
            parse_remote("git@gitlab.com:bytefulminds/branchline.git"),
            loc("gitlab.com", "bytefulminds/branchline")
        );
        assert_eq!(
            parse_remote("ssh://git@GitLab.Example.com:2222/a/b/c.git"),
            loc("gitlab.example.com", "a/b/c")
        );
        assert_eq!(
            parse_remote("https://***@gitlab.com/group/sub/project/"),
            loc("gitlab.com", "group/sub/project")
        );
        assert_eq!(
            parse_remote("https://gitlab.example.com:8443/team/app"),
            loc("gitlab.example.com", "team/app")
        );
    }

    #[test]
    fn maps_ssh_hosts_to_the_service() {
        assert_eq!(
            parse_remote("git@ssh.bitbucket.org:acme/app.git"),
            loc("bitbucket.org", "acme/app")
        );
        assert_eq!(
            parse_remote("ssh://git@altssh.bitbucket.org:443/acme/app.git"),
            loc("bitbucket.org", "acme/app")
        );
        assert_eq!(
            parse_remote("ssh://git@altssh.gitlab.com:443/group/app.git"),
            loc("gitlab.com", "group/app")
        );
        assert_eq!(
            parse_remote("git@bitbucket.org:acme/app.git"),
            loc("bitbucket.org", "acme/app")
        );
    }

    #[test]
    fn knows_ssh_remotes() {
        assert!(is_ssh("git@bitbucket-work:acme/app.git"));
        assert!(is_ssh("ssh://git@host:2222/a/b.git"));
        assert!(!is_ssh("https://bitbucket.org/acme/app.git"));
        assert!(!is_ssh("/srv/git/app.git"));
    }

    #[test]
    fn reads_the_real_host_of_an_ssh_alias() {
        // Skipped where OpenSSH is not installed.
        if Command::new("ssh").arg("-V").output().is_err() {
            return;
        }
        let dir = std::env::temp_dir().join(format!("bl-ssh-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let config = dir.join("config");
        std::fs::write(
            &config,
            "Host bitbucket-work\n  HostName ssh.bitbucket.org\n  User git\n",
        )
        .unwrap();
        let f = config.to_str().unwrap();
        assert_eq!(
            ssh_config_hostname(&["-F", f], "bitbucket-work").as_deref(),
            Some("ssh.bitbucket.org")
        );
        // Not an alias: its own name. Odd names never reach the command line.
        assert_eq!(
            ssh_config_hostname(&["-F", f], "example.com").as_deref(),
            Some("example.com")
        );
        assert_eq!(ssh_config_hostname(&["-F", f], "-oProxyCommand=x"), None);
        assert_eq!(ssh_config_hostname(&["-F", f], "a b"), None);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn ignores_local_paths_and_odd_addresses() {
        assert_eq!(parse_remote("/srv/git/demo.git"), None);
        assert_eq!(parse_remote("C:\\code\\demo"), None);
        assert_eq!(parse_remote("file:///srv/git/a/b.git"), None);
        assert_eq!(
            parse_remote("git@gitlab.com:project-without-group.git"),
            None
        );
        assert_eq!(parse_remote("https://gitlab.com/a/../b"), None);
        assert_eq!(parse_remote("../other/repo.git"), None);
    }

    #[test]
    fn host_of_a_web_address() {
        assert_eq!(
            url_host("https://GitLab.com/-/merge_requests").as_deref(),
            Some("gitlab.com")
        );
        assert_eq!(
            url_host("http://127.0.0.1:8080").as_deref(),
            Some("127.0.0.1")
        );
        assert_eq!(url_host("gitlab.com"), None);
    }
}
