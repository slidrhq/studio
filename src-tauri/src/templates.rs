//! The built-in templates of the media library, and what a template request works on.
//!
//! A template request writes the sample deck of one built-in template in languages: one it is not
//! written in yet (a translation), or one it has (a rewrite the person describes). Each language is
//! a variant of the request, with its own Claude conversation, and each is published by itself into
//! `templates/catalog.json`, under `samples[<template>][<lang>]` (docs/media-library.md). A deck in a
//! language a sample is written in gets it; any other gets the English one ([ADR-098]).
//!
//! ```text
//! <variant>/work/brief.json      the task: the template, its names, the language, the person's words
//! <variant>/work/template.md     the theme and every layout's boxes, as Claude reads them
//! <variant>/work/en.json         the sample in English, which sets the structure, and in Hebrew
//! <variant>/work/he.json
//! <variant>/work/<lang>.json     Claude's: the sample in the variant's language (SampleSlide[])
//! <variant>/work/template.json   the template as the catalog holds it, for the render page
//! ```
//!
//! The catalog read is the author copy's (`../Slidr-media`), which is what publishing sends, and the
//! published one when there is no author copy.

use std::{
    collections::{BTreeSet, HashMap, HashSet},
    fs,
    path::{Path, PathBuf},
    sync::Arc,
    time::{Duration, Instant, SystemTime},
};

use serde::Serialize;
use serde_json::{Map, Value};

use crate::{
    languages::{self, CONTENT_LANGUAGES},
    net,
    prompts::{items, show, truthy},
    store::{Named, TemplateBrief, to_json_indented, write_json},
};

pub const CATALOG: &str = "templates/catalog.json";
/// How long a published catalog read is kept; the author copy is read again when it changes.
const PUBLISHED_TTL: Duration = Duration::from_secs(600);

/// A built-in template, with the languages its sample is written in and those it lacks.
#[derive(Debug, Clone, Serialize)]
pub struct TemplateInfo {
    pub id: String,
    pub name: Named,
    pub tagline: Named,
    pub languages: Vec<String>,
    pub missing: Vec<String>,
}

/// The languages a template's sample is written in, in the registry's order.
pub fn sample_languages(samples: Option<&Value>) -> Vec<String> {
    CONTENT_LANGUAGES
        .iter()
        .filter(|lang| {
            samples
                .and_then(|s| s.get(**lang))
                .is_some_and(Value::is_array)
        })
        .map(|lang| (*lang).to_owned())
        .collect()
}

/// The content languages a template's sample is not written in yet.
pub fn missing_languages(samples: Option<&Value>) -> Vec<String> {
    let have = sample_languages(samples);
    CONTENT_LANGUAGES
        .iter()
        .filter(|lang| !have.iter().any(|h| h == *lang))
        .map(|lang| (*lang).to_owned())
        .collect()
}

fn template_id(template: &Value) -> Option<&str> {
    template.pointer("/theme/id").and_then(Value::as_str)
}

/// Puts a template's sample in one language into a catalog of templates, replacing the one it
/// had, and keeps the languages of every sample in the registry's order.
pub fn merge_sample(
    catalog: &mut Value,
    id: &str,
    lang: &str,
    slides: Value,
) -> Result<(), String> {
    let known = items(catalog.get("templates"))
        .iter()
        .any(|template| template_id(template) == Some(id));
    if !known {
        return Err(format!("The catalog has no template {id}."));
    }
    let Some(catalog) = catalog.as_object_mut() else {
        return Err("The catalog of templates is not an object.".into());
    };
    let samples = catalog
        .entry("samples")
        .or_insert_with(|| Value::Object(Map::new()));
    if !samples.is_object() {
        *samples = Value::Object(Map::new());
    }
    let Some(samples) = samples.as_object_mut() else {
        return Ok(());
    };
    let mut mine = samples
        .get(id)
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    mine.insert(lang.to_owned(), slides);
    let mut ordered = Map::new();
    for code in CONTENT_LANGUAGES {
        if let Some(value) = mine.get(code) {
            ordered.insert(code.to_owned(), value.clone());
        }
    }
    for (code, value) in &mine {
        if !languages::is_content(code) {
            ordered.insert(code.clone(), value.clone());
        }
    }
    samples.insert(id.to_owned(), Value::Object(ordered));
    Ok(())
}

