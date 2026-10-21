"""Where things are, and what can be changed through the environment.

Every path has a default that works from a clone of this repository. The media library is read
where it is published (`SLIDR_MEDIA_URL`), and written only through Slidr Library's API
(`SLIDR_LIBRARY_URL`): there is no copy of it here. The app's packages and instructions the
studio uses are copied in `vendor/` (vendor/README.md).
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

STUDIO = Path(__file__).resolve().parents[2]
WEB = STUDIO / "web"
#: The app's code the studio uses, at its paths in the app's repository (vendor/README.md).
VENDOR = STUDIO / "vendor"

DEFAULT_MEDIA_URL = "https://slidr-media.pages.dev/"
#: Slidr Library, whose upload API takes the studio's work (`uploads.py`).
DEFAULT_LIBRARY_URL = "https://library.slidr.workers.dev/"


def _path(name: str, default: Path) -> Path:
    value = os.environ.get(name)
    return Path(value).resolve() if value else default


@dataclass
class Settings:
    host: str = field(default_factory=lambda: os.environ.get("SLIDR_STUDIO_HOST", "127.0.0.1"))
    port: int = field(default_factory=lambda: int(os.environ.get("SLIDR_STUDIO_PORT", "8765")))
    #: Requests, variants, their files and logs. Never published.
    data: Path = field(default_factory=lambda: _path("SLIDR_STUDIO_DATA", STUDIO / ".data"))
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
    #: The library whose API the approved work is uploaded to, and the studio's key to it (the
    #: Worker's `LIBRARY_KEYS`, `studio=<key>`). The key is kept in memory only, unless it came
    #: from the environment.
    library_url: str = field(
        default_factory=lambda: os.environ.get("SLIDR_LIBRARY_URL", DEFAULT_LIBRARY_URL)
    )
    library_key: str | None = field(
        default_factory=lambda: os.environ.get("SLIDR_LIBRARY_KEY") or None
    )

    @property
    def render_url(self) -> str:
        return (self.ui_url or f"http://{self.host}:{self.port}").rstrip("/")

    @property
    def requests_dir(self) -> Path:
        return self.data / "requests"
