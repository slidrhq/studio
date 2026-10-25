//! What Claude is told when it makes a design for the Elements gallery.
//!
//! The system prompt is assembled from the app's own instructions (`instructions.rs`): the quality
//! bar of AGENTS.md, the design guidelines and HTML conventions of `packages/prompts`, and the
//! fonts of the library. What is said here is only what a design of the gallery adds to them: the
//! contract the app's catalog and its tests hold a design to (`desktop/src/elements/
//! designs.test.ts`), and how the studio's files and turns work.
//!
//! Every prompt names the languages of its request (`languages.rs`): one HTML file per language,
//! Hebrew and English always, and only the other languages the person chose for that request.

use serde_json::{Value, json};

use crate::{
    instructions::{AppInstructions, Font, fonts_text},
    languages::{BASE_LANGUAGES, direction, file_of, files, listing, name, names},
    library::Group,
    store::{DesignBrief, to_json_indented},
};

const ROLE: &str = "# Slidr Studio: designs for the Elements gallery

You are the art director of Slidr's Elements gallery. Slidr is a desktop presentation editor. Elements → Designs offers ready-made slides (invitations, announcements, marketing slides, event and course slides, video thumbnails, greetings and more) that a user inserts into a deck with one click, then edits: the words, the picture, the colours. What you make here is published to every user of the app, in {languages}, so it must be finished work: art directed, publication ready, and distinct from the other designs.

The person running the studio describes what they need. You plan concepts, then design each one as HTML, which the app converts into an editable slide with its own engine. The app renders the result, runs its own design check on it, and shows it to you before anyone else sees it.";

const QUALITY_HEADER: &str = "## The quality bar\n\nThe repository's instruction for ready-made designs, and the standard your work is judged by:";

const PRECEDENCE: &str = "The guidelines below were written for the slides of a deck. A design of the gallery is not part of a deck with a theme: where the contract that follows them says otherwise (theme variables, fonts, icons), the contract wins.";

const CONTRACT: &str = r#"## The contract of a design in the gallery

{files_rule}
- **The canvas.** One root `<div>` of exactly 1920×1080 px that carries `dir` and `lang` and the slide's background. Sizes in px. A `<style>` block is fine.
- **One picture.** `subject.png`, made for this design, is placed with `<img data-asset="__subject__" alt="…" style="object-fit: cover; …">`: the attribute, never a `src`. It may appear in more than one frame (the faces of one sheet). No other raster image may appear: decorative graphics are inline `<svg>` or CSS (gradients, shapes, borders, patterns), and there are no data: URLs. Keep the picture's `<img>` a direct child of the root, not inside a card, a group or a link, and let nothing lie over the middle of its subject: the user clicks the subject to select the picture and replace it with their own. Never flip, rotate or otherwise transform the picture (no `transform`, no `filter`): the frame is mirrored between the directions, the picture is not. Place and crop it with its frame and `object-position`.
- **Fonts.** Every element with text sets its own `font-family` by name, from the list below; never `var(--font-heading)` or `var(--font-body)`. Two families at most in each file.
- **Colours.** Literal colours (`#0f2a3d`, `rgba(…)`); no theme variables. The design keeps its look in any deck.
- **Copy.** Real, specific, original words that fit the purpose, in at least three blocks of text: a title, a line under it, and details (a time, a place, a call to action, a price…). No lorem ipsum, no "placeholder", "add your text", "sample text" or the like, in any language. No year, and no date that will go stale: a day and a month, or a weekday and an hour, at most, written as the readers of each language write them. No real people's names, brands, logos or trademarks.
- **Editable.** Text stays text: never inside SVG or the picture. Give every block of text a definite width. Mark the title `data-role="title"` and write no other `data-role`. No scripts, no external URLs, no `data-image-prompt`, no `data-icon` (there is no icon search here: draw an icon as a small inline `<svg>` in the style the HTML conventions describe).
- **Both sizes.** The design is seen full size on a slide, and as a thumbnail 384 px wide in the gallery: the focal point and the title must read at both, in every language.

## The picture

The picture is made by an image model from the brief's `image` (`prompt`, and `aspect`: one of wide, landscape, square, portrait, tall). The model cannot see your HTML. When the picture falls short (its subject, its crop, its mood, a clash with the layout), change `brief.json` in this folder:
- a new `"image": {"prompt": "…", "aspect": "…"}` makes a new picture;
- `"imageEdit": "<instruction>"` changes the picture there is (the model draws it again after it, so ask for a change of content or composition, not a pixel fix).

