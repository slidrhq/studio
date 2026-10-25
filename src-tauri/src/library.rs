//! The media library: what is published, and the approved work sent to it.
//!
//! Designs the studio makes go to their own catalog, `elements/designs/managed.json`, with ids that
//! start with `m-`, beside the authored `elements/designs/index.json`, which the studio never
//! writes. The app reads both (docs/media-library.md). Their pictures are
//! `images/designs/<id>.webp`, and their sizes are kept in managed.json.
//!
//! The approved work goes to the library through its upload API (`uploads.rs`). The studio's own
//! publication of the author copy stays here for the library's next step, which takes the accepted
//! uploads in; the studio's window no longer offers it. It goes through the app's own
//! `desktop/scripts/media-publish.mjs`, from the author copy (`../Slidr-media`), so it keeps that
//! script's staging, manifest and guards, and runs in a build of the repository, with Node:
//!
//! 1. prepare: copy into the author copy the published files it lacks (never one it has), write the
//!    approved designs into it, and ask the script for a dry run with a report of what would change;
//! 2. the person reads the report and confirms;
//! 3. publish: run the script for real, then read the published manifest back to check the files.
//!
//! Cancelling, or a failed deploy, puts the author copy back as it was.

use std::{
    collections::HashSet,
    fs,
    path::{Path, PathBuf},
    process::Stdio,
    sync::{Arc, Mutex, MutexGuard, PoisonError},
    time::{Duration, Instant},
};

use serde::Serialize;
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};
use tokio::io::{AsyncBufReadExt, BufReader};

use crate::{
    config::Settings,
    languages::{self, BASE_LANGUAGES, CONTENT_LANGUAGES},
    net::{self, FetchError},
    programs,
    prompts::{items, truthy},
    render::render_dir,
    store::{Emit, Published, Store, Tags, Upload, Variant, now, read_json, write_atomic},
    templates::{CATALOG as TEMPLATES, Templates, catalog_changes, encode_catalog, merge_sample},
    uploads::{LibraryApi, design_upload, sample_upload},
};

pub const MANAGED: &str = "elements/designs/managed.json";
pub const INDEX: &str = "elements/designs/index.json";
/// The largest file Cloudflare Pages serves (docs/media-library.md).
const FILE_LIMIT: usize = 25 * 1024 * 1024;
const LOG_LIMIT: usize = 600;
/// Most search tags kept in a language, and fewest a language must have for any to be kept.
const MOST_TAGS: usize = 20;
const FEWEST_TAGS: usize = 3;

pub fn sha256(data: &[u8]) -> String {
    format!("{:x}", Sha256::digest(data))
}

pub fn empty_catalog() -> Value {
    json!({
        "version": 1,
        "groups": [],
        "groupNames": {},
        "groupIds": {},
        "slides": {},
        "subjects": {},
        "names": {},
        "sizes": {},
        "tags": {},
    })
}

fn niqqud(c: char) -> bool {
    ('\u{0591}'..='\u{05C7}').contains(&c)
}

fn hebrew_letter(c: char) -> bool {
    ('א'..='ת').contains(&c)
}

/// The search tags of a design as the catalog keeps them (ADR-108 of the app): `{he, en}`, each a
/// list of short words, English in lower case, Hebrew in Hebrew letters and without niqqud, none
/// twice. None when either language has too few.
pub fn design_tags(value: Option<&Value>) -> Option<Tags> {
    let value = value?.as_object()?;
    let mut tags = Tags::default();
    for lang in BASE_LANGUAGES {
        let mut kept: Vec<String> = Vec::new();
        for tag in items(value.get(lang)) {
            let Some(tag) = tag.as_str() else {
                continue;
            };
            let text = tag.split_whitespace().collect::<Vec<_>>().join(" ");
            let text = if lang == "he" {
                text.chars().filter(|c| !niqqud(*c)).collect::<String>()
            } else {
                text.to_lowercase()
            };
            let hebrew = text.chars().any(hebrew_letter);
            if text.is_empty()
                || text.chars().count() > 40
                || hebrew != (lang == "he")
                || kept.contains(&text)
            {
                continue;
            }
            kept.push(text);
        }
        if kept.len() < FEWEST_TAGS {
            return None;
        }
        kept.truncate(MOST_TAGS);
        if lang == "he" {
            tags.he = kept;
        } else {
            tags.en = kept;
        }
    }
    Some(tags)
}

fn object<'a>(catalog: &'a mut Map<String, Value>, key: &str) -> &'a mut Map<String, Value> {
    let value = catalog
        .entry(key)
        .or_insert_with(|| Value::Object(Map::new()));
    if !value.is_object() {
        *value = Value::Object(Map::new());
    }
    match value {
        Value::Object(map) => map,
        _ => unreachable!("made an object above"),
    }
}

