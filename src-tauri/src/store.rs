//! Requests (the studio's tabs) and their variants, kept as JSON files.
//!
//! ```text
//! <data>/requests/<rid>/request.json          the request: kind, prompt, options, languages, plan,
//!                                             variants
//! <data>/requests/<rid>/plan/                 the folder of the planning call (and of the call that
//!                                             reads a request in words)
//! <data>/requests/<rid>/<vid>/state.json      a variant: kind, languages, stage, log, renders, approval
//! <data>/requests/<rid>/<vid>/work/           Claude's folder. A design: brief.json, an HTML file for
//!                                             each language (he.html, en.html, ar.html…),
//!                                             subject.png. A template's sample in one language:
//!                                             brief.json, template.md, en.json, he.json, <lang>.json
//!                                             (templates.rs). Both: renders/r<n>/
//! ```
//!
//! A request's `kind` is `design`, or `template` (the sample of a built-in template, written in
//! languages: a variant a language). A request stored before there were kinds is a design. A design
//! request's `languages` are those its designs are made in (`languages.rs`); a request or variant
//! stored before there was a choice has none, and is made in Hebrew and English. A template
//! request's `languages` are the languages its sample is written in, a variant each.
//!
//! State files are outside the folder Claude works in, so nothing it writes can change them. Every
//! change is written at once and sent to the studio's window (`Emit`).

use std::{
    collections::{HashMap, HashSet},
    fs, io,
    path::{Path, PathBuf},
    sync::{Arc, Mutex, MutexGuard, PoisonError},
    time::{SystemTime, UNIX_EPOCH},
};

use serde::{Deserialize, Serialize, de::DeserializeOwned};
use serde_json::{Map, Value, json};

use crate::languages;

/// Entries a variant's log keeps.
const LOG_LIMIT: usize = 400;

/// Where a change goes: the studio's window, or nowhere in a test.
pub type Emit = Arc<dyn Fn(Value) + Send + Sync>;

/// Seconds since the epoch, to the millisecond.
pub fn now() -> f64 {
    let seconds = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0.0, |elapsed| elapsed.as_secs_f64());
    (seconds * 1000.0).round() / 1000.0
}

/// `r2510251305` and six hex digits: the local time it was made at, then chance.
pub fn new_id(prefix: &str) -> String {
    let stamp = chrono::Local::now().format("%y%m%d%H%M%S");
    let chance: String = uuid::Uuid::new_v4().as_bytes()[..3]
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    format!("{prefix}{stamp}{chance}")
}

/// JSON indented by one space, as the studio has always written its files.
pub fn to_json_indented(data: &impl Serialize) -> String {
    let mut out = Vec::new();
    let formatter = serde_json::ser::PrettyFormatter::with_indent(b" ");
    let mut serializer = serde_json::Serializer::with_formatter(&mut out, formatter);
    // Serializing a value of the studio's own types cannot fail.
    if data.serialize(&mut serializer).is_err() {
        return "null".into();
    }
    String::from_utf8(out).unwrap_or_default()
}

/// Writes `data` beside the file, then puts it in the file's place.
pub fn write_json(path: &Path, data: &impl Serialize) -> io::Result<()> {
    write_atomic(path, to_json_indented(data).as_bytes())
}

pub fn write_atomic(path: &Path, bytes: &[u8]) -> io::Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let mut temp = path.as_os_str().to_owned();
    temp.push(".tmp");
    let temp = PathBuf::from(temp);
    fs::write(&temp, bytes)?;
    fs::rename(&temp, path)
}

/// A JSON file read as `T`; None when it is missing or is not one.
pub fn read_json<T: DeserializeOwned>(path: &Path) -> Option<T> {
    let text = fs::read_to_string(path).ok()?;
    serde_json::from_str(&text).ok()
}

fn empty_object() -> Value {
    Value::Object(Map::new())
}

fn two() -> u32 {
    2
}

