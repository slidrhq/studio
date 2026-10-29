//! The agents the studio works with, the person's choice of them, and one turn of either program.
//!
//! Three roles, each its own choice of program, model and effort:
//!
//! - **design**: the English design, the master of every language: the plan of the concepts, the
//!   HTML, its review, and its names and search tags in English (and its Hebrew name);
//! - **images**: the picture of each design (Codex's image tool, as the app makes them);
//! - **translation**: every other language of a design once its master is approved, the names and
//!   search tags in those languages, and the sample decks of the templates.
//!
//! The settings hold the studio's choice (`<data>/settings.json`); a chat may hold its own for any
//! role, which wins over them in that chat. Claude Code and the Codex CLI both work in a folder of
//! their own, write its files, and keep a conversation that a later turn resumes. A conversation
//! belongs to its program: a role moved to the other program starts a new one.

use std::{
    path::{Path, PathBuf},
    sync::{Mutex, MutexGuard, PoisonError},
    time::Duration,
};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::{
    claude::{self, ClaudeCall},
    codex,
    store::{read_json, write_json},
};

/// Claude Code's file tools, all a turn that writes needs.
const CLAUDE_TOOLS: [&str; 4] = ["Read", "Write", "Edit", "Glob"];
/// The models and efforts Claude Code is asked for by name; empty is its default.
pub const CLAUDE_MODELS: [&str; 5] = ["", "fable", "opus", "sonnet", "haiku"];
pub const EFFORTS: [&str; 6] = ["", "low", "medium", "high", "xhigh", "max"];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Program {
    #[default]
    Claude,
    Codex,
}

impl Program {
    pub fn name(self) -> &'static str {
        match self {
            Self::Claude => "Claude",
            Self::Codex => "Codex",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Role {
    Design,
    Images,
    Translation,
}

/// A role's program, model and effort; an empty model or effort is the program's default.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentChoice {
    #[serde(default)]
    pub program: Program,
    #[serde(default)]
    pub model: String,
    #[serde(default)]
    pub effort: String,
}

impl AgentChoice {
    fn codex() -> Self {
        Self {
            program: Program::Codex,
            ..Self::default()
        }
    }

    /// The choice held to what the role and its program take.
    pub fn check(&self, role: Role) -> Result<(), String> {
        if role == Role::Images && self.program != Program::Codex {
            return Err("The pictures are made by Codex only.".into());
        }
        if !EFFORTS.contains(&self.effort.as_str()) {
            return Err(format!("Unknown effort '{}'.", self.effort));
        }
        match self.program {
            Program::Claude if !CLAUDE_MODELS.contains(&self.model.as_str()) => {
                Err(format!("Unknown Claude model '{}'.", self.model))
            }
            Program::Codex
                if self.model.len() > 40
                    || !self
                        .model
                        .bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b".-_".contains(&b)) =>
            {
                Err(format!("Not a model's name: '{}'.", self.model))
            }
            _ => Ok(()),
        }
    }
}

/// The program, model and effort of each role.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct Agents {
    pub design: AgentChoice,
    pub images: AgentChoice,
    pub translation: AgentChoice,
}

impl Default for Agents {
    fn default() -> Self {
        Self {
            design: AgentChoice::default(),
            images: AgentChoice::codex(),
            translation: AgentChoice::default(),
        }
    }
}

impl Agents {
    pub fn of(&self, role: Role) -> &AgentChoice {
        match role {
            Role::Design => &self.design,
            Role::Images => &self.images,
            Role::Translation => &self.translation,
        }
    }

    /// These, with a chat's own choices over them.
    pub fn with(&self, own: Option<&OwnAgents>) -> Self {
        let Some(own) = own else {
            return self.clone();
        };
        Self {
            design: own.design.clone().unwrap_or_else(|| self.design.clone()),
            images: own.images.clone().unwrap_or_else(|| self.images.clone()),
            translation: own
                .translation
                .clone()
                .unwrap_or_else(|| self.translation.clone()),
        }
    }