/// Puts one design into a managed catalog, replacing it in place when it is there.
///
/// `design`: id, name {he, en}, group, groupName {he, en}, slides {he, en, and any other content
/// language it was made in: ar, de, ja…}, subject [x, y], size [w, h], and its search tags {he, en}
/// when it has them. The names and tags stay in Hebrew and English, the languages the gallery names
/// and searches its designs in. A design has one group: it leaves any other it was filed under.
pub fn merge_design(catalog: &mut Value, design: &Value) {
    if !catalog.is_object() {
        *catalog = empty_catalog();
    }
    let Some(catalog) = catalog.as_object_mut() else {
        return;
    };
    if let Value::Object(defaults) = empty_catalog() {
        for (key, value) in defaults {
            catalog.entry(key).or_insert(value);
        }
    }
    let did = design
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();
    let group = design
        .get("group")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();
    let mut groups: Vec<String> = items(catalog.get("groups"))
        .iter()
        .filter_map(|g| g.as_str().map(str::to_owned))
        .collect();
    if !groups.contains(&group) {
        groups.push(group.clone());
    }
    // A group keeps the names it was published with.
    let names = design
        .get("groupName")
        .filter(|names| truthy(names))
        .cloned()
        .unwrap_or_else(|| json!({"he": group, "en": group}));
    object(catalog, "groupNames")
        .entry(group.clone())
        .or_insert(names);
    let ids = object(catalog, "groupIds");
    for (other, list) in ids.iter_mut() {
        if *other != group
            && let Some(list) = list.as_array_mut()
        {
            list.retain(|id| id.as_str() != Some(&did));
        }
    }
    let list = ids.entry(group.clone()).or_insert_with(|| json!([]));
    if let Some(list) = list.as_array_mut()
        && !list.iter().any(|id| id.as_str() == Some(&did))
    {
        list.push(json!(did));
    }
    for (key, field) in [
        ("slides", "slides"),
        ("subjects", "subject"),
        ("names", "name"),
        ("sizes", "size"),
    ] {
        object(catalog, key).insert(
            did.clone(),
            design.get(field).cloned().unwrap_or(Value::Null),
        );
    }
    // A design published again without tags keeps none: the app then finds it by its names.
    match design.get("tags").filter(|tags| truthy(tags)) {
        Some(tags) => {
            object(catalog, "tags").insert(did.clone(), tags.clone());
        }
        None => {
            object(catalog, "tags").shift_remove(&did);
        }
    }
    // Groups left without designs go.
    let filled = |catalog: &Map<String, Value>, group: &str| {
        catalog
            .get("groupIds")
            .and_then(|ids| ids.get(group))
            .and_then(Value::as_array)
            .is_some_and(|ids| !ids.is_empty())
    };
    let (kept, gone): (Vec<String>, Vec<String>) =
        groups.into_iter().partition(|group| filled(catalog, group));
    for group in &gone {
        object(catalog, "groupIds").shift_remove(group);
        object(catalog, "groupNames").shift_remove(group);
    }
    let ids = object(catalog, "groupIds").clone();
    let ordered: Map<String, Value> = kept
        .iter()
        .filter_map(|group| ids.get(group).map(|list| (group.clone(), list.clone())))
        .collect();
    catalog.insert("groupIds".into(), Value::Object(ordered));
    catalog.insert("groups".into(), json!(kept));
}

/// The picture as the library keeps it: lossy WebP at the quality the studio has always used, with
/// its alpha when it has one; and its size.
pub fn to_webp(png: &Path) -> Result<(Vec<u8>, (u32, u32)), String> {
    let failed = |e: &dyn std::fmt::Display| format!("{}: {e}", png.display());
    let image = image::ImageReader::open(png)
        .and_then(image::ImageReader::with_guessed_format)
        .map_err(|e| failed(&e))?
        .decode()
        .map_err(|e| failed(&e))?;
    let (width, height) = (image.width(), image.height());
    let mut config = webp::WebPConfig::new().map_err(|()| failed(&"no WebP encoder"))?;
    config.quality = 86.0;
    config.method = 6;
    let encoded = if image.color().has_alpha() {
        let rgba = image.to_rgba8();
        webp::Encoder::from_rgba(&rgba, width, height).encode_advanced(&config)
    } else {
        let rgb = image.to_rgb8();
        webp::Encoder::from_rgb(&rgb, width, height).encode_advanced(&config)
    }
    .map_err(|e| failed(&format!("{e:?}")))?;
    Ok((encoded.to_vec(), (width, height)))
}

/// A group of the gallery, with its names where the library has them.
#[derive(Debug, Clone, Serialize)]
pub struct Group {
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub he: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub en: Option<String>,
}

/// The gallery's groups and design ids, published and local, for planning.
#[derive(Debug, Clone, Serialize)]
pub struct Known {
    pub groups: Vec<Group>,
    pub ids: Vec<String>,
    pub managed: usize,
    pub authored: usize,
    pub reachable: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Phase {
    Idle,
    Preparing,
    Prepared,
    Publishing,
    Done,
    Failed,
}

#[derive(Debug, Clone, Serialize)]
pub struct LogLine {
    pub t: f64,
    pub text: String,
}

/// Where a publication of the author copy stands, as the studio's window shows it.
#[derive(Debug, Clone, Serialize)]
pub struct PublishState {
    pub phase: Phase,
    pub items: Vec<String>,
    pub report: Option<Value>,
    pub log: Vec<LogLine>,
    pub error: Option<String>,
    pub at: Option<f64>,
}

impl PublishState {
    fn idle() -> Self {
        Self {
            phase: Phase::Idle,
            items: Vec::new(),
            report: None,
            log: Vec::new(),
            error: None,
            at: None,
        }
    }
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

pub struct Library {
    settings: Arc<Settings>,
    store: Arc<Store>,
    templates: Arc<Templates>,
    emit: Emit,
    known: Mutex<Option<(Instant, Known)>>,
    state: Mutex<PublishState>,
    /// What the author copy's files held before the publication wrote them.
    undo: Mutex<Vec<(PathBuf, Option<Vec<u8>>)>>,
    turn: tokio::sync::Mutex<()>,
}

impl Library {
    pub fn new(
        settings: Arc<Settings>,
        store: Arc<Store>,
        templates: Arc<Templates>,
        emit: Emit,
    ) -> Self {
        Self {
            settings,
            store,
            templates,
            emit,
            known: Mutex::new(None),
            state: Mutex::new(PublishState::idle()),
            undo: Mutex::new(Vec::new()),
            turn: tokio::sync::Mutex::new(()),
        }
    }

    pub fn state(&self) -> PublishState {
        lock(&self.state).clone()
    }

    fn url(&self, path: &str) -> String {
        format!("{}/{path}", self.settings.media_url.trim_end_matches('/'))
    }

    /// A JSON file of the published library; None when it was never published.
    pub async fn published_json(&self, path: &str) -> Result<Option<Value>, String> {
        match net::fetch(&self.url(path), Duration::from_secs(30)).await {
            Ok(bytes) => serde_json::from_slice(&bytes)
                .map(Some)
                .map_err(|e| e.to_string()),
            Err(FetchError::Status(404 | 410)) => Ok(None),
            Err(error) => Err(error.to_string()),
        }
    }

    /* -------------------------------------------------------------- what is there */

