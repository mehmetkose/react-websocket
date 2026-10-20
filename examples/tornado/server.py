#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["tornado>=6.5,<7"]
# ///
"""The WebSocket server for the react-websocket Tornado example.

A broadcast chat on ws://localhost:8888/live: every message is sent to every client. The page
itself is served by Vite (`npm run example:tornado`).
"""

import argparse
import asyncio
import contextlib
import logging
from urllib.parse import urlparse

import tornado.web
import tornado.websocket

log = logging.getLogger("chat")
clients: set["ChatHandler"] = set()


class ChatHandler(tornado.websocket.WebSocketHandler):
    def check_origin(self, origin: str) -> bool:
        # Vite serves the page from another port, which the default same-origin check turns
        # down. In production, serve the page from this server and drop this method.
        return urlparse(origin).hostname in {"localhost", "127.0.0.1", "::1"}

    def open(self) -> None:
        clients.add(self)
        log.info("client joined, %d online", len(clients))

    def on_close(self) -> None:
        clients.discard(self)
        log.info("client left, %d online", len(clients))

    def on_message(self, message: str | bytes) -> None:
        for client in list(clients):
            # A client that is closing is removed by its on_close.
            with contextlib.suppress(tornado.websocket.WebSocketClosedError):
                client.write_message(message, binary=isinstance(message, bytes))


def make_app() -> tornado.web.Application:
    return tornado.web.Application(
        [(r"/live", ChatHandler)],
        # Restart when this file changes.
        autoreload=True,
        # Ping every client, and close the ones that don't answer, so a connection that died
        # without closing doesn't stay in `clients`.
        websocket_ping_interval=10,
        # Every message goes to every client, so keep them small.
        websocket_max_message_size=64 * 1024,
    )


async def main(port: int) -> None:
    make_app().listen(port, address="localhost")
    log.info("WebSocket server running on ws://localhost:%d/live", port)
    await asyncio.Event().wait()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="The Tornado example's broadcast chat server.")
    parser.add_argument("--port", type=int, default=8888, help="port to listen on (default: 8888)")
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s", datefmt="%H:%M:%S")
    with contextlib.suppress(KeyboardInterrupt):
        asyncio.run(main(args.port))
