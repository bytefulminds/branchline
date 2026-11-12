//! The review quest: an AI game master asks questions about each changed file of a merge
//! request (or of your own branch), and responds to open answers.
//!
//! The AI never reviews on its own: it points at code worth a closer look, and the person
//! decides. Questions come back as JSON and are checked against the diff, so a question that
//! points at a line that is not in the diff is thrown away. What is sent per round: the title
//! and description, the file's diff with line numbers (shortened to fit) and earlier comments
//! on that file. Nothing is sent while AI is off.

use std::collections::HashSet;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::provider::{chat_json, endpoint};
use crate::error::GitError;
use crate::git::diff::{range_diff, DiffOptions, LineKind};
use crate::git::log::{range_files, CommitFile};
use crate::git::remote::register;
use crate::git::repository::resolve_root;
use crate::settings::AiSettings;

/// Up to this many files get a round; above it the riskiest are picked.
pub const MAX_FILES: usize = 40;
/// Characters of numbered diff sent for one file.
const DIFF_BUDGET: usize = 14_000;
const MAX_ANSWER: usize = 40_000;
const MAX_TOKENS: u32 = 4_096;

/// A changed file and whether the quest covers it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QuestFile {
    pub path: String,
    pub original_path: Option<String>,
    pub status: String,
    pub additions: u32,
    pub deletions: u32,
    /// Why there is no round for it (binary, generated, or over the limit).
    pub skipped: Option<String>,
}

/// The files of the quest in round order, and the files it leaves out.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QuestPlan {
    pub rounds: Vec<QuestFile>,
    pub skipped: Vec<QuestFile>,
    /// Changed lines in all files, for the coverage.
    pub total_lines: u32,
}

/// Lock files and generated output: no questions about these.
pub fn is_generated(path: &str) -> bool {
    let lower = path.to_ascii_lowercase();
    let name = lower.rsplit('/').next().unwrap_or(&lower);
    const NAMES: [&str; 9] = [
        "package-lock.json",
        "yarn.lock",
        "pnpm-lock.yaml",
        "cargo.lock",
        "poetry.lock",
        "composer.lock",
        "gemfile.lock",
        "go.sum",
        "uv.lock",
    ];
    NAMES.contains(&name)
        || [".min.js", ".min.css", ".map", ".snap", ".lock"]
            .iter()
            .any(|s| name.ends_with(s))
        || ["dist/", "build/", "vendor/", "node_modules/", "generated/"]
            .iter()
            .any(|d| lower.starts_with(d) || lower.contains(&format!("/{d}")))
}

fn to_quest_file(f: CommitFile, skipped: Option<String>) -> QuestFile {
    QuestFile {
        path: f.path,
        original_path: f.original_path,
        status: f.status,
        additions: f.additions.unwrap_or(0),
        deletions: f.deletions.unwrap_or(0),
        skipped,
    }
}

/// Which files get a round. Binary and generated files never do; above `MAX_FILES` the files
/// with the most changed lines come first. Rounds stay in path order, so related files
/// follow each other.
pub fn plan_files(files: Vec<CommitFile>) -> QuestPlan {
    let total_lines = files
        .iter()
        .map(|f| f.additions.unwrap_or(0) + f.deletions.unwrap_or(0))
        .sum();
    let mut rounds = Vec::new();
    let mut skipped = Vec::new();
    for f in files {
        if f.binary {
            skipped.push(to_quest_file(f, Some("Binary file".into())));
        } else if is_generated(&f.path) {
            skipped.push(to_quest_file(f, Some("Generated or lock file".into())));
        } else if f.additions.unwrap_or(0) + f.deletions.unwrap_or(0) == 0 {
            skipped.push(to_quest_file(f, Some("No changed lines".into())));
        } else {
            rounds.push(to_quest_file(f, None));
        }
    }
    if rounds.len() > MAX_FILES {
        rounds.sort_by(|a, b| {
            (b.additions + b.deletions)
                .cmp(&(a.additions + a.deletions))
                .then(a.path.cmp(&b.path))
        });
        for mut f in rounds.split_off(MAX_FILES) {
            f.skipped = Some(format!(
                "Over the limit of {MAX_FILES} files (fewer changes)"
            ));
            skipped.push(f);
        }
    }
    rounds.sort_by(|a, b| a.path.cmp(&b.path));
    skipped.sort_by(|a, b| a.path.cmp(&b.path));
    QuestPlan {
        rounds,
        skipped,
        total_lines,
    }
}

