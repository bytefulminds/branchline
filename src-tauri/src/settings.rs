//! Application settings, stored as JSON in the platform's configuration folder
//! (for example `~/Library/Application Support/dev.branchline.app/settings.json`).
//!
//! Every field has a default, so older or partial files load fine and unknown
//! values are ignored. Writes go to a temporary file first and are then renamed,
//! so a crash never leaves a half-written file.

use std::path::{Path, PathBuf};
use std::sync::{OnceLock, RwLock};

use serde::{Deserialize, Serialize};

use crate::error::GitError;
use crate::git::remote::PullMode;

/// Deserialize a value, falling back to its default when the stored value is not one Branchline
/// knows (an option from a newer version, or a typo in a hand-edited file), instead of
/// rejecting the whole settings file.
fn or_default<'de, D, T>(d: D) -> Result<T, D::Error>
where
    D: serde::Deserializer<'de>,
    T: serde::de::DeserializeOwned + Default,
{
    let value = serde_json::Value::deserialize(d)?;
    Ok(serde_json::from_value(value).unwrap_or_default())
}

/// How diffs are laid out.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DiffLayout {
    /// Old and new lines in one column.
    #[default]
    Unified,
    /// Old version on the left, new version on the right.
    Split,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct GeneralSettings {
    /// Reopen the most recent repository on start.
    pub open_last_repository: bool,
    /// Refresh the repository when the window gets focus.
    pub refresh_on_focus: bool,
    /// Fetch all remotes in the background every this many minutes; 0 is off.
    pub auto_fetch_minutes: u32,
    /// Look for a new Branchline release shortly after starting.
    pub check_for_updates: bool,
}

