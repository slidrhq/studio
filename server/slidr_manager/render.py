"""Converting and rendering a design with the app's own engine, in a headless browser.

`web/tools/snap.mjs` opens the studio's render page (`render.html`) in the installed
Edge. The page converts the HTML file of every language of the variant with `@slidr/html-import`,
renders the slides with `@slidr/renderer`, runs the app's design check (`@slidr/lint`) and the
gallery's contract, and the script takes the pictures, two for each language:

```text
work/renders/r<n>/<lang>-full.png    1920×1080 (he-full.png, en-full.png, ar-full.png…)
work/renders/r<n>/<lang>-thumb.png   384 px wide, as the gallery shows a design
work/renders/r<n>/result.json        the slides, findings, conversion notes, subject point
```

Each revision has a folder of its own: on Windows a folder that something holds open (an
Explorer window, a file being read) cannot be emptied and written again. The last few are kept.
"""

from __future__ import annotations

import asyncio
import shutil
from pathlib import Path

from .config import WEB, Settings
from .programs import creation_flags, find_node
from .store import read_json

TIMEOUT = 240.0
KEEP = 3


def render_dir(work: Path, revision: int) -> Path:
    return work / "renders" / f"r{revision}"


def forget_old(work: Path, revision: int) -> None:
    for folder in (work / "renders").glob("r*"):
        number = folder.name[1:]
        if number.isdigit() and int(number) <= revision - KEEP:
            shutil.rmtree(folder, ignore_errors=True)


class RenderError(Exception):
    pass


async def snap(settings: Settings, vid: str, revision: int, out: Path) -> dict:
    node = find_node()
    if not node:
        raise RenderError("Node.js was not found; it drives the headless browser.")
    shutil.rmtree(out, ignore_errors=True)
    out.mkdir(parents=True, exist_ok=True)
    url = f"{settings.render_url}/render.html?v={vid}&rev={revision}"
    process = await asyncio.create_subprocess_exec(
        str(node), str(WEB / "tools" / "snap.mjs"),
        "--url", url, "--out", str(out), "--channel", settings.browser_channel,
        cwd=str(WEB),
        stdin=asyncio.subprocess.DEVNULL,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.STDOUT,
        creationflags=creation_flags(),
    )
    try:
        said, _ = await asyncio.wait_for(process.communicate(), TIMEOUT)
    except asyncio.TimeoutError:
        raise RenderError(f"The render did not finish within {int(TIMEOUT)} seconds.")
    finally:
        if process.returncode is None:
            process.kill()
            await process.wait()
    result = read_json(out / "result.json")
    if process.returncode != 0 or not isinstance(result, dict):
        text = said.decode("utf-8", "replace").strip()[-1200:]
        raise RenderError(f"The render failed: {text or 'no result'}")
    return result