/// The files of a merge request or branch between `base` and `head`.
pub fn quest_plan(repo: &str, base: &str, head: &str) -> Result<QuestPlan, GitError> {
    let root = resolve_root(repo)?;
    Ok(plan_files(range_files(&root, base, head)?))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Side {
    Old,
    New,
}

/// A line of the diff: on the old side (removed lines) or the new side.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LineRef {
    pub side: Side,
    pub line: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum QuestionKind {
    /// Multiple choice with a known answer.
    Choice,
    /// True or false: choices are ["True", "False"].
    TrueFalse,
    /// Click the line in the diff.
    FindLine,
    /// An open question the AI responds to.
    Open,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Question {
    pub kind: QuestionKind,
    pub prompt: String,
    pub choices: Vec<String>,
    /// Index of the right choice (quiz questions).
    pub answer: Option<usize>,
    /// The lines that matter: the answer of a find-the-line question, the lines a question is
    /// about otherwise.
    pub lines: Vec<LineRef>,
    pub explanation: String,
}

/// The questions about one file.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Round {
    pub path: String,
    pub questions: Vec<Question>,
}

/// What the quest is about, for the prompt.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct QuestContext {
    pub base: String,
    pub head: String,
    pub path: String,
    pub original_path: Option<String>,
    /// Merge request (or branch) title and description.
    pub title: String,
    pub description: String,
    /// Earlier comments on this file, so the AI does not ask about them again.
    pub discussion: String,
    /// Reviewing your own branch before anyone else does.
    pub own_branch: bool,
}

/// The lines of a diff the quest can point at.
#[derive(Debug, Clone, Default)]
pub struct KnownLines {
    /// Every line of the diff, context included.
    pub all: HashSet<LineRef>,
    /// Added and removed lines: the ones a reviewer can click.
    pub changed: HashSet<LineRef>,
}

/// The file's diff with a line reference on every line: `[new 17] + code`.
fn numbered_diff(repo: &str, ctx: &QuestContext) -> Result<(String, KnownLines), GitError> {
    let root = resolve_root(repo)?;
    let diff = range_diff(
        &root,
        &ctx.base,
        &ctx.head,
        &ctx.path,
        ctx.original_path.as_deref(),
        false,
        &DiffOptions::default(),
    )?;
    if diff.is_binary || diff.too_large {
        return Err(GitError::Unsupported(
            "This file is binary or too large to ask about.".into(),
        ));
    }
    let mut out = String::new();
    let mut lines = KnownLines::default();
    let mut shortened = false;
    for hunk in &diff.hunks {
        if out.len() > DIFF_BUDGET {
            shortened = true;
            break;
        }
        out.push_str(&hunk.header);
        out.push('\n');
        for l in &hunk.lines {
            let (side, number, mark) = match l.kind {
                LineKind::Delete => (Side::Old, l.old_line, '-'),
                LineKind::Add => (Side::New, l.new_line, '+'),
                LineKind::Context => (Side::New, l.new_line, ' '),
            };
            let Some(number) = number else { continue };
            let r = LineRef { side, line: number };
            lines.all.insert(r);
            if l.kind != LineKind::Context {
                lines.changed.insert(r);
            }
            let tag = match side {
                Side::Old => "old",
                Side::New => "new",
            };
            out.push_str(&format!("[{tag} {number}] {mark} {}\n", l.content));
        }
    }
    if shortened {
        out.push_str("[the rest of this file's changes is left out]\n");
    }
    Ok((out, lines))
}

