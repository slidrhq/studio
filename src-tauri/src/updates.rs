//! Updates of the studio itself, as the app updates (`src-tauri/src/updates.rs` of the app): looked
//! for when the studio starts, downloaded while it runs, installed when it closes.
//!
//! The release says where the next one is (`plugins.updater` in `tauri.conf.json`: the
//! `latest.json` of the newest GitHub release), and every installer it names is signed with the
//! key whose public half is there; one that is not is refused. Nothing is asked of the user and
//! nothing interrupts the work: the installer runs quietly once the window has closed, and the next
//! start is the new version. A failure on the way (no network, no release, a bad signature) leaves
//! the studio as it is, and the next start tries again.
//!
//! Only the real studio looks: not a debug build, and not a build under another identifier, so a
//! development copy never reaches the network or replaces itself.

use std::sync::Mutex;

use tauri::{AppHandle, Manager, Runtime};
use tauri_plugin_updater::{Update, UpdaterExt};

/// The identifier of the studio that is released.
const RELEASED: &str = "slidr.studio";

/// An update downloaded and waiting for the studio to close.
#[derive(Default)]
pub struct Pending(Mutex<Option<(Update, Vec<u8>)>>);

/// Whether this build looks for updates at all.
pub fn enabled<R: Runtime>(app: &AppHandle<R>) -> bool {
    !cfg!(debug_assertions) && app.config().identifier == RELEASED
}

/// Looks for a newer release and downloads it, in the background.
pub fn start<R: Runtime>(app: &AppHandle<R>) {
    if !enabled(app) {
        return;
    }
    app.manage(Pending::default());
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let Ok(updater) = app.updater() else { return };
        let Ok(Some(update)) = updater.check().await else {
            return;
        };
        let Ok(bytes) = update.download(|_, _| {}, || {}).await else {
            return;
        };
        if let Some(pending) = app.try_state::<Pending>()
            && let Ok(mut slot) = pending.0.lock()
        {
            *slot = Some((update, bytes));
        }
    });
}

/// Installs the update that was downloaded, if there is one. Called as the studio exits: on Windows
/// the installer starts and this process ends.
pub fn install_pending<R: Runtime>(app: &AppHandle<R>) {
    let Some(pending) = app.try_state::<Pending>() else {
        return;
    };
    let Some((update, bytes)) = pending.0.lock().ok().and_then(|mut slot| slot.take()) else {
        return;
    };
    // A failure here only means the old version starts next time, and looks again.
    let _ = update.install(bytes);
}
