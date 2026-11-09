//! AI features: commit message suggestions, rebase suggestions and the review quest.
//!
//! Branchline only talks to the provider chosen in Settings (Ollama, a server with an
//! OpenAI-compatible API, Anthropic or OpenAI), and only when the user asks. API keys live in
//! the system's credential store.

pub mod commit;
mod http;
pub mod provider;
pub mod rebase;
pub mod review;

pub use commit::{
    budget_diff, change_context, clean_message, suggest_commit_message, system_prompt, user_prompt,
    ChangeContext,
};
pub(crate) use http::agent;
pub use http::{compatible_url, is_loopback, server_url};
pub use provider::{ModelInfo, ServerInfo};
