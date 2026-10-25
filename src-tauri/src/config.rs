//! Where things are, and what can be changed through the environment.
//!
//! A build of the repository (`pnpm tauri dev`) keeps its work in the repository's `.data` and
//! reads the media library's author copy beside the repository (`../Slidr-media`), as the studio
//! always has. The installed studio keeps its work in its own folder of the user's local
//! application data, and reads an author copy only where `SLIDR_MEDIA_DIR` names one.

use std::{
    env,
    path::{Path, PathBuf},
    sync::{Mutex, MutexGuard, PoisonError},
};

/// The Cloudflare account of the media library (docs/media-library.md). Not a secret.
const DEFAULT_ACCOUNT_ID: &str = "d3a1982ae102ceb45926da85e92d6edf";
const DEFAULT_MEDIA_URL: &str = "https://slidr-media.pages.dev/";
/// Slidr Library, whose upload API takes the studio's work (`uploads.rs`).
const DEFAULT_LIBRARY_URL: &str = "https://library.slidr.workers.dev/";

/// The repository the studio was built from, in a development build.
pub fn repository() -> Option<PathBuf> {
    cfg!(debug_assertions)
        .then(|| {
            Path::new(env!("CARGO_MANIFEST_DIR"))
                .parent()
                .map(Path::to_path_buf)
        })
        .flatten()
}

fn text(name: &str) -> Option<String> {
    env::var(name)
        .ok()
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
}

fn path(name: &str) -> Option<PathBuf> {
    text(name).map(|value| {
        let path = PathBuf::from(value);
        std::path::absolute(&path).unwrap_or(path)
    })
}

fn number(name: &str, default: usize) -> usize {
    text(name)
        .and_then(|value| value.parse().ok())
        .unwrap_or(default)
}

/// What the person may change while the studio runs: the library and the keys to it.
#[derive(Debug, Clone)]
pub struct Remote {
    /// The library whose API the approved work is uploaded to.
    pub library_url: String,
    /// The studio's key to it (the Worker's `LIBRARY_KEYS`, `studio=<key>`).
    pub library_key: Option<String>,
    pub cloudflare_account_id: String,
    /// Kept in memory only, unless it came from the environment.
    pub cloudflare_token: Option<String>,
}

pub struct Settings {
    /// Requests, variants, their files and logs. Never published.
    pub data: PathBuf,
    /// The author copy of the media library, which `pnpm media:publish` stages from.
    pub media_dir: Option<PathBuf>,
    pub media_url: String,
    /// The app's script that publishes the author copy, in a build of the repository.
    pub publish_script: Option<PathBuf>,
    /// Processes that may run at once. Four Codex images at a time is what the app measured
    /// (ADR-004).
    pub max_claude: usize,
    pub max_codex: usize,
    pub max_render: usize,
    /// Where the read-only answers for Slidr Library are served (`local_server.rs`).
    pub host: String,
    pub port: u16,
    /// Render windows shown, and left open, to see what the render page does.
    pub show_render: bool,
    remote: Mutex<Remote>,
}

impl Settings {
    /// The settings of the environment, over `data` and `media_dir` where it names none.
    pub fn new(data: PathBuf, media_dir: Option<PathBuf>, library_key: Option<String>) -> Self {
        let repository = repository();
        Self {
            data: path("SLIDR_STUDIO_DATA").unwrap_or(data),
            media_dir: path("SLIDR_MEDIA_DIR").or(media_dir),
            media_url: text("SLIDR_MEDIA_URL").unwrap_or_else(|| DEFAULT_MEDIA_URL.into()),
            publish_script: repository
                .map(|repo| repo.join("vendor/desktop/scripts/media-publish.mjs"))
                .filter(|script| script.is_file()),
            max_claude: number("SLIDR_STUDIO_MAX_CLAUDE", 4).max(1),
            max_codex: number("SLIDR_STUDIO_MAX_CODEX", 4).max(1),
            max_render: number("SLIDR_STUDIO_MAX_RENDER", 2).max(1),
            host: text("SLIDR_STUDIO_HOST").unwrap_or_else(|| "127.0.0.1".into()),
            port: text("SLIDR_STUDIO_PORT")
                .and_then(|port| port.parse().ok())
                .unwrap_or(8765),
            show_render: text("SLIDR_STUDIO_SHOW_RENDER").is_some(),
            remote: Mutex::new(Remote {
                library_url: text("SLIDR_LIBRARY_URL")
                    .unwrap_or_else(|| DEFAULT_LIBRARY_URL.into()),
                library_key: text("SLIDR_LIBRARY_KEY").or(library_key),
                cloudflare_account_id: text("CLOUDFLARE_ACCOUNT_ID")
                    .unwrap_or_else(|| DEFAULT_ACCOUNT_ID.into()),
                cloudflare_token: text("CLOUDFLARE_API_TOKEN"),
            }),
        }
    }

    pub fn requests_dir(&self) -> PathBuf {
        self.data.join("requests")
    }

    pub fn remote(&self) -> MutexGuard<'_, Remote> {
        self.remote.lock().unwrap_or_else(PoisonError::into_inner)
    }
}
