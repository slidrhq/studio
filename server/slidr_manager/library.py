"""The media library: what is published, and publishing approved work to it.

Designs the studio makes go to their own catalog, `elements/designs/managed.json`, with ids that
start with `m-`, beside the authored `elements/designs/index.json`, which the studio never
writes. The app reads both (docs/media-library.md). Their pictures are
`images/designs/<id>.webp`, and their sizes are kept in managed.json.

The samples of templates the studio writes go into the catalog of templates,
`templates/catalog.json`, under `samples[<template>][<lang>]`: the author copy's catalog, which
may hold an author's work that is not published yet, is the base, and nothing else of it changes
(`templates.py`).

Publishing goes through the repository's own `desktop/scripts/media-publish.mjs`, from the
author copy (`../Slidr-media`), so it keeps that script's staging, manifest and guards:

1. prepare: copy into the author copy the published files it lacks (never one it has), write the
   approved designs into it, and ask the script for a dry run with a report of what would change;
2. the person reads the report and confirms;
3. publish: run the script for real, then read the published manifest back to check the files.

Cancelling, or a failed deploy, puts the author copy back as it was.
"""

from __future__ import annotations

import asyncio
import hashlib
import io
import json
import os
import re
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

from PIL import Image

from .config import VENDOR, Settings
from .events import EventBus
from .languages import BASE_LANGUAGES, CONTENT_LANGUAGES, NAMES
from .programs import creation_flags, find_node
from .render import render_dir
from .store import Store, now, read_json, write_json
from .templates import (
    CATALOG as TEMPLATES,
    TemplateError,
    Templates,
    catalog_changes,
    encode_catalog,
    merge_sample,
)
from .uploads import LibraryApi, UploadError, design_upload, sample_upload

MANAGED = "elements/designs/managed.json"
INDEX = "elements/designs/index.json"
#: The largest file Cloudflare Pages serves (docs/media-library.md).
FILE_LIMIT = 25 * 1024 * 1024
PUBLISH_SCRIPT = VENDOR / "desktop" / "scripts" / "media-publish.mjs"
LOG_LIMIT = 600


class LibraryError(Exception):
    pass


class NotPublished(Exception):
    pass


