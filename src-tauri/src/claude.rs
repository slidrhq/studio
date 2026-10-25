//! One `claude -p` turn, with stream-json out, on the user's Claude Code sign-in.
//!
//! ```text
//! claude -p --output-format stream-json --verbose --restricted --strict-mcp-config
//!        --disable-slash-commands --tools <list> --allowedTools <list> --permission-mode dontAsk
//!        --system-prompt-file <file> (--session-id <uuid> | --resume <uuid>)
//!        [--model m] [--effort e] [--json-schema s]
//! stdin: the prompt, then closed       cwd: the job's folder (the only one its file tools reach)
//! ```
//!
//! The CLI keeps a conversation under `~/.claude/projects/<cwd>/`, so a session resumes only from
//! the folder it started in: each variant has its own folder and keeps it.

use std::{
    collections::VecDeque,
    path::{Path, PathBuf},
    process::Stdio,
    time::Duration,
};

use serde_json::Value;
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncWriteExt, BufReader};

use crate::programs;

/// The lines of stderr kept to say why a turn failed.
const STDERR_LINES: usize = 20;

pub struct ClaudeCall {
    pub prompt: String,
    pub cwd: PathBuf,
    pub system_prompt_file: PathBuf,
    pub tools: Vec<&'static str>,
    /// A new conversation under this id, or the one to continue.
    pub session_id: Option<String>,
    pub resume: Option<String>,
    pub model: Option<String>,
    pub effort: Option<String>,
    pub json_schema: Option<Value>,
    pub timeout: Duration,
}

impl ClaudeCall {
    pub fn new(prompt: String, cwd: PathBuf, system_prompt_file: PathBuf) -> Self {
        Self {
            prompt,
            cwd,
            system_prompt_file,
            tools: Vec::new(),
            session_id: None,
            resume: None,
            model: None,
            effort: None,
            json_schema: None,
            timeout: Duration::from_secs(30 * 60),
        }
    }
}

#[derive(Debug)]
pub struct ClaudeResult {
    pub session_id: Option<String>,
    pub text: String,
    /// The structured output a call with a JSON schema asked for; `Null` without one.
    pub structured: Value,
    pub cost: f64,
}

pub fn build_args(call: &ClaudeCall) -> Vec<String> {
    let mut args: Vec<String> = [
        "-p",
        "--output-format",
        "stream-json",
        "--verbose",
        "--restricted",
        "--strict-mcp-config",
        "--disable-slash-commands",
        "--tools",
    ]
    .map(str::to_owned)
    .to_vec();
    args.push(call.tools.join(","));
    if !call.tools.is_empty() {
        args.push("--allowedTools".into());
        args.extend(call.tools.iter().map(|tool| (*tool).to_owned()));
    }
    args.extend(["--permission-mode".into(), "dontAsk".into()]);
    args.push("--system-prompt-file".into());
    args.push(call.system_prompt_file.display().to_string());
    if let Some(resume) = &call.resume {
        args.extend(["--resume".into(), resume.clone()]);
    } else if let Some(session) = &call.session_id {
        args.extend(["--session-id".into(), session.clone()]);
    }
    if let Some(model) = &call.model {
        args.extend(["--model".into(), model.clone()]);
    }
    if let Some(effort) = &call.effort {
        args.extend(["--effort".into(), effort.clone()]);
    }
    if let Some(schema) = &call.json_schema {
        args.extend(["--json-schema".into(), schema.to_string()]);
    }
    args
}

/// A tool call in a few words, for the activity log.
pub fn describe_tool(name: &str, input: &Value) -> String {
    let path = ["file_path", "path", "pattern"]
        .iter()
        .find_map(|key| input.get(key).and_then(Value::as_str));
    match path {
        Some(path) => {
            let file = Path::new(path).file_name().map_or_else(
                || path.to_owned(),
                |name| name.to_string_lossy().into_owned(),
            );
            format!("{name} {file}")
        }
        None => name.to_owned(),
    }
}

fn first_chars(text: &str, count: usize) -> String {
    text.chars().take(count).collect()
}

/// What the stream-json lines of a turn said.
pub struct Transcript<F: FnMut(&str, &str)> {
    pub session_id: Option<String>,
    pub result: Option<Value>,
    on_activity: F,
}

