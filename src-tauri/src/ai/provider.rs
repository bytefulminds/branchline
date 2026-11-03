//! The AI providers: Ollama, servers with an OpenAI-compatible API, Anthropic and OpenAI.
//!
//! Every provider gets the same rules: only the address in Settings is contacted (the fixed
//! API address for Anthropic and OpenAI), only when the user asks, and API keys come from the
//! system's credential store, never from the settings file. A key is never sent over plain
//! `http://` to another computer.

use std::io::{BufRead, BufReader, Read};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::http::{agent, compatible_url, is_loopback, server_url};
use crate::error::GitError;
use crate::git::runner::CancelToken;
use crate::secrets;
use crate::settings::{AiProvider, AiSettings};

/// The Anthropic API.
pub const ANTHROPIC_URL: &str = "https://api.anthropic.com";
const ANTHROPIC_VERSION: &str = "2023-06-01";
/// The OpenAI API.
pub const OPENAI_URL: &str = "https://api.openai.com/v1";

/// A model the provider offers.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelInfo {
    /// The id used in requests.
    pub name: String,
    /// A friendlier name, when the provider has one ("Claude Sonnet 4.5").
    pub display_name: Option<String>,
    /// Size on disk in bytes (Ollama).
    pub size: Option<u64>,
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

/// Everything needed to send a request.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Endpoint {
    pub provider: AiProvider,
    /// Base address without a trailing slash.
    pub base: String,
    pub key: Option<String>,
    pub model: String,
}

/// The provider's name in messages.
pub fn name(provider: AiProvider) -> &'static str {
    match provider {
        AiProvider::Ollama => "Ollama",
        AiProvider::OpenaiCompatible => "The AI server",
        AiProvider::Anthropic => "Anthropic",
        AiProvider::Openai => "OpenAI",
    }
}

/// Whether the provider sends code to a cloud service (as opposed to a server the user runs).
pub fn is_cloud(provider: AiProvider) -> bool {
    matches!(provider, AiProvider::Anthropic | AiProvider::Openai)
}

/// Credential store entry of the provider's API key; Ollama has none.
pub fn key_name(provider: AiProvider) -> Option<&'static str> {
    match provider {
        AiProvider::Ollama => None,
        AiProvider::OpenaiCompatible => Some("ai:openai-compatible"),
        AiProvider::Anthropic => Some("ai:anthropic"),
        AiProvider::Openai => Some("ai:openai"),
    }
}

fn needs_key(provider: AiProvider) -> bool {
    is_cloud(provider)
}

/// The address and model in `cfg` for its provider.
pub fn url_of(cfg: &AiSettings) -> &str {
    match cfg.provider {
        AiProvider::Ollama => &cfg.url,
        AiProvider::OpenaiCompatible => &cfg.compatible_url,
        AiProvider::Anthropic => ANTHROPIC_URL,
        AiProvider::Openai => OPENAI_URL,
    }
}

pub fn model_of(cfg: &AiSettings) -> &str {
    match cfg.provider {
        AiProvider::Ollama => &cfg.model,
        AiProvider::OpenaiCompatible => &cfg.compatible_model,
        AiProvider::Anthropic => &cfg.anthropic_model,
        AiProvider::Openai => &cfg.openai_model,
    }
    .trim()
}

/// Checked base address for a provider. `url` is only used for Ollama and compatible servers.
pub fn base_url(provider: AiProvider, url: &str) -> Result<String, GitError> {
    match provider {
        AiProvider::Ollama => server_url(url),
        AiProvider::OpenaiCompatible => compatible_url(url),
        AiProvider::Anthropic => Ok(ANTHROPIC_URL.into()),
        AiProvider::Openai => Ok(OPENAI_URL.into()),
    }
}

fn stored_key(provider: AiProvider) -> Result<Option<String>, GitError> {
    match key_name(provider) {
        Some(entry) => secrets::get(entry),
        None => Ok(None),
    }
}

/// Whether an API key is stored for the provider. The key itself never leaves the backend.
pub fn has_key(provider: AiProvider) -> Result<bool, GitError> {
    match key_name(provider) {
        Some(entry) => secrets::exists(entry),
        None => Ok(false),
    }
}

