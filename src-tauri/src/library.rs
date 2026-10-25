//! The media library: what is published, and the studio's work sent to it.
//!
//! The studio reads the published library, as the app reads it (`SLIDR_MEDIA_URL`): the groups and
//! ids of its designs, for planning, and the catalog of templates (`templates.rs`). It keeps no copy
//! of it, and never writes it.
//!
//! Its approved work goes to Slidr Library's upload API (`uploads.rs`; the library's README,
//! "Uploading"): a design as `designs: add`, a template's sample as `templates: translate`. The
//! library checks each against what it publishes, and keeps it until an editor accepts it. A
//! publication then writes the accepted uploads into the library, through the library's API too
//! (`POST /api/publish`; README, "Publishing the uploads"): the library lives in its Worker's
//! bucket, and every app reads it from there. The studio asks for one from its Publish panel, with
//! its key, and marks the variants whose uploads it published.

use std::{
    collections::HashSet,
    path::Path,
    sync::{Arc, Mutex, MutexGuard, PoisonError},
    time::{Duration, Instant},
};

use serde::Serialize;
use serde_json::{Map, Value, json};

use crate::{
    config::Settings,
    languages::{BASE_LANGUAGES, CONTENT_LANGUAGES},
    net::{self, FetchError},
    prompts::{items, truthy},
    render::render_dir,
    store::{Published, Store, Tags, Upload, Variant, now, read_json},
    templates::Templates,
    uploads::{LibraryApi, Transport, design_upload, https, sample_upload},
};

pub const MANAGED: &str = "elements/designs/managed.json";
pub const INDEX: &str = "elements/designs/index.json";
/// Most search tags kept in a language, and fewest a language must have for any to be kept.
const MOST_TAGS: usize = 20;
const FEWEST_TAGS: usize = 3;
/// Most uploads a publication may name.
pub const MOST_PUBLISHED: usize = 50;

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

/// The gallery's groups and design ids, as published, for planning.
#[derive(Debug, Clone, Serialize)]
pub struct Known {
    pub groups: Vec<Group>,
    pub ids: Vec<String>,
    pub managed: usize,
    pub authored: usize,
    pub reachable: bool,
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

pub struct Library {
    settings: Arc<Settings>,
    store: Arc<Store>,
    templates: Arc<Templates>,
    /// How the library's API is reached: over HTTPS, or a test's stand-in.
    transport: Arc<dyn Transport>,
    known: Mutex<Option<(Instant, Known)>>,
}

impl Library {
    pub fn new(settings: Arc<Settings>, store: Arc<Store>, templates: Arc<Templates>) -> Self {
        Self::with(settings, store, templates, https())
    }

    pub fn with(
        settings: Arc<Settings>,
        store: Arc<Store>,
        templates: Arc<Templates>,
        transport: Arc<dyn Transport>,
    ) -> Self {
        Self {
            settings,
            store,
            templates,
            transport,
            known: Mutex::new(None),
        }
    }

    /// The library's API, at its address, with the studio's token as it is now.
    fn api(&self) -> LibraryApi {
        let remote = self.settings.remote();
        LibraryApi::with(
            &remote.library_url,
            remote.library_token.clone(),
            Arc::clone(&self.transport),
        )
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

    /// The gallery's groups and design ids, as published, for planning.
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
        let slides_of = |catalog: Option<&Value>| {
            catalog
                .and_then(|c| c.get("slides"))
                .and_then(Value::as_object)
                .map(|slides| slides.keys().cloned().collect::<Vec<_>>())
                .unwrap_or_default()
        };
        if let Some(index) = index.as_ref().filter(|i| i.is_object()) {
            ids.extend(slides_of(Some(index)));
            for group in items(index.get("groups")).iter().filter_map(Value::as_str) {
                groups.push(Group {
                    id: group.to_owned(),
                    he: None,
                    en: None,
                });
            }
        }
        if let Some(managed) = managed.as_ref().filter(|m| m.is_object()) {
            ids.extend(slides_of(Some(managed)));
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
                let at = match groups.iter().position(|g| g.id == group) {
                    Some(at) => at,
                    None => {
                        groups.push(Group {
                            id: group.to_owned(),
                            he: None,
                            en: None,
                        });
                        groups.len() - 1
                    }
                };
                if let Some(he) = name("he") {
                    groups[at].he = Some(he);
                }
                if let Some(en) = name("en") {
                    groups[at].en = Some(en);
                }
            }
        }
        ids.sort();
        ids.dedup();
        let known = Known {
            groups,
            ids,
            managed: slides_of(managed.as_ref()).len(),
            authored: slides_of(index.as_ref()).len(),
            reachable,
        };
        *lock(&self.known) = Some((Instant::now(), known.clone()));
        known
    }

    /* -------------------------------------------------------------- the work, as uploads */

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
        let api = self.api();
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

    /* -------------------------------------------------------------- into the library */

    /// Where the published library is, when it was published, and how many uploads wait.
    pub async fn state(&self) -> Result<Value, String> {
        self.api().library().await.map_err(|e| e.message)
    }

    /// The uploads the library's editors accepted, which the next publication takes.
    pub async fn accepted(&self) -> Result<Vec<Value>, String> {
        self.api().accepted().await.map_err(|e| e.message)
    }

