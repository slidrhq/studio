//! The work of the studio: the person's chats, the requests each message starts, and the variants
//! of each request, the outputs the display panel shows.
//!
//! ```text
//! a message in a chat ──► a request in it (or, about chosen outputs, a change of each)
//!
//! design request ──plan (design agent, structured)──► N concepts ──► one variant each, side by side:
//!   master:  picture (images agent) ─► en.html (design agent, looking at it) ─► render + design
//!            check (a hidden window, the app's engine) ─► review rounds ─► ready: the person
//!            approves the English design, or asks for a change
//!   approved: the other fifteen languages (translation agent, a few at a time, with the names and
//!            search tags in each) ─► render every language ─► review rounds ─► ready: the person
//!            approves, and it is published to the library at once
//!
//! template request ──► one variant for each language, side by side:
//!   variant: the template, its digest and its English and Hebrew samples ─► <lang>.json
//!            (translation agent) ─► build with the app's engine, render every slide, design check
//!            ─► review rounds ─► ready: approved, it is published at once
//!
//! a request in words (kind "auto") ──route (design agent, structured)──► a design or a template
//! ```
//!
//! Each variant keeps a conversation of each agent that works on it, so a review or a change asked
//! for later is a turn of the same session, with everything it saw before. The agents are the
//! settings' (`agents.rs`), with the chat's own choices over them, as they are when a turn starts.
//!
//! A request's work and each variant's run as tasks of their own, stopped by a token: a stopped
//! task drops what it was waiting on, which ends the program it ran (`programs.rs`).

use std::{
    collections::{HashMap, HashSet},
    fs,
    future::Future,
    path::{Path, PathBuf},
    pin::Pin,
    sync::{
        Arc, Mutex, MutexGuard, PoisonError,
        atomic::{AtomicU64, Ordering},
    },
    time::Duration,
};

use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tokio::sync::Semaphore;
use tokio_util::sync::CancellationToken;

use crate::{
    agents::{self, Agents, OwnAgents, Preferences, Program, Role, Turn},
    codex::{self, CodexErrorKind},
    config::Settings,
    instructions::{self, Instructions, quality_bar},
    languages,
    library::Library,
    prompts::{self, items, truthy},
    render::{forget_old, render_dir},
    store::{
        Brief, Chat, DesignBrief, ImageBrief, ImageInfo, Message, MessageError, Named, NewVariant,
        Phase, RenderSummary, Request, RequestKind, RequestStatus, Route, Store, Variant,
        VariantKind, VariantStatus, read_json, write_json,
    },
    tags::clean_tags,
    template_prompts,
    templates::{TemplateInfo, Templates, sample_file, template_brief},
};

/// Languages the translation agent writes in one turn.
const TRANSLATION_BATCH: usize = 5;
/// What the translation agent writes beside the files: the names and tags of its languages.
const LOCALIZED: &str = "localized.json";
/// The kinds of the rail the library cannot take new items of yet.
const NOT_YET: [&str; 6] = ["cards", "frames", "shapes", "graphics", "emoji", "fonts"];

/// What draws a variant's renders: the hidden windows of the studio, or a test's stand-in.
pub trait Renderer: Send + Sync {
    fn snap<'a>(
        &'a self,
        vid: &'a str,
        revision: u32,
        out: &'a Path,
    ) -> Pin<Box<dyn Future<Output = Result<Value, String>> + Send + 'a>>;
}

pub fn slugify(text: &str) -> String {
    let mut slug = String::new();
    let mut gap = false;
    for c in text.to_lowercase().chars() {
        if c.is_ascii_lowercase() || c.is_ascii_digit() {
            if gap && !slug.is_empty() {
                slug.push('-');
            }
            gap = false;
            slug.push(c);
        } else {
            gap = true;
        }
    }
    let slug: String = slug.chars().take(40).collect();
    if slug.is_empty() {
        "design".into()
    } else {
        slug
    }
}

pub fn unique_id(slug: &str, taken: &mut HashSet<String>) -> String {
    let base = format!("m-{}", slugify(slug));
    let mut candidate = base.clone();
    let mut n = 2;
    while taken.contains(&candidate) {
        candidate = format!("{base}-{n}");
        n += 1;
    }
    taken.insert(candidate.clone());
    candidate
}

/// The files an agent must write: a design's HTML file for each language, or a template's sample
/// in the variant's language.
pub fn outputs(variant: &Variant, langs: &[String]) -> Vec<String> {
    match (&variant.kind, &variant.lang) {
        (VariantKind::Template, Some(lang)) => vec![sample_file(lang)],
        _ => langs.iter().map(|lang| languages::file_of(lang)).collect(),
    }
}

/// The outputs that are not written yet.
pub fn missing_files(work: &Path, variant: &Variant, langs: &[String]) -> Vec<String> {
    outputs(variant, langs)
        .into_iter()
        .filter(|name| !work.join(name).exists())
        .collect()
}

fn fingerprint(work: &Path, files: &[String]) -> HashMap<String, Option<String>> {
    files
        .iter()
        .map(|name| {
            let hash = fs::read(work.join(name))
                .ok()
                .map(|bytes| format!("{:x}", Sha256::digest(bytes)));
            (name.clone(), hash)
        })
        .collect()
}

pub fn picture_size(path: &Path) -> Result<(u32, u32), String> {
    image::ImageReader::open(path)
        .and_then(image::ImageReader::with_guessed_format)
        .map_err(|e| e.to_string())?
        .into_dimensions()
        .map_err(|e| format!("{}: {e}", path.display()))
}

pub fn has_errors(result: &Value) -> bool {
    if !result.get("publishable").is_some_and(truthy) {
        return true;
    }
    result
        .get("langs")
        .and_then(Value::as_object)
        .is_some_and(|sides| {
            sides.values().any(|side| {
                items(side.get("findings"))
                    .iter()
                    .any(|f| f.get("severity").and_then(Value::as_str) == Some("error"))
            })
        })
}

fn publishable(result: &Value) -> bool {
    result.get("publishable").is_some_and(truthy)
}

fn round4(cost: f64) -> f64 {
    (cost * 10_000.0).round() / 10_000.0
}

fn quoted(value: Option<&Value>) -> String {
    match value {
        Some(Value::String(text)) => format!("'{text}'"),
        None | Some(Value::Null) => "None".into(),
        Some(other) => other.to_string(),
    }
}

/// The languages of a design but English, in the registry's order.
fn others_of(langs: &[String]) -> Vec<String> {
    langs.iter().filter(|lang| *lang != "en").cloned().collect()
}

/// How a task ended.
enum Ended {
    Done(Result<(), String>),
    Cancelled,
}

type Work = Pin<Box<dyn Future<Output = Result<(), String>> + Send>>;

/// A message the person sends in a chat (`chat_send`).
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatSend {
    #[serde(default)]
    pub chat_id: Option<String>,
    #[serde(default)]
    pub text: String,
    /// `auto`, `design`, `template`, or a kind of the rail the studio cannot make yet.
    #[serde(default)]
    pub kind: String,
    /// The outputs the message is about: a change of each.
    #[serde(default)]
    pub refs: Vec<String>,
    #[serde(default)]
    pub template_id: Option<String>,
    #[serde(default)]
    pub languages: Vec<String>,
    /// The designs to plan; none is as many as the words ask for.
    #[serde(default)]
    pub count: Option<u32>,
}

/// What an approval did to one variant.
pub enum Approval {
    /// The English master was approved: its other languages are being written.
    Translate,
    /// It is being published.
    Publish,
    /// Withdrawn.
    Withdrawn,
}

pub struct Studio {
    pub settings: Arc<Settings>,
    pub store: Arc<Store>,
    pub prefs: Arc<Preferences>,
    pub instructions: Arc<Instructions>,
    pub library: Arc<Library>,
    pub templates: Arc<Templates>,
    renderer: Arc<dyn Renderer>,
    claude_slots: Semaphore,
    codex_slots: Semaphore,
    render_slots: Semaphore,
    /// One publication at a time: the library takes one upload of a part's tags at once.
    publish_slots: Semaphore,
    /// The running work, by request or variant id.
    tasks: Mutex<HashMap<String, (u64, CancellationToken)>>,
    next_task: AtomicU64,
}

impl Studio {
    pub fn new(
        settings: Arc<Settings>,
        store: Arc<Store>,
        prefs: Arc<Preferences>,
        instructions: Arc<Instructions>,
        library: Arc<Library>,
        templates: Arc<Templates>,
        renderer: Arc<dyn Renderer>,
    ) -> Self {
        Self {
            claude_slots: Semaphore::new(settings.max_claude),
            codex_slots: Semaphore::new(settings.max_codex),
            render_slots: Semaphore::new(settings.max_render),
            publish_slots: Semaphore::new(1),
            settings,
            store,
            prefs,
            instructions,
            library,
            templates,
            renderer,
            tasks: Mutex::new(HashMap::new()),
            next_task: AtomicU64::new(1),
        }
    }

    fn tasks(&self) -> MutexGuard<'_, HashMap<String, (u64, CancellationToken)>> {
        self.tasks.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /* -------------------------------------------------------------- tasks */

    fn spawn(
        self: &Arc<Self>,
        key: &str,
        work: Work,
        end: impl FnOnce(Ended) + Send + 'static,
    ) -> Result<(), String> {
        let token = CancellationToken::new();
        let id = self.next_task.fetch_add(1, Ordering::Relaxed);
        {
            let mut tasks = self.tasks();
            if tasks.contains_key(key) {
                return Err("This is already running.".into());
            }
            tasks.insert(key.to_owned(), (id, token.clone()));
        }
        let studio = Arc::clone(self);
        let key = key.to_owned();
        tauri::async_runtime::spawn(async move {
            let ended = tokio::select! {
                result = work => Ended::Done(result),
                () = token.cancelled() => Ended::Cancelled,
            };
            end(ended);
            let mut tasks = studio.tasks();
            if tasks.get(&key).is_some_and(|(known, _)| *known == id) {
                tasks.remove(&key);
            }
        });
        Ok(())
    }

    /// A request's work: planning, or reading a request in words. It marks the request ready
    /// itself; stopped, or failed, the request says so.
    fn spawn_request(self: &Arc<Self>, rid: &str, work: Work) -> Result<(), String> {
        let store = Arc::clone(&self.store);
        let id = rid.to_owned();
        self.spawn(rid, work, move |ended| {
            store.update_request(&id, |request| match ended {
                Ended::Done(Ok(())) => {}
                Ended::Done(Err(error)) => request.fail(error),
                Ended::Cancelled => request.status = RequestStatus::Cancelled,
            });
        })
    }