/// Store the provider's API key in the credential store; an empty key removes it.
pub fn save_key(provider: AiProvider, key: &str) -> Result<(), GitError> {
    let Some(entry) = key_name(provider) else {
        return Err(GitError::Ai("Ollama does not use an API key.".into()));
    };
    let key = key.trim();
    if key.is_empty() {
        return secrets::delete(entry);
    }
    if key.len() > 1024 || key.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return Err(GitError::Ai(
            "That does not look like an API key. Paste the key without spaces.".into(),
        ));
    }
    secrets::set(entry, key)
}

fn missing_key(provider: AiProvider) -> GitError {
    GitError::Ai(format!(
        "Add your {} API key in Settings > AI first.",
        name(provider)
    ))
}

/// A key may only travel encrypted, unless the server is on this computer.
fn check_transport(base: &str, key: Option<&str>) -> Result<(), GitError> {
    if key.is_some() && base.to_ascii_lowercase().starts_with("http://") && !is_loopback(base) {
        return Err(GitError::Ai(
            "Branchline does not send an API key over plain http:// to another computer. Use an https:// address, or remove the key."
                .into(),
        ));
    }
    Ok(())
}

/// The endpoint the settings describe, with its key from the credential store.
pub fn endpoint(cfg: &AiSettings) -> Result<Endpoint, GitError> {
    let base = base_url(cfg.provider, url_of(cfg))?;
    let model = model_of(cfg);
    if model.is_empty() {
        return Err(GitError::Ai("Choose a model in Settings > AI.".into()));
    }
    let key = stored_key(cfg.provider)?;
    if needs_key(cfg.provider) && key.is_none() {
        return Err(missing_key(cfg.provider));
    }
    check_transport(&base, key.as_deref())?;
    Ok(Endpoint {
        provider: cfg.provider,
        base,
        key,
        model: model.to_string(),
    })
}

fn headers(provider: AiProvider, key: Option<&str>) -> Vec<(&'static str, String)> {
    let mut out = Vec::new();
    match (provider, key) {
        (AiProvider::Anthropic, key) => {
            out.push(("anthropic-version", ANTHROPIC_VERSION.to_string()));
            if let Some(k) = key {
                out.push(("x-api-key", k.to_string()));
            }
        }
        (_, Some(k)) => out.push(("authorization", format!("Bearer {k}"))),
        (_, None) => {}
    }
    out
}

fn unreachable(provider: AiProvider, base: &str, err: ureq::Error) -> GitError {
    let who = name(provider);
    match (err, provider) {
        (ureq::Error::Timeout(_), AiProvider::Ollama) => GitError::Ai(format!(
            "Ollama at {base} did not answer in time. Large models can take a while to load; try again, or pick a smaller model."
        )),
        (ureq::Error::Timeout(_), _) => GitError::Ai(format!(
            "{who} did not answer in time. Try again in a moment."
        )),
        (ureq::Error::HostNotFound, p) if is_cloud(p) => GitError::Ai(format!(
            "Could not reach {who}. Check your internet connection."
        )),
        (ureq::Error::HostNotFound, _) => GitError::Ai(format!(
            "Could not find the host in {base}. Check the address in Settings."
        )),
        (_, AiProvider::Ollama) => GitError::Ai(format!(
            "Could not reach Ollama at {base}. Make sure it is running (for example with `ollama serve`) and check the address in Settings."
        )),
        (_, AiProvider::OpenaiCompatible) => GitError::Ai(format!(
            "Could not reach the AI server at {base}. Make sure it is running and check the address in Settings."
        )),
        (_, _) => GitError::Ai(format!(
            "Could not reach {who}. Check your internet connection, and any firewall or proxy."
        )),
    }
}

fn shorten(mut text: String) -> String {
    if text.len() > 400 {
        let cut = (0..=400)
            .rev()
            .find(|&i| text.is_char_boundary(i))
            .unwrap_or(0);
        text.truncate(cut);
        text.push('…');
    }
    text
}

/// The error text in a provider's answer: Ollama `{"error": "..."}`, OpenAI
/// `{"error": {"message": "..."}}`, Anthropic `{"type": "error", "error": {"message": "..."}}`.
fn reported(body: &str) -> (String, String) {
    let v: Value = serde_json::from_str(body).unwrap_or(Value::Null);
    let err = &v["error"];
    let message = err
        .as_str()
        .or_else(|| err["message"].as_str())
        .or_else(|| v["message"].as_str())
        .unwrap_or_default()
        .to_string();
    let code = err["code"]
        .as_str()
        .or_else(|| err["type"].as_str())
        .unwrap_or_default()
        .to_string();
    (message, code)
}

