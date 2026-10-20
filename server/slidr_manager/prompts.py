"""What Claude is told when it makes a design for the Elements gallery.

The system prompt is assembled from the app's own instructions (`instructions.py`): the quality
bar of AGENTS.md, the design guidelines and HTML conventions of `packages/prompts`, and the
fonts of the library. What is said here is only what a design of the gallery adds to them: the
contract the app's catalog and its tests hold a design to (`apps/desktop/src/elements/
designs.test.ts`), and how the studio's files and turns work.

Every prompt names the languages of its request (`languages.py`): one HTML file per language,
Hebrew and English always, and only the other languages the person chose for that request.
"""

from __future__ import annotations

import json
from collections.abc import Sequence

from .instructions import fonts_text
from .languages import BASE_LANGUAGES, NAMES, direction, file_of, files, listing, names

ROLE = """# Slidr Studio: designs for the Elements gallery

You are the art director of Slidr's Elements gallery. Slidr is a desktop presentation editor. Elements → Designs offers ready-made slides (invitations, announcements, marketing slides, event and course slides, video thumbnails, greetings and more) that a user inserts into a deck with one click, then edits: the words, the picture, the colours. What you make here is published to every user of the app, in {languages}, so it must be finished work: art directed, publication ready, and distinct from the other designs.

The person running the studio describes what they need. You plan concepts, then design each one as HTML, which the app converts into an editable slide with its own engine. The app renders the result, runs its own design check on it, and shows it to you before anyone else sees it."""

QUALITY_HEADER = "## The quality bar\n\nThe repository's instruction for ready-made designs, and the standard your work is judged by:"

PRECEDENCE = """The guidelines below were written for the slides of a deck. A design of the gallery is not part of a deck with a theme: where the contract that follows them says otherwise (theme variables, fonts, icons), the contract wins."""

CONTRACT = """## The contract of a design in the gallery

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
- a new `"image": {{"prompt": "…", "aspect": "…"}}` makes a new picture;
- `"imageEdit": "<instruction>"` changes the picture there is (the model draws it again after it, so ask for a change of content or composition, not a pixel fix).

A prompt says what the picture shows and how: subject, framing and where calm space for text falls ("the subject on the right third, a quiet sky on the left"), light, palette, medium. It never asks for text, letters, numbers, logos or watermarks in the picture. You may also change the brief's `name`, `group` and `groupName` when the work changes what the design is; the `id` stays."""

WORKFLOW = """## This folder

You work in a folder of your own, and your file tools reach only it: `brief.json` (the concept), `subject.png` (the picture), {files} (yours to write: one for each language of this request, and no other), and `renders/` (the app's renders of your files, a folder for each revision, and nothing else). You have no shell. Write complete files; there is nothing to install or run."""

#: Languages whose lines run longer than English.
LONGER = ("de", "es", "fr", "it", "pt-BR", "ru", "tr", "id")
#: Languages whose letters reach higher and lower than Latin ones, and must not be spaced apart.
TALLER = ("ar", "hi")
#: Languages a browser may break between almost any two characters.
ANY_BREAK = ("ja", "ko", "zh-CN")
COUNTS = {4: "four", 6: "six", 8: "eight", 10: "ten", 12: "twelve"}


def _only_base(langs: Sequence[str]) -> bool:
    return tuple(langs) == BASE_LANGUAGES


def _ltr(langs: Sequence[str]) -> list[str]:
    return [lang for lang in langs if direction(lang) == "ltr"]


def _rtl(langs: Sequence[str]) -> list[str]:
    return [lang for lang in langs if direction(lang) == "rtl"]


