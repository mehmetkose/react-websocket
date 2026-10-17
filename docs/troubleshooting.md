---
title: 'Troubleshooting WebSockets in React'
description: 'Fixes for common react-websocket problems: two sockets in development, ignored options, a stuck status, missing messages, close codes, Next.js and TypeScript.'
---

# Troubleshooting

Answers to the questions that come up most. If yours isn't here, [open a discussion](https://github.com/mehmetkose/react-websocket/discussions) or [file an issue](https://github.com/mehmetkose/react-websocket/issues).

:::tip Turn on logging first
`logger: console.debug` makes the client explain itself: every connection attempt, close, retry delay, heartbeat timeout and dropped message.

```ts
useWebSocket(url, { logger: console.debug });
```

To watch it instead, render [`<WebSocketDevtools />`](./api/devtools.md) in development: a panel with each client's status, attempts, queue, send buffer, messages, round-trip time and topics.
:::

## I see two sockets in development

**Not from StrictMode.** StrictMode mounts, unmounts and re-mounts every component in development, and since React 19.3 it does this during hydration too. The client closes a connection one tick after its last user unmounts, so the immediate re-mount reuses the same socket. You should see exactly one connection per URL.

If you do see two, the hooks aren't sharing a connection. URL hooks share a socket only when the URL string **and** `protocols` are identical:

- `wss://api.example.com/live` and `wss://api.example.com/live/` are different URLs.
- So are URLs whose query parameters differ in order, or that contain a changing value like a timestamp.
- `useWebSocket(url)` and a `createWebSocket(url)` client never share, even with the same URL. Pick one.

Also check that you don't have two copies of the package installed (`npm ls react-websocket`); each copy has its own registry.

## My options are ignored

Components using the same URL share one client, and its options come from **the first component to mount** with that URL. Later components' connection options (`json`, `reconnect`, `heartbeat`, …) don't apply. Handlers (`onMessage`, …) and `enabled` are always per component.

If different components need different options, or you want them defined in one place, use a [shared client](./guide/shared-clients.md):

```ts
export const live = createWebSocket(url, { json: true, heartbeat: { interval: 25_000 } });
```

## The status is stuck at `idle`

`idle` means nothing is trying to connect. Check that:

- the URL isn't `null` or `undefined`,
- `enabled` isn't `false`,
- you're not looking at server-rendered HTML: during a server render the hooks always render `idle` and connect after hydration,
- the component isn't inside a hidden [`<Activity>`](./guide/lifecycle.md), which releases its connections,
- outside a browser (Node, a test runner without a DOM) you passed a `WebSocket` implementation. Without `window`, the client won't use a global `WebSocket` on its own.

## The status is `closed` and it doesn't reconnect

`closed` is final until you call `connect()` or `reconnect()`, or every component using the client unmounts. It happens when:

- `close()` was called,
- the client gave up after `reconnect.maxAttempts` failures,
- `reconnect.shouldReconnect` returned `false`. By default it does for close codes `1002`, `1003` and `1008`,
- `reconnect: false` is set and the connection closed,
- the `WebSocket` constructor threw (usually an invalid URL, such as a missing `ws://` or `wss://`). Retrying wouldn't help, so the client doesn't.

Listen with `onClose` and `onError` to see which.

## Reconnects keep getting slower

