//! Converting and rendering a variant with the app's own engine, in a window of the studio's that is
//! never shown.
//!
//! A render opens `render.html` in a hidden window of its own, at 1920×1080 CSS px and one device
//! pixel per CSS pixel whatever the display's scale (the DevTools protocol's
//! `Emulation.setDeviceMetricsOverride`). The page converts the HTML file of every language of a
//! design with `@slidr/html-import` (or builds a template's sample with `@slidr/templates`),
//! renders the slides with `@slidr/renderer`, runs the app's design check (`@slidr/lint`) and the
//! contract, and draws every view it made; Rust then takes a picture of each with
//! `Page.captureScreenshot`, as the app's capture window does (ADR-003):
//!
//! ```text
//! work/renders/r<n>/<lang>-full.png    1920×1080 (he-full.png, en-full.png, ar-full.png…)
//! work/renders/r<n>/<lang>-thumb.png   384 px wide, as the gallery shows a design
//! work/renders/r<n>/<lang>-gallery.png 320×180, the picture made ahead that is published with it
//! work/renders/r<n>/result.json        the slides, findings, conversion notes, subject point
//! ```
//!
//! ```text
//! snap ──► the window "render-<n>", window.__studioRender = { vid, revision }
//!   page: render_input(vid)        ──►  the metrics set, the variant's files   ◄── Rust
//!   page: capture_clip(rect) …     ──►  a picture of the page for the engine's fidelity guard
//!   page: render_done(result, views, or error)
//!   Rust: a picture of each view, result.json; the window closes
//! ```
//!
//! Each revision has a folder of its own: on Windows a folder that something holds open (an
//! Explorer window, a file being read) cannot be emptied and written again. The last few are kept.

#[cfg(windows)]
#[allow(unsafe_code)]
// The COM call into WebView2; `jobs.rs` is the other place that takes `unsafe`.
mod webview2;

use std::{
    collections::HashMap,
    fs,
    future::Future,
    path::{Path, PathBuf},
    pin::Pin,
    sync::{
        Mutex, MutexGuard, PoisonError,
        atomic::{AtomicU64, Ordering},
    },
    time::Duration,
};

use serde::Deserialize;
use serde_json::{Value, json};
use tauri::{
    AppHandle, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder, Window, WindowEvent,
};
use tokio::sync::oneshot;

/// The labels of the render windows start with this; only they may report a render.
pub const PREFIX: &str = "render-";
/// The studio's own window: when it goes, the hidden render windows must not keep it running.
const MAIN_LABEL: &str = "main";
/// A render answers within this, or fails.
const TIMEOUT: Duration = Duration::from_secs(240);
/// One DevTools call. A full-size picture of a long page takes its time.
const DEVTOOLS_TIMEOUT: Duration = Duration::from_secs(30);
/// Revisions whose renders are kept.
const KEEP: u32 = 3;
/// The longest side of a picture, in CSS px.
const MAX_SIDE: f64 = 16384.0;

pub fn render_dir(work: &Path, revision: u32) -> PathBuf {
    work.join("renders").join(format!("r{revision}"))
}

/// Takes away the renders of revisions older than the last few.
pub fn forget_old(work: &Path, revision: u32) {
    let Ok(entries) = fs::read_dir(work.join("renders")) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if let Some(number) = name.strip_prefix('r').and_then(|n| n.parse::<u32>().ok())
            && number + KEEP <= revision
        {
            let _ = fs::remove_dir_all(entry.path());
        }
    }
}

/// A rectangle of a page, in CSS px of the page.
#[derive(Debug, Clone, Copy, Deserialize)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

impl Rect {
    fn validate(&self) -> Result<(), String> {
        let sides = [self.width, self.height];
        let corner = [self.x, self.y];
        if sides.iter().all(|s| (1.0..=MAX_SIDE).contains(s))
            && corner.iter().all(|c| (0.0..=MAX_SIDE * 4.0).contains(c))
        {
            Ok(())
        } else {
            Err(format!("{self:?} is not a rectangle of the page"))
        }
    }
}

/// A view the page drew: `he-full`, `s01-thumb`, `sheet`.
#[derive(Debug, Deserialize)]
pub struct View {
    pub name: String,
    #[serde(flatten)]
    pub rect: Rect,
}

