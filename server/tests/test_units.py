"""Unit tests of the parts that need no CLI, browser or network."""

from __future__ import annotations

import asyncio
import json
import os
import re
import time
from pathlib import Path

import pytest
from PIL import Image
from pydantic import ValidationError

from slidr_manager import claude_cli, codex_cli, languages, prompts, template_prompts, templates
from slidr_manager.app import NewRequest
from slidr_manager.config import VENDOR, Settings
from slidr_manager.events import EventBus
from slidr_manager.instructions import Instructions
from slidr_manager.library import Library, LibraryError, design_tags, empty_catalog, merge_design, to_webp
from slidr_manager.pipeline import Studio, StudioError, has_errors, slugify, unique_id, watched
from slidr_manager.store import Store, write_json
from slidr_manager.templates import Templates

BASE = ["he", "en"]


# ---------------------------------------------------------------- Claude Code


def test_claude_command_line_names_tools_and_session():
    call = claude_cli.ClaudeCall(
        prompt="x",
        cwd=Path("."),
        system_prompt_file=Path("system.md"),
        tools=["Read", "Write"],
        session_id="abc",
        model="opus",
        json_schema={"type": "object"},
    )
    args = claude_cli.build_args("claude", call)
    assert args[:4] == ["claude", "-p", "--output-format", "stream-json"]
    assert "--restricted" in args and "--strict-mcp-config" in args
    assert args[args.index("--tools") + 1] == "Read,Write"
    assert args[args.index("--allowedTools") + 1 : args.index("--allowedTools") + 3] == ["Read", "Write"]
    assert args[args.index("--session-id") + 1] == "abc"
    assert "--resume" not in args
    assert json.loads(args[args.index("--json-schema") + 1]) == {"type": "object"}


def test_claude_resume_and_no_tools():
    call = claude_cli.ClaudeCall(prompt="x", cwd=Path("."), system_prompt_file=Path("s.md"), resume="abc")
    args = claude_cli.build_args("claude", call)
    assert args[args.index("--tools") + 1] == ""
    assert "--allowedTools" not in args
    assert args[args.index("--resume") + 1] == "abc"


def test_claude_transcript_reads_the_stream():
    seen: list[tuple[str, str]] = []
    transcript = claude_cli.Transcript(lambda kind, text: seen.append((kind, text)))
    lines = [
        {"type": "system", "subtype": "init", "session_id": "s1"},
        {"type": "assistant", "message": {"content": [
            {"type": "tool_use", "name": "Write", "input": {"file_path": "C:\\w\\he.html"}},
            {"type": "text", "text": "  Wrote both files. "},
        ]}},
        {"type": "assistant", "message": {"content": [{"type": "tool_use", "name": "StructuredOutput", "input": {}}]}},
        {"type": "result", "subtype": "success", "result": "done", "session_id": "s1", "structured_output": {"a": 1}},
    ]
    for line in lines:
        transcript.read(json.dumps(line))
    transcript.read("not json")
    assert transcript.session_id == "s1"
    assert transcript.result and transcript.result["structured_output"] == {"a": 1}
    assert seen == [("tool", "Write he.html"), ("text", "Wrote both files.")]


# ---------------------------------------------------------------- Codex


def test_codex_prompt_and_command_line_follow_the_app():
    prompt = codex_cli.generate_prompt("  a barn  ", "square")
    assert prompt.startswith("Use your image generation tool.")
    assert prompt.endswith("Create ONE square 1:1 image: a barn")
    args = codex_cli.build_args("codex", prompt, Path("ref.png"))
    assert args[1:9] == ["exec", "--json", "--skip-git-repo-check", "--ignore-user-config",
                         "--ignore-rules", "--ephemeral", "-s", "read-only"]
    # The prompt comes before -i, which would take what follows it as files.
    assert args.index(prompt) < args.index("-i")


def test_codex_transcript_and_failures():
    transcript = codex_cli.Transcript()
    for line in [
        {"type": "thread.started", "thread_id": "01a0-ff"},
        {"type": "item.completed", "item": {"type": "agent_message", "text": "C:\\x\\exec-1.png"}},
        {"type": "turn.completed"},
    ]:
        transcript.read(json.dumps(line))
    assert transcript.thread_id == "01a0-ff" and transcript.completed
    bad = codex_cli.Transcript()
    bad.read(json.dumps({"type": "thread.started", "thread_id": "../../etc"}))
    assert bad.thread_id is None
    assert codex_cli.classify("401 Unauthorized") == "not_logged_in"
    assert codex_cli.classify("You've hit your usage limit") == "quota"
    assert codex_cli.classify("something else") == "generation_failed"