def _fit_notes(langs: Sequence[str]) -> list[str]:
    notes: list[str] = []
    longer = [lang for lang in langs if lang in LONGER]
    if longer:
        notes.append(
            f"{names(longer)} {'runs' if len(longer) == 1 else 'run'} longer than English: give the "
            "lines room within the composition (a wider block, or the type a step smaller), and never "
            "let a line overflow, crowd its neighbours or break a word."
        )
    if "vi" in langs:
        notes.append(
            "Vietnamese stacks marks above and below its letters: give its lines a little more "
            "height than English, so that no mark touches the line above or is clipped."
        )
    taller = [lang for lang in langs if lang in TALLER]
    if taller:
        breaks = listing(
            {"ar": "the joined letters of Arabic", "hi": "the line along the top of Hindi letters"}[lang]
            for lang in taller
        )
        notes.append(
            f"{names(taller)} letters reach higher and lower than Latin ones: give their lines more "
            "height (about 1.5 for running text, 1.25 for a title) so that no mark is clipped, never "
            f"set `letter-spacing` on them (it breaks {breaks}), and do not rely on capitals: "
            f"{'the script has' if len(taller) == 1 else 'the scripts have'} none."
        )
    breaking = [lang for lang in langs if lang in ANY_BREAK]
    if breaking:
        notes.append(
            f"{names(breaking)} may break a line between almost any two characters: break the lines "
            "of the title and of other large text yourself with `<br>` at natural phrase boundaries"
            + (" (between words in Korean)" if "ko" in breaking else "")
            + ", and never leave one or two characters alone on a line. There are no capitals and no "
            "italics: give emphasis with weight, size or colour."
        )
    return notes


def files_rule(langs: Sequence[str]) -> str:
    """The first rule of the contract: which files to write, and how they mirror each other."""
    if _only_base(langs):
        return (
            "- **Two files, one design.** This request is made in Hebrew and English only: write "
            "`he.html` and `en.html`, and no file in any other language (a deck in another language "
            "gets the English design). `he.html` is the Hebrew design (`dir=\"rtl\" lang=\"he\"`), "
            "with copy written for Hebrew readers, not translated word by word. `en.html` is the "
            "English one (`dir=\"ltr\" lang=\"en\"`). Each is the mirror of the other: what stands on "
            "the right in Hebrew stands on the left in English. Mirror the picture's frame exactly "
            "(its `left` in one file is `1920 - left - width` in the other), so that the same point "
            "of the picture lies on its subject in both."
        )
    roots = "\n".join(
        f"  - `{file_of(lang)}`: {NAMES[lang]}, `dir=\"{direction(lang)}\" lang=\"{lang}\"`" for lang in langs
    )
    extra = [lang for lang in langs if lang not in BASE_LANGUAGES]
    notes = "\n".join(f"  - {note}" for note in _fit_notes(langs))
    return (
        f"- **One file per language, one design.** This request is made in {names(langs)}, and in "
        f"no other language: write exactly {files(langs)}, each with its language and direction on "
        f"the root:\n{roots}\n"
        f"  Hebrew and English are always made (a deck in a language the design was not written in "
        f"gets the English one); {names(extra)} {'is' if len(extra) == 1 else 'are'} what the "
        "person asked for. Each file's copy is written natively for its own readers, not translated "
        "word by word from another file.\n"
        "- **One composition, mirrored.** The English file sets it. Every left-to-right file "
        f"({files(_ltr(langs))}) keeps it: the same layout, places and sizes, and the picture's frame "
        f"exactly where it is in `en.html`. Every right-to-left file ({files(_rtl(langs))}) is its "
        "mirror: what stands on the left in English stands on the right, and the picture's frame is "
        "mirrored exactly (its `left` is `1920 - left - width` of the English one). So the same "
        "point of the picture lies on its subject in every file. A language changes only what its "
        "text needs to fit, never the places of the picture and the blocks:"
        + (f"\n{notes}" if notes else "")
    )


def system_prompt(
    app: dict, quality: str, fonts: list[dict], langs: Sequence[str], *, with_html: bool
) -> str:
    parts = [
        ROLE.format(languages=names(langs)),
        f"{QUALITY_HEADER}\n\n{quality}",
        PRECEDENCE,
        app["design"],
    ]
    if with_html:
        parts.append(app["html"])
    parts += [CONTRACT.format(files_rule=files_rule(langs)), fonts_text(fonts, langs)]
    if with_html:
        parts.append(WORKFLOW.format(files=files(langs)))
    return "\n\n".join(parts)