/// What the page reports when it is done.
#[derive(Debug, Deserialize)]
pub struct Done {
    pub result: Option<Value>,
    pub error: Option<String>,
    #[serde(default)]
    pub views: Vec<View>,
}

/// A view's name becomes a file name: letters, digits and hyphens only.
fn plain_name(name: &str) -> bool {
    (1..=40).contains(&name.len()) && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
}

/// `Page.captureScreenshot` of a rectangle of the page as it is, one pixel per CSS pixel, also
/// where the page is larger than its window.
fn clip_params(rect: Rect, device_pixel_ratio: f64) -> Value {
    let scale = if device_pixel_ratio.is_finite() && device_pixel_ratio > 0.0 {
        1.0 / device_pixel_ratio
    } else {
        1.0
    };
    json!({
        "format": "png",
        "fromSurface": true,
        "captureBeyondViewport": true,
        "clip": {"x": rect.x, "y": rect.y, "width": rect.width, "height": rect.height, "scale": scale},
    })
}

/// A PNG of a rectangle of a window's page.
#[cfg(windows)]
pub async fn picture(
    window: &WebviewWindow,
    rect: Rect,
    device_pixel_ratio: f64,
) -> Result<Vec<u8>, String> {
    rect.validate()?;
    let result = webview2::call(
        window,
        "Page.captureScreenshot",
        &clip_params(rect, device_pixel_ratio),
        DEVTOOLS_TIMEOUT,
    )
    .await?;
    let data = result["data"]
        .as_str()
        .ok_or("the screenshot has no data")?;
    webview2::decode_png(data)
}

#[cfg(not(windows))]
pub async fn picture(_window: &WebviewWindow, rect: Rect, _dpr: f64) -> Result<Vec<u8>, String> {
    let _ = (rect.validate(), clip_params(rect, 1.0));
    Err("A render takes its pictures through WebView2, on Windows only.".into())
}

/// The page laid out at 1920×1080 CSS px, one device pixel each, as the headless browser the
/// studio used before laid it out.
#[cfg(windows)]
async fn fix_metrics(window: &WebviewWindow) -> Result<(), String> {
    let metrics = json!({"width": 1920, "height": 1080, "deviceScaleFactor": 1, "mobile": false});
    webview2::call(
        window,
        "Emulation.setDeviceMetricsOverride",
        &metrics,
        DEVTOOLS_TIMEOUT,
    )
    .await
    .map(drop)
}

#[cfg(not(windows))]
async fn fix_metrics(_window: &WebviewWindow) -> Result<(), String> {
    Ok(())
}

struct Waiting {
    vid: String,
    done: Option<oneshot::Sender<Done>>,
}

/// The render windows, and the renders that wait for their pages.
pub struct Renders {
    app: AppHandle,
    /// Render windows shown, and left open, to see what the page does.
    show: bool,
    next: AtomicU64,
    waiting: Mutex<HashMap<String, Waiting>>,
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

impl Renders {
    pub fn new(app: AppHandle, show: bool) -> Self {
        Self {
            app,
            show,
            next: AtomicU64::new(1),
            waiting: Mutex::new(HashMap::new()),
        }
    }

    /// Renders revision `revision` of a variant into `out`; the page's result.
    pub async fn draw(&self, vid: &str, revision: u32, out: &Path) -> Result<Value, String> {
        let _ = fs::remove_dir_all(out);
        fs::create_dir_all(out).map_err(|e| format!("{}: {e}", out.display()))?;
        let label = format!("{PREFIX}{}", self.next.fetch_add(1, Ordering::Relaxed));
        let (sender, receiver) = oneshot::channel();
        lock(&self.waiting).insert(
            label.clone(),
            Waiting {
                vid: vid.to_owned(),
                done: Some(sender),
            },
        );
        let job = json!({"vid": vid, "revision": revision});
        let built =
            WebviewWindowBuilder::new(&self.app, &label, WebviewUrl::App("render.html".into()))
                .title(format!("Slidr Studio · render {vid} r{revision}"))
                .visible(self.show)
                .focused(false)
                .skip_taskbar(!self.show)
                .inner_size(1920.0, 1080.0)
                .initialization_script(format!("window.__studioRender = {job};"))
                .build();
        let window = match built {
            Ok(window) => window,
            Err(error) => {
                lock(&self.waiting).remove(&label);
                return Err(format!("The render window could not open: {error}"));
            }
        };
        let answer = tokio::time::timeout(TIMEOUT, receiver).await;
        lock(&self.waiting).remove(&label);
        let outcome = match answer {
            Ok(Ok(done)) => self.keep(&window, done, out).await,
            Ok(Err(_)) => Err("The render page went away before it was done.".into()),
            Err(_) => Err(format!(
                "The render did not finish within {} seconds.",
                TIMEOUT.as_secs()
            )),
        };
        if !self.show {
            let _ = window.destroy();
        }
        outcome
    }

