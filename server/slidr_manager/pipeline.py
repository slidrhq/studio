"""The work of a request: a design request plans concepts and makes each one a design; a
template request writes the sample deck of a built-in template in languages, a variant each.

```text
design request ──plan (Claude, structured)──► N concepts ──► one variant each, side by side:
  variant: picture (Codex) ─► HTML in each language of the request (Claude, looking at it)
           ─► render + design check (headless, the app's engine) ─► review rounds (Claude looks
           at the renders and fixes) ─► ready: the person approves, or asks for a change

template request ──► one variant for each language, side by side:
  variant: the template, its digest and its English and Hebrew samples ─► <lang>.json (Claude)
           ─► build with the app's engine, render every slide, design check ─► review rounds
           ─► ready: the person approves, or asks for a change

a request in words (kind "auto") ──route (Claude, structured)──► a design or a template request
```

Each variant keeps one Claude conversation, so a review or a change asked for later is a turn
of the same session, with everything it saw before.

A design request names its languages (`languages.py`): Hebrew and English always, and the others
the person chose. Every concept of it is planned, written, rendered, reviewed and published in
exactly those, one HTML file per language; a request without a choice is Hebrew and English. A
template request names the languages its sample is to be written in (`templates.py`).
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import re
import uuid
from collections.abc import Coroutine
from pathlib import Path
from typing import Any

from PIL import Image

from . import claude_cli, codex_cli, languages, prompts, template_prompts
from .config import Settings
from .instructions import Instructions, quality_bar
from .library import Library
from .render import forget_old, render_dir, snap
from .store import RUNNING, Store, read_json, write_json
from .templates import Templates, sample_file, template_brief

TOOLS = ["Read", "Write", "Edit", "Glob"]
ASPECTS = set(codex_cli.SHAPES)
SLUG = re.compile(r"[^a-z0-9]+")


class StudioError(Exception):
    pass


def slugify(text: str) -> str:
    return SLUG.sub("-", text.lower()).strip("-")[:40] or "design"


def unique_id(slug: str, taken: set[str]) -> str:
    base = f"m-{slugify(slug)}"
    candidate, n = base, 2
    while candidate in taken:
        candidate = f"{base}-{n}"
        n += 1
    taken.add(candidate)
    return candidate


def outputs(variant: dict, langs: list[str]) -> list[str]:
    """The files Claude must write: a design's HTML file for each language, or a template's
    sample in the variant's language."""
    if variant.get("kind") == "template":
        return [sample_file(variant["lang"])]
    return [languages.file_of(lang) for lang in langs]


def watched(variant: dict, langs: list[str]) -> list[str]:
    """The files Claude writes: its outputs, and a design's brief."""
    return outputs(variant, langs) + ([] if variant.get("kind") == "template" else ["brief.json"])


def missing_files(work: Path, variant: dict, langs: list[str]) -> list[str]:
    """The outputs that are not written yet."""
    return [name for name in outputs(variant, langs) if not (work / name).exists()]


def fingerprint(work: Path, variant: dict, langs: list[str]) -> dict[str, str | None]:
    return {
        name: hashlib.sha256((work / name).read_bytes()).hexdigest() if (work / name).exists() else None
        for name in watched(variant, langs)
    }


def picture_size(path: Path) -> tuple[int, int]:
    with Image.open(path) as image:
        return image.size


def has_errors(result: dict) -> bool:
    if not result.get("publishable"):
        return True
    return any(
        f.get("severity") == "error"
        for side in (result.get("langs") or {}).values()
        for f in side.get("findings") or []
    )