def test_codex_pick_prefers_the_named_file(tmp_path: Path):
    older, newer = tmp_path / "exec-1.png", tmp_path / "exec-2.png"
    older.write_bytes(b"1")
    newer.write_bytes(b"2")
    past = time.time() - 100
    os.utime(older, (past, past))
    assert codex_cli.pick([older, newer], None) == newer
    assert codex_cli.pick([older, newer], f"saved {older}") == older
    assert codex_cli.pick([], "x") is None


# ---------------------------------------------------------------- the catalog


def design(did: str, group: str, name: str = "N") -> dict:
    return {
        "id": did,
        "name": {"he": name, "en": name},
        "group": group,
        "groupName": {"he": group, "en": group},
        "slides": {"he": {"id": "a"}, "en": {"id": "b"}},
        "subject": [1, 2],
        "size": [3, 4],
    }


def test_merge_adds_replaces_and_moves_between_groups():
    catalog = empty_catalog()
    merge_design(catalog, design("m-a", "invites"))
    merge_design(catalog, design("m-b", "invites"))
    merge_design(catalog, design("m-c", "sales"))
    assert catalog["groups"] == ["invites", "sales"]
    assert catalog["groupIds"] == {"invites": ["m-a", "m-b"], "sales": ["m-c"]}
    # Replaced in place, names and all.
    merge_design(catalog, design("m-a", "invites", "New"))
    assert catalog["groupIds"]["invites"] == ["m-a", "m-b"]
    assert catalog["names"]["m-a"] == {"he": "New", "en": "New"}
    # A design has one group; a group left empty goes.
    merge_design(catalog, design("m-c", "invites"))
    assert catalog["groups"] == ["invites"]
    assert catalog["groupIds"] == {"invites": ["m-a", "m-b", "m-c"]}
    assert "sales" not in catalog["groupNames"]
    assert catalog["sizes"]["m-c"] == [3, 4] and catalog["subjects"]["m-c"] == [1, 2]


def test_merge_keeps_the_names_a_group_was_published_with():
    catalog = empty_catalog()
    first = design("m-a", "invites")
    first["groupName"] = {"he": "הזמנות", "en": "Invitations"}
    merge_design(catalog, first)
    second = design("m-b", "invites")
    second["groupName"] = {"he": "אחר", "en": "Other"}
    merge_design(catalog, second)
    assert catalog["groupNames"]["invites"] == {"he": "הזמנות", "en": "Invitations"}


def test_merge_writes_the_tags_of_a_design_and_drops_them_when_it_has_none():
    catalog = empty_catalog()
    tagged = design("m-a", "invites")
    tagged["tags"] = {"he": ["יום הולדת"], "en": ["birthday"]}
    merge_design(catalog, tagged)
    assert catalog["tags"] == {"m-a": {"he": ["יום הולדת"], "en": ["birthday"]}}
    merge_design(catalog, design("m-a", "invites"))
    assert catalog["tags"] == {}
    # A catalog published before there were tags gets the key.
    old = empty_catalog()
    del old["tags"]
    assert "tags" in merge_design(old, design("m-b", "invites"))


def test_webp_keeps_the_size(tmp_path: Path):
    png = tmp_path / "subject.png"
    Image.new("RGB", (64, 36), (10, 20, 30)).save(png)
    data, size = to_webp(png)
    assert data[:4] == b"RIFF" and data[8:12] == b"WEBP"
    assert size == (64, 36)


# ---------------------------------------------------------------- ids and prompts


def test_ids_are_slugs_with_the_managed_prefix_and_unique():
    assert slugify("Garden Wedding!! 2") == "garden-wedding-2"
    taken = {"m-garden"}
    assert unique_id("garden", taken) == "m-garden-2"
    assert unique_id("garden", taken) == "m-garden-3"
    assert "m-garden-3" in taken