    /// A variant's work: ready when it ends, cancelled when stopped, failed with its error.
    fn spawn_variant(self: &Arc<Self>, vid: &str, work: Work) -> Result<(), String> {
        let store = Arc::clone(&self.store);
        let id = vid.to_owned();
        self.spawn(vid, work, move |ended| {
            store.update_variant(&id, |variant| {
                variant.stage = None;
                match ended {
                    Ended::Done(Ok(())) => {
                        variant.status = VariantStatus::Ready;
                        variant.error = None;
                    }
                    Ended::Cancelled => {
                        variant.push_log("error", "Stopped.");
                        variant.status = VariantStatus::Cancelled;
                        variant.error = None;
                    }
                    Ended::Done(Err(error)) => {
                        variant.push_log("error", error.clone());
                        variant.error = Some(error);
                        variant.status = VariantStatus::Failed;
                    }
                }
            });
        })
    }

    pub fn cancel(&self, key: &str) -> bool {
        match self.tasks().get(key) {
            Some((_, token)) => {
                token.cancel();
                true
            }
            None => false,
        }
    }

    pub fn busy(&self, key: &str) -> bool {
        self.tasks().contains_key(key)
    }

    /// Stops every task, as the studio closes.
    pub fn stop_all(&self) {
        for (_, token) in self.tasks().values() {
            token.cancel();
        }
    }

    /* -------------------------------------------------------------- reading */

    fn variant(&self, vid: &str) -> Result<Variant, String> {
        self.store
            .variant(vid)
            .ok_or_else(|| "No such variant.".to_owned())
    }

    fn request(&self, rid: &str) -> Result<Request, String> {
        self.store
            .request(rid)
            .ok_or_else(|| "No such request.".to_owned())
    }

    /// The options a variant's request was made with.
    fn options(&self, variant: &Variant) -> Option<Request> {
        self.store.request(&variant.request_id)
    }

    /// The agents of a chat: the settings', with its own choices over them.
    pub fn agents_of_chat(&self, cid: Option<&str>) -> Agents {
        let own = cid
            .and_then(|cid| self.store.chat(cid))
            .and_then(|chat| chat.agents);
        self.prefs.get().agents.with(own.as_ref())
    }

    /// The agents that work on a request now: those of its chat.
    fn agents_of_request(&self, request: &Request) -> Agents {
        self.agents_of_chat(request.chat_id.as_deref())
    }

    fn agents_of(&self, variant: &Variant) -> Agents {
        match self.options(variant) {
            Some(request) => self.agents_of_request(&request),
            None => self.prefs.get().agents,
        }
    }

    /// The languages a variant is made in: a template variant's one language; a design's own, else
    /// its request's, else Hebrew and English (a variant from before there was a choice).
    pub fn languages_of(&self, variant: &Variant) -> Vec<String> {
        if let (VariantKind::Template, Some(lang)) = (&variant.kind, &variant.lang) {
            return vec![lang.clone()];
        }
        let request = self.options(variant).and_then(|request| request.languages);
        languages::chosen(&[variant.languages.as_ref(), request.as_ref()])
    }

    /// The languages a variant has, or is having, written and rendered now: a master's English
    /// alone; every language of its other variants.
    pub fn making(&self, variant: &Variant) -> Vec<String> {
        if variant.is_master() {
            vec!["en".to_owned()]
        } else {
            self.languages_of(variant)
        }
    }

    /// The languages the design agent writes: a master's English (also once it is whole: the
    /// translation agent writes the others); every language of a design from before.
    fn design_languages(&self, variant: &Variant) -> Vec<String> {
        if variant.phase.is_some() {
            vec!["en".to_owned()]
        } else {
            self.languages_of(variant)
        }
    }

    fn set(&self, vid: &str, status: VariantStatus, stage: Option<&str>) {
        self.store.update_variant(vid, |variant| {
            variant.status = status;
            variant.stage = stage.map(str::to_owned);
            if status != VariantStatus::Failed {
                variant.error = None;
            }
        });
    }

    pub async fn template_listing(&self) -> Result<Vec<TemplateInfo>, String> {
        self.templates.listing(&instructions::app().templates).await
    }

    /* -------------------------------------------------------------- prompts */

    async fn system_files(
        &self,
        folder: &Path,
        langs: &[String],
    ) -> Result<(PathBuf, PathBuf), String> {
        let fonts = self.instructions.fonts().await?;
        let quality = quality_bar();
        let app = instructions::app();
        fs::create_dir_all(folder).map_err(|e| format!("{}: {e}", folder.display()))?;
        let plan = folder.join("system-plan.md");
        let design = folder.join("system-design.md");
        let write = |path: &Path, text: String| {
            fs::write(path, text).map_err(|e| format!("{}: {e}", path.display()))
        };
        write(
            &plan,
            prompts::system_prompt(app, &quality, &fonts, langs, false),
        )?;
        write(
            &design,
            prompts::system_prompt(app, &quality, &fonts, langs, true),
        )?;
        Ok((plan, design))
    }

    /// The system prompt of the translation agent on a design.
    async fn translation_system_file(&self, variant: &Variant) -> Result<PathBuf, String> {
        let fonts = self.instructions.fonts().await?;
        let path = self
            .store
            .variant_dir(variant)
            .join("system-translation.md");
        fs::create_dir_all(self.store.variant_dir(variant)).map_err(|e| e.to_string())?;
        fs::write(
            &path,
            prompts::translation_system_prompt(instructions::app(), &quality_bar(), &fonts),
        )
        .map_err(|e| format!("{}: {e}", path.display()))?;
        Ok(path)
    }

    /// The system prompt of a template variant, for its template and language.
    async fn template_system_file(&self, variant: &Variant) -> Result<PathBuf, String> {
        let template = read_json::<Value>(&self.store.work_dir(variant).join("template.json"))
            .filter(Value::is_object)
            .ok_or("The template this variant works on was not read; retry it.")?;
        let fonts = self.instructions.fonts().await?;
        let lang = variant.lang.clone().unwrap_or_default();
        let path = self.store.variant_dir(variant).join("system-template.md");
        fs::write(
            &path,
            template_prompts::system_prompt(&template, &quality_bar(), &fonts, &lang),
        )
        .map_err(|e| format!("{}: {e}", path.display()))?;
        Ok(path)
    }

    /// One turn of an agent that only answers (a plan, a route), on a request.
    async fn answer(
        &self,
        request: &Request,
        prompt: String,
        system: PathBuf,
        schema: Value,
        minutes: u64,
    ) -> Result<agents::TurnResult, String> {
        let choice = self.agents_of_request(request).design;
        let folder = self.store.request_dir(&request.id).join("plan");
        let mut turn = Turn::new(choice.clone(), prompt, folder, system);
        turn.json_schema = Some(schema);
        turn.timeout = Duration::from_secs(minutes * 60);
        let _slot = self.slot(choice.program).await?;
        agents::run(turn, |_, _| {}).await
    }

