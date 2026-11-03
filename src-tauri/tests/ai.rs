//! Commit message suggestions and AI providers against small fake servers on localhost.

use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpListener;
use std::path::Path;
use std::process::Command;
use std::sync::{Arc, Mutex};

use branchline_lib::ai::provider::{self, chat, endpoint, models_at, save_key, Endpoint};
use branchline_lib::ai::suggest_commit_message;
use branchline_lib::error::GitError;
use branchline_lib::git::remote::cancel;
use branchline_lib::git::runner::CancelToken;
use branchline_lib::secrets;
use branchline_lib::settings::{AiProvider, AiSettings};
use tempfile::TempDir;

/// Requests seen as (request line, body, lower-case headers).
type Seen = Arc<Mutex<Vec<(String, String, String)>>>;

fn server_info(url: &str) -> Result<provider::ServerInfo, GitError> {
    provider::server_info(AiProvider::Ollama, url)
}

/// Serve canned answers: `route(path)` gives (status, body). Returns the base
/// URL and the requests seen.
fn fake_ollama(route: fn(&str) -> (u16, String)) -> (String, Seen) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let seen: Seen = Arc::default();
    let log = seen.clone();
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(mut stream) = stream else { break };
            let mut reader = BufReader::new(stream.try_clone().unwrap());
            let mut request_line = String::new();
            if reader.read_line(&mut request_line).is_err() {
                continue;
            }
            let mut length = 0usize;
            let mut headers = String::new();
            loop {
                let mut header = String::new();
                reader.read_line(&mut header).unwrap();
                if header.trim().is_empty() {
                    break;
                }
                let lower = header.to_ascii_lowercase();
                headers.push_str(&lower);
                if let Some(v) = lower.strip_prefix("content-length:") {
                    length = v.trim().parse().unwrap();
                }
            }
            let mut body = vec![0; length];
            reader.read_exact(&mut body).unwrap();
            let path = request_line
                .split_whitespace()
                .nth(1)
                .unwrap_or("")
                .to_string();
            log.lock().unwrap().push((
                request_line.trim().to_string(),
                String::from_utf8_lossy(&body).into(),
                headers,
            ));
            let (status, answer) = route(&path);
            let _ = write!(
                stream,
                "HTTP/1.1 {status} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{answer}",
                answer.len()
            );
        }
    });
    (url, seen)
}

fn git(dir: &Path, args: &[&str]) {
    let out = Command::new("git")
        .args(args)
        .current_dir(dir)
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .output()
        .unwrap();
    assert!(out.status.success(), "git {args:?}");
}

/// A repository with one commit, a staged change and an unstaged one.
fn repo() -> TempDir {
    let t = TempDir::new().unwrap();
    let d = t.path();
    git(d, &["init", "-q", "-b", "main"]);
    git(d, &["config", "user.name", "T"]);
    git(d, &["config", "user.email", "t@example.com"]);
    fs::write(d.join("greet.txt"), "hi\n").unwrap();
    git(d, &["add", "."]);
    git(d, &["commit", "-qm", "feat: add greeting file"]);
    fs::write(d.join("greet.txt"), "hi\nhello there\n").unwrap();
    git(d, &["add", "greet.txt"]);
    fs::write(d.join("notes.txt"), "UNSTAGED-SECRET\n").unwrap();
    t
}

fn cfg(url: &str) -> AiSettings {
    AiSettings {
        enabled: true,
        url: url.into(),
        model: "llama3.2:latest".into(),
        ..AiSettings::default()
    }
}

fn path(t: &TempDir) -> String {
    t.path().to_str().unwrap().to_string()
}

fn ndjson(parts: &[&str]) -> String {
    let mut out: String = parts
        .iter()
        .map(|p| {
            format!(
                "{}\n",
                serde_json::json!({ "message": { "role": "assistant", "content": p }, "done": false })
            )
        })
        .collect();
    out.push_str("{\"done\":true}\n");
    out
}

