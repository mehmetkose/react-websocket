# react-websocket Tornado example

A small broadcast chat: a [Tornado](https://www.tornadoweb.org/) WebSocket server plus a Vite + React 19 client.

The server runs with [uv](https://docs.astral.sh/uv/getting-started/installation/). Its dependencies are declared at the top of `server.py` ([inline script metadata](https://packaging.python.org/en/latest/specifications/inline-script-metadata/)) and pinned in `server.py.lock`, so `uv run` sets up the environment itself. It also downloads Python 3.11+ if you don't have it. You don't need a virtualenv or `pip install`.

```sh
# From the repository root.
# 1. WebSocket server on ws://localhost:8888/live
npm run example:tornado:server

# 2. In another terminal: the client on http://localhost:5173
npm run example:tornado
```

Open it in two tabs and send messages. Stop the server to watch the client go to `reconnecting`. Messages you send meanwhile are queued and sent once it's back, to every tab that is connected by then (the server keeps no history). The server restarts itself when you edit `server.py`.

To use another port, pass it to the server and point the client at it:

```sh
uv run examples/tornado/server.py --port 9000
VITE_WS_URL=ws://localhost:9000/live npm run example:tornado
```

## Files

```
server.py         The Tornado server: the broadcast chat on /live, with its dependencies inline
server.py.lock    The pinned dependencies uv runs it with
App.tsx           The page: status, the composer and the messages
```

The client imports the library from `../../src`, so it runs your working copy without a build.

## How the server works

`ChatHandler` adds each socket to a set in `open`, removes it in `on_close`, and sends every message to every socket in the set. Text messages go out as text and binary messages as binary.

- **Origins.** Tornado turns down a WebSocket whose `Origin` doesn't match its `Host`. Vite serves the page from another port, so `check_origin` allows any `localhost` origin. In production, serve the page from the same origin and delete `check_origin`, or check against your own domains.
- **Dead connections.** `websocket_ping_interval=10` pings every client every 10 seconds and closes the ones that don't answer in time. Without it, a connection that died without closing (a laptop that went to sleep, a dropped network) stays in the set.
- **Message size.** Each message goes to every client, so `websocket_max_message_size` caps it at 64 KiB. Tornado's default is 10 MiB. A larger message closes the connection with code 1009, and the client reconnects.

## Updating Tornado

```sh
uv lock --script examples/tornado/server.py --upgrade
```

This moves `server.py.lock` to the newest Tornado that matches `tornado>=6.5,<7` in `server.py`.

## Without uv

```sh
pip install "tornado>=6.5,<7"
python3 examples/tornado/server.py
```
