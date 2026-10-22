---
title: 'A Python Tornado WebSocket server with a React client'
description: 'Connect a React app to a Python Tornado WebSocket server with react-websocket: a broadcast chat handler, origin checks, pings that drop dead connections, a message size limit, a heartbeat for the browser, and running it all with uv.'
---

# Tornado (Python)

react-websocket speaks plain WebSocket, so your server can be written in any language. This recipe pairs it with [Tornado](https://www.tornadoweb.org/), a Python web framework. The result is a small broadcast chat: every message goes to everyone who's connected.

It follows the repository's [Tornado example](https://github.com/mehmetkose/react-websocket/tree/main/examples/tornado). The server runs with [uv](https://docs.astral.sh/uv/getting-started/installation/), which sets up Python and Tornado by itself. Start it in two terminals:

```sh
# From the repository root.
# 1. The WebSocket server on ws://localhost:8888/live
npm run example:tornado:server

# 2. In another terminal: the client on http://localhost:5173
npm run example:tornado
```

Then open http://localhost:5173 in two tabs and send a message from each.

## The short version

- A `WebSocketHandler` with `open`, `on_close` and `on_message` is the whole server.
- Vite serves the page from another port, so in development the server has to accept that origin.
- Turn on `websocket_ping_interval`, so connections that died without closing get cleaned up.
- On the client, it's an ordinary `createWebSocket` with `json: true`. Nothing Python-specific.

## The server

The handler keeps every open socket in a set, and sends each message to all of them:

```python
# server.py (trimmed: the full file adds logging and a --port flag)
import contextlib
from urllib.parse import urlparse

import tornado.web
import tornado.websocket

clients: set["ChatHandler"] = set()


class ChatHandler(tornado.websocket.WebSocketHandler):
    def check_origin(self, origin: str) -> bool:
        # Vite serves the page from another port, which the default same-origin check turns
        # down. In production, serve the page from this server and drop this method.
        return urlparse(origin).hostname in {"localhost", "127.0.0.1", "::1"}

    def open(self) -> None:
        clients.add(self)

    def on_close(self) -> None:
        clients.discard(self)

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
```

Here's what each part does:

- **`open` and `on_close`** add and remove the socket. `on_message` loops over the set and passes the message on as it came: text as text, binary as binary.
- **`check_origin`** decides which pages may connect. Tornado's default only allows a page from the same host and port. Vite serves the page on 5173 and Tornado listens on 8888, so the example allows any `localhost` page.
- **`websocket_ping_interval=10`** pings every client every 10 seconds and closes the ones that don't answer. Without it, a laptop that went to sleep would stay in `clients` for a long time. Browsers answer these pings by themselves, so the client needs no code for them.
- **`websocket_max_message_size`** caps each message at 64 KiB. Tornado's default is 10 MiB. A bigger message closes the connection with code `1009`, and the client reconnects.

## Run it with uv

The server's dependencies are written at the top of `server.py`, as [inline script metadata](https://packaging.python.org/en/latest/specifications/inline-script-metadata/):

```python
#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["tornado>=6.5,<7"]
# ///
```

So `uv run` creates the environment, installs Tornado and even downloads Python 3.11+ if you don't have it. There's no virtualenv to create and no `pip install` to remember:

```sh
uv run examples/tornado/server.py
```

The exact versions are pinned in `server.py.lock`, next to the script. To move to the newest Tornado that still matches `tornado>=6.5,<7`:

```sh
uv lock --script examples/tornado/server.py --upgrade
```

Prefer pip? That works too:

```sh
pip install "tornado>=6.5,<7"
python3 examples/tornado/server.py
```

## The client

The client is a normal Vite + React app. Create one shared connection and use it from your components:

```tsx
// App.tsx
import { Suspense, use, useState, type FormEvent, type ReactNode } from 'react';
import { createWebSocket, useWebSocket, useWebSocketEvent } from 'react-websocket';

const URL = import.meta.env.VITE_WS_URL ?? 'ws://localhost:8888/live';

interface ChatMessage {
  text: string;
  at: number;
}

// One shared connection for the whole app; the server broadcasts every message to all clients.
const live = createWebSocket<ChatMessage, ChatMessage>(URL, {
  json: true,
  logger: console.debug
});

function Composer() {
  const [text, setText] = useState('');
  const { status, send, close, reconnect, attempt } = useWebSocket(live);

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!text) return;
    send({ text, at: Date.now() }); // queued if we're not connected yet
    setText('');
  }

  return (
    <>
      <p>
        Status:{' '}
        <span className="status" data-status={status}>
          {status}
          {status === 'reconnecting' ? ` (attempt ${attempt})` : ''}
        </span>{' '}
        <button onClick={reconnect}>Reconnect</button>{' '}
        <button onClick={() => close()}>Close</button>
      </p>
      <form onSubmit={submit}>
        <input value={text} onChange={e => setText(e.target.value)} placeholder="Say something" />{' '}
        <button>Send</button>
      </form>
    </>
  );
}

function Log() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  // Appends without this component subscribing to every status change.
  useWebSocketEvent(live, 'message', message => setMessages(list => [...list, message].slice(-50)));
  return (
    <ul>
      {messages.map(m => (
        <li key={m.at + m.text}>
          {new Date(m.at).toLocaleTimeString()} — {m.text}
        </li>
      ))}
    </ul>
  );
}

function Connected({ children }: { children: ReactNode }) {
  use(live.ready); // suspends until the first connection opens
  return children;
}

export default function App() {
  return (
    <>
      <Composer />
      <Suspense fallback={<p>Waiting for the server…</p>}>
        <Connected>
          <Log />
        </Connected>
      </Suspense>
    </>
  );
}
```

`use(live.ready)` shows "Waiting for the server…" until the first connection opens. Later reconnects don't bring the placeholder back, so the messages stay on screen.

The example itself imports from `../../src` instead of `react-websocket`, so it runs the repository's working copy without a build. In your app, import from `react-websocket` as above.

With `json: true`, `send()` turns your object into JSON text, and the server passes that text to everyone unchanged. Each client turns it back into an object before your listeners see it.

### Use another port

The server takes a `--port` flag, and the client reads its URL from `VITE_WS_URL`:

```sh
uv run examples/tornado/server.py --port 9000
VITE_WS_URL=ws://localhost:9000/live npm run example:tornado
```

## Let the browser notice a dead server

The server's pings find dead clients. The opposite case, a browser whose server has quietly gone away, needs a [heartbeat](../guide/reconnecting.md#heartbeats) on the client. Browsers can't send WebSocket ping frames from JavaScript, so the heartbeat is an ordinary message that the server answers.

Tell the client what to send and what the answer looks like:

```ts
const live = createWebSocket<ChatMessage, ChatMessage>(URL, {
  json: true,
  // A ping every 10 seconds. Five quiet seconds after one mean the connection is dead.
  heartbeat: { interval: 10_000, timeout: 5000, message: 'ping', pong: 'pong' },
  logger: console.debug
});
```

And answer it at the top of `on_message`, before the broadcast:

```python
    def on_message(self, message: str | bytes) -> None:
        # Answer the client's heartbeat, and keep it out of the chat.
        if message == "ping":
            self.write_message("pong")
            return
        for client in list(clients):
            ...
```

The `return` matters. Without it, the server would broadcast `ping` to everyone, and every client would report it as a message that isn't valid JSON. Setting `pong` on the client means the answer is swallowed, so your components never see it.

## Going to production

- **Serve the page from the same origin** as the WebSocket, and delete `check_origin`. Tornado's default check then allows your own page and nothing else.
- **Or check against your own domains** if the page lives elsewhere:

  ```python
  def check_origin(self, origin: str) -> bool:
      return urlparse(origin).hostname in {"example.com", "www.example.com"}
  ```

- **Point the client at the real server** with `VITE_WS_URL` when you build, for example `VITE_WS_URL=wss://example.com/live`. Use `wss://` on an HTTPS page.

## Try it

With both parts running:

1. **Open two tabs** and send a message from each. Both tabs show both messages.
2. **Stop the server** with Ctrl+C. The status goes to `reconnecting`.
3. **Send a few messages while it's down.** They're queued. Start the server again, and they go out to every tab that's connected by then. The server keeps no history, so a tab that connects later won't see them.
4. **Edit `server.py`.** Tornado restarts itself, and the page reconnects on its own.

## See also

- [Reconnecting and heartbeats](../guide/reconnecting.md): backoff, heartbeats and the send queue
- [Messages and types](../guide/messages.md): JSON, binary data and schemas
- [Authentication](../guide/authentication.md): sending a token when browsers can't set headers
- [Hono](./hono.md): the same kind of chat, with a TypeScript server and shared types
