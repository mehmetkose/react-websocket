---
title: 'WebSockets in Next.js with react-websocket'
description: 'Add a live WebSocket connection to a Next.js App Router app: one shared client, hooks in Client Components, Suspense that waits for the first connection, and a custom server for the WebSocket endpoint.'
---

# Next.js

This recipe adds a live connection to a Next.js App Router app. It follows the repository's [Next.js example](https://github.com/mehmetkose/react-websocket/tree/main/examples/nextjs), so you can run everything on this page:

```sh
# From the repository root: build the library, install it in the example, and start it.
npm run example:nextjs
```

Then open http://localhost:3000. Open a second tab too, so you can watch the chat from both sides.

## The short version

- Create the client once, in a plain module, with `react-websocket/core`. Any file can import it, Server Components included.
- Call the hooks in Client Components, the files that start with `'use client'`.
- On the server, those components render as `idle`. They connect in the browser, once the page has hydrated.
- Next.js route handlers can't accept WebSocket connections. Run the WebSocket server in a small custom server next to Next.js, or as a separate service.

## Install

```sh
npm install react-websocket
```

## Make one client for the whole app

Put the client in a module of its own. Every component that imports it shares the same connection, so ten components still open one socket.

```ts
// lib/live.ts (trimmed: the example builds more on this client)
// This module has no 'use client': `react-websocket/core` has no hooks, so it's safe to import
// from anywhere, and the client only connects in a browser.
import { createWebSocket } from 'react-websocket/core';
import { serverMessage, type ClientMessage, type ServerMessage } from './protocol';

// Called before every connection attempt, including reconnects, so each one gets a fresh token.
async function url() {
  const response = await fetch('/api/token');
  if (!response.ok) throw new Error(`Token request failed: HTTP ${response.status}`);
  const { token } = (await response.json()) as { token: string };
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${location.host}/ws?token=${encodeURIComponent(token)}`;
}

export const live = createWebSocket<ServerMessage, ClientMessage>(url, {
  json: true,
  // Every message is validated; one that doesn't match is reported to `error` listeners.
  schema: serverMessage,
  // The demo server answers 'heartbeat' with 'heartbeat'. Three quiet seconds after a ping
  // count as a dead connection.
  heartbeat: { interval: 4000, timeout: 3000, message: 'heartbeat', pong: 'heartbeat' },
  // 4003 means the server refused this client: retrying won't help.
  reconnect: { maxDelay: 8000, shouldReconnect: close => close.code !== 4003 },
  queue: { limit: 50 },
  logger: console.debug
});
```

Here's what each option does:

- **`url`** is a function here, not a string. The client calls it before every attempt, so each connection gets a fresh short-lived token from the app's own `/api/token` route. A reconnect never reuses an expired one.
- **`json: true`** turns incoming text into objects and outgoing objects into text.
- **`schema`** checks every incoming message against a [zod](https://zod.dev/) schema. A message that doesn't match is reported as an error instead of reaching your components.
- **`heartbeat`** sends a ping every 4 seconds. If nothing comes back within 3, the connection is treated as dead and replaced.
- **`shouldReconnect`** stops retrying when the server says no for good (close code `4003`).
- **`queue`** keeps up to 50 messages you send while offline, and sends them in order once the connection is back.

Why `react-websocket/core`? The main `react-websocket` entry contains hooks, so it's marked `'use client'`. The `core` entry has no hooks and no directive, so a Server Component can import a module that uses it. Both entries share one runtime: the hooks work with a client made by `core`.

The example builds more on this same client: [topics](../guide/topics.md), [state](../guide/state.md), [requests](../api/create-websocket-requests.md), [latency](../api/create-websocket-latency.md) and an [agent responder](../api/create-websocket-responder.md). See the full [`lib/live.ts`](https://github.com/mehmetkose/react-websocket/blob/main/examples/nextjs/lib/live.ts).

## Use it in Client Components

Hooks only work in Client Components, the same as `useState`. A status badge is the smallest one:

```tsx
// components/status-badge.tsx
'use client';

import { useWebSocketStatus } from 'react-websocket';
import { live } from '@/lib/live';