#[test]
fn lists_chat_models_and_the_version() {
    let (url, _) = fake_ollama(|path| {
        match path {
        "/api/tags" => (
            200,
            r#"{"models":[
                {"name":"qwen2.5-coder:7b","size":4683087332,"details":{"parameter_size":"7.6B"}},
                {"name":"nomic-embed-text:latest","size":274302450,"details":{"parameter_size":"137M"}},
                {"name":"llama3.2:latest","size":2019393189,"details":{}}
            ]}"#
            .into(),
        ),
        "/api/version" => (200, r#"{"version":"0.6.2"}"#.into()),
        _ => (404, "404 page not found".into()),
    }
    });
    let info = server_info(&format!("{url}/")).unwrap();
    assert_eq!(info.version.as_deref(), Some("0.6.2"));
    let names: Vec<_> = info.models.iter().map(|m| m.name.as_str()).collect();
    assert_eq!(names, ["llama3.2:latest", "qwen2.5-coder:7b"]);
    assert_eq!(info.models[1].parameter_size.as_deref(), Some("7.6B"));
    assert_eq!(info.models[0].parameter_size, None);
}

#[test]
fn explains_servers_that_are_not_ollama_or_not_running() {
    let (url, _) = fake_ollama(|_| (404, "not here".into()));
    let err = server_info(&url).unwrap_err();
    assert!(
        err.to_string()
            .contains("does not look like an Ollama server"),
        "{err}"
    );

    // A port nobody listens on.
    let closed = TcpListener::bind("127.0.0.1:0").unwrap();
    let addr = closed.local_addr().unwrap();
    drop(closed);
    let err = server_info(&format!("http://{addr}")).unwrap_err();
    assert_eq!(serde_json::to_value(&err).unwrap()["kind"], "ai");
    assert!(err.to_string().contains("Could not reach Ollama"), "{err}");

    let err = server_info("http://user:pw@localhost:11434").unwrap_err();
    assert!(err.to_string().contains("passwords"));
}

#[test]
fn suggests_a_message_from_the_staged_changes_only() {
    let t = repo();
    let (url, seen) = fake_ollama(|path| match path {
        "/api/chat" => (
            200,
            ndjson(&[
                "<think>They added a line.",
                "</think>\n",
                "feat: greet ",
                "visitors",
                "\n\nSay hello.",
            ]),
        ),
        _ => (404, String::new()),
    });
    let mut streamed = Vec::new();
    let message = suggest_commit_message(&path(&t), &cfg(&url), "op-ai-1", &mut |text| {
        streamed.push(text.to_string())
    })
    .unwrap();
    assert_eq!(message, "feat: greet visitors\n\nSay hello.");
    assert_eq!(streamed.first().map(String::as_str), Some("feat: greet"));
    assert_eq!(streamed.last(), Some(&message));
    assert!(
        streamed.iter().all(|s| !s.contains("think")),
        "{streamed:?}"
    );

    let seen = seen.lock().unwrap();
    assert_eq!(seen.len(), 1);
    assert_eq!(seen[0].0, "POST /api/chat HTTP/1.1");
    let body: serde_json::Value = serde_json::from_str(&seen[0].1).unwrap();
    assert_eq!(body["model"], "llama3.2:latest");
    assert_eq!(body["stream"], true);
    // Thinking models answer directly, with room for the whole prompt.
    assert_eq!(body["think"], false);
    assert!(body["options"]["num_ctx"].as_u64().unwrap() >= 8192);
    assert!(body["options"]["num_predict"].as_u64().is_some());
    let user = body["messages"][1]["content"].as_str().unwrap();
    assert!(user.contains("+hello there"), "the staged diff is sent");
    assert!(user.contains("Branch: main"));
    assert!(user.contains("- feat: add greeting file"));
    assert!(
        !seen[0].1.contains("UNSTAGED-SECRET"),
        "unstaged files never leave"
    );
}

#[test]
fn reports_a_missing_model() {
    let t = repo();
    let (url, _) = fake_ollama(|_| {
        (
            404,
            r#"{"error":"model \"llama3.2:latest\" not found, try pulling it first"}"#.into(),
        )
    });
    let err = suggest_commit_message(&path(&t), &cfg(&url), "op-ai-2", &mut |_| {}).unwrap_err();
    assert!(
        err.to_string().contains("ollama pull llama3.2:latest"),
        "{err}"
    );
}

