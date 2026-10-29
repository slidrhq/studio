//! The Tauri shell of Slidr Studio. The pages show the chats, the requests and their outputs, and
//! ask for the work; Rust keeps them, runs the agents of each role (Claude Code, the Codex CLI),
//! renders in hidden windows with the app's own engine, and publishes the approved work to the
//! library.

mod agents;
mod claude;
mod codex;
mod commands;
mod config;
mod files;
mod gallery;
mod instructions;
#[cfg(windows)]
#[allow(unsafe_code)]
// The job object that ends the studio's programs with it; `render/webview2.rs` is the other place
// that takes `unsafe`.
mod jobs;
mod languages;
mod library;
mod local_server;
mod media;
mod net;
mod pipeline;
mod programs;
mod prompts;
mod render;
mod secrets;
mod store;
mod tags;
mod template_prompts;
mod templates;
mod updates;
mod uploads;

use std::sync::Arc;

use tauri::{
    AppHandle, Emitter, Manager, RunEvent, Runtime, Url, WebviewUrl, WebviewWindowBuilder,
    ipc::Invoke, webview::NewWindowResponse,
};
use tauri_plugin_opener::OpenerExt;

use crate::{
    agents::Preferences,
    config::Settings,
    instructions::Instructions,
    library::Library,
    pipeline::Studio,
    render::Renders,
    store::{Emit, Store},
    templates::Templates,
};

/// Starts the studio. Blocks until its window closes.
///
/// # Panics
/// If the webview runtime cannot be initialised; there is nothing to fall back to.
pub fn run() {
    let handler = gate(tauri::generate_handler![
        commands::studio_status,
        commands::studio_state,
        commands::settings_get,
        commands::settings_set,
        commands::chat_send,
        commands::chat_agents,
        commands::chat_delete,
        commands::library_known,
        commands::template_listing,
        commands::request_more,
        commands::request_cancel,
        commands::request_delete,
        commands::variant_retry,
        commands::variant_cancel,
        commands::variant_refine,
        commands::variant_image,
        commands::variant_approve,
        commands::variants_approve,
        commands::variant_discard,
        commands::variant_result,
        commands::library_upload,
        commands::library_settings,
        commands::library_statuses,
        commands::gallery_missing,
        commands::gallery_draw,
        commands::render_input,
        commands::capture_clip,
        commands::render_done,
    ]);
    tauri::Builder::default()
        // A second start brings the first studio forward: two would run the same requests.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_opener::init())
        // Updates of the studio: found and downloaded while it runs, installed when it exits.
        .plugin(tauri_plugin_updater::Builder::new().build())
        // The media library, where `@slidr/media-library` looks for it in a Tauri window.
        .register_asynchronous_uri_scheme_protocol(media::SCHEME, |context, request, responder| {
            let library = context
                .app_handle()
                .try_state::<Arc<Studio>>()
                .map(|studio| studio.settings.media_url.clone());
            tauri::async_runtime::spawn(async move {
                if let Some(library) = library {
                    responder.respond(media::respond(&library, &request).await);
                }
            });
        })
        // The pictures and renders of a variant, to the studio's pages.
        .register_asynchronous_uri_scheme_protocol(files::SCHEME, |context, request, responder| {
            let studio = context
                .app_handle()
                .try_state::<Arc<Studio>>()
                .map(|studio| Arc::clone(&studio));
            tauri::async_runtime::spawn_blocking(move || {
                if let Some(studio) = studio {
                    responder.respond(files::respond(&studio.store, &request));
                }
            });
        })
        .setup(|app| {
            setup(app.handle())?;
            Ok(())
        })
        .on_window_event(render::on_window_event)
        .invoke_handler(handler)
        .build(tauri::generate_context!())
        .expect("failed to start Slidr Studio")
        .run(|app, event| {
            if let RunEvent::Exit = event {
                if let Some(studio) = app.try_state::<Arc<Studio>>() {
                    studio.stop_all();
                }
                updates::install_pending(app);
            }
        });
}

/// A render window runs HTML that Claude wrote: it may call its own few commands only.
fn gate<R: Runtime>(
    handler: impl Fn(Invoke<R>) -> bool + Send + Sync + 'static,
) -> impl Fn(Invoke<R>) -> bool + Send + Sync + 'static {
    move |invoke| {
        let command = invoke.message.command();
        if render::is_render_window(invoke.message.webview_ref().label())
            && !commands::RENDER_COMMANDS.contains(&command)
        {
            let refusal = format!("a render window may not call {command}");
            invoke.resolver.reject(refusal);
            return true;
        }
        handler(invoke)
    }
}

fn setup(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    // A build of the repository works where the studio always worked; the installed one in a
    // folder of its own.
    let data = match config::repository() {
        Some(repository) => repository.join(".data"),
        None => app.path().app_local_data_dir()?,
    };
    let settings = Arc::new(Settings::new(data, secrets::library_token()));
    let emitter = app.clone();
    let emit: Emit = Arc::new(move |event| {
        let _ = emitter.emit_to("main", "studio", event);
    });
    let store = Arc::new(Store::new(settings.requests_dir(), emit));
    store.load();
    let templates = Arc::new(Templates::new(settings.media_url.clone()));
    let library = Arc::new(Library::new(
        Arc::clone(&settings),
        Arc::clone(&store),
        Arc::clone(&templates),
    ));
    let renders = Arc::new(Renders::new(app.clone(), settings.show_render));
    let prefs = Arc::new(Preferences::load(agents::settings_file(&settings.data)));
    let studio = Arc::new(Studio::new(
        Arc::clone(&settings),
        store,
        prefs,
        Arc::new(Instructions::new(settings.media_url.clone())),
        library,
        templates,
        Arc::clone(&renders) as Arc<dyn pipeline::Renderer>,
    ));
    app.manage(renders);
    app.manage(Arc::clone(&studio));
    main_window(app)?;
    local_server::start(app.clone(), studio);
    updates::start(app);
    Ok(())
}

/// The studio's own pages: the packaged ones, or Vite's while the studio is worked on.
fn own_page(url: &Url) -> bool {
    match url.scheme() {
        "tauri" | "about" | "data" | "blob" => true,
        "http" | "https" => {
            url.host_str() == Some("tauri.localhost")
                || (cfg!(debug_assertions)
                    && url.host_str() == Some("127.0.0.1")
                    && url.port() == Some(5175))
        }
        _ => false,
    }
}

/// A link that leaves the studio opens in the system's browser.
fn open_outside(app: &AppHandle, url: &Url) {
    if matches!(url.scheme(), "http" | "https") {
        let _ = app.opener().open_url(url.as_str(), None::<&str>);
    }
}

fn main_window(app: &AppHandle) -> tauri::Result<()> {
    let (navigating, opening) = (app.clone(), app.clone());
    WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
        .title("Slidr Studio")
        .inner_size(1440.0, 920.0)
        .min_inner_size(1024.0, 640.0)
        .center()
        .on_navigation(move |url| {
            let own = own_page(url);
            if !own {
                open_outside(&navigating, url);
            }
            own
        })
        .on_new_window(move |url, _features| {
            open_outside(&opening, &url);
            NewWindowResponse::Deny
        })
        .build()
        .map(drop)
}