    pub fn check(&self) -> Result<(), String> {
        self.design.check(Role::Design)?;
        self.images.check(Role::Images)?;
        self.translation.check(Role::Translation)
    }
}

/// A chat's own choices, each role optional.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct OwnAgents {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub design: Option<AgentChoice>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub images: Option<AgentChoice>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub translation: Option<AgentChoice>,
}

impl OwnAgents {
    pub fn is_empty(&self) -> bool {
        self.design.is_none() && self.images.is_none() && self.translation.is_none()
    }

    pub fn check(&self) -> Result<(), String> {
        for (choice, role) in [
            (&self.design, Role::Design),
            (&self.images, Role::Images),
            (&self.translation, Role::Translation),
        ] {
            if let Some(choice) = choice {
                choice.check(role)?;
            }
        }
        Ok(())
    }
}

fn two() -> u32 {
    2
}

/// What the person sets for the whole studio.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StudioSettings {
    #[serde(default)]
    pub agents: Agents,
    /// The review rounds of every design and sample, 0 to 3.
    #[serde(default = "two")]
    pub review_rounds: u32,
}

impl Default for StudioSettings {
    fn default() -> Self {
        Self {
            agents: Agents::default(),
            review_rounds: 2,
        }
    }
}

impl StudioSettings {
    pub fn check(&self) -> Result<(), String> {
        if self.review_rounds > 3 {
            return Err("Review at most 3 rounds.".into());
        }
        self.agents.check()
    }
}

/// The studio's settings, kept in a file of its data.
pub struct Preferences {
    path: PathBuf,
    value: Mutex<StudioSettings>,
}

impl Preferences {
    /// The settings in `path`, or the defaults where there are none (or they do not hold).
    pub fn load(path: PathBuf) -> Self {
        let value = read_json::<StudioSettings>(&path)
            .filter(|settings| settings.check().is_ok())
            .unwrap_or_default();
        Self {
            path,
            value: Mutex::new(value),
        }
    }

    fn lock(&self) -> MutexGuard<'_, StudioSettings> {
        self.value.lock().unwrap_or_else(PoisonError::into_inner)
    }

    pub fn get(&self) -> StudioSettings {
        self.lock().clone()
    }

    pub fn set(&self, settings: StudioSettings) -> Result<StudioSettings, String> {
        settings.check()?;
        write_json(&self.path, &settings).map_err(|e| format!("{}: {e}", self.path.display()))?;
        *self.lock() = settings.clone();
        Ok(settings)
    }
}

/// A conversation of an agent, and the program it belongs to.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Session {
    pub program: Program,
    pub id: String,
}

/// One turn of an agent in its folder.
pub struct Turn {
    pub choice: AgentChoice,
    pub prompt: String,
    /// The folder it works in: the only one its file tools reach.
    pub cwd: PathBuf,
    pub system_prompt_file: PathBuf,
    /// Whether it writes files; a turn that only answers (a plan, a route) reads none either.
    pub writes: bool,
    /// The conversation to continue; a new one when it is none or of the other program.
    pub session: Option<Session>,
    /// The shape of the answer, for a turn that answers with data.
    pub json_schema: Option<Value>,
    pub timeout: Duration,
}

impl Turn {
    pub fn new(choice: AgentChoice, prompt: String, cwd: PathBuf, system: PathBuf) -> Self {
        Self {
            choice,
            prompt,
            cwd,
            system_prompt_file: system,
            writes: false,
            session: None,
            json_schema: None,
            timeout: Duration::from_secs(30 * 60),
        }
    }
}

#[derive(Debug)]
pub struct TurnResult {
    /// The conversation the turn was part of, to resume.
    pub session: Option<Session>,
    pub text: String,
    /// The answer's data, for a turn with a schema; `Null` without one.
    pub structured: Value,
    /// What it cost, where the program says (Claude Code does; Codex does not).
    pub cost: f64,
}

/// The data of a reply that should be JSON: the reply itself, or the first object in it (a model
/// may wrap it in a fence).
pub fn json_in(text: &str) -> Option<Value> {
    let text = text.trim();
    if let Ok(value) = serde_json::from_str::<Value>(text) {
        return Some(value);
    }
    let start = text.find('{')?;
    let end = text.rfind('}')?;
    serde_json::from_str(&text[start..=end]).ok()
}