#[test]
fn refuses_without_staged_changes_or_when_off() {
    let t = repo();
    git(t.path(), &["reset", "-q"]);
    let (url, seen) = fake_ollama(|_| (200, ndjson(&["x"])));
    let err = suggest_commit_message(&path(&t), &cfg(&url), "op-ai-3", &mut |_| {}).unwrap_err();
    assert!(matches!(err, GitError::Unsupported(_)), "{err}");

    let off = AiSettings {
        enabled: false,
        ..cfg(&url)
    };
    let err = suggest_commit_message(&path(&t), &off, "op-ai-4", &mut |_| {}).unwrap_err();
    assert!(err.to_string().contains("turned off"));

    let no_model = AiSettings {
        model: String::new(),
        ..cfg(&url)
    };
    let err = suggest_commit_message(&path(&t), &no_model, "op-ai-5", &mut |_| {}).unwrap_err();
    assert!(err.to_string().contains("Choose a model"));
    assert!(seen.lock().unwrap().is_empty(), "nothing was sent");
}

#[test]
fn can_be_cancelled_while_streaming() {
    let t = repo();
    let (url, _) = fake_ollama(|_| (200, ndjson(&["feat: one", " two", " three", " four"])));
    let err = suggest_commit_message(&path(&t), &cfg(&url), "op-ai-6", &mut |_| cancel("op-ai-6"))
        .unwrap_err();
    assert!(matches!(err, GitError::Cancelled), "{err}");
}

/// Server-sent events from `(event, data)` pairs.
fn sse(events: &[(&str, serde_json::Value)]) -> String {
    events
        .iter()
        .map(|(event, data)| {
            if event.is_empty() {
                format!("data: {data}\n\n")
            } else {
                format!("event: {event}\ndata: {data}\n\n")
            }
        })
        .collect()
}

fn openai_stream(parts: &[&str]) -> String {
    let mut out = String::from(": keep-alive\n\n");
    out.push_str(&sse(&[(
        "",
        serde_json::json!({ "choices": [{ "index": 0, "delta": { "role": "assistant" } }] }),
    )]));
    for p in parts {
        out.push_str(&sse(&[(
            "",
            serde_json::json!({ "choices": [{ "index": 0, "delta": { "content": p } }] }),
        )]));
    }
    out.push_str("data: [DONE]\n\n");
    out
}

fn collect(ep: &Endpoint) -> Result<String, GitError> {
    let mut text = String::new();
    chat(
        ep,
        "system words",
        "user words",
        512,
        &CancelToken::default(),
        &mut |p| {
            text.push_str(p);
            true
        },
    )?;
    Ok(text)
}

#[test]
fn openai_compatible_servers_suggest_with_the_stored_key() {
    secrets::use_memory_store();
    let t = repo();
    let (url, seen) = fake_ollama(|path| {
        match path {
        "/v1/models" => (
            200,
            r#"{"object":"list","data":[{"id":"qwen2.5-coder-7b"},{"id":"nomic-embed-text"},{"id":"llama-3.2-3b"}]}"#
                .into(),
        ),
        "/v1/chat/completions" => (200, openai_stream(&["fix: greet ", "everyone"])),
        _ => (404, String::new()),
    }
    });
    let base = format!("{url}/v1/");
    let names: Vec<_> = provider::server_info(AiProvider::OpenaiCompatible, &base)
        .unwrap()
        .models
        .into_iter()
        .map(|m| m.name)
        .collect();
    assert_eq!(names, ["llama-3.2-3b", "qwen2.5-coder-7b"]);

    save_key(AiProvider::OpenaiCompatible, " lm-key-1 ").unwrap();
    assert!(provider::has_key(AiProvider::OpenaiCompatible).unwrap());
    let cfg = AiSettings {
        enabled: true,
        provider: AiProvider::OpenaiCompatible,
        compatible_url: base,
        compatible_model: "qwen2.5-coder-7b".into(),
        ..AiSettings::default()
    };
    let message = suggest_commit_message(&path(&t), &cfg, "op-ai-7", &mut |_| {}).unwrap();
    assert_eq!(message, "fix: greet everyone");

    let seen = seen.lock().unwrap();
    let post = seen.last().unwrap();
    assert_eq!(post.0, "POST /v1/chat/completions HTTP/1.1");
    assert!(
        post.2.contains("authorization: bearer lm-key-1"),
        "{}",
        post.2
    );
    let body: serde_json::Value = serde_json::from_str(&post.1).unwrap();
    assert_eq!(body["model"], "qwen2.5-coder-7b");
    assert_eq!(body["stream"], true);
    assert_eq!(body["messages"][0]["role"], "system");
    assert!(body["messages"][1]["content"]
        .as_str()
        .unwrap()
        .contains("+hello there"));

    save_key(AiProvider::OpenaiCompatible, "").unwrap();
    assert!(!provider::has_key(AiProvider::OpenaiCompatible).unwrap());
}

