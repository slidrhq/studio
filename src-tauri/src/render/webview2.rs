//! The WebView2 DevTools protocol, from Rust: `ICoreWebView2::CallDevToolsProtocolMethod` on a
//! render window, as the app's capture window calls it (`src-tauri/src/capture/webview2.rs`). COM
//! calls in windows-rs are `unsafe`, so this file is one of the two places the studio allows it.

use std::{
    sync::{Arc, Mutex, PoisonError},
    time::Duration,
};

use base64::Engine;
use serde_json::Value;
use tauri::WebviewWindow;
use tokio::sync::oneshot;
use webview2_com::CallDevToolsProtocolMethodCompletedHandler;
use windows_core::HSTRING;

/// Calls one DevTools method and returns its JSON result.
pub(super) async fn call(
    window: &WebviewWindow,
    method: &str,
    params: &Value,
    wait: Duration,
) -> Result<Value, String> {
    let (sender, receiver) = oneshot::channel::<Result<String, String>>();
    let method = HSTRING::from(method);
    let params = HSTRING::from(params.to_string());
    window
        .with_webview(move |webview| {
            // Answered once: by the completion handler, or here if the call is never made.
            let sender = Arc::new(Mutex::new(Some(sender)));
            let answer = {
                let sender = Arc::clone(&sender);
                move |result: Result<String, String>| {
                    if let Some(sender) =
                        sender.lock().unwrap_or_else(PoisonError::into_inner).take()
                    {
                        let _ = sender.send(result);
                    }
                }
            };
            let handler = {
                let answer = answer.clone();
                CallDevToolsProtocolMethodCompletedHandler::create(Box::new(move |result, json| {
                    answer(result.map(|()| json).map_err(|e| e.to_string()));
                    Ok(())
                }))
            };
            // SAFETY: `with_webview` runs this closure on the webview's UI thread, the thread its
            // COM objects belong to. The controller is a counted COM reference held by
            // `webview`; `method`, `params` and `handler` outlive the call, and WebView2 keeps
            // its own reference to the handler until it has been invoked.
            let called = unsafe {
                webview
                    .controller()
                    .CoreWebView2()
                    .and_then(|core| core.CallDevToolsProtocolMethod(&method, &params, &handler))
            };
            if let Err(e) = called {
                answer(Err(format!("WebView2 refused the call: {e}")));
            }
        })
        .map_err(|e| format!("the render window is not available: {e}"))?;
    match tokio::time::timeout(wait, receiver).await {
        Ok(Ok(Ok(json))) => serde_json::from_str(&json).map_err(|e| e.to_string()),
        Ok(Ok(Err(e))) => Err(format!("DevTools error: {e}")),
        Ok(Err(_)) => Err("the DevTools call was dropped".into()),
        Err(_) => Err(format!("no DevTools answer within {wait:?}")),
    }
}

/// The PNG of a `Page.captureScreenshot` result.
pub(super) fn decode_png(data: &str) -> Result<Vec<u8>, String> {
    const SIGNATURE: [u8; 8] = [0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];
    let png = base64::engine::general_purpose::STANDARD
        .decode(data)
        .map_err(|e| format!("the screenshot is not base64: {e}"))?;
    if png.starts_with(&SIGNATURE) {
        Ok(png)
    } else {
        Err("the screenshot is not a PNG".into())
    }
}
