# react-websocket Astro demo

Every react-websocket feature on one page of [Astro](https://astro.build/) islands. Each card is a separate island that hydrates on its own schedule, and all of them share one connection. One card uses that connection with no React at all.

```sh
# From the repository root: build the library, install it here, and start the demo.
npm run example:astro
```

Then open http://localhost:4321, and a second tab for the chat and cursors.

## What's on the page

| Card | Shows |
| --- | --- |
| Connection | `useWebSocket`, `useWebSocketEvent`, reconnect with backoff, the heartbeat, `schema` validation (zod), the async `url` function (a fresh token per attempt), `shouldReconnect`, and Suspense with `use(client.ready)` in a `client:only` island. Buttons make the server drop the connection, go silent, refuse the client or send invalid data |
| AI agent | `createWebSocketResponder` and `useAgentApproval`. The server's agent asks the page for the selected text and time zone (answered by handlers), then for your approval or for a file (answered by you). Stopping the run cancels its request |
| Chat | The send queue: messages sent while disconnected go out in order on reconnect |
| Prices | `createWebSocketTopics` and `useWebSocketTopic` for subscriptions that come back after a reconnect, and `createWebSocketState` and `useWebSocketState` for per-symbol re-renders |
| Cursors | Volatile sends (pointer moves are dropped while offline) and keyed sends (only your last color is queued) |
| Requests | `createWebSocketRequests`: replies, error replies, timeouts and `AbortSignal` |
| Latency | `createWebSocketLatency`, `useWebSocketLatency` and `serverNow()`. The demo server's clock runs 2.5 s fast so there's an offset to measure |
| Without React | `react-websocket/core` in a plain `<script>`: a custom element that holds the connection with `acquire()`, watches the status with `subscribe()` and `getSnapshot()`, and counts messages with `on()` |

The header's status badge uses `useWebSocketStatus`, and shows the name the server gave this connection.

## Astro and react-websocket

**Islands share one client.** Every island is its own React root, so there's no shared provider. There doesn't need to be: the client and its managers are created once in `src/lib/live.ts`, and every island imports that module. Islands hydrate with `client:load`, `client:idle` or `client:visible`, and each joins the connection when it mounts. The connection opens with the first one.

**State that an island needs on hydration lives outside it.** An island that hydrates late misses the events that came before it. The header shows the connection's name from a `createWebSocketState` store in `live.ts`, which keeps the `welcome` message even when it arrives before the badge mounts. A `useWebSocketEvent` listener inside the badge would miss it.

**Suspense goes in a `client:only` island.** On the server, `client.ready` rejects: there's nothing to connect to. Rendered with `client:only="react"`, the island skips server rendering, and its `slot="fallback"` content shows until it loads. The Suspense boundary goes inside the island, because each island is a separate React root.

**Navigation keeps the connection, with the client router.** By default every Astro link is a full page load, and a full page load is a new connection. The layout adds `<ClientRouter />`, so pages swap in place and the JavaScript (the client with it) stays loaded. The status badge is a `transition:persist` island: it stays mounted through the swap and holds the connection while the old page's islands unmount and the new page's hydrate. Go to the About page and back: the name in the header stays the same.

**Plain scripts work too.** `react-websocket/core` has no React dependency, so a `<script>` in an `.astro` component can use the same client. A custom element is a good fit: `connectedCallback` and `disconnectedCallback` set it up and clean up, including when the client router swaps pages.

## Where the WebSocket server runs

Astro endpoints can't accept WebSocket upgrades, so the socket is attached to the HTTP server underneath:

- **Development:** an integration in `astro.config.ts` adds an `upgrade` listener to Astro's dev server in the `astro:server:setup` hook. It handles `/ws` and leaves Vite's hot reload socket alone.
- **Production:** the Node adapter builds in `middleware` mode, and `server.ts` mounts it in Express, as in [Astro's docs](https://docs.astro.build/en/guides/integrations-guide/node/), then handles upgrades on the same port.

```sh
npm run build   # prerendered pages and assets in dist/client, the server entry in dist/server
npm start       # http://localhost:4321
```

The pages are prerendered to static HTML. Only `/api/token` runs on demand: it issues the short-lived token the WebSocket URL carries. In production you might run the WebSocket server separately. The client only needs its URL.

## Files

```
src/lib/live.ts          The shared client and every manager on it (react-websocket/core)
src/lib/protocol.ts      The messages, with the zod schema the client validates against
src/components/          One React island per card, plus Card.astro and Traffic.astro (no React)
src/layouts/Layout.astro The header, the persisted status badge and <ClientRouter />
src/pages/index.astro    The demo page
src/pages/about.astro    A second page, to navigate to and back
src/pages/api/token.ts   Issues the short-lived token the WebSocket URL carries
astro.config.ts          React, the Node adapter, and the WebSocket server in development
server.ts                The production server: Express, the built site and /ws
demo-server.ts           The demo's WebSocket backend (chat, prices, RPC, clock, agent)
```

## Working on the library

The demo installs the library from `../..` as a copy of the built package, the way an app would get it from npm. It isn't a symlink, so React isn't loaded twice. After changing the library, run this here and restart the dev server:

```sh
npm run update-library
```

`npm run typecheck` runs `astro check`, which covers the `.astro` files and the TypeScript.