fn round_schema() -> Value {
    let line = json!({
        "type": "object",
        "properties": {
            "side": { "type": "string", "enum": ["old", "new"] },
            "line": { "type": "integer" }
        },
        "required": ["side", "line"]
    });
    json!({
        "type": "object",
        "properties": {
            "questions": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "type": { "type": "string", "enum": ["choice", "truefalse", "findline", "open"] },
                        "question": { "type": "string" },
                        "choices": { "type": "array", "items": { "type": "string" } },
                        "answer": {},
                        "lines": { "type": "array", "items": line },
                        "explanation": { "type": "string" }
                    },
                    "required": ["type", "question", "explanation"]
                }
            }
        },
        "required": ["questions"]
    })
}

/// Instructions for asking about one file.
pub fn round_prompt(ctx: &QuestContext) -> String {
    let who = if ctx.own_branch {
        "The developer reviews their own branch before opening a merge request. Ask what a \
reviewer is likely to ask, so they can fix things before anyone else sees them."
    } else {
        "The developer reviews a colleague's merge request."
    };
    format!(
        "You are the game master of a code review game. {who} You do not review the code \
yourself: you ask questions that make the reviewer look closely at what matters, such as \
edge cases, errors, naming, tests, security and behaviour changes.\n\
\n\
You get one file's diff. Every line starts with its reference, such as [new 17] for a line in \
the new version or [old 20] for a removed line, then +, - or a space.\n\
\n\
Ask 1 to 3 questions about this file, mixing these types:\n\
- \"choice\": multiple choice with 3 or 4 \"choices\"; \"answer\" is the index of the right one \
(0 is the first).\n\
- \"truefalse\": a statement about the change; \"answer\" is true or false.\n\
- \"findline\": ask the reviewer to click a line; \"lines\" holds the right line or lines, \
which must be added (+) or removed (-) lines.\n\
- \"open\": a question without one right answer, such as what could go wrong or what they \
would change. Ask one when there is something worth discussing.\n\
\n\
Rules:\n\
- Only ask about what the diff shows. Every \"lines\" entry must be a reference from the diff, \
as {{\"side\": \"new\", \"line\": 17}}.\n\
- Give each question an \"explanation\": why the answer is right or what to look at, in one \
or two sentences. Wrong answers are no failure; the explanation teaches.\n\
- Do not ask about things the earlier comments already discuss.\n\
- Keep questions short and concrete.\n\
- Every question must be a real question about this diff. Never answer that you cannot think \
of a question: even a small change has something to check, such as a name, a value, a \
missing test or what happens on an error.\n\
\n\
Answer with JSON only: {{\"questions\": [{{\"type\": \"choice\", \"question\": \"...\", \"choices\": \
[\"...\"], \"answer\": 0, \"lines\": [{{\"side\": \"new\", \"line\": 17}}], \"explanation\": \
\"...\"}}]}}"
    )
}

fn round_input(ctx: &QuestContext, diff: &str) -> String {
    let mut p = String::new();
    if !ctx.title.trim().is_empty() {
        p.push_str(&format!("Title: {}\n", ctx.title.trim()));
    }
    if !ctx.description.trim().is_empty() {
        let d: String = ctx.description.trim().chars().take(3_000).collect();
        p.push_str(&format!("Description:\n{d}\n"));
    }
    p.push_str(&format!("\nFile: {}\n", ctx.path));
    if !ctx.discussion.trim().is_empty() {
        let d: String = ctx.discussion.trim().chars().take(3_000).collect();
        p.push_str(&format!("\nEarlier comments on this file:\n{d}\n"));
    }
    p.push_str("\nDiff:\n");
    p.push_str(diff);
    p.push_str("\nAsk your questions about this file.");
    p
}

