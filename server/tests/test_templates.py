"""Unit tests of template requests: the sample of a built-in template written in languages."""

from __future__ import annotations

import asyncio
import json
from pathlib import Path

import pytest

from slidr_manager import languages, template_prompts, templates
from slidr_manager.app import NewRequest
from slidr_manager.config import Settings
from slidr_manager.events import EventBus
from slidr_manager.instructions import Instructions
from slidr_manager.library import Library, LibraryError
from slidr_manager.pipeline import Studio, StudioError, watched
from slidr_manager.store import Store, write_json
from slidr_manager.templates import Templates

BASE = ["he", "en"]


def _paragraphs(*lines: str) -> dict:
    return {"paragraphs": [{"dir": "auto", "align": "start", "runs": [{"text": line}]} for line in lines]}


THEME = {
    "id": "mifgash",
    "name": "Mifgash",
    "colors": {"bg": "#1a24a6", "text": "#ffffff", "muted": "#e3e6ff"},
    "fonts": {"heading": {"he": "Rubik", "latin": "Montserrat"}, "body": {"he": "Heebo", "latin": "Montserrat"}},
    "textStyles": {
        "title": {"font": "heading", "size": 60, "weight": 700, "lineHeight": 1.15, "color": {"token": "text"}},
        "body": {"font": "body", "size": 26, "weight": 400, "lineHeight": 1.5, "color": {"token": "text"}},
    },
}
TEMPLATE = {
    "theme": THEME,
    "description": "Online session.",
    "dir": "rtl",
    "layouts": [
        {
            "id": "l_cards",
            "name": "Cards",
            "archetype": "cards",
            "placeholders": [
                {"id": "p1", "role": "title", "frame": {"x": 0, "y": 0, "w": 1300, "h": 148}, "styleRef": "title"},
                {
                    "id": "p2",
                    "role": "body",
                    "frame": {"x": 0, "y": 0, "w": 500, "h": 120},
                    "styleRef": "body",
                    "color": {"token": "bg"},
                },
                {"id": "p3", "role": "body", "frame": {"x": 0, "y": 0, "w": 500, "h": 120}, "styleRef": "body"},
                {"id": "p4", "role": "image", "frame": {"x": 0, "y": 0, "w": 604, "h": 560}},
            ],
            "decorations": [],
        }
    ],
}
EN = [
    {
        "layout": "l_cards",
        "name": "Three sessions",
        "content": {"title": _paragraphs("Three evenings"), "body": [_paragraphs("One"), _paragraphs("Two")]},
    }
]
HE = [
    {
        "layout": "l_cards",
        "name": "שלושה מפגשים",
        "content": {"title": _paragraphs("שלושה ערבים"), "body": [_paragraphs("אחד"), _paragraphs("שניים")]},
    }
]
FONTS = [
    {"family": "Rubik", "scripts": ["he", "latin", "arabic", "cyrillic"]},
    {"family": "Heebo", "scripts": ["he", "latin"]},
    {"family": "Montserrat", "scripts": ["latin", "cyrillic", "vietnamese"]},
    {"family": "Poppins", "scripts": ["latin", "devanagari"]},
]
LISTING = {
    "id": "mifgash",
    "name": {"he": "מפגש", "en": "Mifgash"},
    "tagline": {"en": "Blue"},
    "languages": ["he", "en"],
    "missing": ["ar", "de"],
}


def _catalog() -> dict:
    return {"templates": [TEMPLATE], "samples": {"mifgash": {"he": HE, "en": EN}}, "pictures": {}, "originals": {}}


def _studio(tmp_path: Path, catalog: dict | None = None) -> tuple[Studio, Store, Library, Path]:
    media = tmp_path / "media"
    write_json(media / "templates" / "catalog.json", catalog or _catalog())
    settings = Settings(data=tmp_path / "data")
    settings.media_dir = media
    bus = EventBus()
    store = Store(settings.requests_dir, bus)
    shelf = Templates(settings)
    library = Library(settings, store, bus, shelf)
    return Studio(settings, store, Instructions(settings), library, shelf), store, library, media


def _variant(store: Store, lang: str = "de", rewrite: bool = False) -> dict:
    request = store.create_request({"prompt": "", "kind": "template", "templateId": "mifgash", "languages": [lang]})
    entry = {**LISTING, "languages": ["he", "en", lang] if rewrite else ["he", "en"]}
    brief = templates.template_brief(entry, entry["name"], lang, "")
    return store.create_variant(request, 0, brief, kind="template", templateId="mifgash", lang=lang, languages=[lang])


# ---------------------------------------------------------------- requests


def test_a_template_request_keeps_exactly_its_languages():
    asked = NewRequest(kind="template", templateId="mifgash", languages=["de", "AR", "de"])
    assert asked.languages == ["ar", "de"]
    # A design, or a request the studio is to read, still gets Hebrew and English.
    assert NewRequest(kind="auto", prompt="translate Mifgash").languages == BASE
    assert languages.known(["ko", "he"]) == ["he", "ko"]
    with pytest.raises(ValueError, match="Unknown language"):
        languages.known(["xx"])


