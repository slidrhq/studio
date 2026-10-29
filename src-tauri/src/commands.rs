//! What the studio's pages ask of it: the studio's window, its requests and variants, and the
//! render windows' own few calls. Every answer is JSON; a refusal is its reason, in words.

use std::sync::Arc;

use serde_json::{Value, json};
use tauri::{Emitter, State, WebviewWindow, ipc::Response};

use crate::{
    agents::{OwnAgents, StudioSettings},
    gallery,
    pipeline::{Approval, ChatSend, Studio},
    programs,
    render::{self, Done, Rect, Renders},
    secrets,
    store::{Chat, Request},
};

type Answer<T = Value> = Result<T, String>;

fn ok() -> Answer {
    Ok(json!({"ok": true}))
}

fn too_long(text: &str, most: usize, what: &str) -> Answer<()> {
    if text.chars().count() > most {
        Err(format!("The {what} may be at most {most} characters."))
    } else {
        Ok(())
    }
}

/* ------------------------------------------------------------------ state */

#[tauri::command]
pub async fn studio_status(studio: State<'_, Arc<Studio>>) -> Answer {
    let found = programs::probe().await;
    let remote = studio.settings.remote().clone();
    Ok(json!({
        "programs": found,
        "media": {"url": studio.settings.media_url},
        "library": {"url": remote.library_url, "token": remote.library_token.is_some()},
    }))
}

#[tauri::command]
pub fn studio_state(studio: State<'_, Arc<Studio>>) -> Value {
    json!({
        "requests": studio.store.requests(),
        "variants": studio.store.variants(),
        "chats": studio.store.chats(),
    })
}

/* ------------------------------------------------------------------ settings */

/// The studio's settings: the agents of each role and the review rounds; and the library.
#[tauri::command]
pub fn settings_get(studio: State<'_, Arc<Studio>>) -> Value {
    let remote = studio.settings.remote().clone();
    json!({
        "settings": studio.prefs.get(),
        "library": {"url": remote.library_url, "token": remote.library_token.is_some()},
    })
}

#[tauri::command]
pub fn settings_set(
    app: tauri::AppHandle,
    studio: State<'_, Arc<Studio>>,
    settings: StudioSettings,
) -> Answer<StudioSettings> {
    let settings = studio.prefs.set(settings)?;
    let _ = app.emit_to(
        "main",
        "studio",
        json!({"type": "settings", "settings": settings}),
    );
    Ok(settings)
}

/* ------------------------------------------------------------------ chats */

/// A message of the person in a chat (a new one when none is named): a request, or a change of
/// the outputs it is about.
#[tauri::command]
pub fn chat_send(studio: State<'_, Arc<Studio>>, body: ChatSend) -> Answer<Chat> {
    studio.send(body)
}

/// A chat's own choice of agents; none goes back to the settings'.
#[tauri::command]
pub fn chat_agents(
    studio: State<'_, Arc<Studio>>,
    chat_id: String,
    agents: Option<OwnAgents>,
) -> Answer<Chat> {
    studio.set_chat_agents(&chat_id, agents)
}

#[tauri::command]
pub fn chat_delete(studio: State<'_, Arc<Studio>>, chat_id: String) -> Answer {
    studio.delete_chat(&chat_id);
    ok()
}

#[tauri::command]
pub async fn library_known(studio: State<'_, Arc<Studio>>, fresh: Option<bool>) -> Answer {
    Ok(json!(studio.library.known(fresh.unwrap_or(false)).await))
}

/// The built-in templates, with the languages each sample is written in and lacks.
#[tauri::command]
pub async fn template_listing(studio: State<'_, Arc<Studio>>, fresh: Option<bool>) -> Answer {
    if fresh.unwrap_or(false) {
        studio.templates.forget().await;
    }
    Ok(json!({"templates": studio.template_listing().await?}))
}

/* ------------------------------------------------------------------ requests */