/// The JSON object in an answer, without reasoning blocks or code fences around it.
fn json_part(raw: &str) -> Option<&str> {
    let raw = match raw.rfind("</think>") {
        Some(i) => &raw[i + "</think>".len()..],
        None => raw,
    };
    let start = raw.find('{')?;
    let end = raw.rfind('}')?;
    (end > start).then(|| &raw[start..=end])
}

fn parse_lines(v: &Value, known: &HashSet<LineRef>) -> Vec<LineRef> {
    let mut out = Vec::new();
    for item in v.as_array().into_iter().flatten() {
        let side = match item["side"].as_str() {
            Some("old") => Side::Old,
            _ => Side::New,
        };
        let line = item["line"]
            .as_u64()
            .or_else(|| item.as_u64())
            .or_else(|| item["line"].as_str().and_then(|s| s.trim().parse().ok()));
        if let Some(line) = line {
            let r = LineRef {
                side,
                line: line as u32,
            };
            if known.contains(&r) && !out.contains(&r) {
                out.push(r);
            }
        }
    }
    out
}

/// Check the questions against the diff and drop the ones that do not fit.
/// A model sometimes answers with a remark instead of a question ("I can't think of a
/// question for this file"). Those are left out, so the round is asked again.
fn is_no_question(prompt: &str) -> bool {
    let p = prompt.to_lowercase().replace('\u{2019}', "'");
    [
        "can't think of",
        "cannot think of",
        "can not think of",
        "couldn't think of",
        "could not think of",
        "can't come up with",
        "cannot come up with",
        "unable to come up with",
        "unable to think of",
        "no questions",
        "no question to ask",
        "nothing to ask",
        "nothing worth asking",
        "not enough information to ask",
        "not enough context to ask",
    ]
    .iter()
    .any(|m| p.contains(m))
}

