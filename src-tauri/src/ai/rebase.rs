//! Suggestions for an interactive rebase: which neighbouring commits belong together, and a
//! message for each resulting commit.
//!
//! What is sent: for each commit after the starting point, its message, the files it
//! changed and (for up to `MAX_DIFFS` commits) a shortened diff. Nothing is sent while AI
//! is off. The model only suggests; the person reviews the plan before anything runs.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::commit::{budget_diff, clean_message, git_text, message_rules};
use super::provider::{chat_json, endpoint};
use crate::error::GitError;
use crate::git::rebase_plan::{plan_commits, PlanCommit};
use crate::git::remote::register;
use crate::git::repository::resolve_root;
use crate::settings::AiSettings;

/// Diffs are sent for at most this many commits; beyond it only file lists.
const MAX_DIFFS: usize = 40;
/// Characters of diff in total and per file.
const DIFF_BUDGET: usize = 24_000;
const FILE_BUDGET: usize = 1_500;
/// Longest answer accepted.
const MAX_ANSWER: usize = 60_000;
const MAX_TOKENS: u32 = 8_192;

/// Commits that become one, oldest first, with the message of the result.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SquashGroup {
    pub commits: Vec<String>,
    pub message: String,
    /// Why these belong together, in a sentence.
    pub reason: Option<String>,
}

/// The suggestion for the whole range, oldest group first.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RebaseSuggestion {
    pub groups: Vec<SquashGroup>,
}

#[derive(Deserialize)]
struct Answer {
    #[serde(default)]
    groups: Vec<AnswerGroup>,
}

#[derive(Deserialize)]
struct AnswerGroup {
    #[serde(default)]
    commits: Vec<Value>,
    #[serde(default)]
    message: String,
    #[serde(default)]
    reason: Option<String>,
}

fn schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "groups": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "commits": { "type": "array", "items": { "type": "integer" } },
                        "message": { "type": "string" },
                        "reason": { "type": "string" }
                    },
                    "required": ["commits", "message"]
                }
            }
        },
        "required": ["groups"]
    })
}

/// Instructions for the model.
pub fn system_prompt(cfg: &AiSettings) -> String {
    format!(
        "You help a developer tidy up the commits of a branch before it is shared, as in an \
interactive rebase. You get the commits oldest first, numbered from 1.\n\
\n\
Group neighbouring commits that belong to one change: a fix of something done in an earlier \
commit of the list, work in progress, review follow-ups, typo fixes, formatting. Keep \
commits that do separate things apart. Never reorder commits: a group is always a run of \
consecutive numbers.\n\
\n\
Answer with JSON only, no other text: {{\"groups\": [{{\"commits\": [1, 2], \"message\": \
\"...\", \"reason\": \"...\"}}]}}\n\
- Every commit number appears in exactly one group, and the groups are in order.\n\
- A commit that stays on its own is a group of one.\n\
- \"message\" is the full commit message of the resulting commit. For a group of one whose \
message is already good, repeat it unchanged.\n\
- \"reason\" is one short sentence on why the commits belong together, or what was \
improved.\n\
\n\
{}",
        message_rules(cfg)
    )
}

