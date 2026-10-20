"""Where things are, and what can be changed through the environment.

Every path has a default that works from a clone of this repository with the media library's
author copy beside it (`../Slidr-media`, docs/media-library.md of the app). The app's packages,
scripts and instructions the studio uses are copied in `vendor/` (vendor/README.md).
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

STUDIO = Path(__file__).resolve().parents[2]
WEB = STUDIO / "web"
#: The app's code the studio uses, at its paths in the app's repository (vendor/README.md).
VENDOR = STUDIO / "vendor"

#: The Cloudflare account of the media library (docs/media-library.md). Not a secret.
DEFAULT_ACCOUNT_ID = "d3a1982ae102ceb45926da85e92d6edf"
DEFAULT_MEDIA_URL = "https://slidr-media.pages.dev/"


def _path(name: str, default: Path) -> Path:
    value = os.environ.get(name)
    return Path(value).resolve() if value else default


@dataclass
class Settings:
    host: str = field(default_factory=lambda: os.environ.get("SLIDR_STUDIO_HOST", "127.0.0.1"))
    port: int = field(default_factory=lambda: int(os.environ.get("SLIDR_STUDIO_PORT", "8765")))
    #: Requests, variants, their files and logs. Never published.
    data: Path = field(default_factory=lambda: _path("SLIDR_STUDIO_DATA", STUDIO / ".data"))
    #: The author copy of the media library that `pnpm media:publish` stages from.
    media_dir: Path = field(
        default_factory=lambda: _path("SLIDR_MEDIA_DIR", STUDIO.parent / "Slidr-media")
    )
    media_url: str = field(
        default_factory=lambda: os.environ.get("SLIDR_MEDIA_URL", DEFAULT_MEDIA_URL)
    )
    #: The built pages of the studio (`pnpm build`).
    web_dist: Path = field(default_factory=lambda: WEB / "dist")
    #: Where the headless browser opens the render page. Defaults to this server; the Vite dev
    #: server (`http://127.0.0.1:5175`) while the pages are being worked on.
    ui_url: str | None = field(default_factory=lambda: os.environ.get("SLIDR_STUDIO_UI_URL"))
    #: Processes that may run at once. Four Codex images at a time is what the app measured
    #: (ADR-004).
    max_claude: int = field(default_factory=lambda: int(os.environ.get("SLIDR_STUDIO_MAX_CLAUDE", "4")))
    max_codex: int = field(default_factory=lambda: int(os.environ.get("SLIDR_STUDIO_MAX_CODEX", "4")))
    max_render: int = field(default_factory=lambda: int(os.environ.get("SLIDR_STUDIO_MAX_RENDER", "2")))
    #: The browser Playwright drives: the installed Edge needs no download.
    browser_channel: str = field(
        default_factory=lambda: os.environ.get("SLIDR_STUDIO_BROWSER", "msedge")
    )
    cloudflare_account_id: str = field(
        default_factory=lambda: os.environ.get("CLOUDFLARE_ACCOUNT_ID", DEFAULT_ACCOUNT_ID)
    )
    #: Kept in memory only, unless it came from the environment.
    cloudflare_token: str | None = field(
        default_factory=lambda: os.environ.get("CLOUDFLARE_API_TOKEN") or None
    )

    @property
    def render_url(self) -> str:
        return (self.ui_url or f"http://{self.host}:{self.port}").rstrip("/")

    @property
    def requests_dir(self) -> Path:
        return self.data / "requests"