pub fn parse_round(raw: &str, path: &str, known: &KnownLines) -> Result<Round, String> {
    let json = json_part(raw).ok_or("no JSON object")?;
    let v: Value = serde_json::from_str(json).map_err(|e| format!("invalid JSON: {e}"))?;
    let mut questions = Vec::new();
    for q in v["questions"].as_array().into_iter().flatten() {
        if questions.len() == 3 {
            break;
        }
        let prompt = q["question"]
            .as_str()
            .or_else(|| q["prompt"].as_str())
            .unwrap_or_default()
            .trim()
            .to_string();
        let explanation = q["explanation"]
            .as_str()
            .unwrap_or_default()
            .trim()
            .to_string();
        if prompt.is_empty() || is_no_question(&prompt) {
            continue;
        }
        let mut lines = parse_lines(&q["lines"], &known.all);
        let kind = match q["type"]
            .as_str()
            .unwrap_or_default()
            .to_ascii_lowercase()
            .as_str()
        {
            "choice" | "multiple_choice" | "multiplechoice" => QuestionKind::Choice,
            "truefalse" | "true_false" | "boolean" => QuestionKind::TrueFalse,
            "findline" | "find_line" | "line" => QuestionKind::FindLine,
            "open" => QuestionKind::Open,
            _ => continue,
        };
        let question = match kind {
            QuestionKind::Choice => {
                let choices: Vec<String> = q["choices"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(|c| c.as_str().map(|s| s.trim().to_string()))
                    .filter(|c| !c.is_empty())
                    .collect();
                let answer = q["answer"].as_u64().map(|n| n as usize).or_else(|| {
                    q["answer"]
                        .as_str()
                        .and_then(|a| choices.iter().position(|c| c == a.trim()))
                });
                match answer {
                    Some(a) if (2..=5).contains(&choices.len()) && a < choices.len() => Question {
                        kind,
                        prompt,
                        choices,
                        answer: Some(a),
                        lines,
                        explanation,
                    },
                    _ => continue,
                }
            }
            QuestionKind::TrueFalse => {
                let answer = match &q["answer"] {
                    Value::Bool(b) => Some(*b),
                    Value::String(s) => match s.trim().to_ascii_lowercase().as_str() {
                        "true" => Some(true),
                        "false" => Some(false),
                        _ => None,
                    },
                    _ => None,
                };
                let Some(answer) = answer else { continue };
                Question {
                    kind,
                    prompt,
                    choices: vec!["True".into(), "False".into()],
                    answer: Some(if answer { 0 } else { 1 }),
                    lines,
                    explanation,
                }
            }
            // A find-the-line question needs a changed line that is really in the diff.
            QuestionKind::FindLine
                if {
                    lines.retain(|l| known.changed.contains(l));
                    lines.is_empty()
                } =>
            {
                continue
            }
            QuestionKind::FindLine | QuestionKind::Open => Question {
                kind,
                prompt,
                choices: Vec::new(),
                answer: None,
                lines,
                explanation,
            },
        };
        questions.push(question);
    }
    if questions.is_empty() {
        return Err("no usable questions".into());
    }
    Ok(Round {
        path: path.to_string(),
        questions,
    })
}

/// Ask the configured model for the questions about one file. Cancel with
/// `git::remote::cancel(op_id)`.
pub fn quest_round(
    repo: &str,
    cfg: &AiSettings,
    ctx: &QuestContext,
    op_id: &str,
) -> Result<Round, GitError> {
    if !cfg.enabled {
        return Err(GitError::Ai(
            "AI is turned off. Turn it on in Settings > AI.".into(),
        ));
    }
    let ep = endpoint(cfg)?;
    let (token, _registration) = register(op_id);
    let (diff, known) = numbered_diff(repo, ctx)?;
    let system = round_prompt(ctx);
    let user = round_input(ctx, &diff);
    let mut last = String::new();
    // Small models sometimes answer with a remark instead of questions; asking again often
    // works, so up to three times.
    for _ in 0..3 {
        if token.is_cancelled() {
            return Err(GitError::Cancelled);
        }
        let mut raw = String::new();
        chat_json(
            &ep,
            &system,
            &user,
            MAX_TOKENS,
            &round_schema(),
            &token,
            &mut |p| {
                raw.push_str(p);
                raw.len() <= MAX_ANSWER
            },
        )?;
        match parse_round(&raw, &ctx.path, &known) {
            Ok(round) => return Ok(round),
            Err(why) => last = why,
        }
    }
    Err(GitError::Ai(format!(
        "The model's questions did not fit this file ({last}). Try again, skip the file, or choose a larger model."
    )))
}

/// The AI's response to an open answer.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Reply {
    pub reply: String,
    /// A review comment the answer could become, when it points at something to change.
    pub comment: Option<String>,
    /// The line that comment belongs to.
    pub line: Option<LineRef>,
}

/// The open question and the reviewer's answer.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ReplyContext {
    #[serde(flatten)]
    pub quest: QuestContext,
    pub question: String,
    pub answer: String,
}

fn reply_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "reply": { "type": "string" },
            "comment": { "type": "string" },
            "line": {
                "type": "object",
                "properties": {
                    "side": { "type": "string", "enum": ["old", "new"] },
                    "line": { "type": "integer" }
                }
            }
        },
        "required": ["reply"]
    })
}

