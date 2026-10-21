"""The built-in templates of the media library, and what a template request works on.

A template request writes the sample deck of one built-in template in languages: one it is not
written in yet (a translation), or one it has (a rewrite the person describes). Each language is
a variant of the request, with its own Claude conversation, and each is uploaded by itself to the
library, which publishes it into `templates/catalog.json`, under `samples[<template>][<lang>]`
(docs/media-library.md). A deck in a
language a sample is written in gets it; any other gets the English one ([ADR-098]).

```text
<variant>/work/brief.json      the task: the template, its names, the language, the person's words
<variant>/work/template.md     the theme and every layout's boxes, as Claude reads them
<variant>/work/en.json         the sample in English, which sets the structure, and in Hebrew
<variant>/work/he.json
<variant>/work/<lang>.json     Claude's: the sample in the variant's language (SampleSlide[])
<variant>/work/template.json   the template as the catalog holds it, for the render page
```

The catalog read is the published one (`SLIDR_MEDIA_URL`), read again after ten minutes, or once
a publication has changed it.
"""

from __future__ import annotations

import asyncio
import json
from pathlib import Path
from typing import Any

from .config import Settings
from .languages import CONTENT_LANGUAGES, NAMES, direction
from .instructions import fetch_json
from .store import write_json

CATALOG = "templates/catalog.json"
#: How long the published catalog read is kept.
PUBLISHED_TTL = 600.0


class TemplateError(Exception):
    pass


def sample_languages(samples: dict | None) -> list[str]:
    """The languages a template's sample is written in, in the registry's order."""
    return [lang for lang in CONTENT_LANGUAGES if isinstance((samples or {}).get(lang), list)]


def missing_languages(samples: dict | None) -> list[str]:
    """The content languages a template's sample is not written in yet."""
    have = set(sample_languages(samples))
    return [lang for lang in CONTENT_LANGUAGES if lang not in have]


# ---------------------------------------------------------------------- what Claude reads


def _color(theme: dict, color: Any) -> str:
    if isinstance(color, dict):
        if "token" in color:
            value = (theme.get("colors") or {}).get(color["token"], color["token"])
            alpha = color.get("alpha")
            return f"{color['token']} ({value})" + (f" at {alpha}" if alpha is not None else "")
        if "value" in color:
            return str(color["value"])
    return "—"


def _style(theme: dict, ref: str | None) -> tuple[str, float | None, float | None]:
    styles = theme.get("textStyles") or {}
    style = styles.get(ref or "body")
    if not isinstance(style, dict):
        return (ref or "—", None, None)
    fonts = (theme.get("fonts") or {}).get(style.get("font") or "body") or {}
    pair = f"{fonts.get('latin', '?')} / {fonts.get('he', '?')}"
    size = style.get("size")
    return (
        f"{ref or 'body'} {size}px {style.get('weight', 400)} in {pair}",
        float(size) if isinstance(size, (int, float)) else None,
        float(style.get("lineHeight") or 1.2),
    )


def digest(template: dict) -> str:
    """The theme and the boxes of every layout, in words: the room each text has."""
    theme = template.get("theme") or {}
    fonts = theme.get("fonts") or {}
    lines = [
        f"# {theme.get('name', theme.get('id'))} (`{theme.get('id')}`)",
        "",
        template.get("description") or "",
        "",
        "## Fonts",
        "",
        "A text style names a role, heading or body; each role has a family for Latin letters "
        "(and every script but Hebrew) and one for Hebrew:",
        "",
    ]
    for role in ("heading", "body"):
        pair = fonts.get(role) or {}
        lines.append(f"- {role}: `{pair.get('latin')}` for Latin and other letters, `{pair.get('he')}` for Hebrew")
    lines += ["", "## Text styles", ""]
    for ref, style in (theme.get("textStyles") or {}).items():
        if isinstance(style, dict):
            lines.append(
                f"- {ref}: {style.get('size')}px, weight {style.get('weight')}, line height "
                f"{style.get('lineHeight')}, {style.get('font')} font, colour {_color(theme, style.get('color'))}"
                + (f", {style['case']} case" if style.get("case") else "")
            )
    lines += [
        "",
        "## Layouts",
        "",
        f"Drawn for {'right to left' if template.get('dir') == 'rtl' else 'left to right'}; a deck "
        "of the other direction gets their mirror, with the same boxes. A role that a layout has "
        "more than once is filled in the order listed, and its content in the sample is a list in "
        "that order. A box is the room its text has: text that outgrows it overflows the slide.",
        "",
    ]
    for layout in template.get("layouts") or []:
        lines.append(f"### `{layout.get('id')}`: {layout.get('archetype')} ({layout.get('name')})")
        counts: dict[str, int] = {}
        for placeholder in layout.get("placeholders") or []:
            role = placeholder.get("role")
            counts[role] = counts.get(role, 0) + 1
        seen: dict[str, int] = {}
        for placeholder in layout.get("placeholders") or []:
            role = placeholder.get("role")
            seen[role] = seen.get(role, 0) + 1
            frame = placeholder.get("frame") or {}
            w, h = round(frame.get("w", 0)), round(frame.get("h", 0))
            name = f"{role} {seen[role]} of {counts[role]}" if counts[role] > 1 else role
            if role in ("image", "chart", "table"):
                lines.append(f"- {name}: {w}×{h}")
                continue
            words, size, height = _style(theme, placeholder.get("styleRef"))
            fits = (
                f", about {max(1, int(h // (size * height)))} line(s)"
                if size and height and h
                else ""
            )
            extra = []
            if placeholder.get("color"):
                extra.append(f"text colour {_color(theme, placeholder['color'])}")
            if placeholder.get("align"):
                extra.append(f"aligned {placeholder['align']}")
            lines.append(
                f"- {name}: {w}×{h} px, {words}{fits}" + (f"; {', '.join(extra)}" if extra else "")
            )
        lines.append("")
    return "\n".join(lines).strip() + "\n"