A prompt says what the picture shows and how: subject, framing and where calm space for text falls ("the subject on the right third, a quiet sky on the left"), light, palette, medium. It never asks for text, letters, numbers, logos or watermarks in the picture. You may also change the brief's `name`, `group`, `groupName` and `tags` (the words its search finds it by, in Hebrew and in English) when the work changes what the design is; the `id` stays."#;

const WORKFLOW: &str = "## This folder

You work in a folder of your own, and your file tools reach only it: `brief.json` (the concept), `subject.png` (the picture), {files} (yours to write: one for each language of this request, and no other), and `renders/` (the app's renders of your files, a folder for each revision, and nothing else). You have no shell. Write complete files; there is nothing to install or run.";

/// Languages whose lines run longer than English.
pub const LONGER: [&str; 8] = ["de", "es", "fr", "it", "pt-BR", "ru", "tr", "id"];
/// Languages whose letters reach higher and lower than Latin ones, and must not be spaced apart.
pub const TALLER: [&str; 2] = ["ar", "hi"];
/// Languages a browser may break between almost any two characters.
pub const ANY_BREAK: [&str; 3] = ["ja", "ko", "zh-CN"];

fn count_word(count: usize) -> String {
    match count {
        4 => "four".into(),
        6 => "six".into(),
        8 => "eight".into(),
        10 => "ten".into(),
        12 => "twelve".into(),
        other => other.to_string(),
    }
}

/// A value in a prompt, as the studio has always written it: text as it is, nothing as `None`,
/// anything else as JSON.
pub fn show(value: Option<&Value>) -> String {
    match value {
        None | Some(Value::Null) => "None".into(),
        Some(Value::String(text)) => text.clone(),
        Some(Value::Bool(true)) => "True".into(),
        Some(Value::Bool(false)) => "False".into(),
        Some(other) => other.to_string(),
    }
}

/// The items of a JSON list; none when it is missing or is not one.
pub fn items(value: Option<&Value>) -> &[Value] {
    value.and_then(Value::as_array).map_or(&[], Vec::as_slice)
}

fn only_base(langs: &[String]) -> bool {
    langs.len() == BASE_LANGUAGES.len() && langs.iter().zip(BASE_LANGUAGES).all(|(a, b)| a == b)
}

fn of_direction(langs: &[String], dir: &str) -> Vec<String> {
    langs
        .iter()
        .filter(|lang| direction(lang) == dir)
        .cloned()
        .collect()
}

fn among(langs: &[String], set: &[&str]) -> Vec<String> {
    langs
        .iter()
        .filter(|lang| set.contains(&lang.as_str()))
        .cloned()
        .collect()
}

fn fit_notes(langs: &[String]) -> Vec<String> {
    let mut notes = Vec::new();
    let longer = among(langs, &LONGER);
    if !longer.is_empty() {
        notes.push(format!(
            "{} {} longer than English: give the lines room within the composition (a wider block, \
             or the type a step smaller), and never let a line overflow, crowd its neighbours or \
             break a word.",
            names(&longer, "and"),
            if longer.len() == 1 { "runs" } else { "run" }
        ));
    }
    if langs.iter().any(|lang| lang == "vi") {
        notes.push(
            "Vietnamese stacks marks above and below its letters: give its lines a little more \
             height than English, so that no mark touches the line above or is clipped."
                .into(),
        );
    }
    let taller = among(langs, &TALLER);
    if !taller.is_empty() {
        let breaks = listing(
            taller.iter().map(|lang| {
                if lang == "ar" {
                    "the joined letters of Arabic"
                } else {
                    "the line along the top of Hindi letters"
                }
            }),
            "and",
        );
        notes.push(format!(
            "{} letters reach higher and lower than Latin ones: give their lines more height \
             (about 1.5 for running text, 1.25 for a title) so that no mark is clipped, never set \
             `letter-spacing` on them (it breaks {breaks}), and do not rely on capitals: {} none.",
            names(&taller, "and"),
            if taller.len() == 1 {
                "the script has"
            } else {
                "the scripts have"
            }
        ));
    }
    let breaking = among(langs, &ANY_BREAK);
    if !breaking.is_empty() {
        notes.push(format!(
            "{} may break a line between almost any two characters: break the lines of the title \
             and of other large text yourself with `<br>` at natural phrase boundaries{}, and \
             never leave one or two characters alone on a line. There are no capitals and no \
             italics: give emphasis with weight, size or colour.",
            names(&breaking, "and"),
            if breaking.iter().any(|lang| lang == "ko") {
                " (between words in Korean)"
            } else {
                ""
            }
        ));
    }
    notes
}

/// The first rule of the contract: which files to write, and how they mirror each other.
pub fn files_rule(langs: &[String]) -> String {
    if only_base(langs) {
        return "- **Two files, one design.** This request is made in Hebrew and English only: \
                write `he.html` and `en.html`, and no file in any other language (a deck in another \
                language gets the English design). `he.html` is the Hebrew design \
                (`dir=\"rtl\" lang=\"he\"`), with copy written for Hebrew readers, not translated \
                word by word. `en.html` is the English one (`dir=\"ltr\" lang=\"en\"`). Each is the \
                mirror of the other: what stands on the right in Hebrew stands on the left in \
                English. Mirror the picture's frame exactly (its `left` in one file is \
                `1920 - left - width` in the other), so that the same point of the picture lies on \
                its subject in both."
            .into();
    }
    let roots: Vec<String> = langs
        .iter()
        .map(|lang| {
            format!(
                "  - `{}`: {}, `dir=\"{}\" lang=\"{lang}\"`",
                file_of(lang),
                name(lang),
                direction(lang)
            )
        })
        .collect();
    let extra: Vec<String> = langs
        .iter()
        .filter(|lang| !BASE_LANGUAGES.contains(&lang.as_str()))
        .cloned()
        .collect();
    let notes: Vec<String> = fit_notes(langs)
        .into_iter()
        .map(|note| format!("  - {note}"))
        .collect();
    let mut rule = format!(
        "- **One file per language, one design.** This request is made in {}, and in no other \
         language: write exactly {}, each with its language and direction on the root:\n{}\n  \
         Hebrew and English are always made (a deck in a language the design was not written in \
         gets the English one); {} {} what the person asked for. Each file's copy is written \
         natively for its own readers, not translated word by word from another file.\n- **One \
         composition, mirrored.** The English file sets it. Every left-to-right file ({}) keeps \
         it: the same layout, places and sizes, and the picture's frame exactly where it is in \
         `en.html`. Every right-to-left file ({}) is its mirror: what stands on the left in English \
         stands on the right, and the picture's frame is mirrored exactly (its `left` is `1920 - \
         left - width` of the English one). So the same point of the picture lies on its subject \
         in every file. A language changes only what its text needs to fit, never the places of \
         the picture and the blocks:",
        names(langs, "and"),
        files(langs),
        roots.join("\n"),
        names(&extra, "and"),
        if extra.len() == 1 { "is" } else { "are" },
        files(&of_direction(langs, "ltr")),
        files(&of_direction(langs, "rtl")),
    );
    if !notes.is_empty() {
        rule.push('\n');
        rule.push_str(&notes.join("\n"));
    }
    rule
}

pub fn system_prompt(
    app: &AppInstructions,
    quality: &str,
    fonts: &[Font],
    langs: &[String],
    with_html: bool,
) -> String {
    let mut parts = vec![
        ROLE.replace("{languages}", &names(langs, "and")),
        format!("{QUALITY_HEADER}\n\n{quality}"),
        PRECEDENCE.to_owned(),
        app.design.clone(),
    ];
    if with_html {
        parts.push(app.html.clone());
    }
    parts.push(CONTRACT.replace("{files_rule}", &files_rule(langs)));
    parts.push(fonts_text(fonts, langs));
    if with_html {
        parts.push(WORKFLOW.replace("{files}", &files(langs)));
    }
    parts.join("\n\n")
}

fn texts(langs: &[String]) -> Value {
    let properties: serde_json::Map<String, Value> = langs
        .iter()
        .map(|lang| (lang.clone(), json!({"type": "string"})))
        .collect();
    json!({"type": "object", "required": langs, "properties": properties})
}

fn base() -> Vec<String> {
    BASE_LANGUAGES
        .iter()
        .map(|lang| (*lang).to_owned())
        .collect()
}

/// The search tags of a design, in Hebrew and English (ADR-108 of the app).
pub fn tags_schema() -> Value {
    let words =
        json!({"type": "array", "minItems": 6, "maxItems": 20, "items": {"type": "string"}});
    json!({
        "type": "object",
        "required": BASE_LANGUAGES,
        "properties": {"he": words.clone(), "en": words},
    })
}

/// The plan's shape: the copy in every language of the request; the names and the search tags in
/// Hebrew and English, the two the gallery names and searches its designs in.
pub fn plan_schema(langs: &[String]) -> Value {
    let slug = |max: u32| json!({"type": "string", "pattern": "^[a-z0-9]+(-[a-z0-9]+)*$", "maxLength": max});
    json!({
        "type": "object",
        "required": ["concepts"],
        "properties": {
            "concepts": {
                "type": "array",
                "minItems": 1,
                "items": {
                    "type": "object",
                    "required": [
                        "slug", "name", "group", "groupName", "tags", "concept", "art", "copy", "image"
                    ],
                    "properties": {
                        "slug": slug(40),
                        "name": texts(&base()),
                        "group": slug(30),
                        "groupName": texts(&base()),
                        "tags": tags_schema(),
                        "concept": {"type": "string"},
                        "art": {"type": "string"},
                        "copy": texts(langs),
                        "image": {
                            "type": "object",
                            "required": ["prompt", "aspect"],
                            "properties": {
                                "prompt": {"type": "string"},
                                "aspect": {"enum": ["wide", "landscape", "square", "portrait", "tall"]},
                            },
                        },
                    },
                },
            }
        },
    })
}

pub fn plan_prompt(
    prompt: &str,
    count: u32,
    groups: &[Group],
    taken: &[String],
    group: Option<&str>,
    langs: &[String],
) -> String {
    let group_lines = if groups.is_empty() {
        "- (none yet)".to_owned()
    } else {
        groups
            .iter()
            .map(|g| match (&g.he, &g.en) {
                (Some(he), en) if !he.is_empty() => {
                    format!("- `{}`: {he} / {}", g.id, en.as_deref().unwrap_or("None"))
                }
                _ => format!("- `{}`", g.id),
            })
            .collect::<Vec<_>>()
            .join("\n")
    };
    let wanted = match group {
        Some(group) => format!("File every design under the group `{group}`."),
        None => "File each design under the existing group it belongs to, or name a new group \
                 when none fits."
            .to_owned(),
    };
    let many = if count > 1 {
        format!(
            "Plan {count} designs. Each must be a different concept: a different layout, focal \
             point, typography, palette and picture, never a recolour or a retitle of another. \
             Together they should give the person real alternatives."
        )
    } else {
        "Plan one design.".to_owned()
    };
    let codes = listing(langs.iter().map(|lang| format!("`{lang}`")), "and");
    let names_only = if only_base(langs) {
        ""
    } else {
        "; the gallery names its designs in these two languages only"
    };
    let fonts_for = if only_base(langs) {
        ""
    } else {
        " (for the letters of each of the design's languages)"
    };
    let taken = if taken.is_empty() {
        "none".to_owned()
    } else {
        taken.join(", ")
    };
    format!(
        "<studio_request>
{}
</studio_request>

{many} {wanted}

Each design is made in {}, and in no other language.

The groups of the gallery:
{group_lines}

Ids already taken (your slug becomes the id `m-<slug>`, so do not reuse these): {taken}

For each concept:
- `slug`: a short English id (lowercase words joined by hyphens).
- `name`: what the gallery calls it, in Hebrew and in English (two to four words{names_only}).
- `group`, `groupName`: its group's id and, for a new group, its name in Hebrew and in English (for an existing one, repeat its names, or your best names for it).
- `tags`: the words people type into the gallery's search to find it, 8 to 16 in Hebrew and 8 to 16 in English, the most telling first: what it is for (the kind of slide, the occasion or event, the field, the people it addresses) and their synonyms. Each language written natively, with the spellings people type (יום הולדת, יומולדת); English in lower case, Hebrew without niqqud; one to three words each. Not its style, colours or picture, and not the subject of its sample copy unless the design is made for it (a birthday invitation is for birthdays).
- `concept`: the idea and the focal point, in two or three sentences.
- `art`: the art direction: the layout and where the picture sits, the palette as hex colours, the font families from the list and how they are used{fonts_for}, the purposeful details.
- `copy`: the words of the slide in each language of the design, under its code ({codes}), block by block (title, the line under it, details, call to action). Original and specific; each language written natively for its own readers, not translated word for word from another.
- `image`: the prompt and aspect of the picture, as the section on the picture describes.

Answer with the plan only.",
        prompt.trim(),
        names(langs, "and"),
    )
}

pub fn build_prompt(brief: &DesignBrief, image_size: (u32, u32), langs: &[String]) -> String {
    let (w, h) = image_size;
    let every = if langs.len() == 2 {
        "both files"
    } else {
        "every file"
    };
    format!(
        "<studio_design>
{}
</studio_design>

Design this concept. Its picture was made from the brief's image prompt and is in this folder as `subject.png` ({w}×{h} px).

1. Read `subject.png` and look at it: where its subject is, where calm space for text falls, its light and colours. Compose around the picture you have, not the one you asked for.
2. Write {} in this folder, following the contract: one file for each language of this request, and no other.
3. Reply in one line with what you made.

The app then converts {every} with its engine, renders them at full size and as a thumbnail, runs its design check, and shows you the result to review.",
        to_json_indented(brief),
        files(langs),
    )
}

pub fn findings_text(result: &Value, langs: &[String]) -> String {
    let sides = result.get("langs");
    let side = |lang: &str| sides.and_then(|sides| sides.get(lang));
    let every = if langs.len() == 2 { "both" } else { "all" };
    let mut lines = Vec::new();
    for issue in items(result.get("issues")) {
        lines.push(format!("- {every} · contract: {}", show(Some(issue))));
    }
    for lang in langs {
        let side = side(lang);
        if let Some(error) = side.and_then(|s| s.get("error")).filter(|e| truthy(e)) {
            lines.push(format!(
                "- {lang} · conversion failed: {}",
                show(Some(error))
            ));
        }
        for issue in items(side.and_then(|s| s.get("issues"))) {
            lines.push(format!("- {lang} · contract: {}", show(Some(issue))));
        }
        for finding in items(side.and_then(|s| s.get("findings"))) {
            lines.push(format!(
                "- {lang} · {} · {}: {}",
                show(finding.get("severity")),
                show(finding.get("rule")),
                show(finding.get("message"))
            ));
        }
    }
    let mut conversion = Vec::new();
    for lang in langs {
        let Some(share) = side(lang)
            .and_then(|s| s.get("editability"))
            .and_then(Value::as_f64)
        else {
            continue;
        };
        let share = (share * 100.0).round_ties_even();
        let notes: Vec<String> = items(side(lang).and_then(|s| s.get("notes")))
            .iter()
            .map(|note| show(Some(note)))
            .collect();
        let notes = if notes.is_empty() {
            String::new()
        } else {
            format!(" (notes: {})", notes.join("; "))
        };
        conversion.push(format!("{lang} {share}% editable{notes}"));
    }
    let listed = if lines.is_empty() {
        "- none".to_owned()
    } else {
        lines.join("\n")
    };
    let mut text =
        format!("Findings of the app's design check and of the gallery's contract:\n{listed}");
    if !conversion.is_empty() {
        text.push_str(&format!("\n\nConversion: {}", conversion.join("; ")));
    }
    text
}

/// Whether a value counts as given: not null, false, zero or empty.
pub fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(flag) => *flag,
        Value::Number(number) => number.as_f64() != Some(0.0),
        Value::String(text) => !text.is_empty(),
        Value::Array(list) => !list.is_empty(),
        Value::Object(map) => !map.is_empty(),
    }
}