class Studio:
    def __init__(
        self,
        settings: Settings,
        store: Store,
        instructions: Instructions,
        library: Library,
        templates: Templates,
    ) -> None:
        self.settings = settings
        self.store = store
        self.instructions = instructions
        self.library = library
        self.templates = templates
        self.claude_slots = asyncio.Semaphore(settings.max_claude)
        self.codex_slots = asyncio.Semaphore(settings.max_codex)
        self.render_slots = asyncio.Semaphore(settings.max_render)
        self.tasks: dict[str, asyncio.Task] = {}

    # ------------------------------------------------------------------ tasks

    def _spawn(self, key: str, work: Coroutine[Any, Any, None]) -> None:
        if key in self.tasks and not self.tasks[key].done():
            work.close()
            raise StudioError("This is already running.")
        task = asyncio.create_task(work)
        self.tasks[key] = task
        task.add_done_callback(lambda _t: self.tasks.pop(key, None) if self.tasks.get(key) is _t else None)

    def cancel(self, key: str) -> bool:
        task = self.tasks.get(key)
        if task and not task.done():
            task.cancel()
            return True
        return False

    def busy(self, key: str) -> bool:
        task = self.tasks.get(key)
        return bool(task and not task.done())

    # ------------------------------------------------------------------ prompts

    async def _system_files(self, folder: Path, langs: list[str]) -> tuple[Path, Path]:
        app = await self.instructions.app()
        fonts = await self.instructions.fonts()
        quality = quality_bar()
        folder.mkdir(parents=True, exist_ok=True)
        plan = folder / "system-plan.md"
        design = folder / "system-design.md"
        plan.write_text(prompts.system_prompt(app, quality, fonts, langs, with_html=False), encoding="utf-8")
        design.write_text(prompts.system_prompt(app, quality, fonts, langs, with_html=True), encoding="utf-8")
        return plan, design

    # ------------------------------------------------------------------ requests

    def start_request(self, data: dict) -> dict:
        request = self.store.create_request(data)
        self._spawn(request["id"], self._begin(request, int(data.get("count") or 1)))
        return request

    def more(self, rid: str, count: int) -> dict:
        request = self.store.requests.get(rid)
        if not request:
            raise StudioError("No such request.")
        if request.get("kind") == "template":
            raise StudioError(
                "A template request has a variant for each of its languages; there are no more concepts to plan."
            )
        if self.busy(rid):
            raise StudioError("Concepts are being planned for this request already.")
        request["status"] = "planning"
        request["error"] = None
        self.store.save_request(request)
        self._spawn(rid, self._plan(request, count))
        return request

    async def _begin(self, request: dict, count: int) -> None:
        """Reads a request in words when its kind was not given, then starts its work."""
        if request.get("kind") == "auto":
            try:
                await self._route(request)
            except asyncio.CancelledError:
                request["status"] = "cancelled"
                self.store.save_request(request)
                raise
            except Exception as error:  # noqa: BLE001
                request["status"] = "failed"
                request["error"] = str(error)
                self.store.save_request(request)
                return
        if request.get("kind") == "template":
            await self._plan_template(request)
        else:
            await self._plan(request, count)

    async def template_listing(self) -> list[dict]:
        words = (await self.instructions.app()).get("templates") or {}
        return await self.templates.listing(words)

    async def _route(self, request: dict) -> None:
        """Asks Claude which kind of work a request in words is, and gives the request that
        kind and what it needs: a template and its languages, or nothing more for a design."""
        listing = await self.template_listing()
        folder = self.store.request_dir(request["id"]) / "plan"
        folder.mkdir(parents=True, exist_ok=True)
        system = folder / "system-route.md"
        system.write_text(template_prompts.ROUTE_SYSTEM, encoding="utf-8")
        async with self.claude_slots:
            result = await claude_cli.run(
                claude_cli.ClaudeCall(
                    prompt=template_prompts.route_prompt(request["prompt"], listing),
                    cwd=folder,
                    system_prompt_file=system,
                    tools=[],
                    session_id=str(uuid.uuid4()),
                    model=request.get("model") or None,
                    effort=request.get("effort") or None,
                    json_schema=template_prompts.route_schema(),
                    timeout=10 * 60,
                )
            )
        request["cost"] = round(request.get("cost", 0) + result.cost, 4)
        answer = result.structured if isinstance(result.structured, dict) else {}
        kind = answer.get("kind")
        reason = str(answer.get("reason") or "").strip()
        request["route"] = {"kind": kind, "reason": reason}
        if kind == "template":
            entry = next((t for t in listing if t["id"] == answer.get("templateId")), None)
            if entry is None:
                raise StudioError(
                    f"The request was read as a template, but not one of the library's: {answer.get('templateId')!r}."
                )
            wanted = [code for code in answer.get("languages") or [] if code in languages.CONTENT_LANGUAGES]
            if not wanted:
                raise StudioError("The request was read as a template, with no language to write its sample in.")
            request["kind"] = "template"
            request["templateId"] = entry["id"]
            request["languages"] = languages.known(wanted)
            request["instructions"] = str(answer.get("instructions") or "").strip()
            title = str(answer.get("title") or "").strip()
            if title:
                request["title"] = title[:60]
        elif kind == "design":
            request["kind"] = "design"
            request["languages"] = languages.chosen(request.get("languages"))
        else:
            raise StudioError(reason or "The studio cannot make what this request asks for.")
        self.store.save_request(request)

    async def _plan_template(self, request: dict) -> None:
        """A variant for each language of a template request that has none yet."""
        store = self.store
        try:
            listing = await self.template_listing()
            entry = next((t for t in listing if t["id"] == request.get("templateId")), None)
            if entry is None:
                raise StudioError(f"The library has no template {request.get('templateId')!r}.")
            langs = languages.known(request.get("languages") or [])
            if not langs:
                raise StudioError("Name at least one language to write the sample in.")
            has = {
                v.get("lang")
                for v in (store.variants.get(vid) for vid in request["variantIds"])
                if v and not v.get("discarded")
            }
            for lang in langs:
                if lang in has:
                    continue
                brief = template_brief(entry, entry["name"], lang, request.get("instructions") or "")
                variant = store.create_variant(
                    request,
                    len(request["variantIds"]),
                    brief,
                    kind="template",
                    templateId=entry["id"],
                    lang=lang,
                    languages=[lang],
                )
                self._spawn(variant["id"], self._make(variant))
            request["status"] = "ready"
            store.save_request(request)
        except asyncio.CancelledError:
            request["status"] = "cancelled"
            store.save_request(request)
            raise
        except Exception as error:  # noqa: BLE001
            request["status"] = "failed"
            request["error"] = str(error)
            store.save_request(request)

    async def _plan(self, request: dict, count: int) -> None:
        store = self.store
        try:
            known = await self.library.known()
            taken = set(known["ids"]) | store.all_design_ids()
            plan_dir = store.request_dir(request["id"]) / "plan"
            langs = languages.chosen(request.get("languages"))
            system_plan, _ = await self._system_files(plan_dir, langs)
            made = [
                f"{v['brief']['name']['en']}: {v['brief'].get('concept', '')}"
                for v in (store.variants.get(vid) for vid in request["variantIds"])
                if v
            ]
            prompt = prompts.plan_prompt(
                request["prompt"], count, known["groups"], sorted(taken), request.get("group") or None, langs
            )
            if made:
                prompt += (
                    "\n\nThis request already has these designs; the new ones must differ from "
                    "each of them:\n" + "\n".join(f"- {m}" for m in made)
                )
            async with self.claude_slots:
                result = await claude_cli.run(
                    claude_cli.ClaudeCall(
                        prompt=prompt,
                        cwd=plan_dir,
                        system_prompt_file=system_plan,
                        tools=[],
                        session_id=str(uuid.uuid4()),
                        model=request.get("model") or None,
                        effort=request.get("effort") or None,
                        json_schema=prompts.plan_schema(langs),
                        timeout=20 * 60,
                    )
                )
            concepts = (result.structured or {}).get("concepts") if isinstance(result.structured, dict) else None
            if not concepts:
                raise StudioError("The plan came back without concepts.")
            request["cost"] = round(request.get("cost", 0) + result.cost, 4)
            request["plan"] = (request.get("plan") or []) + concepts[:count]
            request["status"] = "ready"
            store.save_request(request)
            for concept in concepts[:count]:
                brief = self._brief(concept, taken, request.get("group") or None)
                variant = store.create_variant(request, len(request["variantIds"]), brief)
                self._spawn(variant["id"], self._make(variant))
        except asyncio.CancelledError:
            request["status"] = "cancelled"
            store.save_request(request)
            raise
        except Exception as error:  # noqa: BLE001
            request["status"] = "failed"
            request["error"] = str(error)
            store.save_request(request)

    @staticmethod
    def _brief(concept: dict, taken: set[str], group: str | None) -> dict:
        image = concept.get("image") or {}
        return {
            "id": unique_id(concept.get("slug") or concept["name"]["en"], taken),
            "name": concept["name"],
            "group": slugify(group or concept.get("group") or "designs"),
            "groupName": concept.get("groupName") or {},
            "concept": concept.get("concept", ""),
            "art": concept.get("art", ""),
            "copy": concept.get("copy", {}),
            "image": {
                "prompt": image.get("prompt", ""),
                "aspect": image.get("aspect") if image.get("aspect") in ASPECTS else "wide",
            },
        }

    def delete_request(self, rid: str) -> None:
        request = self.store.requests.get(rid)
        if not request:
            return
        self.cancel(rid)
        for vid in request["variantIds"]:
            self.cancel(vid)
        self.store.delete_request(rid)

    # ------------------------------------------------------------------ variants

    def _variant(self, vid: str) -> dict:
        variant = self.store.variants.get(vid)
        if not variant:
            raise StudioError("No such variant.")
        return variant

    def _set(self, variant: dict, status: str, stage: str | None = None) -> None:
        variant["status"] = status
        variant["stage"] = stage
        if status not in ("failed",):
            variant["error"] = None
        self.store.save_variant(variant)

    def _options(self, variant: dict) -> dict:
        return self.store.requests.get(variant["requestId"]) or {}

    def languages_of(self, variant: dict) -> list[str]:
        """The languages a variant is made in: a template variant's one language; a design's
        own, else its request's, else Hebrew and English (a variant from before there was a
        choice)."""
        if variant.get("kind") == "template":
            return [variant["lang"]]
        return languages.chosen(variant.get("languages"), self._options(variant).get("languages"))

    async def _guard(self, variant: dict, work: Coroutine[Any, Any, None]) -> None:
        try:
            await work
            self._set(variant, "ready")
        except asyncio.CancelledError:
            self.store.log(variant, "error", "Stopped.", save=False)
            self._set(variant, "cancelled")
            raise
        except Exception as error:  # noqa: BLE001
            variant["error"] = str(error)
            self.store.log(variant, "error", str(error), save=False)
            self._set(variant, "failed")

    async def _make(self, variant: dict) -> None:
        if variant.get("kind") == "template":
            await self._guard(variant, self._make_template_steps(variant))
        else:
            await self._guard(variant, self._make_steps(variant))

    async def _make_template_steps(self, variant: dict) -> None:
        """A template's sample in one language: written, rendered, reviewed, and mended when it
        breaks the sample's contract."""
        work = self.store.work_dir(variant)
        lang = variant["lang"]
        if not (work / "template.json").exists():
            await self.templates.prepare_work(work, variant["brief"])
        if not (variant.get("sessionId") and not missing_files(work, variant, [lang])):
            variant["sessionId"] = None
            await self._turn(variant, "writing", template_prompts.build_prompt(variant["brief"]))
        result = await self._render(variant)
        rounds = int(self._options(variant).get("reviewRounds", 2))
        while variant["reviews"] < rounds:
            variant["reviews"] += 1
            changed = await self._turn(
                variant,
                "reviewing",
                template_prompts.review_prompt(result, variant["reviews"], rounds, self._renders(variant), lang),
            )
            if not changed:
                self.store.log(variant, "info", "Claude reviewed the renders and changed nothing.")
                break
            result = await self._render(variant)
        # As for a design: a sample that breaks its contract gets one turn to mend it, whatever
        # number of review rounds was asked for.
        if not result.get("publishable"):
            self.store.log(variant, "info", "The sample breaks its contract; Claude fixes it.")
            if await self._turn(variant, "reviewing", template_prompts.fix_prompt(result, self._renders(variant), lang)):
                await self._render(variant)

    async def _make_steps(self, variant: dict) -> None:
        work = self.store.work_dir(variant)
        work.mkdir(parents=True, exist_ok=True)
        if not (work / "brief.json").exists():
            write_json(work / "brief.json", variant["brief"])
        if not (work / "subject.png").exists():
            await self._image(variant)
        langs = self.languages_of(variant)
        if not (variant.get("sessionId") and not missing_files(work, variant, langs)):
            variant["sessionId"] = None
            await self._turn(
                variant,
                "writing",
                prompts.build_prompt(variant["brief"], picture_size(work / "subject.png"), langs),
            )
            await self._apply_brief(variant)
        result = await self._render(variant)
        rounds = int(self._options(variant).get("reviewRounds", 2))
        while variant["reviews"] < rounds:
            variant["reviews"] += 1
            changed = await self._turn(
                variant,
                "reviewing",
                prompts.review_prompt(result, variant["reviews"], rounds, self._renders(variant), langs),
            )
            if not changed:
                self.store.log(variant, "info", "Claude reviewed the renders and changed nothing.")
                break
            await self._apply_brief(variant)
            result = await self._render(variant)
        # The contract is not a matter of taste: a design that breaks it gets one turn to mend it,
        # whatever number of review rounds was asked for.
        if not result.get("publishable"):
            self.store.log(variant, "info", "The design breaks the gallery's contract; Claude fixes it.")
            if await self._turn(variant, "reviewing", prompts.fix_prompt(result, self._renders(variant), langs)):
                await self._apply_brief(variant)
                await self._render(variant)

    @staticmethod
    def _renders(variant: dict) -> str:
        """The latest render's folder, as Claude names it from its own folder."""
        return f"renders/r{variant['revision']}"

    async def _template_system_file(self, variant: dict) -> Path:
        """The system prompt of a template variant, for its template and language."""
        template = read_json(self.store.work_dir(variant) / "template.json")
        if not isinstance(template, dict):
            raise StudioError("The template this variant works on was not read; retry it.")
        fonts = await self.instructions.fonts()
        path = self.store.variant_dir(variant) / "system-template.md"
        path.write_text(
            template_prompts.system_prompt(template, quality_bar(), fonts, variant["lang"]), encoding="utf-8"
        )
        return path

    async def _turn(self, variant: dict, stage: str, prompt: str) -> bool:
        """One turn of the variant's Claude session. True when it changed a file."""
        work = self.store.work_dir(variant)
        langs = self.languages_of(variant)
        if variant.get("kind") == "template":
            system_design = await self._template_system_file(variant)
        else:
            _, system_design = await self._system_files(self.store.variant_dir(variant), langs)
        before = fingerprint(work, variant, langs)
        self._set(variant, stage, "waiting for Claude")
        async with self.claude_slots:
            self._set(variant, stage, None)
            first = not variant.get("sessionId")
            if first:
                variant["sessionId"] = str(uuid.uuid4())
            options = self._options(variant)

            def activity(kind: str, text: str) -> None:
                self.store.log(variant, kind, text)

            result = await claude_cli.run(
                claude_cli.ClaudeCall(
                    prompt=prompt,
                    cwd=work,
                    system_prompt_file=system_design,
                    tools=TOOLS,
                    session_id=variant["sessionId"] if first else None,
                    resume=None if first else variant["sessionId"],
                    model=options.get("model") or None,
                    effort=options.get("effort") or None,
                ),
                activity,
            )
        variant["cost"] = round(variant.get("cost", 0) + result.cost, 4)
        if result.session_id:
            variant["sessionId"] = result.session_id
        if result.text:
            self.store.log(variant, "claude", result.text[:1500], save=False)
        self.store.save_variant(variant)
        after = fingerprint(work, variant, langs)
        missing = missing_files(work, variant, langs)
        if missing:
            raise StudioError(f"Claude did not write {languages.listing(missing)}.")
        return before != after

    async def _apply_brief(self, variant: dict) -> None:
        """Takes what Claude changed in brief.json: names and group, or a new picture."""
        work = self.store.work_dir(variant)
        brief = read_json(work / "brief.json")
        if not isinstance(brief, dict):
            write_json(work / "brief.json", variant["brief"])
            return
        current = variant["brief"]
        for key in ("name", "groupName"):
            value = brief.get(key)
            if isinstance(value, dict) and isinstance(value.get("he"), str) and isinstance(value.get("en"), str):
                current[key] = {"he": value["he"].strip(), "en": value["en"].strip()}
        if isinstance(brief.get("group"), str) and brief["group"].strip():
            current["group"] = slugify(brief["group"])
        image = brief.get("image")
        edit = brief.get("imageEdit")
        if isinstance(edit, str) and edit.strip():
            brief.pop("imageEdit", None)
            write_json(work / "brief.json", {**brief, "id": current["id"]})
            await self._image(variant, edit=edit.strip())
        elif isinstance(image, dict) and isinstance(image.get("prompt"), str):
            wanted = {
                "prompt": image["prompt"].strip(),
                "aspect": image.get("aspect") if image.get("aspect") in ASPECTS else "wide",
            }
            if wanted != current.get("image"):
                current["image"] = wanted
                await self._image(variant)
        self.store.save_variant(variant)

    async def _image(self, variant: dict, edit: str | None = None) -> None:
        work = self.store.work_dir(variant)
        image = variant["brief"]["image"]
        self._set(variant, "image", "waiting for Codex")
        fresh = work / "subject.next.png"
        async with self.codex_slots:
            self._set(variant, "image", None)
            if edit:
                self.store.log(variant, "image", f"Changing the picture: {edit}")
            else:
                self.store.log(variant, "image", f"Making the picture ({image['aspect']}): {image['prompt']}")
            for attempt in (1, 2):
                try:
                    await codex_cli.make_image(
                        edit or image["prompt"],
                        fresh,
                        aspect=image["aspect"],
                        reference=(work / "subject.png") if edit else None,
                    )
                    break
                except codex_cli.CodexError as error:
                    if attempt == 2 or error.kind != "generation_failed":
                        raise
                    self.store.log(variant, "error", f"{error} Trying once more.")
        fresh.replace(work / "subject.png")
        w, h = picture_size(work / "subject.png")
        variant["imageRevision"] = int(variant.get("imageRevision", 0)) + 1
        variant["image"] = {"width": w, "height": h, "revision": variant["imageRevision"], **image}
        self.store.log(variant, "image", f"The picture is ready ({w}×{h}).")

    async def _render(self, variant: dict) -> dict:
        work = self.store.work_dir(variant)
        self._set(variant, "rendering", "waiting for the browser")
        async with self.render_slots:
            self._set(variant, "rendering", None)
            variant["revision"] = int(variant.get("revision", 0)) + 1
            result = await snap(
                self.settings, variant["id"], variant["revision"], render_dir(work, variant["revision"])
            )
            forget_old(work, variant["revision"])
        findings = [
            f for side in (result.get("langs") or {}).values() for f in side.get("findings") or []
        ]
        issues = list(result.get("issues") or []) + [
            i for side in (result.get("langs") or {}).values() for i in side.get("issues") or []
        ]
        variant["render"] = {
            "revision": variant["revision"],
            "imageRevision": variant.get("imageRevision", 0),
            "publishable": bool(result.get("publishable")),
            "errors": sum(1 for f in findings if f.get("severity") == "error"),
            "warnings": sum(1 for f in findings if f.get("severity") != "error"),
            "issues": len(issues),
            "editability": {
                lang: side.get("editability") for lang, side in (result.get("langs") or {}).items()
            },
        }
        if variant.get("approved"):
            variant["approved"] = False
            self.store.log(variant, "info", "The design changed, so its approval was withdrawn.", save=False)
        summary = (
            f"Rendered revision {variant['revision']}: "
            f"{variant['render']['errors']} errors, {variant['render']['warnings']} warnings, "
            f"{len(issues)} contract issues."
        )
        self.store.log(variant, "render", summary)
        return result

    # ------------------------------------------------------------------ actions

    def retry(self, vid: str) -> None:
        variant = self._variant(vid)
        if variant["status"] in RUNNING:
            raise StudioError("It is running.")
        variant["error"] = None
        self._set(variant, "queued")
        self._spawn(vid, self._make(variant))

    def refine(self, vid: str, feedback: str) -> None:
        variant = self._variant(vid)
        if variant["status"] in RUNNING:
            raise StudioError("Wait for it to finish, or stop it.")
        if not variant.get("sessionId"):
            raise StudioError("This variant has no design to change yet; retry it first.")
        self.store.log(variant, "feedback", feedback)
        self._set(variant, "queued")
        self._spawn(vid, self._guard(variant, self._refine_steps(variant, feedback)))

    async def _refine_steps(self, variant: dict, feedback: str) -> None:
        if variant.get("kind") == "template":
            lang = variant["lang"]
            await self._turn(variant, "writing", template_prompts.feedback_prompt(feedback, lang))
            result = await self._render(variant)
            if has_errors(result):
                if await self._turn(variant, "reviewing", template_prompts.fix_prompt(result, self._renders(variant), lang)):
                    await self._render(variant)
            return
        langs = self.languages_of(variant)
        await self._turn(variant, "writing", prompts.feedback_prompt(feedback, langs))
        await self._apply_brief(variant)
        result = await self._render(variant)
        if has_errors(result):
            if await self._turn(variant, "reviewing", prompts.fix_prompt(result, self._renders(variant), langs)):
                await self._apply_brief(variant)
                await self._render(variant)

    def new_image(self, vid: str, instruction: str | None) -> None:
        variant = self._variant(vid)
        if variant.get("kind") == "template":
            raise StudioError("A template's sample keeps the template's pictures.")
        if variant["status"] in RUNNING:
            raise StudioError("Wait for it to finish, or stop it.")
        self._set(variant, "queued")

        async def steps() -> None:
            await self._image(variant, edit=instruction or None)
            await self._render(variant)

        self._spawn(vid, self._guard(variant, steps()))

    def approve(self, vid: str, approved: bool) -> None:
        variant = self._variant(vid)
        if approved:
            if variant["status"] != "ready":
                raise StudioError("Only a finished design can be approved.")
            if not (variant.get("render") or {}).get("publishable"):
                raise StudioError("Its last render did not pass the gallery's contract; ask for a fix first.")
        variant["approved"] = approved
        self.store.log(variant, "approval", "Approved for publishing." if approved else "Approval withdrawn.")

    def discard(self, vid: str, discarded: bool) -> None:
        variant = self._variant(vid)
        self.cancel(vid)
        variant["discarded"] = discarded
        if discarded:
            variant["approved"] = False
        self.store.save_variant(variant)

    def render_input(self, vid: str) -> dict:
        """What the render page converts: the HTML of every language of a design and its
        picture, or a template and its sample in the variant's language, with the English one
        it is held to."""
        variant = self._variant(vid)
        work = self.store.work_dir(variant)
        if variant.get("kind") == "template":
            return self._template_render_input(variant, work)
        langs = self.languages_of(variant)
        missing = missing_files(work, variant, langs) + ([] if (work / "subject.png").exists() else ["subject.png"])
        if missing:
            raise StudioError(f"Not written yet: {', '.join(missing)}")
        w, h = picture_size(work / "subject.png")
        return {
            "id": variant["id"],
            "designId": variant["designId"],
            "revision": variant.get("revision", 0),
            "languages": langs,
            "html": {lang: (work / languages.file_of(lang)).read_text(encoding="utf-8") for lang in langs},
            "image": {
                "url": f"/api/variants/{vid}/files/subject.png?r={variant.get('imageRevision', 0)}",
                "width": w,
                "height": h,
            },
        }

    def _template_render_input(self, variant: dict, work: Path) -> dict:
        lang = variant["lang"]
        missing = [name for name in ("template.json", "en.json", sample_file(lang)) if not (work / name).exists()]
        if missing:
            raise StudioError(f"Not written yet: {', '.join(missing)}")
        # A file that is not JSON is the render's finding, not a failure of the render.
        try:
            sample, error = json.loads((work / sample_file(lang)).read_text(encoding="utf-8")), None
        except json.JSONDecodeError as failure:
            sample, error = None, f"{sample_file(lang)} is not valid JSON: {failure}"
        return {
            "kind": "template",
            "id": variant["id"],
            "templateId": variant["templateId"],
            "revision": variant.get("revision", 0),
            "lang": lang,
            "template": read_json(work / "template.json"),
            "english": read_json(work / "en.json"),
            "hebrew": read_json(work / "he.json"),
            "sample": sample,
            "error": error,
        }