def pretty(slides: Any) -> str:
    return json.dumps(slides, ensure_ascii=False, indent=1) + "\n"


def sample_file(lang: str) -> str:
    """The file of a sample in a language: `de.json`, `pt-BR.json`."""
    return f"{lang}.json"


class Templates:
    """The catalog of templates, read when it is asked for."""

    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self._read: tuple[float, dict] | None = None
        self._lock = asyncio.Lock()

    async def catalog(self) -> dict:
        """The published catalog of templates."""
        async with self._lock:
            loop = asyncio.get_running_loop()
            if self._read and loop.time() - self._read[0] < PUBLISHED_TTL:
                return self._read[1]
            url = self.settings.media_url.rstrip("/") + "/" + CATALOG
            try:
                data = await asyncio.to_thread(fetch_json, url, 120)
            except Exception as error:  # noqa: BLE001 - any failure means no catalog
                raise TemplateError(f"Could not read the library's templates ({url}): {error}")
            if not isinstance(data, dict) or not isinstance(data.get("templates"), list):
                raise TemplateError("The catalog of templates holds no templates.")
            self._read = (loop.time(), data)
            return data

    def forget(self) -> None:
        self._read = None

    async def listing(self, words: dict | None = None) -> list[dict]:
        """Every built-in template: its id, its names and tagline in Hebrew and English (the
        app's words), the languages its sample is written in, and those it is not."""
        catalog = await self.catalog()
        words = words or {}

        def word(lang: str, key: str, tid: str) -> str | None:
            value = ((words.get(lang) or {}).get(key) or {}).get(tid)
            return value if isinstance(value, str) else None

        out = []
        for template in catalog["templates"]:
            theme = template.get("theme") or {}
            tid = theme.get("id")
            if not isinstance(tid, str):
                continue
            samples = (catalog.get("samples") or {}).get(tid)
            out.append(
                {
                    "id": tid,
                    "name": {"he": word("he", "name", tid) or theme.get("name", tid), "en": word("en", "name", tid) or theme.get("name", tid)},
                    "tagline": {"he": word("he", "tagline", tid) or "", "en": word("en", "tagline", tid) or ""},
                    "languages": sample_languages(samples),
                    "missing": missing_languages(samples),
                }
            )
        return out

    async def template(self, tid: str) -> tuple[dict, dict]:
        """A template as the catalog holds it, and its samples by language."""
        catalog = await self.catalog()
        template = next((t for t in catalog["templates"] if (t.get("theme") or {}).get("id") == tid), None)
        if template is None:
            raise TemplateError(f"The library has no template {tid}.")
        samples = (catalog.get("samples") or {}).get(tid) or {}
        if not isinstance(samples.get("en"), list):
            raise TemplateError(f"The template {tid} has no English sample to start from.")
        return template, samples

    async def prepare_work(self, work: Path, brief: dict) -> None:
        """Writes what a template variant starts from into its folder: the template, its
        digest, the English and Hebrew samples, and the sample in the variant's language when the
        template has one already (a rewrite)."""
        template, samples = await self.template(brief["templateId"])
        work.mkdir(parents=True, exist_ok=True)
        write_json(work / "brief.json", brief)
        (work / "template.json").write_text(json.dumps(template, ensure_ascii=False), encoding="utf-8")
        (work / "template.md").write_text(digest(template), encoding="utf-8")
        for lang in ("en", "he"):
            if isinstance(samples.get(lang), list):
                (work / sample_file(lang)).write_text(pretty(samples[lang]), encoding="utf-8")
        lang = brief["lang"]
        if lang not in ("en", "he") and isinstance(samples.get(lang), list):
            (work / sample_file(lang)).write_text(pretty(samples[lang]), encoding="utf-8")


def template_brief(template: dict, names: dict, lang: str, instructions: str) -> dict:
    """The task of one variant of a template request."""
    tid = template["id"]
    return {
        "templateId": tid,
        "name": names,
        "tagline": template.get("tagline") or {},
        "lang": lang,
        "language": NAMES[lang],
        "dir": direction(lang),
        "rewrite": lang in template.get("languages", []),
        "instructions": instructions,
    }
