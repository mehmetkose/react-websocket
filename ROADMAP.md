# Roadmap

Ideas that have been checked against the current code (3.2.0) and are worth doing. Nothing here is a
promise or a schedule. Items marked **behavior change** alter a default, so they need either a major
version or an opt-in first.

## Design fixes

### Spread out reconnects (full jitter, close code 1013)

Today the delay is `base * (1 - jitter * random)` with `jitter: 0.5`, so it only shortens by up to half.
After a server deploy, every client retries within the same 500–1000 ms window. `reconnect: { jitter: 1 }`
already gives full jitter (a random delay from 0 to the base), but nobody knows to set it.

- Make full jitter the default. **Behavior change** (timing only).
- Honor close code 1013 (Try Again Later), with an optional server-supplied delay in the close reason.

### Don't retry closes that can't succeed

Every close is retried unless `shouldReconnect` says otherwise, including 1002 (protocol error), 1003
(unsupported data) and 1008 (policy violation, often an auth failure). That hammers the server forever.

- Skip 1002, 1003 and 1008 by default. **Behavior change.** Ship it first as an exported preset, such as
  `shouldReconnect: retryableClose`, and document it in the authentication guide.

### Bound the send queue by default

`queue.limit` defaults to `Infinity`. After hours offline, every stale message is replayed on reconnect.

- A default cap (for example 100), and a per-message or per-queue `maxAge`. **Behavior change** for the cap.
  `maxAge` can ship on its own. Messages dropped by age should call `onDrop`, like key and limit drops do.

### Check liveness on wake

After sleep, a socket can be half-open while `readyState` is still `OPEN`. The `online` and
`visibilitychange` handlers only act when a retry timer is pending, so a dead socket can go unnoticed until
the next heartbeat interval.

- When a heartbeat is configured, send a ping right away on `online` and on becoming visible, and start the
  pong timeout.

### Warn about conflicting options on a shared URL

Hooks with the same URL share one client, and its options come from whichever hook rendered first. A second
component with different `json`, `parse` or `schema` options silently gets data in a shape it doesn't expect.
`sharedClient()` also writes to the registry during render, so a render that React discards can still decide
which options win.

- A development-only warning when a hook's options differ from the shared client's.
- Look at creating the registry entry outside render, or replacing an entry that no committed hook ever
  acquired.

### Backpressure for volatile sends

`send()` ignores `bufferedAmount`. On a congested link, high-rate streams pile up in the browser's buffer and
latency grows.

- An option to drop `volatile` sends while `bufferedAmount` is above a threshold. This follows on from the
  3.2 volatile and keyed sends.

### Priority sends

Messages queued while disconnected go out in order, and only `open` listeners can send ahead of the queue.
Control messages (cancel, interrupt, auth refresh) can end up behind a backlog of audio frames or input.

- `send(message, { priority: true })` puts a message at the front of the queue. Together with backpressure,
  this is the transport side of voice interruption (see below).

### Batch state updates per frame

Every message is its own task, so a store updated by a fast stream renders once per message. The performance
guide shows a hand-written `requestAnimationFrame` buffer for this.

- A `batch: 'frame'` option on `createWebSocketState` that notifies subscribers at most once per animation
  frame. Token streams, tickers and game state all benefit.

## Features

These build on what exists already: the `WebSocket` injection option, `latency.serverNow()`, volatile and
keyed sends, and topics. Large ones should ship as separate entry points so the core budget stays small.

### Games

- **Snapshot interpolation, prediction and rollback** (`createWebSocketTimeline`). Buffer server snapshots by
  server time and render at `serverNow() - delay`. Inputs carry sequence numbers; when the server confirms
  one, replay the inputs it hasn't seen yet. Every multiplayer web game rewrites this, and the clock sync it
  needs is already here.
- **Adaptive send rate.** Lower the input tick rate and coalesce keyed sends based on RTT and
  `bufferedAmount`, so players on poor connections degrade smoothly instead of building up lag. Depends on
  the backpressure work above.

### Live data

- **Sequenced streams with gap detection and resume.** Track a sequence number per topic, detect gaps, and on
  reconnect send `resume { lastSeq }` and drop duplicates, falling back to a snapshot when the server can't
  replay. This gives close to exactly-once delivery for trading, sports data and chat, and fits the existing
  re-subscribe-on-reconnect logic in topics.
