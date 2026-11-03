//! Server addresses and the HTTP client for AI providers (shared with the GitLab client).
//!
//! Addresses may not contain credentials, redirects are not followed, and system proxies are
//! skipped for loopback addresses so a local model never goes through a proxy.

use std::time::Duration;

use crate::error::GitError;

/// Check and normalize a server address: `http` or `https`, a host, an optional
/// port and nothing else (no credentials, path, query or fragment).
pub fn server_url(raw: &str) -> Result<String, GitError> {
    let bad = |why: &str| Err(GitError::Ai(why.to_string()));
    let url = raw.trim().trim_end_matches('/');
    if url.is_empty() {
        return bad("Enter the address of your Ollama server, for example http://localhost:11434.");
    }
    let lower = url.to_ascii_lowercase();
    let rest = if let Some(r) = lower.strip_prefix("http://") {
        r
    } else if let Some(r) = lower.strip_prefix("https://") {
        r
    } else {
        return bad("The address must start with http:// or https://.");
    };
    if rest.is_empty() || rest.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return bad("The address is missing a host name, or contains spaces.");
    }
    if rest.contains('@') {
        return bad("Leave user names and passwords out of the address.");
    }
    if rest.contains(['/', '?', '#']) {
        return bad(
            "Use only the server address, for example http://localhost:11434, without a path.",
        );
    }
    Ok(url.to_string())
}

/// Whether the server runs on this computer (`localhost`, `127.x.x.x` or `[::1]`).
pub fn is_loopback(url: &str) -> bool {
    let rest = url
        .split_once("://")
        .map(|(_, r)| r)
        .unwrap_or(url)
        .to_ascii_lowercase();
    let host = if let Some(v6) = rest.strip_prefix('[') {
        v6.split(']').next().unwrap_or("").to_string()
    } else {
        rest.split([':', '/']).next().unwrap_or("").to_string()
    };
    host == "localhost"
        || host.ends_with(".localhost")
        || host == "::1"
        || host
            .parse::<std::net::Ipv4Addr>()
            .is_ok_and(|ip| ip.is_loopback())
}

/// HTTP client without redirects, with time limits, and without system proxies for
/// servers on this computer. Shared with the GitLab client.
pub(crate) fn agent(url: &str, per_read: Duration, total: Duration) -> ureq::Agent {
    let mut config = ureq::Agent::config_builder()
        .http_status_as_error(false)
        .max_redirects(0)
        .user_agent("Branchline")
        .timeout_connect(Some(Duration::from_secs(5)))
        .timeout_per_read(Some(per_read))
        .timeout_global(Some(total));
    if is_loopback(url) {
        config = config.proxy(None);
    }
    config.build().into()
}

/// Check and normalize the base address of an OpenAI-compatible server. Unlike Ollama, it
/// usually has a path (`http://localhost:1234/v1`), but no credentials, query or fragment.
pub fn compatible_url(raw: &str) -> Result<String, GitError> {
    let bad = |why: &str| Err(GitError::Ai(why.to_string()));
    let url = raw.trim().trim_end_matches('/');
    if url.is_empty() {
        return bad("Enter the address of the server, for example http://localhost:1234/v1.");
    }
    let lower = url.to_ascii_lowercase();
    let Some(rest) = lower
        .strip_prefix("http://")
        .or_else(|| lower.strip_prefix("https://"))
    else {
        return bad("The address must start with http:// or https://.");
    };
    let host = rest.split('/').next().unwrap_or("");
    if host.is_empty() || rest.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return bad("The address is missing a host name, or contains spaces.");
    }
    if host.contains('@') {
        return bad("Leave user names and passwords out of the address; add an API key instead.");
    }
    if rest.contains(['?', '#']) {
        return bad("Use the server's base address, for example http://localhost:1234/v1.");
    }
    Ok(url.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn checks_server_addresses() {
        assert_eq!(
            server_url(" http://localhost:11434/ ").unwrap(),
            "http://localhost:11434"
        );
        assert_eq!(
            server_url("https://ollama.lan").unwrap(),
            "https://ollama.lan"
        );
        for bad in [
            "",
            "localhost:11434",
            "ftp://host",
            "http://user:pw@host:11434",
            "http://host:11434/api",
            "http://host?x=1",
            "http://",
            "http://ho st",
        ] {
            assert!(server_url(bad).is_err(), "{bad} should be refused");
        }
    }

    #[test]
    fn knows_which_servers_are_local() {
        assert!(is_loopback("http://localhost:11434"));
        assert!(is_loopback("http://127.0.0.1:11434"));
        assert!(is_loopback("http://[::1]:11434"));
        assert!(!is_loopback("http://192.168.1.10:11434"));
        assert!(!is_loopback("https://localhost.example.com"));
    }
}