#[test]
fn anthropic_streams_text_deltas_with_its_own_headers() {
    let (url, seen) = fake_ollama(|path| {
        match path {
        "/v1/models?limit=1000" => (
            200,
            r#"{"data":[{"type":"model","id":"claude-new","display_name":"Claude New"},{"type":"model","id":"claude-old","display_name":"Claude Old"}],"has_more":false}"#
                .into(),
        ),
        "/v1/messages" => (
            200,
            sse(&[
                ("message_start", serde_json::json!({ "type": "message_start", "message": { "id": "m1" } })),
                ("content_block_start", serde_json::json!({ "type": "content_block_start", "index": 0, "content_block": { "type": "text", "text": "" } })),
                ("ping", serde_json::json!({ "type": "ping" })),
                ("content_block_delta", serde_json::json!({ "type": "content_block_delta", "index": 0, "delta": { "type": "text_delta", "text": "docs: explain " } })),
                ("content_block_delta", serde_json::json!({ "type": "content_block_delta", "index": 0, "delta": { "type": "text_delta", "text": "providers" } })),
                ("content_block_stop", serde_json::json!({ "type": "content_block_stop", "index": 0 })),
                ("message_delta", serde_json::json!({ "type": "message_delta", "delta": { "stop_reason": "end_turn" } })),
                ("message_stop", serde_json::json!({ "type": "message_stop" })),
            ]),
        ),
        _ => (404, String::new()),
    }
    });
    let info = models_at(AiProvider::Anthropic, &url, Some("sk-ant-1")).unwrap();
    let names: Vec<_> = info.models.iter().map(|m| m.name.as_str()).collect();
    assert_eq!(
        names,
        ["claude-new", "claude-old"],
        "newest first, as listed"
    );
    assert_eq!(info.models[0].display_name.as_deref(), Some("Claude New"));

    let ep = Endpoint {
        provider: AiProvider::Anthropic,
        base: url,
        key: Some("sk-ant-1".into()),
        model: "claude-new".into(),
    };
    assert_eq!(collect(&ep).unwrap(), "docs: explain providers");

    let seen = seen.lock().unwrap();
    let post = seen.last().unwrap();
    assert_eq!(post.0, "POST /v1/messages HTTP/1.1");
    assert!(post.2.contains("x-api-key: sk-ant-1"));
    assert!(post.2.contains("anthropic-version: 2023-06-01"));
    assert!(!post.2.contains("authorization"));
    let body: serde_json::Value = serde_json::from_str(&post.1).unwrap();
    assert_eq!(body["system"], "system words");
    assert_eq!(body["messages"][0]["role"], "user");
    assert_eq!(body["max_tokens"], 512);
}

#[test]
fn anthropic_errors_in_the_stream_and_refused_keys_are_explained() {
    let (url, _) = fake_ollama(|path| {
        match path {
        "/v1/messages" => (
            200,
            sse(&[(
                "error",
                serde_json::json!({ "type": "error", "error": { "type": "overloaded_error", "message": "Overloaded" } }),
            )]),
        ),
        _ => (
            401,
            r#"{"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}"#
                .into(),
        ),
    }
    });
    let ep = Endpoint {
        provider: AiProvider::Anthropic,
        base: url.clone(),
        key: Some("bad".into()),
        model: "claude-new".into(),
    };
    let err = collect(&ep).unwrap_err();
    assert!(err.to_string().contains("Anthropic is busy"), "{err}");
    let err = models_at(AiProvider::Anthropic, &url, Some("bad")).unwrap_err();
    assert!(err.to_string().contains("refused the API key"), "{err}");
}

