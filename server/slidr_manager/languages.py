"""The languages a design is made in: the server's copy of the app's registry.

`packages/model/src/languages.ts` is the registry; the tests hold this copy to it. Every design
is written in the two base languages, Hebrew and English. A request may add any of the others,
and its designs are then planned, written, rendered, reviewed and published in exactly those. A
request without a choice (one made before there was one) is made in Hebrew and English.
"""

from __future__ import annotations

from collections.abc import Iterable

#: The content languages of the app, in its order (`CONTENT_LANGUAGES`).
CONTENT_LANGUAGES = (
    "he", "en", "ar", "de", "es", "fr", "it", "pt-BR",
    "ru", "tr", "vi", "id", "hi", "ja", "ko", "zh-CN",
)
#: The languages every design is written in (`BASE_LANGUAGES`).
BASE_LANGUAGES = ("he", "en")
#: The languages written right to left (`languageDir`).
RTL = frozenset({"he", "ar"})

#: Each language by its English name (`LANGUAGE_NAMES[lang].english`).
NAMES = {
    "he": "Hebrew",
    "en": "English",
    "ar": "Arabic",
    "de": "German",
    "es": "Spanish",
    "fr": "French",
    "it": "Italian",
    "pt-BR": "Brazilian Portuguese",
    "ru": "Russian",
    "tr": "Turkish",
    "vi": "Vietnamese",
    "id": "Indonesian",
    "hi": "Hindi",
    "ja": "Japanese",
    "ko": "Korean",
    "zh-CN": "Simplified Chinese",
}

#: The letters each language is written in, by the tag a family of the library's fonts carries
#: for them in `fonts/catalog.json` (`LANGUAGE_SCRIPT`).
SCRIPT = {
    "he": "he",
    "en": "latin",
    "ar": "arabic",
    "de": "latin",
    "es": "latin",
    "fr": "latin",
    "it": "latin",
    "pt-BR": "latin",
    "ru": "cyrillic",
    "tr": "latin",
    "vi": "vietnamese",
    "id": "latin",
    "hi": "devanagari",
    "ja": "japanese",
    "ko": "korean",
    "zh-CN": "chinese",
}

_BY_LOWER = {code.lower(): code for code in CONTENT_LANGUAGES}


def direction(lang: str) -> str:
    return "rtl" if lang in RTL else "ltr"


def file_of(lang: str) -> str:
    """The design's HTML file in a language: `he.html`, `pt-BR.html`."""
    return f"{lang}.html"


def _ordered(codes: set[str]) -> list[str]:
    return [code for code in CONTENT_LANGUAGES if code in codes or code in BASE_LANGUAGES]


def parse(codes: Iterable[str]) -> list[str]:
    """The languages a request asks for: the codes of the registry (in any case), Hebrew and
    English added, each once, in the registry's order. An unknown code is an error."""
    found: set[str] = set()
    unknown: list[str] = []
    for code in codes:
        known = _BY_LOWER.get(str(code).strip().lower())
        if known:
            found.add(known)
        else:
            unknown.append(str(code))
    if unknown:
        raise ValueError(
            f"Unknown language {', '.join(unknown)}; the languages are {', '.join(CONTENT_LANGUAGES)}."
        )
    return _ordered(found)


def known(codes: Iterable[str]) -> list[str]:
    """The languages of the registry among `codes` (in any case), each once, in the registry's
    order, and nothing added: the languages a template's sample is to be written in. An unknown
    code is an error."""
    found: list[str] = []
    for code in codes:
        match = _BY_LOWER.get(str(code).strip().lower())
        if not match:
            raise ValueError(
                f"Unknown language {code}; the languages are {', '.join(CONTENT_LANGUAGES)}."
            )
        found.append(match)
    return [code for code in CONTENT_LANGUAGES if code in found]


def chosen(*sources: object) -> list[str]:
    """The languages of a stored request or variant: the first list among `sources` that has
    any, read leniently (a code the registry does not know is left out), Hebrew and English
    always. Nothing stored means Hebrew and English."""
    for source in sources:
        if isinstance(source, (list, tuple)) and source:
            known = {_BY_LOWER.get(code.lower()) for code in source if isinstance(code, str)}
            return _ordered({code for code in known if code})
    return list(BASE_LANGUAGES)


def listing(items: Iterable[str], last: str = "and") -> str:
    """`a`, `a and b`, `a, b and c`."""
    words = list(items)
    if len(words) <= 1:
        return "".join(words)
    return ", ".join(words[:-1]) + f" {last} " + words[-1]


def names(langs: Iterable[str], last: str = "and") -> str:
    """"Hebrew and English", "Hebrew, English and Arabic"."""
    return listing((NAMES[lang] for lang in langs), last)


def files(langs: Iterable[str]) -> str:
    """"`he.html` and `en.html`"."""
    return listing(f"`{file_of(lang)}`" for lang in langs)