- **One socket across tabs.** Elect a leader tab over `BroadcastChannel` (or use a `SharedWorker`) and
  multiplex topics through it. Users with 10–20 tabs open would cost one server connection instead of one per
  tab. A separate entry point.
- **Coordinated reconnects during deploys.** A small protocol where the server tells clients to reconnect over
  a spread of time, optionally to a different URL, and the client follows it. Deploys become gradual
  migrations instead of reconnect storms. Builds on the 1013 handling above.
- **WebTransport behind the same API.** Volatile sends map to datagrams and everything else to streams, with
  automatic fallback to WebSocket. Large and dependent on browser support, so it comes after the others.

### AI agents

- **Streaming RPC** (`rpc.stream(message)` and a `useWebSocketStream` hook). An async iterable of partial
  replies, with an `AbortSignal` that sends a cancel message. Realtime LLM and voice APIs work this way.
  Extends `createWebSocketRequests`.
- **Resumable agent runs** (`useAgentRun(runId)`). A refresh, a Wi-Fi to cellular switch or a sleeping laptop
  drops a streaming answer halfway, and the tokens are paid for anyway. Events carry an offset, the run id is
  kept in `sessionStorage`, and on reconnect or reload the client sends `resume { runId, offset }` and drops
  duplicates. A per-run disconnect policy chooses `keep` (background agents keep working) or `cancel` (chat
  stops spending). This is sequenced streams (above) applied to runs, so it ships after them.
- **Voice sessions with interruption.** On interruption the client must stop audio, discard queued frames,
  cancel generation and report how much the user actually heard, or the transcript includes words they never
  heard. The library's part is the transport: priority sends for control messages, volatile audio frames with
  backpressure dropping stale ones while open, and a guide showing `truncate { itemId, heardMs }` from
  playback position. Audio capture and playback stay in the app.
- **Dashboards of many runs.** Stream full tokens only for runs on screen and status alone for the rest.
  `useWebSocketTopic` already resubscribes when its topic changes, so this is a guide recipe plus a small
  `IntersectionObserver` helper that picks the topic. The same recipe can show a live cost meter from usage
  events and cancel a run that crosses a client-side budget.
### Business

- **Persistent offline outbox.** Keep the queue in IndexedDB with idempotency keys, so it survives reloads and
  requests are safe to retry. For POS, field-service and warehouse apps on flaky Wi-Fi. Pairs with the queue
  `maxAge` above.

- **Presence and live cursors** (`createWebSocketPresence`). Per-peer temporary state that expires, throttled
  through keyed sends.

### Tooling

- **Chaos testing.** A `WebSocket` wrapper, passed through the existing `WebSocket` option, that injects
  latency, packet loss and dropped connections in development.
- **Devtools overlay.** Shows sockets, topics, the queue and RTT.
- **Session recording and replay.** Record timestamped message logs to a file and replay them through a mock
  `WebSocket` at real speed, sped up, or with injected failures. That gives reproducible bug reports ("attach
  your recording"), offline demos, and deterministic AI UI tests that don't call a model on every CI run.

### Protocol adapters

- **AG-UI** (`react-websocket/ag-ui`). AG-UI's standard agent events (run lifecycle, text messages, tool calls,
  state snapshots and JSON Patch deltas) are transport-agnostic and list WebSockets as an option, but its
  standard client ships SSE and an HTTP binary protocol. An adapter would apply state deltas through
  `createWebSocketState`, falling back to a snapshot when a patch fails, and add resumable runs on top.
- **MCP over WebSocket.** SEP-1288 proposes a WebSocket transport for server-initiated notifications. It is
  still in review, and since browsers can't set headers on a WebSocket, it passes the auth token in the
  subprotocol list. The existing `url` function and `protocols` option already support that flow, so a
  browser reference client could demonstrate it. Label it experimental until the spec settles.

## Considered, not planned

- **Incremental markdown rendering for token streams.** Re-parsing only the last open block is real work
  worth doing, but it belongs to the markdown renderer, not the transport. The frame batching above covers
  the part that is the library's job.
- **Typed partial objects from streamed JSON** (`usePartialObject`). Useful, but it parses text from any
  transport, and AI SDKs already offer partial-object hooks. Worth revisiting as an option on `rpc.stream`
  (final value validated with the existing Standard Schema support) once streaming RPC exists.