def test_a_template_request_has_no_more_concepts(tmp_path: Path):
    studio, store, _, _ = _studio(tmp_path)
    request = store.create_request({"prompt": "", "kind": "template", "templateId": "mifgash", "languages": ["de"]})
    with pytest.raises(StudioError, match="variant for each of its languages"):
        studio.more(request["id"], 2)


def test_the_route_prompt_gives_each_template_its_names_and_missing_languages():
    text = template_prompts.route_prompt("תרגם את תבנית מפגש לכל השפות שחסרות", [LISTING])
    assert "`mifgash`: מפגש / Mifgash" in text and "Not yet in: ar, de." in text
    assert "תרגם את תבנית מפגש" in text
    schema = template_prompts.route_schema()
    assert schema["properties"]["kind"]["enum"] == ["design", "template", "unsupported"]
    assert set(schema["properties"]["languages"]["items"]["enum"]) == set(languages.CONTENT_LANGUAGES)


# ---------------------------------------------------------------- the catalog


def test_the_languages_a_template_lacks_are_the_registrys_others():
    assert templates.sample_languages({"en": [], "he": [], "de": [], "x": []}) == ["he", "en", "de"]
    missing = templates.missing_languages({"he": [], "en": []})
    assert missing == [code for code in languages.CONTENT_LANGUAGES if code not in BASE]
    assert len(missing) == 14


def test_a_sample_is_merged_in_the_registrys_order_and_written_as_node_writes_it():
    catalog = _catalog()
    templates.merge_sample(catalog, "mifgash", "ja", [{"layout": "l_cards"}])
    templates.merge_sample(catalog, "mifgash", "de", [{"layout": "l_cards"}])
    assert list(catalog["samples"]["mifgash"]) == ["he", "en", "de", "ja"]
    templates.merge_sample(catalog, "mifgash", "de", [{"layout": "l_cards", "name": "Drei"}])
    assert catalog["samples"]["mifgash"]["de"] == [{"layout": "l_cards", "name": "Drei"}]
    with pytest.raises(templates.TemplateError):
        templates.merge_sample(catalog, "nosuch", "de", [])
    # `JSON.stringify(…)`: no spaces and no line end, letters as they are.
    encoded = templates.encode_catalog({"a": [1, {"b": "שלום"}]})
    assert encoded == '{"a":[1,{"b":"שלום"}]}'.encode("utf-8")


def test_the_listing_names_each_template_in_the_apps_words(tmp_path: Path):
    catalog = _catalog()
    catalog["samples"]["mifgash"]["de"] = EN
    studio, _, _, _ = _studio(tmp_path, catalog)
    listing = asyncio.run(studio.templates.listing({"he": {"name": {"mifgash": "מפגש"}}}))
    assert listing[0]["name"] == {"he": "מפגש", "en": "Mifgash"}
    assert listing[0]["languages"] == ["he", "en", "de"] and "de" not in listing[0]["missing"]


# ---------------------------------------------------------------- what Claude reads


def test_the_digest_names_every_box_and_the_room_it_has():
    text = templates.digest(TEMPLATE)
    assert "`l_cards`: cards" in text
    assert "title: 1300×148 px, title 60px 700 in Montserrat / Rubik, about 2 line(s)" in text
    assert "body 1 of 2: 500×120 px" in text and "text colour bg (#1a24a6)" in text
    assert "image: 604×560" in text


def test_the_fonts_note_says_which_letters_the_theme_leaves_to_the_system():
    # Arabic: Rubik, the heading's Hebrew family, has its letters; the body's families do not.
    arabic = template_prompts.fonts_note(TEMPLATE, FONTS, "ar")
    assert "body family lacks Arabic" in arabic and '"font": "Rubik"' in arabic
    assert "name no font" in template_prompts.fonts_note(TEMPLATE, FONTS, "ru")
    assert "Poppins" in template_prompts.fonts_note(TEMPLATE, FONTS, "hi")
    assert "No family of the library has Japanese" in template_prompts.fonts_note(TEMPLATE, FONTS, "ja")
    assert template_prompts.fonts_note(TEMPLATE, FONTS, "de") == ""
    # A catalog with counterparts: the app draws the letters in them, and no font is named.
    with_counterparts = [
        {**font, "counterparts": counterparts}
        for font, counterparts in zip(
            FONTS,
            [
                {"japanese": "Zen Maru Gothic"},
                {"arabic": "IBM Plex Sans Arabic", "japanese": "Noto Sans JP"},
                {"arabic": "Cairo", "japanese": "Noto Sans JP"},
                {},
            ],
        )
    ]
    arabic = template_prompts.fonts_note(TEMPLATE, with_counterparts, "ar")
    assert "the body in Cairo" in arabic and "Name no font" in arabic and '"font"' not in arabic
    japanese = template_prompts.fonts_note(TEMPLATE, with_counterparts, "ja")
    assert "the heading in Noto Sans JP and the body in Noto Sans JP" in japanese
    assert "draws those letters" in japanese
    system = template_prompts.system_prompt(TEMPLATE, "QUALITY", FONTS, "de")
    assert "`de.json`" in system and "German runs longer than English" in system and "QUALITY" in system


