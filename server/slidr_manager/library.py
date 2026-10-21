"""The media library: what is published, and the studio's work sent to it.

The studio reads the published library, as the app reads it (`SLIDR_MEDIA_URL`): the groups and
ids of its designs, for planning, and the catalog of templates (`templates.py`). It keeps no copy
of it, and never writes it.

Its approved work goes to Slidr Library's upload API (`uploads.py`; the library's README,
"Uploading"): a design as `designs: add`, a template's sample as `templates: translate`. The
library checks each against what it publishes, and keeps it until an editor accepts it. A
publication then writes the accepted uploads into the library, through the library's API too
(`POST /api/publish`; README, "Publishing the uploads"): the library lives in its Worker's
bucket, and every app reads it from there. The studio asks for one from its Publish panel, with
its key, and marks the variants whose uploads it published.
"""

from __future__ import annotations

import asyncio
import io
import json
import re
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

from PIL import Image

from .config import Settings
from .events import EventBus
from .languages import BASE_LANGUAGES, CONTENT_LANGUAGES
from .render import render_dir
from .store import Store, now, read_json
from .templates import Templates
from .uploads import LibraryApi, UploadError, design_upload, sample_upload

MANAGED = "elements/designs/managed.json"
INDEX = "elements/designs/index.json"


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

    def _api(self) -> LibraryApi:
        return LibraryApi(self.settings.library_url, self.settings.library_key)

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
        """The gallery's groups and design ids, as published, for planning."""
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

    # ------------------------------------------------------------------ the work, as uploads

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

    async def upload(self, vids: list[str]) -> list[dict]:
        """Sends approved work to the library's upload API (`uploads.py`), one upload each: a
        design as `designs: add`, a template's sample as `templates: translate`. Each item says
        the upload it now waits as, or why the library did not take it; a variant keeps its
        upload (`variant["upload"]`), so it is not sent twice."""
        api = self._api()
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

    # ------------------------------------------------------------------ into the library

    async def state(self) -> dict:
        """Where the published library is, when it was published, and how many uploads wait."""
        try:
            return await self._api().library()
        except UploadError as error:
            raise LibraryError(str(error)) from error

    async def accepted(self) -> list[dict]:
        """The uploads the library's editors accepted, which the next publication takes."""
        try:
            return await self._api().accepted()
        except UploadError as error:
            raise LibraryError(str(error)) from error

    async def publish(self, upload_ids: list[str] | None = None) -> dict:
        """Asks the library to publish its accepted uploads (or those named), and marks each
        variant whose upload it published: it leaves the queue, as published."""
        try:
            done = await self._api().publish(upload_ids)
        except UploadError as error:
            raise LibraryError(str(error)) from error
        published = {one.get("id") for one in done.get("uploads") or [] if isinstance(one, dict)}
        if published:
            stamp = now()
            for variant in list(self.store.variants.values()):
                upload = variant.get("upload") or {}
                if upload.get("id") not in published:
                    continue
                variant["upload"] = {**upload, "status": "published"}
                variant["published"] = {"at": stamp, "revision": variant.get("revision")}
                variant["approved"] = False
                self.store.log(variant, "publish", f"Published to the media library ({done.get('published')}).")
            self._known = None
            if self.templates:
                self.templates.forget()
        return done
