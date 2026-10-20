"""What Claude is told when it writes the sample deck of a built-in template in a language, and
when it reads a request in words to tell which kind of work it is.

The quality bar is the repository's (AGENTS.md, through `instructions.py`); the families the
library has for each script come from its font catalog. What is said here is the sample's format
(the catalog's `SampleSlide[]`, `packages/templates/src/builtin/kit.ts`), what a sample must keep
from the English one, and how the studio's files and turns work.
"""

from __future__ import annotations

import json
from collections.abc import Sequence

from .instructions import SCRIPT_NAMES, SYSTEM_FONTS, _has
from .languages import CONTENT_LANGUAGES, NAMES, SCRIPT, direction
from .prompts import ANY_BREAK, LONGER, TALLER
from .templates import sample_file

ROLE = """# Slidr Studio: the sample decks of the built-in templates

Slidr is a desktop presentation editor. Its template library shows every built-in template with a sample deck: a slide on each of the template's layouts, with real, specific copy (an organisation, a programme, figures, a timeline, a team) that shows what the template is for. A deck in a language a template's sample is written in gets that sample; a deck in any other language gets the English one, drawn left to right. A user starts from these slides and replaces the words with their own.

You write the sample of one template in one language: {language}. What you write is published to every user of the app who works in {language}, so it must read as if it had been written for them: natural, specific and finished, and it must fit the template's boxes as the English sample does. The app builds your sample with its own engine, renders every slide, runs its design check, and shows you the result before anyone else sees it."""

QUALITY_HEADER = "## The quality bar\n\nThe repository's instruction for ready-made content, and the standard your work is judged by. It is written for designs; for a sample deck, what it asks is copy that is original and meaningful, no placeholder text or stale dates, and a render you have looked at, slide by slide, at full size and as a thumbnail, with every overflow, awkward wrap, clipping and direction mistake fixed:"

FORMAT = """## The sample's format

`en.json` is the English sample, as the library's catalog holds it: a list of slides, each

```json
{{"layout": "l_…", "name": "the slide's name", "content": {{"<role>": <fill> | [<fill>, …]}}, "chart": {{…}}, "table": {{…}}}}
```

A fill is a picture, `{{"assetId": "…"}}`, or text: `{{"paragraphs": [{{"dir": "auto", "align": "start", "runs": [{{"text": "…", "marks": {{"weight": 700}}}}], …}}]}}`. A role that a layout has more than once (three cards' titles, four stations of a timeline) takes a list, filled in the order `template.md` lists its boxes. `chart` holds the data of the slide's chart (`chartType`, `data` with its series names and category labels, and a `title`); `table` the rows of its table, header first, with the widths of its columns (`cols`) and the height of a row.

Write `{file}` in exactly this format, as JSON, and as a translation of the English sample's structure:

- **Keep** the slides, their order and their layouts; every role and the number of fills under it; every picture (`assetId`) as it is; the paragraphs of each fill (lists, `spaceAfter`, `align`, a paragraph's `styleRef`), and the marks of each run (a run in bold stays in bold, a colour stays). Keep `"dir": "auto"`: the app sets each paragraph's direction from its letters and the deck's.
- **Write** every run's `text`, each slide's `name`, the chart's title and the names and labels in its data, and the table's cells, in {language}. Figures stay figures: write them as {language} readers do (separators, decimal mark, currency, units, times and dates). A run may be split or joined where {language} puts the bold words elsewhere in the sentence.
- **Room.** Each text must fit its box as the English does; `template.md` gives every box's size, style and how many lines it holds. Type cannot be made smaller in a sample: where {language} runs longer, say it in fewer words. A title that took one line in English takes one line here unless its box holds two.
- **The text slide** (the slide on the layout of archetype `text`) is one page of text, its body from margin to margin: a lead of two lines, then four numbered points of one line each, each opening with a few words in bold. Keep that shape in {language}: two lines of lead, the second more than a few words long, and every point on one line. Where a line of {language} would break inside a word or a phrase, give the lead as two paragraphs, one a line, with the lead's `spaceAfter` on the second.
{script_notes}"""

COPY = """## The copy

The English and Hebrew samples were each written for their own readers. Write {language} the same way: as a native writer of {language} would write the deck for this purpose, not a word-for-word translation. Keep what the sample is about (its organisation, its programme, its figures, its story), so the template shows the same thing in every language; adapt what readers of {language} would find foreign: the form of dates and times, the names of people (keep them fictional and natural to {language} readers), a turn of phrase. No real people, brands or trademarks. No year, and no date that will go stale: where the English names a year ("12 to 14 January 2027"), leave the year out and keep the day and the month, or a weekday and an hour."""