impl<F: FnMut(&str, &str)> Transcript<F> {
    pub fn new(on_activity: F) -> Self {
        Self {
            session_id: None,
            result: None,
            on_activity,
        }
    }

    pub fn read(&mut self, line: &str) {
        let Ok(event) = serde_json::from_str::<Value>(line) else {
            return;
        };
        let session = || {
            event
                .get("session_id")
                .and_then(Value::as_str)
                .map(str::to_owned)
        };
        match event.get("type").and_then(Value::as_str) {
            Some("system") if event.get("subtype").and_then(Value::as_str) == Some("init") => {
                self.session_id = session().or(self.session_id.take());
            }
            Some("assistant") => {
                let parts = event
                    .pointer("/message/content")
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default();
                for part in parts {
                    match part.get("type").and_then(Value::as_str) {
                        Some("tool_use") => {
                            let name = part.get("name").and_then(Value::as_str).unwrap_or("?");
                            if name != "StructuredOutput" {
                                let input = part.get("input").cloned().unwrap_or(Value::Null);
                                (self.on_activity)("tool", &describe_tool(name, &input));
                            }
                        }
                        Some("text") => {
                            let text = part
                                .get("text")
                                .and_then(Value::as_str)
                                .unwrap_or("")
                                .trim();
                            if !text.is_empty() {
                                (self.on_activity)("text", &first_chars(text, 600));
                            }
                        }
                        _ => {}
                    }
                }
            }
            Some("result") => {
                self.session_id = session().or(self.session_id.take());
                self.result = Some(event);
            }
            _ => {}
        }
    }
}

/// Every line of a stream, however long: a line of stream-json can hold a whole file the agent
/// read, or a picture as base64.
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