fn pictures(folder: &str, langs: &[String], kind: &str) -> String {
    listing(
        langs
            .iter()
            .map(|lang| format!("`{folder}/{lang}-{kind}.png`")),
        "and",
    )
}

fn keep(langs: &[String]) -> &'static str {
    if langs.len() == 2 {
        "keep them mirrored"
    } else {
        "keep every left-to-right file in the English composition and every right-to-left file its mirror"
    }
}

pub fn review_prompt(
    result: &Value,
    round: u32,
    rounds: u32,
    folder: &str,
    langs: &[String],
) -> String {
    let count = 2 * langs.len();
    let compare = if langs.len() == 2 {
        "the two languages"
    } else {
        "the languages"
    };
    format!(
        "<studio_review round=\"{round}\" of=\"{rounds}\">
The app converted your HTML with its engine and rendered the slides. Look at all {} pictures before you decide anything (Read them):
- {}: the slide at 1920×1080
- {}: the thumbnail the gallery shows, 384 px wide

{}

Hold each render against the quality bar and the checklist that closes the design guidelines, and compare {compare}. Fix every error above, and whatever the pictures show falls short: overflow, awkward wraps, clipping, weak contrast, a poor crop of the picture, uneven alignment, mistakes of direction, a weak focal point, empty or crowded areas. Edit {}, and {}. Change `brief.json` when the picture is what falls short.

When the design is publication ready, change no file and reply READY. Otherwise reply in one line with what you changed.
</studio_review>",
        count_word(count),
        pictures(folder, langs, "full"),
        pictures(folder, langs, "thumb"),
        findings_text(result, langs),
        files(langs),
        keep(langs),
    )
}

