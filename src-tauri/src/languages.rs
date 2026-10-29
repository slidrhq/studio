//! The languages a design is made in: the studio's copy of the app's registry.
//!
//! `packages/model/src/languages.ts` is the registry; the tests hold this copy to it. Every design
//! is written in the two base languages, Hebrew and English. A request may add any of the others,
//! and its designs are then planned, written, rendered, reviewed and published in exactly those. A
//! request without a choice (one made before there was one) is made in Hebrew and English.

/// The content languages of the app, in its order (`CONTENT_LANGUAGES`).
pub const CONTENT_LANGUAGES: [&str; 16] = [
    "he", "en", "ar", "de", "es", "fr", "it", "pt-BR", "ru", "tr", "vi", "id", "hi", "ja", "ko",
    "zh-CN",
];
/// The languages every design is written in (`BASE_LANGUAGES`).
pub const BASE_LANGUAGES: [&str; 2] = ["he", "en"];
/// The languages written right to left (`languageDir`).
const RTL: [&str; 2] = ["he", "ar"];

/// Each language by its English name (`LANGUAGE_NAMES[lang].english`).
const NAMES: [(&str, &str); 16] = [
    ("he", "Hebrew"),
    ("en", "English"),
    ("ar", "Arabic"),
    ("de", "German"),
    ("es", "Spanish"),
    ("fr", "French"),
    ("it", "Italian"),
    ("pt-BR", "Brazilian Portuguese"),
    ("ru", "Russian"),
    ("tr", "Turkish"),
    ("vi", "Vietnamese"),
    ("id", "Indonesian"),
    ("hi", "Hindi"),
    ("ja", "Japanese"),
    ("ko", "Korean"),
    ("zh-CN", "Simplified Chinese"),
];

/// The letters each language is written in, by the tag a family of the library's fonts carries
/// for them in `fonts/catalog.json` (`LANGUAGE_SCRIPT`).
const SCRIPTS: [(&str, &str); 16] = [
    ("he", "he"),
    ("en", "latin"),
    ("ar", "arabic"),
    ("de", "latin"),
    ("es", "latin"),
    ("fr", "latin"),
    ("it", "latin"),
    ("pt-BR", "latin"),
    ("ru", "cyrillic"),
    ("tr", "latin"),
    ("vi", "vietnamese"),
    ("id", "latin"),
    ("hi", "devanagari"),
    ("ja", "japanese"),
    ("ko", "korean"),
    ("zh-CN", "chinese"),
];

/// A language's English name; a code the registry does not know names itself.
pub fn name(lang: &str) -> &str {
    NAMES
        .iter()
        .find(|(code, _)| *code == lang)
        .map_or(lang, |(_, name)| name)
}

/// The script tag of a language's letters.
pub fn script(lang: &str) -> &'static str {
    SCRIPTS
        .iter()
        .find(|(code, _)| *code == lang)
        .map_or("latin", |(_, script)| script)
}

pub fn is_rtl(lang: &str) -> bool {
    RTL.contains(&lang)
}

pub fn direction(lang: &str) -> &'static str {
    if is_rtl(lang) { "rtl" } else { "ltr" }
}

pub fn is_base(lang: &str) -> bool {
    BASE_LANGUAGES.contains(&lang)
}

pub fn is_content(lang: &str) -> bool {
    CONTENT_LANGUAGES.contains(&lang)
}

/// The design's HTML file in a language: `he.html`, `pt-BR.html`.
pub fn file_of(lang: &str) -> String {
    format!("{lang}.html")
}

/// The registry's code for one given in any case.
fn canonical(code: &str) -> Option<&'static str> {
    let code = code.trim();
    CONTENT_LANGUAGES
        .iter()
        .copied()
        .find(|known| known.eq_ignore_ascii_case(code))
}

/// The registry's codes among `found`, Hebrew and English always, in the registry's order.
fn ordered(found: &[&str]) -> Vec<String> {
    CONTENT_LANGUAGES
        .iter()
        .filter(|code| found.contains(code) || is_base(code))
        .map(|code| (*code).to_owned())
        .collect()
}

fn all_codes() -> String {
    CONTENT_LANGUAGES.join(", ")
}

/// The languages of the registry among `codes` (in any case), each once, in the registry's order,
/// and nothing added: the languages a template's sample is to be written in. An unknown code is
/// an error.
pub fn known<S: AsRef<str>>(codes: &[S]) -> Result<Vec<String>, String> {
    let mut found = Vec::new();
    for code in codes {
        let Some(known) = canonical(code.as_ref()) else {
            return Err(format!(
                "Unknown language {}; the languages are {}.",
                code.as_ref(),
                all_codes()
            ));
        };
        found.push(known);
    }
    Ok(CONTENT_LANGUAGES
        .iter()
        .filter(|code| found.contains(code))
        .map(|code| (*code).to_owned())
        .collect())
}

/// The languages of a stored request or variant: the first list among `sources` that has any,
/// read leniently (a code the registry does not know is left out), Hebrew and English always.
/// Nothing stored means Hebrew and English.
pub fn chosen(sources: &[Option<&Vec<String>>]) -> Vec<String> {
    for source in sources.iter().flatten() {
        if !source.is_empty() {
            let found: Vec<&str> = source.iter().filter_map(|code| canonical(code)).collect();
            return ordered(&found);
        }
    }
    base()
}

/// Hebrew and English.
pub fn base() -> Vec<String> {
    BASE_LANGUAGES
        .iter()
        .map(|code| (*code).to_owned())
        .collect()
}