/// Where a catalog of templates differs from the published one, beside the samples in `ours`
/// ((template, language) pairs): the author's work that is not published yet, which a publication
/// of the file sends too. A part of the catalog, a template, or a sample in a language, as
/// `templates/catalog.json: samples.shidur.de`.
pub fn catalog_changes(
    local: &Value,
    published: Option<&Value>,
    ours: &HashSet<(String, String)>,
) -> Vec<String> {
    let (Some(local), Some(published)) = (local.as_object(), published.and_then(Value::as_object))
    else {
        return Vec::new();
    };
    let mut out = Vec::new();
    let keys: BTreeSet<&String> = local.keys().chain(published.keys()).collect();
    for key in keys {
        // Equal whatever the order of their keys, as `json.dumps(sort_keys=True)` compared them.
        if key != "samples" && local.get(key) != published.get(key) {
            out.push(format!("{CATALOG}: {key}"));
        }
    }
    let empty = Map::new();
    let samples =
        |side: &Map<String, Value>| side.get("samples").and_then(Value::as_object).cloned();
    let (mine, theirs) = (
        samples(local).unwrap_or_default(),
        samples(published).unwrap_or_default(),
    );
    let ids: BTreeSet<&String> = mine.keys().chain(theirs.keys()).collect();
    for id in ids {
        let a = mine.get(id).and_then(Value::as_object).unwrap_or(&empty);
        let b = theirs.get(id).and_then(Value::as_object).unwrap_or(&empty);
        for lang in CONTENT_LANGUAGES {
            if !(a.contains_key(lang) || b.contains_key(lang)) {
                continue;
            }
            if !ours.contains(&(id.clone(), lang.to_owned())) && a.get(lang) != b.get(lang) {
                out.push(format!("{CATALOG}: samples.{id}.{lang}"));
            }
        }
    }
    out
}

/// The catalog as `export-templates.mjs` writes it (`JSON.stringify(catalog)`: no spaces, no line
/// end), so that publishing changes no byte of it but the sample. Indented, the catalog of
/// sixteen-language samples would pass the 25 MB that Pages serves of a file.
pub fn encode_catalog(catalog: &Value) -> Vec<u8> {
    serde_json::to_vec(catalog).unwrap_or_default()
}

/* ---------------------------------------------------------------------- what Claude reads */

fn color(theme: &Value, color: Option<&Value>) -> String {
    let Some(color) = color.and_then(Value::as_object) else {
        return "—".into();
    };
    if let Some(token) = color.get("token") {
        let token = show(Some(token));
        let value = theme
            .pointer(&format!("/colors/{token}"))
            .map_or_else(|| token.clone(), |value| show(Some(value)));
        let alpha = match color.get("alpha") {
            Some(Value::Null) | None => String::new(),
            Some(alpha) => format!(" at {}", show(Some(alpha))),
        };
        return format!("{token} ({value}){alpha}");
    }
    color
        .get("value")
        .map_or_else(|| "—".into(), |value| show(Some(value)))
}

