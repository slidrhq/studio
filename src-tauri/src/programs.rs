//! Finding the programs the studio runs: Claude Code and the Codex CLI (and Node, for the script
//! that publishes the author copy).
//!
//! Searched as the app searches (`src-tauri/src/harness/setup.rs`): the PATH, then the places
//! installers put programs without adding them to it. The Codex CLI is also found inside the
//! ChatGPT extension of VS Code, which ships the same native program. `CLAUDE_PATH`, `CODEX_PATH`
//! and `NODE_PATH_EXE` name a program outright.

use std::{
    env,
    ffi::OsStr,
    fs, io,
    path::{Path, PathBuf},
    process::Stdio,
    time::{Duration, SystemTime},
};

use serde::Serialize;
use tokio::process::{Child, Command};

const WINDOWS: bool = cfg!(windows);

/// A program the studio starts: without a console window, ended with the studio, and stopped
/// when the work that started it is.
pub fn command(program: impl AsRef<OsStr>) -> Command {
    let mut command = Command::new(program);
    #[cfg(windows)]
    {
        /// Windows: start a program without a console window.
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    command.kill_on_drop(true);
    command
}

/// Starts `command` and ties the process to the studio, so it ends when the studio does
/// (`jobs.rs`).
pub fn spawn(command: &mut Command) -> io::Result<Child> {
    let child = command.spawn()?;
    #[cfg(windows)]
    crate::jobs::adopt(&child);
    Ok(child)
}

fn home() -> Option<PathBuf> {
    env::var_os("USERPROFILE")
        .or_else(|| env::var_os("HOME"))
        .map(PathBuf::from)
}

pub fn search_paths() -> Vec<PathBuf> {
    let mut paths: Vec<PathBuf> = env::var_os("PATH")
        .map(|path| {
            env::split_paths(&path)
                .filter(|p| !p.as_os_str().is_empty())
                .collect()
        })
        .unwrap_or_default();
    if let Some(home) = home() {
        paths.push(home.join(".local").join("bin"));
    }
    if let Some(local) = env::var_os("LOCALAPPDATA") {
        paths.push(
            PathBuf::from(local)
                .join("Microsoft")
                .join("WinGet")
                .join("Links"),
        );
    }
    if let Some(programs) = env::var_os("ProgramFiles") {
        paths.push(PathBuf::from(programs).join("WinGet").join("Links"));
    }
    if let Some(roaming) = env::var_os("APPDATA") {
        paths.push(PathBuf::from(roaming).join("npm"));
    }
    paths
}

fn exe(name: &str) -> String {
    if WINDOWS {
        format!("{name}.exe")
    } else {
        name.to_owned()
    }
}

/// A program on the PATH, with the extensions Windows runs (`PATHEXT`).
pub fn which(name: &str) -> Option<PathBuf> {
    let extensions: Vec<String> = if WINDOWS {
        env::var("PATHEXT")
            .unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".into())
            .split(';')
            .filter(|ext| !ext.is_empty())
            .map(str::to_owned)
            .collect()
    } else {
        vec![String::new()]
    };
    let path = env::var_os("PATH")?;
    env::split_paths(&path).find_map(|dir| {
        extensions
            .iter()
            .map(|ext| dir.join(format!("{name}{ext}")))
            .find(|candidate| candidate.is_file())
    })
}

fn named(variable: &str) -> Option<PathBuf> {
    env::var_os(variable)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
}

pub fn find_claude() -> Option<PathBuf> {
    if let Some(named) = named("CLAUDE_PATH") {
        return Some(named);
    }
    search_paths()
        .into_iter()
        .map(|dir| dir.join(exe("claude")))
        .find(|candidate| candidate.is_file())
        .or_else(|| which("claude"))
}

/// The npm package, the triple of its native program, and the folder of the VS Code extension's.
fn codex_target() -> Option<(&'static str, &'static str, &'static str)> {
    let os = env::consts::OS;
    let arch = env::consts::ARCH;
    Some(match (os, arch) {
        ("windows", "x86_64") => (
            "codex-win32-x64",
            "x86_64-pc-windows-msvc",
            "windows-x86_64",
        ),
        ("windows", "aarch64") => (
            "codex-win32-arm64",
            "aarch64-pc-windows-msvc",
            "windows-aarch64",
        ),
        ("macos", "x86_64") => ("codex-darwin-x64", "x86_64-apple-darwin", "macos-x86_64"),
        ("macos", "aarch64") => (
            "codex-darwin-arm64",
            "aarch64-apple-darwin",
            "macos-aarch64",
        ),
        ("linux", "x86_64") => (
            "codex-linux-x64",
            "x86_64-unknown-linux-musl",
            "linux-x86_64",
        ),
        ("linux", "aarch64") => (
            "codex-linux-arm64",
            "aarch64-unknown-linux-musl",
            "linux-aarch64",
        ),
        _ => return None,
    })
}

/// The native program behind npm's shim, looked up as the package's own codex.js does.
fn native_from_package(package: &Path, target: (&str, &str, &str)) -> Option<PathBuf> {
    let (platform_package, triple, _) = target;
    let program = Path::new("vendor")
        .join(triple)
        .join("bin")
        .join(exe("codex"));
    let mut places = vec![package.to_path_buf()];
    places.extend(package.ancestors().skip(1).take(3).map(Path::to_path_buf));
    for dir in places {
        let candidate = dir
            .join("node_modules")
            .join("@openai")
            .join(platform_package)
            .join(&program);
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    let candidate = package.join(&program);
    candidate.is_file().then_some(candidate)
}

/// The native Codex program. npm's `codex.cmd` is never started: cmd.exe's quoting would stand
/// between the studio and a free-text prompt, and ending it would leave codex running.
pub fn find_codex() -> Option<PathBuf> {
    if let Some(named) = named("CODEX_PATH") {
        return Some(named);
    }
    let target = codex_target();
    for dir in search_paths() {
        let native = dir.join(exe("codex"));
        if native.is_file() {
            return Some(native);
        }
        let shim = dir.join(if WINDOWS { "codex.cmd" } else { "codex" });
        if let Some(target) = target
            && shim.is_file()
            && let Some(found) = native_from_package(
                &dir.join("node_modules").join("@openai").join("codex"),
                target,
            )
        {
            return Some(found);
        }
    }
    // The ChatGPT extension of VS Code carries the CLI: the newest installed version.
    let (home, target) = (home()?, target?);
    let extensions = home.join(".vscode").join("extensions");
    let entries = fs::read_dir(extensions).ok()?;
    entries
        .flatten()
        .filter(|entry| {
            entry
                .file_name()
                .to_string_lossy()
                .starts_with("openai.chatgpt-")
        })
        .map(|entry| entry.path().join("bin").join(target.2).join(exe("codex")))
        .filter(|candidate| candidate.is_file())
        .max_by_key(|candidate| {
            fs::metadata(candidate)
                .and_then(|meta| meta.modified())
                .unwrap_or(SystemTime::UNIX_EPOCH)
        })
}

pub fn find_node() -> Option<PathBuf> {
    named("NODE_PATH_EXE").or_else(|| which("node"))
}

/// What is installed and signed in, for the studio's status line.
#[derive(Debug, Clone, Serialize)]
pub struct ProgramStatus {
    pub name: &'static str,
    pub path: Option<String>,
    pub version: Option<String>,
    pub ready: bool,
    pub note: Option<String>,
}

/// A program's exit code and what it printed; -1 when it did not answer in time.
async fn output(program: &Path, args: &[&str]) -> (i32, String) {
    let mut command = command(program);
    command
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let Ok(child) = spawn(&mut command) else {
        return (-1, "it could not be started".into());
    };
    match tokio::time::timeout(Duration::from_secs(20), child.wait_with_output()).await {
        Ok(Ok(out)) => {
            let mut said = String::from_utf8_lossy(&out.stdout).into_owned();
            said.push_str(&String::from_utf8_lossy(&out.stderr));
            (out.status.code().unwrap_or(-1), said.trim().to_owned())
        }
        Ok(Err(error)) => (-1, error.to_string()),
        Err(_) => (-1, "no answer in time".into()),
    }
}

fn first_chars(text: &str, count: usize) -> String {
    text.chars().take(count).collect()
}

pub async fn probe() -> Vec<ProgramStatus> {
    let mut statuses = Vec::new();

    match find_claude() {
        Some(claude) => {
            let (code, said) = output(&claude, &["--version"]).await;
            statuses.push(ProgramStatus {
                name: "claude",
                path: Some(claude.display().to_string()),
                version: (code == 0).then(|| said.clone()),
                ready: code == 0,
                note: (code != 0).then(|| first_chars(&said, 300)),
            });
        }
        None => statuses.push(ProgramStatus {
            name: "claude",
            path: None,
            version: None,
            ready: false,
            note: Some(
                "Claude Code was not found. Install it and run `claude` once to sign in.".into(),
            ),
        }),
    }

    match find_codex() {
        Some(codex) => {
            let (code, said) = output(&codex, &["--version"]).await;
            let (login_code, login) = output(&codex, &["login", "status"]).await;
            let signed_in = login_code == 0 && login.to_lowercase().contains("logged in");
            let note = if login.is_empty() {
                "Run `codex login` and sign in with ChatGPT.".to_owned()
            } else {
                login
            };
            statuses.push(ProgramStatus {
                name: "codex",
                path: Some(codex.display().to_string()),
                version: (code == 0).then_some(said),
                ready: code == 0 && signed_in,
                note: (!signed_in).then(|| first_chars(&note, 300)),
            });
        }
        None => statuses.push(ProgramStatus {
            name: "codex",
            path: None,
            version: None,
            ready: false,
            note: Some(
                "The Codex CLI was not found. Install it (`npm install -g @openai/codex`) and run \
                 `codex login`."
                    .into(),
            ),
        }),
    }
    statuses
}