    /// The gallery's groups and design ids, published and local, for planning.
    pub async fn known(&self, fresh: bool) -> Known {
        if !fresh
            && let Some((at, known)) = lock(&self.known).as_ref()
            && at.elapsed() < Duration::from_secs(60)
        {
            return known.clone();
        }
        let read = async {
            let index = self.published_json(INDEX).await?;
            let managed = self.published_json(MANAGED).await?;
            Ok::<_, String>((index, managed))
        };
        // The studio still plans without the network.
        let (index, managed, reachable) = match read.await {
            Ok((index, managed)) => (index, managed, true),
            Err(_) => (None, None, false),
        };
        let mut groups: Vec<Group> = Vec::new();
        let mut ids: Vec<String> = Vec::new();
        let slides_of = |catalog: &Option<Value>| {
            catalog
                .as_ref()
                .and_then(|c| c.get("slides"))
                .and_then(Value::as_object)
                .map(|slides| slides.keys().cloned().collect::<Vec<_>>())
                .unwrap_or_default()
        };
        if let Some(index) = index.as_ref().filter(|i| i.is_object()) {
            ids.extend(slides_of(&Some(index.clone())));
            for group in items(index.get("groups")).iter().filter_map(Value::as_str) {
                groups.push(Group {
                    id: group.to_owned(),
                    he: None,
                    en: None,
                });
            }
        }
        if let Some(managed) = managed.as_ref().filter(|m| m.is_object()) {
            ids.extend(slides_of(&Some(managed.clone())));
            for group in items(managed.get("groups"))
                .iter()
                .filter_map(Value::as_str)
            {
                let names = managed.pointer(&format!("/groupNames/{group}"));
                let name = |lang: &str| {
                    names
                        .and_then(|n| n.get(lang))
                        .and_then(Value::as_str)
                        .map(str::to_owned)
                };
                let entry = match groups.iter_mut().position(|g| g.id == group) {
                    Some(at) => &mut groups[at],
                    None => {
                        groups.push(Group {
                            id: group.to_owned(),
                            he: None,
                            en: None,
                        });
                        groups.last_mut().expect("just pushed")
                    }
                };
                if let Some(he) = name("he") {
                    entry.he = Some(he);
                }
                if let Some(en) = name("en") {
                    entry.en = Some(en);
                }
            }
        }
        ids.sort();
        ids.dedup();
        let count = |catalog: &Option<Value>| slides_of(catalog).len();
        let known = Known {
            groups,
            ids,
            managed: count(&managed),
            authored: count(&index),
            reachable,
        };
        *lock(&self.known) = Some((Instant::now(), known.clone()));
        known
    }

    /* -------------------------------------------------------------- the approved work */

    fn last_result(&self, variant: &Variant) -> Option<Value> {
        let revision = variant
            .render
            .as_ref()
            .map(|render| render.revision)
            .filter(|r| *r > 0)?;
        read_json::<Value>(&render_dir(&self.store.work_dir(variant), revision).join("result.json"))
            .filter(Value::is_object)
    }

    /// A design as its last render made it, and its picture as WebP.
    pub fn design_record(&self, variant: &Variant) -> Result<(Value, Vec<u8>), String> {
        let did = variant.design_id.clone().unwrap_or_default();
        let result = self
            .last_result(variant)
            .filter(|result| result.get("publishable").is_some_and(truthy))
            .ok_or_else(|| format!("{did}: its last render did not pass the checks."))?;
        // A slide for every language the design was rendered in, in the registry's order.
        let mut slides = Map::new();
        for lang in CONTENT_LANGUAGES {
            if let Some(slide) = result
                .pointer(&format!("/langs/{lang}/slide"))
                .filter(|slide| truthy(slide))
            {
                slides.insert(lang.to_owned(), slide.clone());
            }
        }
        if BASE_LANGUAGES
            .iter()
            .any(|lang| !slides.contains_key(*lang))
        {
            return Err(format!(
                "{did}: its last render has no Hebrew or English slide."
            ));
        }
        let (webp, (width, height)) = to_webp(&self.store.work_dir(variant).join("subject.png"))?;
        let brief = variant
            .brief
            .design()
            .ok_or_else(|| format!("{did}: its brief is not a design's."))?;
        let group_name = if truthy(&brief.group_name) {
            brief.group_name.clone()
        } else {
            json!({"he": brief.group, "en": brief.group})
        };
        let mut record = json!({
            "id": did,
            "name": brief.name,
            "group": brief.group,
            "groupName": group_name,
            "slides": slides,
            "subject": result.get("subject").cloned().unwrap_or(Value::Null),
            "size": [width, height],
        });
        let tags = serde_json::to_value(&brief.tags).ok();
        if let Some(tags) = design_tags(tags.as_ref()) {
            record["tags"] = json!(tags);
        }
        Ok((record, webp))
    }

    /// A template's sample in one language, as its last render built it.
    pub fn sample_record(&self, variant: &Variant) -> Result<(String, String, Value), String> {
        let template = variant.template_id.clone().unwrap_or_default();
        let lang = variant.lang.clone().unwrap_or_default();
        let place = format!("{template} · {lang}");
        let result = self
            .last_result(variant)
            .filter(|result| result.get("publishable").is_some_and(truthy))
            .ok_or_else(|| format!("{place}: its last render did not pass the checks."))?;
        let sample = result
            .get("sample")
            .filter(|sample| sample.as_array().is_some_and(|slides| !slides.is_empty()))
            .cloned()
            .ok_or_else(|| format!("{place}: its last render holds no sample."))?;
        Ok((template, lang, sample))
    }