/// The text files of a folder a turn works in (its brief, its HTML, its samples and names), as
/// they are now, for a program that cannot read them itself: Codex has no tool that reads a file
/// once its shell is off (it has its patch tool, and sees pictures). A file larger than any of
/// ours is named, not shown; pictures and the renders' folders are not text.
pub fn folder_text(folder: &Path) -> String {
    const MOST: u64 = 600_000;
    let mut files: Vec<PathBuf> = std::fs::read_dir(folder)
        .map(|entries| {
            entries
                .filter_map(Result::ok)
                .map(|entry| entry.path())
                .filter(|path| path.is_file())
                .filter(|path| {
                    path.extension()
                        .and_then(|ext| ext.to_str())
                        .is_some_and(|ext| matches!(ext, "html" | "json" | "md" | "txt"))
                })
                .collect()
        })
        .unwrap_or_default();
    files.sort();
    let mut text =
        "\n\n## The files of your folder, as they are now\n\nYou have no tool that reads \
                    a file: this is the text of each file of your folder as it stands at the \
                    start of this turn. Read them here, and change them with your patch tool, \
                    whose context lines must match these exactly. The pictures (`subject.png`, \
                    `renders/`) you see with your image tool."
            .to_owned();
    for path in files {
        let name = path
            .file_name()
            .map_or_else(String::new, |n| n.to_string_lossy().into());
        let size = std::fs::metadata(&path).map_or(0, |m| m.len());
        if size > MOST {
            text.push_str(&format!(
                "\n\n### `{name}`\n\n({size} bytes: too large to show.)"
            ));
            continue;
        }
        let Ok(content) = std::fs::read_to_string(&path) else {
            continue;
        };
        let lang = path.extension().and_then(|ext| ext.to_str()).unwrap_or("");
        text.push_str(&format!("\n\n### `{name}`\n\n````{lang}\n{content}\n````"));
    }
    text
}

/// Runs one turn. `on_activity` hears each tool call and each passage of text as it comes.
pub async fn run(
    turn: Turn,
    on_activity: impl FnMut(&str, &str) + Send,
) -> Result<TurnResult, String> {
    let program = turn.choice.program;
    let resume = turn
        .session
        .filter(|session| session.program == program)
        .map(|session| session.id);
    let model = Some(turn.choice.model.clone()).filter(|m| !m.is_empty());
    let effort = Some(turn.choice.effort.clone()).filter(|e| !e.is_empty());
    match program {
        Program::Claude => {
            let mut call = ClaudeCall::new(turn.prompt, turn.cwd, turn.system_prompt_file);
            if turn.writes {
                call.tools = CLAUDE_TOOLS.to_vec();
            }
            match resume {
                Some(id) => call.resume = Some(id),
                None => call.session_id = Some(uuid::Uuid::new_v4().to_string()),
            }
            call.model = model;
            call.effort = effort;
            call.json_schema = turn.json_schema;
            call.timeout = turn.timeout;
            let result = claude::run(call, on_activity).await?;
            Ok(TurnResult {
                session: result.session_id.map(|id| Session { program, id }),
                text: result.text,
                structured: result.structured,
                cost: result.cost,
            })
        }
        Program::Codex => {
            let mut prompt = turn.prompt;
            // Codex reads no file without its shell, which is off: a turn that works on the
            // folder is given its files as they are now.
            if turn.writes {
                prompt.push_str(&folder_text(&turn.cwd));
            }
            if let Some(schema) = &turn.json_schema {
                prompt.push_str(&format!(
                    "\n\nAnswer with one JSON object and nothing else (no fence, no words around \
                     it), of this JSON Schema:\n{schema}"
                ));
            }
            let call = codex::AgentCall {
                prompt,
                cwd: turn.cwd,
                system_prompt_file: turn.system_prompt_file,
                writes: turn.writes,
                resume,
                model,
                effort,
                timeout: turn.timeout,
            };
            let result = codex::run_agent(call, on_activity).await?;
            let structured = if turn.json_schema.is_some() {
                json_in(&result.text).ok_or_else(|| {
                    format!(
                        "Codex did not answer with the data asked for: {}",
                        result.text.chars().take(300).collect::<String>()
                    )
                })?
            } else {
                Value::Null
            };
            Ok(TurnResult {
                session: result.thread.map(|id| Session { program, id }),
                text: result.text,
                structured,
                cost: 0.0,
            })
        }
    }
}

