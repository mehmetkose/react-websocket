# Why react-websocket

This page covers what the library does for you, what it deliberately doesn't do, and how it fits into a React app.

## The problem

The browser's `WebSocket` is a low-level object. Using it well in React takes a surprising amount of code:

- **Lifecycle.** A socket opened in an Effect must be closed in its cleanup. StrictMode runs Effects twice in development, `<Activity>` unmounts and remounts them, and route transitions remount whole trees. A naive hook opens and closes sockets constantly.
- **Sharing.** Two components that need the same feed should not open two connections.
- **Reconnecting.** Networks drop. You need backoff, jitter so that a thousand clients don't reconnect at the same instant, and a fast retry when the laptop wakes up.
- **Sending early.** A `send()` made before the socket is open throws `InvalidStateError`.
- **Stale handlers.** A message handler registered in an Effect sees the props and state from the render that registered it, unless you reconnect every time they change.
- **Types.** `event.data` is `any`. Production code needs parsing and validation.
- **Server rendering.** Node has a global `WebSocket` too, so a careless hook opens connections from your server.

react-websocket handles all of this in about 2.5 kB.

## How it works

At the core is a **client**: a small store that owns at most one `WebSocket` at a time. It implements the `subscribe`/`getSnapshot` contract of [`useSyncExternalStore`](https://react.dev/reference/react/useSyncExternalStore), so React always renders a consistent status, even during concurrent rendering.

```
 component ─┐                         ┌──────────── client ────────────┐
 component ─┼─ hooks ─ acquire() ───▶ │ status · lastMessage · attempt │ ──▶ WebSocket
 component ─┘          release()      │ queue · backoff · heartbeat    │
                                      └────────────────────────────────┘
```

The client is **reference-counted**. Each mounted hook holds the connection. The first hold opens it, and it closes one tick after the last hold is released. That tick is what lets StrictMode's mount → unmount → mount, an `<Activity>` toggle, or a route change re-acquire the same socket instead of reopening it.

You get clients in two ways:

- **By URL.** `useWebSocket('wss://…')` looks up a client for that URL (and sub-protocols). Every component using the same URL shares it.
- **Explicitly.** `createWebSocket('wss://…', options)` at module level gives you a client to import anywhere, use from several hooks, and call outside React.

## Design principles

- **Hooks-first, store underneath.** Everything a hook does is also available on the client, so non-React code (and tests) can use the same connection.
- **Correct by default.** Queueing, reconnecting and StrictMode safety are on without configuration.
- **No surprises for React.** Handlers always see your latest props and state, the same idea as React's [`useEffectEvent`](https://react.dev/reference/react/useEffectEvent), so changing them never reconnects. `send`, `close` and `reconnect` keep the same identity between renders.
- **Small and dependency-free.** No runtime dependencies. ESM and CommonJS, fully typed, tree-shakable.

## What it doesn't do

- **No protocol.** It doesn't impose a message format, rooms, acknowledgements or request/response semantics. Build them on top; the [recipes](../recipes.md) show how.
- **No Socket.IO, SignalR or STOMP.** Those have their own wire protocols and clients.
- **No server.** Use any WebSocket server: Node's `ws`, Django Channels, Tornado, Go, Phoenix, Cloudflare Durable Objects, and so on.

## Requirements

| | |
| --- | --- |
| React | 18 or 19. `use(client.ready)` needs React 19. `<Activity>` support is automatic on React 19.2+. |
| Browsers | Every browser with `WebSocket` and ES2022 support. |
| TypeScript | Optional. Types ship with the package; TypeScript 5.4+ is recommended. |
| Server rendering | Supported. See [Server rendering and Next.js](./ssr.md). |

Ready? [Get started](./getting-started.md).
