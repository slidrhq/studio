//! What the studio's pages ask of it: the studio's window, its requests and variants, and the
//! render windows' own few calls. Every answer is JSON; a refusal is its reason, in words.

use std::sync::Arc;

use serde::Deserialize;
use serde_json::{Value, json};
use tauri::{State, WebviewWindow, ipc::Response};

use crate::{
    gallery, languages,
    pipeline::Studio,
    programs,
    render::{self, Done, Rect, Renders},
    secrets,
    store::{Request, RequestKind},
};

type Answer<T = Value> = Result<T, String>;

const MODELS: [&str; 5] = ["", "fable", "opus", "sonnet", "haiku"];
const EFFORTS: [&str; 6] = ["", "low", "medium", "high", "xhigh", "max"];

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
    })
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

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewRequest {
    /// What to make, in words: a design's description, a template request's instructions
    /// (optional), or any request for the studio to read (`kind` "auto").
    #[serde(default)]
    prompt: String,
    /// `design`, `template` (the sample of `templateId` in `languages`), or `auto`: Claude reads
    /// the prompt and makes it one of the two.
    #[serde(default)]
    kind: RequestKind,
    #[serde(default)]
    template_id: String,
    #[serde(default)]
    group: String,
    #[serde(default)]
    model: String,
    #[serde(default)]
    effort: String,
    #[serde(default = "two")]
    review_rounds: u32,
    /// A design's languages: Hebrew and English always (added when left out), and any other
    /// content language asked for; none asked for means Hebrew and English only. A template's:
    /// exactly the languages to write its sample in. A code the registry does not know is refused.
    #[serde(default)]
    languages: Vec<String>,
}

fn two() -> u32 {
    2
}

impl NewRequest {
    /// The request as it is asked for, held to what a request may be.
    fn checked(self) -> Answer<(Request, Self)> {
        too_long(&self.prompt, 4000, "request")?;
        too_long(&self.template_id, 40, "template id")?;
        too_long(&self.group, 40, "group")?;
        if self.review_rounds > 3 {
            return Err("Review at most 3 rounds.".into());
        }
        if self.languages.len() > 64 {
            return Err("Too many languages.".into());
        }
        if !MODELS.contains(&self.model.as_str()) || !EFFORTS.contains(&self.effort.as_str()) {
            return Err("Unknown model or effort.".into());
        }
        let prompt = self.prompt.trim().to_owned();
        let mut request = Request::draft(self.kind, prompt.clone());
        // A design, or a request that may become one, is made in Hebrew and English always.
        request.languages = Some(if self.kind == RequestKind::Template {
            languages::known(&self.languages)?
        } else {
            languages::parse(&self.languages)?
        });
        request.title = prompt
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ")
            .chars()
            .take(48)
            .collect();
        request.model.clone_from(&self.model);
        request.effort.clone_from(&self.effort);
        request.review_rounds = self.review_rounds;
        Ok((request, self))
    }
}

#[tauri::command]
pub async fn request_new(studio: State<'_, Arc<Studio>>, body: NewRequest) -> Answer<Request> {
    let (mut request, body) = body.checked()?;
    if body.kind == RequestKind::Template {
        let listing = studio.template_listing().await?;
        let entry = listing
            .iter()
            .find(|template| template.id == body.template_id)
            .ok_or_else(|| format!("The library has no template '{}'.", body.template_id))?;
        let langs = request.languages.clone().unwrap_or_default();
        if langs.is_empty() {
            return Err("Name at least one language to write the sample in.".into());
        }
        request.template_id = Some(entry.id.clone());
        request.instructions = Some(request.prompt.clone());
        let shown = if langs.len() <= 3 {
            langs.join(", ")
        } else {
            format!("{} languages", langs.len())
        };
        request.title = format!("{} · {shown}", entry.name.en);
    } else {
        if request.prompt.chars().count() < 3 {
            return Err("Say what to make.".into());
        }
        request.group = Some(body.group.clone());
    }
    studio.start_request(request)
}

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

#[tauri::command]
pub fn variant_approve(studio: State<'_, Arc<Studio>>, vid: String, value: Option<bool>) -> Answer {
    studio.approve(&vid, value.unwrap_or(true))?;
    ok()
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

/// How many slides of the published designs the library has no picture of, and of how many designs.
#[tauri::command]
pub async fn gallery_missing(studio: State<'_, Arc<Studio>>) -> Answer {
    let missing = studio.library.gallery_missing().await?;
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

#[cfg(test)]
mod tests {
    use super::*;

    fn asked(body: Value) -> Answer<(Request, NewRequest)> {
        serde_json::from_value::<NewRequest>(body)
            .map_err(|e| e.to_string())?
            .checked()
    }

    #[test]
    fn a_request_is_made_in_hebrew_and_english_unless_more_are_chosen() {
        let (request, _) = asked(json!({"prompt": "an invitation"})).expect("a request");
        assert_eq!(request.languages, Some(languages::base()));
        let (request, _) = asked(
            json!({"prompt": "an invitation", "languages": ["ja", "ar", "JA", "pt-br", "en"]}),
        )
        .expect("a request");
        assert_eq!(
            request.languages,
            Some(["he", "en", "ar", "pt-BR", "ja"].map(String::from).to_vec())
        );
        assert!(
            asked(json!({"prompt": "an invitation", "languages": ["de", "xx"]}))
                .is_err_and(|e| e.contains("Unknown language xx"))
        );
        assert!(asked(json!({"prompt": "x", "model": "gpt"})).is_err());
    }

    #[test]
    fn a_template_request_keeps_exactly_its_languages() {
        let (request, _) = asked(
            json!({"kind": "template", "templateId": "mifgash", "languages": ["de", "AR", "de"]}),
        )
        .expect("a request");
        assert_eq!(
            request.languages,
            Some(["ar", "de"].map(String::from).to_vec())
        );
        // A design, or a request the studio is to read, still gets Hebrew and English.
        let (request, _) =
            asked(json!({"kind": "auto", "prompt": "translate Mifgash"})).expect("a request");
        assert_eq!(request.languages, Some(languages::base()));
    }
}
