"""The studio's web server: the API, a stream of changes, the job files and the built pages."""

from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager
from typing import Literal

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, StreamingResponse
from pydantic import BaseModel, Field, field_validator, model_validator

from . import programs
from .config import Settings
from .events import EventBus
from .instructions import Instructions
from .languages import BASE_LANGUAGES, known as known_languages, parse as parse_languages
from .library import Library, LibraryError
from .pipeline import Studio, StudioError
from .render import render_dir
from .store import Store, read_json
from .templates import TemplateError, Templates

MODELS = {"", "fable", "opus", "sonnet", "haiku"}
EFFORTS = {"", "low", "medium", "high", "xhigh", "max"}


class NewRequest(BaseModel):
    #: What to make, in words: a design's description, a template request's instructions
    #: (optional), or any request for the studio to read (`kind` "auto").
    prompt: str = Field(default="", max_length=4000)
    #: `design`, `template` (the sample of `templateId` in `languages`), or `auto`: Claude reads
    #: the prompt and makes it one of the two.
    kind: Literal["auto", "design", "template"] = "design"
    templateId: str = Field(default="", max_length=40)
    count: int = Field(default=3, ge=1, le=6)
    group: str = Field(default="", max_length=40)
    model: str = ""
    effort: str = ""
    reviewRounds: int = Field(default=2, ge=0, le=3)
    #: A design's languages: Hebrew and English always (added when left out), and any other
    #: content language asked for; none asked for means Hebrew and English only. A template's:
    #: exactly the languages to write its sample in. A code the registry does not know is refused.
    languages: list[str] = Field(default_factory=lambda: list(BASE_LANGUAGES), max_length=64)

    @field_validator("languages")
    @classmethod
    def _known_languages(cls, value: list[str]) -> list[str]:
        return known_languages(value)

    @model_validator(mode="after")
    def _design_languages(self) -> "NewRequest":
        # A design, or a request that may become one, is made in Hebrew and English always.
        if self.kind != "template":
            self.languages = parse_languages(self.languages)
        return self


class More(BaseModel):
    count: int = Field(default=2, ge=1, le=6)


class Feedback(BaseModel):
    feedback: str = Field(min_length=2, max_length=4000)


class ImageRequest(BaseModel):
    instruction: str = Field(default="", max_length=2000)


class Flag(BaseModel):
    value: bool = True


class PublishItems(BaseModel):
    variantIds: list[str] | None = None


class CloudflareSettings(BaseModel):
    token: str = Field(default="", max_length=400)
    accountId: str = Field(default="", max_length=64)