#[test]
fn openai_lists_chat_models_and_leaves_out_the_temperature() {
    let (url, seen) = fake_ollama(|path| {
        match path {
        "/models" => (
            200,
            r#"{"data":[{"id":"gpt-4.1"},{"id":"whisper-1"},{"id":"text-embedding-3-small"},{"id":"o4-mini"}]}"#
                .into(),
        ),
        "/chat/completions" => (200, openai_stream(&["chore: tidy"])),
        _ => (404, String::new()),
    }
    });
    let names: Vec<_> = models_at(AiProvider::Openai, &url, Some("sk-1"))
        .unwrap()
        .models
        .into_iter()
        .map(|m| m.name)
        .collect();
    assert_eq!(names, ["gpt-4.1", "o4-mini"]);
    let ep = Endpoint {
        provider: AiProvider::Openai,
        base: url,
        key: Some("sk-1".into()),
        model: "o4-mini".into(),
    };
    assert_eq!(collect(&ep).unwrap(), "chore: tidy");
    let seen = seen.lock().unwrap();
    let body: serde_json::Value = serde_json::from_str(&seen.last().unwrap().1).unwrap();
    assert!(body.get("temperature").is_none());
    assert!(seen
        .last()
        .unwrap()
        .2
        .contains("authorization: bearer sk-1"));
}

#[test]
fn cloud_providers_need_a_key_and_use_their_own_address() {
    secrets::use_memory_store();
    let cfg = AiSettings {
        enabled: true,
        provider: AiProvider::Openai,
        openai_model: "gpt-4.1".into(),
        ..AiSettings::default()
    };
    let err = endpoint(&cfg).unwrap_err();
    assert!(err.to_string().contains("Add your OpenAI API key"), "{err}");
    let err = provider::server_info(AiProvider::Openai, "").unwrap_err();
    assert!(err.to_string().contains("API key"), "{err}");

    save_key(AiProvider::Openai, "sk-test").unwrap();
    let ep = endpoint(&cfg).unwrap();
    assert_eq!(ep.base, "https://api.openai.com/v1");
    assert_eq!(ep.key.as_deref(), Some("sk-test"));
    let anthropic = AiSettings {
        provider: AiProvider::Anthropic,
        anthropic_model: "claude-new".into(),
        ..cfg.clone()
    };
    save_key(AiProvider::Anthropic, "sk-ant").unwrap();
    assert_eq!(
        endpoint(&anthropic).unwrap().base,
        "https://api.anthropic.com"
    );
    assert!(save_key(AiProvider::Anthropic, "two words").is_err());
    assert!(save_key(AiProvider::Ollama, "x").is_err());
    save_key(AiProvider::Openai, "").unwrap();
    save_key(AiProvider::Anthropic, "").unwrap();
}

#[test]
fn stops_a_model_that_only_keeps_thinking() {
    let t = repo();
    let (url, _) = fake_ollama(|_| {
        let line = serde_json::json!({
            "message": { "role": "assistant", "content": "", "thinking": "x".repeat(1000) },
            "done": false
        });
        (200, format!("{line}\n").repeat(60))
    });
    let mut shown = 0;
    let err =
        suggest_commit_message(&path(&t), &cfg(&url), "op-ai-8", &mut |_| shown += 1).unwrap_err();
    assert!(err.to_string().contains("kept thinking"), "{err}");
    assert_eq!(shown, 0, "reasoning is never shown as the message");
}

#[test]
fn retries_without_think_for_models_that_cannot_think() {
    let t = repo();
    // A server that refuses `think` the first time, like some Ollama versions do.
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let bodies: Arc<Mutex<Vec<String>>> = Arc::default();
    let log = bodies.clone();
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(mut stream) = stream else { break };
            let mut reader = BufReader::new(stream.try_clone().unwrap());
            let mut line = String::new();
            reader.read_line(&mut line).unwrap();
            let mut length = 0;
            loop {
                let mut h = String::new();
                reader.read_line(&mut h).unwrap();
                if h.trim().is_empty() {
                    break;
                }
                if let Some(v) = h.to_ascii_lowercase().strip_prefix("content-length:") {
                    length = v.trim().parse().unwrap();
                }
            }
            let mut body = vec![0; length];
            reader.read_exact(&mut body).unwrap();
            let body = String::from_utf8_lossy(&body).to_string();
            let (status, answer) = if body.contains("\"think\"") {
                (
                    400,
                    r#"{"error":"\"llama3.2:latest\" does not support thinking"}"#.to_string(),
                )
            } else {
                (200, ndjson(&["fix: works anyway"]))
            };
            log.lock().unwrap().push(body);
            let _ = write!(
                stream,
                "HTTP/1.1 {status} X\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{answer}",
                answer.len()
            );
        }
    });
    let message = suggest_commit_message(&path(&t), &cfg(&url), "op-ai-9", &mut |_| {}).unwrap();
    assert_eq!(message, "fix: works anyway");
    assert_eq!(bodies.lock().unwrap().len(), 2);
}
