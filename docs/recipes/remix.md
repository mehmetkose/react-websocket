---
title: 'WebSockets in Remix 3 with react-websocket/core'
description: 'Use react-websocket in a Remix 3 app, which has no React: one shared client from react-websocket/core, small bindings that stand in for the hooks, client entries that share one connection, and the WebSocket server next to the router.'
---

# Remix 3

[Remix 3](https://remix.run/) has its own component model, and its components aren't React components. You can still use react-websocket there: [`react-websocket/core`](../guide/without-react.md) has the client and everything built on it, with no React at all.

This recipe follows the repository's [Remix example](https://github.com/mehmetkose/react-websocket/tree/main/examples/remix), so you can run everything on this page:

```sh
# From the repository root: build the library, install it in the example, and start it.
npm run example:remix
```

Then open http://localhost:44100, and a second tab for the chat and cursors. Remix 3 needs Node.js 24.3 or later.

## The short version

- Import from `react-websocket/core`, not `react-websocket`. The main entry is the React hooks.
- Create the client in one module. Every client entry that imports it shares one connection.
- Copy a small `bindings.ts` file into your app. It does for Remix components what the hooks do for React ones.
- Put browser code in `public/` folders, and allow `react-websocket` in the asset server.
- The Remix router can't accept WebSocket connections. Handle them on the Node server underneath it.

## Install

```sh
npm install react-websocket
```

npm also installs React, because it's the package's peer dependency, but nothing in the app imports it.

## Make one client for the whole app

The client lives in a `public/` folder, so the browser can load it:

```ts
// app/live/public/live.ts (trimmed: the example builds more on this client)
// Each client entry hydrates on its own, but they all import this module, so they share one
// client (and one socket). It imports `react-websocket/core`, which has no React dependency.
// The server imports it too, to render the client entries, but nothing connects there: the
// components only hold the connection once they're in the browser (see bindings.ts).
import { createWebSocket, createWebSocketState } from 'react-websocket/core';
import { routes } from '../../routes.ts';
import { serverMessage, type ClientMessage, type ServerMessage } from './protocol.ts';

// Called before every connection attempt, including reconnects, so each one gets a fresh token.
async function url() {
  const response = await fetch(routes.token.href());
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
 * than in a component: client entries hydrate in no fixed order, so the `welcome` message may
 * arrive before the one that shows it is listening.
 */
export const me = createWebSocketState(live, {
  initialState: null as string | null,
  reduce: (state, message) => (message.type === 'welcome' ? message.name : state)
});
```

The `url` function builds the token URL from the app's routes, so the browser and the server agree on it. [Next.js](./nextjs.md#make-one-client-for-the-whole-app) explains the other options one by one. The full [`live.ts`](https://github.com/mehmetkose/react-websocket/blob/main/examples/remix/app/live/public/live.ts) adds topics, requests, latency and an agent responder.

## Bindings: hooks for Remix components

Each react-websocket hook is a thin wrapper around a `core` store. It subscribes, renders again when something changes, and holds the connection open while the component is on the page.

A Remix component works differently. Its setup function runs once and returns a render function, and the component calls `handle.update()` when it wants to render again. So the example has the same small wrappers for Remix, one per hook:

| React hook | Remix binding |
| --- | --- |
| `useWebSocket(client)` | `watchSnapshot(handle, client)` |
| `useWebSocketStatus(client)` | `watchStatus(handle, client)` |
| `useWebSocketEvent(client, type, listener)` | `listen(handle, client, type, listener)` |
| `useWebSocketState(store, selector)` | `watchState(handle, store, selector)` |
| `useWebSocketTopic(topics, topic)` | `holdTopic(handle, topics, topic)` |
| `useWebSocketLatency(latency)` | `watchLatency(handle, latency)` |
| `useAgentApproval(responder, method)` | `watchRequests(handle, responder, method)` |

The library doesn't ship these, so copy [`bindings.ts`](https://github.com/mehmetkose/react-websocket/blob/main/examples/remix/app/live/public/bindings.ts) into your app. Here's the heart of it:

```ts
// app/live/public/bindings.ts (trimmed)
import type { Handle } from 'remix/component';
import type { EventMap, Status, WebSocketClient } from 'react-websocket/core';

type AnyHandle = Handle<any, any>;
type Client = WebSocketClient<any, any>;

/** Run `start` in the browser after the first render; its cleanups run when the component goes. */
function whileMounted(handle: AnyHandle, start: () => (() => void)[]) {
  handle.queueTask(() => {
    for (const stop of start()) handle.signal.addEventListener('abort', stop, { once: true });
  });
}

/**
 * Re-render when `read()` returns something new (by `Object.is`), however often the store
 * changes, and hold `client`'s connection. Like `useSyncExternalStore` with a selector.
 */
function select<T>(
  handle: AnyHandle,
  client: Client,
  subscribe: (listener: () => void) => () => void,
  read: () => T,
  initial: T
): () => T {
  let value = initial;
  const check = () => {
    const next = read();
    if (Object.is(next, value)) return;
    value = next;
    void handle.update();
  };
  whileMounted(handle, () => {
    const stops = [subscribe(check), client.acquire()];
    check(); // it may have changed since the server rendered `initial`
    return stops;
  });
  return () => value;
}

/** `useWebSocketStatus(client)`: re-renders on status changes only. */
export function watchStatus(handle: AnyHandle, client: Client) {
  return select<Status>(
    handle,
    client,
    client.subscribe,
    () => client.getSnapshot().status,
    'idle'
  );
}

/** `useWebSocketEvent(client, type, listener)`: listens without re-rendering. */
export function listen<In, K extends keyof EventMap<In>>(
  handle: AnyHandle,
  client: WebSocketClient<In, any>,
  type: K,
  listener: EventMap<In>[K]
) {
  whileMounted(handle, () => [client.on(type, listener), client.acquire()]);
}
```

Two details make server rendering work:

- **They start in `handle.queueTask()`.** A queued task runs after the first render in the browser and never on the server, so nothing connects during a server render.
- **They return getters.** Until the browser takes over, a getter returns what the server rendered: `idle`, or the store's `initialState`. The first render in the browser matches the HTML.

`handle.signal` aborts when the component leaves the page, which unsubscribes and lets go of the connection.

## Use it in client entries

A client entry is a component that hydrates in the browser on its own. Call the bindings in the setup function, and the getters in the render function:

```tsx
// app/ui/public/status-badge.tsx
import { clientEntry, type Handle } from 'remix/component';
import { watchState, watchStatus } from '../../live/public/bindings.ts';
import { live, me } from '../../live/public/live.ts';

/**
 * Re-renders only when the status or the name changes, not on every message. It's in the header
 * of every page, so client navigation keeps it mounted, and it holds the connection open while
 * one page's cards leave and the next page's hydrate.
 */
export const StatusBadge = clientEntry(import.meta.url, function StatusBadge(handle: Handle) {
  const status = watchStatus(handle, live);
  const name = watchState(handle, me);
  return () => (
    <span class="status">
      <span class="badge" data-status={status()}>
        {status()}
      </span>
      {status() === 'open' && name() && <span class="muted">as {name()}</span>}
    </span>
  );
});
```

A chat box keeps its state in plain variables and calls `handle.update()` when they change. `live.send()` returns `false` when the message was queued instead of sent:

```tsx
// app/ui/public/chat.tsx
import { clientEntry, on, type Handle } from 'remix/component';
import { listen } from '../../live/public/bindings.ts';
import { live } from '../../live/public/live.ts';
import type { ServerMessage } from '../../live/public/protocol.ts';

type ChatMessage = Extract<ServerMessage, { type: 'chat' }>;

export const Chat = clientEntry(import.meta.url, function Chat(handle: Handle) {
  let messages: ChatMessage[] = [];
  let queued = 0;

  listen(handle, live, 'message', message => {
    if (message.type !== 'chat') return;
    messages = [...messages, message].slice(-20);
    void handle.update();
  });
  // Queued messages go out right after `open` listeners run.
  listen(handle, live, 'open', () => {
    queued = 0;
    void handle.update();
  });

  return () => (
    <>
      <ul class="chat">
        {messages.map(message => (
          <li key={message.id}>
            <span class="muted">{message.from}</span> {message.text}
          </li>
        ))}
      </ul>
      <form
        class="row"
        mix={on('submit', event => {
          event.preventDefault();
          const form = event.currentTarget;
          const text = String(new FormData(form).get('text') ?? '').trim();
          if (!text) return;
          // Sent now if open; otherwise queued (up to `queue.limit`) and sent on reconnect.
          if (!live.send({ type: 'chat', text })) queued++;
          form.reset();
          void handle.update();
        })}
      >
        <input name="text" placeholder="Say something" autocomplete="off" />
        <button type="submit">Send</button>
      </form>
      {queued > 0 && <p class="note">{queued} queued until the connection is back</p>}
    </>
  );
});
```

## Let the browser load the library

Remix's asset server compiles browser modules when they're requested. It only serves files and packages you allow, so add `react-websocket` (and your schema library, if you use one) to `allowPackages`:

```ts
// app/assets.ts (trimmed)
import { createAssetServer } from 'remix/assets';

// Compiles the browser modules on demand. The allow lists are the security boundary: only
// `public/` directories under app/ and the listed packages can reach the browser, so
// app/live/token.ts (which holds the token secret) can't.
export const assets = createAssetServer({
  basePath: '/assets',
  rootDir: process.cwd(),
  allowFiles: ['app/routes.ts', 'app/**/public/**'],
  // `react-websocket/core` and the schema it validates with. React isn't listed: nothing in the
  // browser imports it.
  allowPackages: ['remix', 'react-websocket', 'zod']
});
```

This is also why the token code sits in `app/live/token.ts`, outside `public/`: it holds a secret, and the browser must never load it.

## Where the WebSocket server goes

A WebSocket starts as an HTTP request that asks to switch protocols, called an _upgrade_. The Remix router turns requests into responses, and an upgrade isn't one. So `server.ts` hands normal requests to the router and upgrades to the WebSocket server, on the same port:

```ts
// server.ts
// One process serves the Remix app and the demo's WebSocket endpoint on the same port. The
// router turns Requests into Responses, and a WebSocket upgrade isn't one, so upgrades are
// handled on the Node server underneath.
import * as http from 'node:http';
import { createRequestListener } from 'remix/node-fetch-server';
import { router } from './app/router.ts';
import { handleUpgrade } from './demo-server.ts';

const port = Number(process.env.PORT ?? 44100);

const server = http.createServer(createRequestListener(router.fetch));
server.on('upgrade', (request, socket, head) => {
  if (!handleUpgrade(request, socket, head)) socket.destroy();
});
server.listen(port, () => {
  console.log(
    `> react-websocket Remix demo on http://localhost:${port} (${process.env.NODE_ENV ?? 'development'})`
  );
});
```

`handleUpgrade` accepts upgrades to `/ws` with a valid token, using the [`ws`](https://github.com/websockets/ws) package. The [Astro recipe](./astro.md#where-the-websocket-server-goes) shows the same function.

The token itself comes from an ordinary route action:

```tsx
// app/actions/controller.tsx (trimmed)
export default createController(routes, {
  actions: {
    // The WebSocket URL function fetches a fresh token here before every connection attempt.
    // A real app would check the user's session first.
    token() {
      return Response.json({ token: issueToken() }, { headers: { 'Cache-Control': 'no-store' } });
    }
  }
});
```

You can also run the WebSocket server as a separate service. The client only needs its URL.

## Keep the connection when you change pages

Once the browser entry calls `run()` from `remix/component`, Remix turns links to your own site into in-place navigations. It fetches the next page's HTML and updates the document, and your JavaScript stays loaded, the shared client with it.

The status badge sits at the same place on every page, so it stays mounted and holds the connection while one page's cards leave and the next page's hydrate. In the example, go to the About page and back: the name in the header stays the same.

## Going to production

```sh
npm start   # production mode, on http://localhost:44100
```

There's no build step: Remix compiles the browser modules on demand. `npm run dev` restarts the server whenever a file changes, which drops the socket. The page reconnects on its own, under a new name.

## Try it

With the example running:

1. **Go to About and back.** The name in the header doesn't change, so the connection was never replaced.
2. **Close the connection**, send a few chat messages, then reconnect. They go out in order.
3. **Make the server misbehave** with the Connection card's buttons, and watch `ready` reject after you close the connection and wait again when you reconnect.
4. **Edit a file** while `npm run dev` is running. The server restarts, and the page reconnects by itself.

## See also

- [Without React](../guide/without-react.md): the whole client API, for any framework
- [Shared clients](../guide/shared-clients.md): what holding a connection means
- [Message state](../guide/state.md): stores that `watchState` reads
- [Astro](./astro.md): another way to share one client between separately hydrated parts of a page
