# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

[3.0.0]: https://github.com/mehmetkose/react-websocket/compare/2.2.0...3.0.0
[2.2.0]: https://github.com/mehmetkose/react-websocket/releases/tag/2.2.0