/// A text style in words, its size and its line height.
fn style(theme: &Value, reference: Option<&str>) -> (String, Option<f64>, Option<f64>) {
    let Some(style) = theme
        .get("textStyles")
        .and_then(|styles| styles.get(reference.unwrap_or("body")))
        .filter(|style| style.is_object())
    else {
        return (reference.unwrap_or("—").to_owned(), None, None);
    };
    let role = style
        .get("font")
        .and_then(Value::as_str)
        .filter(|role| !role.is_empty())
        .unwrap_or("body");
    let fonts = theme.pointer(&format!("/fonts/{role}"));
    let family = |key: &str| {
        fonts
            .and_then(|pair| pair.get(key))
            .map_or_else(|| "?".to_owned(), |name| show(Some(name)))
    };
    let pair = format!("{} / {}", family("latin"), family("he"));
    let size = style.get("size");
    let weight = style
        .get("weight")
        .map_or_else(|| "400".to_owned(), |w| show(Some(w)));
    let line_height = style
        .get("lineHeight")
        .filter(|height| truthy(height))
        .and_then(Value::as_f64)
        .unwrap_or(1.2);
    (
        format!(
            "{} {}px {weight} in {pair}",
            reference.unwrap_or("body"),
            show(size)
        ),
        size.and_then(Value::as_f64),
        Some(line_height),
    )
}

fn rounded(value: Option<&Value>) -> i64 {
    // Halves to the even number, as the digest has always rounded a box.
    value
        .and_then(Value::as_f64)
        .unwrap_or(0.0)
        .round_ties_even() as i64
}

/// The theme and the boxes of every layout, in words: the room each text has.
pub fn digest(template: &Value) -> String {
    let empty = Value::Object(Map::new());
    let theme = template.get("theme").unwrap_or(&empty);
    let name = theme.get("name").or_else(|| theme.get("id"));
    let mut lines = vec![
        format!("# {} (`{}`)", show(name), show(theme.get("id"))),
        String::new(),
        template
            .get("description")
            .filter(|d| truthy(d))
            .map(|d| show(Some(d)))
            .unwrap_or_default(),
        String::new(),
        "## Fonts".into(),
        String::new(),
        "A text style names a role, heading or body; each role has a family for Latin letters \
         (and every script but Hebrew) and one for Hebrew:"
            .into(),
        String::new(),
    ];
    for role in ["heading", "body"] {
        let pair = theme.pointer(&format!("/fonts/{role}"));
        let family = |key: &str| show(pair.and_then(|pair| pair.get(key)));
        lines.push(format!(
            "- {role}: `{}` for Latin and other letters, `{}` for Hebrew",
            family("latin"),
            family("he")
        ));
    }
    lines.extend(["".into(), "## Text styles".into(), "".into()]);
    if let Some(styles) = theme.get("textStyles").and_then(Value::as_object) {
        for (reference, style) in styles {
            if !style.is_object() {
                continue;
            }
            let case = style
                .get("case")
                .filter(|case| truthy(case))
                .map(|case| format!(", {} case", show(Some(case))))
                .unwrap_or_default();
            lines.push(format!(
                "- {reference}: {}px, weight {}, line height {}, {} font, colour {}{case}",
                show(style.get("size")),
                show(style.get("weight")),
                show(style.get("lineHeight")),
                show(style.get("font")),
                color(theme, style.get("color"))
            ));
        }
    }
    let direction = if template.get("dir").and_then(Value::as_str) == Some("rtl") {
        "right to left"
    } else {
        "left to right"
    };
    lines.extend([
        String::new(),
        "## Layouts".into(),
        String::new(),
        format!(
            "Drawn for {direction}; a deck of the other direction gets their mirror, with the same \
             boxes. A role that a layout has more than once is filled in the order listed, and its \
             content in the sample is a list in that order. A box is the room its text has: text \
             that outgrows it overflows the slide."
        ),
        String::new(),
    ]);
    for layout in items(template.get("layouts")) {
        lines.push(format!(
            "### `{}`: {} ({})",
            show(layout.get("id")),
            show(layout.get("archetype")),
            show(layout.get("name"))
        ));
        let placeholders = items(layout.get("placeholders"));
        let role_of = |placeholder: &Value| show(placeholder.get("role"));
        let mut counts: HashMap<String, usize> = HashMap::new();
        for placeholder in placeholders {
            *counts.entry(role_of(placeholder)).or_default() += 1;
        }
        let mut seen: HashMap<String, usize> = HashMap::new();
        for placeholder in placeholders {
            let role = role_of(placeholder);
            let index = {
                let seen = seen.entry(role.clone()).or_default();
                *seen += 1;
                *seen
            };
            let frame = placeholder.get("frame");
            let w = rounded(frame.and_then(|f| f.get("w")));
            let h = rounded(frame.and_then(|f| f.get("h")));
            let count = counts.get(&role).copied().unwrap_or(1);
            let name = if count > 1 {
                format!("{role} {index} of {count}")
            } else {
                role.clone()
            };
            if ["image", "chart", "table"].contains(&role.as_str()) {
                lines.push(format!("- {name}: {w}×{h}"));
                continue;
            }
            let reference = placeholder.get("styleRef").and_then(Value::as_str);
            let (words, size, height) = style(theme, reference);
            let fits = match (size, height) {
                (Some(size), Some(height)) if size != 0.0 && height != 0.0 && h != 0 => {
                    let lines_held = ((h as f64) / (size * height)).floor().max(1.0);
                    format!(", about {lines_held} line(s)")
                }
                _ => String::new(),
            };
            let mut extra = Vec::new();
            if let Some(text_color) = placeholder.get("color").filter(|c| truthy(c)) {
                extra.push(format!("text colour {}", color(theme, Some(text_color))));
            }
            if let Some(align) = placeholder.get("align").filter(|a| truthy(a)) {
                extra.push(format!("aligned {}", show(Some(align))));
            }
            let extra = if extra.is_empty() {
                String::new()
            } else {
                format!("; {}", extra.join(", "))
            };
            lines.push(format!("- {name}: {w}×{h} px, {words}{fits}{extra}"));
        }
        lines.push(String::new());
    }
    format!("{}\n", lines.join("\n").trim())
}

