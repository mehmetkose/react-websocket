# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [4.18.1] - 2026-10-20

The library's code is the same as in 4.18.0. This release brings the new README and package description to npm.

### Documentation

- The README and the package description present react-websocket as a real-time toolkit: install and a quick start
  come first, then the features and the API, grouped into the core and six opt-in groups. The bundle size is now given
  as about 4 kB, which is what `{ useWebSocket }` measures.
- Real-world guides that build whole apps, client and server: an AI chatbot, an AI image and video generator, a voice
  assistant, a multiplayer party game, a real-time action game, a team chat, a collaborative whiteboard, a trading
  dashboard, live notifications and delivery tracking. See
  [Real-world guides](https://mehmetkose.github.io/react-websocket/recipes#real-world-guides).
- Numbered feeds: the example server sends the whole state when a client's `after` is ahead of its own number, as it
  is after the server restarts.
- Tabs share a connection only when they connect to the same URL, so a token in the URL that differs between tabs
  opens a connection per tab. Send it in a first message instead.

## [4.18.0] - 2026-10-18

The first release since 4.0.0. Versions 4.1.0 to 4.17.0 were numbered on `main` but never tagged or published to
npm, so their changes are listed here, as what changed since 4.0.0. Fixes to features that are new in this release
are part of those features.

### Added

- Close code `1013` (Try Again Later) gets a longer wait. If its reason is a number of seconds, like an HTTP
  `Retry-After` header (`ws.close(1013, '30')`), the client waits that long plus the usual backoff, so clients told
  the same delay still spread out. Otherwise its backoff starts at `maxDelay`. Coming back online or to the tab no
  longer cuts such a wait short. It used to be retried like any other close, after about a second.
- `reconnect.retryAfter(close)` reads how long the server asked to wait, in ms, so a server can name a delay with a
  close code of its own. Its default is the new `retryAfter` export, from both `react-websocket` and
  `react-websocket/core`. See [Overloaded servers](https://mehmetkose.github.io/react-websocket/guide/reconnecting#overloaded-servers-1013).
- `client.migrate({ url?, within? })` moves to a new connection without a gap, for deploys. At a random moment within
  `within` ms, it opens a new connection (to `url`, if given) and closes the current one once the new one is open, so
  the status stays `open` and nothing is queued. `open` listeners run for the new connection, so handshakes and topic
  subscriptions move with it. If the new connection fails, the current one stays. A server can ask its clients to
  move before it restarts, and they spread out over the window instead of reconnecting all at once. See
  [Deploys without reconnect storms](https://mehmetkose.github.io/react-websocket/guide/reconnecting#deploys-without-reconnect-storms).
- The default `retryAfter` also reads a `1012` (Service Restart) close whose reason is a number of seconds, so a
  restarting server can say when to come back.
- The `MigrateOptions` type.
- `queue.maxAge` and `send(message, { maxAge })` drop a queued message that has waited longer than that many ms
  instead of sending it, calling its `onDrop`, so a "typing" indicator or a price quote queued during a long outage
  isn't sent once the connection is back. A message's own `maxAge` overrides the queue's. It's checked when the socket
  opens, before the queue is sent, and whenever another message is queued. A request from `createWebSocketRequests`
  dropped this way rejects. See
  [Expiring stale messages](https://mehmetkose.github.io/react-websocket/guide/reconnecting#expiring-stale-messages).
- `react-websocket/outbox`, a new entry point. `createWebSocketOutbox(client, { name, send, ack })` keeps messages until
  the server acknowledges them, across reconnects and page reloads. `add(message)` stores a message in IndexedDB and
  sends it with an idempotency key as soon as the socket is open, and every new connection sends the unacknowledged
  ones again, in order, so the server can ignore repeats. After a reload, the stored messages are sent before new
  ones. While messages are waiting, the outbox holds the connection open. `maxAge` and `onExpire` drop messages that
  are too old, and `remove(id)` and `clear()` cancel them. `indexedDBStorage(name)` and `memoryStorage()` are the
  built-in storages; pass your own as `storage`. About 1.1 kB min+gzip, with no React dependency. See
  [Offline outbox](https://mehmetkose.github.io/react-websocket/guide/outbox).
- `useWebSocketOutbox(outbox)` lists the messages waiting in an outbox, for a "3 orders waiting to sync" banner.
- `createWebSocketFeeds(client, { subscribe, sequence, snapshot })` subscribes to topics whose messages carry a
  sequence number, and delivers each message once and in order across reconnects. Every new connection subscribes
  with `after`, the last number received, so the server sends only what was missed. A message numbered at or below
  the last is dropped as a duplicate. One that skips numbers is held back, and the feed asks once for what's missing
  (`resume`, `onGap`). A `snapshot` resets the numbering when the server can't replay. It's a `WebSocketTopics`, so
  `useWebSocketTopic` takes it. See
  [Numbered feeds](https://mehmetkose.github.io/react-websocket/guide/topics#numbered-feeds).
- `createWebSocketState` takes feeds in place of the client, through the new `MessageSource` type, to reduce their
  in-order messages.
- `createWebSocketRuns(client, { name, start, resume, event, initial, reduce })` streams runs, such as an AI agent's
  answer, that survive reconnects and page reloads. `start(request)` returns a run id and folds the run's events
  into its value. Events carry an offset: on a new connection a streaming run sends `resume(runId, after)`, so the
  server sends only what was missed, and duplicates are dropped. Streaming runs are remembered in `sessionStorage`,
  so a reloaded page follows them again from their first event. A run's policy is `keep` (resume) or `cancel`
  (abort when the connection drops, and send `cancel` first thing on the next one). `abort(runId)`, `attach(runId)`
  for runs started elsewhere, and `list()`. `start()` and `attach()` take an `initial` value for the run. Built on
  `createWebSocketFeeds`.
- `useAgentRun(runs, runId)` renders a run's value and status, attaching to a run it doesn't know yet. See
  [Resumable runs](https://mehmetkose.github.io/react-websocket/guide/agents#resumable-runs).
- `react-websocket/ag-ui`, a new entry point for [AG-UI](https://docs.ag-ui.com) agents over a WebSocket.
  `createAgUiAgent(client, options?)` starts runs with `run({ messages, tools, context })`, sending AG-UI's
  `RunAgentInput`, and folds their events into a thread: messages (text, tool calls and their results, reasoning,
  activity), shared state from `STATE_SNAPSHOT` and JSON Patch `STATE_DELTA`, steps and status. A delta that can't be
  applied keeps the last good state, marks the thread `stale`, and sends `resync` to ask for a snapshot. Runs are built
  on `createWebSocketRuns`, so they resume after a reconnect or a reload. The wire format is small and replaceable:
  `{ type: 'run' | 'resume' | 'cancel', runId, … }` out, `{ runId, offset, event }` in. Also exports
  `applyAgUiEvent(thread, event)` and `applyPatch(document, operations)`. About 3.5 kB min+gzip with the runs it uses,
  with no React dependency. See [AG-UI over WebSockets](https://mehmetkose.github.io/react-websocket/guide/ag-ui).
- `useAgUiAgent(agent)` renders an agent's thread.
- `createWebSocketPresence(client, { send, receive, leave })` shares per-peer state that expires, for presence, live
  cursors and selections. `set(state)` sends this client's state at most `maxRate` times per second (20 by default),
  newest last, again every `refresh` while it doesn't change, and on every new connection, but never from the queue.
  Other peers' states come from `receive`, and a peer is forgotten when it leaves or nothing has arrived from it for
  `timeout` (30 s by default), so a peer whose connection died silently doesn't leave a frozen cursor behind.
  `leave()` stops sharing. See
  [Presence and live cursors](https://mehmetkose.github.io/react-websocket/guide/presence).
- `useWebSocketPresence(presence)` renders the other peers and holds the connection.
- `useInView(ref, options?)` says whether an element is on screen, from an `IntersectionObserver`, so a dashboard of
  many runs can stream full tokens only for the cards on screen and status alone for the rest:
  `useWebSocketTopic(feeds, useInView(ref) ? tokensTopic : statusTopic)`. Takes `rootMargin`, `threshold` and
  `initial`.
- A [Dashboards of many runs](https://mehmetkose.github.io/react-websocket/guide/agents#dashboards-of-many-runs)
  section in the AI agents guide, with a live cost meter that stops a run over a client-side budget.
- A [Voice agents and interruptions](https://mehmetkose.github.io/react-websocket/guide/voice) guide: microphone frames
  with `volatile` and `maxBuffered`, playing the answer on a Web Audio clock, and an interruption that stops playback,
  cancels generation and sends `truncate { itemId, heardMs }` from the playback position, with `priority`. Binary
  frames and JSON control messages share one client through `serialize` and `parse`.
- `react-websocket/tabs`, a new entry point. `createTabsWebSocket(options?)` returns a `WebSocket` class that shares one
  connection between all the tabs of an app: pass it as the `WebSocket` option, and only one tab, elected with the
  Web Locks API, connects to the server, while the others reach it over a `BroadcastChannel`. Each tab keeps its own
  client, queue, reconnects and hooks. When the leading tab closes, another takes over. With `topics`, an
  unsubscribe reaches the server only when no other tab holds the topic, and messages go only to the tabs that hold
  their topic. Without `BroadcastChannel` or locks, each tab connects on its own. About 1.7 kB min+gzip, with no
  imports. See [One connection across tabs](https://mehmetkose.github.io/react-websocket/guide/tabs).
- `react-websocket/replay`, a new entry point. `createRecordingWebSocket()` returns a `WebSocket` class that records
  each connection's open, sends, messages, errors and closes with their times; `recording()` returns them as plain
  JSON and `save()` downloads it. `createReplayWebSocket(recording, { speed })` plays a recording back without a
  server, one recorded connection per connection the client opens, at the recorded timing or faster. By default it
  waits for the app to send before replaying what came after a send, so the replay follows the app. `sent`, `done`
  and `reset()` help in tests, and chaos can wrap it to add faults. For bug reports, offline demos, and UI tests that
  don't call an AI model on every run. About 1.7 kB min+gzip, with no imports. See
  [Recording and replay](https://mehmetkose.github.io/react-websocket/guide/replay).
- `react-websocket/devtools`, a new entry point. `<WebSocketDevtools sources={[live, topics, latency]} />` renders a
  panel in a corner of the page with each client's status and attempts, queued messages, send buffer and messages
  received, and the round-trip time, topics, feeds, outbox, presence and runs of the `sources` that use it. In
  development, it also lists the clients `useWebSocket(url)` shares by itself. About 1.8 kB min+gzip, for development:
  load it lazily behind your dev flag. See [WebSocketDevtools](https://mehmetkose.github.io/react-websocket/api/devtools).
- `react-websocket/webtransport`, a new entry point. `createWebTransportSocket(options?)` returns a `WebSocket` class
  that connects over WebTransport behind the same API: messages go framed on one reliable stream, and `volatile`
  sends go as datagrams, which are never queued or retransmitted (`datagrams: false` keeps them on the stream). Where
  WebTransport isn't available, or a session can't be established within `timeout`, it falls back to a WebSocket to
  the client's own URL, and keeps doing so. About 1.7 kB min+gzip, with no imports. The client hands `volatile` sends
  to a socket's datagram method where it has one. See
  [WebTransport](https://mehmetkose.github.io/react-websocket/guide/webtransport), with the wire format for servers.

### Changed

- With a `heartbeat`, an open connection is checked right away when the browser comes back online or the tab becomes
  visible: a ping goes out at once and the `timeout` starts. After sleep, a socket can be dead while `readyState` still
  says `OPEN`, and the client used to notice only at the next `interval`, often half a minute later. Only one ping is
  outstanding at a time.
- Under `<Activity>`, a component using `useWebSocket(url)` keeps its client, and its `lastMessage`, across hide and
  show. It used to start again from a fresh client, as on a remount.

### Fixed

- A message sent from the `onDrop` of a queued message that a newer message with the same `key` replaced was lost.
  `onDrop` now runs once the queue is updated.
- `useWebSocket(url)` registers the client it shares for a URL when a component mounts, not while it renders. A render
  that React threw away, for example because it suspended or a transition was interrupted, used to decide the
  connection's options for every component that came after, and left a client behind that nothing used. Now the
  options come from the first component to mount. Components that mount together still share one connection, and
  what they `send` from a mount effect reaches it.
- `client.close()` with a code the browser rejects, such as `1001`, throws before anything changes. It used to throw
  halfway, leaving the status `open`, `socket` null and the real socket open, with its messages ignored.
- A client closed, or one that gave up, while nothing held it starts again for the next hook to mount, as after the
  last hook unmounted. It used to stay `closed` for good.
- The client connects in a Web Worker, which has no `window`.
- Topics send nothing while the server closes the socket, which still reads `open` until its close event. A release
  and hold there used to be queued, and sent after the new connection's subscriptions: the server ended up
  unsubscribed from a topic still held.
- A request on a `closed` client rejects and leaves it closed. It used to move it to `idle`, so the next request
  opened it again.

### Documentation

- Suspense: a connection started only by reading `ready` keeps retrying a server that's down until it opens, gives up
  or `close()` is called, since the client can't tell an abandoned read from a suspended render.

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

Also includes 3.4.0, which was tagged but never published to npm.

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

2.1.0 and earlier have no changelog. [npm](https://www.npmjs.com/package/react-websocket?activeTab=versions) lists
them, and some have [git tags](https://github.com/mehmetkose/react-websocket/tags).

[Unreleased]: https://github.com/mehmetkose/react-websocket/compare/4.18.1...HEAD
[4.18.1]: https://github.com/mehmetkose/react-websocket/compare/4.18.0...4.18.1
[4.18.0]: https://github.com/mehmetkose/react-websocket/compare/4.0.0...4.18.0
[4.0.0]: https://github.com/mehmetkose/react-websocket/compare/3.6.0...4.0.0
[3.6.0]: https://github.com/mehmetkose/react-websocket/compare/3.5.0...3.6.0
[3.5.0]: https://github.com/mehmetkose/react-websocket/compare/3.3.0...3.5.0
[3.3.0]: https://github.com/mehmetkose/react-websocket/compare/3.2.0...3.3.0
[3.2.0]: https://github.com/mehmetkose/react-websocket/compare/3.1.0...3.2.0
[3.1.0]: https://github.com/mehmetkose/react-websocket/compare/3.0.0...3.1.0
[3.0.0]: https://github.com/mehmetkose/react-websocket/compare/2.2.0...3.0.0
[2.2.0]: https://github.com/mehmetkose/react-websocket/releases/tag/2.2.0