def fetch(url: str, timeout: float = 30) -> bytes:
    request = urllib.request.Request(
        url, headers={"User-Agent": "slidr-studio", "Cache-Control": "no-cache"}
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:  # noqa: S310
            return response.read()
    except urllib.error.HTTPError as error:
        if error.code in (404, 410):
            raise NotPublished(url) from error
        raise


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def empty_catalog() -> dict:
    return {
        "version": 1,
        "groups": [],
        "groupNames": {},
        "groupIds": {},
        "slides": {},
        "subjects": {},
        "names": {},
        "sizes": {},
        "tags": {},
    }


# Most search tags kept in a language, and fewest a language must have for any to be kept.
MOST_TAGS = 20
FEWEST_TAGS = 3


def design_tags(value: Any) -> dict | None:
    """The search tags of a design as the catalog keeps them (ADR-108 of the app): `{he, en}`,
    each a list of short words, English in lower case, Hebrew in Hebrew letters and without
    niqqud, none twice. None when either language has too few."""
    if not isinstance(value, dict):
        return None
    tags: dict[str, list[str]] = {}
    for lang in ("he", "en"):
        given = value.get(lang)
        kept: list[str] = []
        for tag in given if isinstance(given, list) else []:
            if not isinstance(tag, str):
                continue
            text = " ".join(tag.split())
            text = re.sub("[֑-ׇ]", "", text) if lang == "he" else text.lower()
            hebrew = re.search("[א-ת]", text) is not None
            if not text or len(text) > 40 or hebrew != (lang == "he") or text in kept:
                continue
            kept.append(text)
        if len(kept) < FEWEST_TAGS:
            return None
        tags[lang] = kept[:MOST_TAGS]
    return tags


def merge_design(catalog: dict, design: dict) -> dict:
    """Puts one design into a managed catalog, replacing it in place when it is there.

    `design`: id, name {he, en}, group, groupName {he, en}, slides {he, en, and any other content
    language it was made in: ar, de, ja…}, subject [x, y], size [w, h], and its search tags
    {he, en} when it has them. The names and tags stay in Hebrew and English, the languages the
    gallery names and searches its designs in. A design has one group: it leaves any other it was
    filed under.
    """
    for key, value in empty_catalog().items():
        catalog.setdefault(key, value)
    did, group = design["id"], design["group"]
    if group not in catalog["groups"]:
        catalog["groups"].append(group)
    # A group keeps the names it was published with.
    catalog["groupNames"].setdefault(group, design.get("groupName") or {"he": group, "en": group})
    for other, ids in catalog["groupIds"].items():
        if other != group and did in ids:
            ids.remove(did)
    ids = catalog["groupIds"].setdefault(group, [])
    if did not in ids:
        ids.append(did)
    catalog["slides"][did] = design["slides"]
    catalog["subjects"][did] = design["subject"]
    catalog["names"][did] = design["name"]
    catalog["sizes"][did] = design["size"]
    # A design published again without tags keeps none: the app then finds it by its names.
    if design.get("tags"):
        catalog["tags"][did] = design["tags"]
    else:
        catalog["tags"].pop(did, None)
    # Groups left without designs go.
    for name in [g for g in catalog["groups"] if not catalog["groupIds"].get(g)]:
        catalog["groups"].remove(name)
        catalog["groupIds"].pop(name, None)
        catalog["groupNames"].pop(name, None)
    catalog["groupIds"] = {g: catalog["groupIds"][g] for g in catalog["groups"]}
    return catalog


def to_webp(png: Path) -> tuple[bytes, tuple[int, int]]:
    with Image.open(png) as image:
        image.load()
        transparent = image.mode in ("RGBA", "LA") or "transparency" in image.info
        converted = image.convert("RGBA" if transparent else "RGB")
        out = io.BytesIO()
        converted.save(out, "WEBP", quality=86, method=6)
        return out.getvalue(), converted.size


class Library:
    def __init__(
        self, settings: Settings, store: Store, bus: EventBus, templates: Templates | None = None
    ) -> None:
        self.settings = settings
        self.store = store
        self.bus = bus
        self.templates = templates
        self._known: tuple[float, dict] | None = None
        self.state: dict[str, Any] = self._idle()
        self._undo: list[tuple[Path, bytes | None]] = []
        self._lock = asyncio.Lock()
        self._task: asyncio.Task | None = None

    @staticmethod
    def _idle() -> dict:
        return {"phase": "idle", "items": [], "report": None, "log": [], "error": None, "at": None}

    def url(self, path: str) -> str:
        return self.settings.media_url.rstrip("/") + "/" + path

    async def published_json(self, path: str) -> Any:
        """A JSON file of the published library; None when it was never published."""
        try:
            data = await asyncio.to_thread(fetch, self.url(path))
        except NotPublished:
            return None
        return json.loads(data.decode("utf-8"))

    # ------------------------------------------------------------------ what is there

    async def known(self, fresh: bool = False) -> dict:
        """The gallery's groups and design ids, published and local, for planning."""
        if self._known and not fresh and time.time() - self._known[0] < 60:
            return self._known[1]
        groups: list[dict] = []
        ids: set[str] = set()
        try:
            index = await self.published_json(INDEX)
            managed = await self.published_json(MANAGED)
            reachable = True
        except Exception:  # noqa: BLE001 - the studio still plans without the network
            index, managed, reachable = None, None, False
        if isinstance(index, dict):
            ids.update((index.get("slides") or {}).keys())
            groups += [{"id": g} for g in index.get("groups") or []]
        if isinstance(managed, dict):
            ids.update((managed.get("slides") or {}).keys())
            names = managed.get("groupNames") or {}
            for group in managed.get("groups") or []:
                entry = next((g for g in groups if g["id"] == group), None)
                if entry is None:
                    entry = {"id": group}
                    groups.append(entry)
                entry.update(names.get(group) or {})
        known = {
            "groups": groups,
            "ids": sorted(ids),
            "managed": len((managed or {}).get("slides") or {}) if isinstance(managed, dict) else 0,
            "authored": len((index or {}).get("slides") or {}) if isinstance(index, dict) else 0,
            "reachable": reachable,
        }
        self._known = (time.time(), known)
        return known

    # ------------------------------------------------------------------ publishing

    def _log(self, text: str) -> None:
        self.state["log"].append({"t": now(), "text": text})
        del self.state["log"][:-LOG_LIMIT]
        self._emit()

    def _emit(self) -> None:
        self.bus.publish({"type": "publish", "publish": self.state})

    def _set(self, **changes: Any) -> None:
        self.state.update(changes)
        self._emit()

    def _write(self, path: Path, data: bytes) -> None:
        """Writes a file of the author copy, remembering what was there to put it back."""
        previous = path.read_bytes() if path.exists() else None
        self._undo.append((path, previous))
        path.parent.mkdir(parents=True, exist_ok=True)
        temp = path.with_suffix(path.suffix + ".tmp")
        temp.write_bytes(data)
        os.replace(temp, path)

    def _revert(self) -> None:
        for path, previous in reversed(self._undo):
            try:
                if previous is None:
                    path.unlink(missing_ok=True)
                else:
                    path.write_bytes(previous)
            except OSError:
                pass
        self._undo = []

    async def _sync_missing(self) -> None:
        """Copies into the author copy the published files it lacks. A file it has is never
        touched: it may hold the author's work that is not published yet."""
        manifest = await self.published_json("manifest.json")
        if not isinstance(manifest, dict):
            self._log("The library has never been published: nothing to copy.")
            return
        files = manifest.get("files") or {}
        media = self.settings.media_dir
        missing = [(p, f) for p, f in files.items() if not (media / Path(*p.split("/"))).exists()]
        if not missing:
            self._log(f"The author copy has every one of the {len(files)} published files.")
            return
        total = sum(int(f.get("size") or 0) for _, f in missing)
        self._log(
            f"Copying {len(missing)} published files ({total / 1024 / 1024:.1f} MB) the author copy "
            f"lacks into {media}, so that publishing it keeps them."
        )
        semaphore = asyncio.Semaphore(8)

        async def one(path: str, info: dict) -> None:
            async with semaphore:
                data = await asyncio.to_thread(fetch, self.url(path), 120)
            if sha256(data) != info.get("sha256"):
                raise LibraryError(f"{path} does not match the published manifest.")
            target = media / Path(*path.split("/"))
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(data)

        for start in range(0, len(missing), 40):
            await asyncio.gather(*(one(p, f) for p, f in missing[start : start + 40]))
            self._log(f"  {min(start + 40, len(missing))} of {len(missing)} copied")

    def _design_record(self, variant: dict) -> tuple[dict, bytes]:
        work = self.store.work_dir(variant)
        revision = (variant.get("render") or {}).get("revision")
        result = read_json(render_dir(work, revision) / "result.json") if revision else None
        if not isinstance(result, dict) or not result.get("publishable"):
            raise LibraryError(f"{variant['designId']}: its last render did not pass the checks.")
        # A slide for every language the design was rendered in, in the registry's order.
        sides = result.get("langs") or {}
        slides = {
            lang: sides[lang]["slide"]
            for lang in CONTENT_LANGUAGES
            if isinstance(sides.get(lang), dict) and sides[lang].get("slide")
        }
        if any(lang not in slides for lang in BASE_LANGUAGES):
            raise LibraryError(f"{variant['designId']}: its last render has no Hebrew or English slide.")
        webp, size = to_webp(work / "subject.png")
        brief = variant["brief"]
        record = {
            "id": variant["designId"],
            "name": brief["name"],
            "group": brief["group"],
            "groupName": brief.get("groupName") or {"he": brief["group"], "en": brief["group"]},
            "slides": slides,
            "subject": result["subject"],
            "size": list(size),
        }
        tags = design_tags(brief.get("tags"))
        if tags:
            record["tags"] = tags
        return record, webp

    async def _prepare_designs(self, variants: list[dict]) -> None:
        """Writes approved designs into the managed catalog, which the studio alone writes: the
        published one is the base."""
        media = self.settings.media_dir
        try:
            catalog = await self.published_json(MANAGED)
        except Exception as error:  # noqa: BLE001
            raise LibraryError(f"Could not read the published {MANAGED}: {error}") from error
        catalog = catalog if isinstance(catalog, dict) else empty_catalog()
        self._log(f"The published managed catalog holds {len(catalog.get('slides') or {})} designs.")
        for variant in variants:
            record, webp = await asyncio.to_thread(self._design_record, variant)
            self._write(media / "images" / "designs" / f"{record['id']}.webp", webp)
            merge_design(catalog, record)
            self._log(f"  {record['id']}: {record['name']['en']} → {record['group']} ({len(webp) // 1024} KB picture)")
        self._write(
            media / Path(*MANAGED.split("/")),
            json.dumps(catalog, ensure_ascii=False, separators=(",", ":")).encode("utf-8"),
        )

    def _sample_record(self, variant: dict) -> tuple[str, str, list]:
        """A template's sample in one language, as its last render built it."""
        work = self.store.work_dir(variant)
        revision = (variant.get("render") or {}).get("revision")
        result = read_json(render_dir(work, revision) / "result.json") if revision else None
        where = f"{variant.get('templateId')} · {variant.get('lang')}"
        if not isinstance(result, dict) or not result.get("publishable"):
            raise LibraryError(f"{where}: its last render did not pass the checks.")
        sample = result.get("sample")
        if not isinstance(sample, list) or not sample:
            raise LibraryError(f"{where}: its last render holds no sample.")
        return variant["templateId"], variant["lang"], sample

    async def _prepare_samples(self, variants: list[dict]) -> list[str]:
        """Writes approved samples into the author copy's catalog of templates, which may hold
        an author's work that is not published yet: that copy is the base, and nothing else of
        it changes. Returns that work, part by part (`catalog_changes`): the report counts the
        catalog as the studio's file, and this is what else the file sends."""
        path = self.settings.media_dir / Path(*TEMPLATES.split("/"))
        if not path.is_file():
            raise LibraryError(f"The author copy has no {TEMPLATES}.")
        catalog = await asyncio.to_thread(lambda: json.loads(path.read_text(encoding="utf-8")))
        try:
            published = await self.published_json(TEMPLATES)
        except Exception:  # noqa: BLE001 - without it, the file's other changes are not listed
            published = None
            self._log(f"The published {TEMPLATES} could not be read: its other changes are not listed.")
        ours = {(v.get("templateId"), v.get("lang")) for v in variants}
        others = catalog_changes(catalog, published, ours)
        if others:
            self._log(f"{TEMPLATES} of the author copy also holds work that is not published yet:")
            for change in others:
                self._log(f"  {change.split(': ', 1)[1]}")
        for variant in variants:
            tid, lang, sample = self._sample_record(variant)
            try:
                merge_sample(catalog, tid, lang, sample)
            except TemplateError as error:
                raise LibraryError(str(error)) from error
            self._log(f"  {tid}: the sample in {NAMES.get(lang, lang)} ({len(sample)} slides)")
        data = await asyncio.to_thread(encode_catalog, catalog)
        if len(data) > FILE_LIMIT:
            raise LibraryError(
                f"{TEMPLATES} would be {len(data) / 1024 / 1024:.1f} MB; Pages serves a file of at most "
                f"{FILE_LIMIT // 1024 // 1024} MB."
            )
        self._write(path, data)
        self._log(f"{TEMPLATES}: {len(data) / 1024 / 1024:.1f} MB.")
        return others

    # ------------------------------------------------------------------ uploading

    async def upload(self, vids: list[str]) -> list[dict]:
        """Sends approved work to the library's upload API (`uploads.py`), one upload each: a
        design as `designs: add`, a template's sample as `templates: translate`. Each item says
        the upload it now waits as, or why the library did not take it; a variant keeps its
        upload (`variant["upload"]`), so it is not sent twice."""
        api = LibraryApi(self.settings.library_url, self.settings.library_key)
        results: list[dict] = []
        for vid in vids:
            variant = self.store.variants.get(vid)
            if not variant:
                continue
            item: dict[str, Any] = {"variantId": vid}
            try:
                if variant.get("kind") == "template":
                    template_id, lang, sample = self._sample_record(variant)
                    answer = await api.send(sample_upload(template_id, lang, sample))
                else:
                    record, webp = self._design_record(variant)
                    answer = await api.send(design_upload(record), {"picture": (webp, "image/webp")})
                variant["upload"] = {"id": answer["id"], "status": answer.get("status"), "at": now()}
                self.store.save_variant(variant)
                item.update(uploadId=answer["id"], status=answer.get("status"), missing=answer.get("missing", []))
            except UploadError as error:
                item.update(error=str(error), issues=error.issues)
            except LibraryError as error:
                item.update(error=str(error), issues=[])
            results.append(item)
        return results

    async def prepare(self, vids: list[str]) -> None:
        async with self._lock:
            if self.state["phase"] in ("preparing", "publishing"):
                raise LibraryError("A publication is already in progress.")
            if self.state["phase"] == "prepared":
                self._revert()
            variants = [self.store.variants[v] for v in vids if v in self.store.variants]
            if not variants:
                raise LibraryError("Nothing approved to publish.")
            self.state = self._idle()
            self._set(phase="preparing", items=[v["id"] for v in variants], at=now())
        self._task = asyncio.create_task(self._prepare(variants))

    async def _prepare(self, variants: list[dict]) -> None:
        try:
            media = self.settings.media_dir
            if not media.is_dir():
                raise LibraryError(f"There is no author copy of the library at {media}.")
            await self._sync_missing()
            designs = [v for v in variants if v.get("kind") != "template"]
            samples = [v for v in variants if v.get("kind") == "template"]
            ours: set[str] = set()
            # Work inside a file of ours that is not ours: an author's unpublished changes.
            inside: list[str] = []
            if designs:
                await self._prepare_designs(designs)
                ours |= {MANAGED} | {f"images/designs/{v['designId']}.webp" for v in designs}
            if samples:
                inside = await self._prepare_samples(samples)
                ours.add(TEMPLATES)
            report = await self._run_script(dry_run=True)
            report["ours"] = sorted(ours)
            report["unexpected"] = sorted(
                p for p in report.get("added", []) + report.get("changed", []) if p not in ours
            ) + inside
            self._set(phase="prepared", report=report)
        except Exception as error:  # noqa: BLE001
            self._revert()
            self._log(f"Failed: {error}")
            self._set(phase="failed", error=str(error))

    async def _run_script(self, dry_run: bool) -> dict:
        node = find_node()
        if not node:
            raise LibraryError("Node.js was not found; it runs the publishing script.")
        report_file = self.settings.data / "publish" / "report.json"
        report_file.parent.mkdir(parents=True, exist_ok=True)
        report_file.unlink(missing_ok=True)
        args = [str(node), str(PUBLISH_SCRIPT), "--from", str(self.settings.media_dir),
                "--report", str(report_file)]
        if dry_run:
            args.append("--dry-run")
        env = os.environ.copy()
        if not dry_run:
            if not self.settings.cloudflare_token:
                raise LibraryError("No Cloudflare API token: enter one in the publishing panel.")
            env["CLOUDFLARE_API_TOKEN"] = self.settings.cloudflare_token
            env["CLOUDFLARE_ACCOUNT_ID"] = self.settings.cloudflare_account_id
        process = await asyncio.create_subprocess_exec(
            *args,
            cwd=str(VENDOR),
            stdin=asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
            env=env,
            creationflags=creation_flags(),
        )
        assert process.stdout
        while line := await process.stdout.readline():
            text = line.decode("utf-8", "replace").rstrip()
            if text:
                # The token never reaches the log, whatever a tool prints.
                if self.settings.cloudflare_token:
                    text = text.replace(self.settings.cloudflare_token, "***")
                self._log(text)
        await process.wait()
        report = read_json(report_file)
        if process.returncode != 0:
            blocked = (report or {}).get("blocked") if isinstance(report, dict) else None
            raise LibraryError(blocked or f"The publishing script stopped with exit code {process.returncode}.")
        if not isinstance(report, dict):
            raise LibraryError("The publishing script wrote no report.")
        return report

    async def confirm(self) -> None:
        async with self._lock:
            if self.state["phase"] != "prepared":
                raise LibraryError("Prepare the publication first, and read what it will change.")
            if not self.settings.cloudflare_token:
                raise LibraryError("No Cloudflare API token: enter one first.")
            self._set(phase="publishing")
        self._task = asyncio.create_task(self._publish())

    async def _publish(self) -> None:
        try:
            await self._run_script(dry_run=False)
            self._log("Deployed. Reading the published manifest back to check the files…")
            expected = {}
            for path in self.state["report"]["ours"]:
                local = self.settings.media_dir / Path(*path.split("/"))
                expected[path] = sha256(local.read_bytes())
            missing: list[str] = list(expected)
            for _attempt in range(12):
                manifest = await self.published_json("manifest.json")
                files = (manifest or {}).get("files") or {}
                missing = [p for p, h in expected.items() if (files.get(p) or {}).get("sha256") != h]
                if not missing:
                    break
                await asyncio.sleep(5)
            if missing:
                raise LibraryError(
                    "The deployment finished, but the published manifest does not have yet: "
                    + ", ".join(missing)
                )
            stamp = now()
            for vid in self.state["items"]:
                variant = self.store.variants.get(vid)
                if variant:
                    variant["published"] = {"at": stamp, "revision": variant["revision"]}
                    # Sent: it leaves the queue, and comes back only when approved again.
                    variant["approved"] = False
                    self.store.log(variant, "publish", "Published to the media library.")
            self._undo = []
            self._known = None
            if self.templates:
                self.templates.forget()
            self._log(f"Published: {len(self.state['items'])} items are in the library.")
            self._set(phase="done", at=stamp)
        except Exception as error:  # noqa: BLE001
            self._revert()
            self._log(f"Failed: {error}. The author copy was put back as it was.")
            self._set(phase="failed", error=str(error))

    async def cancel(self) -> None:
        async with self._lock:
            if self.state["phase"] in ("preparing", "publishing"):
                raise LibraryError("Wait for this step to finish.")
            self._revert()
            self.state = self._idle()
            self._emit()