pub fn pretty(slides: &Value) -> String {
    format!("{}\n", to_json_indented(slides))
}

/// The file of a sample in a language: `de.json`, `pt-BR.json`.
pub fn sample_file(lang: &str) -> String {
    format!("{lang}.json")
}

/// When a catalog was read, and from where.
#[derive(Clone, PartialEq)]
enum Read {
    Local(SystemTime),
    Published(Instant),
}

/// The catalog of templates, read when it is asked for.
pub struct Templates {
    media_dir: Option<PathBuf>,
    media_url: String,
    read: tokio::sync::Mutex<Option<(Read, Arc<Value>)>>,
}

impl Templates {
    pub fn new(media_dir: Option<PathBuf>, media_url: String) -> Self {
        Self {
            media_dir,
            media_url,
            read: tokio::sync::Mutex::new(None),
        }
    }

    pub fn local(&self) -> Option<PathBuf> {
        self.media_dir.as_ref().map(|dir| dir.join(CATALOG))
    }

    /// The author copy's catalog when there is one, else the published one.
    pub async fn catalog(&self) -> Result<Arc<Value>, String> {
        let mut read = self.read.lock().await;
        let local = self.local().filter(|path| path.is_file());
        let (key, data) = if let Some(local) = local {
            let modified = fs::metadata(&local)
                .and_then(|meta| meta.modified())
                .unwrap_or(SystemTime::UNIX_EPOCH);
            let key = Read::Local(modified);
            if let Some((known, data)) = read.as_ref()
                && *known == key
            {
                return Ok(Arc::clone(data));
            }
            let text =
                fs::read_to_string(&local).map_err(|e| format!("{}: {e}", local.display()))?;
            let data: Value =
                serde_json::from_str(&text).map_err(|e| format!("{}: {e}", local.display()))?;
            (key, data)
        } else {
            if let Some((Read::Published(at), data)) = read.as_ref()
                && at.elapsed() < PUBLISHED_TTL
            {
                return Ok(Arc::clone(data));
            }
            let url = format!("{}/{CATALOG}", self.media_url.trim_end_matches('/'));
            let data = net::fetch_json(&url, Duration::from_secs(120))
                .await
                .map_err(|e| format!("Could not read the library's templates ({url}): {e}"))?;
            (Read::Published(Instant::now()), data)
        };
        if !data.get("templates").is_some_and(Value::is_array) {
            return Err("The catalog of templates holds no templates.".into());
        }
        let data = Arc::new(data);
        *read = Some((key, Arc::clone(&data)));
        Ok(data)
    }

