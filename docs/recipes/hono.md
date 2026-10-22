---
title: 'A Hono WebSocket server with a React client'
description: 'Pair a Hono WebSocket server with a Vite and React client using react-websocket: message types shared by both sides, upgradeWebSocket on Node.js, a dev proxy, room state that survives reconnects, and one port in production.'
---

# Hono

This recipe builds a small chat room with a list of who's online. The server is [Hono](https://hono.dev/) on Node.js, the client is Vite and React, and both sides import the same message types. It follows the repository's [Hono example](https://github.com/mehmetkose/react-websocket/tree/main/examples/hono), so you can run everything on this page:

```sh
# From the repository root: build the library, install it in the example, and start both servers.
npm run example:hono
```

Then open http://localhost:5173 in two tabs and say hello.

## The short version

- Write your messages once, as TypeScript types in a file both sides import.
- On the server, `upgradeWebSocket` from `@hono/node-server` turns a route into a WebSocket endpoint.
- In development, Vite forwards `/ws` to the Hono server, so the page connects to its own address.
- On the client, keep the room in a [`createWebSocketState`](../guide/state.md) store, and let the server's `welcome` message refresh it after every reconnect.
- In production, Hono serves the built page and the socket on one port.

## Install

```sh
# The server
npm install hono @hono/node-server ws
# The client
npm install react react-dom react-websocket
npm install --save-dev vite @vitejs/plugin-react
```

## Share the message types

Put every message in one file. The server and the client both import it, so if you change a message, TypeScript checks both ends:

```ts
// src/protocol.ts
// The messages both sides speak. The server and the client import the same types, so a change
// here is checked on both ends.

export interface ChatMessage {
  id: string;
  from: string;
  text: string;
  at: number;
}

/** Every message the server sends. */
export type ServerMessage =
  // The first message on every connection, including reconnects: who you are and what you missed.
  | { type: 'welcome'; name: string; history: ChatMessage[] }
  | { type: 'chat'; message: ChatMessage }
  | { type: 'presence'; online: string[] };

/** Every message the client sends. */
export type ClientMessage = { type: 'chat'; text: string };

/** The client's heartbeat ping and the server's reply, sent as plain text rather than JSON. */
export const HEARTBEAT = 'heartbeat';
```

## The server

`@hono/node-server` handles WebSocket connections itself, since version 2. Give `serve()` a `ws` server created with `noServer: true`, and `upgradeWebSocket` works on any route:

```ts
// server.ts (trimmed: the full file also checks incoming messages and serves the built page)
import { serve, upgradeWebSocket } from '@hono/node-server';
import { Hono } from 'hono';
import type { WSContext } from 'hono/ws';
import { WebSocketServer } from 'ws';
import { HEARTBEAT, type ChatMessage, type ServerMessage } from './src/protocol.ts';

const port = Number(process.env.PORT ?? 8787);

// Hono has no rooms or broadcast of its own: keep the open sockets and loop over them.
const members = new Map<string, WSContext>();
const history: ChatMessage[] = [];
let guests = 0;

function send(ws: WSContext, message: ServerMessage) {
  ws.send(JSON.stringify(message));
}

function broadcast(message: ServerMessage) {
  for (const ws of members.values()) send(ws, message);
}

const app = new Hono();

app.get(
  '/ws',
  // Middleware before `upgradeWebSocket` can turn the upgrade down, e.g. without a session.
  // This factory runs once per request, so its variables belong to that connection.
  upgradeWebSocket(() => {
    let name = '';
    return {
      onOpen(_event, ws) {
        // Named on open: the factory also runs for plain GETs that never upgrade.
        name = `guest-${++guests}`;
        members.set(name, ws);
        send(ws, { type: 'welcome', name, history });
        broadcast({ type: 'presence', online: [...members.keys()] });
      },
      onMessage(event, ws) {
        // Answer the client's heartbeat so it knows the connection is alive.
        if (event.data === HEARTBEAT) return ws.send(HEARTBEAT);
        // ...parse the chat message and broadcast it
      },
      onClose() {
        members.delete(name);
        broadcast({ type: 'presence', online: [...members.keys()] });
      }
    };
  })
);

serve(
  {
    fetch: app.fetch,
    port,
    // Turns on `upgradeWebSocket`. The server must be created with `noServer: true`.
    websocket: { server: new WebSocketServer({ noServer: true }) }
  },
  info => console.log(`> Hono WebSocket server on ws://localhost:${info.port}/ws`)
);
```

A few things worth knowing:

- **Do side effects in `onOpen`.** The function you pass to `upgradeWebSocket` runs for every request to the route, before Hono checks that it's a WebSocket. A crawler, a health check or a browser tab runs it too, and then gets a 404. `onOpen` only runs once a socket is really open, so that's where each guest gets a name.
- **There's no broadcast built in.** Hono gives you one socket at a time. The server keeps the open ones in a `Map` and loops over it.
- **`welcome` goes out on every connection,** including reconnects. It tells the client who it is and what it missed, so the client never has to ask.
- **The heartbeat reply.** The client sends `heartbeat` every 10 seconds, and the server sends it straight back. A connection that died without closing is noticed and replaced.

### Turning connections down

Middleware before `upgradeWebSocket` runs first, so it can say no before the socket opens. The client sees a failed connection and tries again with backoff:

```ts
app.get(
  '/ws',
  async (c, next) => {
    if (!(await isSignedIn(c))) return c.text('Unauthorized', 401);
    await next();
  },
  upgradeWebSocket(c => ({ /* ... */ }))
);
```

To stop the client from retrying when its credentials are wrong, see [Authentication](../guide/authentication.md#stop-retrying-when-credentials-are-rejected).

### Other runtimes

The same `upgradeWebSocket` handler shape works on Bun, Deno and Cloudflare Workers. Import it from `hono/bun`, `hono/deno` or `hono/cloudflare-workers` instead.

## Forward `/ws` in development

Vite serves the page on port 5173, and Hono listens on 8787. A proxy forwards `/ws` from one to the other, so the page connects to its own address in development and in production alike:

```ts
// vite.config.ts
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  server: {
    // The page connects to /ws on its own origin; forward it to the Hono server (server.ts).
    proxy: { '/ws': { target: 'http://localhost:8787', ws: true } }
  }
});
```

`ws: true` is the important part: it tells Vite to forward WebSocket connections, not only normal requests.

## The client

One module holds the connection and the room:

```ts
// src/live.ts
import { createWebSocket, createWebSocketState } from 'react-websocket';
import { HEARTBEAT, type ChatMessage, type ClientMessage, type ServerMessage } from './protocol';

