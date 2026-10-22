//! Commit message suggestions from a local AI model served by Ollama.
//!
//! Branchline only talks to the server the user configured in Settings, and
//! only when they ask for a suggestion. What is sent: the staged diff (shortened
//! to fit), the list of changed files, the branch name and the subjects of the
//! last few commits. Nothing else leaves the machine, and nothing is sent at all
//! while the feature is off.
//!
//! The server address may not contain credentials, redirects are not followed,
//! and system proxies are skipped for loopback addresses so a local model never
//! goes through a proxy.

use std::io::{BufRead, BufReader, Read};
use std::path::Path;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::error::GitError;
use crate::git::remote::register;
use crate::git::repository::resolve_root;
use crate::git::runner::{run_git_with, RunOptions};
use crate::settings::{AiSettings, CommitStyle};

/// Largest staged diff read from Git; anything bigger is summarized by file list only.
const MAX_DIFF_READ: usize = 4 * 1024 * 1024;
/// Characters of diff sent to the model in total, and per file, so one huge
/// file (a lock file, generated code) cannot crowd out the rest.
const DIFF_BUDGET: usize = 14_000;
const FILE_BUDGET: usize = 4_000;
/// Longest message accepted from the model; generation stops beyond it.
const MAX_MESSAGE: usize = 6_000;
const RECENT_SUBJECTS: &str = "10";

/// A model the server has installed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelInfo {
    pub name: String,
    /// Size on disk in bytes.
    pub size: u64,
    /// For example "8B", when the server reports it.
    pub parameter_size: Option<String>,
}

/// What a connection test found.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerInfo {
    pub version: Option<String>,
    pub models: Vec<ModelInfo>,
}

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

fn agent(url: &str, per_read: Duration, total: Duration) -> ureq::Agent {
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

fn unreachable(url: &str, err: ureq::Error) -> GitError {
    match err {
        ureq::Error::Timeout(_) => GitError::Ai(format!(
            "Ollama at {url} did not answer in time. Large models can take a while to load; try again, or pick a smaller model."
        )),
        ureq::Error::HostNotFound => GitError::Ai(format!(
            "Could not find the host in {url}. Check the address in Settings."
        )),
        _ => GitError::Ai(format!(
            "Could not reach Ollama at {url}. Make sure it is running (for example with `ollama serve`) and check the address in Settings."
        )),
    }
}

/// Turn a non-success answer into a readable error. Ollama reports `{"error": "..."}`.
fn server_error(status: u16, body: &str, model: Option<&str>) -> GitError {
    let reported = serde_json::from_str::<serde_json::Value>(body)
        .ok()
        .and_then(|v| v.get("error").and_then(|e| e.as_str()).map(str::to_string))
        .unwrap_or_default();
    if status == 404 {
        if let Some(model) = model.filter(|_| reported.contains("not found")) {
            return GitError::Ai(format!(
                "The model {model} is not installed on the server. Run `ollama pull {model}` or choose another model in Settings."
            ));
        }
        return GitError::Ai(
            "This address does not look like an Ollama server. Check the address and port in Settings."
                .into(),
        );
    }
    let mut text = if reported.is_empty() {
        format!("Ollama answered with HTTP status {status}.")
    } else {
        format!("Ollama reported an error: {reported}")
    };
    if text.len() > 400 {
        let cut = (0..=400)
            .rev()
            .find(|&i| text.is_char_boundary(i))
            .unwrap_or(0);
        text.truncate(cut);
        text.push('…');
    }
    GitError::Ai(text)
}

#[derive(Deserialize)]
struct TagsResponse {
    #[serde(default)]
    models: Vec<TagModel>,
}

#[derive(Deserialize)]
struct TagModel {
    name: String,
    #[serde(default)]
    size: u64,
    #[serde(default)]
    details: Option<TagDetails>,
}

#[derive(Deserialize)]
struct TagDetails {
    #[serde(default)]
    parameter_size: Option<String>,
}

/// Connect to the server and list its chat models. Embedding-only models are
/// left out because they cannot write text.
pub fn server_info(raw_url: &str) -> Result<ServerInfo, GitError> {
    let url = server_url(raw_url)?;
    let agent = agent(&url, Duration::from_secs(10), Duration::from_secs(15));
    let mut res = agent
        .get(format!("{url}/api/tags"))
        .call()
        .map_err(|e| unreachable(&url, e))?;
    let status = res.status().as_u16();
    let body = res
        .body_mut()
        .with_config()
        .limit(4 * 1024 * 1024)
        .read_to_string()
        .map_err(|e| unreachable(&url, e))?;
    if status != 200 {
        return Err(server_error(status, &body, None));
    }
    let tags: TagsResponse = serde_json::from_str(&body).map_err(|_| {
        GitError::Ai(
            "This address does not look like an Ollama server. Check the address and port in Settings."
                .into(),
        )
    })?;
    let mut models: Vec<ModelInfo> = tags
        .models
        .into_iter()
        .filter(|m| !m.name.to_ascii_lowercase().contains("embed"))
        .map(|m| ModelInfo {
            name: m.name,
            size: m.size,
            parameter_size: m
                .details
                .and_then(|d| d.parameter_size)
                .filter(|s| !s.is_empty()),
        })
        .collect();
    models.sort_by(|a, b| a.name.cmp(&b.name));

    // The version is nice to show but not required.
    let version = agent
        .get(format!("{url}/api/version"))
        .call()
        .ok()
        .filter(|r| r.status().as_u16() == 200)
        .and_then(|mut r| r.body_mut().read_json::<serde_json::Value>().ok())
        .and_then(|v| {
            v.get("version")
                .and_then(|v| v.as_str())
                .map(str::to_string)
        });
    Ok(ServerInfo { version, models })
}

/// What the model gets to see about the staged changes.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ChangeContext {
    pub branch: Option<String>,
    pub recent_subjects: Vec<String>,
    pub stat: String,
    pub diff: String,
    /// Some of the diff was left out to fit the budget.
    pub shortened: bool,
}

