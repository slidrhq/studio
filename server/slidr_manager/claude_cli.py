"""One `claude -p` turn, with stream-json out, on the user's Claude Code sign-in.

```text
claude -p --output-format stream-json --verbose --restricted --strict-mcp-config
       --disable-slash-commands --tools <list> --allowedTools <list> --permission-mode dontAsk
       --system-prompt-file <file> (--session-id <uuid> | --resume <uuid>)
       [--model m] [--effort e] [--json-schema s]
stdin: the prompt, then closed       cwd: the job's folder (the only one its file tools reach)
```

The CLI keeps a conversation under `~/.claude/projects/<cwd>/`, so a session resumes only from
the folder it started in: each variant has its own folder and keeps it.
"""

from __future__ import annotations

import asyncio
import json
import os
from collections import deque
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from .programs import creation_flags, find_claude

#: A line of stream-json can hold a whole file the agent read, or a picture as base64.
LINE_LIMIT = 64 * 1024 * 1024
STDERR_LINES = 20

Activity = Callable[[str, str], None]


class ClaudeError(Exception):
    pass


@dataclass
class ClaudeCall:
    prompt: str
    cwd: Path
    system_prompt_file: Path
    tools: list[str] = field(default_factory=list)
    #: A new conversation under this id, or the one to continue.
    session_id: str | None = None
    resume: str | None = None
    model: str | None = None
    effort: str | None = None
    json_schema: dict | None = None
    timeout: float = 30 * 60


@dataclass
class ClaudeResult:
    session_id: str | None
    text: str
    structured: Any
    cost: float
    turns: int


def build_args(program: str, call: ClaudeCall) -> list[str]:
    args = [
        program,
        "-p",
        "--output-format",
        "stream-json",
        "--verbose",
        "--restricted",
        "--strict-mcp-config",
        "--disable-slash-commands",
        "--tools",
        ",".join(call.tools),
    ]
    if call.tools:
        args += ["--allowedTools", *call.tools]
    args += ["--permission-mode", "dontAsk", "--system-prompt-file", str(call.system_prompt_file)]
    if call.resume:
        args += ["--resume", call.resume]
    elif call.session_id:
        args += ["--session-id", call.session_id]
    if call.model:
        args += ["--model", call.model]
    if call.effort:
        args += ["--effort", call.effort]
    if call.json_schema is not None:
        args += ["--json-schema", json.dumps(call.json_schema, separators=(",", ":"))]
    return args


def describe_tool(name: str, data: dict) -> str:
    """A tool call in a few words, for the activity log."""
    path = data.get("file_path") or data.get("path") or data.get("pattern")
    if isinstance(path, str):
        return f"{name} {Path(path).name}"
    return name


class Transcript:
    """What the stream-json lines of a turn said."""

    def __init__(self, on_activity: Activity | None = None) -> None:
        self.session_id: str | None = None
        self.result: dict | None = None
        self.on_activity = on_activity

    def read(self, line: str) -> None:
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            return
        if not isinstance(event, dict):
            return
        kind = event.get("type")
        if kind == "system" and event.get("subtype") == "init":
            self.session_id = event.get("session_id") or self.session_id
        elif kind == "assistant":
            for part in (event.get("message") or {}).get("content") or []:
                if not isinstance(part, dict):
                    continue
                if part.get("type") == "tool_use" and self.on_activity:
                    if part.get("name") != "StructuredOutput":
                        self.on_activity("tool", describe_tool(part.get("name", "?"), part.get("input") or {}))
                elif part.get("type") == "text" and self.on_activity:
                    text = (part.get("text") or "").strip()
                    if text:
                        self.on_activity("text", text[:600])
        elif kind == "result":
            self.result = event
            self.session_id = event.get("session_id") or self.session_id


async def run(call: ClaudeCall, on_activity: Activity | None = None) -> ClaudeResult:
    program = find_claude()
    if not program:
        raise ClaudeError("Claude Code was not found. Install it and run `claude` once to sign in.")
    call.cwd.mkdir(parents=True, exist_ok=True)
    env = os.environ.copy()
    # Calls that wait on nothing but the model; a long one is not a hung one.
    env.setdefault("BASH_DEFAULT_TIMEOUT_MS", "600000")
    process = await asyncio.create_subprocess_exec(
        *build_args(str(program), call),
        cwd=str(call.cwd),
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        limit=LINE_LIMIT,
        env=env,
        creationflags=creation_flags(),
    )
    transcript = Transcript(on_activity)
    stderr_tail: deque[str] = deque(maxlen=STDERR_LINES)

    async def feed() -> None:
        assert process.stdin
        process.stdin.write(call.prompt.encode("utf-8"))
        await process.stdin.drain()
        process.stdin.close()

    async def read_out() -> None:
        assert process.stdout
        while True:
            line = await process.stdout.readline()
            if not line:
                break
            transcript.read(line.decode("utf-8", "replace"))

    async def read_err() -> None:
        assert process.stderr
        while True:
            line = await process.stderr.readline()
            if not line:
                break
            text = line.decode("utf-8", "replace").strip()
            if text:
                stderr_tail.append(text)

    try:
        await asyncio.wait_for(
            asyncio.gather(feed(), read_out(), read_err(), process.wait()), call.timeout
        )
    except asyncio.TimeoutError:
        raise ClaudeError(f"Claude did not finish within {int(call.timeout)} seconds and was stopped.")
    finally:
        if process.returncode is None:
            process.kill()
            await process.wait()

    result = transcript.result
    if not result:
        said = " ".join(stderr_tail) or "no result"
        raise ClaudeError(f"Claude stopped (exit code {process.returncode}) before it was done: {said[:600]}")
    if result.get("is_error") or result.get("subtype") != "success":
        said = result.get("result") or result.get("subtype") or "an error"
        raise ClaudeError(f"Claude could not finish: {str(said)[:600]}")
    return ClaudeResult(
        session_id=transcript.session_id,
        text=str(result.get("result") or ""),
        structured=result.get("structured_output"),
        cost=float(result.get("total_cost_usd") or 0),
        turns=int(result.get("num_turns") or 0),
    )