impl Default for GeneralSettings {
    fn default() -> Self {
        Self {
            open_last_repository: false,
            refresh_on_focus: true,
            auto_fetch_minutes: 0,
            check_for_updates: true,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct GitSettings {
    /// What the Pull button does.
    pub default_pull_mode: PullMode,
    /// Remove remote-tracking branches that were deleted on the remote when fetching.
    pub prune_on_fetch: bool,
    /// Also push annotated tags that point at pushed commits (`--follow-tags`).
    pub push_follow_tags: bool,
}

impl Default for GitSettings {
    fn default() -> Self {
        Self {
            default_pull_mode: PullMode::FastForward,
            prune_on_fetch: true,
            push_follow_tags: false,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct EditorSettings {
    /// Command that opens a file, for example `code` or `subl`; empty uses the system default app.
    pub external_editor: String,
    /// Terminal application; empty uses the system's terminal.
    pub terminal: String,
    /// Lines of context around changes in diffs.
    pub diff_context: u32,
    /// Hide changes that only touch whitespace (read-only diffs).
    pub ignore_whitespace: bool,
    pub tab_width: u32,
    /// Font size of code in diffs and the merge editor, in pixels.
    pub code_font_size: u32,
    #[serde(deserialize_with = "or_default")]
    pub diff_layout: DiffLayout,
    /// Color code in diffs by language.
    pub syntax_highlighting: bool,
}

impl Default for EditorSettings {
    fn default() -> Self {
        Self {
            external_editor: String::new(),
            terminal: String::new(),
            diff_context: 3,
            ignore_whitespace: false,
            tab_width: 4,
            code_font_size: 12,
            diff_layout: DiffLayout::Unified,
            syntax_highlighting: true,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SafetySettings {
    pub confirm_discard: bool,
    pub confirm_force_push: bool,
    /// Warn before rebasing a branch that is already pushed.
    pub confirm_rebase_published: bool,
    pub confirm_delete_branch: bool,
}

impl Default for SafetySettings {
    fn default() -> Self {
        Self {
            confirm_discard: true,
            confirm_force_push: true,
            confirm_rebase_published: true,
            confirm_delete_branch: true,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CommitStyle {
    /// `feat(scope): summary`
    #[default]
    Conventional,
    /// A plain imperative summary.
    Plain,
}

/// Where AI answers come from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AiProvider {
    /// An Ollama server, usually on this computer.
    #[default]
    Ollama,
    /// Any server with an OpenAI-compatible API (LM Studio, vLLM, llama.cpp, OpenRouter...).
    OpenaiCompatible,
    /// Claude models through the Anthropic API.
    Anthropic,
    /// The OpenAI API.
    Openai,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AiSettings {
    /// The general "Use AI" switch. Off: no AI feature is shown and nothing is sent.
    pub enabled: bool,
    #[serde(deserialize_with = "or_default")]
    pub provider: AiProvider,
    /// Ollama server, for example `http://localhost:11434`.
    pub url: String,
    /// Ollama model.
    pub model: String,
    /// Base address of an OpenAI-compatible server, for example `http://localhost:1234/v1`.
    pub compatible_url: String,
    pub compatible_model: String,
    pub anthropic_model: String,
    pub openai_model: String,
    /// Show "Suggest message" in the commit box (when AI is on).
    pub commit_suggestions: bool,
    #[serde(deserialize_with = "or_default")]
    pub style: CommitStyle,
    /// Language of generated messages, for example "English".
    pub language: String,
    /// Extra instructions added to the prompt (team conventions, ticket prefixes...).
    pub instructions: String,
}

impl Default for AiSettings {
    fn default() -> Self {
        Self {
            enabled: false,
            provider: AiProvider::Ollama,
            url: "http://localhost:11434".into(),
            model: String::new(),
            compatible_url: "http://localhost:1234/v1".into(),
            compatible_model: String::new(),
            anthropic_model: String::new(),
            openai_model: String::new(),
            commit_suggestions: true,
            style: CommitStyle::Conventional,
            language: "English".into(),
            instructions: String::new(),
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub general: GeneralSettings,
    pub git: GitSettings,
    pub editor: EditorSettings,
    pub safety: SafetySettings,
    pub ai: AiSettings,
}

impl Settings {
    /// Clamp values the UI should never produce, in case the file was edited by hand.
    pub fn normalized(mut self) -> Self {
        self.general.auto_fetch_minutes = self.general.auto_fetch_minutes.min(24 * 60);
        self.editor.diff_context = self.editor.diff_context.clamp(0, 50);
        self.editor.tab_width = self.editor.tab_width.clamp(1, 16);
        self.editor.code_font_size = self.editor.code_font_size.clamp(9, 24);
        self.editor.external_editor = self.editor.external_editor.trim().to_string();
        self.editor.terminal = self.editor.terminal.trim().to_string();
        self.ai.url = self.ai.url.trim().trim_end_matches('/').to_string();
        self.ai.model = self.ai.model.trim().to_string();
        self.ai.compatible_url = self
            .ai
            .compatible_url
            .trim()
            .trim_end_matches('/')
            .to_string();
        for model in [
            &mut self.ai.compatible_model,
            &mut self.ai.anthropic_model,
            &mut self.ai.openai_model,
        ] {
            *model = model.trim().to_string();
        }
        if self.ai.instructions.len() > 4000 {
            self.ai.instructions.truncate(4000);
        }
        self
    }
}

struct Store {
    path: Option<PathBuf>,
    current: Settings,
}

fn store() -> &'static RwLock<Store> {
    static STORE: OnceLock<RwLock<Store>> = OnceLock::new();
    STORE.get_or_init(|| {
        RwLock::new(Store {
            path: None,
            current: Settings::default(),
        })
    })
}

/// Read settings from `path` (missing or unreadable files give the defaults).
pub fn load_file(path: &Path) -> Settings {
    std::fs::read(path)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Settings>(&bytes).ok())
        .unwrap_or_default()
        .normalized()
}

/// Write settings to `path` atomically.
pub fn save_file(path: &Path, settings: &Settings) -> Result<(), GitError> {
    let io = |e: std::io::Error| GitError::Internal(format!("cannot save settings: {e}"));
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(io)?;
    }
    let json = serde_json::to_vec_pretty(settings)
        .map_err(|e| GitError::Internal(format!("cannot save settings: {e}")))?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, json).map_err(io)?;
    std::fs::rename(&tmp, path).map_err(io)
}

/// Load the settings file once at startup.
pub fn init(path: PathBuf) {
    let current = load_file(&path);
    let mut s = store().write().unwrap_or_else(|e| e.into_inner());
    s.path = Some(path);
    s.current = current;
}

/// The settings in effect.
pub fn current() -> Settings {
    store()
        .read()
        .unwrap_or_else(|e| e.into_inner())
        .current
        .clone()
}

/// Replace the settings and write them to disk.
pub fn update(settings: Settings) -> Result<Settings, GitError> {
    let settings = settings.normalized();
    let mut s = store().write().unwrap_or_else(|e| e.into_inner());
    if let Some(path) = &s.path {
        save_file(path, &settings)?;
    }
    s.current = settings.clone();
    Ok(settings)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_and_partial_files_use_defaults() {
        let dir = tempfile::TempDir::new().unwrap();
        let path = dir.path().join("settings.json");
        assert_eq!(load_file(&path), Settings::default());

        std::fs::write(
            &path,
            r#"{"general":{"autoFetchMinutes":15},"ai":{"enabled":true,"model":"llama3.2"},"future":1}"#,
        )
        .unwrap();
        let s = load_file(&path);
        assert_eq!(s.general.auto_fetch_minutes, 15);
        assert!(
            s.general.refresh_on_focus,
            "missing fields keep their defaults"
        );
        assert!(s.ai.enabled);
        assert_eq!(s.ai.url, "http://localhost:11434");

        std::fs::write(&path, b"not json").unwrap();
        assert_eq!(load_file(&path), Settings::default());
    }

    #[test]
    fn saves_atomically_and_round_trips() {
        let dir = tempfile::TempDir::new().unwrap();
        let path = dir.path().join("nested").join("settings.json");
        let mut s = Settings::default();
        s.editor.tab_width = 2;
        s.ai.url = " http://192.168.1.5:11434/ ".into();
        let s = s.normalized();
        save_file(&path, &s).unwrap();
        assert!(!path.with_extension("json.tmp").exists());
        let back = load_file(&path);
        assert_eq!(back, s);
        assert_eq!(back.ai.url, "http://192.168.1.5:11434");
    }

    #[test]
    fn unknown_choices_fall_back_without_losing_other_settings() {
        let s: Settings = serde_json::from_str(
            r#"{"editor":{"diffLayout":"triple","tabWidth":2},"ai":{"style":"haiku","model":"m"}}"#,
        )
        .unwrap();
        assert_eq!(s.editor.diff_layout, DiffLayout::Unified);
        assert_eq!(s.editor.tab_width, 2);
        assert_eq!(s.ai.style, CommitStyle::Conventional);
        assert_eq!(s.ai.model, "m");
        assert_eq!(s.ai.provider, AiProvider::Ollama);
        assert!(s.ai.commit_suggestions);
        assert!(s.editor.syntax_highlighting);
        let split: Settings = serde_json::from_str(r#"{"editor":{"diffLayout":"split"}}"#).unwrap();
        assert_eq!(split.editor.diff_layout, DiffLayout::Split);
    }

    #[test]
    fn clamps_hand_edited_values() {
        let mut s = Settings::default();
        s.editor.tab_width = 0;
        s.editor.code_font_size = 400;
        s.editor.diff_context = 9999;
        let s = s.normalized();
        assert_eq!(
            (
                s.editor.tab_width,
                s.editor.code_font_size,
                s.editor.diff_context
            ),
            (1, 24, 50)
        );
    }
}
