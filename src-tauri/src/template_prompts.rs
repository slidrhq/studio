//! What Claude is told when it writes the sample deck of a built-in template in a language, and
//! when it reads a request in words to tell which kind of work it is.
//!
//! The quality bar is the repository's (AGENTS.md, through `instructions.rs`); the families the
//! library has for each script come from its font catalog. What is said here is the sample's format
//! (the catalog's `SampleSlide[]`, `packages/templates/src/builtin/kit.ts`), what a sample must keep
//! from the English one, and how the studio's files and turns work.

use std::collections::BTreeSet;

use serde_json::{Value, json};

use crate::{
    instructions::{Font, has, script_name, system_font},
    languages::{CONTENT_LANGUAGES, direction, name, script},
    prompts::{ANY_BREAK, LONGER, TALLER, items, show, truthy},
    store::{TemplateBrief, to_json_indented},
    templates::{TemplateInfo, sample_file},
};

const ROLE: &str = "# Slidr Studio: the sample decks of the built-in templates

Slidr is a desktop presentation editor. Its template library shows every built-in template with a sample deck: a slide on each of the template's layouts, with real, specific copy (an organisation, a programme, figures, a timeline, a team) that shows what the template is for. A deck in a language a template's sample is written in gets that sample; a deck in any other language gets the English one, drawn left to right. A user starts from these slides and replaces the words with their own.

You write the sample of one template in one language: {language}. What you write is published to every user of the app who works in {language}, so it must read as if it had been written for them: natural, specific and finished, and it must fit the template's boxes as the English sample does. The app builds your sample with its own engine, renders every slide, runs its design check, and shows you the result before anyone else sees it.";

const QUALITY_HEADER: &str = "## The quality bar\n\nThe repository's instruction for ready-made content, and the standard your work is judged by. It is written for designs; for a sample deck, what it asks is copy that is original and meaningful, no placeholder text or stale dates, and a render you have looked at, slide by slide, at full size and as a thumbnail, with every overflow, awkward wrap, clipping and direction mistake fixed:";

const FORMAT: &str = r#"## The sample's format

`en.json` is the English sample, as the library's catalog holds it: a list of slides, each

```json
{"layout": "l_…", "name": "the slide's name", "content": {"<role>": <fill> | [<fill>, …]}, "chart": {…}, "table": {…}}
```