    /// Sends approved work to the library's upload API (`uploads.rs`), one upload each: a design as
    /// `designs: add`, a template's sample as `templates: translate`. Each item says the upload it
    /// now waits as, or why the library did not take it; a variant keeps its upload
    /// (`variant.upload`), so it is not sent twice.
    pub async fn upload(&self, vids: &[String]) -> Vec<Value> {
        let (url, key) = {
            let remote = self.settings.remote();
            (remote.library_url.clone(), remote.library_key.clone())
        };
        let api = LibraryApi::new(&url, key);
        let mut results = Vec::new();
        for vid in vids {
            let Some(variant) = self.store.variant(vid) else {
                continue;
            };
            let sent = if variant.is_template() {
                match self.sample_record(&variant) {
                    Ok((template, lang, sample)) => api
                        .send(&sample_upload(&template, &lang, sample), &[])
                        .await
                        .map_err(|e| (e.message, e.issues)),
                    Err(error) => Err((error, Vec::new())),
                }
            } else {
                match self.design_record(&variant) {
                    Ok((record, webp)) => api
                        .send(&design_upload(&record), &[("picture", &webp, "image/webp")])
                        .await
                        .map_err(|e| (e.message, e.issues)),
                    Err(error) => Err((error, Vec::new())),
                }
            };
            let item = match sent {
                Ok(answer) => {
                    let id = answer
                        .get("id")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_owned();
                    let status = answer
                        .get("status")
                        .and_then(Value::as_str)
                        .map(str::to_owned);
                    self.store.update_variant(vid, |variant| {
                        variant.upload = Some(Upload {
                            id: id.clone(),
                            status: status.clone(),
                            at: now(),
                        });
                    });
                    json!({
                        "variantId": vid,
                        "uploadId": id,
                        "status": status,
                        "missing": answer.get("missing").cloned().unwrap_or_else(|| json!([])),
                    })
                }
                Err((error, issues)) => json!({"variantId": vid, "error": error, "issues": issues}),
            };
            results.push(item);
        }
        results
    }

    /* -------------------------------------------------------------- publishing the author copy */

    fn emit_state(&self) {
        (self.emit)(json!({"type": "publish", "publish": self.state()}));
    }

    fn log(&self, text: impl Into<String>) {
        {
            let mut state = lock(&self.state);
            state.log.push(LogLine {
                t: now(),
                text: text.into(),
            });
            if state.log.len() > LOG_LIMIT {
                let extra = state.log.len() - LOG_LIMIT;
                state.log.drain(..extra);
            }
        }
        self.emit_state();
    }

    fn set(&self, change: impl FnOnce(&mut PublishState)) {
        change(&mut lock(&self.state));
        self.emit_state();
    }

    fn media_dir(&self) -> Result<&Path, String> {
        self.settings.media_dir.as_deref().ok_or_else(|| {
            "No author copy of the library is named: set SLIDR_MEDIA_DIR.".to_owned()
        })
    }

    /// Writes a file of the author copy, remembering what was there to put it back.
    fn write(&self, path: &Path, data: &[u8]) -> Result<(), String> {
        let previous = fs::read(path).ok();
        lock(&self.undo).push((path.to_path_buf(), previous));
        write_atomic(path, data).map_err(|e| format!("{}: {e}", path.display()))
    }

    pub fn revert(&self) {
        let undo = std::mem::take(&mut *lock(&self.undo));
        for (path, previous) in undo.into_iter().rev() {
            let _ = match previous {
                None => fs::remove_file(&path),
                Some(bytes) => fs::write(&path, bytes),
            };
        }
    }

    /// Copies into the author copy the published files it lacks. A file it has is never touched:
    /// it may hold the author's work that is not published yet.
    async fn sync_missing(&self) -> Result<(), String> {
        let media = self.media_dir()?.to_path_buf();
        let manifest = self.published_json("manifest.json").await?;
        let Some(files) = manifest.as_ref().filter(|m| m.is_object()).map(|m| {
            m.get("files")
                .and_then(Value::as_object)
                .cloned()
                .unwrap_or_default()
        }) else {
            self.log("The library has never been published: nothing to copy.");
            return Ok(());
        };
        let missing: Vec<(String, Value)> = files
            .iter()
            .filter(|(path, _)| !media.join(path).exists())
            .map(|(path, info)| (path.clone(), info.clone()))
            .collect();
        if missing.is_empty() {
            self.log(format!(
                "The author copy has every one of the {} published files.",
                files.len()
            ));
            return Ok(());
        }
        let total: u64 = missing
            .iter()
            .map(|(_, info)| info.get("size").and_then(Value::as_u64).unwrap_or(0))
            .sum();
        self.log(format!(
            "Copying {} published files ({:.1} MB) the author copy lacks into {}, so that \
             publishing it keeps them.",
            missing.len(),
            total as f64 / 1024.0 / 1024.0,
            media.display()
        ));
        let slots = Arc::new(tokio::sync::Semaphore::new(8));
        for (done, chunk) in missing.chunks(40).enumerate() {
            let mut copies = tokio::task::JoinSet::new();
            for (path, info) in chunk {
                let (path, info) = (path.clone(), info.clone());
                let (url, target, slots) = (self.url(&path), media.join(&path), Arc::clone(&slots));
                copies.spawn(async move {
                    let data = {
                        let _slot = slots.acquire().await.map_err(|e| e.to_string())?;
                        net::fetch(&url, Duration::from_secs(120))
                            .await
                            .map_err(|e| e.to_string())?
                    };
                    if Some(sha256(&data).as_str()) != info.get("sha256").and_then(Value::as_str) {
                        return Err(format!("{path} does not match the published manifest."));
                    }
                    write_atomic(&target, &data).map_err(|e| e.to_string())
                });
            }
            while let Some(copied) = copies.join_next().await {
                copied.map_err(|e| e.to_string())??;
            }
            self.log(format!(
                "  {} of {} copied",
                ((done + 1) * 40).min(missing.len()),
                missing.len()
            ));
        }
        Ok(())
    }

