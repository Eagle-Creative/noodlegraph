# SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Noodlegraph-Commercial
# SPDX-FileCopyrightText: 2026 Eagle Creative
"""The noodlegraph demo with the Python runtime: a small host application as a server.

The main demo (``demo/`` in the project folder) runs everything in the browser. This one
shows the other arrangement: the editor in the browser, the engine in a Python process.

    python runtimes/python/demo/server.py     then open http://localhost:8765

It serves the page, hands the editor its blocks, saves the graph the editor sends
(``graphs/demo.yaml`` next to this file), runs it on the engine and streams what happens back to the
page. Only the standard library, pydantic and PyYAML are needed. Everything a real host
does is here in small: a context, own blocks, save, check, run, live events.
"""

from __future__ import annotations

import argparse
import asyncio
import contextlib
import json
import mimetypes
import sys
from http import HTTPStatus
from pathlib import Path
from typing import Any

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]  # the project folder: the page also needs editors/web
sys.path.insert(0, str(HERE.parent / "src"))
sys.path.insert(0, str(HERE))

from blocks import CHOICES, DEMO_BLOCKS, Stage  # noqa: E402

from noodlegraph import (  # noqa: E402
    STANDARD,
    Engine,
    GraphError,
    GraphFileError,
    GraphStore,
    catalogue,
    check,
    parse,
    parse_text,
    registry,
)

GRAPH_ID = "demo"
EXAMPLE = Path(__file__).with_name("example.json")


class Demo:
    """The host: one graph, one engine, one stage, and the pages that watch."""

    def __init__(self, folder: Path) -> None:
        self.pages: set[asyncio.Queue[str]] = set()
        self.stage = Stage(lambda state: self.send("stage", state))
        self.registry = registry(STANDARD, DEMO_BLOCKS)
        self.store = GraphStore(folder)
        self.engine = Engine(
            self.stage,
            self.registry,
            on_event=lambda _gid, event: self.send("event", event),
            on_status=lambda status: self.send("status", status),
        )
        graphs, _ = self.store.load()
        saved = next((g for g in graphs if g.id == GRAPH_ID), None)
        self.graph = saved or parse_text(EXAMPLE.read_text(encoding="utf-8"))

    def send(self, kind: str, data: Any) -> None:
        """Tell every open page (server-sent events)."""
        message = f"event: {kind}\ndata: {json.dumps(data)}\n\n"
        for queue in self.pages:
            queue.put_nowait(message)

    def state(self) -> dict[str, Any]:
        """What a page needs when it opens."""
        return {
            "blocks": catalogue(self.registry),
            "choices": CHOICES,
            "graph": self.graph.to_document(),
            "problems": check(self.graph, self.registry, self.stage).problems,
            "status": self.engine.status(),
            "stage": self.stage.state(),
        }

    async def call(self, path: str, body: dict[str, Any]) -> tuple[int, dict[str, Any]]:
        """One request of the page; the answer and its HTTP status."""
        try:
            if path == "/api/state":
                return 200, self.state()
            if path == "/api/graph":  # save: check it, keep it, run it from now on
                graph = parse({**body.get("graph", {}), "id": GRAPH_ID, "enabled": True})
                problems = check(graph, self.registry, self.stage).problems
                self.graph = graph
                self.store.save(graph)
                await self.engine.load([graph])
                return 200, {"graph": graph.to_document(), "problems": problems}
            if path == "/api/active":
                await (self.engine.activate() if body.get("active") else self.engine.deactivate())
                return 200, {"active": self.engine.active}
            if path == "/api/run":
                await self.engine.fire(GRAPH_ID, str(body.get("node", "")))
                return 200, {}
            if path == "/api/button":
                self.stage.press()
                return 200, {}
            if path == "/api/slider":
                self.stage.slider = min(max(float(body.get("value", 0)), 0.0), 100.0)
                return 200, {}
        except (GraphError, GraphFileError, ValueError) as exc:
            return 400, {"error": str(exc)}
        return 404, {"error": "no such address"}