A fill is a picture, `{"assetId": "…"}`, or text: `{"paragraphs": [{"dir": "auto", "align": "start", "runs": [{"text": "…", "marks": {"weight": 700}}], …}]}`. A role that a layout has more than once (three cards' titles, four stations of a timeline) takes a list, filled in the order `template.md` lists its boxes. `chart` holds the data of the slide's chart (`chartType`, `data` with its series names and category labels, and a `title`); `table` the rows of its table, header first, with the widths of its columns (`cols`) and the height of a row.

Write `{file}` in exactly this format, as JSON, and as a translation of the English sample's structure:

- **Keep** the slides, their order and their layouts; every role and the number of fills under it; every picture (`assetId`) as it is; the paragraphs of each fill (lists, `spaceAfter`, `align`, a paragraph's `styleRef`), and the marks of each run (a run in bold stays in bold, a colour stays). Keep `"dir": "auto"`: the app sets each paragraph's direction from its letters and the deck's.
- **Write** every run's `text`, each slide's `name`, the chart's title and the names and labels in its data, and the table's cells, in {language}. Figures stay figures: write them as {language} readers do (separators, decimal mark, currency, units, times and dates). A run may be split or joined where {language} puts the bold words elsewhere in the sentence.
- **Room.** Each text must fit its box as the English does; `template.md` gives every box's size, style and how many lines it holds. Type cannot be made smaller in a sample: where {language} runs longer, say it in fewer words. A title that took one line in English takes one line here unless its box holds two.
- **The text slide** (the slide on the layout of archetype `text`) is one page of text, its body from margin to margin: a lead of two lines, then four numbered points of one line each, each opening with a few words in bold. Keep that shape in {language}: two lines of lead, the second more than a few words long, and every point on one line. Where a line of {language} would break inside a word or a phrase, give the lead as two paragraphs, one a line, with the lead's `spaceAfter` on the second.
{script_notes}"#;

const COPY: &str = "## The copy

The English and Hebrew samples were each written for their own readers. Write {language} the same way: as a native writer of {language} would write the deck for this purpose, not a word-for-word translation. Keep what the sample is about (its organisation, its programme, its figures, its story), so the template shows the same thing in every language; adapt what readers of {language} would find foreign: the form of dates and times, the names of people (keep them fictional and natural to {language} readers), a turn of phrase. No real people, brands or trademarks. No year, and no date that will go stale: where the English names a year (\"12 to 14 January 2027\"), leave the year out and keep the day and the month, or a weekday and an hour.";

const WORKFLOW: &str = "## This folder

You work in a folder of your own, and your file tools reach only it: `brief.json` (the task: the template, its names, the language, and what the person asked), `template.md` (the theme, its fonts and text styles, and every layout's boxes), `en.json` and `he.json` (the English and Hebrew samples; English sets the structure), `{file}` (yours to write, and the only file you write), and `renders/` (the app's renders of your file, a folder for each revision). You have no shell. Write the complete file; there is nothing to install or run.";

/// The theme's families: the heading's and the body's, Latin then Hebrew, each once.
fn template_families(template: &Value) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for role in ["heading", "body"] {
        for key in ["latin", "he"] {
            if let Some(name) = template
                .pointer(&format!("/theme/fonts/{role}/{key}"))
                .and_then(Value::as_str)
                && !out.iter().any(|known| known == name)
            {
                out.push(name.to_owned());
            }
        }
    }
    out
}

/// How the letters of `lang` are drawn in the template: by the theme's families when they have
/// them, else by their counterparts in the library (the app adds a family's counterpart to the
/// theme's stack, ADR-105), and only in a catalog without counterparts by the system's font.
pub fn fonts_note(template: &Value, fonts: &[Font], lang: &str) -> String {
    let script = script(lang);
    if script == "latin" || script == "he" {
        return String::new();
    }
    let by_name = |name: &str| fonts.iter().find(|font| font.family == name);
    let mut bare = Vec::new();
    let mut stand_in = Vec::new();
    for role in ["heading", "body"] {
        let pair: Vec<&str> = ["latin", "he"]
            .iter()
            .filter_map(|key| {
                template
                    .pointer(&format!("/theme/fonts/{role}/{key}"))
                    .and_then(Value::as_str)
            })
            .collect();
        // The renderer's stack: the Hebrew-only face, the Latin family, then the Hebrew family.
        let drawn = pair
            .iter()
            .any(|name| by_name(name).is_some_and(|font| has(font, script)));
        if !drawn {
            bare.push(role);
            // Then the counterpart of the Latin family in the letters, else the Hebrew family's.
            let other = pair
                .iter()
                .find_map(|name| by_name(name).and_then(|font| font.counterpart(script)))
                .filter(|other| !other.is_empty());
            if let Some(other) = other {
                stand_in.push(format!("the {role} in {other}"));
            }
        }
    }
    let language = name(lang);
    let letters = script_name(script);
    if bare.is_empty() {
        return format!(
            "- **Fonts.** The template's families draw the {letters} letters of {language}: name no font."
        );
    }
    let lacks = if bare.len() > 1 {
        "families lack"
    } else {
        "family lacks"
    };
    if stand_in.len() == bare.len() {
        let whole = script == "cyrillic" || script == "vietnamese";
        return format!(
            "- **Fonts.** The template's {} {lacks} {letters} letters, and the app draws {} in the \
             family of the library closest to it that has them: {}. Name no font: a named font \
             stays with the text when a deck moves to another template. Look at the renders for \
             lines that run longer in that family.",
            bare.join(" and "),
            if whole {
                "the whole text"
            } else {
                "those letters"
            },
            stand_in.join(" and ")
        );
    }
    let library: Vec<&str> = fonts
        .iter()
        .filter(|font| has(font, script))
        .map(|font| font.family.as_str())
        .collect();
    let roles = bare.join(" and ");
    let system = system_font(lang)
        .map(|font| format!(" (on Windows, {font})"))
        .unwrap_or_default();
    if library.is_empty() {
        return format!(
            "- **Fonts.** No family of the library has {language} letters: the system's \
             font{system} draws them, as in every template. Name no font."
        );
    }
    let theirs = template_families(template);
    let ours: Vec<&str> = library
        .iter()
        .copied()
        .filter(|name| theirs.iter().any(|family| family == name))
        .collect();
    let choice = if ours.is_empty() { library[0] } else { ours[0] };
    format!(
        "- **Fonts.** The template's {roles} {lacks} {letters} letters, so the system's \
         font{system} draws that text. The library has them in {}. You may name one of them on \
         the runs of that text (`\"marks\": {{\"font\": \"{choice}\"}}`), {}, when the system's \
         font would look out of place beside the rest; a named font stays with the text when a \
         deck moves to another template, so leave the others alone.",
        library.join(", "),
        if ours.is_empty() {
            "the one closest to the template"
        } else {
            "a family the template already uses"
        }
    )
}

pub fn script_notes(template: &Value, fonts: &[Font], lang: &str) -> String {
    let language = name(lang);
    let mut notes = Vec::new();
    if LONGER.contains(&lang) {
        notes.push(format!(
            "- **Longer lines.** {language} runs longer than English: choose the shorter of two \
             good wordings, and look at every box that the English fills to the edge."
        ));
    }
    if lang == "vi" {
        notes.push(
            "- **Marks.** Vietnamese stacks marks above and below its letters: make sure the \
             renders show no mark touching the line above or clipped."
                .to_owned(),
        );
    }
    if TALLER.contains(&lang) {
        notes.push(format!(
            "- **Tall letters.** {language} letters reach higher and lower than Latin ones. Where \
             a title's lines meet or a mark is clipped, give its paragraphs a `lineHeight` (about \
             1.18 for display titles and 1.3 for other titles, as the Atlas template does for \
             Hindi); never set `letterSpacing` on them, and do not rely on capitals."
        ));
    }
    if ANY_BREAK.contains(&lang) {
        notes.push(format!(
            "- **Line breaks.** {language} may break a line between almost any two characters. \
             Where a title or a large text breaks badly, split it into paragraphs at a natural \
             phrase boundary{}, and never leave one or two characters alone on a line. There are \
             no capitals and no italics.",
            if lang == "ko" {
                " (between words in Korean)"
            } else {
                ""
            }
        ));
    }
    if direction(lang) == "rtl" {
        notes.push(format!(
            "- **Direction.** {language} is written right to left: the deck is right to left and \
             every layout is mirrored. Latin words and figures inside a sentence stay in it."
        ));
    }
    let fonts_line = fonts_note(template, fonts, lang);
    if !fonts_line.is_empty() {
        notes.push(fonts_line);
    }
    notes.join("\n")
}

pub fn system_prompt(template: &Value, quality: &str, fonts: &[Font], lang: &str) -> String {
    let language = name(lang);
    let file = sample_file(lang);
    [
        ROLE.replace("{language}", language),
        format!("{QUALITY_HEADER}\n\n{quality}"),
        FORMAT
            .replace("{script_notes}", &script_notes(template, fonts, lang))
            .replace("{language}", language)
            .replace("{file}", &file),
        COPY.replace("{language}", language),
        WORKFLOW.replace("{file}", &file),
    ]
    .join("\n\n")
}

pub fn build_prompt(brief: &TemplateBrief) -> String {
    let lang = &brief.lang;
    let file = sample_file(lang);
    let asked = brief.instructions.trim();
    let task = if brief.rewrite {
        format!(
            "`{file}` holds the template's {} sample as it is published. Rewrite it as the person \
             asks, keeping the format, and write the whole file again.",
            name(lang)
        )
    } else {
        format!("Write `{file}`: the template's sample in {}.", name(lang))
    };
    let request = if asked.is_empty() {
        String::new()
    } else {
        format!("\n<studio_request>\n{asked}\n</studio_request>\n")
    };
    format!(
        "<studio_template>
{}
</studio_template>
{request}
{task}

1. Read `template.md`, `en.json` and `he.json`.
2. Write `{file}`, complete, following the format.
3. Reply in one line with what you wrote.

The app then builds the sample with its engine, renders every slide at full size and as a thumbnail, runs its design check, and shows you the result to review.",
        to_json_indented(brief)
    )
}

fn slides_line(result: &Value, folder: &str) -> String {
    let count = items(result.get("slides")).len();
    if count == 0 {
        return String::new();
    }
    format!(
        "- `{folder}/sheet.png`: every slide at the size the template library shows it\n\
         - `{folder}/s01-full.png` … `{folder}/s{count:02}-full.png`: each slide at 1920×1080\n\
         - `{folder}/s01-thumb.png` … `{folder}/s{count:02}-thumb.png`: each slide 384 px wide"
    )
}

/// The findings of a template render, slide by slide.
pub fn slide_findings(result: &Value) -> String {
    let lang = result.get("lang").and_then(Value::as_str).unwrap_or("");
    let mut lines = Vec::new();
    for issue in items(result.get("issues")) {
        lines.push(format!("- the sample · contract: {}", show(Some(issue))));
    }
    for slide in items(result.get("slides")) {
        let index = slide.get("index").and_then(Value::as_i64).unwrap_or(0);
        let text = |key: &str| slide.get(key).and_then(Value::as_str).unwrap_or("");
        let place = format!(
            "s{:02} \"{}\" ({})",
            index + 1,
            text("name"),
            text("layout")
        );
        if let Some(error) = slide.get("error").filter(|e| truthy(e)) {
            lines.push(format!(
                "- {place} · could not be built: {}",
                show(Some(error))
            ));
        }
        for issue in items(slide.get("issues")) {
            lines.push(format!("- {place} · contract: {}", show(Some(issue))));
        }
        let findings = items(slide.get("findings"));
        let baseline = |finding: &Value| finding.get("baseline").is_some_and(truthy);
        for finding in findings.iter().filter(|f| !baseline(f)) {
            lines.push(format!(
                "- {place} · {} · {}: {}",
                show(finding.get("severity")),
                show(finding.get("rule")),
                show(finding.get("message"))
            ));
        }
        let inherited: BTreeSet<String> = findings
            .iter()
            .filter(|f| baseline(f))
            .map(|f| show(f.get("rule")))
            .collect();
        if !inherited.is_empty() {
            // The slide it was written from has these on the same elements: the template's.
            lines.push(format!(
                "- {place} · also on the slide it was written from, so not this language's to fix: {}",
                inherited.into_iter().collect::<Vec<_>>().join(", ")
            ));
        }
    }
    if let Some(error) = result
        .pointer(&format!("/langs/{lang}/error"))
        .filter(|e| truthy(e))
    {
        lines.push(format!("- the sample · {}", show(Some(error))));
    }
    let listed = if lines.is_empty() {
        "- none".to_owned()
    } else {
        lines.join("\n")
    };
    format!("Findings of the app's design check and of the sample's contract:\n{listed}")
}

pub fn review_prompt(result: &Value, round: u32, rounds: u32, folder: &str, lang: &str) -> String {
    let file = sample_file(lang);
    let first = if round == 1 {
        "Look at the sheet and at every slide at full size before you decide anything (Read them)."
    } else {
        "Look at the sheet, and at full size at every slide you changed or that has a finding (Read them)."
    };
    format!(
        "<studio_review round=\"{round}\" of=\"{rounds}\">
The app built your sample with its engine and rendered it. {first}
{}

{}

Hold each slide against the English sample and the quality bar. Fix every error above, and whatever the pictures show falls short: text that overflows its box or runs into the next, an awkward break, a word alone on a line, a clipped mark, wrong direction, a figure or date written the English way, a sentence that reads as a translation. Edit `{file}`.

When the sample is ready to publish, change no file and reply READY. Otherwise reply in one line with what you changed.
</studio_review>",
        slides_line(result, folder),
        slide_findings(result),
    )
}

pub fn fix_prompt(result: &Value, folder: &str, lang: &str) -> String {
    format!(
        "<studio_check>
The app rendered your change.
{}

{}

Look at the slides with findings, and fix the errors above in `{}` without undoing the change that was asked for. When nothing needs fixing, change no file and reply READY.
</studio_check>",
        slides_line(result, folder),
        slide_findings(result),
        sample_file(lang),
    )
}

pub fn feedback_prompt(feedback: &str, lang: &str) -> String {
    format!(
        "<studio_feedback>
{}
</studio_feedback>

The person reviewing this sample asks for the change above. Make it in `{}` and keep everything else that works. Reply in one line with what you changed. The app renders the result again and shows it to you.",
        feedback.trim(),
        sample_file(lang),
    )
}

/* ---------------------------------------------------------------------- reading a request */

pub const ROUTE_SYSTEM: &str = "# Slidr Studio: what a request asks for

Slidr is a desktop presentation editor, and the studio makes the ready-made content of its media library. A person writes a request in words, often in Hebrew. You read it and say which kind of work it is, so the studio can start it. You answer with the structured result only.

The kinds the studio makes:

- `design`: ready-made slides for Elements → Designs (an invitation, an announcement, a marketing slide, a slide for an event or a course, a video thumbnail, a greeting…), each from a concept, a picture and HTML. A request that describes a slide or a design to make is a design.
- `template`: the sample deck of one of the built-in templates, written in languages. Translating a template (\"translate Mifgash into German\", \"translate the Mifgash template into every language it lacks\") is this kind; so is rewriting the sample of a template in a language it has (\"make the Hebrew sample of Atlas about a travel agency\"). The template's layouts, colours and pictures stay as they are.
- `unsupported`: anything else: a new template from nothing, a template's layouts or colours, card sets, event frames, shapes, graphics, icons, emoji, fonts. Say why in `reason`, in the request's language, and what the studio can do instead.";

pub fn route_schema() -> Value {
    json!({
        "type": "object",
        "required": ["kind", "reason"],
        "properties": {
            "kind": {"enum": ["design", "template", "unsupported"]},
            "reason": {"type": "string"},
            "templateId": {"type": "string"},
            "languages": {"type": "array", "items": {"enum": CONTENT_LANGUAGES}},
            "instructions": {"type": "string"},
            "title": {"type": "string", "maxLength": 60},
        },
    })
}

pub fn route_prompt(prompt: &str, templates: &[TemplateInfo]) -> String {
    let rows: Vec<String> = templates
        .iter()
        .map(|t| {
            let missing = if t.missing.is_empty() {
                "none".to_owned()
            } else {
                t.missing.join(", ")
            };
            format!(
                "- `{}`: {} / {}, {}. Its sample is written in: {}. Not yet in: {missing}.",
                t.id,
                t.name.he,
                t.name.en,
                t.tagline.en,
                t.languages.join(", ")
            )
        })
        .collect();
    let langs: Vec<String> = CONTENT_LANGUAGES
        .iter()
        .map(|code| format!("`{code}` {}", name(code)))
        .collect();
    format!(
        "<studio_request>
{}
</studio_request>

The built-in templates:
{}

The content languages of the app: {}.

Answer with:
- `kind`, and `reason`: one sentence on what you understood, in the request's language.
- For a template: `templateId`; `languages`, the languages to write its sample in (for \"every language it lacks\", exactly the languages its sample is not yet written in; a rewrite names a language it has); `instructions`, what the person asks beyond the translation, in their words, or an empty string; and `title`, a short name for the request in English (the template's English name and what is done, such as \"Mifgash · 14 languages\").
- For a design, nothing more.",
        prompt.trim(),
        rows.join("\n"),
        langs.join(", "),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        prompts::tests::fonts,
        store::Named,
        templates::tests::{listing_entry, template},
    };

    fn the_fonts() -> Vec<Font> {
        fonts(json!([
            {"family": "Rubik", "scripts": ["he", "latin", "arabic", "cyrillic"]},
            {"family": "Heebo", "scripts": ["he", "latin"]},
            {"family": "Montserrat", "scripts": ["latin", "cyrillic", "vietnamese"]},
            {"family": "Poppins", "scripts": ["latin", "devanagari"]},
        ]))
    }

    #[test]
    fn the_route_prompt_gives_each_template_its_names_and_missing_languages() {
        let text = route_prompt("תרגם את תבנית מפגש לכל השפות שחסרות", &[listing_entry()]);
        assert!(text.contains("`mifgash`: מפגש / Mifgash") && text.contains("Not yet in: ar, de."));
        assert!(text.contains("תרגם את תבנית מפגש"));
        let schema = route_schema();
        assert_eq!(
            schema["properties"]["kind"]["enum"],
            json!(["design", "template", "unsupported"])
        );
        assert_eq!(
            schema["properties"]["languages"]["items"]["enum"],
            json!(CONTENT_LANGUAGES)
        );
    }

    #[test]
    fn the_fonts_note_says_which_letters_the_theme_leaves_to_the_system() {
        let template = template();
        // Arabic: Rubik, the heading's Hebrew family, has its letters; the body's families do not.
        let arabic = fonts_note(&template, &the_fonts(), "ar");
        assert!(
            arabic.contains("body family lacks Arabic") && arabic.contains("\"font\": \"Rubik\"")
        );
        assert!(fonts_note(&template, &the_fonts(), "ru").contains("name no font"));
        assert!(fonts_note(&template, &the_fonts(), "hi").contains("Poppins"));
        assert!(
            fonts_note(&template, &the_fonts(), "ja")
                .contains("No family of the library has Japanese")
        );
        assert_eq!(fonts_note(&template, &the_fonts(), "de"), "");
        // A catalog with counterparts: the app draws the letters in them, and no font is named.
        let with_counterparts = fonts(json!([
            {"family": "Rubik", "scripts": ["he", "latin", "arabic", "cyrillic"],
             "counterparts": {"japanese": "Zen Maru Gothic"}},
            {"family": "Heebo", "scripts": ["he", "latin"],
             "counterparts": {"arabic": "IBM Plex Sans Arabic", "japanese": "Noto Sans JP"}},
            {"family": "Montserrat", "scripts": ["latin", "cyrillic", "vietnamese"],
             "counterparts": {"arabic": "Cairo", "japanese": "Noto Sans JP"}},
            {"family": "Poppins", "scripts": ["latin", "devanagari"], "counterparts": {}},
        ]));
        let arabic = fonts_note(&template, &with_counterparts, "ar");
        assert!(arabic.contains("the body in Cairo") && arabic.contains("Name no font"));
        assert!(!arabic.contains("\"font\""));
        let japanese = fonts_note(&template, &with_counterparts, "ja");
        assert!(japanese.contains("the heading in Noto Sans JP and the body in Noto Sans JP"));
        assert!(japanese.contains("draws those letters"));
        let system = system_prompt(&template, "QUALITY", &the_fonts(), "de");
        assert!(system.contains("`de.json`") && system.contains("German runs longer than English"));
        assert!(system.contains("QUALITY"));
    }

    #[test]
    fn a_rewrite_starts_from_the_sample_the_template_has() {
        let brief = TemplateBrief {
            template_id: "mifgash".into(),
            name: Named {
                he: "מפגש".into(),
                en: "Mifgash".into(),
            },
            tagline: json!({}),
            lang: "de".into(),
            language: "German".into(),
            dir: "ltr".into(),
            rewrite: true,
            instructions: String::new(),
        };
        assert!(build_prompt(&brief).contains("Rewrite it as the person asks"));
    }

    #[test]
    fn findings_the_source_slide_has_are_told_apart() {
        let result = json!({
            "lang": "de",
            "issues": [],
            "slides": [{
                "index": 2, "name": "In Zahlen", "layout": "l_big", "issues": [],
                "findings": [
                    {"rule": "L01", "severity": "error", "message": "Text overflows."},
                    {"rule": "L09", "severity": "warning", "message": "Misaligned.", "baseline": true},
                    {"rule": "L13", "severity": "warning", "message": "Too many words.", "baseline": true},
                ],
            }],
            "langs": {"de": {"findings": [], "issues": []}},
        });
        let text = slide_findings(&result);
        assert!(text.contains("- s03 \"In Zahlen\" (l_big) · error · L01: Text overflows."));
        assert!(
            text.contains("not this language's to fix: L09, L13") && !text.contains("Misaligned")
        );
    }
}