class LibrarySettings(BaseModel):
    key: str = Field(default="", max_length=400)
    url: str = Field(default="", max_length=400)


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or Settings()
    bus = EventBus()
    store = Store(settings.requests_dir, bus)
    store.load()
    instructions = Instructions(settings)
    templates = Templates(settings)
    library = Library(settings, store, bus, templates)
    studio = Studio(settings, store, instructions, library, templates)

    @asynccontextmanager
    async def lifespan(_app: FastAPI):
        yield
        for task in list(studio.tasks.values()):
            task.cancel()

    app = FastAPI(title="Slidr Studio", lifespan=lifespan)
    # Slidr Library (github.com/slidrhq/library), served from this machine, reads which of the
    # library's designs the studio made: reading only, and only from this machine's pages.
    app.add_middleware(
        CORSMiddleware,
        allow_origin_regex=r"http://(127\.0\.0\.1|localhost)(:\d+)?",
        allow_methods=["GET"],
    )
    app.state.studio = studio
    app.state.store = store
    app.state.library = library
    app.state.settings = settings

    def fail(error: Exception, status: int = 400) -> HTTPException:
        return HTTPException(status_code=status, detail=str(error))

    # ------------------------------------------------------------------ state

    @app.get("/api/status")
    async def status() -> dict:
        found = await programs.probe()
        return {
            "programs": [p.as_dict() for p in found],
            "media": {
                "dir": str(settings.media_dir),
                "exists": settings.media_dir.is_dir(),
                "url": settings.media_url,
            },
            "cloudflare": {
                "accountId": settings.cloudflare_account_id,
                "token": bool(settings.cloudflare_token),
            },
            "library": {"url": settings.library_url, "key": bool(settings.library_key)},
            "renderUrl": settings.render_url,
            "web": settings.web_dist.is_dir(),
        }

    @app.get("/api/state")
    async def state() -> dict:
        return {
            "requests": sorted(store.requests.values(), key=lambda r: r["createdAt"]),
            "variants": list(store.variants.values()),
            "publish": library.state,
        }

    @app.get("/api/library")
    async def known(fresh: bool = False) -> dict:
        return await library.known(fresh)

    @app.get("/api/templates")
    async def template_listing(fresh: bool = False) -> dict:
        """The built-in templates, with the languages each sample is written in and lacks."""
        if fresh:
            templates.forget()
        try:
            return {"templates": await studio.template_listing()}
        except TemplateError as error:
            raise fail(error, 502)

    @app.get("/api/events")
    async def events(request: Request) -> StreamingResponse:
        queue = bus.subscribe()

        async def stream():
            try:
                yield "retry: 2000\n\n"
                while True:
                    if await request.is_disconnected():
                        break
                    try:
                        data = await asyncio.wait_for(queue.get(), 15)
                        yield f"data: {data}\n\n"
                    except asyncio.TimeoutError:
                        yield ": keep-alive\n\n"
            finally:
                bus.unsubscribe(queue)

        return StreamingResponse(
            stream(),
            media_type="text/event-stream",
            headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
        )

    # ------------------------------------------------------------------ requests

    @app.post("/api/requests")
    async def new_request(body: NewRequest) -> dict:
        if body.model not in MODELS or body.effort not in EFFORTS:
            raise fail(ValueError("Unknown model or effort."))
        data = body.model_dump()
        data["prompt"] = data["prompt"].strip()
        data["title"] = " ".join(data["prompt"].split())[:48]
        if body.kind == "template":
            try:
                listing = await studio.template_listing()
            except TemplateError as error:
                raise fail(error, 502)
            entry = next((t for t in listing if t["id"] == body.templateId), None)
            if entry is None:
                raise fail(ValueError(f"The library has no template {body.templateId!r}."))
            if not body.languages:
                raise fail(ValueError("Name at least one language to write the sample in."))
            data["instructions"] = data["prompt"]
            shown = ", ".join(body.languages) if len(body.languages) <= 3 else f"{len(body.languages)} languages"
            data["title"] = f"{entry['name']['en']} · {shown}"
            data.pop("group")
            data.pop("count")
        else:
            if len(data["prompt"]) < 3:
                raise fail(ValueError("Say what to make."))
            data.pop("templateId")
        return studio.start_request(data)

    @app.post("/api/requests/{rid}/more")
    async def more(rid: str, body: More) -> dict:
        try:
            return studio.more(rid, body.count)
        except StudioError as error:
            raise fail(error)

    @app.post("/api/requests/{rid}/cancel")
    async def cancel_request(rid: str) -> dict:
        request = store.requests.get(rid)
        if not request:
            raise fail(StudioError("No such request."), 404)
        studio.cancel(rid)
        for vid in request["variantIds"]:
            studio.cancel(vid)
        return {"ok": True}

    @app.delete("/api/requests/{rid}")
    async def delete_request(rid: str) -> dict:
        studio.delete_request(rid)
        return {"ok": True}

    # ------------------------------------------------------------------ variants

    def act(action, *args) -> dict:
        try:
            action(*args)
        except StudioError as error:
            raise fail(error)
        return {"ok": True}

    @app.post("/api/variants/{vid}/retry")
    async def retry(vid: str) -> dict:
        return act(studio.retry, vid)

    @app.post("/api/variants/{vid}/cancel")
    async def cancel_variant(vid: str) -> dict:
        studio.cancel(vid)
        return {"ok": True}

    @app.post("/api/variants/{vid}/refine")
    async def refine(vid: str, body: Feedback) -> dict:
        return act(studio.refine, vid, body.feedback.strip())

    @app.post("/api/variants/{vid}/image")
    async def new_image(vid: str, body: ImageRequest) -> dict:
        return act(studio.new_image, vid, body.instruction.strip() or None)

    @app.post("/api/variants/{vid}/approve")
    async def approve(vid: str, body: Flag) -> dict:
        return act(studio.approve, vid, body.value)

    @app.post("/api/variants/{vid}/discard")
    async def discard(vid: str, body: Flag) -> dict:
        return act(studio.discard, vid, body.value)

    @app.get("/api/variants/{vid}/render-input")
    async def render_input(vid: str) -> dict:
        try:
            return studio.render_input(vid)
        except StudioError as error:
            raise fail(error, 404)

    @app.get("/api/variants/{vid}/result")
    async def result(vid: str) -> JSONResponse:
        variant = store.variants.get(vid)
        render = (variant or {}).get("render") or {}
        data = (
            read_json(render_dir(store.work_dir(variant), render["revision"]) / "result.json")
            if variant and render.get("revision")
            else None
        )
        if not isinstance(data, dict):
            raise fail(StudioError("No render yet."), 404)
        return JSONResponse(data, headers={"Cache-Control": "no-store"})

    @app.get("/api/variants/{vid}/files/{name:path}")
    async def variant_file(vid: str, name: str) -> FileResponse:
        variant = store.variants.get(vid)
        if not variant:
            raise fail(StudioError("No such variant."), 404)
        work = store.work_dir(variant).resolve()
        path = (work / name).resolve()
        if not path.is_relative_to(work) or not path.is_file():
            raise fail(StudioError("No such file."), 404)
        return FileResponse(path, headers={"Cache-Control": "no-store"})

    # ------------------------------------------------------------------ publishing

    @app.post("/api/upload")
    async def upload(body: PublishItems) -> dict:
        """Sends the approved work (or the variants named) to the library's upload API."""
        vids = body.variantIds
        if vids is None:
            vids = [v["id"] for v in store.variants.values() if v.get("approved") and not v.get("discarded")]
        return {"items": await library.upload(vids)}

    @app.post("/api/settings/library")
    async def library_settings(body: LibrarySettings) -> dict:
        # Kept in this process's memory only; never written to disk.
        settings.library_key = body.key.strip() or settings.library_key
        if body.url.strip():
            settings.library_url = body.url.strip()
        return {"url": settings.library_url, "key": bool(settings.library_key)}

    @app.post("/api/publish/prepare")
    async def prepare(body: PublishItems) -> dict:
        vids = body.variantIds
        if vids is None:
            vids = [v["id"] for v in store.variants.values() if v.get("approved") and not v.get("discarded")]
        try:
            await library.prepare(vids)
        except LibraryError as error:
            raise fail(error)
        return library.state

    @app.post("/api/publish/confirm")
    async def confirm() -> dict:
        try:
            await library.confirm()
        except LibraryError as error:
            raise fail(error)
        return library.state

    @app.post("/api/publish/cancel")
    async def cancel_publish() -> dict:
        try:
            await library.cancel()
        except LibraryError as error:
            raise fail(error)
        return library.state

    @app.post("/api/settings/cloudflare")
    async def cloudflare(body: CloudflareSettings) -> dict:
        # Kept in this process's memory only; never written to disk.
        settings.cloudflare_token = body.token.strip() or None
        if body.accountId.strip():
            settings.cloudflare_account_id = body.accountId.strip()
        return {"accountId": settings.cloudflare_account_id, "token": bool(settings.cloudflare_token)}

    # ------------------------------------------------------------------ pages

    def page(name: str):
        file = settings.web_dist / name
        if file.is_file():
            return FileResponse(file, headers={"Cache-Control": "no-cache"})
        return HTMLResponse(
            "<!doctype html><meta charset=utf-8><title>Slidr Studio</title>"
            "<p style='font-family:system-ui;padding:2rem'>The pages are not built. Run "
            "<code>pnpm build</code>, or open the Vite dev server "
            "(<code>pnpm dev</code>, http://127.0.0.1:5175).</p>",
            status_code=503,
        )

    @app.get("/")
    async def index():
        return page("index.html")

    @app.get("/render.html")
    async def render_page():
        return page("render.html")

    @app.get("/{name:path}")
    async def static(name: str):
        if name.startswith("api/"):
            raise fail(StudioError("Not found."), 404)
        dist = settings.web_dist.resolve()
        path = (dist / name).resolve()
        if path.is_relative_to(dist) and path.is_file():
            immutable = name.startswith("assets/")
            return FileResponse(
                path,
                headers={"Cache-Control": "public, max-age=31536000, immutable" if immutable else "no-cache"},
            )
        return page("index.html")

    return app

