"""`python -m slidr_manager`: starts the studio and opens it in the browser."""

from __future__ import annotations

import argparse
import asyncio
import sys
import webbrowser

import uvicorn

from .app import create_app
from .config import Settings


def main() -> None:
    parser = argparse.ArgumentParser(prog="slidr_manager", description="Slidr Studio")
    parser.add_argument("--host", help="address to listen on (default 127.0.0.1)")
    parser.add_argument("--port", type=int, help="port (default 8765)")
    parser.add_argument("--no-open", action="store_true", help="do not open the browser")
    args = parser.parse_args()

    settings = Settings()
    if args.host:
        settings.host = args.host
    if args.port:
        settings.port = args.port
    app = create_app(settings)
    config = uvicorn.Config(app, host=settings.host, port=settings.port, log_level="warning")
    server = uvicorn.Server(config)
    url = f"http://{settings.host}:{settings.port}/"
    print(f"Slidr Studio: {url}  (data: {settings.data}, library copy: {settings.media_dir})")
    if not args.no_open:
        webbrowser.open(url)
    # The default loop of Windows (Proactor) is the one that runs subprocesses.
    if sys.platform == "win32":
        asyncio.set_event_loop_policy(asyncio.WindowsProactorEventLoopPolicy())
    asyncio.run(server.serve())


if __name__ == "__main__":
    main()