pub fn feedback_prompt(feedback: &str, langs: &[String]) -> String {
    let place = if only_base(langs) {
        "both `he.html` and `en.html` (mirrored, the Hebrew still natural Hebrew)".to_owned()
    } else {
        format!(
            "every file of the design, {} (every left-to-right file in the English composition \
             and every right-to-left file its mirror, each language still natural to its \
             readers),",
            files(langs)
        )
    };
    format!(
        "<studio_feedback>
{}
</studio_feedback>

The person reviewing this design asks for the change above. Make it in {place} and keep everything else that works. When it concerns the picture, the name, the group or the tags, change `brief.json` as the contract describes. Reply in one line with what you changed. The app renders the result again and shows it to you.",
        feedback.trim()
    )
}

pub fn fix_prompt(result: &Value, folder: &str, langs: &[String]) -> String {
    let fulls: Vec<String> = langs
        .iter()
        .map(|lang| format!("`{folder}/{lang}-full.png`"))
        .collect();
    format!(
        "<studio_check>
The app rendered your change. {}

Look at {} and the thumbnails in that folder, and fix the errors above in {} without undoing the change that was asked for. When nothing needs fixing, change no file and reply READY.
</studio_check>",
        findings_text(result, langs),
        fulls.join(", "),
        files(langs),
    )
}

