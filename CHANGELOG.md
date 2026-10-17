# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [3.2.0] - 2026-10-17

### Added

- `send(message, { volatile: true })` drops a message instead of queueing it while the socket isn't open, so
  input isn't replayed after a reconnect. `send(message, { key })` keeps only the newest queued message per key.
  The same options work on the `send` returned by `useWebSocket`.
- `createWebSocketRequests(client, { send, reply, error, timeout })`: `request(message)` sends a message tagged
  with a generated id and resolves with the matching reply. Requests reject on timeout (`TimeoutError`),
  on an error reply, on abort (`signal`), and when the connection they were sent on closes, so they never hang.
- `createWebSocketLatency(client, { ping, pong, interval, samples })` and `useWebSocketLatency(latency)`:
  round-trip time (median of recent pings) and the server clock offset, with `serverNow()` for countdowns
  that agree across players.
- A [Real-time games](https://mehmetkose.github.io/react-websocket/guide/games) guide: input, requests, ping,
  render loops, rejoining after a reconnect, binary codecs and background tabs.

## [3.1.0] - 2026-10-17

### Added

- `createWebSocketTopics(client, { subscribe, unsubscribe })` and `useWebSocketTopic(topics, topic)`:
  reference-counted topic subscriptions. Components holding the same topic share one subscription,
  `unsubscribe` is sent a tick after the last holder releases it (so StrictMode doesn't churn), and
  every held topic is subscribed again after each reconnect, before queued messages are sent.
- `createWebSocketState(client, { initialState, reduce })` and `useWebSocketState(store, selector, isEqual)`:
  state reduced from messages, kept across reconnects. Components re-render only when their selected
  value changes. Renders `initialState` on the server and during hydration.
- Guides for topic subscriptions and message state; the Zustand guide now separates the connection
  (react-websocket) from app data (Zustand).

### Changed

- TypeScript 5.4+ is recommended: the new APIs use `NoInfer` so literal message types aren't widened.

## [3.0.0] - 2026-10-17

A rewrite: v3 replaces the v2 class component with React hooks and a standalone,
framework-agnostic client. See the [migration guide](https://mehmetkose.github.io/react-websocket/migration).

### Added

- `useWebSocket(url | client, options)`: status, last message, and stable `send`, `close` and `reconnect`.
  Handlers always see the latest props and state, and changing them never reconnects.
- `useWebSocketEvent(client, type, listener)`: listen to events without re-rendering.
- `useWebSocketStatus(client)`: re-renders only when the connection status changes.
- `createWebSocket(url, options)`: a module-level client with `subscribe`/`getSnapshot` (compatible with
  `useSyncExternalStore`), `on`, `send`, `connect`, `close`, `reconnect`, `acquire` and a `ready` promise.
- `react-websocket/core` entry with no React dependency. The hooks entry imports its client from it at
  runtime, so using both entries ships one copy and `instanceof MessageError` works across them.
- Shared, reference-counted connections: components using the same URL share one socket, and
  StrictMode (including StrictMode during hydration in React 19.3) never opens duplicates.
- Reconnect with exponential backoff and jitter (`reconnect: { maxAttempts, minDelay, maxDelay, factor, jitter, shouldReconnect }`),
  plus an immediate retry when the browser comes back online or the tab becomes visible.
- Send queue: `send()` before the socket is open queues the message and sends it on connect.
  `queue: { limit }` caps the queue, dropping the oldest message. `open` listeners run before the queue
  is flushed, so a handshake (such as an auth message) sent from `onOpen` goes out first.
- `heartbeat: { interval, message, pong, timeout }` keep-alive with dead-connection detection
  (closes with code `4000` and reconnects).
- `json`, `parse` and `serialize` options, and `schema` validation with any
  [Standard Schema](https://standardschema.dev) library (zod, valibot, arktype). Invalid messages are
  reported as a `MessageError`.
- A URL function (sync or async), called before every connection attempt, for fresh auth tokens (#13).
- `ready` promise for React 19's `use()` and Suspense. It resolves on the first open and stays resolved
  through automatic reconnects, so a network blip never replaces content with a fallback. It rejects
  when the client gives up, on `close()`, and during a server render.
- `connect()` keeps a client connected, even with no hooks using it, until `close()`.
- `logger` option and a `WebSocket` option for custom implementations (tests, Node).
- Server-rendering safety: nothing connects during a server render, and the hooks entry is marked `'use client'`.
- Works with `<Activity>` (React 19.2+): hidden content releases its connections, and visible content reconnects.
- TypeScript types for everything, with TSDoc on every export.
- ESM and CommonJS builds with source maps; `"sideEffects": false`; zero dependencies.
- Documentation site with guides, recipes, an API reference and troubleshooting.
- Vite + React 19 example app with a Tornado server.
- Tooling: Vitest suite (also run against React 18 in CI), ESLint with `eslint-plugin-react-hooks`,
  Prettier, package validation with publint and Are the Types Wrong, size budgets with size-limit,
  GitHub Actions for CI, docs and npm releases with provenance.

### Changed

- `onClose` receives `{ code, reason, wasClean }` instead of `(code, reason)`.
- `close()` stops reconnecting; in v2 it triggered a reconnect (#50).
- Changing the URL reconnects to the new one; v2 ignored it (#46).
- The reconnect backoff resets after a successful connection (#33).
- Requires React 18 or 19 (v2 supported React 16.8 and later). `react-dom` is no longer a peer dependency.

### Removed

- The `<Websocket>` component, its ref methods (`sendMessage`, `open`, `close`) and its `propTypes`.
  See the [migration guide](https://mehmetkose.github.io/react-websocket/migration) for equivalents.
- The `debug` prop, replaced by `logger`.
- The `reconnectIntervalInMilliSeconds` prop, replaced by `reconnect: { minDelay, maxDelay, jitter }`.

## [2.2.0] - 2026-10-16

### Changed

- Dependency updates and security fixes.

## Earlier versions

See the [git tags](https://github.com/mehmetkose/react-websocket/tags) for 2.1.0 and earlier.

[3.2.0]: https://github.com/mehmetkose/react-websocket/compare/3.1.0...3.2.0
[3.1.0]: https://github.com/mehmetkose/react-websocket/compare/3.0.0...3.1.0
[3.0.0]: https://github.com/mehmetkose/react-websocket/compare/2.2.0...3.0.0
[2.2.0]: https://github.com/mehmetkose/react-websocket/releases/tag/2.2.0