    /// Writes approved designs into the managed catalog, which the studio alone writes: the
    /// published one is the base.
    async fn prepare_designs(&self, variants: &[Variant]) -> Result<(), String> {
        let media = self.media_dir()?.to_path_buf();
        let catalog = self
            .published_json(MANAGED)
            .await
            .map_err(|e| format!("Could not read the published {MANAGED}: {e}"))?;
        let mut catalog = catalog
            .filter(Value::is_object)
            .unwrap_or_else(empty_catalog);
        let held = catalog
            .get("slides")
            .and_then(Value::as_object)
            .map_or(0, Map::len);
        self.log(format!(
            "The published managed catalog holds {held} designs."
        ));
        for variant in variants {
            let (record, webp) = self.design_record(variant)?;
            let id = record["id"].as_str().unwrap_or_default().to_owned();
            self.write(
                &media.join("images/designs").join(format!("{id}.webp")),
                &webp,
            )?;
            merge_design(&mut catalog, &record);
            self.log(format!(
                "  {id}: {} → {} ({} KB picture)",
                record
                    .pointer("/name/en")
                    .and_then(Value::as_str)
                    .unwrap_or(""),
                record["group"].as_str().unwrap_or(""),
                webp.len() / 1024
            ));
        }
        self.write(&media.join(MANAGED), &encode_catalog(&catalog))
    }

    /// Writes approved samples into the author copy's catalog of templates, which may hold an
    /// author's work that is not published yet: that copy is the base, and nothing else of it
    /// changes. Returns that work, part by part (`catalog_changes`): the report counts the catalog
    /// as the studio's file, and this is what else the file sends.
    pub async fn prepare_samples(&self, variants: &[Variant]) -> Result<Vec<String>, String> {
        let path = self.media_dir()?.join(TEMPLATES);
        if !path.is_file() {
            return Err(format!("The author copy has no {TEMPLATES}."));
        }
        let text = fs::read_to_string(&path).map_err(|e| format!("{}: {e}", path.display()))?;
        let mut catalog: Value =
            serde_json::from_str(&text).map_err(|e| format!("{}: {e}", path.display()))?;
        let published = match self.published_json(TEMPLATES).await {
            Ok(published) => published,
            Err(_) => {
                // Without it, the file's other changes are not listed.
                self.log(format!(
                    "The published {TEMPLATES} could not be read: its other changes are not listed."
                ));
                None
            }
        };
        let ours: HashSet<(String, String)> = variants
            .iter()
            .map(|v| {
                (
                    v.template_id.clone().unwrap_or_default(),
                    v.lang.clone().unwrap_or_default(),
                )
            })
            .collect();
        let others = catalog_changes(&catalog, published.as_ref(), &ours);
        if !others.is_empty() {
            self.log(format!(
                "{TEMPLATES} of the author copy also holds work that is not published yet:"
            ));
            for change in &others {
                let part = change
                    .split_once(": ")
                    .map_or(change.as_str(), |(_, part)| part);
                self.log(format!("  {part}"));
            }
        }
        for variant in variants {
            let (template, lang, sample) = self.sample_record(variant)?;
            let slides = sample.as_array().map_or(0, Vec::len);
            merge_sample(&mut catalog, &template, &lang, sample)?;
            self.log(format!(
                "  {template}: the sample in {} ({slides} slides)",
                languages::name(&lang)
            ));
        }
        let data = encode_catalog(&catalog);
        let megabytes = data.len() as f64 / 1024.0 / 1024.0;
        if data.len() > FILE_LIMIT {
            return Err(format!(
                "{TEMPLATES} would be {megabytes:.1} MB; Pages serves a file of at most {} MB.",
                FILE_LIMIT / 1024 / 1024
            ));
        }
        self.write(&path, &data)?;
        self.log(format!("{TEMPLATES}: {megabytes:.1} MB."));
        Ok(others)
    }

    pub async fn prepare(self: &Arc<Self>, vids: &[String]) -> Result<(), String> {
        let variants = {
            let _turn = self.turn.lock().await;
            let phase = lock(&self.state).phase;
            if matches!(phase, Phase::Preparing | Phase::Publishing) {
                return Err("A publication is already in progress.".into());
            }
            if phase == Phase::Prepared {
                self.revert();
            }
            let variants: Vec<Variant> = vids
                .iter()
                .filter_map(|vid| self.store.variant(vid))
                .collect();
            if variants.is_empty() {
                return Err("Nothing approved to publish.".into());
            }
            *lock(&self.state) = PublishState::idle();
            let items: Vec<String> = variants.iter().map(|v| v.id.clone()).collect();
            self.set(|state| {
                state.phase = Phase::Preparing;
                state.items = items;
                state.at = Some(now());
            });
            variants
        };
        let library = Arc::clone(self);
        tauri::async_runtime::spawn(async move {
            if let Err(error) = library.prepare_steps(&variants).await {
                library.revert();
                library.log(format!("Failed: {error}"));
                library.set(|state| {
                    state.phase = Phase::Failed;
                    state.error = Some(error);
                });
            }
        });
        Ok(())
    }

    async fn prepare_steps(&self, variants: &[Variant]) -> Result<(), String> {
        let media = self.media_dir()?;
        if !media.is_dir() {
            return Err(format!(
                "There is no author copy of the library at {}.",
                media.display()
            ));
        }
        self.sync_missing().await?;
        let designs: Vec<Variant> = variants
            .iter()
            .filter(|v| !v.is_template())
            .cloned()
            .collect();
        let samples: Vec<Variant> = variants
            .iter()
            .filter(|v| v.is_template())
            .cloned()
            .collect();
        let mut ours: Vec<String> = Vec::new();
        // Work inside a file of ours that is not ours: an author's unpublished changes.
        let mut inside: Vec<String> = Vec::new();
        if !designs.is_empty() {
            self.prepare_designs(&designs).await?;
            ours.push(MANAGED.into());
            ours.extend(designs.iter().map(|v| {
                format!(
                    "images/designs/{}.webp",
                    v.design_id.clone().unwrap_or_default()
                )
            }));
        }
        if !samples.is_empty() {
            inside = self.prepare_samples(&samples).await?;
            ours.push(TEMPLATES.into());
        }
        let mut report = self.run_script(true).await?;
        ours.sort();
        ours.dedup();
        let mut unexpected: Vec<String> = ["added", "changed"]
            .iter()
            .flat_map(|key| items(report.get(*key)).iter().filter_map(Value::as_str))
            .filter(|path| !ours.iter().any(|ours| ours == path))
            .map(str::to_owned)
            .collect();
        unexpected.sort();
        unexpected.extend(inside);
        report["ours"] = json!(ours);
        report["unexpected"] = json!(unexpected);
        self.set(|state| {
            state.phase = Phase::Prepared;
            state.report = Some(report);
        });
        Ok(())
    }