/* ------------------------------------------------------------------ kinds and states */

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RequestKind {
    /// Designs for the gallery; every request from before there were kinds.
    #[default]
    Design,
    /// The sample of a built-in template, written in languages.
    Template,
    /// A request in words that Claude reads first; it becomes one of the two.
    Auto,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RequestStatus {
    Planning,
    Ready,
    Failed,
    Cancelled,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum VariantKind {
    #[default]
    Design,
    Template,
}

/// The stages a variant can be in. `Ready`, `Failed` and `Cancelled` are at rest.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum VariantStatus {
    Queued,
    Image,
    Writing,
    Rendering,
    Reviewing,
    Ready,
    Failed,
    Cancelled,
}

impl VariantStatus {
    pub fn running(self) -> bool {
        matches!(
            self,
            Self::Queued | Self::Image | Self::Writing | Self::Rendering | Self::Reviewing
        )
    }
}

/* ------------------------------------------------------------------ requests */

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Route {
    pub kind: Option<String>,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Request {
    pub id: String,
    pub created_at: f64,
    pub updated_at: f64,
    pub status: RequestStatus,
    #[serde(default)]
    pub variant_ids: Vec<String>,
    pub error: Option<String>,
    /// The concepts planned so far.
    pub plan: Option<Vec<Value>>,
    #[serde(default)]
    pub cost: f64,
    /// What to make, in words.
    #[serde(default)]
    pub prompt: String,
    #[serde(default)]
    pub kind: RequestKind,
    #[serde(default)]
    pub title: String,
    /// A design request's concepts to plan at first.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub count: Option<u32>,
    /// The gallery group a design request files its designs under; none chosen is empty.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub group: Option<String>,
    #[serde(default)]
    pub model: String,
    #[serde(default)]
    pub effort: String,
    #[serde(default = "two")]
    pub review_rounds: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub languages: Option<Vec<String>>,
    /// A template request's template, and what the person asked beyond writing it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub template_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub instructions: Option<String>,
    /// How a request in words was read.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub route: Option<Route>,
    /// What an older or newer studio wrote that this one does not read, kept as it was.
    #[serde(flatten)]
    pub rest: Map<String, Value>,
}

impl Request {
    /// A request as it is asked for, before the store gives it an id.
    pub fn draft(kind: RequestKind, prompt: String) -> Self {
        Self {
            id: String::new(),
            created_at: 0.0,
            updated_at: 0.0,
            status: RequestStatus::Planning,
            variant_ids: Vec::new(),
            error: None,
            plan: None,
            cost: 0.0,
            prompt,
            kind,
            title: String::new(),
            count: None,
            group: None,
            model: String::new(),
            effort: String::new(),
            review_rounds: 2,
            languages: None,
            template_id: None,
            instructions: None,
            route: None,
            rest: Map::new(),
        }
    }

    pub fn fail(&mut self, error: impl Into<String>) {
        self.status = RequestStatus::Failed;
        self.error = Some(error.into());
    }
}

/* ------------------------------------------------------------------ variants */

/// A name in the gallery: in Hebrew and English, whatever languages the design is made in.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Named {
    pub he: String,
    pub en: String,
}

/// The search tags of a design, in Hebrew and English (ADR-108 of the app).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Tags {
    #[serde(default)]
    pub he: Vec<String>,
    #[serde(default)]
    pub en: Vec<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ImageBrief {
    #[serde(default)]
    pub prompt: String,
    #[serde(default)]
    pub aspect: String,
}

/// A design's concept, as it was planned and as Claude changes it in `brief.json`.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesignBrief {
    pub id: String,
    pub name: Named,
    #[serde(default)]
    pub group: String,
    /// `{he, en}`, or `{}` when the plan named none.
    #[serde(default = "empty_object")]
    pub group_name: Value,
    #[serde(default)]
    pub tags: Tags,
    #[serde(default)]
    pub concept: String,
    #[serde(default)]
    pub art: String,
    /// The words of the slide in each language of the design.
    #[serde(default = "empty_object")]
    pub copy: Value,
    #[serde(default)]
    pub image: ImageBrief,
}

/// A template variant's task: the template, its names, the language, the person's words.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TemplateBrief {
    pub template_id: String,
    pub name: Named,
    #[serde(default = "empty_object")]
    pub tagline: Value,
    pub lang: String,
    pub language: String,
    pub dir: String,
    #[serde(default)]
    pub rewrite: bool,
    #[serde(default)]
    pub instructions: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum Brief {
    Template(TemplateBrief),
    Design(DesignBrief),
}

impl Brief {
    pub fn name(&self) -> &Named {
        match self {
            Self::Template(brief) => &brief.name,
            Self::Design(brief) => &brief.name,
        }
    }

