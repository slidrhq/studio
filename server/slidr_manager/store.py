"""Requests (the studio's tabs) and their variants, kept as JSON files.

```text
<data>/requests/<rid>/request.json          the request: kind, prompt, options, languages, plan,
                                            variants
<data>/requests/<rid>/plan/                 the folder of the planning call (and of the call that
                                            reads a request in words)
<data>/requests/<rid>/<vid>/state.json      a variant: kind, languages, stage, log, renders, approval
<data>/requests/<rid>/<vid>/work/           Claude's folder. A design: brief.json, an HTML file for
                                            each language (he.html, en.html, ar.html…),
                                            subject.png. A template's sample in one language:
                                            brief.json, template.md, en.json, he.json, <lang>.json
                                            (templates.py). Both: renders/r<n>/
```

A request's `kind` is `design`, or `template` (the sample of a built-in template, written in
languages: a variant a language). A request stored before there were kinds is a design. A design
request's `languages` are those its designs are made in (`languages.py`); a request or variant
stored before there was a choice has none, and is made in Hebrew and English. A template
request's `languages` are the languages its sample is written in, a variant each.

State files are outside the folder Claude works in, so nothing it writes can change them.
"""

from __future__ import annotations

import json
import os
import secrets
import shutil
import time
from pathlib import Path
from typing import Any

from . import languages
from .events import EventBus

#: Stages a variant can be in. `ready`, `failed` and `cancelled` are at rest.
RUNNING = {"queued", "image", "writing", "rendering", "reviewing"}
LOG_LIMIT = 400


def now() -> float:
    return round(time.time(), 3)


def new_id(prefix: str) -> str:
    return f"{prefix}{time.strftime('%y%m%d%H%M%S')}{secrets.token_hex(3)}"


def write_json(path: Path, data: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix(path.suffix + ".tmp")
    temp.write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")
    os.replace(temp, path)


def read_json(path: Path, default: Any = None) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return default


class Store:
    def __init__(self, root: Path, bus: EventBus) -> None:
        self.root = root
        self.bus = bus
        self.requests: dict[str, dict] = {}
        self.variants: dict[str, dict] = {}

    # ------------------------------------------------------------------ places

    def request_dir(self, rid: str) -> Path:
        return self.root / rid

    def variant_dir(self, variant: dict) -> Path:
        return self.root / variant["requestId"] / variant["id"]

    def work_dir(self, variant: dict) -> Path:
        return self.variant_dir(variant) / "work"

    # ------------------------------------------------------------------ loading

    def load(self) -> None:
        """Reads what was there. A variant that was running when the server stopped is told so."""
        if not self.root.is_dir():
            return
        for folder in sorted(self.root.iterdir()):
            request = read_json(folder / "request.json")
            if not isinstance(request, dict):
                continue
            if request.get("status") == "planning":
                request["status"] = "failed"
                request["error"] = "The server stopped while the concepts were being planned."
            self.requests[request["id"]] = request
            for vid in request.get("variantIds", []):
                variant = read_json(folder / vid / "state.json")
                if not isinstance(variant, dict):
                    continue
                if variant.get("status") in RUNNING:
                    variant["error"] = "The server stopped while this was running. Retry continues it."
                    variant["status"] = "failed"
                self.variants[vid] = variant

    # ------------------------------------------------------------------ requests

    def create_request(self, data: dict) -> dict:
        rid = new_id("r")
        request = {
            "id": rid,
            "createdAt": now(),
            "updatedAt": now(),
            "status": "planning",
            "variantIds": [],
            "error": None,
            "plan": None,
            "cost": 0.0,
            **data,
        }
        self.requests[rid] = request
        self.save_request(request)
        return request

    def save_request(self, request: dict) -> None:
        request["updatedAt"] = now()
        write_json(self.request_dir(request["id"]) / "request.json", request)
        self.bus.publish({"type": "request", "request": request})

    def delete_request(self, rid: str) -> None:
        request = self.requests.pop(rid, None)
        if not request:
            return
        for vid in request.get("variantIds", []):
            self.variants.pop(vid, None)
        shutil.rmtree(self.request_dir(rid), ignore_errors=True)
        self.bus.publish({"type": "requestDeleted", "id": rid})

    # ------------------------------------------------------------------ variants

    def create_variant(self, request: dict, index: int, brief: dict, **fields: Any) -> dict:
        """A variant of a request: a design (the default), or, with `kind="template"`, the
        sample of a template in one language (`lang`, `templateId`), which has no design id."""
        vid = new_id("v")
        variant = {
            "id": vid,
            "requestId": request["id"],
            "index": index,
            "kind": "design",
            "designId": brief.get("id"),
            "brief": brief,
            "languages": languages.chosen(request.get("languages")),
            "status": "queued",
            "stage": None,
            "error": None,
            "log": [],
            "sessionId": None,
            "revision": 0,
            "render": None,
            "imageRevision": 0,
            "image": None,
            "reviews": 0,
            "approved": False,
            "published": None,
            "cost": 0.0,
            "createdAt": now(),
            "updatedAt": now(),
            **fields,
        }
        self.variants[vid] = variant
        request["variantIds"].append(vid)
        self.save_variant(variant)
        self.save_request(request)
        return variant

    def save_variant(self, variant: dict) -> None:
        variant["updatedAt"] = now()
        write_json(self.variant_dir(variant) / "state.json", variant)
        self.bus.publish({"type": "variant", "variant": variant})

    def log(self, variant: dict, kind: str, text: str, save: bool = True) -> None:
        variant["log"].append({"t": now(), "kind": kind, "text": text})
        del variant["log"][:-LOG_LIMIT]
        if save:
            self.save_variant(variant)

    def all_design_ids(self, exclude: str | None = None) -> set[str]:
        return {
            v["designId"]
            for v in self.variants.values()
            if v["id"] != exclude and v.get("status") != "cancelled" and isinstance(v.get("designId"), str)
        }