    pub async fn forget(&self) {
        *self.read.lock().await = None;
    }

    /// Every built-in template: its id, its names and tagline in Hebrew and English (the app's
    /// words), the languages its sample is written in, and those it is not.
    pub async fn listing(&self, words: &Value) -> Result<Vec<TemplateInfo>, String> {
        let catalog = self.catalog().await?;
        let word = |lang: &str, key: &str, id: &str| {
            words
                .pointer(&format!("/{lang}/{key}"))
                .and_then(|table| table.get(id))
                .and_then(Value::as_str)
                .map(str::to_owned)
        };
        let mut out = Vec::new();
        for template in items(catalog.get("templates")) {
            let Some(id) = template_id(template) else {
                continue;
            };
            let own = template
                .pointer("/theme/name")
                .and_then(Value::as_str)
                .unwrap_or(id)
                .to_owned();
            let samples = catalog.get("samples").and_then(|samples| samples.get(id));
            out.push(TemplateInfo {
                id: id.to_owned(),
                name: Named {
                    he: word("he", "name", id).unwrap_or_else(|| own.clone()),
                    en: word("en", "name", id).unwrap_or(own),
                },
                tagline: Named {
                    he: word("he", "tagline", id).unwrap_or_default(),
                    en: word("en", "tagline", id).unwrap_or_default(),
                },
                languages: sample_languages(samples),
                missing: missing_languages(samples),
            });
        }
        Ok(out)
    }

    /// A template as the catalog holds it, and its samples by language.
    pub async fn template(&self, id: &str) -> Result<(Value, Map<String, Value>), String> {
        let catalog = self.catalog().await?;
        let template = items(catalog.get("templates"))
            .iter()
            .find(|template| template_id(template) == Some(id))
            .cloned()
            .ok_or_else(|| format!("The library has no template {id}."))?;
        let samples = catalog
            .get("samples")
            .and_then(|samples| samples.get(id))
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default();
        if !samples.get("en").is_some_and(Value::is_array) {
            return Err(format!(
                "The template {id} has no English sample to start from."
            ));
        }
        Ok((template, samples))
    }

    /// Writes what a template variant starts from into its folder: the template, its digest, the
    /// English and Hebrew samples, and the sample in the variant's language when the template has
    /// one already (a rewrite).
    pub async fn prepare_work(&self, work: &Path, brief: &TemplateBrief) -> Result<(), String> {
        let (template, samples) = self.template(&brief.template_id).await?;
        let failed = |e: std::io::Error| format!("{}: {e}", work.display());
        fs::create_dir_all(work).map_err(failed)?;
        write_json(&work.join("brief.json"), brief).map_err(failed)?;
        fs::write(
            work.join("template.json"),
            serde_json::to_vec(&template).unwrap_or_default(),
        )
        .map_err(failed)?;
        fs::write(work.join("template.md"), digest(&template)).map_err(failed)?;
        let mut langs = vec!["en", "he"];
        if !languages::is_base(&brief.lang) {
            langs.push(&brief.lang);
        }
        for lang in langs {
            if let Some(sample) = samples.get(lang).filter(|s| s.is_array()) {
                fs::write(work.join(sample_file(lang)), pretty(sample)).map_err(failed)?;
            }
        }
        Ok(())
    }
}

/// The task of one variant of a template request.
pub fn template_brief(
    template: &TemplateInfo,
    names: Named,
    lang: &str,
    instructions: &str,
) -> TemplateBrief {
    TemplateBrief {
        template_id: template.id.clone(),
        name: names,
        tagline: serde_json::to_value(&template.tagline).unwrap_or_default(),
        lang: lang.to_owned(),
        language: languages::name(lang).to_owned(),
        dir: languages::direction(lang).to_owned(),
        rewrite: template.languages.iter().any(|known| known == lang),
        instructions: instructions.to_owned(),
    }
}