#[tauri::command]
pub fn request_more(
    studio: State<'_, Arc<Studio>>,
    rid: String,
    count: Option<u32>,
) -> Answer<Request> {
    let count = count.unwrap_or(2);
    if !(1..=6).contains(&count) {
        return Err("Plan 1 to 6 concepts.".into());
    }
    studio.more(&rid, count)
}

#[tauri::command]
pub fn request_cancel(studio: State<'_, Arc<Studio>>, rid: String) -> Answer {
    let request = studio.store.request(&rid).ok_or("No such request.")?;
    studio.cancel(&rid);
    for vid in &request.variant_ids {
        studio.cancel(vid);
    }
    ok()
}

#[tauri::command]
pub fn request_delete(studio: State<'_, Arc<Studio>>, rid: String) -> Answer {
    studio.delete_request(&rid);
    ok()
}

/* ------------------------------------------------------------------ variants */

#[tauri::command]
pub fn variant_retry(studio: State<'_, Arc<Studio>>, vid: String) -> Answer {
    studio.retry(&vid)?;
    ok()
}

#[tauri::command]
pub fn variant_cancel(studio: State<'_, Arc<Studio>>, vid: String) -> Answer {
    studio.cancel(&vid);
    ok()
}

#[tauri::command]
pub fn variant_refine(studio: State<'_, Arc<Studio>>, vid: String, feedback: String) -> Answer {
    let feedback = feedback.trim().to_owned();
    if feedback.chars().count() < 2 {
        return Err("Say what to change.".into());
    }
    too_long(&feedback, 4000, "change")?;
    studio.refine(&vid, feedback)?;
    ok()
}

#[tauri::command]
pub fn variant_image(
    studio: State<'_, Arc<Studio>>,
    vid: String,
    instruction: Option<String>,
) -> Answer {
    let instruction = instruction
        .map(|text| text.trim().to_owned())
        .filter(|text| !text.is_empty());
    if let Some(instruction) = &instruction {
        too_long(instruction, 2000, "instruction")?;
    }
    studio.new_image(&vid, instruction)?;
    ok()
}

/// Approves a variant: an English master is written in the other languages, a whole design or a
/// sample is published at once. `value: false` withdraws an approval.
#[tauri::command]
pub fn variant_approve(studio: State<'_, Arc<Studio>>, vid: String, value: Option<bool>) -> Answer {
    let action = match studio.approve(&vid, value.unwrap_or(true))? {
        Approval::Translate => "translate",
        Approval::Publish => "publish",
        Approval::Withdrawn => "skip",
    };
    Ok(json!({"variantId": vid, "action": action}))
}

/// Approves each of these variants, as `variant_approve` does; what became of each.
#[tauri::command]
pub fn variants_approve(studio: State<'_, Arc<Studio>>, vids: Vec<String>) -> Answer {
    if vids.len() > 500 {
        return Err("Approve at most 500 at once.".into());
    }
    Ok(json!({"items": studio.approve_many(&vids)}))
}

#[tauri::command]
pub fn variant_discard(studio: State<'_, Arc<Studio>>, vid: String, value: Option<bool>) -> Answer {
    studio.discard(&vid, value.unwrap_or(true))?;
    ok()
}

#[tauri::command]
pub fn variant_result(studio: State<'_, Arc<Studio>>, vid: String) -> Answer {
    studio.result(&vid)
}

/* ------------------------------------------------------------------ publishing */

/// Sends the approved work (or the variants named) to the library's upload API.
#[tauri::command]
pub async fn library_upload(
    studio: State<'_, Arc<Studio>>,
    variant_ids: Option<Vec<String>>,
) -> Answer {
    let vids = variant_ids.unwrap_or_else(|| approved(&studio));
    Ok(json!({"items": studio.library.upload(&vids).await}))
}

fn approved(studio: &Studio) -> Vec<String> {
    studio
        .store
        .variants()
        .into_iter()
        .filter(|variant| variant.approved && !variant.discarded)
        .map(|variant| variant.id)
        .collect()
}