fn git_text(root: &Path, args: &[&str], ok_codes: &[i32]) -> Result<String, GitError> {
    Ok(run_git_with(
        root,
        args,
        &RunOptions {
            ok_codes,
            max_output: Some(MAX_DIFF_READ),
            ..RunOptions::default()
        },
    )?
    .stdout_string())
}

/// Collect the staged changes, or explain that nothing is staged.
pub fn change_context(repo: &str) -> Result<ChangeContext, GitError> {
    let root = resolve_root(repo)?;
    let stat = git_text(
        &root,
        &[
            "diff",
            "--cached",
            "--no-color",
            "--stat=100",
            "--find-renames",
        ],
        &[0],
    )?;
    if stat.trim().is_empty() {
        return Err(GitError::Unsupported(
            "Stage the changes you want to describe first.".into(),
        ));
    }
    let (diff, mut shortened) = match git_text(
        &root,
        &[
            "diff",
            "--cached",
            "--no-color",
            "--no-ext-diff",
            "--no-textconv",
            "--find-renames",
            "--unified=3",
        ],
        &[0],
    ) {
        Ok(full) => budget_diff(&full, FILE_BUDGET, DIFF_BUDGET),
        Err(GitError::OutputTooLarge { .. }) => (String::new(), true),
        Err(e) => return Err(e),
    };
    if diff.is_empty() {
        shortened = true;
    }
    let branch = git_text(&root, &["symbolic-ref", "--short", "-q", "HEAD"], &[0, 1])?
        .trim()
        .to_string();
    // An unborn branch has no log; that is fine.
    let recent_subjects = git_text(
        &root,
        &["log", "-n", RECENT_SUBJECTS, "--no-merges", "--format=%s"],
        &[0, 128],
    )
    .unwrap_or_default()
    .lines()
    .map(str::trim)
    .filter(|l| !l.is_empty())
    .map(str::to_string)
    .collect();
    Ok(ChangeContext {
        branch: (!branch.is_empty()).then_some(branch),
        recent_subjects,
        stat: stat.trim_end().to_string(),
        diff,
        shortened,
    })
}