A connection resets the backoff only once it has stayed open for [`reconnect.minUptime`](./api/options.md#reconnect) (5 seconds by default). If the server keeps closing connections sooner, often because it rejects the credentials sent on open, each retry waits longer than the last, up to `maxDelay`. Check `onClose` for the code and reason the server sends. If your server closes connections on purpose shortly after opening them, lower `minUptime`.

## Messages don't arrive

- **They fail to decode.** With `json: true`, `parse` or `schema`, a message that can't be parsed or fails validation is **not delivered**. It's reported to `onError` (and the `error` event) as a [`MessageError`](./api/types.md#messageerror) carrying the raw `data` and the schema `issues`:

  ```ts
  onError(error) {
    if (error instanceof MessageError) console.warn('Bad message', error.data, error.issues);
  }
  ```

- **They're heartbeat replies.** Data exactly equal to `heartbeat.pong` is swallowed.
- **You're listening with the wrong hook.** `useWebSocketStatus` doesn't re-render on messages. Use `useWebSocket` (`lastMessage`, `onMessage`) or `useWebSocketEvent`.
- **They arrived before you listened.** Events aren't replayed. `lastMessage` keeps the most recent message for late subscribers; anything else, have the server send on subscribe.

## My Suspense fallback shows up again

`use(client.ready)` suspends until the **first** connection. `ready` stays resolved through automatic reconnects, so network blips don't swap your UI for the fallback. Show reconnects with `status` instead.

You'll see the fallback again when the client starts over:

- after `close()`, or after it gave up, followed by `connect()` or `reconnect()`,
- after every component using the client unmounted (for example, a route change) and a new one mounts.

See [Suspense](./guide/suspense.md).

## The connection drops every minute or so

Load balancers and proxies (nginx, AWS ALB, Cloudflare, corporate proxies) close connections that are idle for a while, often 60 seconds. Have one side send something periodically. With the [`heartbeat`](./api/options.md#heartbeat) option the client pings:

```ts
createWebSocket(url, {
  heartbeat: { interval: 25_000, message: 'ping', pong: 'pong', timeout: 10_000 }
});
```

`timeout` also catches dead connections that never report a close, like a laptop waking from sleep: if nothing arrives within `timeout` ms of a ping, the client closes with code `4000` and reconnects. A ping goes out as soon as the browser comes back online or the tab becomes visible, so after sleep that takes `timeout`, not up to `interval` more.

## Close codes

`onClose` receives `{ code, reason, wasClean }`. The codes you'll see most:

| Code | Meaning | Typical cause |
| --- | --- | --- |
| `1000` | Normal closure | `close()` was called, or the server finished normally |
| `1001` | Going away | Server restart or deploy, or the page navigated away |
| `1006` | Abnormal closure | No close frame: network loss, server crash, failed handshake (bad URL path, auth rejected at upgrade, TLS error). Browsers deliberately hide the details |
| `1008` | Policy violation | The server rejected the client, often for auth or origin. Not retried by default |
| `1011` | Internal error | The server hit an unexpected error |
| `4000` | Heartbeat timeout | Set by this library when a `heartbeat.timeout` expires |
| `4001`–`4999` | Application-defined | Your server's own meanings, e.g. `4001` for unauthorized |

The client doesn't retry `1002` (protocol error), `1003` (unsupported data) or `1008`, and retries every other code. To change which codes are retried, see [`shouldReconnect`](./api/options.md#reconnect).

## `WebSocket is not defined`, or nothing connects in tests

The client never touches the global `WebSocket` during a server render or in Node without a DOM, so the library itself doesn't throw this. If your test environment has no `window`, nothing connects. In jsdom it would try a real network connection. In both cases, pass a fake through the `WebSocket` option. See [Testing](./guide/testing.md).

In Node, pass Node's built-in `WebSocket` (Node 22+) or the `ws` package explicitly. See [Without React](./guide/without-react.md#node).

## Next.js: errors about hooks or `'use client'`

The `react-websocket` entry is marked `'use client'`, so its hooks and clients run on the client only. Two rules:

1. **Call the hooks from Client Components.** A component that calls `useWebSocket` must be in a file starting with `'use client'`, or be imported from one. Server Components can render it.
2. **Import `createWebSocket` from `react-websocket/core` in shared modules.** Exports of a `'use client'` module are client references when imported from server code, so a module that defines a client and is also imported by server code should use `react-websocket/core`, which has no directive.

See [Server rendering and Next.js](./guide/ssr.md).

## TypeScript: `lastMessage` is `unknown`

Give the hook or client the message types, or a schema to infer them from:

```ts
useWebSocket<Incoming, Outgoing>(url, { json: true });
createWebSocket(url, { json: true, schema: Incoming }); // In inferred from the schema
```

The type parameters describe what you expect; only a `schema` checks it at runtime. See [Messages and types](./guide/messages.md).
