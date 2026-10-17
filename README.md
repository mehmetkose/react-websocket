# react-websocket

**Hooks-first WebSocket client for React 18 and 19.** Shared connections, automatic reconnects, a send queue, typed and validated messages, and Suspense, in about 3 kB (min+gzip) with zero dependencies.

[![npm](https://img.shields.io/npm/v/react-websocket.svg)](https://www.npmjs.com/package/react-websocket)
[![CI](https://github.com/mehmetkose/react-websocket/actions/workflows/ci.yml/badge.svg)](https://github.com/mehmetkose/react-websocket/actions/workflows/ci.yml)
[![bundle size](https://img.shields.io/bundlejs/size/react-websocket)](https://bundlejs.com/?q=react-websocket)
[![types](https://img.shields.io/npm/types/react-websocket.svg)](https://www.npmjs.com/package/react-websocket)
[![license](https://img.shields.io/npm/l/react-websocket.svg)](LICENSE)
[![FOSSA Status](https://app.fossa.io/api/projects/git%2Bgithub.com%2Fmehmetkose%2Freact-websocket.svg?type=shield)](https://app.fossa.io/projects/git%2Bgithub.com%2Fmehmetkose%2Freact-websocket?ref=badge_shield)

**[Documentation](https://mehmetkose.github.io/react-websocket/)** · [Getting started](https://mehmetkose.github.io/react-websocket/guide/getting-started) · [API](https://mehmetkose.github.io/react-websocket/api/) · [Recipes](https://mehmetkose.github.io/react-websocket/recipes) · [Changelog](CHANGELOG.md)

- **Shared connections.** Components using the same URL share one socket. StrictMode, `<Activity>` and route transitions never open duplicates.
- **Auto-reconnect.** Exponential backoff with jitter, plus an immediate retry when the browser comes back online or the tab becomes visible. Optional heartbeats detect dead links.
- **Send queue.** `send()` before the socket is open just works. The message goes out on connect. Mark input `volatile` so it's never replayed late, or `key` it so only the newest is sent.
- **Typed messages.** `json: true`, your own codec, or validation with any [Standard Schema](https://standardschema.dev) library (zod, valibot, arktype), with inferred types.
- **Suspense.** `use(client.ready)` waits for the first connection, and reconnects never flash a fallback.
- **Topic subscriptions.** Reference-counted `subscribe`/`unsubscribe` messages that are sent again after every reconnect, so feeds don't silently stop.
- **Message state.** Reduce messages into a store, and let each component re-render only when its slice changes.
- **Requests and latency.** Await replies with timeouts and cancellation, and measure round-trip time and the server's clock for ping displays and synchronized countdowns.
- **Server requests.** Answer requests from the server, such as an AI agent's, in code for browser-only tools, or from a dialog for human approval. Every request gets exactly one reply, and none is sent to the wrong connection.
- **SSR-safe.** Never connects during a server render, hydrates cleanly, and ships a `'use client'` entry for Next.js and other Server Components frameworks.
- **Small and typed.** Zero dependencies, ESM + CJS, TypeScript declarations with inline docs, plus a React-free `react-websocket/core` entry.

## Install

```sh
npm install react-websocket
```

## Quick start

```tsx
import { useState } from 'react';
import { useWebSocket } from 'react-websocket';

type ChatIn = { user: string; text: string };
type ChatOut = { text: string };

function Chat() {
  const [messages, setMessages] = useState<ChatIn[]>([]);
  const { status, send } = useWebSocket<ChatIn, ChatOut>('wss://api.example.com/chat', {
    json: true,
    onMessage: message => setMessages(list => [...list, message])
  });

  return (
    <>
      <p>{status}</p>
      <ul>
        {messages.map((m, i) => (
          <li key={i}>
            {m.user}: {m.text}
          </li>
        ))}
      </ul>
      <button onClick={() => send({ text: 'hi' })}>Say hi</button>
    </>
  );
}
```

Handlers always see your latest props and state, and changing them never reconnects. `send`, `close` and `reconnect` keep the same identity between renders.

## Shared clients

Define a connection once and use it anywhere, including outside React:

```tsx
import { createWebSocket, useWebSocketEvent, useWebSocketStatus } from 'react-websocket';

export const chat = createWebSocket<ChatIn, ChatOut>('wss://api.example.com/chat', { json: true });

function Messages() {
  const [messages, setMessages] = useState<ChatIn[]>([]);
  useWebSocketEvent(chat, 'message', m => setMessages(list => [...list, m])); // no re-render per message
  return <ul>{/* … */}</ul>;
}

function Header() {
  const status = useWebSocketStatus(chat); // re-renders only when the status changes
  return <button onClick={() => chat.send({ text: 'hi' })}>Say hi ({status})</button>;
}
```

The client connects when the first component uses it and closes a tick after the last one unmounts.

## Suspense

```tsx
import { use, Suspense } from 'react';

function Room() {
  use(chat.ready); // React 19: suspend until the first connection
  return <Messages />;
}

<ErrorBoundary fallback={<Retry onClick={() => chat.reconnect()} />}>
  <Suspense fallback={<Spinner />}>
    <Room />
  </Suspense>
</ErrorBoundary>;
```

`ready` stays resolved through automatic reconnects, so a network blip shows your `status` UI instead of replacing the page with a spinner. It rejects if the client gives up or `close()` is called.

## API at a glance

| Export | |
| --- | --- |
| `useWebSocket(url \| client, options?)` | Connect; returns `{ status, lastMessage, attempt, send, close, reconnect, client }` |
| `useWebSocketEvent(client, type, listener)` | Handle `'open'`, `'message'`, `'close'` or `'error'` without re-rendering |
| `useWebSocketStatus(client)` | The status; re-renders only when it changes |
| `useWebSocketTopic(topics, topic)` | Hold topic subscriptions that survive reconnects |
| `useWebSocketState(store, selector?)` | Read state reduced from messages; re-renders only when the selection changes |
| `useWebSocketLatency(latency)` | Round-trip time and server clock offset |
| `useAgentApproval(responder, method)` | Requests from the server waiting for a person to answer |
| `createWebSocket(url, options?)` | A shareable client: `send`, `on`, `connect`, `close`, `reconnect`, `ready`, `getSnapshot`, `subscribe` |
| `createWebSocketTopics(client, { subscribe, unsubscribe })` | Topic subscription manager for `useWebSocketTopic` |
| `createWebSocketState(client, { initialState, reduce })` | Message-state store for `useWebSocketState` |
| `createWebSocketRequests(client, { send, reply })` | `request(message)` returns a promise of the reply, with timeouts |
| `createWebSocketLatency(client, { ping, pong })` | Ping tracker for `useWebSocketLatency`, plus `serverNow()` |
| `createWebSocketResponder(client, { request, respond, error })` | Answer the server's requests: `onRequest(method, handler)`, or a person through `useAgentApproval` |
| `MessageError` | Reported to `onError` when a message fails `parse` or `schema` |

| Option | Default | |
| --- | --- | --- |
| `protocols` | | Sub-protocols for the `WebSocket` constructor |
| `binaryType` | `'blob'` | |
| `json` | `false` | `JSON.parse` incoming and `JSON.stringify` outgoing messages |
| `parse(data)` / `serialize(message)` | | Custom codec; takes precedence over `json` |
| `schema` | | Standard Schema validation; types are inferred |
| `reconnect` | `true` | `false`, or `{ maxAttempts, minDelay, maxDelay, factor, jitter, shouldReconnect }` |
| `heartbeat` | | `{ interval, message, pong, timeout }` |
| `queue` | `true` | `false`, or `{ limit }` |
| `logger` | | e.g. `console.debug` |
| `WebSocket` | global | Custom implementation for tests or Node |

`useWebSocket` also takes `onOpen`, `onMessage`, `onClose`, `onError` and `enabled`. The [API reference](https://mehmetkose.github.io/react-websocket/api/) documents everything.

## Guides

- [Shared clients](https://mehmetkose.github.io/react-websocket/guide/shared-clients) · [Messages and types](https://mehmetkose.github.io/react-websocket/guide/messages) · [Reconnecting and heartbeats](https://mehmetkose.github.io/react-websocket/guide/reconnecting)
- [Suspense](https://mehmetkose.github.io/react-websocket/guide/suspense) · [Server rendering and Next.js](https://mehmetkose.github.io/react-websocket/guide/ssr) · [StrictMode, Activity and lifecycle](https://mehmetkose.github.io/react-websocket/guide/lifecycle)
- [Authentication](https://mehmetkose.github.io/react-websocket/guide/authentication) · [Performance](https://mehmetkose.github.io/react-websocket/guide/performance) · [Real-time games](https://mehmetkose.github.io/react-websocket/guide/games) · [AI agents](https://mehmetkose.github.io/react-websocket/guide/agents) · [Testing](https://mehmetkose.github.io/react-websocket/guide/testing) · [Without React](https://mehmetkose.github.io/react-websocket/guide/without-react)
- [Recipes](https://mehmetkose.github.io/react-websocket/recipes) · [Troubleshooting](https://mehmetkose.github.io/react-websocket/troubleshooting) · [Migrating from v2](https://mehmetkose.github.io/react-websocket/migration)

The docs source lives in [`docs/`](docs). Run `npm run docs:dev` to browse it locally.

## Compatibility

| | |
| --- | --- |
| React | 18 and 19 (`use(client.ready)` needs 19; `<Activity>` is handled on 19.2+). Tested in CI against both |
| Runtimes | Modern browsers; Node via the `WebSocket` option |
| Frameworks | Vite, Next.js (App and Pages Router), Remix/React Router, Astro islands, and any React setup |

## Migrating from v2

v2 was a `<Websocket>` class component. v3 replaces it with hooks: `<Websocket url onMessage />` becomes `useWebSocket(url, { onMessage })`, and `ref.sendMessage(msg)` becomes `send(msg)`. See the [migration guide](https://mehmetkose.github.io/react-websocket/migration) for the full mapping.

## Examples

- [`examples/nextjs`](examples/nextjs) is a demo of every feature in a Next.js App Router app, with its own WebSocket server. Run `npm run example:nextjs` and open http://localhost:3000.
- [`examples/astro`](examples/astro) is the same demo of every feature as Astro islands sharing one connection, with a page that keeps it open across navigation. Run `npm run example:astro` and open http://localhost:4321.
- [`examples/hono`](examples/hono) is a chat room with presence: a Hono server on Node.js and a Vite + React 19 client sharing one set of message types. Run `npm run example:hono` and open http://localhost:5173.
- [`examples/tornado`](examples/tornado) is a small broadcast chat: a Tornado server and a Vite + React 19 client.

## Contributing

Contributions are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md). To report a vulnerability, follow [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE)

[![FOSSA Status](https://app.fossa.io/api/projects/git%2Bgithub.com%2Fmehmetkose%2Freact-websocket.svg?type=large)](https://app.fossa.io/projects/git%2Bgithub.com%2Fmehmetkose%2Freact-websocket?ref=badge_large)