#[cfg(test)]
pub mod tests {
    use super::*;
    use crate::languages::CONTENT_LANGUAGES;

    pub fn langs(codes: &[&str]) -> Vec<String> {
        codes.iter().map(|code| (*code).to_owned()).collect()
    }

    pub fn fonts(list: Value) -> Vec<Font> {
        serde_json::from_value(list).expect("fonts")
    }

    fn the_fonts() -> Vec<Font> {
        fonts(json!([
            {"family": "Heebo", "scripts": ["he", "latin"], "for": ["he"],
             "counterparts": {"arabic": "Cairo", "cyrillic": "Inter"}},
            {"family": "Rubik", "scripts": ["he", "latin", "cyrillic", "arabic"], "for": ["he", "latin", "arabic"]},
            {"family": "Inter", "scripts": ["latin", "cyrillic", "vietnamese"], "for": ["latin"],
             "counterparts": {"he": "Heebo", "arabic": "Cairo", "devanagari": "Poppins"}},
            {"family": "Playfair Display", "scripts": ["latin", "cyrillic"], "for": ["latin"],
             "counterparts": {"he": "Frank Ruhl Libre", "arabic": "Amiri", "devanagari": "Poppins"}},
            {"family": "Poppins", "scripts": ["latin", "devanagari"], "for": ["latin", "devanagari"]},
            {"family": "Cairo", "scripts": ["latin", "arabic"], "for": ["arabic"],
             "counterparts": {"he": "Rubik", "cyrillic": "Inter"}},
            {"family": "Noto Sans JP", "scripts": ["latin", "cyrillic", "japanese"], "for": ["japanese"]},
        ]))
    }