def test_findings_reach_the_review_prompt():
    result = {
        "publishable": False,
        "issues": ["No point of the picture lies on top."],
        "langs": {
            "he": {"issues": [], "findings": [{"severity": "error", "rule": "L01", "message": "overflow"}],
                   "editability": 1, "notes": []},
            "en": {"issues": ["Only 2 blocks"], "findings": [], "editability": 0.5, "notes": ["kept html"]},
        },
    }
    text = prompts.review_prompt(result, 1, 2, "renders/r3", BASE)
    assert "renders/r3/he-thumb.png" in text
    assert "- both · contract: No point" in text
    assert "- he · error · L01: overflow" in text
    assert "- en · contract: Only 2 blocks" in text
    assert "en 50% editable (notes: kept html)" in text
    assert "all four pictures" in text and "keep them mirrored" in text
    assert has_errors(result)
    assert not has_errors({"publishable": True, "langs": {"he": {"findings": [{"severity": "warning"}]}}})


def test_findings_and_renders_of_every_chosen_language_reach_the_prompts():
    langs = ["he", "en", "ar", "ja"]
    result = {
        "publishable": False,
        "issues": ["No point of the picture lies on top."],
        "langs": {
            "he": {"issues": [], "findings": [], "editability": 1},
            "en": {"issues": [], "findings": [], "editability": 1},
            "ar": {"issues": [], "findings": [{"severity": "error", "rule": "L02", "message": "clipped"}],
                   "editability": 0.9},
            "ja": {"error": "no slide", "issues": ["No text names a font"], "findings": []},
        },
    }
    review = prompts.review_prompt(result, 2, 2, "renders/r4", langs)
    for lang in langs:
        assert f"renders/r4/{lang}-full.png" in review and f"renders/r4/{lang}-thumb.png" in review
    assert "de-full.png" not in review
    assert "all eight pictures" in review
    assert "- all · contract: No point" in review
    assert "- ar · error · L02: clipped" in review
    assert "- ja · conversion failed: no slide" in review and "- ja · contract: No text names a font" in review
    assert "ar 90% editable" in review
    assert "`he.html`, `en.html`, `ar.html` and `ja.html`" in review
    assert "every right-to-left file its mirror" in review
    fix = prompts.fix_prompt(result, "renders/r4", langs)
    assert "`renders/r4/ja-full.png`" in fix and "`ja.html`" in fix and "- ar · error" in fix
    feedback = prompts.feedback_prompt("Make the title bigger", langs)
    assert "`ar.html` and `ja.html`" in feedback
    assert "mirrored, the Hebrew still natural Hebrew" in prompts.feedback_prompt("x", BASE)


FONTS = [
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
]
APP = {"design": "## Design guidelines\nDG", "html": "## Writing a slide as HTML\nHC"}


def test_system_prompt_carries_the_apps_instructions():
    fonts = [{"family": "Heebo", "scripts": ["he", "latin"]}, {"family": "Inter", "scripts": ["latin"]}]
    text = prompts.system_prompt(APP, "QUALITY", fonts, BASE, with_html=True)
    # A catalog that does not say what a family is made for lists a family's own letters first.
    for part in ("QUALITY", "DG", "HC", "data-asset=\"__subject__\"", "Hebrew (`he.html`): Heebo",
                 "Latin (`en.html`): Inter"):
        assert part in text
    plan = prompts.system_prompt(APP, "QUALITY", fonts, BASE, with_html=False)
    assert "HC" not in plan and "## This folder" not in plan


@pytest.mark.parametrize("langs", [BASE, ["he", "en", "ar", "pt-BR", "ja", "zh-CN"]])
def test_prompts_name_exactly_the_files_of_the_chosen_languages(langs: list[str]):
    system = prompts.system_prompt(APP, "QUALITY", FONTS, langs, with_html=True)
    build = prompts.build_prompt({"id": "m-x"}, (1536, 1024), langs)
    for lang in languages.CONTENT_LANGUAGES:
        for text in (system, build):
            assert (f"`{lang}.html`" in text) == (lang in langs), lang
    if langs == BASE:
        assert "This request is made in Hebrew and English only" in system
        assert "in Hebrew and English, so it must be finished work" in system
    else:
        assert "made in Hebrew, English, Arabic, Brazilian Portuguese, Japanese and Simplified Chinese, and in no other language" in system
        assert '`ar.html`: Arabic, `dir="rtl" lang="ar"`' in system
        assert '`zh-CN.html`: Simplified Chinese, `dir="ltr" lang="zh-CN"`' in system
        # Left to right in the English composition, right to left its mirror.
        assert "Every right-to-left file (`he.html` and `ar.html`) is its mirror" in system
        assert "Brazilian Portuguese runs longer than English" in system
        assert "Japanese and Simplified Chinese may break a line" in system