/// `a`, `a and b`, `a, b and c`.
pub fn listing<I, S>(items: I, last: &str) -> String
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    let words: Vec<String> = items.into_iter().map(|s| s.as_ref().to_owned()).collect();
    match words.as_slice() {
        [] => String::new(),
        [one] => one.clone(),
        [rest @ .., end] => format!("{} {last} {end}", rest.join(", ")),
    }
}

/// "Hebrew and English", "Hebrew, English and Arabic".
pub fn names(langs: &[String], last: &str) -> String {
    listing(langs.iter().map(|lang| name(lang)), last)
}

/// "`he.html` and `en.html`".
pub fn files(langs: &[String]) -> String {
    listing(
        langs.iter().map(|lang| format!("`{}`", file_of(lang))),
        "and",
    )
}

#[cfg(test)]
mod tests {
    use std::{collections::HashMap, fs, path::Path};

    use super::*;

    fn strings(codes: &[&str]) -> Vec<String> {
        codes.iter().map(|code| (*code).to_owned()).collect()
    }

    /// The text of a constant of a TypeScript file, from its name to the end of its value.
    fn ts_block<'a>(text: &'a str, start: &str) -> &'a str {
        let at = text.find(start).expect("the constant is in the file");
        let end = ["] as const", "};"]
            .iter()
            .filter_map(|end| text[at..].find(end))
            .min()
            .expect("the constant ends");
        &text[at..at + end]
    }

    /// Every `'…'` of a block, in order.
    fn quoted(block: &str) -> Vec<String> {
        block
            .split('\'')
            .skip(1)
            .step_by(2)
            .map(str::to_owned)
            .collect()
    }

    /// `key: 'value'` and `'key': { … english: 'value' }` pairs of a block, one per line.
    fn pairs(block: &str, marker: &str) -> HashMap<String, String> {
        block
            .lines()
            .filter_map(|line| {
                let line = line.trim();
                let (key, rest) = line.split_once(": ")?;
                let value = rest.split(marker).nth(1)?.split('\'').next()?;
                Some((key.trim_matches('\'').to_owned(), value.to_owned()))
            })
            .collect()
    }

    #[test]
    fn the_language_list_is_the_models() {
        let model = Path::new(env!("CARGO_MANIFEST_DIR")).join("../vendor/packages/model/src");
        let source = fs::read_to_string(model.join("languages.ts")).expect("the model's registry");
        assert_eq!(
            quoted(ts_block(&source, "export const CONTENT_LANGUAGES")),
            strings(&CONTENT_LANGUAGES)
        );
        assert_eq!(
            quoted(ts_block(&source, "export const BASE_LANGUAGES")),
            strings(&BASE_LANGUAGES)
        );
        let names = pairs(
            ts_block(&source, "export const LANGUAGE_NAMES"),
            "english: '",
        );
        assert_eq!(names.len(), 16);
        for (code, english) in NAMES {
            assert_eq!(names[code], english, "{code}");
        }
        let scripts = pairs(ts_block(&source, "export const LANGUAGE_SCRIPT"), "'");
        assert_eq!(scripts.len(), 16);
        for (code, tag) in SCRIPTS {
            assert_eq!(scripts[code], tag, "{code}");
        }
        // The right-to-left ones, as the model's `languageDir` says (`isRtlLanguage`).
        let factories = fs::read_to_string(model.join("factories.ts")).expect("the factories");
        let set = factories
            .split("const RTL = new Set([")
            .nth(1)
            .and_then(|rest| rest.split("])").next())
            .expect("the model's right-to-left set");
        let rtl = quoted(set);
        let ours: Vec<&str> = CONTENT_LANGUAGES
            .iter()
            .copied()
            .filter(|code| {
                let primary = code.split('-').next().unwrap_or(code).to_lowercase();
                rtl.contains(&primary)
            })
            .collect();
        assert_eq!(ours, RTL);
        let directions: Vec<&str> = ["he", "ar", "en", "zh-CN"].map(direction).to_vec();
        assert_eq!(directions, ["rtl", "rtl", "ltr", "ltr"]);
    }

    #[test]
    fn a_stored_request_is_made_in_hebrew_and_english_and_its_languages() {
        // What was stored is read leniently; nothing stored is Hebrew and English.
        assert_eq!(chosen(&[None, None]), base());
        let stored = strings(&["ko", "xx"]);
        assert_eq!(chosen(&[None, Some(&stored)]), strings(&["he", "en", "ko"]));
        let de = strings(&["de"]);
        assert_eq!(
            chosen(&[Some(&de), Some(&stored)]),
            strings(&["he", "en", "de"])
        );
    }

    #[test]
    fn a_template_request_keeps_exactly_its_languages() {
        assert_eq!(known(&["de", "AR", "de"]), Ok(strings(&["ar", "de"])));
        assert_eq!(known(&["ko", "he"]), Ok(strings(&["he", "ko"])));
        assert!(known(&["xx"]).is_err_and(|e| e.contains("Unknown language")));
    }

    #[test]
    fn lists_read_as_sentences() {
        assert_eq!(listing(["a"], "and"), "a");
        assert_eq!(listing(["a", "b", "c"], "or"), "a, b or c");
        assert_eq!(names(&strings(&["he", "en"]), "and"), "Hebrew and English");
        assert_eq!(files(&strings(&["he", "en"])), "`he.html` and `en.html`");
    }
}
