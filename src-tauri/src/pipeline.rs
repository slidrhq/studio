//! The work of a request: a design request plans concepts and makes each one a design; a template
//! request writes the sample deck of a built-in template in languages, a variant each.
//!
//! ```text
//! design request ──plan (Claude, structured)──► N concepts ──► one variant each, side by side:
//!   variant: picture (Codex) ─► HTML in each language of the request (Claude, looking at it)
//!            ─► render + design check (a hidden window, the app's engine) ─► review rounds (Claude
//!            looks at the renders and fixes) ─► ready: the person approves, or asks for a change
//!
//! template request ──► one variant for each language, side by side:
//!   variant: the template, its digest and its English and Hebrew samples ─► <lang>.json (Claude)
//!            ─► build with the app's engine, render every slide, design check ─► review rounds
//!            ─► ready: the person approves, or asks for a change
//!
//! a request in words (kind "auto") ──route (Claude, structured)──► a design or a template request
//! ```
//!
//! Each variant keeps one Claude conversation, so a review or a change asked for later is a turn of
//! the same session, with everything it saw before.
//!
//! A design request names its languages (`languages.rs`): Hebrew and English always, and the others
//! the person chose. Every concept of it is planned, written, rendered, reviewed and published in
//! exactly those, one HTML file per language; a request without a choice is Hebrew and English. A
//! template request names the languages its sample is to be written in (`templates.rs`).
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

use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tokio::sync::Semaphore;
use tokio_util::sync::CancellationToken;

use crate::{
    claude::{self, ClaudeCall},
    codex::{self, CodexErrorKind},
    config::Settings,
    instructions::{self, Instructions, quality_bar},
    languages,
    library::{Library, design_tags},
    prompts::{self, items, truthy},
    render::{forget_old, render_dir},
    store::{
        Brief, DesignBrief, ImageBrief, ImageInfo, Named, NewVariant, RenderSummary, Request,
        RequestKind, RequestStatus, Route, Store, Variant, VariantKind, VariantStatus, read_json,
        write_json,
    },
    template_prompts,
    templates::{TemplateInfo, Templates, sample_file, template_brief},
};

const TOOLS: [&str; 4] = ["Read", "Write", "Edit", "Glob"];

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

/// The files Claude must write: a design's HTML file for each language, or a template's sample in
/// the variant's language.
pub fn outputs(variant: &Variant, langs: &[String]) -> Vec<String> {
    match (&variant.kind, &variant.lang) {
        (VariantKind::Template, Some(lang)) => vec![sample_file(lang)],
        _ => langs.iter().map(|lang| languages::file_of(lang)).collect(),
    }
}

/// The files Claude writes: its outputs, and a design's brief.
pub fn watched(variant: &Variant, langs: &[String]) -> Vec<String> {
    let mut files = outputs(variant, langs);
    if !variant.is_template() {
        files.push("brief.json".into());
    }
    files
}

/// The outputs that are not written yet.
pub fn missing_files(work: &Path, variant: &Variant, langs: &[String]) -> Vec<String> {
    outputs(variant, langs)
        .into_iter()
        .filter(|name| !work.join(name).exists())
        .collect()
}