    fn app() -> AppInstructions {
        AppInstructions {
            design: "## Design guidelines\nDG".into(),
            html: "## Writing a slide as HTML\nHC".into(),
            templates: Value::Null,
        }
    }

    fn base_langs() -> Vec<String> {
        langs(&BASE_LANGUAGES)
    }

    #[test]
    fn findings_reach_the_review_prompt() {
        let result = json!({
            "publishable": false,
            "issues": ["No point of the picture lies on top."],
            "langs": {
                "he": {"issues": [], "findings": [{"severity": "error", "rule": "L01", "message": "overflow"}],
                       "editability": 1, "notes": []},
                "en": {"issues": ["Only 2 blocks"], "findings": [], "editability": 0.5, "notes": ["kept html"]},
            },
        });
        let text = review_prompt(&result, 1, 2, "renders/r3", &base_langs());
        assert!(text.contains("renders/r3/he-thumb.png"));
        assert!(text.contains("- both · contract: No point"));
        assert!(text.contains("- he · error · L01: overflow"));
        assert!(text.contains("- en · contract: Only 2 blocks"));
        assert!(text.contains("en 50% editable (notes: kept html)"));
        assert!(text.contains("all four pictures") && text.contains("keep them mirrored"));
    }

    #[test]
    fn findings_and_renders_of_every_chosen_language_reach_the_prompts() {
        let chosen = langs(&["he", "en", "ar", "ja"]);
        let result = json!({
            "publishable": false,
            "issues": ["No point of the picture lies on top."],
            "langs": {
                "he": {"issues": [], "findings": [], "editability": 1},
                "en": {"issues": [], "findings": [], "editability": 1},
                "ar": {"issues": [], "findings": [{"severity": "error", "rule": "L02", "message": "clipped"}],
                       "editability": 0.9},
                "ja": {"error": "no slide", "issues": ["No text names a font"], "findings": []},
            },
        });
        let review = review_prompt(&result, 2, 2, "renders/r4", &chosen);
        for lang in &chosen {
            assert!(review.contains(&format!("renders/r4/{lang}-full.png")));
            assert!(review.contains(&format!("renders/r4/{lang}-thumb.png")));
        }
        assert!(!review.contains("de-full.png"));
        assert!(review.contains("all eight pictures"));
        assert!(review.contains("- all · contract: No point"));
        assert!(review.contains("- ar · error · L02: clipped"));
        assert!(review.contains("- ja · conversion failed: no slide"));
        assert!(review.contains("- ja · contract: No text names a font"));
        assert!(review.contains("ar 90% editable"));
        assert!(review.contains("`he.html`, `en.html`, `ar.html` and `ja.html`"));
        assert!(review.contains("every right-to-left file its mirror"));
        let fix = fix_prompt(&result, "renders/r4", &chosen);
        assert!(fix.contains("`renders/r4/ja-full.png`") && fix.contains("`ja.html`"));
        assert!(fix.contains("- ar · error"));
        let feedback = feedback_prompt("Make the title bigger", &chosen);
        assert!(feedback.contains("`ar.html` and `ja.html`"));
        assert!(
            feedback_prompt("x", &base_langs())
                .contains("mirrored, the Hebrew still natural Hebrew")
        );
    }