def test_fonts_by_the_letters_of_the_chosen_languages():
    text = prompts.system_prompt(APP, "Q", FONTS, ["he", "en", "ar", "ru", "hi", "ja", "ko"], with_html=True)
    # A family of a language is made for its letters, or for Latin ones and has its letters.
    assert "- Hebrew (`he.html`): Heebo, Rubik" in text
    assert "- Latin (`en.html`): Rubik, Inter, Playfair Display, Poppins" in text
    assert "- Arabic (`ar.html`): Rubik, Cairo" in text
    assert "- Cyrillic (`ru.html`): Rubik, Inter, Playfair Display" in text
    assert "- Devanagari (`hi.html`): Poppins" in text
    assert "- Japanese (`ja.html`): Noto Sans JP" in text
    # The families the English file may use, by their counterparts in each language.
    assert "- In `ar.html`: Heebo → Cairo, Inter → Cairo, Playfair Display → Amiri" in text
    assert "- In `he.html`: Inter → Heebo, Playfair Display → Frank Ruhl Libre" in text
    assert "- In `hi.html`: Inter → Poppins, Playfair Display → Poppins" in text
    assert "Never one family for every text of a file" in text
    assert "- Korean (`ko.html`): none" in text
    assert "No family of the library has Korean letters. In `ko.html`" in text
    assert "Malgun Gothic for Korean" in text and "Yu Gothic" not in text
    # A family of the library, then the generic family the app's runs end in: nothing else.
    assert "`font-family: 'Inter', sans-serif`" in text and "Name no system font" in text
    assert "Nirmala UI" not in text
    # A catalog tagged with Hebrew and Latin only: the others take the system's letters.
    old = [{"family": "Heebo", "scripts": ["he", "latin"]}, {"family": "Inter", "scripts": ["latin"]}]
    text = prompts.system_prompt(APP, "Q", old, ["he", "en", "ru", "hi"], with_html=True)
    assert "No family of the library has Russian or Hindi letters. In `ru.html` and `hi.html`" in text
    assert "Nirmala UI for Hindi" in text
    # The default names no other script.
    text = prompts.system_prompt(APP, "Q", FONTS, BASE, with_html=True)
    assert "Cyrillic" not in text and "No family of the library has" not in text


@pytest.mark.parametrize("count", [1, 3])
def test_plan_prompt(count: int):
    text = prompts.plan_prompt("an invitation", count, [{"id": "invites", "he": "הזמנות", "en": "Invites"}],
                               ["m-x"], None, BASE)
    assert "an invitation" in text and "`invites`: הזמנות / Invites" in text and "m-x" in text
    assert ("Plan one design." in text) == (count == 1)
    assert "Each design is made in Hebrew and English, and in no other language." in text
    assert "under its code (`he` and `en`)" in text


def test_plan_asks_for_copy_in_every_chosen_language_and_names_in_two():
    langs = ["he", "en", "de", "ko"]
    text = prompts.plan_prompt("a sale", 2, [], [], None, langs)
    assert "Each design is made in Hebrew, English, German and Korean, and in no other language." in text
    assert "under its code (`he`, `en`, `de` and `ko`)" in text
    item = prompts.plan_schema(langs)["properties"]["concepts"]["items"]["properties"]
    assert item["copy"]["required"] == langs and sorted(item["copy"]["properties"]) == sorted(langs)
    assert item["name"]["required"] == BASE and item["groupName"]["required"] == BASE
    assert prompts.plan_schema(BASE)["properties"]["concepts"]["items"]["properties"]["copy"]["required"] == BASE