fn cut_at(text: &str, max: usize) -> &str {
    if text.len() <= max {
        return text;
    }
    let mut end = text[..max].rfind('\n').map(|i| i + 1).unwrap_or(max);
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    &text[..end]
}

/// Shorten a diff so every file gets a fair share: at most `per_file`
/// characters of each file and `total` overall, cut at line ends.
pub fn budget_diff(diff: &str, per_file: usize, total: usize) -> (String, bool) {
    let mut files: Vec<&str> = Vec::new();
    let mut start = 0;
    for (i, _) in diff.match_indices("diff --git ") {
        if i > start && diff[..i].ends_with('\n') {
            files.push(&diff[start..i]);
            start = i;
        }
    }
    if start < diff.len() {
        files.push(&diff[start..]);
    }
    let mut out = String::new();
    let mut shortened = false;
    for (n, file) in files.iter().enumerate() {
        let left = total.saturating_sub(out.len());
        if left < 200 {
            out.push_str(&format!(
                "[{} more file(s) left out to keep the prompt short]\n",
                files.len() - n
            ));
            shortened = true;
            break;
        }
        let part = cut_at(file, per_file.min(left));
        out.push_str(part);
        if part.len() < file.len() {
            if !out.ends_with('\n') {
                out.push('\n');
            }
            out.push_str("[rest of this file's changes left out]\n");
            shortened = true;
        }
    }
    (out, shortened)
}

/// Instructions for the model.
pub fn system_prompt(cfg: &AiSettings) -> String {
    let first_line = match cfg.style {
        CommitStyle::Conventional => {
            "a Conventional Commits header: `type(scope): summary`, where type is one of feat, fix, docs, style, refactor, perf, test, build, ci, chore or revert, and the scope is optional"
        }
        CommitStyle::Plain => "a short summary that starts with a capital letter",
    };
    let language = match cfg.language.trim() {
        "" => "English",
        other => other,
    };
    let mut prompt = format!(
        "You write Git commit messages. Reply with the commit message only: no introduction, \
no quotes, no Markdown and no code fences.\n\
\n\
Rules:\n\
- The first line is {first_line}. Keep it under 72 characters, use the imperative mood \
(\"add\", not \"added\") and do not end it with a period.\n\
- If the change needs explaining, add one blank line and then a short body, wrapped at 72 \
characters, that says what changed and why. Leave the body out for small, obvious changes.\n\
- Describe only what the diff shows. Do not invent ticket numbers, issue links or reasons.\n\
- Write the message in {language}."
    );
    let extra = cfg.instructions.trim();
    if !extra.is_empty() {
        prompt.push_str(
            "\n\nTeam guidelines (follow them unless they conflict with the rules above):\n",
        );
        prompt.push_str(extra);
    }
    prompt
}

/// The changes, as the model sees them.
pub fn user_prompt(ctx: &ChangeContext) -> String {
    let mut p = String::new();
    if let Some(branch) = &ctx.branch {
        p.push_str(&format!("Branch: {branch}\n\n"));
    }
    if !ctx.recent_subjects.is_empty() {
        p.push_str("Recent commit subjects in this repository (match their style when it fits):\n");
        for s in &ctx.recent_subjects {
            p.push_str(&format!("- {s}\n"));
        }
        p.push('\n');
    }
    p.push_str("Files changed:\n");
    p.push_str(&ctx.stat);
    p.push_str("\n\n");
    if ctx.diff.is_empty() {
        p.push_str("The diff is too large to include; use the file list above.\n");
    } else {
        p.push_str(if ctx.shortened {
            "Staged diff (shortened):\n"
        } else {
            "Staged diff:\n"
        });
        p.push_str(&ctx.diff);
    }
    p.push_str("\nWrite the commit message for these staged changes.");
    p
}