    #[test]
    fn system_prompt_carries_the_apps_instructions() {
        let fonts = fonts(json!([
            {"family": "Heebo", "scripts": ["he", "latin"]},
            {"family": "Inter", "scripts": ["latin"]}
        ]));
        let text = system_prompt(&app(), "QUALITY", &fonts, &base_langs(), true);
        // A catalog that does not say what a family is made for lists a family's own letters first.
        for part in [
            "QUALITY",
            "DG",
            "HC",
            "data-asset=\"__subject__\"",
            "Hebrew (`he.html`): Heebo",
            "Latin (`en.html`): Inter",
        ] {
            assert!(text.contains(part), "{part}");
        }
        let plan = system_prompt(&app(), "QUALITY", &fonts, &base_langs(), false);
        assert!(!plan.contains("HC") && !plan.contains("## This folder"));
    }

    #[test]
    fn prompts_name_exactly_the_files_of_the_chosen_languages() {
        for chosen in [
            base_langs(),
            langs(&["he", "en", "ar", "pt-BR", "ja", "zh-CN"]),
        ] {
            let system = system_prompt(&app(), "QUALITY", &the_fonts(), &chosen, true);
            let brief = DesignBrief {
                id: "m-x".into(),
                ..DesignBrief::default()
            };
            let build = build_prompt(&brief, (1536, 1024), &chosen);
            for lang in CONTENT_LANGUAGES {
                for text in [&system, &build] {
                    assert_eq!(
                        text.contains(&format!("`{lang}.html`")),
                        chosen.iter().any(|c| c == lang),
                        "{lang}"
                    );
                }
            }
            if chosen == base_langs() {
                assert!(system.contains("This request is made in Hebrew and English only"));
                assert!(system.contains("in Hebrew and English, so it must be finished work"));
            } else {
                assert!(system.contains(
                    "made in Hebrew, English, Arabic, Brazilian Portuguese, Japanese and Simplified Chinese, and in no other language"
                ));
                assert!(system.contains("`ar.html`: Arabic, `dir=\"rtl\" lang=\"ar\"`"));
                assert!(
                    system
                        .contains("`zh-CN.html`: Simplified Chinese, `dir=\"ltr\" lang=\"zh-CN\"`")
                );
                // Left to right in the English composition, right to left its mirror.
                assert!(
                    system.contains(
                        "Every right-to-left file (`he.html` and `ar.html`) is its mirror"
                    )
                );
                assert!(system.contains("Brazilian Portuguese runs longer than English"));
                assert!(system.contains("Japanese and Simplified Chinese may break a line"));
            }
        }
    }