/** Re-renders only when the status changes, not on every message. */
export function StatusBadge() {
  const status = useWebSocketStatus(live);
  return (
    <span className="badge" data-status={status}>
      {status}
    </span>
  );
}
```

A chat box listens for messages and sends its own. `live.send()` returns `false` when the message was queued instead of sent, which is handy for showing a "queued" note:

```tsx
// components/chat.tsx
'use client';

import { useState, type FormEvent } from 'react';
import { useWebSocketEvent } from 'react-websocket';
import { live } from '@/lib/live';
import type { ServerMessage } from '@/lib/protocol';

type ChatMessage = Extract<ServerMessage, { type: 'chat' }>;

export function Chat() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [text, setText] = useState('');
  const [queued, setQueued] = useState(0);

  useWebSocketEvent(live, 'message', message => {
    if (message.type === 'chat') setMessages(list => [...list, message].slice(-20));
  });
  // Queued messages go out right after `open` listeners run.
  useWebSocketEvent(live, 'open', () => setQueued(0));

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!text.trim()) return;
    // Sent now if open; otherwise queued (up to `queue.limit`) and sent on reconnect.
    if (!live.send({ type: 'chat', text })) setQueued(count => count + 1);
    setText('');
  }

  return (
    <>
      <ul className="chat">
        {messages.map(message => (
          <li key={message.id}>
            <span className="muted">{message.from}</span> {message.text}
          </li>
        ))}
      </ul>
      <form className="row" onSubmit={submit}>
        <input
          value={text}
          onChange={event => setText(event.target.value)}
          placeholder="Say something"
        />
        <button>Send</button>
      </form>
      {queued > 0 && <p className="note">{queued} queued until the connection is back</p>}
    </>
  );
}
```

## Render them from a Server Component

Your pages and layouts can stay Server Components. They render the Client Components like any others:

```tsx
// app/page.tsx (trimmed)
// A Server Component: it renders the cards on the server, and each client component inside
// connects after hydration. View the page source to see them rendered as `idle`.
import { Chat } from '@/components/chat';
import { StatusBadge } from '@/components/status-badge';

export default function Page() {
  return (
    <main>
      <header>
        <h1>
          react-websocket <StatusBadge />
        </h1>
      </header>
      <Chat />
    </main>
  );
}
```

Nothing connects on the server. The HTML arrives with the badge saying `idle`, the first render in the browser says `idle` too, so hydration matches, and then the connection opens.

## Wait for the first connection with Suspense

`live.ready` is a promise that resolves when the first connection opens. Pass it to `use()` and the nearest `<Suspense>` shows its fallback until then:

```tsx
// components/connection.tsx (trimmed)
'use client';

import { use, useState } from 'react';
import { browser } from 'react-dom';
import { live } from '@/lib/live';

const time = () => new Date().toLocaleTimeString([], { hour12: false });

export function FirstConnection() {
  use(browser('The demo connects from the browser')); // the server sends the fallback
  use(live.ready);
  const [openedAt] = useState(time);
  return <p className="muted">First connected at {openedAt}. Reconnects don’t suspend again.</p>;
}
```

```tsx
// app/page.tsx (trimmed)
<Suspense fallback={<p className="muted">Waiting for the first connection…</p>}>
  <FirstConnection />
</Suspense>
```

`use(browser())` (React 19.3 or later) tells React that this part only renders in the browser, so the server sends the fallback. `ready` stays resolved through later reconnects, so a network blip never flashes the fallback again. [Server rendering and Next.js](../guide/ssr.md) explains the details.

## Where the WebSocket server goes

A WebSocket starts life as an HTTP request that asks the server to switch protocols. That request is called an _upgrade_. Next.js route handlers can only answer with a normal response, so they can't accept one.

The example solves this with a [custom server](https://nextjs.org/docs/app/guides/custom-server): a short file that starts Next.js and also handles upgrades, on the same port.

```ts
// server.ts
// One process serves the Next.js app and the demo's WebSocket endpoint on the same port.
// Next.js route handlers can't accept WebSocket upgrades, so this is a custom server:
// https://nextjs.org/docs/app/guides/custom-server
import { createServer } from 'node:http';
import next from 'next';
import { handleUpgrade } from './demo-server.ts';