fn fingerprint(
    work: &Path,
    variant: &Variant,
    langs: &[String],
) -> HashMap<String, Option<String>> {
    watched(variant, langs)
        .into_iter()
        .map(|name| {
            let hash = fs::read(work.join(&name))
                .ok()
                .map(|bytes| format!("{:x}", Sha256::digest(bytes)));
            (name, hash)
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

/// How a task ended.
enum Ended {
    Done(Result<(), String>),
    Cancelled,
}

type Work = Pin<Box<dyn Future<Output = Result<(), String>> + Send>>;

pub struct Studio {
    pub settings: Arc<Settings>,
    pub store: Arc<Store>,
    pub instructions: Arc<Instructions>,
    pub library: Arc<Library>,
    pub templates: Arc<Templates>,
    renderer: Arc<dyn Renderer>,
    claude_slots: Semaphore,
    codex_slots: Semaphore,
    render_slots: Semaphore,
    /// The running work, by request or variant id.
    tasks: Mutex<HashMap<String, (u64, CancellationToken)>>,
    next_task: AtomicU64,
}

impl Studio {
    pub fn new(
        settings: Arc<Settings>,
        store: Arc<Store>,
        instructions: Arc<Instructions>,
        library: Arc<Library>,
        templates: Arc<Templates>,
        renderer: Arc<dyn Renderer>,
    ) -> Self {
        Self {
            claude_slots: Semaphore::new(settings.max_claude),
            codex_slots: Semaphore::new(settings.max_codex),
            render_slots: Semaphore::new(settings.max_render),
            settings,
            store,
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

    /// The languages a variant is made in: a template variant's one language; a design's own, else
    /// its request's, else Hebrew and English (a variant from before there was a choice).
    pub fn languages_of(&self, variant: &Variant) -> Vec<String> {
        if let (VariantKind::Template, Some(lang)) = (&variant.kind, &variant.lang) {
            return vec![lang.clone()];
        }
        let request = self.options(variant).and_then(|request| request.languages);
        languages::chosen(&[variant.languages.as_ref(), request.as_ref()])
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

    /* -------------------------------------------------------------- requests */

    /// Starts a request's work; the request as it is now.
    pub fn start_request(self: &Arc<Self>, draft: Request, count: u32) -> Result<Request, String> {
        let request = self.store.create_request(draft);
        let studio = Arc::clone(self);
        let rid = request.id.clone();
        self.spawn_request(
            &request.id,
            Box::pin(async move { studio.begin(rid, count).await }),
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
        self.spawn_request(rid, Box::pin(async move { studio.plan(&id, count).await }))?;
        Ok(request)
    }

    /// Reads a request in words when its kind was not given, then starts its work.
    async fn begin(self: Arc<Self>, rid: String, count: u32) -> Result<(), String> {
        if self.request(&rid)?.kind == RequestKind::Auto {
            self.route(&rid).await?;
        }
        if self.request(&rid)?.kind == RequestKind::Template {
            self.plan_template(&rid).await
        } else {
            self.plan(&rid, count).await
        }
    }

    /// Asks Claude which kind of work a request in words is, and gives the request that kind and
    /// what it needs: a template and its languages, or nothing more for a design.
    async fn route(&self, rid: &str) -> Result<(), String> {
        let listing = self.template_listing().await?;
        let request = self.request(rid)?;
        let folder = self.store.request_dir(rid).join("plan");
        fs::create_dir_all(&folder).map_err(|e| e.to_string())?;
        let system = folder.join("system-route.md");
        fs::write(&system, template_prompts::ROUTE_SYSTEM).map_err(|e| e.to_string())?;
        let mut call = ClaudeCall::new(
            template_prompts::route_prompt(&request.prompt, &listing),
            folder,
            system,
        );
        call.session_id = Some(uuid::Uuid::new_v4().to_string());
        call.model = Some(request.model.clone()).filter(|m| !m.is_empty());
        call.effort = Some(request.effort.clone()).filter(|e| !e.is_empty());
        call.json_schema = Some(template_prompts::route_schema());
        call.timeout = Duration::from_secs(10 * 60);
        let result = {
            let _slot = self
                .claude_slots
                .acquire()
                .await
                .map_err(|e| e.to_string())?;
            claude::run(call, |_, _| {}).await?
        };
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
                    request.languages = Some(languages::chosen(&[request.languages.as_ref()]));
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

    /// A variant for each language of a template request that has none yet.
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
        let langs = languages::known(request.languages.as_deref().unwrap_or_default())?;
        if langs.is_empty() {
            return Err("Name at least one language to write the sample in.".into());
        }
        let has: HashSet<String> = request
            .variant_ids
            .iter()
            .filter_map(|vid| self.store.variant(vid))
            .filter(|variant| !variant.discarded)
            .filter_map(|variant| variant.lang)
            .collect();
        let instructions = request.instructions.clone().unwrap_or_default();
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

    async fn plan(self: &Arc<Self>, rid: &str, count: u32) -> Result<(), String> {
        let known = self.library.known(false).await;
        let mut taken: HashSet<String> = known.ids.iter().cloned().collect();
        taken.extend(self.store.all_design_ids());
        let request = self.request(rid)?;
        let plan_dir = self.store.request_dir(rid).join("plan");
        let langs = languages::chosen(&[request.languages.as_ref()]);
        let (system_plan, _) = self.system_files(&plan_dir, &langs).await?;
        let made: Vec<String> = request
            .variant_ids
            .iter()
            .filter_map(|vid| self.store.variant(vid))
            .map(|variant| {
                let concept = variant
                    .brief
                    .design()
                    .map_or("", |design| design.concept.as_str());
                format!("{}: {concept}", variant.brief.name().en)
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
            &langs,
        );
        if !made.is_empty() {
            prompt.push_str(
                "\n\nThis request already has these designs; the new ones must differ from each of \
                 them:\n",
            );
            prompt.push_str(
                &made
                    .iter()
                    .map(|m| format!("- {m}"))
                    .collect::<Vec<_>>()
                    .join("\n"),
            );
        }
        let mut call = ClaudeCall::new(prompt, plan_dir, system_plan);
        call.session_id = Some(uuid::Uuid::new_v4().to_string());
        call.model = Some(request.model.clone()).filter(|m| !m.is_empty());
        call.effort = Some(request.effort.clone()).filter(|e| !e.is_empty());
        call.json_schema = Some(prompts::plan_schema(&langs));
        call.timeout = Duration::from_secs(20 * 60);
        let result = {
            let _slot = self
                .claude_slots
                .acquire()
                .await
                .map_err(|e| e.to_string())?;
            claude::run(call, |_, _| {}).await?
        };
        let concepts: Vec<Value> = items(result.structured.get("concepts"))
            .iter()
            .take(count as usize)
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
            request.status = RequestStatus::Ready;
        });
        for concept in &concepts {
            let brief = make_brief(concept, &mut taken, group);
            let variant = self
                .store
                .create_variant(rid, Brief::Design(brief), NewVariant::default())
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
        if self.variant(vid)?.is_template() {
            self.make_template_steps(vid).await
        } else {
            self.make_steps(vid).await
        }
    }

    fn review_rounds(&self, variant: &Variant) -> u32 {
        self.options(variant)
            .map_or(2, |request| request.review_rounds)
    }

    /// The latest render's folder, as Claude names it from its own folder.
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
    /// the sample's contract.
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
        if variant.session_id.is_none() || !missing_files(&work, &variant, &langs).is_empty() {
            self.store.update_variant(vid, |v| v.session_id = None);
            self.turn(
                vid,
                VariantStatus::Writing,
                template_prompts::build_prompt(brief),
            )
            .await?;
        }
        let mut result = self.render(vid).await?;
        let rounds = self.review_rounds(&variant);
        while let Some(round) = self.next_review(vid, rounds) {
            let prompt =
                template_prompts::review_prompt(&result, round, rounds, &self.renders(vid), &lang);
            if !self.turn(vid, VariantStatus::Reviewing, prompt).await? {
                self.store.log(
                    vid,
                    "info",
                    "Claude reviewed the renders and changed nothing.",
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
                "The sample breaks its contract; Claude fixes it.",
            );
            let prompt = template_prompts::fix_prompt(&result, &self.renders(vid), &lang);
            if self.turn(vid, VariantStatus::Reviewing, prompt).await? {
                self.render(vid).await?;
            }
        }
        Ok(())
    }

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
        let langs = self.languages_of(&variant);
        if variant.session_id.is_none() || !missing_files(&work, &variant, &langs).is_empty() {
            self.store.update_variant(vid, |v| v.session_id = None);
            let variant = self.variant(vid)?;
            let brief = variant.brief.design().cloned().unwrap_or_default();
            let size = picture_size(&work.join("subject.png"))?;
            self.turn(
                vid,
                VariantStatus::Writing,
                prompts::build_prompt(&brief, size, &langs),
            )
            .await?;
            self.apply_brief(vid).await?;
        }
        let mut result = self.render(vid).await?;
        let rounds = self.review_rounds(&variant);
        while let Some(round) = self.next_review(vid, rounds) {
            let prompt = prompts::review_prompt(&result, round, rounds, &self.renders(vid), &langs);
            if !self.turn(vid, VariantStatus::Reviewing, prompt).await? {
                self.store.log(
                    vid,
                    "info",
                    "Claude reviewed the renders and changed nothing.",
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
                "The design breaks the gallery's contract; Claude fixes it.",
            );
            let prompt = prompts::fix_prompt(&result, &self.renders(vid), &langs);
            if self.turn(vid, VariantStatus::Reviewing, prompt).await? {
                self.apply_brief(vid).await?;
                self.render(vid).await?;
            }
        }
        Ok(())
    }

    /// One turn of the variant's Claude session. True when it changed a file.
    async fn turn(&self, vid: &str, stage: VariantStatus, prompt: String) -> Result<bool, String> {
        let variant = self.variant(vid)?;
        let work = self.store.work_dir(&variant);
        let langs = self.languages_of(&variant);
        let system = if variant.is_template() {
            self.template_system_file(&variant).await?
        } else {
            self.system_files(&self.store.variant_dir(&variant), &langs)
                .await?
                .1
        };
        let before = fingerprint(&work, &variant, &langs);
        self.set(vid, stage, Some("waiting for Claude"));
        let result = {
            let _slot = self
                .claude_slots
                .acquire()
                .await
                .map_err(|e| e.to_string())?;
            self.set(vid, stage, None);
            let (first, session) = self
                .store
                .update_variant(vid, |v| {
                    let first = v.session_id.is_none();
                    if first {
                        v.session_id = Some(uuid::Uuid::new_v4().to_string());
                    }
                    (first, v.session_id.clone())
                })
                .ok_or("No such variant.")?;
            let options = self.options(&variant);
            let mut call = ClaudeCall::new(prompt, work.clone(), system);
            call.tools = TOOLS.to_vec();
            if first {
                call.session_id = session;
            } else {
                call.resume = session;
            }
            call.model = options
                .as_ref()
                .map(|o| o.model.clone())
                .filter(|m| !m.is_empty());
            call.effort = options
                .as_ref()
                .map(|o| o.effort.clone())
                .filter(|e| !e.is_empty());
            let store = Arc::clone(&self.store);
            let id = vid.to_owned();
            claude::run(call, move |kind, text| store.log(&id, kind, text)).await?
        };
        self.store.update_variant(vid, |v| {
            v.cost = round4(v.cost + result.cost);
            if let Some(session) = &result.session_id {
                v.session_id = Some(session.clone());
            }
            if !result.text.is_empty() {
                v.push_log("claude", result.text.chars().take(1500).collect::<String>());
            }
        });
        let after = fingerprint(&work, &variant, &langs);
        let missing = missing_files(&work, &variant, &langs);
        if !missing.is_empty() {
            return Err(format!(
                "Claude did not write {}.",
                languages::listing(&missing, "and")
            ));
        }
        Ok(before != after)
    }

    /// Takes what Claude changed in brief.json: names, group and tags, or a new picture.
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
        if let Some(tags) = design_tags(written.get("tags")) {
            brief.tags = tags;
        }
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

    async fn image(&self, vid: &str, edit: Option<String>) -> Result<(), String> {
        let variant = self.variant(vid)?;
        let work = self.store.work_dir(&variant);
        let image = variant
            .brief
            .design()
            .map(|d| d.image.clone())
            .unwrap_or_default();
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
        if variant.session_id.is_none() {
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
            self.turn(
                vid,
                VariantStatus::Writing,
                template_prompts::feedback_prompt(feedback, lang),
            )
            .await?;
            let result = self.render(vid).await?;
            if has_errors(&result) {
                let prompt = template_prompts::fix_prompt(&result, &self.renders(vid), lang);
                if self.turn(vid, VariantStatus::Reviewing, prompt).await? {
                    self.render(vid).await?;
                }
            }
            return Ok(());
        }
        let langs = self.languages_of(&variant);
        self.turn(
            vid,
            VariantStatus::Writing,
            prompts::feedback_prompt(feedback, &langs),
        )
        .await?;
        self.apply_brief(vid).await?;
        let result = self.render(vid).await?;
        if has_errors(&result) {
            let prompt = prompts::fix_prompt(&result, &self.renders(vid), &langs);
            if self.turn(vid, VariantStatus::Reviewing, prompt).await? {
                self.apply_brief(vid).await?;
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

    pub fn approve(&self, vid: &str, approved: bool) -> Result<(), String> {
        let variant = self.variant(vid)?;
        if approved {
            if variant.status != VariantStatus::Ready {
                return Err("Only a finished design can be approved.".into());
            }
            if !variant
                .render
                .as_ref()
                .is_some_and(|render| render.publishable)
            {
                return Err(
                    "Its last render did not pass the gallery's contract; ask for a fix first."
                        .into(),
                );
            }
        }
        self.store.update_variant(vid, |v| {
            v.approved = approved;
            v.push_log(
                "approval",
                if approved {
                    "Approved for publishing."
                } else {
                    "Approval withdrawn."
                },
            );
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

    /// What the render page converts: the HTML of every language of a design and its picture, or
    /// a template and its sample in the variant's language, with the English one it is held to.
    pub fn render_input(&self, vid: &str) -> Result<Value, String> {
        let variant = self.variant(vid)?;
        let work = self.store.work_dir(&variant);
        if variant.is_template() {
            return template_render_input(&variant, &work);
        }
        let langs = self.languages_of(&variant);
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
        tags: design_tags(concept.get("tags")).unwrap_or_default(),
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

    fn studio(root: &Path, media: Option<PathBuf>) -> Arc<Studio> {
        let settings = Arc::new(Settings::new(root.to_path_buf(), media.clone(), None));
        let store = Arc::new(store(&settings.requests_dir()));
        let templates = Arc::new(Templates::new(media, "http://127.0.0.1:9/".into()));
        let library = Arc::new(Library::new(
            Arc::clone(&settings),
            Arc::clone(&store),
            Arc::clone(&templates),
            Arc::new(|_| {}),
        ));
        Arc::new(Studio::new(
            settings,
            store,
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
        let studio = studio(dir.path(), None);
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
        assert_eq!(
            watched(&variant, &langs(&["he", "en", "ar", "ja"])),
            ["he.html", "en.html", "ar.html", "ja.html", "brief.json"]
        );
    }

    #[test]
    fn a_variant_from_before_the_choice_is_hebrew_and_english() {
        let dir = tempfile::tempdir().expect("a folder");
        let studio = studio(dir.path(), None);
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
        let studio = studio(dir.path(), None);
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
        let media = dir.path().join("media");
        write_json(&media.join("templates/catalog.json"), &catalog()).expect("written");
        let studio = studio(&dir.path().join("data"), Some(media));
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
        assert_eq!(watched(&variant, &langs(&["de"])), ["de.json"]);
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
}
