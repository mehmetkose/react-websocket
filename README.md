# react-websocket [![contributions welcome](https://img.shields.io/badge/contributions-welcome-brightgreen.svg?style=flat)](https://github.com/mehmetkose/react-websocket/edit/master/README.md) [![FOSSA Status](https://app.fossa.io/api/projects/git%2Bgithub.com%2Fmehmetkose%2Freact-websocket.svg?type=shield)](https://app.fossa.io/projects/git%2Bgithub.com%2Fmehmetkose%2Freact-websocket?ref=badge_shield)

Hooks-first WebSocket client for React 18 and 19.

- **Shared connections:** components using the same URL share one socket, and StrictMode never opens duplicates.
- **Auto-reconnect:** exponential backoff with jitter. It also retries right away when the browser comes back online or the tab becomes visible.
- **Send queue:** `send()` before the socket is open just works; the message goes out on connect.
- **Typed messages:** `json: true`, or your own parser, or validate with any [Standard Schema](https://standardschema.dev) library (zod, valibot, arktype).
- **Suspense:** `use(socket.ready)` waits until the socket is connected.
- **SSR-safe:** never connects during a server render. Hooks are marked `'use client'`.
- Zero dependencies, ESM + CJS, written in TypeScript.

## Help Wanted

Things here are running very slowly as I have a lot of other stuff to take care at the moment so please don't be upset if I don't answer your question or if a PR sits unreviewed for a few days or weeks. Anyone interested in helping it move faster can help by submitting or reviewing PR's and answering each other's questions.

## Install

```sh
npm install react-websocket
```

## Quick start

```tsx
import { useState } from 'react';
import { useWebSocket } from 'react-websocket';

function ProductDetail({ id }: { id: string }) {
  const [count, setCount] = useState(90);
  const { status, send } = useWebSocket<{ movement: number }>(`wss://api.example.com/live/product/${id}`, {
    json: true,
    onMessage: ({ movement }) => setCount(c => c + movement)
  });

  return (
    <div>
      Count: <strong>{count}</strong> ({status})
      <button onClick={() => send({ type: 'refresh' })}>Refresh</button>
    </div>
  );
}
```

`useWebSocket(url, options)` returns:

| Field | |
| --- | --- |
| `status` | `'idle' \| 'connecting' \| 'open' \| 'reconnecting' \| 'closed'` |
| `lastMessage` | The latest (parsed) message, or `undefined` |
| `attempt` | Consecutive failed attempts since the last successful open |
| `send(message)` | Sends now, or queues until open. Returns `true` if it was sent immediately |
| `close(code?, reason?)` | Closes and stops reconnecting |
| `reconnect()` | Drops the socket and connects again right away |
| `client` | The underlying client (see below) |

`send`, `close` and `reconnect` keep the same identity between renders. Handlers (`onOpen`, `onMessage`, `onClose`, `onError`) always see your latest props and state, and changing them never reconnects. Pass `url = null` or `enabled: false` to stay disconnected.

`useWebSocket` re-renders on every message, so it fits low-to-moderate traffic. For high-frequency streams, see below.

## Shared clients

Define a connection once at module level and use it anywhere:

```tsx
import { createWebSocket, useWebSocketEvent, useWebSocketStatus } from 'react-websocket';

type ChatIn = { user: string; text: string };
type ChatOut = { text: string };

export const chat = createWebSocket<ChatIn, ChatOut>('wss://api.example.com/chat', { json: true });

function Messages() {
  const [messages, setMessages] = useState<ChatIn[]>([]);
  // Listen without re-rendering on every message.
  useWebSocketEvent(chat, 'message', m => setMessages(list => [...list, m]));
  return <ul>{messages.map((m, i) => <li key={i}>{m.user}: {m.text}</li>)}</ul>;
}

function Header() {
  const status = useWebSocketStatus(chat); // re-renders only when the status changes
  return <button onClick={() => chat.send({ text: 'hi' })}>Say hi ({status})</button>;
}
```

The client connects lazily, the first time a hook mounts or `ready` is read. It closes a tick after the last hook unmounts. That tick is why StrictMode's mount/unmount/mount and route transitions don't churn the socket.

### Suspense

```tsx
import { use, Suspense } from 'react';