/// Turn a non-success answer into a readable error.
fn server_error(provider: AiProvider, status: u16, body: &str, model: Option<&str>) -> GitError {
    let who = name(provider);
    let (message, code) = reported(body);
    let text = match status {
        404 if provider == AiProvider::Ollama => {
            if let Some(model) = model.filter(|_| message.contains("not found")) {
                format!("The model {model} is not installed on the server. Run `ollama pull {model}` or choose another model in Settings.")
            } else {
                "This address does not look like an Ollama server. Check the address and port in Settings.".into()
            }
        }
        404 if model.is_some() => format!(
            "The model {} is not available at {}. Choose another model in Settings > AI.",
            model.unwrap_or_default(),
            who.to_lowercase().trim_start_matches("the ")
        ),
        404 if provider == AiProvider::OpenaiCompatible => {
            "This address does not look like an OpenAI-compatible server. The address usually ends in /v1, for example http://localhost:1234/v1."
                .into()
        }
        401 => format!("{who} refused the API key. Check the key in Settings > AI."),
        403 => format!(
            "{who} did not allow this request{}",
            if message.is_empty() {
                ". Check what your API key may use.".to_string()
            } else {
                format!(": {message}")
            }
        ),
        429 if code == "insufficient_quota" => {
            "Your OpenAI account has no API credit left. API use is billed separately from a ChatGPT subscription; add credit on platform.openai.com."
                .into()
        }
        429 => format!("{who} is limiting requests right now. Try again in a moment."),
        503 | 529 => format!("{who} is busy right now. Try again in a moment."),
        _ if message.is_empty() => format!("{who} answered with HTTP status {status}."),
        _ => format!("{who} reported an error: {message}"),
    };
    GitError::Ai(shorten(text))
}

fn read_body(res: ureq::http::Response<ureq::Body>, limit: u64) -> String {
    res.into_body()
        .into_with_config()
        .limit(limit)
        .read_to_string()
        .unwrap_or_default()
}