    /// The pictures of every view the page drew, and its result, in `out`.
    async fn keep(&self, window: &WebviewWindow, done: Done, out: &Path) -> Result<Value, String> {
        if let Some(error) = done.error {
            let tail: String = {
                let chars: Vec<char> = error.trim().chars().collect();
                chars[chars.len().saturating_sub(1200)..].iter().collect()
            };
            return Err(format!("The render failed: {tail}"));
        }
        let result = done
            .result
            .ok_or("The render failed: the page gave no result.")?;
        for view in &done.views {
            if !plain_name(&view.name) {
                return Err(format!("The render page named a view {:?}.", view.name));
            }
            let png = picture(window, view.rect, 1.0)
                .await
                .map_err(|e| format!("The picture of {} could not be taken: {e}", view.name))?;
            fs::write(out.join(format!("{}.png", view.name)), png).map_err(|e| e.to_string())?;
        }
        fs::write(
            out.join("result.json"),
            serde_json::to_vec(&result).unwrap_or_default(),
        )
        .map_err(|e| e.to_string())?;
        Ok(result)
    }

    /// The variant a render window's page is rendering; refused to any other window.
    fn variant_of(&self, label: &str) -> Result<String, String> {
        lock(&self.waiting)
            .get(label)
            .map(|waiting| waiting.vid.clone())
            .ok_or_else(|| format!("{label} is not rendering anything"))
    }

    /// Sets the page's metrics and says which variant it renders: the first thing the page asks.
    pub async fn begin(&self, window: &WebviewWindow) -> Result<String, String> {
        let vid = self.variant_of(window.label())?;
        fix_metrics(window).await?;
        Ok(vid)
    }

    /// The page's answer. One for a render that already timed out is dropped.
    pub fn done(&self, label: &str, done: Done) -> Result<(), String> {
        let sender = lock(&self.waiting)
            .get_mut(label)
            .and_then(|waiting| waiting.done.take())
            .ok_or_else(|| format!("{label} is not rendering anything"))?;
        let _ = sender.send(done);
        Ok(())
    }
}

impl crate::pipeline::Renderer for Renders {
    fn snap<'a>(
        &'a self,
        vid: &'a str,
        revision: u32,
        out: &'a Path,
    ) -> Pin<Box<dyn Future<Output = Result<Value, String>> + Send + 'a>> {
        Box::pin(self.draw(vid, revision, out))
    }
}

pub fn is_render_window(label: &str) -> bool {
    label.starts_with(PREFIX)
}

/// Closes the render windows with the studio's own; a hidden window would keep it running.
pub fn on_window_event(window: &Window, event: &WindowEvent) {
    if window.label() == MAIN_LABEL && matches!(event, WindowEvent::Destroyed) {
        for (label, other) in window.app_handle().webview_windows() {
            if is_render_window(&label) {
                let _ = other.destroy();
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn old_renders_go_and_the_last_three_stay() {
        let dir = tempfile::tempdir().expect("a folder");
        for revision in 1..=5 {
            fs::create_dir_all(render_dir(dir.path(), revision)).expect("a folder");
        }
        forget_old(dir.path(), 5);
        let left: Vec<bool> = (1..=5)
            .map(|r| render_dir(dir.path(), r).exists())
            .collect();
        assert_eq!(left, [false, false, true, true, true]);
    }

    #[test]
    fn a_view_is_named_as_a_file_may_be() {
        assert!(plain_name("he-full") && plain_name("s01-thumb") && plain_name("zh-CN-full"));
        assert!(!plain_name("../x") && !plain_name("a b") && !plain_name(""));
        assert!(
            Rect {
                x: 0.0,
                y: 2200.0,
                width: 1920.0,
                height: 1080.0
            }
            .validate()
            .is_ok()
        );
        assert!(
            Rect {
                x: 0.0,
                y: 0.0,
                width: 0.0,
                height: 10.0
            }
            .validate()
            .is_err()
        );
    }
}