pub fn reply_prompt(cfg: &AiSettings, own_branch: bool) -> String {
    let language = match cfg.language.trim() {
        "" => "English",
        other => other,
    };
    let comment = if own_branch {
        "a short note for the developer to fix it later"
    } else {
        "a short, friendly review comment the reviewer could post"
    };
    format!(
        "You are the game master of a code review game. You asked the reviewer an open \
question about a file's diff, and they answered. Respond in two to four sentences: agree \
with what they got right and add what they missed. Never say the answer is wrong; there is \
no single right answer. The reviewer cannot answer you, so never ask them a question: end \
with a statement. If something is still worth raising, put it in the comment.\n\
\n\
When their answer points at something that should change, also write {comment} in \
\"comment\", and the line it is about in \"line\" (a reference from the diff, such as \
{{\"side\": \"new\", \"line\": 17}}). Leave \"comment\" out otherwise.\n\
\n\
Write in {language}. Answer with JSON only: {{\"reply\": \"...\", \"comment\": \"...\", \
\"line\": {{\"side\": \"new\", \"line\": 17}}}}"
    )
}

/// Splits questions off the end of a reply: the reviewer cannot answer them. A reply that is
/// only a question is kept as it is. Returns the reply and the questions that were dropped.
fn drop_trailing_questions(reply: &str) -> (String, String) {
    let mut kept = reply.trim_end();
    while kept.ends_with('?') || kept.ends_with('\u{ff1f}') {
        // The end of the sentence before the question: punctuation followed by a space.
        let cut = kept
            .char_indices()
            .zip(kept.chars().skip(1))
            .filter(|((_, c), next)| {
                matches!(c, '.' | '!' | '?' | '\u{3002}' | '\u{ff01}' | '\u{ff1f}')
                    && next.is_whitespace()
            })
            .map(|((i, c), _)| i + c.len_utf8())
            .last();
        match cut {
            Some(i) => kept = kept[..i].trim_end(),
            None => break,
        }
    }
    let question = reply.trim()[kept.len()..].trim().to_string();
    (kept.to_string(), question)
}

pub fn parse_reply(raw: &str, known: &KnownLines) -> Result<Reply, String> {
    let json = json_part(raw).ok_or("no JSON object")?;
    let v: Value = serde_json::from_str(json).map_err(|e| format!("invalid JSON: {e}"))?;
    let reply = v["reply"].as_str().unwrap_or_default().trim().to_string();
    if reply.is_empty() {
        return Err("no reply".into());
    }
    let mut comment = v["comment"]
        .as_str()
        .map(|c| c.trim().to_string())
        .filter(|c| !c.is_empty());
    let (reply, question) = drop_trailing_questions(&reply);
    if comment.is_none() && !question.is_empty() {
        comment = Some(question);
    }
    let line = comment.as_ref().and_then(|_| {
        parse_lines(&json!([v["line"]]), &known.all)
            .into_iter()
            .next()
    });
    Ok(Reply {
        reply,
        comment,
        line,
    })
}