    async fn slot(&self, program: Program) -> Result<tokio::sync::SemaphorePermit<'_>, String> {
        match program {
            Program::Claude => self.claude_slots.acquire().await,
            Program::Codex => self.codex_slots.acquire().await,
        }
        .map_err(|e| e.to_string())
    }

    /* -------------------------------------------------------------- chats */

    /// A message of the person: a change of the outputs it is about, or a request in the chat.
    /// The chat as it is then.
    pub fn send(self: &Arc<Self>, body: ChatSend) -> Result<Chat, String> {
        let text = body.text.trim().to_owned();
        if text.chars().count() > 4000 {
            return Err("A message may be at most 4000 characters.".into());
        }
        let kind = if body.kind.is_empty() {
            "auto".to_owned()
        } else {
            body.kind.clone()
        };
        if NOT_YET.contains(&kind.as_str()) && body.refs.is_empty() {
            return Err(format!(
                "The library cannot take new {kind} yet, so the studio cannot make them."
            ));
        }
        let request_kind = match kind.as_str() {
            "auto" => RequestKind::Auto,
            "design" => RequestKind::Design,
            "template" => RequestKind::Template,
            other if body.refs.is_empty() => return Err(format!("Unknown kind '{other}'.")),
            _ => RequestKind::Auto,
        };
        if body.refs.is_empty() && request_kind != RequestKind::Template && text.chars().count() < 3
        {
            return Err("Say what to make.".into());
        }
        if !body.refs.is_empty() && text.chars().count() < 2 {
            return Err("Say what to change.".into());
        }
        if body.refs.len() > 200 {
            return Err("A message may be about at most 200 outputs.".into());
        }
        // A template request is held to its template before anything is made.
        let template = if body.refs.is_empty() && request_kind == RequestKind::Template {
            let id = body
                .template_id
                .clone()
                .filter(|id| !id.is_empty())
                .ok_or("Choose the template whose sample to write.")?;
            Some(id)
        } else {
            None
        };
        let langs = languages::known(&body.languages)?;
        if let Some(count) = body.count
            && !(1..=prompts::MOST_CONCEPTS).contains(&count)
        {
            return Err(format!("Plan 1 to {} designs.", prompts::MOST_CONCEPTS));
        }

        let chat = match body.chat_id.as_deref().filter(|cid| !cid.is_empty()) {
            Some(cid) => self.store.chat(cid).ok_or("No such chat.")?,
            // A template's sample may be asked for without words: the chat is named after it.
            None => self.store.create_chat(if text.is_empty() {
                template.as_deref().unwrap_or_default()
            } else {
                &text
            }),
        };
        let mut message = Message::user(text.clone(), Some(kind));
        if body.refs.is_empty() {
            let settings = self.prefs.get();
            let agents = self.agents_of_chat(Some(&chat.id));
            let mut request = Request::draft(request_kind, text.clone());
            request.chat_id = Some(chat.id.clone());
            request.title = crate::store::title_of(&text);
            request.review_rounds = settings.review_rounds;
            request.model.clone_from(&agents.design.model);
            request.effort.clone_from(&agents.design.effort);
            request.agents = Some(agents);
            request.asked = body.count;
            if let Some(template) = template {
                request.template_id = Some(template);
                request.instructions = Some(text.clone());
                request.languages = Some(langs);
            } else {
                // A design is made in every language: English first.
                request.languages = Some(prompts::all_languages());
            }
            let request = self.start_request(request)?;
            message.request_ids.push(request.id);
        } else {
            for vid in &body.refs {
                if let Err(error) = self.refine(vid, text.clone()) {
                    message.errors.push(MessageError {
                        variant_id: Some(vid.clone()),
                        error,
                    });
                }
            }
            message.refs.clone_from(&body.refs);
        }
        self.store
            .update_chat(&chat.id, |chat| {
                chat.messages.push(message);
                chat.clone()
            })
            .ok_or_else(|| "No such chat.".to_owned())
    }

    /// A chat's own choice of agents, or none (the settings').
    pub fn set_chat_agents(&self, cid: &str, agents: Option<OwnAgents>) -> Result<Chat, String> {
        let agents = agents.filter(|agents| !agents.is_empty());
        if let Some(agents) = &agents {
            agents.check()?;
        }
        self.store
            .update_chat(cid, |chat| {
                chat.agents = agents;
                chat.clone()
            })
            .ok_or_else(|| "No such chat.".to_owned())
    }

    /// Forgets a chat, and stops and forgets its requests and their variants.
    pub fn delete_chat(&self, cid: &str) {
        let rids: Vec<String> = self
            .store
            .requests()
            .into_iter()
            .filter(|request| request.chat_id.as_deref() == Some(cid))
            .map(|request| request.id)
            .collect();
        for rid in rids {
            self.delete_request(&rid);
        }
        self.store.delete_chat(cid);
    }

    /* -------------------------------------------------------------- requests */

    /// Starts a request's work; the request as it is now.
    pub fn start_request(self: &Arc<Self>, draft: Request) -> Result<Request, String> {
        let request = self.store.create_request(draft);
        let studio = Arc::clone(self);
        let rid = request.id.clone();
        self.spawn_request(
            &request.id,
            Box::pin(async move { studio.begin(rid).await }),
        )?;
        Ok(request)
    }

    pub fn more(self: &Arc<Self>, rid: &str, count: u32) -> Result<Request, String> {
        let request = self.request(rid)?;
        if request.kind == RequestKind::Template {
            return Err(
                "A template request has a variant for each of its languages; there are no more \
                        concepts to plan."
                    .into(),
            );
        }
        if self.busy(rid) {
            return Err("Concepts are being planned for this request already.".into());
        }
        let request = self
            .store
            .update_request(rid, |request| {
                request.status = RequestStatus::Planning;
                request.error = None;
                request.clone()
            })
            .ok_or("No such request.")?;
        let studio = Arc::clone(self);
        let id = rid.to_owned();
        self.spawn_request(
            rid,
            Box::pin(async move { studio.plan(&id, Some(count)).await }),
        )?;
        Ok(request)
    }

    /// Reads a request in words when its kind was not given, then starts its work.
    async fn begin(self: Arc<Self>, rid: String) -> Result<(), String> {
        if self.request(&rid)?.kind == RequestKind::Auto {
            self.route(&rid).await?;
        }
        let request = self.request(&rid)?;
        if request.kind == RequestKind::Template {
            self.plan_template(&rid).await
        } else {
            self.plan(&rid, request.asked).await
        }
    }

    /// Asks the design agent which kind of work a request in words is, and gives the request that
    /// kind and what it needs: a template and its languages, or nothing more for a design.
    async fn route(&self, rid: &str) -> Result<(), String> {
        let listing = self.template_listing().await?;
        let request = self.request(rid)?;
        let folder = self.store.request_dir(rid).join("plan");
        fs::create_dir_all(&folder).map_err(|e| e.to_string())?;
        let system = folder.join("system-route.md");
        fs::write(&system, template_prompts::ROUTE_SYSTEM).map_err(|e| e.to_string())?;
        let result = self
            .answer(
                &request,
                template_prompts::route_prompt(&request.prompt, &listing),
                system,
                template_prompts::route_schema(),
                10,
            )
            .await?;
        let answer = result.structured.as_object().cloned().unwrap_or_default();
        let kind = answer
            .get("kind")
            .and_then(Value::as_str)
            .map(str::to_owned);
        let text = |key: &str| {
            answer
                .get(key)
                .and_then(Value::as_str)
                .unwrap_or("")
                .trim()
                .to_owned()
        };
        let reason = text("reason");
        self.store.update_request(rid, |request| {
            request.cost = round4(request.cost + result.cost);
            request.route = Some(Route {
                kind: kind.clone(),
                reason: reason.clone(),
            });
        });
        match kind.as_deref() {
            Some("template") => {
                let entry = listing
                    .iter()
                    .find(|t| {
                        answer.get("templateId").and_then(Value::as_str) == Some(t.id.as_str())
                    })
                    .ok_or_else(|| {
                        format!(
                            "The request was read as a template, but not one of the library's: {}.",
                            quoted(answer.get("templateId"))
                        )
                    })?;
                let wanted: Vec<String> = items(answer.get("languages"))
                    .iter()
                    .filter_map(Value::as_str)
                    .filter(|code| languages::is_content(code))
                    .map(str::to_owned)
                    .collect();
                if wanted.is_empty() {
                    return Err(
                        "The request was read as a template, with no language to write its sample in."
                            .into(),
                    );
                }
                let langs = languages::known(&wanted)?;
                let (instructions, title) = (text("instructions"), text("title"));
                self.store.update_request(rid, |request| {
                    request.kind = RequestKind::Template;
                    request.template_id = Some(entry.id.clone());
                    request.languages = Some(langs);
                    request.instructions = Some(instructions);
                    if !title.is_empty() {
                        request.title = title.chars().take(60).collect();
                    }
                });
                Ok(())
            }
            Some("design") => {
                self.store.update_request(rid, |request| {
                    request.kind = RequestKind::Design;
                    request.languages = Some(prompts::all_languages());
                });
                Ok(())
            }
            _ => Err(if reason.is_empty() {
                "The studio cannot make what this request asks for.".into()
            } else {
                reason
            }),
        }
    }

    /// A variant for each language of a template request that has none yet: the languages asked
    /// for, else every language its sample lacks.
    async fn plan_template(self: &Arc<Self>, rid: &str) -> Result<(), String> {
        let listing = self.template_listing().await?;
        let request = self.request(rid)?;
        let entry = listing
            .iter()
            .find(|t| request.template_id.as_deref() == Some(t.id.as_str()))
            .ok_or_else(|| {
                format!(
                    "The library has no template {}.",
                    quoted(request.template_id.clone().map(Value::String).as_ref())
                )
            })?;
        let mut langs = languages::known(request.languages.as_deref().unwrap_or_default())?;
        if langs.is_empty() {
            langs.clone_from(&entry.missing);
            let kept = langs.clone();
            self.store
                .update_request(rid, |request| request.languages = Some(kept));
        }
        if langs.is_empty() {
            return Err("The template's sample is written in every language already.".into());
        }
        let has: HashSet<String> = request
            .variant_ids
            .iter()
            .filter_map(|vid| self.store.variant(vid))
            .filter(|variant| !variant.discarded)
            .filter_map(|variant| variant.lang)
            .collect();
        let instructions = request.instructions.clone().unwrap_or_default();
        let shown = if langs.len() <= 3 {
            langs.join(", ")
        } else {
            format!("{} languages", langs.len())
        };
        let title = format!("{} · {shown}", entry.name.en);
        self.store.update_request(rid, |request| {
            if request.kind == RequestKind::Template && request.route.is_none() {
                request.title.clone_from(&title);
            }
        });
        for lang in langs {
            if has.contains(&lang) {
                continue;
            }
            let brief = template_brief(entry, entry.name.clone(), &lang, &instructions);
            let fields = NewVariant {
                kind: VariantKind::Template,
                template_id: Some(entry.id.clone()),
                lang: Some(lang.clone()),
                languages: Some(vec![lang.clone()]),
                phase: None,
            };
            let variant = self
                .store
                .create_variant(rid, Brief::Template(brief), fields)
                .ok_or("No such request.")?;
            self.start_variant(&variant.id)?;
        }
        self.store
            .update_request(rid, |request| request.status = RequestStatus::Ready);
        Ok(())
    }

    /// Plans `count` more concepts, or at first as many as the request asks for: each an English
    /// master, to be written in every other language once it is approved.
    async fn plan(self: &Arc<Self>, rid: &str, count: Option<u32>) -> Result<(), String> {
        let known = self.library.known(false).await;
        let mut taken: HashSet<String> = known.ids.iter().cloned().collect();
        taken.extend(self.store.all_design_ids());
        let request = self.request(rid)?;
        let plan_dir = self.store.request_dir(rid).join("plan");
        let master = vec!["en".to_owned()];
        let (system_plan, _) = self.system_files(&plan_dir, &master).await?;
        let made: Vec<String> = request
            .variant_ids
            .iter()
            .filter_map(|vid| self.store.variant(vid))
            .map(|variant| {
                let design = variant.brief.design();
                let concept = design.map_or("", |design| design.concept.as_str());
                let layout = design
                    .and_then(|design| design.art.split(". ").next())
                    .unwrap_or("");
                format!("{}: {concept} Layout: {layout}.", variant.brief.name().en)
            })
            .collect();
        let group = request.group.as_deref().filter(|group| !group.is_empty());
        let mut sorted: Vec<String> = taken.iter().cloned().collect();
        sorted.sort();
        let mut prompt = prompts::plan_prompt(
            &request.prompt,
            count,
            &known.groups,
            &sorted,
            group,
            &master,
        );
        if !made.is_empty() {
            prompt.push_str(
                "\n\nThis request already has these designs; the new ones must differ from each of \
                 them, in composition as well as in concept:\n",
            );
            prompt.push_str(
                &made
                    .iter()
                    .map(|m| format!("- {m}"))
                    .collect::<Vec<_>>()
                    .join("\n"),
            );
        }
        let result = self
            .answer(
                &request,
                prompt,
                system_plan,
                prompts::plan_schema(&master),
                20,
            )
            .await?;
        let concepts: Vec<Value> = items(result.structured.get("concepts"))
            .iter()
            .take(count.unwrap_or(prompts::MOST_CONCEPTS) as usize)
            .cloned()
            .collect();
        if concepts.is_empty() {
            return Err("The plan came back without concepts.".into());
        }
        self.store.update_request(rid, |request| {
            request.cost = round4(request.cost + result.cost);
            request
                .plan
                .get_or_insert_with(Vec::new)
                .extend(concepts.iter().cloned());
            request.count = Some(request.count.unwrap_or(0) + concepts.len() as u32);
            request.status = RequestStatus::Ready;
        });
        let langs = languages::chosen(&[request.languages.as_ref()]);
        for concept in &concepts {
            let brief = make_brief(concept, &mut taken, group);
            let fields = NewVariant {
                languages: Some(langs.clone()),
                phase: Some(Phase::Master),
                ..NewVariant::default()
            };
            let variant = self
                .store
                .create_variant(rid, Brief::Design(brief), fields)
                .ok_or("No such request.")?;
            self.start_variant(&variant.id)?;
        }
        Ok(())
    }

    pub fn delete_request(&self, rid: &str) {
        let Some(request) = self.store.request(rid) else {
            return;
        };
        self.cancel(rid);
        for vid in &request.variant_ids {
            self.cancel(vid);
        }
        self.store.delete_request(rid);
    }

    /* -------------------------------------------------------------- variants */

    fn start_variant(self: &Arc<Self>, vid: &str) -> Result<(), String> {
        let studio = Arc::clone(self);
        let id = vid.to_owned();
        self.spawn_variant(vid, Box::pin(async move { studio.make(&id).await }))
    }

    async fn make(&self, vid: &str) -> Result<(), String> {
        let variant = self.variant(vid)?;
        if variant.is_template() {
            self.make_template_steps(vid).await
        } else if matches!(variant.phase, Some(Phase::Translating | Phase::Full)) {
            self.translate_steps(vid).await
        } else {
            self.make_steps(vid).await
        }
    }

    fn review_rounds(&self, variant: &Variant) -> u32 {
        self.options(variant)
            .map_or(2, |request| request.review_rounds)
    }

    /// The latest render's folder, as an agent names it from its own folder.
    fn renders(&self, vid: &str) -> String {
        format!(
            "renders/r{}",
            self.store.variant(vid).map_or(0, |v| v.revision)
        )
    }

    /// The next review round, counted on the variant.
    fn next_review(&self, vid: &str, rounds: u32) -> Option<u32> {
        self.store
            .update_variant(vid, |variant| {
                (variant.reviews < rounds).then(|| {
                    variant.reviews += 1;
                    variant.reviews
                })
            })
            .flatten()
    }

    /// A template's sample in one language: written, rendered, reviewed, and mended when it breaks
    /// the sample's contract. The translation agent writes it.
    async fn make_template_steps(&self, vid: &str) -> Result<(), String> {
        let variant = self.variant(vid)?;
        let work = self.store.work_dir(&variant);
        let lang = variant.lang.clone().unwrap_or_default();
        let Brief::Template(brief) = &variant.brief else {
            return Err("This variant's brief is not a template's.".into());
        };
        if !work.join("template.json").exists() {
            self.templates.prepare_work(&work, brief).await?;
        }
        let langs = [lang.clone()];
        let file = vec![sample_file(&lang)];
        if variant.session_id.is_none() || !missing_files(&work, &variant, &langs).is_empty() {
            self.store.update_variant(vid, |v| v.set_main_session(None));
            self.turn(
                vid,
                VariantStatus::Writing,
                template_prompts::build_prompt(brief),
                Role::Translation,
                file.clone(),
            )
            .await?;
        }
        let mut result = self.render(vid).await?;
        let rounds = self.review_rounds(&variant);
        while let Some(round) = self.next_review(vid, rounds) {
            let prompt =
                template_prompts::review_prompt(&result, round, rounds, &self.renders(vid), &lang);
            if !self
                .turn(
                    vid,
                    VariantStatus::Reviewing,
                    prompt,
                    Role::Translation,
                    file.clone(),
                )
                .await?
            {
                self.store.log(
                    vid,
                    "info",
                    "The agent reviewed the renders and changed nothing.",
                );
                break;
            }
            result = self.render(vid).await?;
        }
        // As for a design: a sample that breaks its contract gets one turn to mend it, whatever
        // number of review rounds was asked for.
        if !publishable(&result) {
            self.store.log(
                vid,
                "info",
                "The sample breaks its contract; the agent fixes it.",
            );
            let prompt = template_prompts::fix_prompt(&result, &self.renders(vid), &lang);
            if self
                .turn(
                    vid,
                    VariantStatus::Reviewing,
                    prompt,
                    Role::Translation,
                    file,
                )
                .await?
            {
                self.render(vid).await?;
            }
        }
        Ok(())
    }

    /// A design's master (or a design from before there were stages, in all its languages): its
    /// picture, its HTML, its render, its review, and a fix when it breaks the gallery's contract.
    async fn make_steps(&self, vid: &str) -> Result<(), String> {
        let variant = self.variant(vid)?;
        let work = self.store.work_dir(&variant);
        fs::create_dir_all(&work).map_err(|e| format!("{}: {e}", work.display()))?;
        if !work.join("brief.json").exists() {
            write_json(&work.join("brief.json"), &variant.brief).map_err(|e| e.to_string())?;
        }
        if !work.join("subject.png").exists() {
            self.image(vid, None).await?;
        }
        let langs = self.design_languages(&variant);
        let files: Vec<String> = langs.iter().map(|lang| languages::file_of(lang)).collect();
        if variant.session_id.is_none() || !missing_files(&work, &variant, &langs).is_empty() {
            self.store.update_variant(vid, |v| v.set_main_session(None));
            let variant = self.variant(vid)?;
            let brief = variant.brief.design().cloned().unwrap_or_default();
            let size = picture_size(&work.join("subject.png"))?;
            self.turn(
                vid,
                VariantStatus::Writing,
                prompts::build_prompt(&brief, size, &langs),
                Role::Design,
                files.clone(),
            )
            .await?;
            self.apply_brief(vid).await?;
        }
        let mut result = self.render(vid).await?;
        let rounds = self.review_rounds(&variant);
        while let Some(round) = self.next_review(vid, rounds) {
            let prompt = prompts::review_prompt(&result, round, rounds, &self.renders(vid), &langs);
            if !self
                .turn(
                    vid,
                    VariantStatus::Reviewing,
                    prompt,
                    Role::Design,
                    files.clone(),
                )
                .await?
            {
                self.store.log(
                    vid,
                    "info",
                    "The agent reviewed the renders and changed nothing.",
                );
                break;
            }
            self.apply_brief(vid).await?;
            result = self.render(vid).await?;
        }
        // The contract is not a matter of taste: a design that breaks it gets one turn to mend it,
        // whatever number of review rounds was asked for.
        if !publishable(&result) {
            self.store.log(
                vid,
                "info",
                "The design breaks the gallery's contract; the agent fixes it.",
            );
            let prompt = prompts::fix_prompt(&result, &self.renders(vid), &langs);
            if self
                .turn(vid, VariantStatus::Reviewing, prompt, Role::Design, files)
                .await?
            {
                self.apply_brief(vid).await?;
                self.render(vid).await?;
            }
        }
        Ok(())
    }

    /// The other languages of an approved master: written a few at a time by the translation
    /// agent, with their names and tags; then every language rendered, reviewed, and fixed when it
    /// breaks the contract. A language already written is not written again.
    async fn translate_steps(&self, vid: &str) -> Result<(), String> {
        let variant = self.variant(vid)?;
        let work = self.store.work_dir(&variant);
        let langs = self.languages_of(&variant);
        let others = others_of(&langs);
        let others_files: Vec<String> = others.iter().map(|l| languages::file_of(l)).collect();
        let localized = read_json::<Value>(&work.join(LOCALIZED)).unwrap_or(Value::Null);
        let missing: Vec<String> = others
            .iter()
            .filter(|lang| {
                !work.join(languages::file_of(lang)).exists()
                    || localized.pointer(&format!("/names/{lang}")).is_none()
            })
            .cloned()
            .collect();
        if !missing.is_empty() {
            // The master as the app drew it, which every language is written from.
            let master = format!("{}/en-full.png", self.renders(vid));
            for batch in missing.chunks(TRANSLATION_BATCH) {
                let brief = self
                    .variant(vid)?
                    .brief
                    .design()
                    .cloned()
                    .unwrap_or_default();
                let files: Vec<String> = batch.iter().map(|l| languages::file_of(l)).collect();
                self.store.log(
                    vid,
                    "info",
                    format!("Writing {}.", languages::names(batch, "and")),
                );
                self.turn(
                    vid,
                    VariantStatus::Translating,
                    prompts::translation_prompt(&brief, batch, &master),
                    Role::Translation,
                    files,
                )
                .await?;
                self.apply_localized(vid)?;
            }
        }
        self.store.update_variant(vid, |v| {
            if v.phase != Some(Phase::Full) {
                v.phase = Some(Phase::Full);
                v.reviews = 0;
            }
        });
        let mut result = self.render(vid).await?;
        let rounds = self.review_rounds(&variant);
        while let Some(round) = self.next_review(vid, rounds) {
            let prompt = prompts::translation_review_prompt(
                &result,
                round,
                rounds,
                &self.renders(vid),
                &langs,
            );
            if !self
                .turn(
                    vid,
                    VariantStatus::Reviewing,
                    prompt,
                    Role::Translation,
                    others_files.clone(),
                )
                .await?
            {
                self.store.log(
                    vid,
                    "info",
                    "The agent reviewed the languages and changed nothing.",
                );
                break;
            }
            self.apply_localized(vid)?;
            result = self.render(vid).await?;
        }
        if !publishable(&result) {
            self.store.log(
                vid,
                "info",
                "A language breaks the gallery's contract; the translation agent fixes it.",
            );
            let prompt = prompts::translation_fix_prompt(&result, &self.renders(vid), &langs);
            if self
                .turn(
                    vid,
                    VariantStatus::Reviewing,
                    prompt,
                    Role::Translation,
                    others_files,
                )
                .await?
            {
                self.apply_localized(vid)?;
                self.render(vid).await?;
            }
        }
        Ok(())
    }

    /// One turn of the agent of `role` on a variant, in its folder, continuing its conversation.
    /// `outputs` are the files it must have written when it ends. True when it changed a file.
    async fn turn(
        &self,
        vid: &str,
        stage: VariantStatus,
        prompt: String,
        role: Role,
        outputs: Vec<String>,
    ) -> Result<bool, String> {
        let variant = self.variant(vid)?;
        let work = self.store.work_dir(&variant);
        let choice = self.agents_of(&variant).of(role).clone();
        let template = variant.is_template();
        let translating = role == Role::Translation && !template;
        let (system, session) = if template {
            (
                self.template_system_file(&variant).await?,
                variant.main_session(),
            )
        } else if translating {
            (
                self.translation_system_file(&variant).await?,
                variant.translation_session.clone(),
            )
        } else {
            let langs = self.design_languages(&variant);
            (
                self.system_files(&self.store.variant_dir(&variant), &langs)
                    .await?
                    .1,
                variant.main_session(),
            )
        };
        let mut watched = outputs.clone();
        if translating {
            for lang in others_of(&self.languages_of(&variant)) {
                let file = languages::file_of(&lang);
                if !watched.contains(&file) {
                    watched.push(file);
                }
            }
            watched.push(LOCALIZED.into());
        } else if !template {
            watched.push("brief.json".into());
        }
        // A conversation of another program (the role moved), or none while the files exist: the
        // agent is told where it stands.
        let fresh = session
            .as_ref()
            .is_none_or(|session| session.program != choice.program);
        let mut prompt = prompt;
        if fresh && outputs.iter().any(|file| work.join(file).exists()) {
            prompt = format!(
                "This folder holds work in progress on this design: read `brief.json` and the files \
                 named below before you change anything.\n\n{prompt}"
            );
        }
        let before = fingerprint(&work, &watched);
        let program = choice.program;
        self.set(
            vid,
            stage,
            Some(match program {
                Program::Claude => "waiting for Claude",
                Program::Codex => "waiting for Codex",
            }),
        );
        let result = {
            let _slot = self.slot(program).await?;
            self.set(vid, stage, None);
            let mut turn = Turn::new(choice, prompt, work.clone(), system);
            turn.writes = true;
            turn.session = session;
            turn.timeout = Duration::from_secs(if translating { 45 * 60 } else { 30 * 60 });
            let store = Arc::clone(&self.store);
            let id = vid.to_owned();
            agents::run(turn, move |kind, text| store.log(&id, kind, text)).await?
        };
        self.store.update_variant(vid, |v| {
            v.cost = round4(v.cost + result.cost);
            if let Some(session) = &result.session {
                if translating {
                    v.translation_session = Some(session.clone());
                } else {
                    v.set_main_session(Some(session.clone()));
                }
            }
            if !result.text.is_empty() {
                v.push_log("claude", result.text.chars().take(1500).collect::<String>());
            }
        });
        let after = fingerprint(&work, &watched);
        let missing: Vec<&String> = outputs
            .iter()
            .filter(|file| !work.join(file).exists())
            .collect();
        if !missing.is_empty() {
            return Err(format!(
                "{} did not write {}.",
                program.name(),
                languages::listing(&missing, "and")
            ));
        }
        Ok(before != after)
    }

    /// Takes what the design agent changed in brief.json: names, group and tags, or a new picture.
    async fn apply_brief(&self, vid: &str) -> Result<(), String> {
        let variant = self.variant(vid)?;
        let work = self.store.work_dir(&variant);
        let Some(current) = variant.brief.design().cloned() else {
            return Ok(());
        };
        let Some(written) = read_json::<Value>(&work.join("brief.json")).filter(Value::is_object)
        else {
            write_json(&work.join("brief.json"), &variant.brief).map_err(|e| e.to_string())?;
            return Ok(());
        };
        let mut brief = current.clone();
        let named = |key: &str| {
            let value = written.get(key)?;
            let (he, en) = (value.get("he")?.as_str()?, value.get("en")?.as_str()?);
            Some(Named {
                he: he.trim().to_owned(),
                en: en.trim().to_owned(),
            })
        };
        if let Some(name) = named("name") {
            brief.name = name;
        }
        if let Some(group_name) = named("groupName") {
            brief.group_name = json!(group_name);
        }
        if let Some(group) = written
            .get("group")
            .and_then(Value::as_str)
            .filter(|g| !g.trim().is_empty())
        {
            brief.group = slugify(group);
        }
        // The languages it gives tags in replace theirs; the others keep theirs.
        brief.tags.0.extend(clean_tags(written.get("tags")).0);
        let edit = written
            .get("imageEdit")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|edit| !edit.is_empty())
            .map(str::to_owned);
        let mut new_picture = false;
        if edit.is_none()
            && let Some(image) = written.get("image").filter(|i| i.is_object())
            && let Some(prompt) = image.get("prompt").and_then(Value::as_str)
        {
            let aspect = image.get("aspect").and_then(Value::as_str).unwrap_or("");
            let wanted = ImageBrief {
                prompt: prompt.trim().to_owned(),
                aspect: if codex::is_aspect(aspect) {
                    aspect.to_owned()
                } else {
                    "wide".into()
                },
            };
            if wanted != current.image {
                brief.image = wanted;
                new_picture = true;
            }
        }
        self.store
            .update_variant(vid, |v| v.brief = Brief::Design(brief.clone()));
        if let Some(edit) = edit {
            let mut kept = written.as_object().cloned().unwrap_or_default();
            kept.shift_remove("imageEdit");
            kept.insert("id".into(), json!(current.id));
            write_json(&work.join("brief.json"), &kept).map_err(|e| e.to_string())?;
            self.image(vid, Some(edit)).await?;
        } else if new_picture {
            self.image(vid, None).await?;
        }
        Ok(())
    }

    /// Takes the names and search tags the translation agent wrote in `localized.json`: every
    /// language but English, whose come from the master; the Hebrew name is the gallery's too.
    fn apply_localized(&self, vid: &str) -> Result<(), String> {
        let variant = self.variant(vid)?;
        let Some(localized) = read_json::<Value>(&self.store.work_dir(&variant).join(LOCALIZED))
            .filter(Value::is_object)
        else {
            return Ok(());
        };
        let Some(mut brief) = variant.brief.design().cloned() else {
            return Ok(());
        };
        if let Some(names) = localized.get("names").and_then(Value::as_object) {
            for (lang, name) in names {
                let Some(name) = name.as_str().map(str::trim).filter(|n| !n.is_empty()) else {
                    continue;
                };
                if lang == "en" || !languages::is_content(lang) {
                    continue;
                }
                let name: String = name.chars().take(80).collect();
                if lang == "he" {
                    brief.name.he.clone_from(&name);
                }
                brief.names.insert(lang.clone(), name);
            }
        }
        let mut tags = clean_tags(localized.get("tags"));
        tags.0.remove("en");
        brief.tags.0.extend(tags.0);
        self.store
            .update_variant(vid, |v| v.brief = Brief::Design(brief));
        Ok(())
    }

    async fn image(&self, vid: &str, edit: Option<String>) -> Result<(), String> {
        let variant = self.variant(vid)?;
        let work = self.store.work_dir(&variant);
        let image = variant
            .brief
            .design()
            .map(|d| d.image.clone())
            .unwrap_or_default();
        let model = Some(self.agents_of(&variant).images.model).filter(|m| !m.is_empty());
        self.set(vid, VariantStatus::Image, Some("waiting for Codex"));
        let fresh = work.join("subject.next.png");
        {
            let _slot = self
                .codex_slots
                .acquire()
                .await
                .map_err(|e| e.to_string())?;
            self.set(vid, VariantStatus::Image, None);
            match &edit {
                Some(edit) => self
                    .store
                    .log(vid, "image", format!("Changing the picture: {edit}")),
                None => self.store.log(
                    vid,
                    "image",
                    format!("Making the picture ({}): {}", image.aspect, image.prompt),
                ),
            }
            let reference = work.join("subject.png");
            for attempt in 1..=2 {
                let made = codex::make_image(
                    edit.as_deref().unwrap_or(&image.prompt),
                    &fresh,
                    &image.aspect,
                    edit.as_ref().map(|_| reference.as_path()),
                    model.as_deref(),
                )
                .await;
                match made {
                    Ok(()) => break,
                    Err(error)
                        if attempt == 2 || error.kind != CodexErrorKind::GenerationFailed =>
                    {
                        return Err(error.message);
                    }
                    Err(error) => {
                        self.store
                            .log(vid, "error", format!("{error} Trying once more."))
                    }
                }
            }
        }
        fs::rename(&fresh, work.join("subject.png")).map_err(|e| e.to_string())?;
        let (width, height) = picture_size(&work.join("subject.png"))?;
        self.store.update_variant(vid, |v| {
            v.image_revision += 1;
            v.image = Some(ImageInfo {
                width,
                height,
                revision: v.image_revision,
                prompt: image.prompt.clone(),
                aspect: image.aspect.clone(),
            });
            v.push_log("image", format!("The picture is ready ({width}×{height})."));
        });
        Ok(())
    }

    async fn render(&self, vid: &str) -> Result<Value, String> {
        let variant = self.variant(vid)?;
        let work = self.store.work_dir(&variant);
        self.set(
            vid,
            VariantStatus::Rendering,
            Some("waiting for the browser"),
        );
        let result = {
            let _slot = self
                .render_slots
                .acquire()
                .await
                .map_err(|e| e.to_string())?;
            self.set(vid, VariantStatus::Rendering, None);
            let revision = self
                .store
                .update_variant(vid, |v| {
                    v.revision += 1;
                    v.revision
                })
                .ok_or("No such variant.")?;
            let result = self
                .renderer
                .snap(vid, revision, &render_dir(&work, revision))
                .await?;
            forget_old(&work, revision);
            result
        };
        let sides: Vec<&Value> = result
            .get("langs")
            .and_then(Value::as_object)
            .map(|sides| sides.values().collect())
            .unwrap_or_default();
        let findings: Vec<&Value> = sides
            .iter()
            .flat_map(|side| items(side.get("findings")))
            .collect();
        let issues = items(result.get("issues")).len()
            + sides
                .iter()
                .map(|side| items(side.get("issues")).len())
                .sum::<usize>();
        let errors = findings
            .iter()
            .filter(|f| f.get("severity").and_then(Value::as_str) == Some("error"))
            .count();
        let editability = result
            .get("langs")
            .and_then(Value::as_object)
            .map(|sides| {
                sides
                    .iter()
                    .map(|(lang, side)| {
                        (
                            lang.clone(),
                            side.get("editability").cloned().unwrap_or(Value::Null),
                        )
                    })
                    .collect()
            })
            .unwrap_or_default();
        self.store.update_variant(vid, |v| {
            v.render = Some(RenderSummary {
                revision: v.revision,
                image_revision: v.image_revision,
                publishable: publishable(&result),
                errors,
                warnings: findings.len() - errors,
                issues,
                editability,
            });
            if v.approved {
                v.approved = false;
                v.push_log("info", "The design changed, so its approval was withdrawn.");
            }
            v.push_log(
                "render",
                format!(
                    "Rendered revision {}: {errors} errors, {} warnings, {issues} contract issues.",
                    v.revision,
                    findings.len() - errors
                ),
            );
        });
        Ok(result)
    }

    /* -------------------------------------------------------------- actions */

    pub fn retry(self: &Arc<Self>, vid: &str) -> Result<(), String> {
        let variant = self.variant(vid)?;
        if variant.status.running() {
            return Err("It is running.".into());
        }
        self.set(vid, VariantStatus::Queued, None);
        self.start_variant(vid)
    }

    pub fn refine(self: &Arc<Self>, vid: &str, feedback: String) -> Result<(), String> {
        let variant = self.variant(vid)?;
        if variant.status.running() {
            return Err("Wait for it to finish, or stop it.".into());
        }
        if variant.discarded {
            return Err("It was discarded; restore it first.".into());
        }
        let work = self.store.work_dir(&variant);
        let written = outputs(&variant, &self.design_languages(&variant))
            .iter()
            .all(|file| work.join(file).exists());
        if !written {
            return Err("This variant has no design to change yet; retry it first.".into());
        }
        self.store.log(vid, "feedback", feedback.clone());
        self.set(vid, VariantStatus::Queued, None);
        let studio = Arc::clone(self);
        let id = vid.to_owned();
        self.spawn_variant(
            vid,
            Box::pin(async move { studio.refine_steps(&id, &feedback).await }),
        )
    }

    async fn refine_steps(&self, vid: &str, feedback: &str) -> Result<(), String> {
        let variant = self.variant(vid)?;
        if let (VariantKind::Template, Some(lang)) = (&variant.kind, &variant.lang) {
            let file = vec![sample_file(lang)];
            self.turn(
                vid,
                VariantStatus::Writing,
                template_prompts::feedback_prompt(feedback, lang),
                Role::Translation,
                file.clone(),
            )
            .await?;
            let result = self.render(vid).await?;
            if has_errors(&result) {
                let prompt = template_prompts::fix_prompt(&result, &self.renders(vid), lang);
                if self
                    .turn(
                        vid,
                        VariantStatus::Reviewing,
                        prompt,
                        Role::Translation,
                        file,
                    )
                    .await?
                {
                    self.render(vid).await?;
                }
            }
            return Ok(());
        }
        if matches!(variant.phase, Some(Phase::Full | Phase::Translating)) {
            return self.refine_whole(vid, feedback).await;
        }
        let langs = self.design_languages(&variant);
        let files: Vec<String> = langs.iter().map(|lang| languages::file_of(lang)).collect();
        self.turn(
            vid,
            VariantStatus::Writing,
            prompts::feedback_prompt(feedback, &langs),
            Role::Design,
            files.clone(),
        )
        .await?;
        self.apply_brief(vid).await?;
        let result = self.render(vid).await?;
        if has_errors(&result) {
            let prompt = prompts::fix_prompt(&result, &self.renders(vid), &langs);
            if self
                .turn(vid, VariantStatus::Reviewing, prompt, Role::Design, files)
                .await?
            {
                self.apply_brief(vid).await?;
                self.render(vid).await?;
            }
        }
        Ok(())
    }

    /// A change of a design written in every language: the design agent changes the master when
    /// the change is the design's, then the translation agent brings the other languages in line
    /// (or makes the change in the languages it concerns), and every language is rendered.
    async fn refine_whole(&self, vid: &str, feedback: &str) -> Result<(), String> {
        let variant = self.variant(vid)?;
        let langs = self.languages_of(&variant);
        let others: Vec<String> = others_of(&langs)
            .iter()
            .map(|lang| languages::file_of(lang))
            .collect();
        let master_changed = self
            .turn(
                vid,
                VariantStatus::Writing,
                prompts::master_change_prompt(feedback),
                Role::Design,
                vec!["en.html".into()],
            )
            .await?;
        self.apply_brief(vid).await?;
        self.turn(
            vid,
            VariantStatus::Translating,
            prompts::translation_change_prompt(feedback, master_changed, &langs),
            Role::Translation,
            others.clone(),
        )
        .await?;
        self.apply_localized(vid)?;
        let result = self.render(vid).await?;
        if has_errors(&result) {
            let prompt = prompts::translation_fix_prompt(&result, &self.renders(vid), &langs);
            if self
                .turn(
                    vid,
                    VariantStatus::Reviewing,
                    prompt,
                    Role::Translation,
                    others,
                )
                .await?
            {
                self.apply_localized(vid)?;
                self.render(vid).await?;
            }
        }
        Ok(())
    }

    pub fn new_image(
        self: &Arc<Self>,
        vid: &str,
        instruction: Option<String>,
    ) -> Result<(), String> {
        let variant = self.variant(vid)?;
        if variant.is_template() {
            return Err("A template's sample keeps the template's pictures.".into());
        }
        if variant.status.running() {
            return Err("Wait for it to finish, or stop it.".into());
        }
        self.set(vid, VariantStatus::Queued, None);
        let studio = Arc::clone(self);
        let id = vid.to_owned();
        self.spawn_variant(
            vid,
            Box::pin(async move {
                studio.image(&id, instruction).await?;
                studio.render(&id).await.map(drop)
            }),
        )
    }

    /// The person's approval. Of an English master: the translation agent writes the other
    /// languages. Of a whole design or a template's sample: it is published to the library at
    /// once. `false` withdraws an approval.
    pub fn approve(self: &Arc<Self>, vid: &str, approved: bool) -> Result<Approval, String> {
        let variant = self.variant(vid)?;
        if !approved {
            self.store.update_variant(vid, |v| {
                v.approved = false;
                v.push_log("approval", "Approval withdrawn.");
            });
            return Ok(Approval::Withdrawn);
        }
        if variant.status != VariantStatus::Ready {
            return Err("Only a finished design can be approved.".into());
        }
        if variant.discarded {
            return Err("It was discarded; restore it first.".into());
        }
        if !variant
            .render
            .as_ref()
            .is_some_and(|render| render.publishable)
        {
            return Err(
                "Its last render did not pass the gallery's contract; ask for a fix first.".into(),
            );
        }
        if variant.is_master() {
            self.store.update_variant(vid, |v| {
                v.phase = Some(Phase::Translating);
                v.status = VariantStatus::Queued;
                v.push_log(
                    "approval",
                    "The English design was approved: its other languages are being written.",
                );
            });
            self.start_variant(vid)?;
            return Ok(Approval::Translate);
        }
        // A design from before the stages, in fewer languages than every one: the library takes a
        // design only in all of them, so its English is the master of the languages it lacks.
        if !variant.is_template()
            && variant.phase.is_none()
            && self.languages_of(&variant).len() < languages::CONTENT_LANGUAGES.len()
        {
            self.keep_words_of_written_languages(&variant)?;
            self.store.update_variant(vid, |v| {
                v.languages = Some(prompts::all_languages());
                v.phase = Some(Phase::Translating);
                v.status = VariantStatus::Queued;
                v.push_log(
                    "approval",
                    "Approved: the languages it lacks are being written from its English.",
                );
            });
            self.start_variant(vid)?;
            return Ok(Approval::Translate);
        }
        if variant.is_published() {
            return Err("It is published as it is.".into());
        }
        self.store.update_variant(vid, |v| {
            v.approved = true;
            v.publish_error = None;
            v.status = VariantStatus::Publishing;
            v.push_log("approval", "Approved: it is being published.");
        });
        let studio = Arc::clone(self);
        let id = vid.to_owned();
        self.spawn_variant(
            vid,
            Box::pin(async move { studio.publish_steps(&id).await }),
        )
        .map(|()| Approval::Publish)
    }

    /// Writes into `localized.json` the names and tags of the languages a design from before the
    /// stages was written in, so that the translation agent writes only the languages it lacks.
    fn keep_words_of_written_languages(&self, variant: &Variant) -> Result<(), String> {
        let Some(brief) = variant.brief.design() else {
            return Ok(());
        };
        let path = self.store.work_dir(variant).join(LOCALIZED);
        let mut localized = read_json::<Value>(&path)
            .filter(Value::is_object)
            .unwrap_or_else(|| json!({"names": {}, "tags": {}}));
        for lang in others_of(&self.languages_of(variant)) {
            let name = brief
                .names
                .get(&lang)
                .cloned()
                .or_else(|| match lang.as_str() {
                    "he" => Some(brief.name.he.clone()),
                    _ => None,
                });
            if let Some(name) = name.filter(|name| !name.is_empty()) {
                localized["names"][&lang] = json!(name);
            }
            if brief.tags.has(&lang) {
                localized["tags"][&lang] = json!(brief.tags.get(&lang));
            }
        }
        write_json(&path, &localized).map_err(|e| e.to_string())
    }

    /// Approves each of `vids`, as `approve` does; what became of each.
    pub fn approve_many(self: &Arc<Self>, vids: &[String]) -> Vec<Value> {
        vids.iter()
            .map(|vid| match self.approve(vid, true) {
                Ok(Approval::Translate) => json!({"variantId": vid, "action": "translate"}),
                Ok(Approval::Publish) => json!({"variantId": vid, "action": "publish"}),
                Ok(Approval::Withdrawn) => json!({"variantId": vid, "action": "skip"}),
                Err(error) => json!({"variantId": vid, "action": "skip", "error": error}),
            })
            .collect()
    }

    /// Sends an approved variant to the library, one publication at a time. A failure is kept on
    /// the variant (`publishError`), which stays as it was made; an upload the library keeps, to
    /// publish later or for a person there to look at, is none: the studio asks after it
    /// (`Library::watch`).
    async fn publish_steps(&self, vid: &str) -> Result<(), String> {
        let _slot = self
            .publish_slots
            .acquire()
            .await
            .map_err(|e| e.to_string())?;
        self.set(vid, VariantStatus::Publishing, None);
        let item = self
            .library
            .upload(&[vid.to_owned()])
            .await
            .into_iter()
            .next()
            .unwrap_or(Value::Null);
        let status = item.get("status").and_then(Value::as_str).unwrap_or("");
        let note = item.get("note").and_then(Value::as_str).unwrap_or("");
        let waits = matches!(status, "accepted" | "pending");
        let failure = if let Some(error) = item.get("error").and_then(Value::as_str) {
            let issues: Vec<String> = items(item.get("issues"))
                .iter()
                .filter_map(|issue| {
                    let message = issue.get("message").and_then(Value::as_str)?;
                    let path = issue.get("path").and_then(Value::as_str).unwrap_or("");
                    Some(format!("{path}: {message}"))
                })
                .collect();
            Some(if issues.is_empty() {
                error.to_owned()
            } else {
                format!("{error} {}", issues.join("; "))
            })
        } else if status == "published" {
            item.get("tagsError")
                .and_then(Value::as_str)
                .map(str::to_owned)
        } else if waits {
            None
        } else {
            Some(
                format!("The library did not publish it ({status}). {note}")
                    .trim()
                    .to_owned(),
            )
        };
        self.store.update_variant(vid, |v| {
            if status != "published" {
                v.approved = false;
            }
            if let Some(failure) = &failure {
                v.push_log("error", failure.clone());
            } else if waits {
                let why = format!("It waits in the library ({status}). {note}");
                v.push_log("publish", why.trim().to_owned());
            }
            v.publish_error = failure;
        });
        Ok(())
    }

    pub fn discard(&self, vid: &str, discarded: bool) -> Result<(), String> {
        self.variant(vid)?;
        self.cancel(vid);
        self.store.update_variant(vid, |v| {
            v.discarded = discarded;
            if discarded {
                v.approved = false;
            }
        });
        Ok(())
    }

    /// What the render page converts: the HTML of every language of a design being made and its
    /// picture, or a template and its sample in the variant's language, with the English one it is
    /// held to.
    pub fn render_input(&self, vid: &str) -> Result<Value, String> {
        let variant = self.variant(vid)?;
        let work = self.store.work_dir(&variant);
        if variant.is_template() {
            return template_render_input(&variant, &work);
        }
        let langs = self.making(&variant);
        let mut missing = missing_files(&work, &variant, &langs);
        if !work.join("subject.png").exists() {
            missing.push("subject.png".into());
        }
        if !missing.is_empty() {
            return Err(format!("Not written yet: {}", missing.join(", ")));
        }
        let (width, height) = picture_size(&work.join("subject.png"))?;
        let mut html = serde_json::Map::new();
        for lang in &langs {
            let path = work.join(languages::file_of(lang));
            let text = fs::read_to_string(&path).map_err(|e| format!("{}: {e}", path.display()))?;
            html.insert(lang.clone(), json!(text));
        }
        Ok(json!({
            "id": variant.id,
            "designId": variant.design_id,
            "revision": variant.revision,
            "languages": langs,
            "html": html,
            "image": {
                "file": "subject.png",
                "revision": variant.image_revision,
                "width": width,
                "height": height,
            },
        }))
    }

    /// The result of a variant's last render.
    pub fn result(&self, vid: &str) -> Result<Value, String> {
        let variant = self.variant(vid)?;
        let revision = variant
            .render
            .as_ref()
            .map(|render| render.revision)
            .filter(|r| *r > 0);
        revision
            .and_then(|revision| {
                read_json::<Value>(
                    &render_dir(&self.store.work_dir(&variant), revision).join("result.json"),
                )
            })
            .filter(Value::is_object)
            .ok_or_else(|| "No render yet.".to_owned())
    }
}

