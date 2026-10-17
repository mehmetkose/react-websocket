# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [4.3.0] - 2026-10-17

### Changed

- With a `heartbeat`, an open connection is checked right away when the browser comes back online or the tab becomes
  visible: a ping goes out at once and the `timeout` starts. After sleep, a socket can be dead while `readyState` still
  says `OPEN`, and the client used to notice only at the next `interval`, often half a minute later. Only one ping is
  outstanding at a time.

## [4.2.0] - 2026-10-17

### Added

- `client.migrate({ url?, within? })` moves to a new connection without a gap, for deploys. At a random moment within
  `within` ms, it opens a new connection (to `url`, if given) and closes the current one once the new one is open, so
  the status stays `open` and nothing is queued. `open` listeners run for the new connection, so handshakes and topic
  subscriptions move with it. If the new connection fails, the current one stays. A server can ask its clients to
  move before it restarts, and they spread out over the window instead of reconnecting all at once. See
  [Deploys without reconnect storms](https://mehmetkose.github.io/react-websocket/guide/reconnecting#deploys-without-reconnect-storms).
- The default `retryAfter` also reads a `1012` (Service Restart) close whose reason is a number of seconds, so a
  restarting server can say when to come back.
- The `MigrateOptions` type.

## [4.1.0] - 2026-10-17

### Added

- Close code `1013` (Try Again Later) gets a longer wait. If its reason is a number of seconds, like an HTTP
  `Retry-After` header (`ws.close(1013, '30')`), the client waits that long plus the usual backoff, so clients told
  the same delay still spread out. Otherwise its backoff starts at `maxDelay`. Coming back online or to the tab no
  longer cuts such a wait short. It used to be retried like any other close, after about a second.
- `reconnect.retryAfter(close)` reads how long the server asked to wait, in ms, so a server can name a delay with a
  close code of its own. Its default is the new `retryAfter` export, from both `react-websocket` and
  `react-websocket/core`. See [Overloaded servers](https://mehmetkose.github.io/react-websocket/guide/reconnecting#overloaded-servers-1013).

## [4.0.0] - 2026-10-17

Safer defaults for reconnecting and queueing. No APIs change, but four defaults do, so this is a major release. Each
has an option that restores the 3.x behavior; see
[Migrating from v3](https://mehmetkose.github.io/react-websocket/migration-v3).

### Changed

- **Breaking:** the backoff resets only once a connection has stayed open for `reconnect.minUptime` (5000 ms by default),
  instead of on every open. A server that accepts and then closes right away, for example to reject the credentials
  sent from `onOpen`, used to get a new connection about once a second, forever. Now each retry waits longer, `attempt`
  keeps counting, and `maxAttempts` applies. `minUptime: 0` restores the old behavior.
- **Breaking:** close codes `1002` (protocol error), `1003` (unsupported data) and `1008` (policy violation, often a
  rejected login) are no longer retried by default: the client gives up, its status becomes `closed` and `ready`
  rejects. A `shouldReconnect` of your own still replaces the default. `shouldReconnect: () => true` restores the old
  behavior.
- **Breaking:** `reconnect.jitter` defaults to `1` (full jitter) instead of `0.5`, so each delay is random between 0
  and the backoff. Clients dropped by the same deploy used to come back within the same 500–1000 ms window; now they
  spread over the whole window. `jitter: 0.5` restores the old behavior.
- **Breaking:** the send queue holds at most 100 messages by default instead of every message, dropping the oldest
  first (and calling its `onDrop`). After a long outage, a backlog is no longer replayed in full on reconnect.
  `queue: { limit: Infinity }` restores the old behavior.

### Added

- `reconnect.minUptime`: how long a connection must stay open, in ms, before the backoff resets.
- `retryableClose(close)`, the default `reconnect.shouldReconnect`, from both `react-websocket` and
  `react-websocket/core`. Call it from your own `shouldReconnect` to keep the default rule, e.g.
  `close => close.code !== 4001 && retryableClose(close)`.
- In development, `useWebSocket(url)` warns when a component passes different connection options (such as `json`,
  `parse` or `schema`) than the component that opened the shared connection for that URL. Those options are ignored,
  so a component could receive data in a shape it doesn't expect. Options written inline count as the same when their
  contents match.

## [3.6.0] - 2026-10-17

### Added

- `rpc.stream(message, options?)` on `createWebSocketRequests` sends a request and returns an async iterator of its
  replies, for servers that answer one request with many messages, such as an LLM's tokens. The new `done` option
  recognizes the last reply, which is yielded too. `timeout` is the time to wait for each reply. Replies are buffered
  until the loop reads them, and a failure (an error reply, a timeout, a lost connection) is thrown after them.
- A `cancel` option on `createWebSocketRequests` builds the message that tells the server to stop request `id`. It's
  sent when a request or stream is aborted, times out or is disposed, and when a loop over a stream exits early, but
  not after the last reply or a lost connection. A cancel for a request still in the send queue is queued behind it.
- `useWebSocketStream(rpc, options?)` folds the replies to a request into state with `initial` and `reduce`, for a
  chat answer with a Stop button. `start(message)` replaces the running stream, and `abort()`, unmounting and a new
  `rpc` stop it and send `cancel`. `status` is `idle`, `streaming`, `done`, `error` or `aborted`, and `batch: 'frame'`
  renders at most once per animation frame. The
  [AI agents](https://mehmetkose.github.io/react-websocket/guide/agents#streaming-the-answer) guide has a new
  section on streaming the answer.

## [3.5.0] - 2026-10-17

### Added

- `send(message, { maxBuffered })` drops a message while the socket is open but more than `maxBuffered` bytes are
  already waiting in the browser's send buffer (`bufferedAmount`), and returns `false`. On a slow link, high-rate
  streams such as per-tick input or audio frames stay current instead of building up lag. It's set per message, so
  replies, pings and other control messages are never dropped. A request dropped this way rejects right away.
- `send(message, { priority: true })` queues a message ahead of everything queued without `priority`, so a cancel,
  interrupt or token refresh doesn't wait behind a backlog after a reconnect. Messages sent from `open` listeners still
  go first, and `queue.limit` evicts ordinary messages before priority ones.
- `createWebSocketState(client, { batch: 'frame' })` notifies subscribers at most once per animation frame instead of
  once per message, so a fast stream renders once per frame. `getState()` stays current, and `setState` and `reset`
  still notify right away.
- `react-websocket/timeline`, a new entry point for multiplayer games. `createWebSocketTimeline(client, options)` keeps
  server snapshots by server time. `at()` renders them slightly in the past, interpolated, so other players move
  smoothly. `input(input)` sends an input tagged with a sequence number and predicts it, and `predicted()` replays
  the inputs the server hasn't confirmed (`ack`) on top of the newest snapshot, so your own controls respond at
  once. The clock comes from `createWebSocketLatency` or is estimated from snapshot arrivals. It starts over on
  reconnect, keeping the last frame visible. About 0.85 kB min+gzip, with no React dependency. The
  [Real-time games](https://mehmetkose.github.io/react-websocket/guide/games) guide covers interpolation,
  prediction and what the server has to send.
- `createWebSocketSendRate(client, options)` sends high-rate state such as aim, cursor or position at a rate that
  adapts to the connection. `send(message, key)` keeps only the newest message per key until the next tick. The
  rate halves when the send buffer fills up or, with `latency`, when the round trip rises, and climbs back when the
  link keeps up, so players on a poor connection degrade smoothly instead of building up lag. About 0.65 kB
  min+gzip, from both `react-websocket` and `react-websocket/core`.
- A [game example](https://github.com/mehmetkose/react-websocket/tree/main/examples/game): a multiplayer canvas game
  with a Node.js server at a fixed tick, aim streamed at an adaptive send rate, and a panel that adds lag and packet
  loss with `react-websocket/chaos`.

## [3.4.0] - 2026-10-17

### Added

- `react-websocket/chaos`, a new entry point for development. `createChaosWebSocket(options)` returns a `WebSocket`
  class to pass as the `WebSocket` option. It adds `latency`, lost (`loss`) and `corrupt` messages, and `refuse`d,
  `drop`ped and `stall`ed (half-open) connections, with a `seed` for repeatable runs. Its static `drop()`, `stall()`,
  `inject(data)` and `configure(faults)` trigger faults on demand, from a dev panel, the console or a test. See the
  [Chaos testing](https://mehmetkose.github.io/react-websocket/guide/chaos) guide.
- A [Hono example](https://github.com/mehmetkose/react-websocket/tree/main/examples/hono): a chat room with
  presence, with a Hono server on Node.js and a Vite + React client that share their message types.
- An [Astro demo](https://github.com/mehmetkose/react-websocket/tree/main/examples/astro) of every feature,
  including server requests: React islands sharing one connection, a card using `react-websocket/core`
  from a plain `<script>`, and a connection kept open across page navigation.
- A [Remix 3 demo](https://github.com/mehmetkose/react-websocket/tree/main/examples/remix) of every feature,
  including server requests. Remix 3 doesn't use React, so it uses `react-websocket/core`, with
  small bindings for Remix components in place of the hooks.

## [3.3.0] - 2026-10-17

### Added

- `createWebSocketResponder(client, { request, respond, error, cancel, timeout })` answers requests the server
  sends, the reverse of `createWebSocketRequests`. `onRequest(method, handler)` answers them in code, for tools
  that only exist in the browser, and `useAgentApproval(responder, method)` renders the ones a person answers.
  Every request gets exactly one reply, including `NotFoundError` when nothing is registered and `TimeoutError`
  after an optional `timeout`. Its `signal` aborts when the server cancels it or its connection closes, and a
  reply is never sent on a newer connection.
- An [AI agents](https://mehmetkose.github.io/react-websocket/guide/agents) guide: browser tools, approvals,
  tools that need a click, cancellation and reconnects.
- A [Next.js demo](https://github.com/mehmetkose/react-websocket/tree/main/examples/nextjs) of every feature, with
  its own WebSocket server. The Tornado example moved to `examples/tornado`.
- `send(message, { onDrop })`: called when a queued message is dropped without being sent, because a newer
  message with the same `key` replaced it or `queue.limit` evicted it.

### Fixed

- A connection started by reading `ready` no longer stays open forever when nothing holds it. That happened
  when the last hook unmounted while connecting, or when a Suspense render read `ready` and was then abandoned.
  It now closes 5 seconds after opening unless a hook, `acquire()` or `connect()` holds it.
- With an async `schema`, one error during delivery (for example a throwing `client.subscribe` listener) no
  longer silently drops every later message. Store listeners that throw are now reported asynchronously, like
  event listeners, instead of interrupting the client.
- A request replaced in the queue by a newer one with the same `key`, or evicted by `queue.limit`, now rejects
  instead of waiting for its timeout (or forever with `timeout: Infinity`).
- Two request managers on one client no longer send the same ids and resolve each other's requests with one
  reply. Ids are now counted per client.
- Bundle size claims now match the measurement: about 3 kB min+gzip for `useWebSocket`, not 2.5 kB. size-limit
  now measures gzip, as the docs state.

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

[4.3.0]: https://github.com/mehmetkose/react-websocket/compare/4.2.0...4.3.0
[4.2.0]: https://github.com/mehmetkose/react-websocket/compare/4.1.0...4.2.0
[4.1.0]: https://github.com/mehmetkose/react-websocket/compare/4.0.0...4.1.0
[4.0.0]: https://github.com/mehmetkose/react-websocket/compare/3.6.0...4.0.0
[3.6.0]: https://github.com/mehmetkose/react-websocket/compare/3.5.0...3.6.0
[3.5.0]: https://github.com/mehmetkose/react-websocket/compare/3.4.0...3.5.0
[3.4.0]: https://github.com/mehmetkose/react-websocket/compare/3.3.0...3.4.0
[3.3.0]: https://github.com/mehmetkose/react-websocket/compare/3.2.0...3.3.0
[3.2.0]: https://github.com/mehmetkose/react-websocket/compare/3.1.0...3.2.0
[3.1.0]: https://github.com/mehmetkose/react-websocket/compare/3.0.0...3.1.0
[3.0.0]: https://github.com/mehmetkose/react-websocket/compare/2.2.0...3.0.0
[2.2.0]: https://github.com/mehmetkose/react-websocket/releases/tag/2.2.0