    #[test]
    fn fonts_by_the_letters_of_the_chosen_languages() {
        let chosen = langs(&["he", "en", "ar", "ru", "hi", "ja", "ko"]);
        let text = system_prompt(&app(), "Q", &the_fonts(), &chosen, true);
        // A family of a language is made for its letters, or for Latin ones and has its letters.
        for part in [
            "- Hebrew (`he.html`): Heebo, Rubik",
            "- Latin (`en.html`): Rubik, Inter, Playfair Display, Poppins",
            "- Arabic (`ar.html`): Rubik, Cairo",
            "- Cyrillic (`ru.html`): Rubik, Inter, Playfair Display",
            "- Devanagari (`hi.html`): Poppins",
            "- Japanese (`ja.html`): Noto Sans JP",
            // The families the English file may use, by their counterparts in each language.
            "- In `ar.html`: Heebo → Cairo, Inter → Cairo, Playfair Display → Amiri",
            "- In `he.html`: Inter → Heebo, Playfair Display → Frank Ruhl Libre",
            "- In `hi.html`: Inter → Poppins, Playfair Display → Poppins",
            "Never one family for every text of a file",
            "- Korean (`ko.html`): none",
            "No family of the library has Korean letters. In `ko.html`",
            "Malgun Gothic for Korean",
            // A family of the library, then the generic family the app's runs end in.
            "`font-family: 'Inter', sans-serif`",
            "Name no system font",
        ] {
            assert!(text.contains(part), "{part}");
        }
        assert!(!text.contains("Yu Gothic") && !text.contains("Nirmala UI"));
        // A catalog tagged with Hebrew and Latin only: the others take the system's letters.
        let old = fonts(json!([
            {"family": "Heebo", "scripts": ["he", "latin"]},
            {"family": "Inter", "scripts": ["latin"]}
        ]));
        let text = system_prompt(&app(), "Q", &old, &langs(&["he", "en", "ru", "hi"]), true);
        assert!(text.contains(
            "No family of the library has Russian or Hindi letters. In `ru.html` and `hi.html`"
        ));
        assert!(text.contains("Nirmala UI for Hindi"));
        // The default names no other script.
        let text = system_prompt(&app(), "Q", &the_fonts(), &base_langs(), true);
        assert!(!text.contains("Cyrillic") && !text.contains("No family of the library has"));
    }

    #[test]
    fn plan_prompt_names_the_groups_and_the_count() {
        for count in [1, 3] {
            let groups = [Group {
                id: "invites".into(),
                he: Some("הזמנות".into()),
                en: Some("Invites".into()),
            }];
            let text = plan_prompt(
                "an invitation",
                count,
                &groups,
                &["m-x".into()],
                None,
                &base_langs(),
            );
            assert!(text.contains("an invitation") && text.contains("`invites`: הזמנות / Invites"));
            assert!(text.contains("m-x"));
            assert_eq!(text.contains("Plan one design."), count == 1);
            assert!(
                text.contains(
                    "Each design is made in Hebrew and English, and in no other language."
                )
            );
            assert!(text.contains("under its code (`he` and `en`)"));
        }
    }

    #[test]
    fn plan_asks_for_copy_in_every_chosen_language_and_names_in_two() {
        let chosen = langs(&["he", "en", "de", "ko"]);
        let text = plan_prompt("a sale", 2, &[], &[], None, &chosen);
        assert!(text.contains(
            "Each design is made in Hebrew, English, German and Korean, and in no other language."
        ));
        assert!(text.contains("under its code (`he`, `en`, `de` and `ko`)"));
        let schema = plan_schema(&chosen);
        let item = &schema["properties"]["concepts"]["items"]["properties"];
        assert_eq!(item["copy"]["required"], json!(chosen));
        assert_eq!(
            item["copy"]["properties"].as_object().map(|o| o.len()),
            Some(4)
        );
        assert_eq!(item["name"]["required"], json!(["he", "en"]));
        assert_eq!(item["groupName"]["required"], json!(["he", "en"]));
        assert_eq!(
            plan_schema(&base_langs())["properties"]["concepts"]["items"]["properties"]["copy"]["required"],
            json!(["he", "en"])
        );
    }

    #[test]
    fn plan_asks_for_the_search_tags_in_hebrew_and_english() {
        let schema = plan_schema(&langs(&["he", "en", "de"]));
        let concept = &schema["properties"]["concepts"]["items"];
        assert!(
            concept["required"]
                .as_array()
                .is_some_and(|r| r.contains(&json!("tags")))
        );
        assert_eq!(
            concept["properties"]["tags"]["required"],
            json!(["he", "en"])
        );
        assert!(
            plan_prompt("a party", 1, &[], &[], None, &base_langs())
                .contains("`tags`: the words people type into the gallery's search")
        );
    }
}