/// Respond to an open answer. Cancel with `git::remote::cancel(op_id)`.
pub fn quest_reply(
    repo: &str,
    cfg: &AiSettings,
    ctx: &ReplyContext,
    op_id: &str,
) -> Result<Reply, GitError> {
    if !cfg.enabled {
        return Err(GitError::Ai(
            "AI is turned off. Turn it on in Settings > AI.".into(),
        ));
    }
    if ctx.answer.trim().is_empty() {
        return Err(GitError::Unsupported("Write an answer first.".into()));
    }
    let ep = endpoint(cfg)?;
    let (token, _registration) = register(op_id);
    let (diff, known) = numbered_diff(repo, &ctx.quest)?;
    let system = reply_prompt(cfg, ctx.quest.own_branch);
    let answer: String = ctx.answer.trim().chars().take(4_000).collect();
    let user = format!(
        "File: {}\n\nDiff:\n{diff}\nYour question: {}\n\nTheir answer: {answer}",
        ctx.quest.path, ctx.question
    );
    let mut last = String::new();
    // Small models sometimes answer with a remark instead of questions; asking again often
    // works, so up to three times.
    for _ in 0..3 {
        let mut raw = String::new();
        chat_json(
            &ep,
            &system,
            &user,
            MAX_TOKENS,
            &reply_schema(),
            &token,
            &mut |p| {
                raw.push_str(p);
                raw.len() <= MAX_ANSWER
            },
        )?;
        match parse_reply(&raw, &known) {
            Ok(r) => return Ok(r),
            Err(why) => last = why,
        }
    }
    Err(GitError::Ai(format!(
        "The model's response could not be read ({last}). Try again."
    )))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn file(path: &str, add: u32, del: u32, binary: bool) -> CommitFile {
        CommitFile {
            path: path.into(),
            original_path: None,
            status: "M".into(),
            additions: Some(add),
            deletions: Some(del),
            binary,
        }
    }

    #[test]
    fn plans_rounds_and_skips_what_cannot_be_quizzed() {
        let plan = plan_files(vec![
            file("src/b.rs", 4, 1, false),
            file("package-lock.json", 900, 20, false),
            file("assets/logo.png", 0, 0, true),
            file("src/a.rs", 2, 0, false),
            file("web/dist/app.min.js", 50, 50, false),
        ]);
        let rounds: Vec<_> = plan.rounds.iter().map(|f| f.path.as_str()).collect();
        assert_eq!(rounds, ["src/a.rs", "src/b.rs"]);
        assert_eq!(plan.skipped.len(), 3);
        assert_eq!(plan.total_lines, 4 + 1 + 920 + 2 + 100);
    }

    #[test]
    fn picks_the_largest_changes_above_the_limit() {
        let files: Vec<_> = (0..45)
            .map(|i| file(&format!("src/f{i:02}.rs"), i as u32 + 1, 0, false))
            .collect();
        let plan = plan_files(files);
        assert_eq!(plan.rounds.len(), MAX_FILES);
        // The five smallest are left out, and say why.
        let skipped: Vec<_> = plan.skipped.iter().map(|f| f.path.as_str()).collect();
        assert_eq!(
            skipped,
            [
                "src/f00.rs",
                "src/f01.rs",
                "src/f02.rs",
                "src/f03.rs",
                "src/f04.rs"
            ]
        );
        assert!(plan.skipped[0]
            .skipped
            .as_deref()
            .unwrap()
            .contains("limit"));
        assert_eq!(
            plan.rounds[0].path, "src/f05.rs",
            "rounds stay in path order"
        );
    }

    #[test]
    fn keeps_questions_that_fit_the_diff() {
        let changed: HashSet<LineRef> = [
            LineRef {
                side: Side::New,
                line: 17,
            },
            LineRef {
                side: Side::Old,
                line: 20,
            },
        ]
        .into();
        let mut all = changed.clone();
        all.insert(LineRef {
            side: Side::New,
            line: 5,
        });
        let known = KnownLines { all, changed };
        let raw = r#"```json
{"questions":[
 {"type":"choice","question":"What is cached?","choices":["Forecasts","Cities","Nothing"],"answer":0,"lines":[{"side":"new","line":17}],"explanation":"Line 17."},
 {"type":"findline","question":"Click line 5.","lines":[{"side":"new","line":5}],"explanation":"Unchanged."},
 {"type":"findline","question":"Click line 99.","lines":[{"side":"new","line":99}],"explanation":"Not in the diff."},
 {"type":"truefalse","question":"The key ignores case.","answer":"true","explanation":"It lowercases."},
 {"type":"findline","question":"Click the old lookup.","lines":[{"side":"old","line":20}],"explanation":"Removed."}
]}
```"#;
        let round = parse_round(raw, "src/api.py", &known).unwrap();
        assert_eq!(
            round.questions.len(),
            3,
            "line 5 is unchanged and line 99 is not in the diff"
        );
        assert_eq!(round.questions[0].answer, Some(0));
        assert_eq!(round.questions[1].choices, ["True", "False"]);
        assert_eq!(round.questions[1].answer, Some(0));
        assert_eq!(
            round.questions[2].lines,
            [LineRef {
                side: Side::Old,
                line: 20
            }]
        );

        assert!(parse_round(r#"{"questions":[]}"#, "x", &known).is_err());
        assert!(parse_round(
            r#"{"questions":[{"type":"choice","question":"Q","choices":["a"],"answer":3,"explanation":""}]}"#,
            "x",
            &known
        )
        .is_err());
    }

    #[test]
    fn leaves_out_remarks_that_are_no_questions() {
        let known = KnownLines {
            all: HashSet::new(),
            changed: HashSet::new(),
        };
        // Only a remark: no usable questions, so the round is asked again.
        assert!(parse_round(
            r#"{"questions":[{"type":"open","question":"I can’t think of a question for this small change.","explanation":""}]}"#,
            "x",
            &known
        )
        .is_err());
        let round = parse_round(
            r#"{"questions":[
             {"type":"open","question":"There is nothing to ask about this file.","explanation":""},
             {"type":"open","question":"What happens when the city list is empty?","explanation":"Look at the loop."}
            ]}"#,
            "x",
            &known,
        )
        .unwrap();
        assert_eq!(round.questions.len(), 1);
        assert!(round.questions[0].prompt.starts_with("What happens"));
    }

    #[test]
    fn reads_replies_and_their_comment_line() {
        let line: HashSet<LineRef> = [LineRef {
            side: Side::New,
            line: 17,
        }]
        .into();
        let known = KnownLines {
            all: line.clone(),
            changed: line,
        };
        let r = parse_reply(
            r#"{"reply":"Good catch.","comment":"Could this be a setting?","line":{"side":"new","line":17}}"#,
            &known,
        )
        .unwrap();
        assert_eq!(r.comment.as_deref(), Some("Could this be a setting?"));
        assert_eq!(
            r.line,
            Some(LineRef {
                side: Side::New,
                line: 17
            })
        );
        let r = parse_reply(
            r#"{"reply":"Agreed.","line":{"side":"new","line":99}}"#,
            &known,
        )
        .unwrap();
        assert_eq!(r.comment, None);
        assert_eq!(r.line, None);
        assert!(parse_reply("{}", &known).is_err());
    }

    #[test]
    fn replies_do_not_end_with_questions() {
        let known = KnownLines {
            all: HashSet::new(),
            changed: HashSet::new(),
        };
        // A trailing question becomes the suggested comment when there is none.
        let r = parse_reply(
            r#"{"reply":"Right, the timeout is fixed at 5.5 seconds. Did you check the retry? What about slow networks?"}"#,
            &known,
        )
        .unwrap();
        assert_eq!(r.reply, "Right, the timeout is fixed at 5.5 seconds.");
        assert_eq!(
            r.comment.as_deref(),
            Some("Did you check the retry? What about slow networks?")
        );
        // With a comment already there, the question is just dropped.
        let r = parse_reply(
            r#"{"reply":"Good point. Why not a setting?","comment":"Make this a setting."}"#,
            &known,
        )
        .unwrap();
        assert_eq!(r.reply, "Good point.");
        assert_eq!(r.comment.as_deref(), Some("Make this a setting."));
        // A reply that is only a question stays, and so does one without questions.
        let r = parse_reply(r#"{"reply":"Is v1.2 still supported?"}"#, &known).unwrap();
        assert_eq!(r.reply, "Is v1.2 still supported?");
        assert_eq!(r.comment, None);
        let r = parse_reply(r#"{"reply":"Agreed. Nothing to add."}"#, &known).unwrap();
        assert_eq!(r.reply, "Agreed. Nothing to add.");
    }

    #[test]
    fn knows_generated_files() {
        for p in [
            "Cargo.lock",
            "web/package-lock.json",
            "dist/app.js",
            "a/b.min.js",
            "x.snap",
        ] {
            assert!(is_generated(p), "{p}");
        }
        for p in ["src/lib.rs", "docs/build.md", "builder.rs"] {
            assert!(!is_generated(p), "{p}");
        }
    }
}
