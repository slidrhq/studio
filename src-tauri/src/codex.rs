//! One picture from the Codex CLI, on the user's ChatGPT sign-in, as the app makes it
//! (`src-tauri/src/image_providers/codex_cli.rs`, ADR-004):
//!
//! ```text
//! codex exec --json --skip-git-repo-check --ignore-user-config --ignore-rules --ephemeral
//!       -s read-only "<prompt>" [-i <reference image>]
//! cwd: an empty temp folder      stdin: closed      stdout: one JSON event per line
//! ```
//!
//! The CLI's agent calls its image tool, which writes to `$CODEX_HOME/generated_images/<thread>/`;
//! the thread id is in the first event. The folder is read, then removed.

use std::{
    collections::VecDeque,
    fmt, fs,
    path::{Path, PathBuf},
    process::Stdio,
    time::{Duration, SystemTime},
};

use serde_json::Value;
use tokio::io::{AsyncBufReadExt, AsyncRead, BufReader};

use crate::programs;

/// Without it the agent sometimes writes code that draws the picture instead of calling its image
/// tool (the app's spike WG0-S4). Starting with a word also keeps the prompt from reading as a flag.
const RULE: &str = "Use your image generation tool. Do not write or run any code. When the image \
                    exists, reply with only its file path.";
/// The aspect is set by the wording; the size is whatever the model then chooses.
pub const SHAPES: [(&str, &str); 5] = [
    ("wide", "wide 16:9 landscape"),
    ("landscape", "4:3 landscape"),
    ("square", "square 1:1"),
    ("portrait", "3:4 portrait"),
    ("tall", "tall 9:16 portrait"),
];
const MAX_PROMPT_CHARS: usize = 8000;
/// An image takes 43 to 95 seconds (ADR-004); past this the run is taken for hung.
const RUN_TIMEOUT: Duration = Duration::from_secs(300);
const STDERR_LINES: usize = 12;

pub fn is_aspect(aspect: &str) -> bool {
    SHAPES.iter().any(|(name, _)| *name == aspect)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CodexErrorKind {
    NotLoggedIn,
    Quota,
    GenerationFailed,
    InvalidInput,
    NotInstalled,
    Timeout,
}

#[derive(Debug)]
pub struct CodexError {
    pub message: String,
    pub kind: CodexErrorKind,
}

impl CodexError {
    fn new(message: impl Into<String>, kind: CodexErrorKind) -> Self {
        Self {
            message: message.into(),
            kind,
        }
    }
}

impl fmt::Display for CodexError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

pub fn generate_prompt(prompt: &str, aspect: &str) -> String {
    let shape = SHAPES
        .iter()
        .find(|(name, _)| *name == aspect)
        .map_or(SHAPES[0].1, |(_, shape)| shape);
    format!("{RULE} Create ONE {shape} image: {}", prompt.trim())
}

pub fn edit_prompt(instruction: &str) -> String {
    format!(
        "{RULE} Edit the attached image, keeping its aspect ratio. Produce ONE image. The edit: {}",
        instruction.trim()
    )
}

pub fn build_args(prompt: &str, reference: Option<&Path>) -> Vec<String> {
    // The prompt goes before `-i`: the flag takes any number of files and would take a prompt
    // after it for one of them.
    let mut args: Vec<String> = [
        "exec",
        "--json",
        "--skip-git-repo-check",
        "--ignore-user-config",
        "--ignore-rules",
        "--ephemeral",
        "-s",
        "read-only",
    ]
    .map(str::to_owned)
    .to_vec();
    args.push(prompt.to_owned());
    if let Some(reference) = reference {
        args.extend(["-i".into(), reference.display().to_string()]);
    }
    args
}

pub fn classify(said: &str) -> CodexErrorKind {
    let said = said.to_lowercase();
    let any = |words: &[&str]| words.iter().any(|word| said.contains(word));
    if any(&[
        "unauthorized",
        "status 401",
        "\"status\":401",
        "not logged in",
        "sign in again",
        "refresh token",
    ]) {
        CodexErrorKind::NotLoggedIn
    } else if any(&[
        "too many requests",
        "status 429",
        "\"status\":429",
        "usage limit",
        "usage_limit",
        "rate limit",
        "rate_limit",
        "quota",
    ]) {
        CodexErrorKind::Quota
    } else {
        CodexErrorKind::GenerationFailed
    }
}

fn failure(said: &str) -> CodexError {
    let kind = classify(said);
    let said: String = said.chars().take(400).collect();
    let message = match kind {
        CodexErrorKind::NotLoggedIn => {
            format!("The Codex CLI is not signed in. Run `codex login`. The CLI said: {said}")
        }
        CodexErrorKind::Quota => {
            format!("The usage limit of the ChatGPT plan was reached. The CLI said: {said}")
        }
        _ => format!("Codex could not make the image: {said}"),
    };
    CodexError::new(message, kind)
}

/// The id becomes a folder name: anything but a plain token could point elsewhere.
fn plain_thread(thread: &str) -> bool {
    (1..=64).contains(&thread.len())
        && thread
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-')
}

#[derive(Debug, Default)]
pub struct Transcript {
    pub thread_id: Option<String>,
    pub last_message: Option<String>,
    pub completed: bool,
    pub failure: Option<String>,
    pub last_error: Option<String>,
}

impl Transcript {
    pub fn read(&mut self, line: &str) {
        let Ok(event) = serde_json::from_str::<Value>(line) else {
            return;
        };
        let text = |pointer: &str| {
            event
                .pointer(pointer)
                .and_then(Value::as_str)
                .map(str::to_owned)
        };
        match event.get("type").and_then(Value::as_str) {
            Some("thread.started") => {
                self.thread_id = text("/thread_id").filter(|thread| plain_thread(thread));
            }
            Some("item.completed") if text("/item/type").as_deref() == Some("agent_message") => {
                self.last_message = text("/item/text");
            }
            Some("turn.completed") => self.completed = true,
            Some("turn.failed") => self.failure = Some(text("/error/message").unwrap_or_default()),
            Some("error") => self.last_error = text("/message"),
            _ => {}
        }
    }
}

fn modified(file: &Path) -> SystemTime {
    fs::metadata(file)
        .and_then(|meta| meta.modified())
        .unwrap_or(SystemTime::UNIX_EPOCH)
}

/// Of several files, the one the agent named; when it named none, the newest.
pub fn pick(mut files: Vec<PathBuf>, said: Option<&str>) -> Option<PathBuf> {
    files.sort_by_key(|file| (modified(file), file.file_name().map(ToOwned::to_owned)));
    if let Some(said) = said
        && let Some(named) = files.iter().rev().find(|file| {
            file.file_name()
                .is_some_and(|name| said.contains(name.to_string_lossy().as_ref()))
        })
    {
        return Some(named.clone());
    }
    files.pop()
}

fn codex_home() -> PathBuf {
    if let Some(home) = std::env::var_os("CODEX_HOME").filter(|home| !home.is_empty()) {
        return PathBuf::from(home);
    }
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)
        .unwrap_or_default()
        .join(".codex")
}

