//! The instructions the studio builds its prompts from, read from the app, never copied:
//!
//! - the design guidelines and the HTML conventions the app gives its own design agent
//!   (`packages/prompts`), and the names and taglines of its built-in templates in Hebrew and
//!   English (`desktop/src/templates/messages.ts`): `instructions.json`, which
//!   `web/tools/instructions.mjs` writes from the app's code in `vendor/` whenever it is copied
//!   in again (`pnpm vendor`), and `pnpm check` holds to it;
//! - the repository's design quality instruction (`vendor/AGENTS.md`);
//! - the fonts of decks the media library offers (`fonts/catalog.json`), read when first needed.

use std::{
    collections::HashMap,
    sync::{Arc, LazyLock},
    time::Duration,
};

use serde::Deserialize;
use serde_json::Value;

use crate::{
    languages::{self, files, listing, names},
    net,
};

/// The script tags of the font catalog, by name.
pub fn script_name(script: &str) -> &str {
    match script {
        "he" => "Hebrew",
        "latin" => "Latin",
        "arabic" => "Arabic",
        "cyrillic" => "Cyrillic",
        "vietnamese" => "Vietnamese",
        "devanagari" => "Devanagari",
        "japanese" => "Japanese",
        "korean" => "Korean",
        "chinese" => "Chinese",
        other => other,
    }
}

/// The font of Windows that draws a language's letters when no family of the library has them.
pub fn system_font(lang: &str) -> Option<&'static str> {
    match lang {
        "ja" => Some("Yu Gothic"),
        "ko" => Some("Malgun Gothic"),
        "zh-CN" => Some("Microsoft YaHei"),
        "hi" => Some("Nirmala UI"),
        _ => None,
    }
}

/// What the app tells its design agent, and the names of its templates.
#[derive(Debug, Deserialize)]
pub struct AppInstructions {
    pub design: String,
    pub html: String,
    /// `{ he: { name: {id: …}, tagline: {id: …} }, en: … }`
    pub templates: Value,
}

static APP: LazyLock<AppInstructions> = LazyLock::new(|| {
    serde_json::from_str(include_str!("../instructions.json"))
        .expect("instructions.json is written by web/tools/instructions.mjs")
});

pub fn app() -> &'static AppInstructions {
    &APP
}

/// AGENTS.md without its title.
pub fn quality_bar() -> String {
    include_str!("../../vendor/AGENTS.md")
        .lines()
        .filter(|line| !line.starts_with("# "))
        .collect::<Vec<_>>()
        .join("\n")
        .trim()
        .to_owned()
}

/// A family of the library's deck fonts, with the scripts it covers.
#[derive(Debug, Clone, Deserialize)]
pub struct Font {
    pub family: String,
    #[serde(default)]
    pub scripts: Vec<String>,
    /// The scripts it was made for, when the catalog says.
    #[serde(default, rename = "for")]
    pub made_for: Option<Vec<String>>,
    /// The family closest to it in character for the letters of a script it lacks (ADR-105).
    #[serde(default)]
    pub counterparts: Option<HashMap<String, String>>,
}

impl Font {
    pub fn counterpart(&self, script: &str) -> Option<&str> {
        self.counterparts.as_ref()?.get(script).map(String::as_str)
    }

    /// What it was made for: as the catalog says, else its first script, else Latin.
    fn made(&self) -> Vec<String> {
        match &self.made_for {
            Some(made) if !made.is_empty() => made.clone(),
            _ => vec![
                self.scripts
                    .first()
                    .cloned()
                    .unwrap_or_else(|| "latin".into()),
            ],
        }
    }
}

pub struct Instructions {
    media_url: String,
    fonts: tokio::sync::Mutex<Option<Arc<Vec<Font>>>>,
}

impl Instructions {
    pub fn new(media_url: String) -> Self {
        Self {
            media_url,
            fonts: tokio::sync::Mutex::new(None),
        }
    }

    /// The families of the library's deck fonts, read once.
    pub async fn fonts(&self) -> Result<Arc<Vec<Font>>, String> {
        let mut fonts = self.fonts.lock().await;
        if let Some(fonts) = fonts.as_ref() {
            return Ok(Arc::clone(fonts));
        }
        let url = format!(
            "{}/fonts/catalog.json",
            self.media_url.trim_end_matches('/')
        );
        let catalog = net::fetch_json(&url, Duration::from_secs(20))
            .await
            .map_err(|e| format!("Could not read the library's fonts ({url}): {e}"))?;
        let families: Vec<Font> = catalog
            .get("families")
            .and_then(Value::as_array)
            .map(|families| {
                families
                    .iter()
                    .filter_map(|family| serde_json::from_value(family.clone()).ok())
                    .collect()
            })
            .unwrap_or_default();
        if families.is_empty() {
            return Err("The library's font catalog lists no families.".into());
        }
        let read = Arc::new(families);
        *fonts = Some(Arc::clone(&read));
        Ok(read)
    }
}

pub fn has(font: &Font, script: &str) -> bool {
    // A family the catalog tags with nothing is taken for a Latin one.
    font.scripts.iter().any(|tag| tag == script) || (script == "latin" && font.scripts.is_empty())
}