def test_plan_asks_for_the_search_tags_in_hebrew_and_english():
    concept = prompts.plan_schema(["he", "en", "de"])["properties"]["concepts"]["items"]
    assert "tags" in concept["required"]
    assert concept["properties"]["tags"]["required"] == BASE
    assert "`tags`: the words people type into the gallery's search" in prompts.plan_prompt(
        "a party", 1, [], [], None, BASE
    )


def test_tags_are_kept_clean_and_in_their_own_letters():
    tags = design_tags(
        {
            "he": ["יוֹם הולדת", "יום הולדת", "birthday", "מסיבה", " עוגה ", 7],
            "en": ["Birthday", "kids  party", "מסיבה", "cake", "x" * 41],
        }
    )
    assert tags == {"he": ["יום הולדת", "מסיבה", "עוגה"], "en": ["birthday", "kids party", "cake"]}
    assert design_tags({"he": ["א", "ב"], "en": ["a", "b", "c"]}) is None
    assert design_tags(None) is None and design_tags({"he": "יום"}) is None


# ---------------------------------------------------------------- languages


def _ts_block(text: str, start: str) -> str:
    """The text of a constant of a TypeScript file, from its name to the end of its value."""
    at = text.index(start)
    ends = [text.find(end, at) for end in ("] as const", "};")]
    return text[at : min(end for end in ends if end >= 0)]


def test_the_language_list_is_the_models():
    source = (VENDOR / "packages" / "model" / "src" / "languages.ts").read_text(encoding="utf-8")
    codes = re.findall(r"'([\w-]+)'", _ts_block(source, "export const CONTENT_LANGUAGES"))
    assert tuple(codes) == languages.CONTENT_LANGUAGES
    base = re.findall(r"'([\w-]+)'", _ts_block(source, "export const BASE_LANGUAGES"))
    assert tuple(base) == languages.BASE_LANGUAGES
    names = dict(re.findall(r"'?([\w-]+)'?: \{ native: '[^']*', english: '([^']*)' \}",
                            _ts_block(source, "export const LANGUAGE_NAMES")))
    assert names == languages.NAMES
    scripts = dict(re.findall(r"'?([\w-]+)'?: '(\w+)'", _ts_block(source, "export const LANGUAGE_SCRIPT")))
    assert scripts == languages.SCRIPT
    # The right-to-left ones, as the model's `languageDir` says (`isRtlLanguage`).
    factories = (VENDOR / "packages" / "model" / "src" / "factories.ts").read_text(encoding="utf-8")
    rtl = set(re.findall(r"'(\w+)'", re.search(r"const RTL = new Set\(\[([^\]]*)\]\)", factories).group(1)))
    assert {code for code in codes if code.split("-")[0].lower() in rtl} == languages.RTL
    assert [languages.direction(code) for code in ("he", "ar", "en", "zh-CN")] == ["rtl", "rtl", "ltr", "ltr"]


def test_a_request_is_made_in_hebrew_and_english_unless_more_are_chosen():
    assert NewRequest(prompt="an invitation").languages == BASE
    assert NewRequest(prompt="an invitation", languages=[]).languages == BASE
    # Hebrew and English always; each language once, in the registry's order, in its own case.
    chosen = NewRequest(prompt="an invitation", languages=["ja", "ar", "JA", "pt-br", "en"])
    assert chosen.languages == ["he", "en", "ar", "pt-BR", "ja"]
    # A code the registry does not know is refused, not dropped.
    with pytest.raises(ValidationError, match="Unknown language xx"):
        NewRequest(prompt="an invitation", languages=["de", "xx"])
    with pytest.raises(ValidationError):
        NewRequest(prompt="an invitation", languages=["zh-TW"])
    # What was stored is read leniently; nothing stored is Hebrew and English.
    assert languages.chosen(None, None) == BASE
    assert languages.chosen(None, ["ko", "xx"]) == ["he", "en", "ko"]
    assert languages.chosen(["de"], ["ko"]) == ["he", "en", "de"]


# ---------------------------------------------------------------- variants in more languages


def _studio(tmp_path: Path, media: Path | None = None) -> tuple[Studio, Store, Library]:
    settings = Settings(data=tmp_path)
    if media is not None:
        settings.media_dir = media
    bus = EventBus()
    store = Store(settings.requests_dir, bus)
    templates = Templates(settings)
    library = Library(settings, store, bus, templates)
    return Studio(settings, store, Instructions(settings), library, templates), store, library