const port = Number(process.env.PORT ?? 3000);
const dev = process.env.NODE_ENV !== 'production';
const app = next({ dev, port });
await app.prepare();
const handle = app.getRequestHandler();
const nextUpgrade = app.getUpgradeHandler();

const server = createServer((request, response) => void handle(request, response));
server.on('upgrade', (request, socket, head) => {
  const { pathname } = new URL(request.url ?? '/', 'http://localhost');
  if (pathname === '/ws') handleUpgrade(request, socket, head);
  else void nextUpgrade(request, socket, head); // Next.js dev tools and hot reload
});
server.listen(port, () => {
  console.log(
    `> react-websocket demo on http://localhost:${port} (${dev ? 'development' : 'production'})`
  );
});
```

Upgrades to `/ws` go to your WebSocket server. Every other upgrade goes back to Next.js, because its hot reload uses a WebSocket of its own.

`handleUpgrade` checks the token and hands the connection to the [`ws`](https://github.com/websockets/ws) package:

```ts
// demo-server.ts (trimmed)
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer } from 'ws';
import { verifyToken } from './lib/token.ts';

// The demo's messages are small: a bigger one closes its connection with code 1009.
const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });

/** Accept a WebSocket upgrade on `/ws` if its token is valid. */
export function handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer) {
  const token = new URL(request.url ?? '/', 'http://localhost').searchParams.get('token');
  if (!verifyToken(token)) {
    socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
    return;
  }
  wss.handleUpgrade(request, socket, head, connected);
}
```

`connected` is where the demo's chat, prices and the rest live. Any WebSocket server works here: react-websocket only needs a URL.

The token comes from an ordinary route handler:

```ts
// app/api/token/route.ts
import { issueToken } from '@/lib/token';

// The WebSocket URL function fetches a fresh token here before every connection attempt.
// A real app would check the user's session first.
export function GET() {
  return Response.json({ token: issueToken() }, { headers: { 'Cache-Control': 'no-store' } });
}
```

Point the `dev` and `start` scripts at the custom server instead of `next dev` and `next start`:

```json
{
  "scripts": {
    "dev": "node server.ts",
    "build": "next build",
    "start": "NODE_ENV=production node server.ts"
  }
}
```

Node 22.18 and later run `.ts` files directly, so there's no build step for `server.ts`.

## Good to know

- **Environment variables.** Only variables named `NEXT_PUBLIC_*` reach the browser. For a WebSocket URL that changes per environment, use something like `process.env.NEXT_PUBLIC_WS_URL`, or build it in the `url` function as above.
- **StrictMode opens one socket.** In development, React mounts components twice to find bugs. react-websocket waits a moment before closing, so the second mount reuses the same connection. See [StrictMode, Activity and lifecycle](../guide/lifecycle.md).
- **Hosts without a custom server.** Some hosts only run `next start`. There, run the WebSocket server as its own service and return its URL from the `url` function. The client doesn't care where the server lives.

## Going to production

```sh
npm run build   # next build
npm start       # NODE_ENV=production node server.ts, on http://localhost:3000
```

## Try it

With the example running:

1. **View the page source.** Every card is in the HTML, rendered as `idle`.
2. **Close the connection** in the Connection card, send a few chat messages, then click Reconnect. They go out in order.
3. **Make the server misbehave** with the buttons: drop the connection and watch the backoff, go silent until the heartbeat gives up, or get refused with code `4003`, which `shouldReconnect` doesn't retry.
4. **Toggle price symbols**, then drop the connection. The subscriptions come back on their own.

## See also

- [Server rendering and Next.js](../guide/ssr.md): what happens on the server, and Suspense during SSR
- [Authentication](../guide/authentication.md): tokens in the URL, cookies and refreshing credentials
- [Shared clients](../guide/shared-clients.md): one connection, many components
- [Build live notifications](./live-notifications.md): a notification bell in a Next.js layout