/// The folders a run leaves, removed whatever becomes of it.
struct Leftovers {
    workdir: PathBuf,
    images: Option<PathBuf>,
}

impl Drop for Leftovers {
    fn drop(&mut self) {
        if let Some(images) = &self.images {
            let _ = fs::remove_dir_all(images);
        }
        let _ = fs::remove_dir_all(&self.workdir);
    }
}

async fn each_line(stream: impl AsyncRead + Unpin, mut on_line: impl FnMut(&str)) {
    let mut reader = BufReader::new(stream);
    let mut line = Vec::new();
    loop {
        line.clear();
        match reader.read_until(b'\n', &mut line).await {
            Ok(0) | Err(_) => break,
            Ok(_) => on_line(&String::from_utf8_lossy(&line)),
        }
    }
}

/// Generates (or, with a reference, regenerates after it) one picture into `out`.
pub async fn make_image(
    prompt: &str,
    out: &Path,
    aspect: &str,
    reference: Option<&Path>,
) -> Result<(), CodexError> {
    let text = match reference {
        Some(_) => edit_prompt(prompt),
        None => generate_prompt(prompt, aspect),
    };
    if text.chars().count() > MAX_PROMPT_CHARS || text.contains('\0') {
        return Err(CodexError::new(
            format!("The image prompt must be at most {MAX_PROMPT_CHARS} characters."),
            CodexErrorKind::InvalidInput,
        ));
    }
    let program = programs::find_codex().ok_or_else(|| {
        CodexError::new(
            "The Codex CLI was not found. Install it (`npm install -g @openai/codex`), then run \
             `codex login`.",
            CodexErrorKind::NotInstalled,
        )
    })?;
    let workdir = std::env::temp_dir().join(format!(
        "slidr-studio-image-{}",
        uuid::Uuid::new_v4().simple()
    ));
    fs::create_dir_all(&workdir)
        .map_err(|e| CodexError::new(e.to_string(), CodexErrorKind::GenerationFailed))?;
    let mut leftovers = Leftovers {
        workdir: workdir.clone(),
        images: None,
    };

    let mut command = programs::command(&program);
    command
        .args(build_args(&text, reference))
        .current_dir(&workdir)
        // The promise is the ChatGPT sign-in: a key that happens to be set must not bill by use.
        .env_remove("CODEX_API_KEY")
        .env_remove("OPENAI_API_KEY")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = programs::spawn(&mut command)
        .map_err(|e| failure(&format!("the CLI could not start: {e}")))?;
    let (Some(stdout), Some(stderr)) = (child.stdout.take(), child.stderr.take()) else {
        return Err(failure("the CLI started without its pipes"));
    };
    let mut transcript = Transcript::default();
    let mut stderr_tail = VecDeque::with_capacity(STDERR_LINES);
    let run = async {
        let out = each_line(stdout, |line| transcript.read(line));
        let err = each_line(stderr, |line| {
            let line = line.trim();
            if !line.is_empty() {
                if stderr_tail.len() == STDERR_LINES {
                    stderr_tail.pop_front();
                }
                stderr_tail.push_back(line.to_owned());
            }
        });
        tokio::join!(out, err);
        child.wait().await
    };
    let status = tokio::time::timeout(RUN_TIMEOUT, run).await.map_err(|_| {
        CodexError::new(
            format!(
                "Codex did not finish within {} seconds and was stopped.",
                RUN_TIMEOUT.as_secs()
            ),
            CodexErrorKind::Timeout,
        )
    })?;

    let folder = transcript
        .thread_id
        .as_ref()
        .map(|thread| codex_home().join("generated_images").join(thread));
    leftovers.images.clone_from(&folder);
    if let Some(said) = &transcript.failure {
        return Err(failure(said));
    }
    let code = status.as_ref().ok().and_then(|status| status.code());
    if !(transcript.completed && code == Some(0)) {
        let said = transcript
            .last_error
            .clone()
            .unwrap_or_else(|| stderr_tail.iter().cloned().collect::<Vec<_>>().join(" "));
        let code = code.map_or_else(|| "none".to_owned(), |code| code.to_string());
        return Err(failure(&format!(
            "the CLI stopped with exit code {code} before it was done. {said}"
        )));
    }
    let files: Vec<PathBuf> = folder
        .as_deref()
        .and_then(|folder| fs::read_dir(folder).ok())
        .map(|entries| {
            entries
                .flatten()
                .map(|entry| entry.path())
                .filter(|path| path.is_file())
                .collect()
        })
        .unwrap_or_default();
    let Some(chosen) = pick(files, transcript.last_message.as_deref()) else {
        let said: String = transcript
            .last_message
            .as_deref()
            .unwrap_or("nothing")
            .chars()
            .take(400)
            .collect();
        return Err(CodexError::new(
            format!("Codex finished without making an image. It said: {said}"),
            CodexErrorKind::GenerationFailed,
        ));
    };
    if let Some(parent) = out.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| CodexError::new(e.to_string(), CodexErrorKind::GenerationFailed))?;
    }
    fs::copy(&chosen, out)
        .map_err(|e| CodexError::new(e.to_string(), CodexErrorKind::GenerationFailed))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use serde_json::json;

    use super::*;

    #[test]
    fn codex_prompt_and_command_line_follow_the_app() {
        let prompt = generate_prompt("  a barn  ", "square");
        assert!(prompt.starts_with("Use your image generation tool."));
        assert!(prompt.ends_with("Create ONE square 1:1 image: a barn"));
        let args = build_args(&prompt, Some(Path::new("ref.png")));
        assert_eq!(
            args[..8],
            [
                "exec",
                "--json",
                "--skip-git-repo-check",
                "--ignore-user-config",
                "--ignore-rules",
                "--ephemeral",
                "-s",
                "read-only"
            ]
        );
        // The prompt comes before -i, which would take what follows it as files.
        let at = |arg: &str| args.iter().position(|a| a == arg).expect(arg);
        assert!(at(&prompt) < at("-i"));
    }

    #[test]
    fn codex_transcript_and_failures() {
        let mut transcript = Transcript::default();
        for line in [
            json!({"type": "thread.started", "thread_id": "01a0-ff"}),
            json!({"type": "item.completed", "item": {"type": "agent_message", "text": "C:\\x\\exec-1.png"}}),
            json!({"type": "turn.completed"}),
        ] {
            transcript.read(&line.to_string());
        }
        assert_eq!(transcript.thread_id.as_deref(), Some("01a0-ff"));
        assert!(transcript.completed);
        let mut bad = Transcript::default();
        bad.read(&json!({"type": "thread.started", "thread_id": "../../etc"}).to_string());
        assert_eq!(bad.thread_id, None);
        assert_eq!(classify("401 Unauthorized"), CodexErrorKind::NotLoggedIn);
        assert_eq!(
            classify("You've hit your usage limit"),
            CodexErrorKind::Quota
        );
        assert_eq!(classify("something else"), CodexErrorKind::GenerationFailed);
    }

    #[test]
    fn codex_pick_prefers_the_named_file() {
        let dir = tempfile::tempdir().expect("a folder");
        let (older, newer) = (dir.path().join("exec-1.png"), dir.path().join("exec-2.png"));
        fs::write(&older, b"1").expect("written");
        fs::write(&newer, b"2").expect("written");
        let past = SystemTime::now() - Duration::from_secs(100);
        fs::File::options()
            .write(true)
            .open(&older)
            .and_then(|file| file.set_modified(past))
            .expect("dated");
        let both = || vec![older.clone(), newer.clone()];
        assert_eq!(pick(both(), None), Some(newer.clone()));
        let said = format!("saved {}", older.display());
        assert_eq!(pick(both(), Some(&said)), Some(older.clone()));
        assert_eq!(pick(Vec::new(), Some("x")), None);
    }
}
