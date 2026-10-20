"""Uploads to Slidr Library ([slidrhq/library](https://github.com/slidrhq/library), README
"Uploading"): the studio sends its approved work to the library's REST API, which checks it
against the published library and keeps it until an editor accepts it. A publication takes the
accepted uploads into the library from there; the studio does not publish the author copy for them.

A design goes as `designs: add`, with its picture, its slide in each language it was made in, and
its names and search tags in Hebrew and English (ADR-108 of the app); a template's sample as
`templates: translate`, in its language. The studio signs in as a program, by its key
(`Authorization: Bearer`, the Worker's `LIBRARY_KEYS`).
"""

from __future__ import annotations

import asyncio
import json
import urllib.error
import urllib.request
import uuid
from typing import Any

from .languages import BASE_LANGUAGES

TIMEOUT_S = 120


class UploadError(Exception):
    """The library did not take an upload: why, and each issue at its place."""

    def __init__(self, message: str, issues: list[dict] | None = None) -> None:
        super().__init__(message)
        self.issues = issues or []


def design_upload(record: dict) -> dict:
    """A design of the studio, as the library's `designs: add` takes it.

    `record` is what publishing writes into `managed.json` (`Library._design_record`): its id,
    names, group, slides by language, subject, and its tags when it has them.
    """
    languages: dict[str, dict] = {}
    for lang, slide in record["slides"].items():
        part: dict[str, Any] = {"slide": slide}
        if lang in BASE_LANGUAGES:
            part["name"] = record["name"][lang]
            group_name = (record.get("groupName") or {}).get(lang)
            if group_name:
                part["groupName"] = group_name
            tags = (record.get("tags") or {}).get(lang)
            if tags:
                part["tags"] = tags
        languages[lang] = part
    return {
        "type": "designs",
        "action": "add",
        "id": record["id"],
        "group": record["group"],
        "subject": record["subject"],
        "languages": languages,
    }


def sample_upload(template_id: str, lang: str, sample: list) -> dict:
    """A template's sample in one language, as the library's `templates: translate` takes it."""
    return {"type": "templates", "action": "translate", "id": template_id, "languages": {lang: {"sample": sample}}}


def multipart(upload: dict, files: dict[str, tuple[bytes, str]]) -> tuple[bytes, str]:
    """A form of the upload as JSON (`upload`) and its files, each by its name; and its type."""
    boundary = f"slidr-studio-{uuid.uuid4().hex}"
    parts: list[bytes] = []

    def part(name: str, data: bytes, content_type: str, filename: str | None = None) -> None:
        disposition = f'form-data; name="{name}"' + (f'; filename="{filename}"' if filename else "")
        head = f"--{boundary}\r\nContent-Disposition: {disposition}\r\nContent-Type: {content_type}\r\n\r\n"
        parts.append(head.encode("utf-8") + data + b"\r\n")

    part("upload", json.dumps(upload, ensure_ascii=False).encode("utf-8"), "application/json")
    for name, (data, content_type) in files.items():
        part(name, data, content_type, f"{name}.webp" if content_type == "image/webp" else name)
    body = b"".join(parts) + f"--{boundary}--\r\n".encode("utf-8")
    return body, f"multipart/form-data; boundary={boundary}"


class LibraryApi:
    """The library's upload API at an address, with the studio's key."""

    def __init__(self, url: str, key: str | None) -> None:
        self.url = url.rstrip("/")
        self.key = key

    def _call(self, method: str, path: str, body: bytes | None = None, content_type: str | None = None) -> tuple[int, Any]:
        if not self.key:
            raise UploadError("The studio has no key to the library: set SLIDR_LIBRARY_KEY, or give it in the Publish panel.")
        headers = {"Authorization": f"Bearer {self.key}", "Accept": "application/json"}
        if content_type:
            headers["Content-Type"] = content_type
        request = urllib.request.Request(self.url + path, data=body, method=method, headers=headers)
        try:
            with urllib.request.urlopen(request, timeout=TIMEOUT_S) as answer:
                status, data = answer.status, answer.read()
        except urllib.error.HTTPError as error:
            status, data = error.code, error.read()
        except (urllib.error.URLError, OSError) as error:
            raise UploadError(f"{self.url} could not be reached: {error}") from error
        try:
            return status, json.loads(data.decode("utf-8")) if data else None
        except ValueError:
            return status, None

    async def send(self, upload: dict, files: dict[str, tuple[bytes, str]] | None = None) -> dict:
        """Sends an upload; the upload as the library keeps it, or `UploadError` with what is wrong."""
        body, content_type = multipart(upload, files or {})
        status, answer = await asyncio.to_thread(self._call, "POST", "/api/uploads", body, content_type)
        if status == 201 and isinstance(answer, dict):
            return answer
        answer = answer if isinstance(answer, dict) else {}
        raise UploadError(
            answer.get("message") or f"The library answered {status}.",
            [issue for issue in answer.get("issues") or [] if isinstance(issue, dict)],
        )
