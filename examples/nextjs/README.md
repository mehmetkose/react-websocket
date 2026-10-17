# react-websocket Next.js demo

Every react-websocket feature on one page: a Next.js App Router app with its own WebSocket server, sharing one connection.

```sh
# From the repository root: build the library, install it here, and start the demo.
npm run example:nextjs
```

Then open http://localhost:3000, and a second tab for the chat and cursors.

## What's on the page

| Card | Shows |
| --- | --- |
| Connection | `useWebSocket`, `useWebSocketEvent`, `useWebSocketStatus`, reconnect with backoff, the heartbeat, `schema` validation (zod), the async `url` function (a fresh token per attempt), `shouldReconnect`, and Suspense with `use(client.ready)`. Buttons make the server drop the connection, go silent, refuse the client or send invalid data |
| AI agent | `createWebSocketResponder` and `useAgentApproval`. The server's agent asks the page for the selected text and time zone (answered by handlers), then for your approval or for a file (answered by you). Stopping the run cancels its request |
| Chat | The send queue: messages sent while disconnected go out in order on reconnect |
| Prices | `createWebSocketTopics` and `useWebSocketTopic` for subscriptions that come back after a reconnect, and `createWebSocketState` and `useWebSocketState` for per-symbol re-renders |
| Cursors | Volatile sends (pointer moves are dropped while offline) and keyed sends (only your last color is queued) |
| Requests | `createWebSocketRequests`: replies, error replies, timeouts and `AbortSignal` |
| Latency | `createWebSocketLatency`, `useWebSocketLatency` and `serverNow()`. The demo server's clock runs 2.5 s fast so there's an offset to measure |

The page itself is a Server Component, and the cards are Client Components that connect after hydration. View the source to see them rendered as `idle`.

## Files

```
lib/live.ts        The shared client and every manager on it (react-websocket/core)
lib/protocol.ts    The messages, with the zod schema the client validates against
components/        One Client Component per card
app/page.tsx       The page (a Server Component)
app/api/token/     Issues the short-lived token the WebSocket URL carries
server.ts          A custom Next.js server: the app plus WebSocket upgrades on /ws
demo-server.ts     The demo's WebSocket backend (chat, prices, RPC, clock, agent)
```

Next.js route handlers can't accept WebSocket upgrades, so `server.ts` is a [custom server](https://nextjs.org/docs/app/guides/custom-server) that serves the app and the socket on one port. In production you'd more often run the WebSocket server separately. The client only needs its URL.

## Working on the library

The demo installs the library from `../..` as a copy of the built package, the way an app would get it from npm. It isn't a symlink, so React isn't loaded twice. After changing the library, run this here and restart the server:

```sh
npm run update-library
```

Other scripts: `npm run build` and `npm start` for a production build, and `npm run typecheck`.
