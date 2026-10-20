"""Changes, pushed to every open page over server-sent events."""

from __future__ import annotations

import asyncio
import json
from typing import Any


class EventBus:
    def __init__(self) -> None:
        self._queues: set[asyncio.Queue[str]] = set()

    def publish(self, event: dict[str, Any]) -> None:
        data = json.dumps(event, ensure_ascii=False)
        for queue in list(self._queues):
            try:
                queue.put_nowait(data)
            except asyncio.QueueFull:
                # A page that stopped reading loses events; it reloads the state on reconnect.
                pass

    def subscribe(self) -> asyncio.Queue[str]:
        queue: asyncio.Queue[str] = asyncio.Queue(maxsize=1000)
        self._queues.add(queue)
        return queue

    def unsubscribe(self, queue: asyncio.Queue[str]) -> None:
        self._queues.discard(queue)