/// The family is one of the script's own (`familyOfLanguage` in the model): it has the letters,
/// and was made for them or for Latin letters. A Hebrew family's Latin letters are for English
/// words in Hebrew text; a Japanese family's Cyrillic ones are no Russian font.
fn own(font: &Font, script: &str) -> bool {
    let made = font.made();
    has(font, script) && made.iter().any(|tag| tag == script || tag == "latin")
}

/// `Family → counterpart` for each family made for Latin or Hebrew letters that has none of the
/// script's: the family the catalog names as closest to it in character.
fn counterparts(fonts: &[Font], script: &str) -> Vec<String> {
    fonts
        .iter()
        .filter_map(|font| {
            let made = font.made();
            let other = font.counterpart(script)?;
            let latin_or_hebrew = made.iter().any(|tag| tag == "latin" || tag == "he");
            (!other.is_empty() && !has(font, script) && latin_or_hebrew)
                .then(|| format!("{} → {other}", font.family))
        })
        .collect()
}

/// The library's families of each of a request's languages (made for its letters, or for Latin
/// ones and having its letters), the counterpart in each language of the families the English
/// file may use, and how a file is set whose letters no family has (an older catalog's).
pub fn fonts_text(fonts: &[Font], langs: &[String]) -> String {
    let mut scripts: Vec<(&str, Vec<String>)> = Vec::new();
    for lang in langs {
        let script = languages::script(lang);
        match scripts.iter_mut().find(|(known, _)| *known == script) {
            Some((_, of)) => of.push(lang.clone()),
            None => scripts.push((script, vec![lang.clone()])),
        }
    }
    let mut lines = Vec::new();
    let mut bare: Vec<String> = Vec::new();
    let mut paired = Vec::new();
    for (script, of) in &scripts {
        let families: Vec<&str> = fonts
            .iter()
            .filter(|font| own(font, script))
            .map(|font| font.family.as_str())
            .collect();
        let listed = if families.is_empty() {
            "none".to_owned()
        } else {
            families.join(", ")
        };
        lines.push(format!(
            "- {} ({}): {listed}",
            script_name(script),
            files(of)
        ));
        if families.is_empty() {
            bare.extend(of.iter().cloned());
        } else if *script != "latin" {
            let pairs = counterparts(fonts, script);
            if !pairs.is_empty() {
                paired.push(format!("- In {}: {}", files(of), pairs.join(", ")));
            }
        }
    }
    let mut text = format!(
        "## Fonts\n\nThese are the fonts the app has; no other font will be there when a user \
         inserts the design. Name them exactly as written. The families of each language, made \
         for its letters:\n\n{}\n\nSet the text of each file in a family of its language: Hebrew \
         text in a family with Hebrew. A left-to-right file may use a family without Hebrew for \
         display type, paired with a Hebrew one in the Hebrew file.",
        lines.join("\n")
    );
    if !paired.is_empty() {
        text.push_str(&format!(
            "\n\nEach language keeps the design's character. Where the English file sets a text \
             in a family without the letters of another file, that file sets the same text in the \
             family's counterpart, the family of its letters closest to it in character (a serif \
             for a serif, a rounded face for a rounded one), at the same weight where the \
             counterpart has it and else the nearest it has. Never one family for every text of a \
             file because it has the letters. The counterparts:\n\n{}",
            paired.join("\n")
        ));
    }
    if !bare.is_empty() {
        // The generic family last: the browser then draws the letters the family lacks in the same
        // font when it converts the HTML as when the app draws the slide, which ends every run's
        // font list in `sans-serif`. Without it the conversion measures other letters and keeps
        // the text as HTML.
        let systems: Vec<String> = bare
            .iter()
            .filter_map(|lang| {
                system_font(lang).map(|font| format!("{font} for {}", languages::name(lang)))
            })
            .collect();
        let latin: Vec<&Font> = fonts.iter().filter(|font| has(font, "latin")).collect();
        let example = latin
            .iter()
            .find(|font| !font.scripts.iter().any(|tag| tag == "he"))
            .or_else(|| latin.first())
            .map_or("Inter", |font| font.family.as_str());
        let windows = if systems.is_empty() {
            String::new()
        } else {
            format!(" (on Windows, {})", listing(&systems, "and"))
        };
        text.push_str(&format!(
            "\n\nNo family of the library has {} letters. In {}, every element with text names \
             one family of the library, for the Latin letters and the figures, then the generic \
             `sans-serif`, and nothing else: `font-family: '{example}', sans-serif`. Name no \
             system font: it is not in the library, and a deck does not carry it. The app draws \
             the letters the family lacks in the system's sans serif for the language{windows}: \
             choose a family whose Latin sits well beside it.",
            names(&bare, "or"),
            files(&bare)
        ));
    }
    text
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_apps_instructions_are_read() {
        assert!(app().design.starts_with("## Design guidelines"));
        assert!(app().html.starts_with("## Writing a slide as HTML"));
        assert!(app().templates.pointer("/en/name").is_some());
        assert!(!quality_bar().starts_with("# "));
        assert!(quality_bar().contains("publication ready"));
    }
}
