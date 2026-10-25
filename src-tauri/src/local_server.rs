//! Slidr Library ([slidrhq/library](https://github.com/slidrhq/library)), served from this machine,
//! reads which of the library's designs the studio made, and opens one in the studio: reading only,
//! and only from this machine's pages (`src/studio.ts` of the library).
//!
//! ```text
//! GET /api/state     the requests and variants, as the studio's window has them
//! GET /api/status    the library the studio publishes to
//! GET /              a page that opens the request and variant its address names
//!                    (#tab=<rid>&v=<vid>) in the studio, and closes
//! GET /open          the same, as a query
//! ```
//!
//! On `127.0.0.1:8765` (`SLIDR_STUDIO_HOST`, `SLIDR_STUDIO_PORT`), where the studio's server was.
//! When another program holds the port, the studio works without it.

use std::{collections::HashMap, sync::Arc};

use axum::{
    Json, Router,
    extract::{Query, Request, State},
    http::{HeaderValue, Method, header},
    middleware::{self, Next},
    response::{Html, IntoResponse, Response},
    routing::get,
};
use serde_json::{Value, json};
use tauri::{AppHandle, Emitter, Manager};

use crate::pipeline::Studio;

#[derive(Clone)]
struct Shared {
    studio: Arc<Studio>,
    app: AppHandle,
}

/// `http://127.0.0.1:<port>` or `http://localhost:<port>`: a page of this machine.
fn local_origin(origin: &str) -> bool {
    let Some(rest) = origin.strip_prefix("http://") else {
        return false;
    };
    let host = rest.split_once(':').map_or(rest, |(host, port)| {
        if port.chars().all(|c| c.is_ascii_digit()) && !port.is_empty() {
            host
        } else {
            ""
        }
    });
    host == "127.0.0.1" || host == "localhost"
}

async fn cors(request: Request, next: Next) -> Response {
    let origin = request
        .headers()
        .get(header::ORIGIN)
        .and_then(|origin| origin.to_str().ok())
        .filter(|origin| local_origin(origin))
        .map(str::to_owned);
    let reading = request.method() == Method::GET;
    let mut response = next.run(request).await;
    if let (Some(origin), true) = (origin, reading)
        && let Ok(value) = HeaderValue::from_str(&origin)
    {
        response
            .headers_mut()
            .insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, value);
        response
            .headers_mut()
            .insert(header::VARY, HeaderValue::from_static("Origin"));
    }
    response
}

async fn state(State(shared): State<Shared>) -> Json<Value> {
    let studio = &shared.studio;
    Json(json!({
        "requests": studio.store.requests(),
        "variants": studio.store.variants(),
        "publish": studio.library.state(),
    }))
}

async fn status(State(shared): State<Shared>) -> Json<Value> {
    let settings = &shared.studio.settings;
    let remote = settings.remote().clone();
    Json(json!({
        "media": {
            "dir": settings.media_dir,
            "exists": settings.media_dir.as_ref().is_some_and(|dir| dir.is_dir()),
            "url": settings.media_url,
        },
        "library": {"url": remote.library_url, "key": remote.library_key.is_some()},
    }))
}

/// Brings the studio's window forward on the request and variant named.
async fn open(
    State(shared): State<Shared>,
    Query(query): Query<HashMap<String, String>>,
) -> impl IntoResponse {
    let route = json!({"tab": query.get("tab"), "v": query.get("v")});
    if let Some(window) = shared.app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.set_focus();
        let _ = window.emit("open", route);
    }
    Html(
        "<!doctype html><meta charset=utf-8><title>Slidr Studio</title><p style='font-family:system-ui;padding:2rem'>Opened in Slidr Studio.</p><script>window.close()</script>",
    )
}

async fn page() -> Html<&'static str> {
    Html(
        "<!doctype html><meta charset=utf-8><title>Slidr Studio</title>\
         <p style='font-family:system-ui;padding:2rem'>Opening in Slidr Studio…</p>\
         <script>fetch('/open?' + location.hash.slice(1)).then(() => window.close())</script>",
    )
}

pub fn start(app: AppHandle, studio: Arc<Studio>) {
    let address = (studio.settings.host.clone(), studio.settings.port);
    let shared = Shared { studio, app };
    tauri::async_runtime::spawn(async move {
        let listener = match tokio::net::TcpListener::bind((address.0.as_str(), address.1)).await {
            Ok(listener) => listener,
            Err(error) => {
                eprintln!(
                    "slidr-studio: {}:{} is taken ({error}); Slidr Library will not find the studio",
                    address.0, address.1
                );
                return;
            }
        };
        let router = Router::new()
            .route("/api/state", get(state))
            .route("/api/status", get(status))
            .route("/open", get(open))
            .route("/", get(page))
            .with_state(shared)
            .layer(middleware::from_fn(cors));
        if let Err(error) = axum::serve(listener, router).await {
            eprintln!("slidr-studio: the local answers stopped: {error}");
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_this_machines_pages_read() {
        assert!(local_origin("http://127.0.0.1:5176"));
        assert!(local_origin("http://localhost"));
        assert!(!local_origin("https://library.slidr.workers.dev"));
        assert!(!local_origin("http://localhost.evil.example:80"));
        assert!(!local_origin("http://127.0.0.1:x"));
    }
}