WORKFLOW = """## This folder

You work in a folder of your own, and your file tools reach only it: `brief.json` (the task: the template, its names, the language, and what the person asked), `template.md` (the theme, its fonts and text styles, and every layout's boxes), `en.json` and `he.json` (the English and Hebrew samples; English sets the structure), `{file}` (yours to write, and the only file you write), and `renders/` (the app's renders of your file, a folder for each revision). You have no shell. Write the complete file; there is nothing to install or run."""


def _template_families(template: dict) -> list[str]:
    fonts = (template.get("theme") or {}).get("fonts") or {}
    out: list[str] = []
    for role in ("heading", "body"):
        pair = fonts.get(role) or {}
        for key in ("latin", "he"):
            name = pair.get(key)
            if isinstance(name, str) and name not in out:
                out.append(name)
    return out


def fonts_note(template: dict, fonts: list[dict], lang: str) -> str:
    """How the letters of `lang` are drawn in the template: by the theme's families when they
    have them, else by their counterparts in the library (the app adds a family's counterpart to
    the theme's stack, ADR-105), and only in a catalog without counterparts by the system's font."""
    script = SCRIPT[lang]
    if script in ("latin", "he"):
        return ""
    by_name = {f["family"]: f for f in fonts}
    pairs = (template.get("theme") or {}).get("fonts") or {}
    bare: list[str] = []
    stand_in: list[str] = []
    for role in ("heading", "body"):
        pair = pairs.get(role) or {}
        # The renderer's stack: the Hebrew-only face, the Latin family, then the Hebrew family.
        drawn = [name for name in (pair.get("latin"), pair.get("he")) if name in by_name and _has(by_name[name], script)]
        if not drawn:
            bare.append(role)
            # Then the counterpart of the Latin family in the letters, else the Hebrew family's.
            other = next(
                (
                    by_name[name].get("counterparts", {}).get(script)
                    for name in (pair.get("latin"), pair.get("he"))
                    if name in by_name and by_name[name].get("counterparts", {}).get(script)
                ),
                None,
            )
            if other:
                stand_in.append(f"the {role} in {other}")
    if not bare:
        return (
            f"- **Fonts.** The template's families draw the {SCRIPT_NAMES[script]} letters of "
            f"{NAMES[lang]}: name no font."
        )
    if len(stand_in) == len(bare):
        whole = script in ("cyrillic", "vietnamese")
        return (
            f"- **Fonts.** The template's {' and '.join(bare)} {'families lack' if len(bare) > 1 else 'family lacks'} "
            f"{SCRIPT_NAMES[script]} letters, and the app draws "
            f"{'the whole text' if whole else 'those letters'} in the family of the library closest "
            f"to it that has them: {' and '.join(stand_in)}. Name no font: a named font stays with "
            "the text when a deck moves to another template. Look at the renders for lines that "
            "run longer in that family."
        )
    library = [f["family"] for f in fonts if _has(f, script)]
    roles = " and ".join(bare)
    system = f" (on Windows, {SYSTEM_FONTS[lang]})" if lang in SYSTEM_FONTS else ""
    if not library:
        return (
            f"- **Fonts.** No family of the library has {NAMES[lang]} letters: the system's font"
            f"{system} draws them, as in every template. Name no font."
        )
    ours = [name for name in library if name in _template_families(template)]
    choice = ours or library
    return (
        f"- **Fonts.** The template's {roles} {'families lack' if len(bare) > 1 else 'family lacks'} "
        f"{SCRIPT_NAMES[script]} letters, so the system's font{system} draws that text. The library "
        f"has them in {', '.join(library)}. You may name one of them on the runs of that text "
        f"(`\"marks\": {{\"font\": \"{choice[0]}\"}}`), {'a family the template already uses' if ours else 'the one closest to the template'}, "
        "when the system's font would look out of place beside the rest; a named font stays with "
        "the text when a deck moves to another template, so leave the others alone."
    )