fn template_render_input(variant: &Variant, work: &Path) -> Result<Value, String> {
    let lang = variant.lang.clone().unwrap_or_default();
    let file = sample_file(&lang);
    let missing: Vec<&str> = ["template.json", "en.json", file.as_str()]
        .into_iter()
        .filter(|name| !work.join(name).exists())
        .collect();
    if !missing.is_empty() {
        return Err(format!("Not written yet: {}", missing.join(", ")));
    }
    // A file that is not JSON is the render's finding, not a failure of the render.
    let text = fs::read_to_string(work.join(&file)).map_err(|e| e.to_string())?;
    let (sample, error) = match serde_json::from_str::<Value>(&text) {
        Ok(sample) => (sample, Value::Null),
        Err(failure) => (
            Value::Null,
            json!(format!("{file} is not valid JSON: {failure}")),
        ),
    };
    let read = |name: &str| read_json::<Value>(&work.join(name)).unwrap_or(Value::Null);
    Ok(json!({
        "kind": "template",
        "id": variant.id,
        "templateId": variant.template_id,
        "revision": variant.revision,
        "lang": lang,
        "template": read("template.json"),
        "english": read("en.json"),
        "hebrew": read("he.json"),
        "sample": sample,
        "error": error,
    }))
}

/// A planned concept as a design's brief.
fn make_brief(concept: &Value, taken: &mut HashSet<String>, group: Option<&str>) -> DesignBrief {
    let text = |key: &str| {
        concept
            .get(key)
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_owned()
    };
    let name: Named = concept
        .get("name")
        .and_then(|name| serde_json::from_value(name.clone()).ok())
        .unwrap_or_default();
    let slug = concept
        .get("slug")
        .and_then(Value::as_str)
        .filter(|slug| !slug.is_empty())
        .map_or_else(|| name.en.clone(), str::to_owned);
    let group = group
        .map(str::to_owned)
        .or_else(|| {
            concept
                .get("group")
                .and_then(Value::as_str)
                .filter(|g| !g.is_empty())
                .map(str::to_owned)
        })
        .unwrap_or_else(|| "designs".into());
    let aspect = concept
        .pointer("/image/aspect")
        .and_then(Value::as_str)
        .unwrap_or("");
    DesignBrief {
        id: unique_id(&slug, taken),
        name,
        group: slugify(&group),
        group_name: concept
            .get("groupName")
            .filter(|names| truthy(names))
            .cloned()
            .unwrap_or_else(|| json!({})),
        tags: clean_tags(concept.get("tags")),
        names: std::collections::BTreeMap::new(),
        concept: text("concept"),
        art: text("art"),
        copy: concept.get("copy").cloned().unwrap_or_else(|| json!({})),
        image: ImageBrief {
            prompt: concept
                .pointer("/image/prompt")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_owned(),
            aspect: if codex::is_aspect(aspect) {
                aspect.to_owned()
            } else {
                "wide".into()
            },
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        store::{
            DesignBrief,
            tests::{design_brief, store},
        },
        templates::tests::{catalog, english, listing_entry},
    };

    struct NoRenders;

    impl Renderer for NoRenders {
        fn snap<'a>(
            &'a self,
            _vid: &'a str,
            _revision: u32,
            _out: &'a Path,
        ) -> Pin<Box<dyn Future<Output = Result<Value, String>> + Send + 'a>> {
            Box::pin(async { Err("no renders here".into()) })
        }
    }

    fn studio(root: &Path, templates: Templates) -> Arc<Studio> {
        let settings = Arc::new(Settings::new(root.to_path_buf(), None));
        let store = Arc::new(store(&settings.requests_dir()));
        let templates = Arc::new(templates);
        let library = Arc::new(Library::new(
            Arc::clone(&settings),
            Arc::clone(&store),
            Arc::clone(&templates),
        ));
        let prefs = Arc::new(Preferences::load(agents::settings_file(&settings.data)));
        Arc::new(Studio::new(
            settings,
            store,
            prefs,
            Arc::new(Instructions::new("http://127.0.0.1:9/".into())),
            library,
            templates,
            Arc::new(NoRenders),
        ))
    }

    fn png(path: &Path) {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).expect("a folder");
        }
        image::RgbImage::new(32, 18).save(path).expect("a picture");
    }

    fn langs(codes: &[&str]) -> Vec<String> {
        codes.iter().map(|code| (*code).to_owned()).collect()
    }

    #[test]
    fn ids_are_slugs_with_the_managed_prefix_and_unique() {
        assert_eq!(slugify("Garden Wedding!! 2"), "garden-wedding-2");
        assert_eq!(slugify("!!!"), "design");
        let mut taken = HashSet::from(["m-garden".to_owned()]);
        assert_eq!(unique_id("garden", &mut taken), "m-garden-2");
        assert_eq!(unique_id("garden", &mut taken), "m-garden-3");
        assert!(taken.contains("m-garden-3"));
    }

    #[test]
    fn errors_are_told_from_warnings() {
        let result =
            json!({"publishable": true, "langs": {"he": {"findings": [{"severity": "warning"}]}}});
        assert!(!has_errors(&result));
        assert!(has_errors(&json!({"publishable": false})));
        let erring =
            json!({"publishable": true, "langs": {"he": {"findings": [{"severity": "error"}]}}});
        assert!(has_errors(&erring));
    }

    #[test]
    fn a_variant_is_rendered_in_the_languages_of_its_request() {
        let dir = tempfile::tempdir().expect("a folder");
        let studio = studio(dir.path(), Templates::new("http://127.0.0.1:9/".into()));
        let mut draft = Request::draft(RequestKind::Design, "x".into());
        draft.languages = Some(langs(&["he", "en", "ar", "ja"]));
        let request = studio.store.create_request(draft);
        let variant = studio
            .store
            .create_variant(&request.id, design_brief(), NewVariant::default())
            .expect("a variant");
        assert_eq!(variant.languages, Some(langs(&["he", "en", "ar", "ja"])));
        let work = studio.store.work_dir(&variant);
        png(&work.join("subject.png"));
        for lang in ["he", "en", "ar"] {
            fs::write(
                work.join(format!("{lang}.html")),
                format!("<div lang='{lang}'></div>"),
            )
            .expect("written");
        }
        assert!(
            studio
                .render_input(&variant.id)
                .is_err_and(|e| e.contains("ja.html"))
        );
        fs::write(work.join("ja.html"), "<div lang='ja'>日本語</div>").expect("written");
        let data = studio.render_input(&variant.id).expect("the input");
        assert_eq!(data["languages"], json!(["he", "en", "ar", "ja"]));
        let order: Vec<&String> = data["html"]
            .as_object()
            .map(|h| h.keys().collect())
            .unwrap_or_default();
        assert_eq!(order, ["he", "en", "ar", "ja"]);
        assert!(
            data["html"]["ja"]
                .as_str()
                .is_some_and(|html| html.contains("日本語"))
        );
    }

    #[test]
    fn a_variant_from_before_the_choice_is_hebrew_and_english() {
        let dir = tempfile::tempdir().expect("a folder");
        let studio = studio(dir.path(), Templates::new("http://127.0.0.1:9/".into()));
        let request = studio
            .store
            .create_request(Request::draft(RequestKind::Design, "x".into()));
        let variant = studio
            .store
            .create_variant(&request.id, design_brief(), NewVariant::default())
            .expect("a variant");
        let variant = studio
            .store
            .update_variant(&variant.id, |v| {
                v.languages = None;
                v.clone()
            })
            .expect("updated");
        let work = studio.store.work_dir(&variant);
        png(&work.join("subject.png"));
        for lang in ["he", "en"] {
            fs::write(work.join(format!("{lang}.html")), "<div></div>").expect("written");
        }
        assert_eq!(studio.languages_of(&variant), ["he", "en"]);
        let data = studio.render_input(&variant.id).expect("the input");
        let order: Vec<&String> = data["html"]
            .as_object()
            .map(|h| h.keys().collect())
            .unwrap_or_default();
        assert_eq!(order, ["he", "en"]);
    }

    #[tokio::test]
    async fn a_template_request_has_no_more_concepts() {
        let dir = tempfile::tempdir().expect("a folder");
        let studio = studio(dir.path(), Templates::new("http://127.0.0.1:9/".into()));
        let mut draft = Request::draft(RequestKind::Template, String::new());
        draft.template_id = Some("mifgash".into());
        draft.languages = Some(langs(&["de"]));
        let request = studio.store.create_request(draft);
        assert!(
            studio
                .more(&request.id, 2)
                .is_err_and(|e| e.contains("variant for each of its languages"))
        );
    }

    #[tokio::test]
    async fn a_template_variant_writes_one_sample_and_is_rendered_from_it() {
        let dir = tempfile::tempdir().expect("a folder");
        let studio = studio(dir.path(), Templates::seeded(catalog()));
        let mut draft = Request::draft(RequestKind::Template, String::new());
        draft.template_id = Some("mifgash".into());
        draft.languages = Some(langs(&["de"]));
        let request = studio.store.create_request(draft);
        let entry = listing_entry();
        let brief = template_brief(&entry, entry.name.clone(), "de", "");
        let variant = studio
            .store
            .create_variant(
                &request.id,
                Brief::Template(brief.clone()),
                NewVariant {
                    kind: VariantKind::Template,
                    template_id: Some("mifgash".into()),
                    lang: Some("de".into()),
                    languages: Some(langs(&["de"])),
                    phase: None,
                },
            )
            .expect("a variant");
        assert_eq!(variant.design_id, None);
        assert_eq!(studio.languages_of(&variant), ["de"]);
        assert!(studio.store.all_design_ids().is_empty());
        let work = studio.store.work_dir(&variant);
        studio
            .templates
            .prepare_work(&work, &brief)
            .await
            .expect("prepared");
        let mut names: Vec<String> = fs::read_dir(&work)
            .expect("the folder")
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        assert_eq!(
            names,
            [
                "brief.json",
                "en.json",
                "he.json",
                "template.json",
                "template.md"
            ]
        );
        assert_eq!(outputs(&variant, &langs(&["de"])), ["de.json"]);
        assert!(
            studio
                .render_input(&variant.id)
                .is_err_and(|e| e.contains("de.json"))
        );
        // A file that is not JSON is the render's finding.
        fs::write(work.join("de.json"), "[{").expect("written");
        let data = studio.render_input(&variant.id).expect("the input");
        assert_eq!(data["kind"], "template");
        assert_eq!(data["sample"], Value::Null);
        assert!(
            data["error"]
                .as_str()
                .is_some_and(|e| e.contains("not valid JSON"))
        );
        fs::write(work.join("de.json"), english().to_string()).expect("written");
        let data = studio.render_input(&variant.id).expect("the input");
        assert_eq!(data["error"], Value::Null);
        assert_eq!(data["sample"], english());
        assert_eq!(data["english"], english());
        assert_eq!(data["template"]["theme"]["id"], "mifgash");
        assert_eq!(data["lang"], "de");
        assert!(
            studio
                .new_image(&variant.id, None)
                .is_err_and(|e| e.contains("pictures"))
        );
    }

    #[test]
    fn a_concept_becomes_a_brief() {
        let mut taken = HashSet::new();
        let concept = json!({
            "slug": "garden-party", "name": {"he": "גן", "en": "Garden"}, "group": "Invites!",
            "groupName": {}, "tags": {"he": ["א"], "en": []}, "concept": "c", "art": "a",
            "copy": {"he": "x", "en": "y"}, "image": {"prompt": "p", "aspect": "huge"},
        });
        let brief: DesignBrief = make_brief(&concept, &mut taken, None);
        assert_eq!(brief.id, "m-garden-party");
        assert_eq!(brief.group, "invites");
        assert_eq!(brief.image.aspect, "wide");
        assert_eq!(brief.tags, crate::store::Tags::default());
        assert_eq!(
            make_brief(&concept, &mut taken, Some("Sales")).group,
            "sales"
        );
    }

    /// A design request's master in a chat, written in English and nothing else yet.
    fn master(studio: &Studio) -> Variant {
        let chat = studio.store.create_chat("an invitation");
        let mut draft = Request::draft(RequestKind::Design, "an invitation".into());
        draft.chat_id = Some(chat.id);
        draft.languages = Some(prompts::all_languages());
        let request = studio.store.create_request(draft);
        let fields = NewVariant {
            languages: Some(prompts::all_languages()),
            phase: Some(Phase::Master),
            ..NewVariant::default()
        };
        studio
            .store
            .create_variant(&request.id, design_brief(), fields)
            .expect("a variant")
    }

    #[test]
    fn a_master_is_written_and_rendered_in_english_alone() {
        let dir = tempfile::tempdir().expect("a folder");
        let studio = studio(dir.path(), Templates::new("http://127.0.0.1:9/".into()));
        let variant = master(&studio);
        assert_eq!(studio.languages_of(&variant).len(), 16);
        assert_eq!(studio.making(&variant), ["en"]);
        let work = studio.store.work_dir(&variant);
        png(&work.join("subject.png"));
        fs::write(work.join("en.html"), "<div lang='en'></div>").expect("written");
        let data = studio.render_input(&variant.id).expect("the input");
        assert_eq!(data["languages"], json!(["en"]));
        let order: Vec<&String> = data["html"]
            .as_object()
            .map(|h| h.keys().collect())
            .unwrap_or_default();
        assert_eq!(order, ["en"]);
        // Once whole, every language is rendered.
        let whole = studio
            .store
            .update_variant(&variant.id, |v| {
                v.phase = Some(Phase::Full);
                v.clone()
            })
            .expect("updated");
        assert_eq!(studio.making(&whole).len(), 16);
        assert!(
            studio
                .render_input(&variant.id)
                .is_err_and(|e| e.contains("he.html") && e.contains("zh-CN.html"))
        );
    }

    #[test]
    fn a_master_is_approved_only_when_it_is_ready_and_holds() {
        let dir = tempfile::tempdir().expect("a folder");
        let studio = studio(dir.path(), Templates::new("http://127.0.0.1:9/".into()));
        let variant = master(&studio);
        assert!(
            studio
                .approve(&variant.id, true)
                .is_err_and(|e| e.contains("finished"))
        );
        studio.store.update_variant(&variant.id, |v| {
            v.status = VariantStatus::Ready;
            v.render = Some(RenderSummary {
                revision: 1,
                publishable: false,
                ..RenderSummary::default()
            });
        });
        assert!(
            studio
                .approve(&variant.id, true)
                .is_err_and(|e| e.contains("contract"))
        );
        let items = studio.approve_many(std::slice::from_ref(&variant.id));
        assert_eq!(items[0]["action"], "skip");
        assert!(items[0]["error"].is_string());
        assert!(matches!(
            studio.approve(&variant.id, false),
            Ok(Approval::Withdrawn)
        ));
    }

    #[tokio::test]
    async fn a_message_asks_for_what_the_studio_can_make() {
        let dir = tempfile::tempdir().expect("a folder");
        let studio = studio(dir.path(), Templates::new("http://127.0.0.1:9/".into()));
        let refused = studio.send(ChatSend {
            text: "180 new emoji for the holidays".into(),
            kind: "emoji".into(),
            ..ChatSend::default()
        });
        assert!(refused.is_err_and(|e| e.contains("cannot take new emoji")));
        assert!(studio.store.chats().is_empty());
        let no_template = studio.send(ChatSend {
            text: "in every language".into(),
            kind: "template".into(),
            ..ChatSend::default()
        });
        assert!(no_template.is_err_and(|e| e.contains("Choose the template")));
        assert!(
            studio
                .send(ChatSend {
                    text: "x".into(),
                    kind: "design".into(),
                    count: Some(40),
                    ..ChatSend::default()
                })
                .is_err()
        );
    }

    #[tokio::test]
    async fn a_message_about_outputs_asks_each_for_the_change() {
        let dir = tempfile::tempdir().expect("a folder");
        let studio = studio(dir.path(), Templates::new("http://127.0.0.1:9/".into()));
        let variant = master(&studio);
        let cid = studio
            .store
            .request(&variant.request_id)
            .and_then(|r| r.chat_id)
            .expect("its chat");
        // Not written yet: the change cannot be made, and the message says so.
        studio
            .store
            .update_variant(&variant.id, |v| v.status = VariantStatus::Failed);
        let chat = studio
            .send(ChatSend {
                chat_id: Some(cid.clone()),
                text: "a warmer palette".into(),
                kind: "design".into(),
                refs: vec![variant.id.clone()],
                ..ChatSend::default()
            })
            .expect("the chat");
        assert_eq!(chat.id, cid);
        let message = chat.messages.last().expect("the message");
        assert_eq!(message.refs, std::slice::from_ref(&variant.id));
        assert!(message.request_ids.is_empty());
        assert_eq!(message.errors.len(), 1);
        assert!(message.errors[0].error.contains("retry it first"));
        // No request was made for it.
        assert_eq!(studio.store.requests().len(), 1);
    }

    #[test]
    fn a_chat_keeps_its_own_agents_over_the_settings() {
        let dir = tempfile::tempdir().expect("a folder");
        let studio = studio(dir.path(), Templates::new("http://127.0.0.1:9/".into()));
        let chat = studio.store.create_chat("x");
        let own = OwnAgents {
            design: Some(agents::AgentChoice {
                program: Program::Codex,
                ..agents::AgentChoice::default()
            }),
            ..OwnAgents::default()
        };
        studio.set_chat_agents(&chat.id, Some(own)).expect("kept");
        let agents = studio.agents_of_chat(Some(&chat.id));
        assert_eq!(agents.design.program, Program::Codex);
        assert_eq!(agents.translation.program, Program::Claude);
        let bad = OwnAgents {
            images: Some(agents::AgentChoice::default()),
            ..OwnAgents::default()
        };
        assert!(studio.set_chat_agents(&chat.id, Some(bad)).is_err());
        studio.set_chat_agents(&chat.id, None).expect("cleared");
        assert_eq!(
            studio.agents_of_chat(Some(&chat.id)),
            studio.prefs.get().agents
        );
    }
}