def _texts(langs: Sequence[str]) -> dict:
    return {
        "type": "object",
        "required": list(langs),
        "properties": {lang: {"type": "string"} for lang in langs},
    }


def plan_schema(langs: Sequence[str]) -> dict:
    """The plan's shape: the copy in every language of the request; the names in Hebrew and
    English, the two the gallery names its designs in."""
    return {
        "type": "object",
        "required": ["concepts"],
        "properties": {
            "concepts": {
                "type": "array",
                "minItems": 1,
                "items": {
                    "type": "object",
                    "required": ["slug", "name", "group", "groupName", "concept", "art", "copy", "image"],
                    "properties": {
                        "slug": {"type": "string", "pattern": "^[a-z0-9]+(-[a-z0-9]+)*$", "maxLength": 40},
                        "name": _texts(BASE_LANGUAGES),
                        "group": {"type": "string", "pattern": "^[a-z0-9]+(-[a-z0-9]+)*$", "maxLength": 30},
                        "groupName": _texts(BASE_LANGUAGES),
                        "concept": {"type": "string"},
                        "art": {"type": "string"},
                        "copy": _texts(langs),
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
    }


def plan_prompt(
    prompt: str,
    count: int,
    groups: list[dict],
    taken: list[str],
    group: str | None,
    langs: Sequence[str],
) -> str:
    group_lines = "\n".join(
        f"- `{g['id']}`" + (f": {g['he']} / {g['en']}" if g.get("he") else "") for g in groups
    ) or "- (none yet)"
    wanted = (
        f"File every design under the group `{group}`."
        if group
        else "File each design under the existing group it belongs to, or name a new group when none fits."
    )
    many = (
        f"Plan {count} designs. Each must be a different concept: a different layout, focal point, "
        "typography, palette and picture, never a recolour or a retitle of another. Together they "
        "should give the person real alternatives."
        if count > 1
        else "Plan one design."
    )
    codes = listing(f"`{lang}`" for lang in langs)
    names_only = (
        "" if _only_base(langs) else "; the gallery names its designs in these two languages only"
    )
    fonts_for = "" if _only_base(langs) else " (for the letters of each of the design's languages)"
    return f"""<studio_request>
{prompt.strip()}
</studio_request>

{many} {wanted}

Each design is made in {names(langs)}, and in no other language.

The groups of the gallery:
{group_lines}

Ids already taken (your slug becomes the id `m-<slug>`, so do not reuse these): {", ".join(taken) or "none"}

For each concept:
- `slug`: a short English id (lowercase words joined by hyphens).
- `name`: what the gallery calls it, in Hebrew and in English (two to four words{names_only}).
- `group`, `groupName`: its group's id and, for a new group, its name in Hebrew and in English (for an existing one, repeat its names, or your best names for it).
- `concept`: the idea and the focal point, in two or three sentences.
- `art`: the art direction: the layout and where the picture sits, the palette as hex colours, the font families from the list and how they are used{fonts_for}, the purposeful details.
- `copy`: the words of the slide in each language of the design, under its code ({codes}), block by block (title, the line under it, details, call to action). Original and specific; each language written natively for its own readers, not translated word for word from another.
- `image`: the prompt and aspect of the picture, as the section on the picture describes.

Answer with the plan only."""


def build_prompt(brief: dict, image_size: tuple[int, int], langs: Sequence[str]) -> str:
    w, h = image_size
    every = "both files" if len(langs) == 2 else "every file"
    return f"""<studio_design>
{json.dumps(brief, ensure_ascii=False, indent=1)}
</studio_design>

Design this concept. Its picture was made from the brief's image prompt and is in this folder as `subject.png` ({w}×{h} px).

1. Read `subject.png` and look at it: where its subject is, where calm space for text falls, its light and colours. Compose around the picture you have, not the one you asked for.
2. Write {files(langs)} in this folder, following the contract: one file for each language of this request, and no other.
3. Reply in one line with what you made.

The app then converts {every} with its engine, renders them at full size and as a thumbnail, runs its design check, and shows you the result to review."""


def findings_text(result: dict, langs: Sequence[str]) -> str:
    sides = result.get("langs") or {}
    lines: list[str] = []
    every = "both" if len(langs) == 2 else "all"
    for issue in result.get("issues") or []:
        lines.append(f"- {every} · contract: {issue}")
    for lang in langs:
        side = sides.get(lang) or {}
        if side.get("error"):
            lines.append(f"- {lang} · conversion failed: {side['error']}")
        for issue in side.get("issues") or []:
            lines.append(f"- {lang} · contract: {issue}")
        for finding in side.get("findings") or []:
            lines.append(f"- {lang} · {finding.get('severity')} · {finding.get('rule')}: {finding.get('message')}")
    conversion = []
    for lang in langs:
        side = sides.get(lang) or {}
        if "editability" in side:
            share = round(float(side["editability"]) * 100)
            notes = "; ".join(side.get("notes") or [])
            conversion.append(f"{lang} {share}% editable" + (f" (notes: {notes})" if notes else ""))
    text = "Findings of the app's design check and of the gallery's contract:\n" + (
        "\n".join(lines) if lines else "- none"
    )
    if conversion:
        text += "\n\nConversion: " + "; ".join(conversion)
    return text


def _pictures(folder: str, langs: Sequence[str], kind: str) -> str:
    return listing(f"`{folder}/{lang}-{kind}.png`" for lang in langs)


def _keep(langs: Sequence[str]) -> str:
    if len(langs) == 2:
        return "keep them mirrored"
    return (
        "keep every left-to-right file in the English composition and every right-to-left file its "
        "mirror"
    )


def review_prompt(result: dict, round_: int, rounds: int, folder: str, langs: Sequence[str]) -> str:
    count = 2 * len(langs)
    compare = "the two languages" if len(langs) == 2 else "the languages"
    return f"""<studio_review round="{round_}" of="{rounds}">
The app converted your HTML with its engine and rendered the slides. Look at all {COUNTS.get(count, count)} pictures before you decide anything (Read them):
- {_pictures(folder, langs, "full")}: the slide at 1920×1080
- {_pictures(folder, langs, "thumb")}: the thumbnail the gallery shows, 384 px wide

{findings_text(result, langs)}

Hold each render against the quality bar and the checklist that closes the design guidelines, and compare {compare}. Fix every error above, and whatever the pictures show falls short: overflow, awkward wraps, clipping, weak contrast, a poor crop of the picture, uneven alignment, mistakes of direction, a weak focal point, empty or crowded areas. Edit {files(langs)}, and {_keep(langs)}. Change `brief.json` when the picture is what falls short.

When the design is publication ready, change no file and reply READY. Otherwise reply in one line with what you changed.
</studio_review>"""


def feedback_prompt(feedback: str, langs: Sequence[str]) -> str:
    where = (
        "both `he.html` and `en.html` (mirrored, the Hebrew still natural Hebrew)"
        if _only_base(langs)
        else f"every file of the design, {files(langs)} (every left-to-right file in the English "
        "composition and every right-to-left file its mirror, each language still natural to its "
        "readers),"
    )
    return f"""<studio_feedback>
{feedback.strip()}
</studio_feedback>

The person reviewing this design asks for the change above. Make it in {where} and keep everything else that works. When it concerns the picture, the name or the group, change `brief.json` as the contract describes. Reply in one line with what you changed. The app renders the result again and shows it to you."""


def fix_prompt(result: dict, folder: str, langs: Sequence[str]) -> str:
    fulls = ", ".join(f"`{folder}/{lang}-full.png`" for lang in langs)
    return f"""<studio_check>
The app rendered your change. {findings_text(result, langs)}

Look at {fulls} and the thumbnails in that folder, and fix the errors above in {files(langs)} without undoing the change that was asked for. When nothing needs fixing, change no file and reply READY.
</studio_check>"""