/// Runs one turn. `on_activity` hears each tool call and each passage of text as it comes.
pub async fn run(
    call: ClaudeCall,
    on_activity: impl FnMut(&str, &str) + Send,
) -> Result<ClaudeResult, String> {
    let program = programs::find_claude().ok_or(
        "Claude Code was not found. Install it and run `claude` once to sign in.".to_owned(),
    )?;
    std::fs::create_dir_all(&call.cwd).map_err(|e| format!("{}: {e}", call.cwd.display()))?;
    let mut command = programs::command(&program);
    command
        .args(build_args(&call))
        .current_dir(&call.cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    // Calls that wait on nothing but the model; a long one is not a hung one.
    if std::env::var_os("BASH_DEFAULT_TIMEOUT_MS").is_none() {
        command.env("BASH_DEFAULT_TIMEOUT_MS", "600000");
    }
    let mut child =
        programs::spawn(&mut command).map_err(|e| format!("Claude Code could not start: {e}"))?;
    let (Some(mut stdin), Some(stdout), Some(stderr)) =
        (child.stdin.take(), child.stdout.take(), child.stderr.take())
    else {
        return Err("Claude Code started without its pipes.".into());
    };

    let mut transcript = Transcript::new(on_activity);
    let mut stderr_tail = VecDeque::with_capacity(STDERR_LINES);
    let prompt = call.prompt.into_bytes();
    let turn = async {
        let feed = async {
            // A CLI that stops reading is a failure the transcript reports.
            let _ = stdin.write_all(&prompt).await;
            let _ = stdin.shutdown().await;
            drop(stdin);
        };
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
        tokio::join!(feed, out, err);
        child.wait().await
    };
    let status = match tokio::time::timeout(call.timeout, turn).await {
        Ok(status) => status.ok(),
        Err(_) => {
            return Err(format!(
                "Claude did not finish within {} seconds and was stopped.",
                call.timeout.as_secs()
            ));
        }
    };

    let Some(result) = transcript.result else {
        let tail: Vec<String> = stderr_tail.into_iter().collect();
        let said = if tail.is_empty() {
            "no result".to_owned()
        } else {
            tail.join(" ")
        };
        let code = status
            .and_then(|status| status.code())
            .map_or_else(|| "none".to_owned(), |code| code.to_string());
        return Err(format!(
            "Claude stopped (exit code {code}) before it was done: {}",
            first_chars(&said, 600)
        ));
    };
    let failed = result
        .get("is_error")
        .and_then(Value::as_bool)
        .unwrap_or(false)
        || result.get("subtype").and_then(Value::as_str) != Some("success");
    if failed {
        let said = [result.get("result"), result.get("subtype")]
            .into_iter()
            .flatten()
            .find_map(|value| match value {
                Value::String(text) if !text.is_empty() => Some(text.clone()),
                Value::Null => None,
                other if !other.is_string() => Some(other.to_string()),
                _ => None,
            })
            .unwrap_or_else(|| "an error".into());
        return Err(format!(
            "Claude could not finish: {}",
            first_chars(&said, 600)
        ));
    }
    Ok(ClaudeResult {
        session_id: transcript.session_id,
        text: match result.get("result") {
            Some(Value::String(text)) => text.clone(),
            Some(Value::Null) | None => String::new(),
            Some(other) => other.to_string(),
        },
        structured: result
            .get("structured_output")
            .cloned()
            .unwrap_or(Value::Null),
        cost: result
            .get("total_cost_usd")
            .and_then(Value::as_f64)
            .unwrap_or(0.0),
    })
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn position(args: &[String], flag: &str) -> usize {
        args.iter().position(|arg| arg == flag).expect(flag)
    }

    #[test]
    fn claude_command_line_names_tools_and_session() {
        let mut call = ClaudeCall::new("x".into(), ".".into(), "system.md".into());
        call.tools = vec!["Read", "Write"];
        call.session_id = Some("abc".into());
        call.model = Some("opus".into());
        call.json_schema = Some(json!({"type": "object"}));
        let args = build_args(&call);
        assert_eq!(args[..3], ["-p", "--output-format", "stream-json"]);
        assert!(
            args.contains(&"--restricted".into()) && args.contains(&"--strict-mcp-config".into())
        );
        assert_eq!(args[position(&args, "--tools") + 1], "Read,Write");
        let allowed = position(&args, "--allowedTools");
        assert_eq!(args[allowed + 1..allowed + 3], ["Read", "Write"]);
        assert_eq!(args[position(&args, "--session-id") + 1], "abc");
        assert!(!args.contains(&"--resume".into()));
        let schema: Value =
            serde_json::from_str(&args[position(&args, "--json-schema") + 1]).expect("JSON");
        assert_eq!(schema, json!({"type": "object"}));
    }

    #[test]
    fn claude_resume_and_no_tools() {
        let mut call = ClaudeCall::new("x".into(), ".".into(), "s.md".into());
        call.resume = Some("abc".into());
        let args = build_args(&call);
        assert_eq!(args[position(&args, "--tools") + 1], "");
        assert!(!args.contains(&"--allowedTools".into()));
        assert_eq!(args[position(&args, "--resume") + 1], "abc");
    }

    #[test]
    fn claude_transcript_reads_the_stream() {
        let mut seen: Vec<(String, String)> = Vec::new();
        let mut transcript =
            Transcript::new(|kind: &str, text: &str| seen.push((kind.into(), text.into())));
        let lines = [
            json!({"type": "system", "subtype": "init", "session_id": "s1"}),
            json!({"type": "assistant", "message": {"content": [
                {"type": "tool_use", "name": "Write", "input": {"file_path": "C:\\w\\he.html"}},
                {"type": "text", "text": "  Wrote both files. "},
            ]}}),
            json!({"type": "assistant", "message": {"content": [
                {"type": "tool_use", "name": "StructuredOutput", "input": {}}
            ]}}),
            json!({"type": "result", "subtype": "success", "result": "done", "session_id": "s1",
                   "structured_output": {"a": 1}}),
        ];
        for line in lines {
            transcript.read(&line.to_string());
        }
        transcript.read("not json");
        assert_eq!(transcript.session_id.as_deref(), Some("s1"));
        assert_eq!(
            transcript
                .result
                .as_ref()
                .and_then(|r| r.get("structured_output")),
            Some(&json!({"a": 1}))
        );
        drop(transcript);
        assert_eq!(
            seen,
            [
                ("tool".to_owned(), "Write he.html".to_owned()),
                ("text".to_owned(), "Wrote both files.".to_owned())
            ]
        );
    }
}