def script_notes(template: dict, fonts: list[dict], lang: str) -> str:
    notes: list[str] = []
    if lang in LONGER:
        notes.append(
            f"- **Longer lines.** {NAMES[lang]} runs longer than English: choose the shorter of two "
            "good wordings, and look at every box that the English fills to the edge."
        )
    if lang == "vi":
        notes.append(
            "- **Marks.** Vietnamese stacks marks above and below its letters: make sure the "
            "renders show no mark touching the line above or clipped."
        )
    if lang in TALLER:
        notes.append(
            f"- **Tall letters.** {NAMES[lang]} letters reach higher and lower than Latin ones. Where "
            "a title's lines meet or a mark is clipped, give its paragraphs a `lineHeight` (about "
            "1.18 for display titles and 1.3 for other titles, as the Atlas template does for "
            "Hindi); never set `letterSpacing` on them, and do not rely on capitals."
        )
    if lang in ANY_BREAK:
        notes.append(
            f"- **Line breaks.** {NAMES[lang]} may break a line between almost any two characters. "
            "Where a title or a large text breaks badly, split it into paragraphs at a natural "
            "phrase boundary"
            + (" (between words in Korean)" if lang == "ko" else "")
            + ", and never leave one or two characters alone on a line. There are no capitals and "
            "no italics."
        )
    if direction(lang) == "rtl":
        notes.append(
            f"- **Direction.** {NAMES[lang]} is written right to left: the deck is right to left and "
            "every layout is mirrored. Latin words and figures inside a sentence stay in it."
        )
    fonts_line = fonts_note(template, fonts, lang)
    if fonts_line:
        notes.append(fonts_line)
    return "\n".join(notes)


def system_prompt(template: dict, quality: str, fonts: list[dict], lang: str) -> str:
    language = NAMES[lang]
    return "\n\n".join(
        [
            ROLE.format(language=language),
            f"{QUALITY_HEADER}\n\n{quality}",
            FORMAT.format(language=language, file=sample_file(lang), script_notes=script_notes(template, fonts, lang)),
            COPY.format(language=language),
            WORKFLOW.format(file=sample_file(lang)),
        ]
    )


def build_prompt(brief: dict) -> str:
    lang = brief["lang"]
    file = sample_file(lang)
    asked = (brief.get("instructions") or "").strip()
    task = (
        f"`{file}` holds the template's {NAMES[lang]} sample as it is published. Rewrite it as the person asks, keeping the format, and write the whole file again."
        if brief.get("rewrite")
        else f"Write `{file}`: the template's sample in {NAMES[lang]}."
    )
    return f"""<studio_template>
{json.dumps(brief, ensure_ascii=False, indent=1)}
</studio_template>
""" + (f"\n<studio_request>\n{asked}\n</studio_request>\n" if asked else "") + f"""
{task}

1. Read `template.md`, `en.json` and `he.json`.
2. Write `{file}`, complete, following the format.
3. Reply in one line with what you wrote.

The app then builds the sample with its engine, renders every slide at full size and as a thumbnail, runs its design check, and shows you the result to review."""


def _slides_line(result: dict, folder: str) -> str:
    count = len(result.get("slides") or [])
    if not count:
        return ""
    last = f"{count:02d}"
    return (
        f"- `{folder}/sheet.png`: every slide at the size the template library shows it\n"
        f"- `{folder}/s01-full.png` … `{folder}/s{last}-full.png`: each slide at 1920×1080\n"
        f"- `{folder}/s01-thumb.png` … `{folder}/s{last}-thumb.png`: each slide 384 px wide"
    )


def slide_findings(result: dict) -> str:
    """The findings of a template render, slide by slide."""
    lang = result.get("lang", "")
    lines: list[str] = []
    for issue in result.get("issues") or []:
        lines.append(f"- the sample · contract: {issue}")
    for slide in result.get("slides") or []:
        where = f"s{int(slide.get('index', 0)) + 1:02d} \"{slide.get('name', '')}\" ({slide.get('layout', '')})"
        if slide.get("error"):
            lines.append(f"- {where} · could not be built: {slide['error']}")
        for issue in slide.get("issues") or []:
            lines.append(f"- {where} · contract: {issue}")
        findings = slide.get("findings") or []
        for finding in [f for f in findings if not f.get("baseline")]:
            lines.append(f"- {where} · {finding.get('severity')} · {finding.get('rule')}: {finding.get('message')}")
        inherited = sorted({str(f.get("rule")) for f in findings if f.get("baseline")})
        if inherited:
            # The slide it was written from has these on the same elements: the template's.
            lines.append(
                f"- {where} · also on the slide it was written from, so not this language's to fix: "
                + ", ".join(inherited)
            )
    side = (result.get("langs") or {}).get(lang) or {}
    if side.get("error"):
        lines.append(f"- the sample · {side['error']}")
    return "Findings of the app's design check and of the sample's contract:\n" + ("\n".join(lines) if lines else "- none")