# ---------------------------------------------------------------- a variant


def test_a_template_variant_writes_one_sample_and_is_rendered_from_it(tmp_path: Path):
    studio, store, _, _ = _studio(tmp_path)
    variant = _variant(store)
    assert variant["designId"] is None and studio.languages_of(variant) == ["de"]
    assert store.all_design_ids() == set()
    work = store.work_dir(variant)
    asyncio.run(studio.templates.prepare_work(work, variant["brief"]))
    assert {p.name for p in work.iterdir()} == {"brief.json", "template.json", "template.md", "en.json", "he.json"}
    assert watched(variant, ["de"]) == ["de.json"]
    with pytest.raises(StudioError, match=r"de\.json"):
        studio.render_input(variant["id"])
    # A file that is not JSON is the render's finding.
    (work / "de.json").write_text("[{", encoding="utf-8")
    data = studio.render_input(variant["id"])
    assert data["kind"] == "template" and data["sample"] is None and "not valid JSON" in data["error"]
    (work / "de.json").write_text(json.dumps(EN), encoding="utf-8")
    data = studio.render_input(variant["id"])
    assert data["error"] is None and data["sample"] == EN and data["english"] == EN
    assert data["template"]["theme"]["id"] == "mifgash" and data["lang"] == "de"
    with pytest.raises(StudioError, match="pictures"):
        studio.new_image(variant["id"], None)


def test_a_rewrite_starts_from_the_sample_the_template_has(tmp_path: Path):
    catalog = _catalog()
    catalog["samples"]["mifgash"]["de"] = EN
    studio, store, _, _ = _studio(tmp_path, catalog)
    variant = _variant(store, "de", rewrite=True)
    assert variant["brief"]["rewrite"] is True
    asyncio.run(studio.templates.prepare_work(store.work_dir(variant), variant["brief"]))
    assert json.loads((store.work_dir(variant) / "de.json").read_text(encoding="utf-8")) == EN
    assert "Rewrite it as the person asks" in template_prompts.build_prompt(variant["brief"])


# ---------------------------------------------------------------- publishing


def test_an_approved_sample_is_published_into_the_author_copys_catalog(tmp_path: Path, monkeypatch):
    _, store, library, media = _studio(tmp_path)
    # The published catalog: the author copy's, before the author added a German sample.
    published = _catalog()

    async def published_json(path: str):
        return published if path == templates.CATALOG else None

    monkeypatch.setattr(library, "published_json", published_json)
    catalog = _catalog()
    catalog["samples"]["mifgash"]["de"] = EN
    write_json(media / "templates" / "catalog.json", catalog)
    variant = _variant(store, "ar")
    work = store.work_dir(variant)
    variant["render"] = {"revision": 2}
    write_json(work / "renders" / "r2" / "result.json", {"publishable": False, "sample": EN})
    with pytest.raises(LibraryError, match="did not pass"):
        asyncio.run(library._prepare_samples([variant]))
    write_json(work / "renders" / "r2" / "result.json", {"publishable": True, "sample": HE})
    # The author's German sample, not published yet, goes with the file: the report says so.
    others = asyncio.run(library._prepare_samples([variant]))
    assert others == ["templates/catalog.json: samples.mifgash.de"]
    catalog = media / "templates" / "catalog.json"
    written = json.loads(catalog.read_text(encoding="utf-8"))
    assert list(written["samples"]["mifgash"]) == ["he", "en", "ar", "de"]
    assert written["samples"]["mifgash"]["ar"] == HE and written["samples"]["mifgash"]["de"] == EN
    # Cancelling puts the author copy back as it was.
    library._revert()
    assert "ar" not in json.loads(catalog.read_text(encoding="utf-8"))["samples"]["mifgash"]


def test_findings_the_source_slide_has_are_told_apart():
    result = {
        "lang": "de",
        "issues": [],
        "slides": [
            {
                "index": 2,
                "name": "In Zahlen",
                "layout": "l_big",
                "issues": [],
                "findings": [
                    {"rule": "L01", "severity": "error", "message": "Text overflows."},
                    {"rule": "L09", "severity": "warning", "message": "Misaligned.", "baseline": True},
                    {"rule": "L13", "severity": "warning", "message": "Too many words.", "baseline": True},
                ],
            }
        ],
        "langs": {"de": {"findings": [], "issues": []}},
    }
    text = template_prompts.slide_findings(result)
    assert '- s03 "In Zahlen" (l_big) · error · L01: Text overflows.' in text
    assert "not this language's to fix: L09, L13" in text and "Misaligned" not in text


def test_the_catalogs_unpublished_work_is_listed_beside_ours():
    published = _catalog()
    local = _catalog()
    local["samples"]["mifgash"]["ar"] = HE
    local["samples"]["mifgash"]["ja"] = EN
    local["pictures"] = {"x": {"id": "1"}}
    ours = {("mifgash", "ar")}
    assert templates.catalog_changes(local, published, ours) == [
        "templates/catalog.json: pictures",
        "templates/catalog.json: samples.mifgash.ja",
    ]
    assert templates.catalog_changes(local, None, ours) == []