/// Where the settings are kept.
pub fn settings_file(data: &Path) -> PathBuf {
    data.join("settings.json")
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn a_chat_choice_wins_over_the_settings_for_its_role_only() {
        let settings = Agents::default();
        let own = OwnAgents {
            translation: Some(AgentChoice {
                program: Program::Codex,
                model: "gpt-5.5".into(),
                effort: "high".into(),
            }),
            ..OwnAgents::default()
        };
        let agents = settings.with(Some(&own));
        assert_eq!(agents.design, settings.design);
        assert_eq!(agents.translation.program, Program::Codex);
        assert_eq!(agents.translation.model, "gpt-5.5");
        assert_eq!(settings.with(None), settings);
    }

    #[test]
    fn choices_are_held_to_what_their_program_takes() {
        assert!(Agents::default().check().is_ok());
        let mut agents = Agents::default();
        agents.images.program = Program::Claude;
        assert!(agents.check().is_err_and(|e| e.contains("Codex only")));
        let mut agents = Agents::default();
        agents.design.model = "gpt-5".into();
        assert!(agents.check().is_err());
        agents.design.program = Program::Codex;
        assert!(agents.check().is_ok());
        agents.design.model = "a b".into();
        assert!(agents.check().is_err());
        let settings: StudioSettings = serde_json::from_value(json!({})).expect("defaults");
        assert_eq!(settings.review_rounds, 2);
        assert_eq!(settings.agents.images.program, Program::Codex);
    }

    #[test]
    fn settings_are_kept_and_refused_when_they_do_not_hold() {
        let dir = tempfile::tempdir().expect("a folder");
        let prefs = Preferences::load(settings_file(dir.path()));
        assert_eq!(prefs.get(), StudioSettings::default());
        let mut settings = prefs.get();
        settings.agents.translation.program = Program::Codex;
        settings.review_rounds = 1;
        prefs.set(settings.clone()).expect("kept");
        assert_eq!(Preferences::load(settings_file(dir.path())).get(), settings);
        settings.review_rounds = 9;
        assert!(prefs.set(settings).is_err());
    }

    #[test]
    fn codex_is_given_the_text_of_its_folder() {
        let folder = std::env::temp_dir().join(format!("studio-folder-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(folder.join("renders")).expect("a folder");
        for (name, bytes) in [
            ("en.html", b"<div lang=\"en\">Hello</div>".as_slice()),
            ("brief.json", b"{\"id\": \"m-x\"}".as_slice()),
            ("subject.png", b"\x89PNG".as_slice()),
            ("renders/result.json", b"{}".as_slice()),
        ] {
            std::fs::write(folder.join(name), bytes).expect("a file");
        }
        let text = folder_text(&folder);
        assert!(text.contains("### `en.html`\n\n````html\n<div lang=\"en\">Hello</div>\n````"));
        let at = |name: &str| text.find(name).unwrap_or(usize::MAX);
        assert!(at("`brief.json`") < at("`en.html`"));
        assert!(!text.contains("### `subject.png`") && !text.contains("### `result.json`"));
        std::fs::remove_dir_all(&folder).expect("removed");
    }

    #[test]
    fn a_reply_in_a_fence_still_gives_its_data() {
        assert_eq!(json_in("{\"a\": 1}"), Some(json!({"a": 1})));
        assert_eq!(
            json_in("Here:\n```json\n{\"a\": [1, 2]}\n```"),
            Some(json!({"a": [1, 2]}))
        );
        assert_eq!(json_in("no data"), None);
    }
}
