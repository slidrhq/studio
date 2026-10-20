"""One picture from the Codex CLI, on the user's ChatGPT sign-in, as the app makes it
(`src-tauri/src/image_providers/codex_cli.rs`, ADR-004):

```text
codex exec --json --skip-git-repo-check --ignore-user-config --ignore-rules --ephemeral
      -s read-only "<prompt>" [-i <reference image>]
cwd: an empty temp folder      stdin: closed      stdout: one JSON event per line
```

The CLI's agent calls its image tool, which writes to `$CODEX_HOME/generated_images/<thread>/`;
the thread id is in the first event. The folder is read, then removed.
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import shutil
import tempfile
import uuid
from collections import deque
from dataclasses import dataclass
from pathlib import Path

from .programs import creation_flags, find_codex

#: Without it the agent sometimes writes code that draws the picture instead of calling its image
#: tool (the app's spike WG0-S4). Starting with a word also keeps the prompt from reading as a flag.
RULE = (
    "Use your image generation tool. Do not write or run any code. When the image exists, "
    "reply with only its file path."
)
#: The aspect is set by the wording; the size is whatever the model then chooses.
SHAPES = {
    "wide": "wide 16:9 landscape",
    "landscape": "4:3 landscape",
    "square": "square 1:1",
    "portrait": "3:4 portrait",
    "tall": "tall 9:16 portrait",
}
MAX_PROMPT_CHARS = 8000
#: An image takes 43 to 95 seconds (ADR-004); past this the run is taken for hung.
RUN_TIMEOUT = 300.0
STDERR_LINES = 12
_THREAD = re.compile(r"^[A-Za-z0-9-]{1,64}$")


class CodexError(Exception):
    def __init__(self, message: str, kind: str = "generation_failed") -> None:
        super().__init__(message)
        self.kind = kind


def generate_prompt(prompt: str, aspect: str) -> str:
    shape = SHAPES.get(aspect, SHAPES["wide"])
    return f"{RULE} Create ONE {shape} image: {prompt.strip()}"


def edit_prompt(instruction: str) -> str:
    return (
        f"{RULE} Edit the attached image, keeping its aspect ratio. Produce ONE image. "
        f"The edit: {instruction.strip()}"
    )


def build_args(program: str, prompt: str, reference: Path | None) -> list[str]:
    # The prompt goes before `-i`: the flag takes any number of files and would take a prompt
    # after it for one of them.
    args = [
        program, "exec", "--json", "--skip-git-repo-check", "--ignore-user-config",
        "--ignore-rules", "--ephemeral", "-s", "read-only", prompt,
    ]
    if reference:
        args += ["-i", str(reference)]
    return args


def classify(said: str) -> str:
    said = said.lower()
    if any(w in said for w in ("unauthorized", "status 401", '"status":401', "not logged in",
                                "sign in again", "refresh token")):
        return "not_logged_in"
    if any(w in said for w in ("too many requests", "status 429", '"status":429', "usage limit",
                                "usage_limit", "rate limit", "rate_limit", "quota")):
        return "quota"
    return "generation_failed"


def failure(said: str) -> CodexError:
    kind = classify(said)
    said = said[:400]
    if kind == "not_logged_in":
        return CodexError(f"The Codex CLI is not signed in. Run `codex login`. The CLI said: {said}", kind)
    if kind == "quota":
        return CodexError(f"The usage limit of the ChatGPT plan was reached. The CLI said: {said}", kind)
    return CodexError(f"Codex could not make the image: {said}", kind)


@dataclass
class Transcript:
    thread_id: str | None = None
    last_message: str | None = None
    completed: bool = False
    failure: str | None = None
    last_error: str | None = None

    def read(self, line: str) -> None:
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            return
        if not isinstance(event, dict):
            return
        kind = event.get("type")
        if kind == "thread.started":
            thread = event.get("thread_id")
            # The id becomes a folder name: anything but a plain token could point elsewhere.
            self.thread_id = thread if isinstance(thread, str) and _THREAD.match(thread) else None
        elif kind == "item.completed" and (event.get("item") or {}).get("type") == "agent_message":
            self.last_message = (event.get("item") or {}).get("text")
        elif kind == "turn.completed":
            self.completed = True
        elif kind == "turn.failed":
            self.failure = str(((event.get("error") or {}).get("message")) or "")
        elif kind == "error":
            self.last_error = event.get("message")


def pick(files: list[Path], said: str | None) -> Path | None:
    """Of several files, the one the agent named; when it named none, the newest."""
    files = sorted(files, key=lambda f: (f.stat().st_mtime, f.name))
    if said:
        for file in reversed(files):
            if file.name in said:
                return file
    return files[-1] if files else None


def codex_home() -> Path:
    home = os.environ.get("CODEX_HOME")
    return Path(home) if home else Path.home() / ".codex"


async def make_image(
    prompt: str,
    out: Path,
    *,
    aspect: str = "wide",
    reference: Path | None = None,
    timeout: float = RUN_TIMEOUT,
) -> Path:
    """Generates (or, with a reference, regenerates after it) one picture into `out`."""
    text = edit_prompt(prompt) if reference else generate_prompt(prompt, aspect)
    if len(text) > MAX_PROMPT_CHARS or "\0" in text:
        raise CodexError(f"The image prompt must be at most {MAX_PROMPT_CHARS} characters.", "invalid_input")
    program = find_codex()
    if not program:
        raise CodexError(
            "The Codex CLI was not found. Install it (`npm install -g @openai/codex`), then run "
            "`codex login`.",
            "not_installed",
        )
    env = os.environ.copy()
    # The promise is the ChatGPT sign-in: a key that happens to be set must not bill by use.
    env.pop("CODEX_API_KEY", None)
    env.pop("OPENAI_API_KEY", None)
    workdir = Path(tempfile.gettempdir()) / f"slidr-studio-image-{uuid.uuid4().hex}"
    workdir.mkdir(parents=True)
    transcript = Transcript()
    stderr_tail: deque[str] = deque(maxlen=STDERR_LINES)
    process = await asyncio.create_subprocess_exec(
        *build_args(str(program), text, reference),
        cwd=str(workdir),
        stdin=asyncio.subprocess.DEVNULL,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        limit=16 * 1024 * 1024,
        env=env,
        creationflags=creation_flags(),
    )

    async def read_out() -> None:
        assert process.stdout
        while line := await process.stdout.readline():
            transcript.read(line.decode("utf-8", "replace"))

    async def read_err() -> None:
        assert process.stderr
        while line := await process.stderr.readline():
            said = line.decode("utf-8", "replace").strip()
            if said:
                stderr_tail.append(said)

    folder: Path | None = None
    try:
        try:
            await asyncio.wait_for(asyncio.gather(read_out(), read_err(), process.wait()), timeout)
        except asyncio.TimeoutError:
            raise CodexError(f"Codex did not finish within {int(timeout)} seconds and was stopped.", "timeout")
        if transcript.thread_id:
            folder = codex_home() / "generated_images" / transcript.thread_id
        if transcript.failure is not None:
            raise failure(transcript.failure)
        if not (transcript.completed and process.returncode == 0):
            said = transcript.last_error or " ".join(stderr_tail)
            raise failure(f"the CLI stopped with exit code {process.returncode} before it was done. {said}")
        files = [f for f in folder.iterdir() if f.is_file()] if folder and folder.is_dir() else []
        chosen = pick(files, transcript.last_message)
        if not chosen:
            said = (transcript.last_message or "nothing")[:400]
            raise CodexError(f"Codex finished without making an image. It said: {said}")
        out.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(chosen, out)
        return out
    finally:
        if process.returncode is None:
            process.kill()
            await process.wait()
        if folder:
            shutil.rmtree(folder, ignore_errors=True)
        shutil.rmtree(workdir, ignore_errors=True)
