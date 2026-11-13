//! Which hosting service and project a Git remote points at.

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