fn context(repo: &str, commits: &[PlanCommit]) -> Result<String, GitError> {
    let root = resolve_root(repo)?;
    let with_diffs = commits.len() <= MAX_DIFFS;
    let per_commit = DIFF_BUDGET / commits.len().clamp(1, MAX_DIFFS);
    let mut out = String::new();
    for (i, c) in commits.iter().enumerate() {
        out.push_str(&format!(
            "## Commit {}\n\nMessage:\n{}\n\n",
            i + 1,
            c.message.trim()
        ));
        let stat = git_text(
            &root,
            &[
                "show",
                "--no-ext-diff",
                "--no-textconv",
                "--format=",
                "--stat=100",
                &c.oid,
                "--",
            ],
            &[0],
        )?;
        out.push_str("Files changed:\n");
        out.push_str(stat.trim_end());
        out.push_str("\n\n");
        if with_diffs {
            let diff = git_text(
                &root,
                &[
                    "show",
                    "--no-ext-diff",
                    "--no-textconv",
                    "--no-color",
                    "--format=",
                    "--unified=2",
                    &c.oid,
                    "--",
                ],
                &[0],
            )?;
            let (diff, _) = budget_diff(&diff, FILE_BUDGET.min(per_commit), per_commit);
            if !diff.is_empty() {
                out.push_str("Diff (shortened):\n");
                out.push_str(&diff);
                out.push('\n');
            }
        }
    }
    out.push_str("\nSuggest the groups and messages for these commits.");
    Ok(out)
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

/// Check the answer against the commits: every number once, groups of consecutive commits
/// in order, a message for each group.
pub fn parse_answer(raw: &str, commits: &[PlanCommit]) -> Result<RebaseSuggestion, String> {
    let json = json_part(raw).ok_or("no JSON object")?;
    let answer: Answer = serde_json::from_str(json).map_err(|e| format!("invalid JSON: {e}"))?;
    let mut next = 1usize;
    let mut groups = Vec::new();
    for g in answer.groups {
        let numbers: Vec<usize> = g
            .commits
            .iter()
            .map(|v| {
                v.as_u64()
                    .or_else(|| v.as_str().and_then(|s| s.trim().parse().ok()))
                    .map(|n| n as usize)
            })
            .collect::<Option<_>>()
            .ok_or("a commit number is not a number")?;
        if numbers.is_empty() {
            continue;
        }
        for &n in &numbers {
            if n > commits.len() {
                return Err(format!("there is no commit {n}"));
            }
            if n != next {
                return Err(format!("expected commit {next}, got {n}"));
            }
            next += 1;
        }
        let message = clean_message(&g.message);
        if message.is_empty() {
            return Err("a group has no message".into());
        }
        groups.push(SquashGroup {
            commits: numbers
                .iter()
                .map(|&n| commits[n - 1].oid.clone())
                .collect(),
            message,
            reason: g
                .reason
                .map(|r| r.trim().to_string())
                .filter(|r| !r.is_empty()),
        });
    }
    if next != commits.len() + 1 {
        return Err(format!("commits {next} to {} are missing", commits.len()));
    }
    Ok(RebaseSuggestion { groups })
}

/// Ask the configured model how to tidy up the commits after `base`. Cancel with
/// `git::remote::cancel(op_id)`.
pub fn suggest_rebase(
    repo: &str,
    cfg: &AiSettings,
    base: &str,
    op_id: &str,
) -> Result<RebaseSuggestion, GitError> {
    if !cfg.enabled {
        return Err(GitError::Ai(
            "AI is turned off. Turn it on in Settings > AI.".into(),
        ));
    }
    let ep = endpoint(cfg)?;
    let (token, _registration) = register(op_id);
    let commits = plan_commits(repo, base)?;
    if commits.len() < 2 {
        return Err(GitError::Unsupported(
            "There is only one commit here, so there is nothing to combine.".into(),
        ));
    }
    let system = system_prompt(cfg);
    let user = context(repo, &commits)?;
    if token.is_cancelled() {
        return Err(GitError::Cancelled);
    }

    // A model that answers with broken JSON gets one more try.
    let mut last = String::new();
    for _ in 0..2 {
        let mut raw = String::new();
        chat_json(
            &ep,
            &system,
            &user,
            MAX_TOKENS,
            &schema(),
            &token,
            &mut |piece| {
                raw.push_str(piece);
                raw.len() <= MAX_ANSWER
            },
        )?;
        match parse_answer(&raw, &commits) {
            Ok(suggestion) => return Ok(suggestion),
            Err(why) => last = why,
        }
    }
    Err(GitError::Ai(format!(
        "The model's suggestion did not fit the commits ({last}). Try again, or choose a larger model."
    )))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn commits(n: usize) -> Vec<PlanCommit> {
        (1..=n)
            .map(|i| PlanCommit {
                oid: format!("{i:040}"),
                summary: format!("c{i}"),
                message: format!("c{i}"),
                author_name: "A".into(),
                author_time: 0,
            })
            .collect()
    }

    #[test]
    fn reads_a_suggestion_in_order() {
        let raw = "<think>hmm {</think>```json\n{\"groups\":[{\"commits\":[1,2],\"message\":\"feat: add login\\n\\nWith tests.\",\"reason\":\"The second fixes the first.\"},{\"commits\":[\"3\"],\"message\":\"docs: explain login\"}]}\n```";
        let s = parse_answer(raw, &commits(3)).unwrap();
        assert_eq!(s.groups.len(), 2);
        assert_eq!(
            s.groups[0].commits,
            [commits(3)[0].oid.clone(), commits(3)[1].oid.clone()]
        );
        assert_eq!(s.groups[0].message, "feat: add login\n\nWith tests.");
        assert_eq!(
            s.groups[0].reason.as_deref(),
            Some("The second fixes the first.")
        );
        assert_eq!(s.groups[1].reason, None);
    }

    #[test]
    fn refuses_suggestions_that_skip_reorder_or_miss_commits() {
        let c = commits(3);
        let parse = |raw: &str| parse_answer(raw, &c).unwrap_err();
        assert!(parse(
            r#"{"groups":[{"commits":[1,3],"message":"x"},{"commits":[2],"message":"y"}]}"#
        )
        .contains("expected commit 2"));
        assert!(parse(r#"{"groups":[{"commits":[1,2],"message":"x"}]}"#).contains("missing"));
        assert!(parse(r#"{"groups":[{"commits":[1,2,3],"message":"  "}]}"#).contains("no message"));
        assert!(parse("no json here").contains("no JSON"));
        assert!(
            parse(r#"{"groups":[{"commits":[1,2,3,4],"message":"x"}]}"#).contains("no commit 4")
        );
    }

    #[test]
    fn asks_for_neighbours_only_and_follows_the_message_rules() {
        let cfg = AiSettings {
            language: "Dutch".into(),
            ..AiSettings::default()
        };
        let p = system_prompt(&cfg);
        assert!(p.contains("Never reorder commits"));
        assert!(p.contains("Write the message in Dutch."));
        assert!(p.contains("Conventional Commits"));
    }
}