/// Connect with the settings' provider and list its chat models (the Test button).
pub fn server_info(provider: AiProvider, url: &str) -> Result<ServerInfo, GitError> {
    let base = base_url(provider, url)?;
    let key = stored_key(provider)?;
    if needs_key(provider) && key.is_none() {
        return Err(missing_key(provider));
    }
    check_transport(&base, key.as_deref())?;
    models_at(provider, &base, key.as_deref())
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

#[derive(Deserialize)]
struct ModelList {
    #[serde(default)]
    data: Vec<ListedModel>,
}

#[derive(Deserialize)]
struct ListedModel {
    id: String,
    #[serde(default)]
    display_name: Option<String>,
}

/// Whether an OpenAI model id is a chat model (and not audio, images, embeddings...).
fn is_openai_chat_model(id: &str) -> bool {
    let id = id.to_ascii_lowercase();
    let family = ["gpt-", "o1", "o3", "o4", "chatgpt-"]
        .iter()
        .any(|p| id.starts_with(p));
    let other = [
        "audio",
        "realtime",
        "transcribe",
        "tts",
        "image",
        "search",
        "embedding",
        "instruct",
        "moderation",
    ]
    .iter()
    .any(|w| id.contains(w));
    family && !other
}

/// List the chat models at `base` (also used by the tests with a fake server).
pub fn models_at(
    provider: AiProvider,
    base: &str,
    key: Option<&str>,
) -> Result<ServerInfo, GitError> {
    let agent = agent(base, Duration::from_secs(10), Duration::from_secs(20));
    let path = match provider {
        AiProvider::Ollama => format!("{base}/api/tags"),
        AiProvider::Anthropic => format!("{base}/v1/models?limit=1000"),
        AiProvider::OpenaiCompatible | AiProvider::Openai => format!("{base}/models"),
    };
    let mut req = agent.get(&path);
    for (k, v) in headers(provider, key) {
        req = req.header(k, v);
    }
    let res = req.call().map_err(|e| unreachable(provider, base, e))?;
    let status = res.status().as_u16();
    let body = read_body(res, 4 * 1024 * 1024);
    if status != 200 {
        return Err(server_error(provider, status, &body, None));
    }
    let not_a_server = || match provider {
        AiProvider::Ollama => server_error(provider, 404, "", None),
        AiProvider::OpenaiCompatible => server_error(provider, 404, "", None),
        _ => GitError::Ai(format!(
            "{} sent a list of models Branchline could not read.",
            name(provider)
        )),
    };

    if provider == AiProvider::Ollama {
        let tags: TagsResponse = serde_json::from_str(&body).map_err(|_| not_a_server())?;
        let mut models: Vec<ModelInfo> = tags
            .models
            .into_iter()
            .filter(|m| !m.name.to_ascii_lowercase().contains("embed"))
            .map(|m| ModelInfo {
                name: m.name,
                display_name: None,
                size: Some(m.size),
                parameter_size: m
                    .details
                    .and_then(|d| d.parameter_size)
                    .filter(|s| !s.is_empty()),
            })
            .collect();
        models.sort_by(|a, b| a.name.cmp(&b.name));
        // The version is nice to show but not required.
        let version = agent
            .get(format!("{base}/api/version"))
            .call()
            .ok()
            .filter(|r| r.status().as_u16() == 200)
            .and_then(|mut r| r.body_mut().read_json::<Value>().ok())
            .and_then(|v| v["version"].as_str().map(str::to_string));
        return Ok(ServerInfo { version, models });
    }

    let list: ModelList = serde_json::from_str(&body).map_err(|_| not_a_server())?;
    let mut models: Vec<ModelInfo> = list
        .data
        .into_iter()
        .filter(|m| match provider {
            AiProvider::Openai => is_openai_chat_model(&m.id),
            _ => !m.id.to_ascii_lowercase().contains("embed"),
        })
        .map(|m| ModelInfo {
            display_name: m.display_name.filter(|d| !d.is_empty() && *d != m.id),
            name: m.id,
            size: None,
            parameter_size: None,
        })
        .collect();
    // Anthropic lists the newest models first, which is the most useful order.
    if provider != AiProvider::Anthropic {
        models.sort_by(|a, b| a.name.cmp(&b.name));
    }
    Ok(ServerInfo {
        version: None,
        models,
    })
}

/// One piece of a streamed answer.
enum Piece {
    Text(String),
    Done,
    Skip,
}

fn unreadable(provider: AiProvider) -> GitError {
    GitError::Ai(format!(
        "{} sent an answer Branchline could not read.",
        name(provider)
    ))
}

/// Ollama streams one JSON object per line.
fn ollama_piece(line: &str, model: &str) -> Result<Piece, GitError> {
    let v: Value = serde_json::from_str(line).map_err(|_| unreadable(AiProvider::Ollama))?;
    if let Some(err) = v["error"].as_str() {
        return Err(server_error(
            AiProvider::Ollama,
            500,
            &json!({ "error": err }).to_string(),
            Some(model),
        ));
    }
    if v["done"].as_bool() == Some(true) {
        let text = v["message"]["content"].as_str().unwrap_or_default();
        return Ok(if text.is_empty() {
            Piece::Done
        } else {
            Piece::Text(text.to_string())
        });
    }
    Ok(match v["message"]["content"].as_str() {
        Some(t) if !t.is_empty() => Piece::Text(t.to_string()),
        _ => Piece::Skip,
    })
}

/// OpenAI and compatible servers stream server-sent events: `data: {json}` lines, ending
/// with `data: [DONE]`.
fn openai_piece(provider: AiProvider, data: &str, model: &str) -> Result<Piece, GitError> {
    if data == "[DONE]" {
        return Ok(Piece::Done);
    }
    let v: Value = serde_json::from_str(data).map_err(|_| unreadable(provider))?;
    if !v["error"].is_null() {
        return Err(server_error(provider, 500, data, Some(model)));
    }
    Ok(match v["choices"][0]["delta"]["content"].as_str() {
        Some(t) if !t.is_empty() => Piece::Text(t.to_string()),
        _ => Piece::Skip,
    })
}

/// Anthropic streams typed events: text arrives in `content_block_delta` events with a
/// `text_delta`, the answer ends with `message_stop`, and errors come as an `error` event.
fn anthropic_piece(data: &str, model: &str) -> Result<Piece, GitError> {
    let v: Value = serde_json::from_str(data).map_err(|_| unreadable(AiProvider::Anthropic))?;
    Ok(match v["type"].as_str().unwrap_or_default() {
        "content_block_delta" if v["delta"]["type"] == "text_delta" => {
            Piece::Text(v["delta"]["text"].as_str().unwrap_or_default().to_string())
        }
        "message_stop" => Piece::Done,
        "error" => {
            let status = if v["error"]["type"] == "overloaded_error" {
                529
            } else {
                500
            };
            return Err(server_error(
                AiProvider::Anthropic,
                status,
                data,
                Some(model),
            ));
        }
        _ => Piece::Skip,
    })
}

/// Send one system and one user message and stream the answer. `on_text` gets each new
/// piece of text and returns false to stop early. Stops with `GitError::Cancelled` when
/// `token` is cancelled.
pub fn chat(
    ep: &Endpoint,
    system: &str,
    user: &str,
    max_tokens: u32,
    token: &CancelToken,
    on_text: &mut dyn FnMut(&str) -> bool,
) -> Result<(), GitError> {
    let base = &ep.base;
    let model = ep.model.as_str();
    let messages = json!([
        { "role": "system", "content": system },
        { "role": "user", "content": user },
    ]);
    let (path, body) = match ep.provider {
        AiProvider::Ollama => (
            format!("{base}/api/chat"),
            json!({
                "model": model,
                "stream": true,
                "messages": messages,
                "options": { "temperature": 0.2 },
            }),
        ),
        AiProvider::OpenaiCompatible => (
            format!("{base}/chat/completions"),
            json!({
                "model": model,
                "stream": true,
                "messages": messages,
                "temperature": 0.2,
                "max_tokens": max_tokens,
            }),
        ),
        // Reasoning models refuse a temperature, and count their thinking in the token
        // limit, so neither is set.
        AiProvider::Openai => (
            format!("{base}/chat/completions"),
            json!({ "model": model, "stream": true, "messages": messages }),
        ),
        AiProvider::Anthropic => (
            format!("{base}/v1/messages"),
            json!({
                "model": model,
                "max_tokens": max_tokens,
                "stream": true,
                "system": system,
                "messages": [{ "role": "user", "content": user }],
            }),
        ),
    };

    // Loading a large local model can take minutes before the first word arrives.
    let (per_read, total) = if is_cloud(ep.provider) {
        (Duration::from_secs(120), Duration::from_secs(300))
    } else {
        (Duration::from_secs(180), Duration::from_secs(600))
    };
    let agent = agent(base, per_read, total);
    let mut req = agent.post(&path);
    for (k, v) in headers(ep.provider, ep.key.as_deref()) {
        req = req.header(k, v);
    }
    let res = req
        .send_json(&body)
        .map_err(|e| unreachable(ep.provider, base, e))?;
    let status = res.status().as_u16();
    if status != 200 {
        let body = read_body(res, 64 * 1024);
        return Err(server_error(ep.provider, status, &body, Some(model)));
    }

    let reader = BufReader::new(res.into_body().into_reader().take(8 * 1024 * 1024));
    for line in reader.lines() {
        if token.is_cancelled() {
            return Err(GitError::Cancelled);
        }
        let line = line.map_err(|_| {
            if token.is_cancelled() {
                GitError::Cancelled
            } else {
                GitError::Ai(format!(
                    "The connection to {} was interrupted.",
                    match ep.provider {
                        AiProvider::OpenaiCompatible => "the AI server",
                        p => name(p),
                    }
                ))
            }
        })?;
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let piece = match ep.provider {
            AiProvider::Ollama => ollama_piece(line, model)?,
            provider => {
                // Server-sent events: only `data:` lines carry content; `event:` names and
                // `:` comments (keep-alives) are skipped.
                let Some(data) = line.strip_prefix("data:") else {
                    continue;
                };
                let data = data.trim();
                if provider == AiProvider::Anthropic {
                    anthropic_piece(data, model)?
                } else {
                    openai_piece(provider, data, model)?
                }
            }
        };
        match piece {
            Piece::Text(t) => {
                if !on_text(&t) {
                    break;
                }
            }
            Piece::Done => break,
            Piece::Skip => {}
        }
    }
    if token.is_cancelled() {
        return Err(GitError::Cancelled);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn checks_compatible_addresses() {
        assert_eq!(
            compatible_url(" http://localhost:1234/v1/ ").unwrap(),
            "http://localhost:1234/v1"
        );
        assert_eq!(
            compatible_url("https://openrouter.ai/api/v1").unwrap(),
            "https://openrouter.ai/api/v1"
        );
        for bad in [
            "",
            "localhost:1234/v1",
            "http://user:pw@host/v1",
            "http://host/v1?x=1",
            "http:///v1",
        ] {
            assert!(compatible_url(bad).is_err(), "{bad} should be refused");
        }
    }

    #[test]
    fn keys_travel_encrypted_or_stay_on_this_computer() {
        assert!(check_transport("http://192.168.1.4:1234/v1", Some("k")).is_err());
        assert!(check_transport("http://192.168.1.4:1234/v1", None).is_ok());
        assert!(check_transport("http://localhost:1234/v1", Some("k")).is_ok());
        assert!(check_transport("https://openrouter.ai/api/v1", Some("k")).is_ok());
    }

    #[test]
    fn sends_each_provider_its_own_headers() {
        let anthropic = headers(AiProvider::Anthropic, Some("sk-ant"));
        assert!(anthropic.contains(&("x-api-key", "sk-ant".into())));
        assert!(anthropic.contains(&("anthropic-version", ANTHROPIC_VERSION.into())));
        assert_eq!(
            headers(AiProvider::Openai, Some("sk-1")),
            [("authorization", "Bearer sk-1".to_string())]
        );
        assert!(headers(AiProvider::OpenaiCompatible, None).is_empty());
    }

    #[test]
    fn keeps_only_openai_chat_models() {
        for id in [
            "gpt-4.1",
            "gpt-4o-mini",
            "o3-mini",
            "o4-mini",
            "chatgpt-4o-latest",
        ] {
            assert!(is_openai_chat_model(id), "{id}");
        }
        for id in [
            "text-embedding-3-small",
            "gpt-4o-audio-preview",
            "gpt-4o-realtime-preview",
            "gpt-4o-mini-tts",
            "gpt-image-1",
            "dall-e-3",
            "whisper-1",
            "gpt-3.5-turbo-instruct",
            "omni-moderation-latest",
        ] {
            assert!(!is_openai_chat_model(id), "{id}");
        }
    }

    #[test]
    fn explains_provider_errors() {
        let msg = |p, status, body: &str, model| server_error(p, status, body, model).to_string();
        assert!(msg(AiProvider::Anthropic, 401, "", None).contains("refused the API key"));
        assert!(msg(
            AiProvider::Openai,
            429,
            r#"{"error":{"message":"You exceeded your current quota","code":"insufficient_quota"}}"#,
            None
        )
        .contains("billed separately"));
        assert!(msg(
            AiProvider::Anthropic,
            400,
            r#"{"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low"}}"#,
            Some("m")
        )
        .contains("Anthropic reported an error: Your credit balance is too low"));
        assert!(msg(AiProvider::Anthropic, 529, "", None).contains("busy"));
        assert!(msg(AiProvider::Openai, 404, "", Some("gpt-x")).contains("not available at openai"));
        assert!(msg(AiProvider::OpenaiCompatible, 404, "", None).contains("ends in /v1"));
    }

    #[test]
    fn reads_streamed_pieces() {
        assert!(matches!(
            anthropic_piece(
                r#"{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"feat"}}"#,
                "m"
            ),
            Ok(Piece::Text(t)) if t == "feat"
        ));
        assert!(matches!(
            anthropic_piece(r#"{"type":"message_stop"}"#, "m"),
            Ok(Piece::Done)
        ));
        assert!(matches!(
            anthropic_piece(r#"{"type":"ping"}"#, "m"),
            Ok(Piece::Skip)
        ));
        let err = anthropic_piece(
            r#"{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}"#,
            "m",
        )
        .err()
        .unwrap();
        assert!(err.to_string().contains("busy"), "{err}");

        assert!(matches!(
            openai_piece(
                AiProvider::Openai,
                r#"{"choices":[{"index":0,"delta":{"content":"fix"}}]}"#,
                "m"
            ),
            Ok(Piece::Text(t)) if t == "fix"
        ));
        assert!(matches!(
            openai_piece(AiProvider::Openai, "[DONE]", "m"),
            Ok(Piece::Done)
        ));
        assert!(matches!(
            openai_piece(
                AiProvider::Openai,
                r#"{"choices":[{"index":0,"delta":{"role":"assistant"}}]}"#,
                "m"
            ),
            Ok(Piece::Skip)
        ));
    }
}