// The page's own origin: in development Vite forwards /ws to the Hono server, and in
// production Hono serves the page and the socket on one port.
function url() {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${location.host}/ws`;
}

/** The one connection the page shares. */
export const live = createWebSocket<ServerMessage, ClientMessage>(url, {
  json: true,
  // Five quiet seconds after a ping count as a dead connection, and the client reconnects.
  heartbeat: { interval: 10_000, timeout: 5000, message: HEARTBEAT, pong: HEARTBEAT },
  queue: { limit: 20 },
  logger: console.debug
});

export interface Room {
  me: string;
  online: string[];
  messages: ChatMessage[];
}

/** The room as the server last described it. Kept across reconnects, refreshed by `welcome`. */
export const room = createWebSocketState(live, {
  initialState: { me: '', online: [], messages: [] } as Room,
  reduce: (state, message): Room => {
    switch (message.type) {
      // Sent on every connection, so the history replaces what we had rather than repeating it.
      case 'welcome':
        return { ...state, me: message.name, messages: message.history };
      case 'chat':
        return { ...state, messages: [...state.messages, message.message].slice(-50) };
      case 'presence':
        return { ...state, online: message.online };
    }
  }
});
```

- **`heartbeat`** uses the same `HEARTBEAT` string as the server. Setting `pong` means the reply is swallowed instead of reaching your components as a message.
- **`room`** keeps the latest state from the messages. It stays on screen while the client reconnects, and `welcome` replaces the history afterwards, so nothing shows up twice.

Components read only the part of the room they need, so the online list doesn't re-render for every chat message:

```tsx
// src/App.tsx (trimmed)
function Online() {
  // Re-renders only when the list changes, not on every chat message.
  const online = useWebSocketState(room, state => state.online);
  return (
    <p className="muted">
      {online.length} online: {online.join(', ')}
    </p>
  );
}
```

Sending works while offline too. `live.send()` queues the message and returns `false`, and the queue goes out in order when the connection is back:

```tsx
// src/App.tsx (trimmed)
function Composer() {
  const [text, setText] = useState('');
  const [queued, setQueued] = useState(0);
  // Queued messages go out right after `open` listeners run.
  useWebSocketEvent(live, 'open', () => setQueued(0));

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!text.trim()) return;
    // Sent now if open; otherwise queued and sent in order on reconnect.
    if (!live.send({ type: 'chat', text })) setQueued(count => count + 1);
    setText('');
  }

  return (
    <form className="row" onSubmit={submit}>
      <input value={text} onChange={e => setText(e.target.value)} placeholder="Say something" />
      <button>Send</button>
      {queued > 0 && <span className="muted">{queued} queued until the connection is back</span>}
    </form>
  );
}
```

To show a placeholder until the server first answers, suspend on `live.ready`:

```tsx
// src/App.tsx (trimmed)
function Connected({ children }: { children: ReactNode }) {
  use(live.ready); // suspends until the first connection opens, and not again on reconnects
  return children;
}

export default function App() {
  return (
    <>
      <Status />
      <Suspense fallback={<p className="muted">Waiting for the server…</p>}>
        <Connected>
          <Online />
          <Messages />
        </Connected>
      </Suspense>
      <Composer />
    </>
  );
}
```

The full [`App.tsx`](https://github.com/mehmetkose/react-websocket/blob/main/examples/hono/src/App.tsx) also has the status line and the message list.

## Going to production

In production there's no Vite server, so Hono serves the built page too:

```ts
// server.ts (trimmed)
import { serveStatic } from '@hono/node-server/serve-static';

// In development Vite serves the page and forwards /ws here (see vite.config.ts).
if (process.env.NODE_ENV === 'production') app.use('/*', serveStatic({ root: './dist' }));
```

```sh
npm run build   # the client, into dist/
npm start       # Hono serves dist/ and /ws on http://localhost:8787
```

The client's `url()` uses the page's own address, so it needs no changes.

## Try it

With the example running:

1. **Open two tabs.** Each one gets a guest name, and both show up in the online list.
2. **Stop the server**, or edit `server.ts`, which restarts it. The client goes to `reconnecting`.
3. **Send a few messages while it's down.** They're queued, and go out once the server is back.
4. **Watch the history.** After the reconnect, `welcome` brings it back without repeating anything.

## See also

- [Message state](../guide/state.md): stores like `room`, with selectors
- [Reconnecting and heartbeats](../guide/reconnecting.md): backoff, heartbeats and the send queue
- [Messages and types](../guide/messages.md): JSON, schemas and one socket with many message types
- [Build a team chat app](./team-chat.md): channels, unread counts and an outbox that survives reloads