def review_prompt(result: dict, round_: int, rounds: int, folder: str, lang: str) -> str:
    file = sample_file(lang)
    first = (
        "Look at the sheet and at every slide at full size before you decide anything (Read them)."
        if round_ == 1
        else "Look at the sheet, and at full size at every slide you changed or that has a finding (Read them)."
    )
    return f"""<studio_review round="{round_}" of="{rounds}">
The app built your sample with its engine and rendered it. {first}
{_slides_line(result, folder)}

{slide_findings(result)}

Hold each slide against the English sample and the quality bar. Fix every error above, and whatever the pictures show falls short: text that overflows its box or runs into the next, an awkward break, a word alone on a line, a clipped mark, wrong direction, a figure or date written the English way, a sentence that reads as a translation. Edit `{file}`.

When the sample is ready to publish, change no file and reply READY. Otherwise reply in one line with what you changed.
</studio_review>"""


def fix_prompt(result: dict, folder: str, lang: str) -> str:
    return f"""<studio_check>
The app rendered your change.
{_slides_line(result, folder)}

{slide_findings(result)}

Look at the slides with findings, and fix the errors above in `{sample_file(lang)}` without undoing the change that was asked for. When nothing needs fixing, change no file and reply READY.
</studio_check>"""


def feedback_prompt(feedback: str, lang: str) -> str:
    return f"""<studio_feedback>
{feedback.strip()}
</studio_feedback>

The person reviewing this sample asks for the change above. Make it in `{sample_file(lang)}` and keep everything else that works. Reply in one line with what you changed. The app renders the result again and shows it to you."""


# ---------------------------------------------------------------------- reading a request


ROUTE_SYSTEM = """# Slidr Studio: what a request asks for

Slidr is a desktop presentation editor, and the studio makes the ready-made content of its media library. A person writes a request in words, often in Hebrew. You read it and say which kind of work it is, so the studio can start it. You answer with the structured result only.

The kinds the studio makes:

- `design`: ready-made slides for Elements → Designs (an invitation, an announcement, a marketing slide, a slide for an event or a course, a video thumbnail, a greeting…), each from a concept, a picture and HTML. A request that describes a slide or a design to make is a design.
- `template`: the sample deck of one of the built-in templates, written in languages. Translating a template ("translate Mifgash into German", "translate the Mifgash template into every language it lacks") is this kind; so is rewriting the sample of a template in a language it has ("make the Hebrew sample of Atlas about a travel agency"). The template's layouts, colours and pictures stay as they are.
- `unsupported`: anything else: a new template from nothing, a template's layouts or colours, card sets, event frames, shapes, graphics, icons, emoji, fonts. Say why in `reason`, in the request's language, and what the studio can do instead."""


def route_schema() -> dict:
    return {
        "type": "object",
        "required": ["kind", "reason"],
        "properties": {
            "kind": {"enum": ["design", "template", "unsupported"]},
            "reason": {"type": "string"},
            "templateId": {"type": "string"},
            "languages": {"type": "array", "items": {"enum": list(CONTENT_LANGUAGES)}},
            "instructions": {"type": "string"},
            "title": {"type": "string", "maxLength": 60},
        },
    }


def route_prompt(prompt: str, templates: Sequence[dict]) -> str:
    rows = "\n".join(
        f"- `{t['id']}`: {t['name']['he']} / {t['name']['en']}, {t['tagline'].get('en', '')}. "
        f"Its sample is written in: {', '.join(t['languages'])}. Not yet in: {', '.join(t['missing']) or 'none'}."
        for t in templates
    )
    langs = ", ".join(f"`{code}` {NAMES[code]}" for code in CONTENT_LANGUAGES)
    return f"""<studio_request>
{prompt.strip()}
</studio_request>

The built-in templates:
{rows}

The content languages of the app: {langs}.

Answer with:
- `kind`, and `reason`: one sentence on what you understood, in the request's language.
- For a template: `templateId`; `languages`, the languages to write its sample in (for "every language it lacks", exactly the languages its sample is not yet written in; a rewrite names a language it has); `instructions`, what the person asks beyond the translation, in their words, or an empty string; and `title`, a short name for the request in English (the template's English name and what is done, such as "Mifgash · 14 languages").
- For a design, nothing more."""