/// Tidy what the model wrote: drop reasoning blocks (`<think>…</think>`), code
/// fences, a leading "Commit message:" label and wrapping quotes. Safe to call on
/// a partial answer while it streams in.
pub fn clean_message(raw: &str) -> String {
    let mut text = String::new();
    let mut rest = raw;
    loop {
        match rest.find("<think>") {
            Some(open) => {
                text.push_str(&rest[..open]);
                match rest[open..].find("</think>") {
                    Some(close) => rest = &rest[open + close + "</think>".len()..],
                    // Still thinking: show nothing of it yet.
                    None => break,
                }
            }
            None => {
                text.push_str(rest);
                break;
            }
        }
    }
    let mut text = text.trim().to_string();

    if text.starts_with("```") {
        text = match text.split_once('\n') {
            Some((_, body)) => body.to_string(),
            None => String::new(),
        };
    }
    let trimmed = text.trim_end();
    if let Some(body) = trimmed.strip_suffix("```") {
        text = body.to_string();
    }

    let first = text.lines().next().unwrap_or("");
    let label = first
        .trim()
        .trim_matches(|c| c == '*' || c == '#' || c == '_')
        .trim()
        .to_ascii_lowercase();
    if label.ends_with(':')
        && (label.starts_with("commit message")
            || label.starts_with("here is")
            || label.starts_with("here's"))
    {
        text = text
            .split_once('\n')
            .map(|(_, b)| b.to_string())
            .unwrap_or_default();
    }

    let mut text = text.trim().to_string();
    for q in ['"', '`', '\''] {
        if text.len() >= 2 && text.starts_with(q) && text.ends_with(q) {
            text = text[1..text.len() - 1].trim().to_string();
        }
    }

    // Trailing spaces off every line, and no runs of blank lines.
    let mut out = String::new();
    let mut blank = 0;
    for line in text.lines() {
        let line = line.trim_end();
        if line.is_empty() {
            blank += 1;
            continue;
        }
        if !out.is_empty() {
            out.push_str(if blank > 0 { "\n\n" } else { "\n" });
        }
        blank = 0;
        out.push_str(line);
    }
    out
}

#[derive(Deserialize)]
struct ChatChunk {
    #[serde(default)]
    message: Option<ChatMessage>,
    #[serde(default)]
    done: bool,
    #[serde(default)]
    error: Option<String>,
}

#[derive(Deserialize)]
struct ChatMessage {
    #[serde(default)]
    content: String,
}

