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

/// The command line with the model named right after `exec`, when one is chosen.
fn with_model(mut args: Vec<String>, model: Option<&str>) -> Vec<String> {
    if let Some(model) = model {
        args.splice(1..1, ["--model".to_owned(), model.to_owned()]);
    }
    args
}

/// Generates (or, with a reference, regenerates after it) one picture into `out`.
pub async fn make_image(
    prompt: &str,
    out: &Path,
    aspect: &str,
    reference: Option<&Path>,
    model: Option<&str>,
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
        .args(with_model(build_args(&text, reference), model))
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

/* ------------------------------------------------------------------ Codex as an agent */

/// One turn of Codex as the agent of a role (`agents.rs`): it works in `cwd`, reads its files with
/// its shell and the pictures in it, and writes its files with its patch tool or its shell. The
/// sandbox of Windows keeps its writes to its folder (and the temporary folder); its shell is
/// Windows PowerShell (`agent_path`).
pub struct AgentCall {
    pub prompt: String,
    pub cwd: PathBuf,
    pub system_prompt_file: PathBuf,
    pub writes: bool,
    /// The thread to continue.
    pub resume: Option<String>,
    pub model: Option<String>,
    pub effort: Option<String>,
    pub timeout: Duration,
}

pub struct AgentResult {
    pub thread: Option<String>,
    pub text: String,
}

/// `codex exec` for a turn of an agent:
///
/// ```text
/// codex exec --json --skip-git-repo-check --ignore-user-config --ignore-rules
///       --sandbox (workspace-write | read-only) -C <cwd> -c approval_policy="never"
///       -c windows.sandbox="unelevated" -c web_search="disabled"
///       -c model_instructions_file="<system>" [--model m] [-c model_reasoning_effort="e"]
///       [resume <thread>] -
/// stdin: the prompt
/// ```
pub fn agent_args(call: &AgentCall) -> Vec<String> {
    let mut args: Vec<String> = [
        "exec",
        "--json",
        "--skip-git-repo-check",
        "--ignore-user-config",
        "--ignore-rules",
        "--sandbox",
        if call.writes {
            "workspace-write"
        } else {
            "read-only"
        },
        "-C",
    ]
    .map(str::to_owned)
    .to_vec();
    args.push(call.cwd.display().to_string());
    let quoted = |text: String| serde_json::Value::String(text).to_string();
    for setting in [
        "approval_policy=\"never\"".to_owned(),
        "windows.sandbox=\"unelevated\"".to_owned(),
        "features.apps=false".to_owned(),
        "web_search=\"disabled\"".to_owned(),
        format!(
            "model_instructions_file={}",
            quoted(call.system_prompt_file.display().to_string())
        ),
    ] {
        args.extend(["-c".into(), setting]);
    }
    if let Some(model) = &call.model {
        args.extend(["--model".into(), model.clone()]);
    }
    if let Some(effort) = &call.effort {
        args.extend([
            "-c".into(),
            format!("model_reasoning_effort={}", quoted(effort.clone())),
        ]);
    }
    if let Some(thread) = &call.resume {
        args.extend(["resume".into(), thread.clone()]);
    }
    args.push("-".into());
    args
}

/// The PATH of an agent's turn: `path` without the folders of the Store's apps (`…\WindowsApps`).
/// Their aliases (`pwsh.exe`) cannot start under the sandbox, and Codex takes the first shell it
/// finds on the PATH; without them it takes Windows PowerShell, which can.
fn agent_path(path: &std::ffi::OsStr) -> Option<std::ffi::OsString> {
    let kept = std::env::split_paths(path).filter(|dir| {
        !dir.components()
            .any(|part| part.as_os_str().eq_ignore_ascii_case("WindowsApps"))
    });
    std::env::join_paths(kept).ok()
}

/// What one line of an agent's stream says to the activity log: a file it wrote, a picture it
/// looked at, a passage of its text.
fn agent_activity(event: &Value) -> Option<(&'static str, String)> {
    let item = event.get("item")?;
    let completed = event.get("type").and_then(Value::as_str) == Some("item.completed");
    match item.get("type").and_then(Value::as_str)? {
        "file_change" if completed => {
            let files: Vec<String> = item
                .get("changes")
                .and_then(Value::as_array)?
                .iter()
                .filter_map(|change| change.get("path").and_then(Value::as_str))
                .map(|path| {
                    Path::new(path)
                        .file_name()
                        .map_or_else(|| path.to_owned(), |n| n.to_string_lossy().into_owned())
                })
                .collect();
            Some(("tool", format!("Write {}", files.join(", "))))
        }
        "agent_message" if completed => {
            let text = item.get("text").and_then(Value::as_str)?.trim();
            (!text.is_empty()).then(|| ("text", text.chars().take(600).collect()))
        }
        "mcp_tool_call" | "web_search" | "command_execution" if !completed => {
            let name = item
                .get("tool")
                .or_else(|| item.get("type"))
                .and_then(Value::as_str)
                .unwrap_or("tool");
            Some(("tool", name.to_owned()))
        }
        _ => None,
    }
}

/// Runs one turn of Codex as an agent. `on_activity` hears what it does as it does it.
pub async fn run_agent(
    call: AgentCall,
    mut on_activity: impl FnMut(&str, &str) + Send,
) -> Result<AgentResult, String> {
    let program = programs::find_codex().ok_or(
        "The Codex CLI was not found. Install it (`npm install -g @openai/codex`), then run \
         `codex login`.",
    )?;
    fs::create_dir_all(&call.cwd).map_err(|e| format!("{}: {e}", call.cwd.display()))?;
    let mut command = programs::command(&program);
    command
        .args(agent_args(&call))
        .current_dir(&call.cwd)
        .env_remove("CODEX_API_KEY")
        .env_remove("OPENAI_API_KEY")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(path) = std::env::var_os("PATH").and_then(|path| agent_path(&path)) {
        command.env("PATH", path);
    }
    let mut child =
        programs::spawn(&mut command).map_err(|e| format!("The Codex CLI could not start: {e}"))?;
    let (Some(mut stdin), Some(stdout), Some(stderr)) =
        (child.stdin.take(), child.stdout.take(), child.stderr.take())
    else {
        return Err("The Codex CLI started without its pipes.".into());
    };
    let mut transcript = Transcript::default();
    let mut stderr_tail = VecDeque::with_capacity(STDERR_LINES);
    let prompt = call.prompt.into_bytes();
    let turn = async {
        let feed = async {
            use tokio::io::AsyncWriteExt;
            let _ = stdin.write_all(&prompt).await;
            let _ = stdin.shutdown().await;
            drop(stdin);
        };
        let out = each_line(stdout, |line| {
            transcript.read(line);
            if let Ok(event) = serde_json::from_str::<Value>(line)
                && let Some((kind, text)) = agent_activity(&event)
            {
                on_activity(kind, &text);
            }
        });
        let err = each_line(stderr, |line| {
            let line = line.trim();
            // Codex warns of every skill of the person's own it cannot read; not ours to tell.
            if !line.is_empty() && !line.contains("failed to load skill") {
                if stderr_tail.len() == STDERR_LINES {
                    stderr_tail.pop_front();
                }
                stderr_tail.push_back(line.to_owned());
            }
        });
        tokio::join!(feed, out, err);
        child.wait().await
    };
    let status = tokio::time::timeout(call.timeout, turn)
        .await
        .map_err(|_| {
            format!(
                "Codex did not finish within {} seconds and was stopped.",
                call.timeout.as_secs()
            )
        })?;
    if let Some(said) = &transcript.failure {
        return Err(agent_failure(said));
    }
    let code = status.as_ref().ok().and_then(|status| status.code());
    if !(transcript.completed && code == Some(0)) {
        let said = transcript
            .last_error
            .clone()
            .unwrap_or_else(|| stderr_tail.iter().cloned().collect::<Vec<_>>().join(" "));
        let code = code.map_or_else(|| "none".to_owned(), |code| code.to_string());
        return Err(agent_failure(&format!(
            "the CLI stopped with exit code {code} before it was done. {said}"
        )));
    }
    Ok(AgentResult {
        thread: transcript.thread_id,
        text: transcript.last_message.unwrap_or_default(),
    })
}

fn agent_failure(said: &str) -> String {
    let short: String = said.chars().take(400).collect();
    match classify(said) {
        CodexErrorKind::NotLoggedIn => {
            format!("The Codex CLI is not signed in. Run `codex login`. The CLI said: {short}")
        }
        CodexErrorKind::Quota => {
            format!("The usage limit of the ChatGPT plan was reached. The CLI said: {short}")
        }
        _ => format!("Codex could not finish: {short}"),
    }
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

    #[test]
    fn codex_as_an_agent_writes_in_its_folder_with_a_shell_and_resumes() {
        let mut call = AgentCall {
            prompt: "x".into(),
            cwd: PathBuf::from("C:/w"),
            system_prompt_file: PathBuf::from("C:/s/system.md"),
            writes: true,
            resume: None,
            model: Some("gpt-5.5".into()),
            effort: Some("high".into()),
            timeout: Duration::from_secs(1),
        };
        let args = agent_args(&call);
        let at = |flag: &str| args.iter().position(|a| a == flag).expect(flag);
        assert_eq!(args[at("--sandbox") + 1], "workspace-write");
        assert_eq!(args[at("-C") + 1], "C:/w");
        assert!(!args.iter().any(|a| a.starts_with("features.shell_tool")));
        assert!(args.contains(&"model_instructions_file=\"C:/s/system.md\"".to_owned()));
        assert!(args.contains(&"model_reasoning_effort=\"high\"".to_owned()));
        assert_eq!(args[at("--model") + 1], "gpt-5.5");
        assert_eq!(args.last().map(String::as_str), Some("-"));
        assert!(!args.contains(&"resume".to_owned()));
        call.writes = false;
        call.resume = Some("01a1-thread".into());
        let args = agent_args(&call);
        assert!(args.contains(&"read-only".to_owned()));
        let resume = args.iter().position(|a| a == "resume").expect("resume");
        assert_eq!(args[resume + 1], "01a1-thread");
        assert_eq!(args[resume + 2], "-");
    }

    #[test]
    fn an_agents_path_leaves_out_the_store_apps() {
        let path = std::ffi::OsString::from(
            r"C:\Program Files\nodejs;C:\Users\a\AppData\Local\Microsoft\WindowsApps;C:\WINDOWS",
        );
        assert_eq!(
            agent_path(&path),
            Some(std::ffi::OsString::from(
                r"C:\Program Files\nodejs;C:\WINDOWS"
            ))
        );
    }

    #[test]
    fn codex_agent_activity_names_the_files_it_wrote() {
        let event = json!({"type": "item.completed", "item": {"type": "file_change",
            "changes": [{"path": "C:\\w\\en.html", "kind": "add"}, {"path": "C:\\w\\he.html"}]}});
        assert_eq!(
            agent_activity(&event),
            Some(("tool", "Write en.html, he.html".to_owned()))
        );
        let said =
            json!({"type": "item.completed", "item": {"type": "agent_message", "text": " Done. "}});
        assert_eq!(agent_activity(&said), Some(("text", "Done.".to_owned())));
        let started =
            json!({"type": "item.started", "item": {"type": "agent_message", "text": "x"}});
        assert_eq!(agent_activity(&started), None);
    }
}