    /// Asks the library to publish its accepted uploads (or those named), and marks each variant
    /// whose upload it published: it leaves the queue, as published.
    pub async fn publish(&self, upload_ids: Option<&[String]>) -> Result<Value, String> {
        let done = self
            .api()
            .publish(upload_ids)
            .await
            .map_err(|e| e.message)?;
        let published: HashSet<&str> = items(done.get("uploads"))
            .iter()
            .filter_map(|upload| upload.get("id").and_then(Value::as_str))
            .collect();
        if !published.is_empty() {
            let stamp = now();
            let when = done.get("published").map_or_else(
                || "None".to_owned(),
                |when| crate::prompts::show(Some(when)),
            );
            for variant in self.store.variants() {
                let Some(upload) = variant
                    .upload
                    .as_ref()
                    .filter(|upload| published.contains(upload.id.as_str()))
                else {
                    continue;
                };
                let upload = Upload {
                    status: Some("published".into()),
                    ..upload.clone()
                };
                self.store.update_variant(&variant.id, |variant| {
                    variant.upload = Some(upload);
                    variant.published = Some(Published {
                        at: stamp,
                        revision: variant.revision,
                    });
                    variant.approved = false;
                    variant.push_log(
                        "publish",
                        format!("Published to the media library ({when})."),
                    );
                });
            }
            *lock(&self.known) = None;
            self.templates.forget().await;
        }
        Ok(done)
    }
}

#[cfg(test)]
mod tests {
    use std::fs;

    use super::*;
    use crate::{
        store::{
            Brief, NewVariant, RenderSummary, Request, RequestKind,
            tests::{design_brief, store},
            write_json,
        },
        uploads::tests::Pages,
    };

    fn png(path: &Path, width: u32, height: u32) {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).expect("a folder");
        }
        image::RgbImage::from_pixel(width, height, image::Rgb([10, 20, 30]))
            .save(path)
            .expect("a picture");
    }

    fn library(root: &Path, transport: Arc<dyn Transport>) -> (Library, Arc<Store>) {
        let settings = Arc::new(Settings::new(root.to_path_buf(), Some("a-key".into())));
        let store = Arc::new(store(&settings.requests_dir()));
        let templates = Arc::new(Templates::new("http://127.0.0.1:9/".into()));
        let library = Library::with(settings, Arc::clone(&store), templates, transport);
        (library, store)
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
    fn a_design_is_uploaded_with_a_slide_for_every_language() {
        let dir = tempfile::tempdir().expect("a folder");
        let (library, store) = library(dir.path(), Pages::new(&[]));
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
        // A brief from before there were tags has none; one with them, its tags.
        assert!(record.get("tags").is_none());
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
        // Without the English slide it is not uploaded.
        sides.as_object_mut().map(|s| s.shift_remove("en"));
        write_json(&work.join("renders/r1/result.json"), &result(&sides)).expect("written");
        assert!(library.design_record(&variant).is_err());
    }

    #[tokio::test]
    async fn a_publication_marks_the_variants_whose_uploads_it_published() {
        let dir = tempfile::tempdir().expect("a folder");
        let pages = Pages::new(&[(
            "POST",
            "/api/publish",
            200,
            json!({"published": "2026-10-21T00:00:01.000Z", "uploads": [{"id": "u-1"}],
                   "skipped": [{"id": "u-2", "message": "It is pending."}]}),
        )]);
        let (library, store) = library(dir.path(), pages.clone());
        let request = store.create_request(Request::draft(RequestKind::Design, "x".into()));
        let sent_upload = |id: &str, status: &str| Upload {
            id: id.into(),
            status: Some(status.into()),
            at: 1.0,
        };
        let sent = store
            .create_variant(&request.id, design_brief(), NewVariant::default())
            .expect("a variant");
        store.update_variant(&sent.id, |v| {
            v.approved = true;
            v.upload = Some(sent_upload("u-1", "accepted"));
        });
        let other = store
            .create_variant(&request.id, design_brief(), NewVariant::default())
            .expect("a variant");
        store.update_variant(&other.id, |v| {
            v.approved = true;
            v.upload = Some(sent_upload("u-2", "pending"));
        });
        let done = library.publish(None).await.expect("published");
        assert_eq!(done["skipped"][0]["id"], "u-2");
        assert_eq!(pages.sent.lock().expect("the log")[0].2, b"{}");
        // Published, it leaves the queue; the other waits as it was.
        let sent = store.variant(&sent.id).expect("the variant");
        assert!(sent.published.is_some() && !sent.approved);
        assert_eq!(
            sent.upload.and_then(|u| u.status).as_deref(),
            Some("published")
        );
        assert!(
            sent.log
                .last()
                .is_some_and(|line| line.text.contains("2026-10-21T00:00:01.000Z"))
        );
        let other = store.variant(&other.id).expect("the variant");
        assert!(other.approved && other.published.is_none());
    }

    #[tokio::test]
    async fn without_its_token_the_studio_says_so() {
        let dir = tempfile::tempdir().expect("a folder");
        let settings = Arc::new(Settings::new(dir.path().to_path_buf(), None));
        if settings.remote().library_token.is_some() {
            // SLIDR_LIBRARY_TOKEN is set where the tests run.
            return;
        }
        let store = Arc::new(store(&settings.requests_dir()));
        let templates = Arc::new(Templates::new("http://127.0.0.1:9/".into()));
        let library = Library::with(settings, store, templates, Pages::new(&[]));
        for refused in [
            library.state().await.err(),
            library.accepted().await.err(),
            library.publish(None).await.err(),
        ] {
            assert!(refused.is_some_and(|e| e.contains("no token")));
        }
    }
}