/// Ask the configured model for a commit message for the staged changes.
/// `on_text` receives the cleaned message so far as it streams in. Cancel with
/// `git::remote::cancel(op_id)`.
pub fn suggest_commit_message(
    repo: &str,
    cfg: &AiSettings,
    op_id: &str,
    on_text: &mut dyn FnMut(&str),
) -> Result<String, GitError> {
    if !cfg.enabled {
        return Err(GitError::Ai(
            "AI commit messages are turned off. Turn them on in Settings.".into(),
        ));
    }
    let url = server_url(&cfg.url)?;
    let model = cfg.model.trim();
    if model.is_empty() {
        return Err(GitError::Ai(
            "Choose a model in Settings under AI commit messages.".into(),
        ));
    }
    let (token, _registration) = register(op_id);
    let ctx = change_context(repo)?;
    if token.is_cancelled() {
        return Err(GitError::Cancelled);
    }

    let request = json!({
        "model": model,
        "stream": true,
        "messages": [
            { "role": "system", "content": system_prompt(cfg) },
            { "role": "user", "content": user_prompt(&ctx) },
        ],
        "options": { "temperature": 0.2 },
    });
    // Loading a large model can take minutes before the first word arrives.
    let agent = agent(&url, Duration::from_secs(180), Duration::from_secs(600));
    let res = agent
        .post(format!("{url}/api/chat"))
        .send_json(&request)
        .map_err(|e| unreachable(&url, e))?;
    let status = res.status().as_u16();
    if status != 200 {
        let body = res
            .into_body()
            .into_with_config()
            .limit(64 * 1024)
            .read_to_string()
            .unwrap_or_default();
        return Err(server_error(status, &body, Some(model)));
    }

    let reader = BufReader::new(res.into_body().into_reader().take(8 * 1024 * 1024));
    let mut raw = String::new();
    let mut shown = String::new();
    for line in reader.lines() {
        if token.is_cancelled() {
            return Err(GitError::Cancelled);
        }
        let line = line.map_err(|_| {
            if token.is_cancelled() {
                GitError::Cancelled
            } else {
                GitError::Ai(format!(
                    "The connection to Ollama at {url} was interrupted."
                ))
            }
        })?;
        if line.trim().is_empty() {
            continue;
        }
        let chunk: ChatChunk = serde_json::from_str(&line)
            .map_err(|_| GitError::Ai("Ollama sent an answer Branchline could not read.".into()))?;
        if let Some(err) = chunk.error {
            return Err(server_error(
                500,
                &json!({ "error": err }).to_string(),
                Some(model),
            ));
        }
        if let Some(m) = chunk.message {
            raw.push_str(&m.content);
            let cleaned = clean_message(&raw);
            if cleaned != shown {
                shown = cleaned;
                on_text(&shown);
            }
        }
        if chunk.done || raw.len() > MAX_MESSAGE {
            break;
        }
    }
    if token.is_cancelled() {
        return Err(GitError::Cancelled);
    }
    let message = clean_message(&raw);
    if message.is_empty() {
        return Err(GitError::Ai(
            "The model did not suggest a message. Try again or choose another model.".into(),
        ));
    }
    Ok(message)
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

    #[test]
    fn cleans_model_output() {
        assert_eq!(
            clean_message("<think>The user changed X.</think>\n\nfeat: add X  \n"),
            "feat: add X"
        );
        assert_eq!(clean_message("<think>still thinking"), "");
        assert_eq!(
            clean_message("```text\nfix(ui): align buttons\n\n\n\nBody line.\n```"),
            "fix(ui): align buttons\n\nBody line."
        );
        assert_eq!(
            clean_message("**Commit message:**\n\"docs: update readme\""),
            "docs: update readme"
        );
        assert_eq!(clean_message("```"), "");
        assert_eq!(
            clean_message("Here is the commit message:\nchore: bump"),
            "chore: bump"
        );
        // A normal colon in the summary is kept.
        assert_eq!(clean_message("feat: add login"), "feat: add login");
    }

    #[test]
    fn shares_the_diff_budget_between_files() {
        let big = format!(
            "diff --git a/big b/big\n{}",
            "+line of a very large generated file\n".repeat(500)
        );
        let small = "diff --git a/small b/small\n+one change\n";
        let diff = format!("{big}{small}");
        let (out, shortened) = budget_diff(&diff, 1_000, 5_000);
        assert!(shortened);
        assert!(out.contains("+one change"), "the small file still fits");
        assert!(out.contains("[rest of this file's changes left out]"));
        assert!(out.len() < 1_200 + small.len());

        let (same, cut) = budget_diff(small, 1_000, 5_000);
        assert_eq!(same, small);
        assert!(!cut);

        let many: String = (0..50)
            .map(|i| format!("diff --git a/f{i} b/f{i}\n{}", "+x\n".repeat(40)))
            .collect();
        let (out, shortened) = budget_diff(&many, 1_000, 2_000);
        assert!(shortened);
        assert!(out.contains("more file(s) left out"));
        assert!(out.len() <= 2_100);
    }

    #[test]
    fn builds_prompts_from_settings_and_changes() {
        let mut cfg = AiSettings {
            language: "Dutch".into(),
            instructions: "Start with the ticket number from the branch name.".into(),
            ..AiSettings::default()
        };
        let p = system_prompt(&cfg);
        assert!(p.contains("Conventional Commits"));
        assert!(p.contains("Write the message in Dutch."));
        assert!(p.contains("Team guidelines"));
        cfg.style = CommitStyle::Plain;
        cfg.instructions.clear();
        let p = system_prompt(&cfg);
        assert!(!p.contains("Conventional Commits"));
        assert!(!p.contains("Team guidelines"));

        let ctx = ChangeContext {
            branch: Some("feature/BL-12-login".into()),
            recent_subjects: vec!["feat: add history".into()],
            stat: " a.txt | 1 +".into(),
            diff: "diff --git a/a.txt b/a.txt\n+hi\n".into(),
            shortened: false,
        };
        let u = user_prompt(&ctx);
        assert!(u.contains("Branch: feature/BL-12-login"));
        assert!(u.contains("- feat: add history"));
        assert!(u.contains("Staged diff:\ndiff --git"));
    }
}