BRIEF = {"id": "m-x", "name": {"he": "שם", "en": "Name"}, "group": "g", "groupName": {"he": "ק", "en": "G"}}


def test_a_variant_is_rendered_in_the_languages_of_its_request(tmp_path: Path):
    studio, store, _ = _studio(tmp_path)
    request = store.create_request({"prompt": "x", "languages": ["he", "en", "ar", "ja"]})
    variant = store.create_variant(request, 0, dict(BRIEF))
    assert variant["languages"] == ["he", "en", "ar", "ja"]
    work = store.work_dir(variant)
    work.mkdir(parents=True)
    Image.new("RGB", (32, 18)).save(work / "subject.png")
    for lang in ("he", "en", "ar"):
        (work / f"{lang}.html").write_text(f"<div lang='{lang}'></div>", encoding="utf-8")
    with pytest.raises(StudioError, match=r"ja\.html"):
        studio.render_input(variant["id"])
    (work / "ja.html").write_text("<div lang='ja'>日本語</div>", encoding="utf-8")
    data = studio.render_input(variant["id"])
    assert data["languages"] == ["he", "en", "ar", "ja"]
    assert list(data["html"]) == ["he", "en", "ar", "ja"] and "日本語" in data["html"]["ja"]
    assert watched(variant, data["languages"]) == ["he.html", "en.html", "ar.html", "ja.html", "brief.json"]


def test_a_variant_from_before_the_choice_is_hebrew_and_english(tmp_path: Path):
    studio, store, _ = _studio(tmp_path)
    request = store.create_request({"prompt": "x"})
    variant = store.create_variant(request, 0, dict(BRIEF))
    variant.pop("languages")
    work = store.work_dir(variant)
    work.mkdir(parents=True)
    Image.new("RGB", (32, 18)).save(work / "subject.png")
    for lang in BASE:
        (work / f"{lang}.html").write_text("<div></div>", encoding="utf-8")
    assert studio.languages_of(variant) == BASE
    assert list(studio.render_input(variant["id"])["html"]) == BASE


def test_a_design_is_published_with_a_slide_for_every_language(tmp_path: Path):
    _, store, library = _studio(tmp_path)
    request = store.create_request({"prompt": "x", "languages": ["he", "en", "ar", "zh-CN"]})
    variant = store.create_variant(request, 0, dict(BRIEF))
    work = store.work_dir(variant)
    work.mkdir(parents=True)
    Image.new("RGB", (64, 36), (10, 20, 30)).save(work / "subject.png")
    variant["render"] = {"revision": 1}
    sides = {lang: {"slide": {"id": lang}, "issues": [], "findings": []} for lang in ("zh-CN", "en", "ar", "he")}
    write_json(work / "renders" / "r1" / "result.json", {"publishable": True, "langs": sides, "subject": [5, 6]})
    record, webp = library._design_record(variant)
    assert list(record["slides"]) == ["he", "en", "ar", "zh-CN"]
    assert record["slides"]["zh-CN"] == {"id": "zh-CN"}
    assert record["name"] == {"he": "שם", "en": "Name"} and record["groupName"] == {"he": "ק", "en": "G"}
    assert record["size"] == [64, 36] and webp[:4] == b"RIFF"
    catalog = merge_design(empty_catalog(), record)
    assert set(catalog["slides"]["m-x"]) == {"he", "en", "ar", "zh-CN"}
    assert catalog["names"]["m-x"] == {"he": "שם", "en": "Name"}
    # A brief from before there were tags publishes none; one with them, its tags.
    assert "tags" not in record and catalog["tags"] == {}
    variant["brief"]["tags"] = {"he": ["הזמנה", "מסיבה", "אירוע"], "en": ["Invitation", "party", "event"]}
    record, _ = library._design_record(variant)
    assert record["tags"] == {"he": ["הזמנה", "מסיבה", "אירוע"], "en": ["invitation", "party", "event"]}
    # Without the English slide it is not published.
    del sides["en"]
    write_json(work / "renders" / "r1" / "result.json", {"publishable": True, "langs": sides, "subject": [5, 6]})
    with pytest.raises(LibraryError):
        library._design_record(variant)
