# react-websocket Remix demo

Every react-websocket feature on one page of a [Remix 3](https://remix.run/) app. Remix 3 components aren't React components, so this demo uses `react-websocket/core`, which has the client and every manager with no React dependency. Each card is a client entry that hydrates on its own, and all of them share one connection.

A walkthrough of this example is in the [Remix 3 recipe](https://mehmetkose.github.io/react-websocket/recipes/remix).

```sh
# From the repository root: build the library, install it here, and start the demo.
npm run example:remix
```

Then open http://localhost:44100, and a second tab for the chat and cursors. Remix 3 needs Node.js 24.3 or later.

## What's on the page

| Card | Shows |
| --- | --- |
| Connection | `acquire()`, `subscribe()` and `getSnapshot()` for the status, `on()` for events, reconnect with backoff, the heartbeat, `schema` validation (zod), the async `url` function (a fresh token per attempt), `shouldReconnect`, and `ready`: waiting, rejected after `close()`, pending again on reconnect. Buttons make the server drop the connection, go silent, refuse the client or send invalid data |
| AI agent | `createWebSocketResponder`. The server's agent asks the page for the selected text and time zone (answered by handlers), then for your approval or for a file (answered by you: `onRequest(method)` without a handler, and the waiting requests from `getSnapshot()`). Stopping the run cancels its request |
| Chat | The send queue: messages sent while disconnected go out in order on reconnect |
| Prices | `createWebSocketTopics` for subscriptions that come back after a reconnect, and `createWebSocketState` for per-symbol re-renders |
| Cursors | Volatile sends (pointer moves are dropped while offline) and keyed sends (only your last color is queued) |
| Requests | `createWebSocketRequests`: replies, error replies, timeouts and `AbortSignal` |
| Latency | `createWebSocketLatency` and `serverNow()`. The demo server's clock runs 2.5 s fast so there's an offset to measure |

The header's status badge shows the status and the name the server gave this connection.

## Remix 3 and react-websocket

**The hooks become bindings.** A Remix component's setup function runs once and returns a render function, and the component calls `handle.update()` to render again. Each react-websocket hook is a small wrapper around a `core` store: subscribe, re-render on change, hold the connection while mounted. `app/live/public/bindings.ts` has the same wrappers for Remix components, built on `handle.queueTask()` and `handle.signal`:

| Hook | Binding |
| --- | --- |
| `useWebSocket(client)` | `watchSnapshot(handle, client)` |
| `useWebSocketStatus(client)` | `watchStatus(handle, client)` |
| `useWebSocketEvent(client, type, listener)` | `listen(handle, client, type, listener)` |
| `useWebSocketState(store, selector)` | `watchState(handle, store, selector)` |
| `useWebSocketTopic(topics, topic)` | `holdTopic(handle, topics, topic)` |
| `useWebSocketLatency(latency)` | `watchLatency(handle, latency)` |
| `useAgentApproval(responder, method)` | `watchRequests(handle, responder, method)` |

The `watch` bindings return a getter to call in the render function. They start in a queued task, which runs after the first render in the browser and never on the server, so nothing connects during a server render. Until then the getters return what the server rendered (`idle`, the store's `initialState`), so hydration matches the HTML.

**Client entries share one client.** Every client entry hydrates separately, so there's no shared provider. The client and its managers are created once in `app/live/public/live.ts`, and every client entry imports that module. The connection opens with the first one to hydrate. State that a card needs on hydration lives in `live.ts` too: the header shows the connection's name from a `createWebSocketState` store, which keeps the `welcome` message even when it arrives before the badge is listening.

**Navigation keeps the connection.** Once the browser entry calls `run()`, Remix turns same-origin links into in-place navigations: it fetches the next page's HTML and updates the document. The JavaScript stays loaded, the shared client with it. The status badge is the same client entry in the same place on every page, so it stays mounted and holds the connection while one page's cards leave and the next page's hydrate. Go to the About page and back: the name in the header stays the same.

**Browser code lives in `public/` directories.** The asset server compiles modules on demand, and only serves `app/routes.ts`, files under `app/**/public/`, and the packages in `allowPackages` (`remix`, `react-websocket` and `zod`). `app/live/token.ts` holds the token secret, so it sits outside `public/` and the browser can't load it.

## Where the WebSocket server runs

The Remix router turns requests into responses, and a WebSocket upgrade isn't one. So `server.ts` passes requests to the router and handles upgrades on the Node server underneath, on the same port. `/api/token` is an ordinary route: it issues the short-lived token the WebSocket URL carries, and the client fetches a fresh one before every connection attempt. In production you might run the WebSocket server separately. The client only needs its URL.

```sh
npm start   # production mode; Remix compiles assets on demand, so there's no build step
```

`npm run dev` restarts the server when a file changes, which drops the socket. The page reconnects on its own, under a new name.

## Files

```
app/live/public/live.ts      The shared client and every manager on it (react-websocket/core)
app/live/public/bindings.ts  The hooks' equivalents for Remix components
app/live/public/protocol.ts  The messages, with the zod schema the client validates against
app/live/token.ts            Issues and checks the short-lived token (server only)
app/ui/public/               One client entry per card, the status badge, and the stylesheet
app/ui/card.tsx              The card around them (server only)
app/actions/                 The controller, the document and both pages, and the browser entry
app/routes.ts                The routes, shared by the server and the browser
app/router.ts, assets.ts     The router, and the asset server that compiles the browser modules
server.ts                    The Node server: the router, plus WebSocket upgrades on /ws
demo-server.ts               The demo's WebSocket backend (chat, prices, RPC, clock, agent)
```

## Working on the library

The demo installs the library from `../..` as a copy of the built package, the way an app would get it from npm. After changing the library, run this here and restart the dev server:

```sh
npm run update-library
```

npm also installs React, as the package's peer dependency, but nothing here imports it. Run `npm run typecheck` to check the types.