# ---------------------------------------------------------------------- a very small web server
async def _reply(writer: asyncio.StreamWriter, status: int, kind: str, body: bytes) -> None:
    head = f"HTTP/1.1 {status} {HTTPStatus(status).phrase}\r\nContent-Type: {kind}\r\nContent-Length: {len(body)}\r\n"
    writer.write((head + "Cache-Control: no-store\r\nConnection: close\r\n\r\n").encode() + body)
    await writer.drain()


async def _events(demo: Demo, writer: asyncio.StreamWriter) -> None:
    """Keep the connection open and write every message for the pages into it."""
    head = "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nCache-Control: no-store\r\n\r\n"
    writer.write(head.encode())
    queue: asyncio.Queue[str] = asyncio.Queue()
    demo.pages.add(queue)
    try:
        while True:
            try:
                message = await asyncio.wait_for(queue.get(), 15)
            except TimeoutError:
                message = ": still here\n\n"
            writer.write(message.encode())
            await writer.drain()
    finally:
        demo.pages.discard(queue)


async def handle(demo: Demo, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
    """One connection: a file, an API call or the event stream."""
    try:
        request = (await reader.readline()).decode("latin-1").split()
        if len(request) < 2:
            return
        method, path = request[0], request[1].split("?", 1)[0]
        length = 0
        while (line := (await reader.readline()).decode("latin-1").strip()) != "":
            name, _, value = line.partition(":")
            if name.lower() == "content-length":
                length = int(value)
        raw = await reader.readexactly(length) if length else b""
        if path == "/api/events":
            await _events(demo, writer)
        elif path.startswith("/api/"):
            body = json.loads(raw) if raw else {}
            status, answer = await demo.call(path, body if isinstance(body, dict) else {})
            await _reply(writer, status, "application/json", json.dumps(answer).encode())
        elif method == "GET" and path == "/":  # the page lives in demo/, next to its files
            writer.write(
                b"HTTP/1.1 302 Found\r\nLocation: /runtimes/python/demo/\r\nContent-Length: 0\r\n\r\n"
            )
            await writer.drain()
        elif method == "GET":
            target = (ROOT / path.lstrip("/")).resolve()
            if target.is_dir():
                target = target / "index.html"
            if ROOT not in target.parents or not target.is_file():
                await _reply(writer, 404, "text/plain", b"not found")
                return
            kind = mimetypes.guess_type(target.name)[0] or "application/octet-stream"
            if target.suffix == ".js":
                kind = "text/javascript"
            await _reply(writer, 200, f"{kind}; charset=utf-8", target.read_bytes())
    except (
        ConnectionError,
        asyncio.IncompleteReadError,
        json.JSONDecodeError,
        ValueError,
    ):
        pass
    finally:
        with contextlib.suppress(Exception):
            writer.close()


async def main() -> None:
    """Serve until Ctrl+C."""
    parser = argparse.ArgumentParser(description="The noodlegraph demo.")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--graphs", type=Path, default=Path(__file__).with_name("graphs"))
    parser.add_argument(
        "--catalogue",
        action="store_true",
        help="write catalogue.json (for the page without this server) and stop",
    )
    args = parser.parse_args()
    demo = Demo(args.graphs)
    if args.catalogue:
        target = Path(__file__).with_name("catalogue.json")
        target.write_text(json.dumps(catalogue(demo.registry), indent=1), encoding="utf-8")
        print(f"wrote {target}")
        return
    await demo.engine.load([demo.graph])
    await demo.engine.activate()
    server = await asyncio.start_server(lambda r, w: handle(demo, r, w), args.host, args.port)
    print(f"noodlegraph demo: http://localhost:{args.port}  (Ctrl+C stops it)")
    async with server:
        await server.serve_forever()


if __name__ == "__main__":
    with contextlib.suppress(KeyboardInterrupt):
        asyncio.run(main())