#[cfg(test)]
pub mod tests {
    use serde_json::json;

    use super::*;

    fn paragraphs(lines: &[&str]) -> Value {
        json!({"paragraphs": lines.iter().map(|line| json!({"dir": "auto", "align": "start", "runs": [{"text": line}]})).collect::<Vec<_>>()})
    }

    pub fn template() -> Value {
        json!({
            "theme": {
                "id": "mifgash",
                "name": "Mifgash",
                "colors": {"bg": "#1a24a6", "text": "#ffffff", "muted": "#e3e6ff"},
                "fonts": {"heading": {"he": "Rubik", "latin": "Montserrat"}, "body": {"he": "Heebo", "latin": "Montserrat"}},
                "textStyles": {
                    "title": {"font": "heading", "size": 60, "weight": 700, "lineHeight": 1.15, "color": {"token": "text"}},
                    "body": {"font": "body", "size": 26, "weight": 400, "lineHeight": 1.5, "color": {"token": "text"}},
                },
            },
            "description": "Online session.",
            "dir": "rtl",
            "layouts": [{
                "id": "l_cards",
                "name": "Cards",
                "archetype": "cards",
                "placeholders": [
                    {"id": "p1", "role": "title", "frame": {"x": 0, "y": 0, "w": 1300, "h": 148}, "styleRef": "title"},
                    {"id": "p2", "role": "body", "frame": {"x": 0, "y": 0, "w": 500, "h": 120}, "styleRef": "body",
                     "color": {"token": "bg"}},
                    {"id": "p3", "role": "body", "frame": {"x": 0, "y": 0, "w": 500, "h": 120}, "styleRef": "body"},
                    {"id": "p4", "role": "image", "frame": {"x": 0, "y": 0, "w": 604, "h": 560}},
                ],
                "decorations": [],
            }],
        })
    }

    pub fn english() -> Value {
        json!([{
            "layout": "l_cards",
            "name": "Three sessions",
            "content": {"title": paragraphs(&["Three evenings"]), "body": [paragraphs(&["One"]), paragraphs(&["Two"])]},
        }])
    }

    pub fn hebrew() -> Value {
        json!([{
            "layout": "l_cards",
            "name": "שלושה מפגשים",
            "content": {"title": paragraphs(&["שלושה ערבים"]), "body": [paragraphs(&["אחד"]), paragraphs(&["שניים"])]},
        }])
    }

    pub fn catalog() -> Value {
        json!({"templates": [template()], "samples": {"mifgash": {"he": hebrew(), "en": english()}}, "pictures": {}, "originals": {}})
    }

    pub fn listing_entry() -> TemplateInfo {
        TemplateInfo {
            id: "mifgash".into(),
            name: Named {
                he: "מפגש".into(),
                en: "Mifgash".into(),
            },
            tagline: Named {
                he: String::new(),
                en: "Blue".into(),
            },
            languages: vec!["he".into(), "en".into()],
            missing: vec!["ar".into(), "de".into()],
        }
    }

    #[test]
    fn the_languages_a_template_lacks_are_the_registrys_others() {
        let samples = json!({"en": [], "he": [], "de": [], "x": []});
        assert_eq!(sample_languages(Some(&samples)), ["he", "en", "de"]);
        let missing = missing_languages(Some(&json!({"he": [], "en": []})));
        assert_eq!(missing.len(), 14);
        assert!(!missing.iter().any(|lang| lang == "he" || lang == "en"));
    }

