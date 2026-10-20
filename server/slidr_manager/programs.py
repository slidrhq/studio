"""Finding the programs the studio runs: Claude Code, the Codex CLI and Node.

Searched as the app searches (`src-tauri/src/harness/setup.rs`): the PATH, then the places
installers put programs without adding them to it. The Codex CLI is also found inside the
ChatGPT extension of VS Code, which ships the same native program. `CLAUDE_PATH`, `CODEX_PATH`
and `NODE_PATH_EXE` name a program outright.
"""

from __future__ import annotations

import asyncio
import os
import shutil
import sys
from dataclasses import dataclass
from pathlib import Path

WINDOWS = sys.platform == "win32"
#: Windows: start a program without a console window.
CREATE_NO_WINDOW = 0x08000000 if WINDOWS else 0


def creation_flags() -> int:
    return CREATE_NO_WINDOW


def search_paths() -> list[Path]:
    paths = [Path(p) for p in os.environ.get("PATH", "").split(os.pathsep) if p]
    home = os.environ.get("USERPROFILE") or os.environ.get("HOME")
    if home:
        paths.append(Path(home) / ".local" / "bin")
    if local := os.environ.get("LOCALAPPDATA"):
        paths.append(Path(local) / "Microsoft" / "WinGet" / "Links")
    if programs := os.environ.get("ProgramFiles"):
        paths.append(Path(programs) / "WinGet" / "Links")
    if roaming := os.environ.get("APPDATA"):
        paths.append(Path(roaming) / "npm")
    return paths


def _exe(name: str) -> str:
    return f"{name}.exe" if WINDOWS else name


def find_claude() -> Path | None:
    if named := os.environ.get("CLAUDE_PATH"):
        return Path(named)
    for directory in search_paths():
        candidate = directory / _exe("claude")
        if candidate.is_file():
            return candidate
    found = shutil.which("claude")
    return Path(found) if found else None


_CODEX_TARGETS = {
    ("win32", "AMD64"): ("codex-win32-x64", "x86_64-pc-windows-msvc", "windows-x86_64"),
    ("win32", "ARM64"): ("codex-win32-arm64", "aarch64-pc-windows-msvc", "windows-aarch64"),
    ("darwin", "x86_64"): ("codex-darwin-x64", "x86_64-apple-darwin", "macos-x86_64"),
    ("darwin", "arm64"): ("codex-darwin-arm64", "aarch64-apple-darwin", "macos-aarch64"),
    ("linux", "x86_64"): ("codex-linux-x64", "x86_64-unknown-linux-musl", "linux-x86_64"),
    ("linux", "aarch64"): ("codex-linux-arm64", "aarch64-unknown-linux-musl", "linux-aarch64"),
}


def _codex_target() -> tuple[str, str, str] | None:
    import platform

    return _CODEX_TARGETS.get((sys.platform, platform.machine()))


def _native_from_package(package: Path, target: tuple[str, str, str]) -> Path | None:
    """The native program behind npm's shim, looked up as the package's own codex.js does."""
    platform_package, triple, _ = target
    program = Path("vendor") / triple / "bin" / _exe("codex")
    for directory in [package, *list(package.parents)[:3]]:
        candidate = directory / "node_modules" / "@openai" / platform_package / program
        if candidate.is_file():
            return candidate
    candidate = package / program
    return candidate if candidate.is_file() else None


def find_codex() -> Path | None:
    """The native Codex program. npm's `codex.cmd` is never started: cmd.exe's quoting would
    stand between the studio and a free-text prompt, and ending it would leave codex running."""
    if named := os.environ.get("CODEX_PATH"):
        return Path(named)
    target = _codex_target()
    for directory in search_paths():
        native = directory / _exe("codex")
        if native.is_file() and (not WINDOWS or native.suffix == ".exe"):
            return native
        if target and (directory / ("codex.cmd" if WINDOWS else "codex")).is_file():
            found = _native_from_package(directory / "node_modules" / "@openai" / "codex", target)
            if found:
                return found
    # The ChatGPT extension of VS Code carries the CLI: the newest installed version.
    home = os.environ.get("USERPROFILE") or os.environ.get("HOME")
    if home and target:
        extensions = Path(home) / ".vscode" / "extensions"
        if extensions.is_dir():
            candidates = sorted(
                (p for p in extensions.glob(f"openai.chatgpt-*/bin/{target[2]}/{_exe('codex')}")),
                key=lambda p: p.stat().st_mtime,
            )
            if candidates:
                return candidates[-1]
    return None


def find_node() -> Path | None:
    if named := os.environ.get("NODE_PATH_EXE"):
        return Path(named)
    found = shutil.which("node")
    return Path(found) if found else None


@dataclass
class ProgramStatus:
    name: str
    path: str | None
    version: str | None
    ready: bool
    note: str | None = None

    def as_dict(self) -> dict:
        return self.__dict__.copy()


async def _output(args: list[str], timeout: float = 20) -> tuple[int, str]:
    process = await asyncio.create_subprocess_exec(
        *args,
        stdin=asyncio.subprocess.DEVNULL,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.STDOUT,
        creationflags=creation_flags(),
    )
    try:
        out, _ = await asyncio.wait_for(process.communicate(), timeout)
    except asyncio.TimeoutError:
        process.kill()
        await process.wait()
        return -1, "no answer in time"
    return process.returncode or 0, out.decode("utf-8", "replace").strip()


async def probe() -> list[ProgramStatus]:
    """What is installed and signed in, for the studio's status line."""
    statuses: list[ProgramStatus] = []

    claude = find_claude()
    if claude:
        code, said = await _output([str(claude), "--version"])
        statuses.append(
            ProgramStatus("claude", str(claude), said if code == 0 else None, code == 0,
                          None if code == 0 else said[:300])
        )
    else:
        statuses.append(ProgramStatus(
            "claude", None, None, False,
            "Claude Code was not found. Install it and run `claude` once to sign in.",
        ))

    codex = find_codex()
    if codex:
        code, said = await _output([str(codex), "--version"])
        login_code, login = await _output([str(codex), "login", "status"])
        signed_in = login_code == 0 and "logged in" in login.lower()
        statuses.append(ProgramStatus(
            "codex", str(codex), said if code == 0 else None, code == 0 and signed_in,
            None if signed_in else (login or "Run `codex login` and sign in with ChatGPT.")[:300],
        ))
    else:
        statuses.append(ProgramStatus(
            "codex", None, None, False,
            "The Codex CLI was not found. Install it (`npm install -g @openai/codex`) and run "
            "`codex login`.",
        ))

    node = find_node()
    if node:
        code, said = await _output([str(node), "--version"])
        statuses.append(ProgramStatus("node", str(node), said if code == 0 else None, code == 0))
    else:
        statuses.append(ProgramStatus("node", None, None, False, "Node.js was not found."))
    return statuses
