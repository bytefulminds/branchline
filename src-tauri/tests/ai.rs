//! Commit message suggestions against a small fake Ollama server on localhost.

use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpListener;
use std::path::Path;
use std::process::Command;
use std::sync::{Arc, Mutex};

use branchline_lib::ai::{server_info, suggest_commit_message};
use branchline_lib::error::GitError;
use branchline_lib::git::remote::cancel;
use branchline_lib::settings::AiSettings;
use tempfile::TempDir;

type Seen = Arc<Mutex<Vec<(String, String)>>>;

/// Serve canned answers: `route(path)` gives (status, body). Returns the base
/// URL and the requests seen as (request line, body).
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
            loop {
                let mut header = String::new();
                reader.read_line(&mut header).unwrap();
                if header.trim().is_empty() {
                    break;
                }
                let lower = header.to_ascii_lowercase();
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
