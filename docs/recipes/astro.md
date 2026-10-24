---
title: 'WebSockets in Astro with react-websocket'
description: 'Share one WebSocket connection between Astro islands: a client module every island imports, state for islands that hydrate late, Suspense in a client:only island, a connection that survives navigation, and the WebSocket server in dev and production.'
---

# Astro

This recipe adds a live connection to an [Astro](https://astro.build/) site with React islands. It follows the repository's [Astro example](https://github.com/mehmetkose/react-websocket/tree/main/examples/astro), so you can run everything on this page:

```sh
# From the repository root: build the library, install it in the example, and start it.
npm run example:astro
```

Then open http://localhost:4321, and a second tab for the chat and cursors.

## The short version

- Every island is its own little React app, with no shared provider. That's fine: create the client in a module, and every island that imports it shares one connection.
- Islands hydrate at different times. Keep state that an island needs when it wakes up in a store in that module, not inside the island.
- Put Suspense inside a `client:only` island. On the server there is nothing to wait for.
- Add `<ClientRouter />` so links don't reload the page. A full page load is a new connection.
- Astro endpoints can't accept WebSocket connections. Attach the WebSocket server to Astro's dev server, and to your own Node server in production.

## Install

```sh
npx astro add react
npm install react-websocket
```

## Make one client for every island

Put the client and anything built on it in one module. Every island imports it, so they all share the same socket.

```ts
// src/lib/live.ts (trimmed: the example builds more on this client)
// Each island is a separate React root, but they all import this module, so they share one
// client (and one socket). It imports `react-websocket/core`, which has no React dependency, so
// the page's plain <script> uses it too. On the server, where Astro renders the islands, nothing
// connects.
import { createWebSocket, createWebSocketState } from 'react-websocket/core';
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

/**
 * The name the server gave this connection; a new connection gets a new name. Kept here rather
 * than in an island: islands hydrate in no fixed order, so the `welcome` message may arrive
 * before the one that shows it has mounted.
 */
export const me = createWebSocketState(live, {
  initialState: null as string | null,
  reduce: (state, message) => (message.type === 'welcome' ? message.name : state)
});
```

The `url` function runs before every attempt, so each connection gets a fresh short-lived token. The other options turn on JSON, check every message against a [zod](https://zod.dev/) schema, notice a dead connection with a heartbeat, stop retrying when the server refuses for good, and queue messages sent while offline. [Next.js](./nextjs.md#make-one-client-for-the-whole-app) goes through them one by one.

See the full [`src/lib/live.ts`](https://github.com/mehmetkose/react-websocket/blob/main/examples/astro/src/lib/live.ts) for the topics, requests, latency and agent responder the example adds.

## Keep early messages in a store

The server sends a `welcome` message as soon as a connection opens. An island that hydrates later, say with `client:visible`, would miss it if it listened for it itself.

That's why `me` lives in `live.ts`. A [`createWebSocketState`](../guide/state.md) store starts listening when it's created, so it has the name by the time any island asks:

```tsx
// src/components/StatusBadge.tsx
import { useWebSocketState, useWebSocketStatus } from 'react-websocket';
import { live, me } from '../lib/live';

/**
 * Re-renders only when the status or the name changes, not on every message. The layout
 * persists this island across page navigations, so it holds the connection open while the page
 * swaps: the name only changes when the socket really reconnects.
 */
export function StatusBadge() {
  const status = useWebSocketStatus(live);
  const name = useWebSocketState(me);
  return (
    <span className="status">
      <span className="badge" data-status={status}>
        {status}
      </span>
      {status === 'open' && name && <span className="muted">as {name}</span>}
    </span>
  );
}
```

## Hydrate islands when you like

Each island joins the connection when it mounts, and the first one opens it. Pick whichever directive suits the island:

```astro
---
// src/pages/index.astro (trimmed)
import { Chat } from '../components/Chat';
import { Cursors } from '../components/Cursors';
import { Prices } from '../components/Prices';
---

<Chat client:load />
<Prices client:idle />
<Cursors client:visible />
```

| Directive | The island joins the connection |
| --- | --- |
| `client:load` | Right away, as the page loads |
| `client:idle` | Once the browser has a quiet moment |
| `client:visible` | When it scrolls into view |
| `client:only="react"` | In the browser only, with no server-rendered HTML |

## Wait for the first connection with Suspense

`live.ready` is a promise that resolves when the first connection opens. On the server it rejects, because there's nothing to connect to. So use it in a `client:only` island, which Astro never renders on the server:

```tsx
// src/components/Connection.tsx (trimmed)
import { Suspense, use, useState } from 'react';
import { live } from '../lib/live';

const time = () => new Date().toLocaleTimeString([], { hour12: false });

/**
 * A `client:only` island: Astro never renders it on the server, where there is nothing to wait
 * for. Each island is its own React root, so the Suspense boundary lives inside it.
 */
export function FirstConnection() {
  return (
    <Suspense fallback={<p className="muted">Waiting for the first connection…</p>}>
      <OpenedAt />
    </Suspense>
  );
}

/**
 * Suspends until the first connection opens. `ready` stays resolved through reconnects, so
 * this never flashes back to the fallback on a network blip. Coming back from another page
 * remounts it, and it renders straight away: the connection is already open.
 */
function OpenedAt() {
  use(live.ready);
  const [renderedAt] = useState(time);
  return (
    <p className="muted">
      Rendered at {renderedAt}, once <code>ready</code> resolved. Reconnects don’t suspend it again.
    </p>
  );
}
```

The `slot="fallback"` content shows while the island's JavaScript loads:

```astro
<FirstConnection client:only="react">
  <p slot="fallback" class="muted">Waiting for the first connection…</p>
</FirstConnection>
```

## Keep the connection when you change pages

By default, every Astro link is a full page load, and a full page load starts a new connection. Two things fix that:

1. **`<ClientRouter />`** swaps pages in place. Your JavaScript stays loaded, and the client with it.
2. **`transition:persist`** keeps one island mounted through the swap. It holds the connection while the old page's islands unmount and the new page's hydrate.

```astro
---
// src/layouts/Layout.astro (trimmed)
import { ClientRouter } from 'astro:transitions';
import { StatusBadge } from '../components/StatusBadge';
---

<html lang="en">
  <head>
    <!-- Navigating between pages swaps the content without a full page load, so the client and
         its socket survive. Without it, every link would reconnect. -->
    <ClientRouter />
  </head>
  <body>
    <h1>
      react-websocket + Astro
      <!-- Persisted: the same island, still mounted, on every page. -->
      <StatusBadge client:load transition:persist="status" />
    </h1>
    <slot />
  </body>
</html>
```

In the example, go to the About page and back. The name next to the status stays the same, because it's still the same socket.

## Use it without React

`react-websocket/core` doesn't need React, so a plain `<script>` in an `.astro` file can use the same client. A custom element is a good fit: it sets itself up when it enters the page and cleans up when it leaves, and that includes the page swaps `<ClientRouter />` does.

```astro
<!-- src/components/Traffic.astro (trimmed) -->
<live-traffic>
  <dl class="facts">
    <dt>Status</dt>
    <dd data-status>–</dd>
    <dt>Messages</dt>
    <dd data-total>0</dd>
  </dl>
</live-traffic>

<script>
  import { live } from '../lib/live';

  class LiveTraffic extends HTMLElement {
    #cleanup: (() => void)[] = [];

    connectedCallback() {
      const status = this.querySelector('[data-status]')!;
      const total = this.querySelector('[data-total]')!;
      let received = 0;

      const showStatus = () => {
        const { status: current, attempt } = live.getSnapshot();
        status.textContent = attempt > 0 ? `${current} (attempt ${attempt})` : current;
      };
      showStatus();

      this.#cleanup.push(
        // Hold the connection open while this element is on the page, the way a hook does.
        live.acquire(),
        // The status store: called on every change, read with getSnapshot().
        live.subscribe(showStatus),
        // Every validated message. Writes to the DOM directly; there is nothing to re-render.
        live.on('message', () => {
          total.textContent = String(++received);
        })
      );
    }

    disconnectedCallback() {
      for (const off of this.#cleanup.splice(0)) off();
    }
  }

  customElements.define('live-traffic', LiveTraffic);
</script>
```

[Without React](../guide/without-react.md) covers the rest of the client API.

## Where the WebSocket server goes

A WebSocket starts as an HTTP request that asks to switch protocols, called an _upgrade_. Astro endpoints answer with normal responses, so they can't accept one. Instead, the WebSocket server listens for upgrades on the HTTP server underneath Astro.

**In development**, a tiny integration attaches it to Astro's dev server:

```ts
// astro.config.ts
import node from '@astrojs/node';
import react from '@astrojs/react';
import { defineConfig } from 'astro/config';
import { handleUpgrade } from './demo-server.ts';

export default defineConfig({
  integrations: [
    react(),
    {
      // Astro endpoints can't accept WebSocket upgrades, so in development this attaches the
      // demo's WebSocket server to Astro's dev server. Upgrades for other paths (Vite's hot
      // reload) are left alone. In production, server.ts does the same job.
      name: 'demo-websocket',
      hooks: {
        'astro:server:setup': ({ server }) => {
          server.httpServer?.on('upgrade', handleUpgrade);
        }
      }
    }
  ],
  // Pages are prerendered to static HTML; only /api/token runs on demand. Middleware mode lets
  // server.ts serve the build from its own HTTP server, next to the WebSocket endpoint.
  adapter: node({ mode: 'middleware' })
});
```

`handleUpgrade` only takes upgrades for `/ws`. It returns `false` for anything else and leaves it alone, so Vite's hot reload keeps working:

```ts
// demo-server.ts (trimmed)
// The demo's messages are small: a bigger one closes its connection with code 1009.
const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });

/**
 * Accept a WebSocket upgrade on `/ws` if its token is valid. Returns `false` for other paths,
 * without touching the socket, so another handler can take them.
 */
export function handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): boolean {
  const url = new URL(request.url ?? '/', 'http://localhost');
  if (url.pathname !== '/ws') return false;
  if (!verifyToken(url.searchParams.get('token'))) {
    socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
    return true;
  }
  wss.handleUpgrade(request, socket, head, connected);
  return true;
}
```

**In production**, the [Node adapter](https://docs.astro.build/en/guides/integrations-guide/node/) builds in `middleware` mode, and a small Express server mounts it and handles upgrades on the same port:

```ts
// server.ts
// Production: one process serves the built Astro site and the demo's WebSocket endpoint on the
// same port. Astro endpoints can't accept WebSocket upgrades, so this mounts the Node adapter's
// middleware in Express (https://docs.astro.build/en/guides/integrations-guide/node/) and
// handles upgrades itself. In development, astro.config.ts attaches the same handler to
// Astro's dev server.
import express, { type RequestHandler } from 'express';
import { handleUpgrade } from './demo-server.ts';

const port = Number(process.env.PORT ?? 4321);

// Written by `npm run build`.
const entry = new URL('./dist/server/entry.mjs', import.meta.url);
const { handler: astro } = (await import(entry.href)) as { handler: RequestHandler };

const app = express();
app.use(express.static(`${import.meta.dirname}/dist/client`)); // prerendered pages and assets
app.use(astro); // on-demand routes: /api/token

const server = app.listen(port, () => {
  console.log(`> react-websocket Astro demo on http://localhost:${port}`);
});
server.on('upgrade', (request, socket, head) => {
  if (!handleUpgrade(request, socket, head)) socket.destroy();
});
```

The pages are prerendered to static HTML. Only the token endpoint runs on demand, because every request needs a new token:

```ts
// src/pages/api/token.ts
import type { APIRoute } from 'astro';
import { issueToken } from '../../lib/token';

// Rendered on demand: every request gets a new token. The rest of the site is prerendered.
export const prerender = false;

// The WebSocket URL function fetches a fresh token here before every connection attempt.
// A real app would check the user's session first.
export const GET: APIRoute = () =>
  Response.json({ token: issueToken() }, { headers: { 'Cache-Control': 'no-store' } });
```

You can also run the WebSocket server as a separate service. The client only needs its URL.

## Going to production

```sh
npm run build   # prerendered pages and assets in dist/client, the server entry in dist/server
npm start       # node server.ts, on http://localhost:4321
```

## Try it

With the example running:

1. **Scroll down slowly.** The Cursors and Latency cards are `client:visible`: they join the connection when they come into view, and there's still only one socket.
2. **Go to About and back.** The name in the header doesn't change, so the connection was never replaced.
3. **Close the connection**, send a few chat messages, then reconnect. They go out in order.
4. **Watch the "Without React" card.** It counts every message the shared client receives, whichever island asked for it.

## See also

- [Server rendering and Next.js](../guide/ssr.md): what happens on the server, for Astro too
- [Message state](../guide/state.md): stores that keep the latest state from your messages
- [Without React](../guide/without-react.md): the client API for plain scripts
- [Suspense](../guide/suspense.md): how `ready` behaves