    #[test]
    fn a_sample_is_merged_in_the_registrys_order_and_written_as_node_writes_it() {
        let mut catalog = catalog();
        merge_sample(
            &mut catalog,
            "mifgash",
            "ja",
            json!([{"layout": "l_cards"}]),
        )
        .expect("merged");
        merge_sample(
            &mut catalog,
            "mifgash",
            "de",
            json!([{"layout": "l_cards"}]),
        )
        .expect("merged");
        let order: Vec<&String> = catalog["samples"]["mifgash"]
            .as_object()
            .map(|samples| samples.keys().collect())
            .unwrap_or_default();
        assert_eq!(order, ["he", "en", "de", "ja"]);
        merge_sample(
            &mut catalog,
            "mifgash",
            "de",
            json!([{"layout": "l_cards", "name": "Drei"}]),
        )
        .expect("merged");
        assert_eq!(
            catalog["samples"]["mifgash"]["de"],
            json!([{"layout": "l_cards", "name": "Drei"}])
        );
        assert!(merge_sample(&mut catalog, "nosuch", "de", json!([])).is_err());
        // `JSON.stringify(…)`: no spaces and no line end, letters as they are.
        assert_eq!(
            encode_catalog(&json!({"a": [1, {"b": "שלום"}]})),
            "{\"a\":[1,{\"b\":\"שלום\"}]}".as_bytes()
        );
    }

    #[tokio::test]
    async fn the_listing_names_each_template_in_the_apps_words() {
        let dir = tempfile::tempdir().expect("a folder");
        let mut catalog = catalog();
        catalog["samples"]["mifgash"]["de"] = english();
        write_json(&dir.path().join(CATALOG), &catalog).expect("written");
        let templates = Templates::new(Some(dir.path().to_path_buf()), "http://unused/".into());
        let listing = templates
            .listing(&json!({"he": {"name": {"mifgash": "מפגש"}}}))
            .await
            .expect("a listing");
        assert_eq!(
            listing[0].name,
            Named {
                he: "מפגש".into(),
                en: "Mifgash".into()
            }
        );
        assert_eq!(listing[0].languages, ["he", "en", "de"]);
        assert!(!listing[0].missing.iter().any(|lang| lang == "de"));
    }

    #[test]
    fn the_digest_names_every_box_and_the_room_it_has() {
        let text = digest(&template());
        assert!(text.contains("`l_cards`: cards"));
        assert!(
            text.contains(
                "title: 1300×148 px, title 60px 700 in Montserrat / Rubik, about 2 line(s)"
            )
        );
        assert!(
            text.contains("body 1 of 2: 500×120 px") && text.contains("text colour bg (#1a24a6)")
        );
        assert!(text.contains("image: 604×560"));
    }

    #[tokio::test]
    async fn a_rewrite_starts_from_the_sample_the_template_has() {
        let dir = tempfile::tempdir().expect("a folder");
        let mut catalog = catalog();
        catalog["samples"]["mifgash"]["de"] = english();
        write_json(&dir.path().join("media").join(CATALOG), &catalog).expect("written");
        let templates = Templates::new(Some(dir.path().join("media")), "http://unused/".into());
        let mut entry = listing_entry();
        entry.languages.push("de".into());
        let brief = template_brief(&entry, entry.name.clone(), "de", "");
        assert!(brief.rewrite);
        let work = dir.path().join("work");
        templates
            .prepare_work(&work, &brief)
            .await
            .expect("prepared");
        let written: Value =
            serde_json::from_str(&fs::read_to_string(work.join("de.json")).expect("de.json"))
                .expect("JSON");
        assert_eq!(written, english());
    }

    #[test]
    fn the_catalogs_unpublished_work_is_listed_beside_ours() {
        let published = catalog();
        let mut local = catalog();
        local["samples"]["mifgash"]["ar"] = hebrew();
        local["samples"]["mifgash"]["ja"] = english();
        local["pictures"] = json!({"x": {"id": "1"}});
        let ours = HashSet::from([("mifgash".to_owned(), "ar".to_owned())]);
        assert_eq!(
            catalog_changes(&local, Some(&published), &ours),
            [
                "templates/catalog.json: pictures",
                "templates/catalog.json: samples.mifgash.ja"
            ]
        );
        assert!(catalog_changes(&local, None, &ours).is_empty());
    }
}
