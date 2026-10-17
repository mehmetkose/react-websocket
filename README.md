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
- **Auto-reconnect.** Exponential backoff with full jitter, plus an immediate retry when the browser comes back online or the tab becomes visible. It backs off from a server that closes right after accepting, and stops on close codes that retrying can't fix. Optional heartbeats detect dead links.
- **Send queue.** `send()` before the socket is open just works. The message goes out on connect. Mark input `volatile` so it's never replayed late, or `key` it so only the newest is sent. Put control messages first with `priority`, and drop stream data on a slow link with `maxBuffered`.
- **Typed messages.** `json: true`, your own codec, or validation with any [Standard Schema](https://standardschema.dev) library (zod, valibot, arktype), with inferred types.
- **Suspense.** `use(client.ready)` waits for the first connection, and reconnects never flash a fallback.
- **Topic subscriptions.** Reference-counted `subscribe`/`unsubscribe` messages that are sent again after every reconnect, so feeds don't silently stop. With numbered messages, each arrives once and in order: duplicates are dropped, gaps are filled, and a reconnect resumes where it left off.
- **Message state.** Reduce messages into a store, and let each component re-render only when its slice changes, at most once per frame if you like.
- **Requests, streams and latency.** Await a reply, or iterate over streamed ones such as an LLM's tokens, with timeouts and a cancel that tells the server to stop. Measure round-trip time and the server's clock for ping displays and synchronized countdowns.
- **Games.** Snapshot interpolation and client-side prediction with server reconciliation, from `react-websocket/timeline`, so other players move smoothly and your own controls respond at once. A send rate that adapts to the connection keeps players on a poor link from building up lag.
- **Offline outbox.** Messages kept in IndexedDB until the server acknowledges them, from `react-websocket/outbox`, so an order taken on flaky Wi-Fi survives reconnects and page reloads, and retries are safe with idempotency keys.
- **Resumable runs.** An AI agent's streamed answer that survives a refresh, a network switch or a sleeping laptop: it resumes from the last event received, or is cancelled so the server stops spending.
- **AG-UI.** Run [AG-UI](https://docs.ag-ui.com) agents over a WebSocket with `react-websocket/ag-ui`: messages, tool calls and JSON Patch shared state, with a snapshot when a patch fails, and runs that resume after a reconnect or a reload.
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
| `useWebSocketStream(rpc, options?)` | Stream the replies to a request into a value, e.g. tokens into an answer; returns `{ value, status, error, start, abort }` |
| `useAgentRun(runs, runId)` | A resumable run's value and status, e.g. an AI answer that keeps streaming after a reconnect or a reload |
| `useAgUiAgent(agent)` | An AG-UI agent's thread: messages, tool calls, shared state and status |
| `useWebSocketOutbox(outbox)` | The messages waiting in an outbox, for a "3 orders waiting to sync" banner |
| `createWebSocket(url, options?)` | A shareable client: `send`, `on`, `connect`, `close`, `reconnect`, `ready`, `getSnapshot`, `subscribe` |
| `createWebSocketTopics(client, { subscribe, unsubscribe })` | Topic subscription manager for `useWebSocketTopic` |
| `createWebSocketFeeds(client, { subscribe, sequence, snapshot })` | Topics with numbered messages, each delivered once and in order across reconnects; pass it to `createWebSocketState` |
| `createWebSocketState(client, { initialState, reduce })` | Message-state store for `useWebSocketState` |
| `createWebSocketRequests(client, { send, reply })` | `request(message)` returns a promise of the reply, and `stream(message)` an async iterator of replies, with timeouts and `cancel` |
| `createWebSocketLatency(client, { ping, pong })` | Ping tracker for `useWebSocketLatency`, plus `serverNow()` |
| `createWebSocketSendRate(client, options?)` | `send(message, key)` coalesced per key at a rate that drops on a congested link |
| `createWebSocketResponder(client, { request, respond, error })` | Answer the server's requests: `onRequest(method, handler)`, or a person through `useAgentApproval` |
| `createWebSocketRuns(client, { start, resume, event, reduce })` | Runs that resume after a reconnect or a reload: `start(request)`, `abort(runId)`, a `keep` or `cancel` policy |
| `MessageError` | Reported to `onError` when a message fails `parse` or `schema` |
| `retryableClose(close)` | The default `reconnect.shouldReconnect`: retries every close except `1002`, `1003` and `1008` |
| `retryAfter(close)` | The default `reconnect.retryAfter`: the delay a `1012` (Service Restart) or `1013` (Try Again Later) close asks for, in seconds in its reason |
| `createWebSocketTimeline(client, { snapshot, interpolate, input })` | From `react-websocket/timeline`: interpolated server snapshots (`at()`) and predicted inputs (`predicted()`, `input()`) for multiplayer games |
| `createWebSocketOutbox(client, { name, send, ack })` | From `react-websocket/outbox`: `add(message)` keeps a message in IndexedDB and sends it until the server acknowledges it, across reconnects and reloads |
| `createAgUiAgent(client, options?)` | From `react-websocket/ag-ui`: `run({ messages })` an AG-UI agent over a WebSocket; also `applyAgUiEvent` and `applyPatch` |
| `createChaosWebSocket(options)` | From `react-websocket/chaos`: a `WebSocket` class that adds latency, lost messages and dropped connections in development |

| Option | Default | |
| --- | --- | --- |
| `protocols` | | Sub-protocols for the `WebSocket` constructor |
| `binaryType` | `'blob'` | |
| `json` | `false` | `JSON.parse` incoming and `JSON.stringify` outgoing messages |
| `parse(data)` / `serialize(message)` | | Custom codec; takes precedence over `json` |
| `schema` | | Standard Schema validation; types are inferred |
| `reconnect` | `true` | `false`, or `{ maxAttempts, minDelay, maxDelay, factor, jitter, minUptime, shouldReconnect, retryAfter }` |
| `heartbeat` | | `{ interval, message, pong, timeout }` |
| `queue` | `true` (100 messages) | `false`, or `{ limit, maxAge }` |
| `logger` | | e.g. `console.debug` |
| `WebSocket` | global | Custom implementation for tests, Node, or chaos testing |

`useWebSocket` also takes `onOpen`, `onMessage`, `onClose`, `onError` and `enabled`. The [API reference](https://mehmetkose.github.io/react-websocket/api/) documents everything.

## Guides

- [Shared clients](https://mehmetkose.github.io/react-websocket/guide/shared-clients) · [Messages and types](https://mehmetkose.github.io/react-websocket/guide/messages) · [Reconnecting and heartbeats](https://mehmetkose.github.io/react-websocket/guide/reconnecting)
- [Suspense](https://mehmetkose.github.io/react-websocket/guide/suspense) · [Server rendering and Next.js](https://mehmetkose.github.io/react-websocket/guide/ssr) · [StrictMode, Activity and lifecycle](https://mehmetkose.github.io/react-websocket/guide/lifecycle)
- [Authentication](https://mehmetkose.github.io/react-websocket/guide/authentication) · [Performance](https://mehmetkose.github.io/react-websocket/guide/performance) · [Real-time games](https://mehmetkose.github.io/react-websocket/guide/games) · [AI agents](https://mehmetkose.github.io/react-websocket/guide/agents) · [Testing](https://mehmetkose.github.io/react-websocket/guide/testing) · [Chaos testing](https://mehmetkose.github.io/react-websocket/guide/chaos) · [Without React](https://mehmetkose.github.io/react-websocket/guide/without-react)
- [Recipes](https://mehmetkose.github.io/react-websocket/recipes) · [Troubleshooting](https://mehmetkose.github.io/react-websocket/troubleshooting) · [Migrating from v3](https://mehmetkose.github.io/react-websocket/migration-v3) · [Migrating from v2](https://mehmetkose.github.io/react-websocket/migration)

The docs source lives in [`docs/`](docs). Run `npm run docs:dev` to browse it locally.

## Compatibility

| | |
| --- | --- |
| React | 18 and 19 (`use(client.ready)` needs 19; `<Activity>` is handled on 19.2+). Tested in CI against both |
| Runtimes | Modern browsers; Node via the `WebSocket` option |
| Frameworks | Vite, Next.js (App and Pages Router), Remix/React Router, Astro islands, and any React setup |

## Migrating from v3

v4 changes no APIs, only four defaults: the backoff resets once a connection has stayed open for 5 seconds, close codes `1002`, `1003` and `1008` aren't retried, jitter is full, and the send queue holds 100 messages. Each has a one-line opt-out. See [Migrating from v3](https://mehmetkose.github.io/react-websocket/migration-v3).

## Migrating from v2

v2 was a `<Websocket>` class component. v3 replaces it with hooks: `<Websocket url onMessage />` becomes `useWebSocket(url, { onMessage })`, and `ref.sendMessage(msg)` becomes `send(msg)`. See the [migration guide](https://mehmetkose.github.io/react-websocket/migration) for the full mapping.

## Examples

- [`examples/nextjs`](examples/nextjs) is a demo of every feature in a Next.js App Router app, with its own WebSocket server. Run `npm run example:nextjs` and open http://localhost:3000.
- [`examples/astro`](examples/astro) is the same demo of every feature as Astro islands sharing one connection, with a page that keeps it open across navigation. Run `npm run example:astro` and open http://localhost:4321.
- [`examples/remix`](examples/remix) is the same demo in a Remix 3 app, which doesn't use React: every card uses `react-websocket/core` through small bindings that stand in for the hooks. Run `npm run example:remix` and open http://localhost:44100.
- [`examples/hono`](examples/hono) is a chat room with presence: a Hono server on Node.js and a Vite + React 19 client sharing one set of message types. Run `npm run example:hono` and open http://localhost:5173.
- [`examples/game`](examples/game) is a multiplayer game: a Node.js server with a fixed tick and a Vite + React canvas client, with a panel that adds lag and packet loss so you can see interpolation and prediction at work. Run `npm run example:game` and open http://localhost:5180.
- [`examples/tornado`](examples/tornado) is a small broadcast chat: a Tornado server and a Vite + React 19 client.

## Contributing

Contributions are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md). To report a vulnerability, follow [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE)

[![FOSSA Status](https://app.fossa.io/api/projects/git%2Bgithub.com%2Fmehmetkose%2Freact-websocket.svg?type=large)](https://app.fossa.io/projects/git%2Bgithub.com%2Fmehmetkose%2Freact-websocket?ref=badge_large)