    async fn run_script(&self, dry_run: bool) -> Result<Value, String> {
        let node = programs::find_node()
            .ok_or("Node.js was not found; it runs the publishing script.".to_owned())?;
        let script = self.settings.publish_script.clone().ok_or(
            "The publishing script is in the studio's repository: run the studio from it \
             (`pnpm tauri dev`) to publish the author copy."
                .to_owned(),
        )?;
        let vendor = script
            .ancestors()
            .nth(3)
            .map(Path::to_path_buf)
            .unwrap_or_default();
        let report_file = self.settings.data.join("publish").join("report.json");
        if let Some(parent) = report_file.parent() {
            let _ = fs::create_dir_all(parent);
        }
        let _ = fs::remove_file(&report_file);
        let media = self.media_dir()?;
        let mut command = programs::command(&node);
        command
            .arg(&script)
            .arg("--from")
            .arg(media)
            .arg("--report")
            .arg(&report_file)
            .current_dir(vendor)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        if dry_run {
            command.arg("--dry-run");
        }
        let token = {
            let remote = self.settings.remote();
            if !dry_run {
                let token = remote.cloudflare_token.clone().ok_or(
                    "No Cloudflare API token: enter one in the publishing panel.".to_owned(),
                )?;
                command
                    .env("CLOUDFLARE_API_TOKEN", &token)
                    .env("CLOUDFLARE_ACCOUNT_ID", &remote.cloudflare_account_id);
            }
            remote.cloudflare_token.clone()
        };
        let mut child = programs::spawn(&mut command).map_err(|e| e.to_string())?;
        let (Some(stdout), Some(stderr)) = (child.stdout.take(), child.stderr.take()) else {
            return Err("The publishing script started without its pipes.".into());
        };
        let said = |line: String| {
            let line = line.trim_end().to_owned();
            if line.is_empty() {
                return;
            }
            // The token never reaches the log, whatever a tool prints.
            match &token {
                Some(token) if !token.is_empty() => self.log(line.replace(token.as_str(), "***")),
                _ => self.log(line),
            }
        };
        let mut out = BufReader::new(stdout).lines();
        let mut err = BufReader::new(stderr).lines();
        let (mut out_open, mut err_open) = (true, true);
        while out_open || err_open {
            tokio::select! {
                line = out.next_line(), if out_open => match line {
                    Ok(Some(line)) => said(line),
                    _ => out_open = false,
                },
                line = err.next_line(), if err_open => match line {
                    Ok(Some(line)) => said(line),
                    _ => err_open = false,
                },
            }
        }
        let status = child.wait().await.map_err(|e| e.to_string())?;
        let report = read_json::<Value>(&report_file);
        if !status.success() {
            let blocked = report
                .as_ref()
                .and_then(|r| r.get("blocked"))
                .and_then(Value::as_str)
                .filter(|b| !b.is_empty())
                .map(str::to_owned);
            let code = status
                .code()
                .map_or_else(|| "none".to_owned(), |c| c.to_string());
            return Err(blocked.unwrap_or_else(|| {
                format!("The publishing script stopped with exit code {code}.")
            }));
        }
        report
            .filter(Value::is_object)
            .ok_or_else(|| "The publishing script wrote no report.".to_owned())
    }

    pub async fn confirm(self: &Arc<Self>) -> Result<(), String> {
        {
            let _turn = self.turn.lock().await;
            if lock(&self.state).phase != Phase::Prepared {
                return Err("Prepare the publication first, and read what it will change.".into());
            }
            if self.settings.remote().cloudflare_token.is_none() {
                return Err("No Cloudflare API token: enter one first.".into());
            }
            self.set(|state| state.phase = Phase::Publishing);
        }
        let library = Arc::clone(self);
        tauri::async_runtime::spawn(async move {
            if let Err(error) = library.publish_steps().await {
                library.revert();
                library.log(format!(
                    "Failed: {error}. The author copy was put back as it was."
                ));
                library.set(|state| {
                    state.phase = Phase::Failed;
                    state.error = Some(error);
                });
            }
        });
        Ok(())
    }

    async fn publish_steps(&self) -> Result<(), String> {
        self.run_script(false).await?;
        self.log("Deployed. Reading the published manifest back to check the files…");
        let media = self.media_dir()?.to_path_buf();
        let ours: Vec<String> = self
            .state()
            .report
            .as_ref()
            .map(|report| {
                items(report.get("ours"))
                    .iter()
                    .filter_map(Value::as_str)
                    .map(str::to_owned)
                    .collect()
            })
            .unwrap_or_default();
        let mut expected = Vec::new();
        for path in ours {
            let bytes = fs::read(media.join(&path)).map_err(|e| format!("{path}: {e}"))?;
            expected.push((path, sha256(&bytes)));
        }
        let mut missing: Vec<String> = expected.iter().map(|(path, _)| path.clone()).collect();
        for _attempt in 0..12 {
            let manifest = self.published_json("manifest.json").await.ok().flatten();
            let files = manifest.as_ref().and_then(|m| m.get("files"));
            missing = expected
                .iter()
                .filter(|(path, hash)| {
                    files
                        .and_then(|files| files.get(path))
                        .and_then(|file| file.get("sha256"))
                        .and_then(Value::as_str)
                        != Some(hash.as_str())
                })
                .map(|(path, _)| path.clone())
                .collect();
            if missing.is_empty() {
                break;
            }
            tokio::time::sleep(Duration::from_secs(5)).await;
        }
        if !missing.is_empty() {
            return Err(format!(
                "The deployment finished, but the published manifest does not have yet: {}",
                missing.join(", ")
            ));
        }
        let stamp = now();
        let items = self.state().items;
        for vid in &items {
            self.store.update_variant(vid, |variant| {
                variant.published = Some(Published {
                    at: stamp,
                    revision: variant.revision,
                });
                // Sent: it leaves the queue, and comes back only when approved again.
                variant.approved = false;
                variant.push_log("publish", "Published to the media library.");
            });
        }
        lock(&self.undo).clear();
        *lock(&self.known) = None;
        self.templates.forget().await;
        self.log(format!(
            "Published: {} items are in the library.",
            items.len()
        ));
        self.set(|state| {
            state.phase = Phase::Done;
            state.at = Some(stamp);
        });
        Ok(())
    }