function Room() {
  use(chat.ready); // React 19: suspend until connected
  return <Messages />;
}

<ErrorBoundary fallback={<Retry onClick={() => chat.reconnect()} />}>
  <Suspense fallback={<Spinner />}>
    <Room />
  </Suspense>
</ErrorBoundary>;
```

`ready` resolves when the socket opens. It rejects (and goes to the error boundary) if the client gives up reconnecting or `close()` is called. During a server render it rejects, so React renders that boundary on the client instead.

## Options

Pass these to `createWebSocket(url, options)` or `useWebSocket(url, options)`:

| Option | Default | |
| --- | --- | --- |
| `protocols` | | Sub-protocols for the `WebSocket` constructor |
| `binaryType` | `'blob'` | |
| `json` | `false` | `JSON.parse` incoming and `JSON.stringify` outgoing messages |
| `parse(data)` | | Custom decoder; takes precedence over `json` |
| `serialize(message)` | | Custom encoder; takes precedence over `json` |
| `schema` | | Standard Schema to validate incoming messages. Types are inferred from it |
| `reconnect` | `true` | `false`, or `{ maxAttempts: Infinity, minDelay: 1000, maxDelay: 30000, factor: 2, jitter: 0.5, shouldReconnect(close) }` |
| `heartbeat` | | `{ interval, message: 'ping', pong?, timeout? }`. A missing reply within `timeout` forces a reconnect |
| `queue` | `true` | Buffer `send()` calls while not open |
| `logger` | | e.g. `console.debug` |
| `WebSocket` | global | Custom implementation (tests, Node) |

`useWebSocket` also accepts `onOpen`, `onMessage(message, event)`, `onClose({ code, reason, wasClean })`, `onError(error)` and `enabled`.

Hooks that share a URL also share one connection, and its options come from whichever hook created it first. If you need different options for the same URL, use `createWebSocket`.

Messages that fail `parse` or `schema` aren't delivered. They're reported to `onError` as a `MessageError` carrying `data` and `issues`.

```ts
import { z } from 'zod';

const Tick = z.object({ symbol: z.string(), price: z.number() });
const prices = createWebSocket('wss://api.example.com/ticks', { json: true, schema: Tick });
// prices.getSnapshot().lastMessage is typed { symbol: string; price: number } | undefined
```

### Without React

`react-websocket/core` exports `createWebSocket` with no React dependency. The client is a plain store with `subscribe`, `getSnapshot`, `on`, `send`, `connect`, `close`, `reconnect` and `ready`.

## Migrating from v2

v2 was a class component that rendered an empty `<div>`. v3 replaces it with hooks.

| v2 | v3 |
| --- | --- |
| `<Websocket url onMessage />` | `useWebSocket(url, { onMessage })` |
| `ref.sendMessage(msg)` | `const { send } = useWebSocket(...)` |
| `onOpen` / `onClose(code, reason)` / `onError` | `onOpen` / `onClose({ code, reason, wasClean })` / `onError` |
| `reconnect={false}` | `reconnect: false` |
| `reconnectIntervalInMilliSeconds={n}` | `reconnect: { minDelay: n, maxDelay: n, jitter: 0 }` |
| `protocol="x"` | `protocols: 'x'` |
| `debug` | `logger: console.debug` |
| `ref.open()` / `ref.close()` | `enabled`, or `reconnect()` / `close()` |
| Raw `evt.data` passed to `onMessage` | Same by default; `json: true` to parse |

## Example

See [`example/`](example) for a Tornado broadcast server and a Vite + React 19 client.

## License
[![FOSSA Status](https://app.fossa.io/api/projects/git%2Bgithub.com%2Fmehmetkose%2Freact-websocket.svg?type=large)](https://app.fossa.io/projects/git%2Bgithub.com%2Fmehmetkose%2Freact-websocket?ref=badge_large)