/// The library's address, and the studio's token to it, kept in the system's credential store.
#[tauri::command]
pub fn library_settings(
    studio: State<'_, Arc<Studio>>,
    token: Option<String>,
    url: Option<String>,
) -> Answer {
    let token = token
        .map(|token| token.trim().to_owned())
        .filter(|token| !token.is_empty());
    let url = url
        .map(|url| url.trim().to_owned())
        .filter(|url| !url.is_empty());
    if let Some(token) = &token {
        too_long(token, 400, "token")?;
        if !is_token(token) {
            return Err(
                "This is not a token of the library: make one in its profile (slk_…).".into(),
            );
        }
        secrets::set_library_token(token)?;
    }
    let mut remote = studio.settings.remote();
    if let Some(token) = token {
        remote.library_token = Some(token);
    }
    if let Some(url) = url {
        too_long(&url, 400, "address")?;
        remote.library_url = url;
    }
    Ok(json!({"url": remote.library_url, "token": remote.library_token.is_some()}))
}

/// Whether a text is a token of the library: `slk_` and 43 characters of base64url.
fn is_token(text: &str) -> bool {
    text.len() == 47
        && text.starts_with("slk_")
        && text[4..]
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
}

/// The status of the uploads these variants were sent as, as the library has them now.
#[tauri::command]
pub async fn library_statuses(studio: State<'_, Arc<Studio>>, variant_ids: Vec<String>) -> Answer {
    Ok(json!({"items": studio.library.statuses(&variant_ids).await}))
}

/* ------------------------------------------------------------------ the galleries' pictures */

/// How many slides of the published designs the library has no picture of, and of how many
/// designs; `stale` while its words are of another library, which drawing has it write first.
#[tauri::command]
pub async fn gallery_missing(studio: State<'_, Arc<Studio>>) -> Answer {
    let Some(missing) = studio.library.gallery_missing().await? else {
        return Ok(json!({"stale": true}));
    };
    let mut designs: Vec<&str> = missing.iter().map(|slide| slide.id.as_str()).collect();
    designs.dedup();
    Ok(json!({"slides": missing.len(), "designs": designs.len()}))
}

/// Draws the slides of the published designs that the library has no picture of, and sends the
/// pictures to it (`gallery.rs`).
#[tauri::command]
pub async fn gallery_draw(
    studio: State<'_, Arc<Studio>>,
    renders: State<'_, Arc<Renders>>,
) -> Answer {
    if studio.settings.remote().library_token.is_none() {
        return Err("The studio has no token of the library yet: save one first.".into());
    }
    let work = studio.settings.data.join("gallery");
    gallery::draw(&studio.library, &renders, &work).await
}

/* ------------------------------------------------------------------ the render windows */

fn from_render_window(window: &WebviewWindow) -> Answer<()> {
    if render::is_render_window(window.label()) {
        Ok(())
    } else {
        Err("only a render window may ask this".into())
    }
}

/// What the render page converts, once its window is set to render at 1920×1080.
#[tauri::command]
pub async fn render_input(
    window: WebviewWindow,
    renders: State<'_, Arc<Renders>>,
    studio: State<'_, Arc<Studio>>,
) -> Answer {
    from_render_window(&window)?;
    match renders.begin(&window).await? {
        (_, Some(input)) => Ok(input),
        (vid, None) => studio.render_input(&vid),
    }
}

/// A picture of a rectangle of the render page, for the conversion engine's fidelity guard. The
/// answer is the PNG's bytes, not JSON.
#[tauri::command]
pub async fn capture_clip(window: WebviewWindow, rect: Rect, dpr: f64) -> Answer<Response> {
    from_render_window(&window)?;
    Ok(Response::new(render::picture(&window, rect, dpr).await?))
}

/// The render page's result, the views it drew, or why it failed.
#[tauri::command]
pub fn render_done(
    window: WebviewWindow,
    renders: State<'_, Arc<Renders>>,
    done: Done,
) -> Answer<()> {
    from_render_window(&window)?;
    renders.done(window.label(), done)
}

/// The commands a render window may call; it runs HTML that Claude wrote.
pub const RENDER_COMMANDS: [&str; 3] = ["render_input", "capture_clip", "render_done"];