    pub async fn cancel(&self) -> Result<(), String> {
        let _turn = self.turn.lock().await;
        if matches!(
            lock(&self.state).phase,
            Phase::Preparing | Phase::Publishing
        ) {
            return Err("Wait for this step to finish.".into());
        }
        self.revert();
        *lock(&self.state) = PublishState::idle();
        self.emit_state();
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        store::{
            Brief, NewVariant, RenderSummary, Request, RequestKind, VariantKind,
            tests::{design_brief, store},
            write_json,
        },
        templates::template_brief,
        templates::tests::{catalog, english, hebrew, listing_entry},
    };

    fn design(id: &str, group: &str, name: &str) -> Value {
        json!({
            "id": id,
            "name": {"he": name, "en": name},
            "group": group,
            "groupName": {"he": group, "en": group},
            "slides": {"he": {"id": "a"}, "en": {"id": "b"}},
            "subject": [1, 2],
            "size": [3, 4],
        })
    }

    fn png(path: &Path, width: u32, height: u32) {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).expect("a folder");
        }
        image::RgbImage::from_pixel(width, height, image::Rgb([10, 20, 30]))
            .save(path)
            .expect("a picture");
    }

    fn library(root: &Path, media: Option<PathBuf>) -> (Arc<Library>, Arc<Store>) {
        let settings = Arc::new(Settings::new(root.to_path_buf(), media.clone(), None));
        let store = Arc::new(store(&settings.requests_dir()));
        let templates = Arc::new(Templates::new(media, "http://127.0.0.1:9/".into()));
        let library = Library::new(settings, Arc::clone(&store), templates, Arc::new(|_| {}));
        (Arc::new(library), store)
    }

    #[test]
    fn merge_adds_replaces_and_moves_between_groups() {
        let mut catalog = empty_catalog();
        merge_design(&mut catalog, &design("m-a", "invites", "N"));
        merge_design(&mut catalog, &design("m-b", "invites", "N"));
        merge_design(&mut catalog, &design("m-c", "sales", "N"));
        assert_eq!(catalog["groups"], json!(["invites", "sales"]));
        assert_eq!(
            catalog["groupIds"],
            json!({"invites": ["m-a", "m-b"], "sales": ["m-c"]})
        );
        // Replaced in place, names and all.
        merge_design(&mut catalog, &design("m-a", "invites", "New"));
        assert_eq!(catalog["groupIds"]["invites"], json!(["m-a", "m-b"]));
        assert_eq!(catalog["names"]["m-a"], json!({"he": "New", "en": "New"}));
        // A design has one group; a group left empty goes.
        merge_design(&mut catalog, &design("m-c", "invites", "N"));
        assert_eq!(catalog["groups"], json!(["invites"]));
        assert_eq!(
            catalog["groupIds"],
            json!({"invites": ["m-a", "m-b", "m-c"]})
        );
        assert!(catalog["groupNames"].get("sales").is_none());
        assert_eq!(catalog["sizes"]["m-c"], json!([3, 4]));
        assert_eq!(catalog["subjects"]["m-c"], json!([1, 2]));
    }

    #[test]
    fn merge_keeps_the_names_a_group_was_published_with() {
        let mut catalog = empty_catalog();
        let mut first = design("m-a", "invites", "N");
        first["groupName"] = json!({"he": "הזמנות", "en": "Invitations"});
        merge_design(&mut catalog, &first);
        let mut second = design("m-b", "invites", "N");
        second["groupName"] = json!({"he": "אחר", "en": "Other"});
        merge_design(&mut catalog, &second);
        assert_eq!(
            catalog["groupNames"]["invites"],
            json!({"he": "הזמנות", "en": "Invitations"})
        );
    }

    #[test]
    fn merge_writes_the_tags_of_a_design_and_drops_them_when_it_has_none() {
        let mut catalog = empty_catalog();
        let mut tagged = design("m-a", "invites", "N");
        tagged["tags"] = json!({"he": ["יום הולדת"], "en": ["birthday"]});
        merge_design(&mut catalog, &tagged);
        assert_eq!(
            catalog["tags"],
            json!({"m-a": {"he": ["יום הולדת"], "en": ["birthday"]}})
        );
        merge_design(&mut catalog, &design("m-a", "invites", "N"));
        assert_eq!(catalog["tags"], json!({}));
        // A catalog published before there were tags gets the key.
        let mut old = empty_catalog();
        old.as_object_mut().map(|o| o.shift_remove("tags"));
        merge_design(&mut old, &design("m-b", "invites", "N"));
        assert!(old.get("tags").is_some());
    }

    #[test]
    fn webp_keeps_the_size() {
        let dir = tempfile::tempdir().expect("a folder");
        let path = dir.path().join("subject.png");
        png(&path, 64, 36);
        let (data, size) = to_webp(&path).expect("a WebP");
        assert_eq!(&data[..4], b"RIFF");
        assert_eq!(&data[8..12], b"WEBP");
        assert_eq!(size, (64, 36));
    }

    #[test]
    fn tags_are_kept_clean_and_in_their_own_letters() {
        let tags = design_tags(Some(&json!({
            "he": ["יוֹם הולדת", "יום הולדת", "birthday", "מסיבה", " עוגה ", 7],
            "en": ["Birthday", "kids  party", "מסיבה", "cake", "x".repeat(41)],
        })));
        assert_eq!(
            tags,
            Some(Tags {
                he: vec!["יום הולדת".into(), "מסיבה".into(), "עוגה".into()],
                en: vec!["birthday".into(), "kids party".into(), "cake".into()],
            })
        );
        assert_eq!(
            design_tags(Some(&json!({"he": ["א", "ב"], "en": ["a", "b", "c"]}))),
            None
        );
        assert_eq!(design_tags(None), None);
        assert_eq!(design_tags(Some(&json!({"he": "יום"}))), None);
    }