    pub fn design(&self) -> Option<&DesignBrief> {
        match self {
            Self::Design(brief) => Some(brief),
            Self::Template(_) => None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LogEntry {
    pub t: f64,
    pub kind: String,
    pub text: String,
}

/// What the last render found, in short.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct RenderSummary {
    pub revision: u32,
    pub image_revision: u32,
    pub publishable: bool,
    pub errors: usize,
    pub warnings: usize,
    pub issues: usize,
    /// The share of each language's slide that converted to editable elements.
    pub editability: Map<String, Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImageInfo {
    pub width: u32,
    pub height: u32,
    pub revision: u32,
    pub prompt: String,
    pub aspect: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Published {
    pub at: f64,
    pub revision: u32,
}

/// The upload a variant was sent to the library as.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Upload {
    pub id: String,
    pub status: Option<String>,
    pub at: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Variant {
    pub id: String,
    pub request_id: String,
    pub index: usize,
    #[serde(default)]
    pub kind: VariantKind,
    /// A design's id in the gallery; a template's sample has none.
    pub design_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub template_id: Option<String>,
    /// A template variant's language.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lang: Option<String>,
    pub brief: Brief,
    /// The languages it is made in, its request's; none on a variant from before there was a
    /// choice.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub languages: Option<Vec<String>>,
    pub status: VariantStatus,
    pub stage: Option<String>,
    pub error: Option<String>,
    #[serde(default)]
    pub log: Vec<LogEntry>,
    /// The variant's Claude conversation.
    pub session_id: Option<String>,
    #[serde(default)]
    pub revision: u32,
    pub render: Option<RenderSummary>,
    #[serde(default)]
    pub image_revision: u32,
    pub image: Option<ImageInfo>,
    #[serde(default)]
    pub reviews: u32,
    #[serde(default)]
    pub approved: bool,
    #[serde(default)]
    pub discarded: bool,
    pub published: Option<Published>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub upload: Option<Upload>,
    #[serde(default)]
    pub cost: f64,
    pub created_at: f64,
    pub updated_at: f64,
    #[serde(flatten)]
    pub rest: Map<String, Value>,
}

impl Variant {
    pub fn is_template(&self) -> bool {
        self.kind == VariantKind::Template
    }

    pub fn push_log(&mut self, kind: &str, text: impl Into<String>) {
        self.log.push(LogEntry {
            t: now(),
            kind: kind.to_owned(),
            text: text.into(),
        });
        if self.log.len() > LOG_LIMIT {
            let extra = self.log.len() - LOG_LIMIT;
            self.log.drain(..extra);
        }
    }
}

/// What a variant is made as, beside its brief.
#[derive(Debug, Clone, Default)]
pub struct NewVariant {
    pub kind: VariantKind,
    pub template_id: Option<String>,
    pub lang: Option<String>,
    /// Its languages; by default its request's.
    pub languages: Option<Vec<String>>,
}

/* ------------------------------------------------------------------ the store */

#[derive(Default)]
struct State {
    requests: HashMap<String, Request>,
    variants: HashMap<String, Variant>,
}

pub struct Store {
    root: PathBuf,
    emit: Emit,
    state: Mutex<State>,
}

impl Store {
    pub fn new(root: PathBuf, emit: Emit) -> Self {
        Self {
            root,
            emit,
            state: Mutex::new(State::default()),
        }
    }

    fn state(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /* -------------------------------------------------------------- places */

    pub fn request_dir(&self, rid: &str) -> PathBuf {
        self.root.join(rid)
    }

    pub fn variant_dir(&self, variant: &Variant) -> PathBuf {
        self.root.join(&variant.request_id).join(&variant.id)
    }

    pub fn work_dir(&self, variant: &Variant) -> PathBuf {
        self.variant_dir(variant).join("work")
    }

    /* -------------------------------------------------------------- loading */

    /// Reads what was there. A variant that was running when the studio stopped is told so.
    pub fn load(&self) {
        let Ok(entries) = fs::read_dir(&self.root) else {
            return;
        };
        let mut folders: Vec<PathBuf> = entries.flatten().map(|entry| entry.path()).collect();
        folders.sort();
        let mut state = self.state();
        for folder in folders {
            let Some(mut request) = read_json::<Request>(&folder.join("request.json")) else {
                continue;
            };
            if request.status == RequestStatus::Planning {
                request.fail("The studio stopped while the concepts were being planned.");
            }
            for vid in &request.variant_ids {
                let Some(mut variant) = read_json::<Variant>(&folder.join(vid).join("state.json"))
                else {
                    continue;
                };
                if variant.status.running() {
                    variant.error = Some(
                        "The studio stopped while this was running. Retry continues it.".into(),
                    );
                    variant.status = VariantStatus::Failed;
                }
                state.variants.insert(vid.clone(), variant);
            }
            state.requests.insert(request.id.clone(), request);
        }
    }

    /* -------------------------------------------------------------- reading */

    pub fn request(&self, rid: &str) -> Option<Request> {
        self.state().requests.get(rid).cloned()
    }

    /// Every request, the oldest first.
    pub fn requests(&self) -> Vec<Request> {
        let mut requests: Vec<Request> = self.state().requests.values().cloned().collect();
        requests.sort_by(|a, b| a.created_at.total_cmp(&b.created_at));
        requests
    }

    pub fn variant(&self, vid: &str) -> Option<Variant> {
        self.state().variants.get(vid).cloned()
    }

    pub fn variants(&self) -> Vec<Variant> {
        self.state().variants.values().cloned().collect()
    }

    /// The design ids the studio's variants hold, but a cancelled one's.
    pub fn all_design_ids(&self) -> HashSet<String> {
        self.state()
            .variants
            .values()
            .filter(|variant| variant.status != VariantStatus::Cancelled)
            .filter_map(|variant| variant.design_id.clone())
            .collect()
    }

    /* -------------------------------------------------------------- requests */

    pub fn create_request(&self, mut request: Request) -> Request {
        request.id = new_id("r");
        request.created_at = now();
        request.updated_at = request.created_at;
        request.status = RequestStatus::Planning;
        request.variant_ids.clear();
        request.error = None;
        request.plan = None;
        request.cost = 0.0;
        let mut state = self.state();
        self.save_request(&mut request);
        state.requests.insert(request.id.clone(), request.clone());
        request
    }

    /// Changes a request, writes it and sends it; None when there is no such request (any more).
    pub fn update_request<T>(
        &self,
        rid: &str,
        change: impl FnOnce(&mut Request) -> T,
    ) -> Option<T> {
        let mut state = self.state();
        let request = state.requests.get_mut(rid)?;
        let out = change(request);
        self.save_request(request);
        Some(out)
    }

    fn save_request(&self, request: &mut Request) {
        request.updated_at = now();
        if let Err(error) = write_json(&self.request_dir(&request.id).join("request.json"), request)
        {
            eprintln!(
                "slidr-studio: could not write request {}: {error}",
                request.id
            );
        }
        (self.emit)(json!({ "type": "request", "request": request }));
    }

    pub fn delete_request(&self, rid: &str) {
        let mut state = self.state();
        let Some(request) = state.requests.remove(rid) else {
            return;
        };
        for vid in &request.variant_ids {
            state.variants.remove(vid);
        }
        drop(state);
        let _ = fs::remove_dir_all(self.request_dir(rid));
        (self.emit)(json!({ "type": "requestDeleted", "id": rid }));
    }

    /* -------------------------------------------------------------- variants */

    /// A variant of a request: a design (the default), or the sample of a template in one
    /// language, which has no design id. None when the request is gone.
    pub fn create_variant(&self, rid: &str, brief: Brief, fields: NewVariant) -> Option<Variant> {
        let mut state = self.state();
        let request = state.requests.get_mut(rid)?;
        let languages = fields
            .languages
            .unwrap_or_else(|| languages::chosen(&[request.languages.as_ref()]));
        let created = now();
        let mut variant = Variant {
            id: new_id("v"),
            request_id: rid.to_owned(),
            index: request.variant_ids.len(),
            kind: fields.kind,
            design_id: brief.design().map(|design| design.id.clone()),
            template_id: fields.template_id,
            lang: fields.lang,
            brief,
            languages: Some(languages),
            status: VariantStatus::Queued,
            stage: None,
            error: None,
            log: Vec::new(),
            session_id: None,
            revision: 0,
            render: None,
            image_revision: 0,
            image: None,
            reviews: 0,
            approved: false,
            discarded: false,
            published: None,
            upload: None,
            cost: 0.0,
            created_at: created,
            updated_at: created,
            rest: Map::new(),
        };
        request.variant_ids.push(variant.id.clone());
        self.save_variant(&mut variant);
        self.save_request(request);
        state.variants.insert(variant.id.clone(), variant.clone());
        Some(variant)
    }

    /// Changes a variant, writes it and sends it; None when there is no such variant (any more:
    /// its request was deleted while it ran).
    pub fn update_variant<T>(
        &self,
        vid: &str,
        change: impl FnOnce(&mut Variant) -> T,
    ) -> Option<T> {
        let mut state = self.state();
        let variant = state.variants.get_mut(vid)?;
        let out = change(variant);
        self.save_variant(variant);
        Some(out)
    }

    /// A line of a variant's log, written at once.
    pub fn log(&self, vid: &str, kind: &str, text: impl Into<String>) {
        let text = text.into();
        self.update_variant(vid, |variant| variant.push_log(kind, text));
    }

    fn save_variant(&self, variant: &mut Variant) {
        variant.updated_at = now();
        if let Err(error) = write_json(&self.variant_dir(variant).join("state.json"), variant) {
            eprintln!(
                "slidr-studio: could not write variant {}: {error}",
                variant.id
            );
        }
        (self.emit)(json!({ "type": "variant", "variant": variant }));
    }
}

#[cfg(test)]
pub mod tests {
    use super::*;

    /// A store in a folder of its own, that sends nothing.
    pub fn store(root: &Path) -> Store {
        Store::new(root.to_path_buf(), Arc::new(|_| {}))
    }

    pub fn design_brief() -> Brief {
        Brief::Design(DesignBrief {
            id: "m-x".into(),
            name: Named {
                he: "שם".into(),
                en: "Name".into(),
            },
            group: "g".into(),
            group_name: json!({"he": "ק", "en": "G"}),
            ..DesignBrief::default()
        })
    }

    #[test]
    fn a_stopped_studio_leaves_nothing_running() {
        let dir = tempfile::tempdir().expect("a folder");
        let first = store(dir.path());
        let request = first.create_request(Request::draft(RequestKind::Design, "x".into()));
        let variant = first
            .create_variant(&request.id, design_brief(), NewVariant::default())
            .expect("a variant");
        first.update_variant(&variant.id, |v| v.status = VariantStatus::Writing);

        let second = store(dir.path());
        second.load();
        let read = second.request(&request.id).expect("the request");
        assert_eq!(read.status, RequestStatus::Failed);
        assert_eq!(read.variant_ids, std::slice::from_ref(&variant.id));
        let read = second.variant(&variant.id).expect("the variant");
        assert_eq!(read.status, VariantStatus::Failed);
        assert!(read.error.is_some_and(|e| e.contains("Retry continues it")));
        assert_eq!(read.languages, Some(languages::base()));
        assert_eq!(read.design_id.as_deref(), Some("m-x"));
    }

    #[test]
    fn a_variant_of_a_deleted_request_writes_nothing() {
        let dir = tempfile::tempdir().expect("a folder");
        let store = store(dir.path());
        let request = store.create_request(Request::draft(RequestKind::Design, "x".into()));
        let variant = store
            .create_variant(&request.id, design_brief(), NewVariant::default())
            .expect("a variant");
        store.delete_request(&request.id);
        assert!(
            store
                .update_variant(&variant.id, |v| v.reviews += 1)
                .is_none()
        );
        assert!(!store.request_dir(&request.id).exists());
    }

    #[test]
    fn a_brief_reads_as_its_kind() {
        let template: Brief = serde_json::from_value(json!({
            "templateId": "mifgash", "name": {"he": "מפגש", "en": "Mifgash"}, "tagline": {},
            "lang": "de", "language": "German", "dir": "ltr", "rewrite": false, "instructions": ""
        }))
        .expect("a template's brief");
        assert!(matches!(template, Brief::Template(_)));
        let design: Brief =
            serde_json::from_value(json!({"id": "m-x", "name": {"he": "א", "en": "A"}}))
                .expect("a design's brief");
        assert!(design.design().is_some_and(|d| d.id == "m-x"));
    }
}