    #[test]
    fn a_design_is_published_with_a_slide_for_every_language() {
        let dir = tempfile::tempdir().expect("a folder");
        let (library, store) = library(dir.path(), None);
        let mut draft = Request::draft(RequestKind::Design, "x".into());
        draft.languages = Some(vec!["he".into(), "en".into(), "ar".into(), "zh-CN".into()]);
        let request = store.create_request(draft);
        let variant = store
            .create_variant(&request.id, design_brief(), NewVariant::default())
            .expect("a variant");
        let work = store.work_dir(&variant);
        png(&work.join("subject.png"), 64, 36);
        let variant = store
            .update_variant(&variant.id, |v| {
                v.render = Some(RenderSummary {
                    revision: 1,
                    ..RenderSummary::default()
                });
                v.clone()
            })
            .expect("updated");
        let mut sides = json!({});
        for lang in ["zh-CN", "en", "ar", "he"] {
            sides[lang] = json!({"slide": {"id": lang}, "issues": [], "findings": []});
        }
        let result =
            |sides: &Value| json!({"publishable": true, "langs": sides, "subject": [5, 6]});
        write_json(&work.join("renders/r1/result.json"), &result(&sides)).expect("written");
        let (record, webp) = library.design_record(&variant).expect("a record");
        let order: Vec<&String> = record["slides"]
            .as_object()
            .map(|s| s.keys().collect())
            .unwrap_or_default();
        assert_eq!(order, ["he", "en", "ar", "zh-CN"]);
        assert_eq!(record["slides"]["zh-CN"], json!({"id": "zh-CN"}));
        assert_eq!(record["name"], json!({"he": "שם", "en": "Name"}));
        assert_eq!(record["groupName"], json!({"he": "ק", "en": "G"}));
        assert_eq!(record["size"], json!([64, 36]));
        assert_eq!(&webp[..4], b"RIFF");
        let mut merged = empty_catalog();
        merge_design(&mut merged, &record);
        assert_eq!(merged["slides"]["m-x"].as_object().map(Map::len), Some(4));
        // A brief from before there were tags publishes none; one with them, its tags.
        assert!(record.get("tags").is_none() && merged["tags"] == json!({}));
        let mut tagged = variant.clone();
        if let Brief::Design(brief) = &mut tagged.brief {
            brief.tags = Tags {
                he: vec!["הזמנה".into(), "מסיבה".into(), "אירוע".into()],
                en: vec!["Invitation".into(), "party".into(), "event".into()],
            };
        }
        let (record, _) = library.design_record(&tagged).expect("a record");
        assert_eq!(
            record["tags"],
            json!({"he": ["הזמנה", "מסיבה", "אירוע"], "en": ["invitation", "party", "event"]})
        );
        // Without the English slide it is not published.
        sides.as_object_mut().map(|s| s.shift_remove("en"));
        write_json(&work.join("renders/r1/result.json"), &result(&sides)).expect("written");
        assert!(library.design_record(&variant).is_err());
    }

    #[tokio::test]
    async fn an_approved_sample_is_published_into_the_author_copys_catalog() {
        let dir = tempfile::tempdir().expect("a folder");
        let media = dir.path().join("media");
        // The author copy: the published catalog, with a German sample the author added since.
        let mut local = catalog();
        local["samples"]["mifgash"]["de"] = english();
        write_json(&media.join(TEMPLATES), &local).expect("written");
        let (library, store) = library(&dir.path().join("data"), Some(media.clone()));
        let mut draft = Request::draft(RequestKind::Template, String::new());
        draft.template_id = Some("mifgash".into());
        draft.languages = Some(vec!["ar".into()]);
        let request = store.create_request(draft);
        let entry = listing_entry();
        let brief = template_brief(&entry, entry.name.clone(), "ar", "");
        let variant = store
            .create_variant(
                &request.id,
                Brief::Template(brief),
                NewVariant {
                    kind: VariantKind::Template,
                    template_id: Some("mifgash".into()),
                    lang: Some("ar".into()),
                    languages: Some(vec!["ar".into()]),
                },
            )
            .expect("a variant");
        let variant = store
            .update_variant(&variant.id, |v| {
                v.render = Some(RenderSummary {
                    revision: 2,
                    ..RenderSummary::default()
                });
                v.clone()
            })
            .expect("updated");
        let result = store.work_dir(&variant).join("renders/r2/result.json");
        write_json(&result, &json!({"publishable": false, "sample": english()})).expect("written");
        let refused = library
            .prepare_samples(std::slice::from_ref(&variant))
            .await;
        assert!(refused.is_err_and(|e| e.contains("did not pass")));
        write_json(&result, &json!({"publishable": true, "sample": hebrew()})).expect("written");
        // The published catalog is out of reach here: the author's German sample is not listed,
        // and goes with the file as it is.
        library
            .prepare_samples(std::slice::from_ref(&variant))
            .await
            .expect("prepared");
        let written: Value =
            serde_json::from_str(&fs::read_to_string(media.join(TEMPLATES)).expect("the catalog"))
                .expect("JSON");
        let order: Vec<&String> = written["samples"]["mifgash"]
            .as_object()
            .map(|s| s.keys().collect())
            .unwrap_or_default();
        assert_eq!(order, ["he", "en", "ar", "de"]);
        assert_eq!(written["samples"]["mifgash"]["ar"], hebrew());
        assert_eq!(written["samples"]["mifgash"]["de"], english());
        // Cancelling puts the author copy back as it was.
        library.revert();
        let restored: Value =
            serde_json::from_str(&fs::read_to_string(media.join(TEMPLATES)).expect("the catalog"))
                .expect("JSON");
        assert!(restored["samples"]["mifgash"].get("ar").is_none());
    }
}
