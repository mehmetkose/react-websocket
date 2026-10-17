# Roadmap

Ideas that have been checked against the current code (4.0.0) and are worth doing. Nothing here is a
promise or a schedule. Items marked **behavior change** alter a default, so they need either a major
version or an opt-in first.

## Design fixes

### Create shared URL clients outside render

Hooks with the same URL share one client, and its options come from whichever hook rendered first. A development
warning now names options that a later hook passes differently, but `sharedClient()` still writes to the registry
during render, so a render that React discards can decide which options win, and leaves behind an entry nothing
acquired.

- Look at creating the registry entry outside render, or replacing an entry that no committed hook ever
  acquired.

## Features

These build on what exists already: the `WebSocket` injection option, `latency.serverNow()`, volatile and
keyed sends, and topics. Large ones should ship as separate entry points so the core budget stays small.

### Live data

- **Sequenced streams with gap detection and resume.** Track a sequence number per topic, detect gaps, and on
  reconnect send `resume { lastSeq }` and drop duplicates, falling back to a snapshot when the server can't
  replay. This gives close to exactly-once delivery for trading, sports data and chat, and fits the existing
  re-subscribe-on-reconnect logic in topics.
- **One socket across tabs.** Elect a leader tab over `BroadcastChannel` (or use a `SharedWorker`) and
  multiplex topics through it. Users with 10–20 tabs open would cost one server connection instead of one per
  tab. A separate entry point.
- **WebTransport behind the same API.** Volatile sends map to datagrams and everything else to streams, with
  automatic fallback to WebSocket. Large and dependent on browser support, so it comes after the others.

### AI agents

- **Resumable agent runs** (`useAgentRun(runId)`). A refresh, a Wi-Fi to cellular switch or a sleeping laptop
  drops a streaming answer halfway, and the tokens are paid for anyway. Events carry an offset, the run id is
  kept in `sessionStorage`, and on reconnect or reload the client sends `resume { runId, offset }` and drops
  duplicates. A per-run disconnect policy chooses `keep` (background agents keep working) or `cancel` (chat
  stops spending). This is sequenced streams (above) applied to `rpc.stream` runs, so it ships after them.
- **Voice sessions with interruption.** On interruption the client must stop audio, discard queued frames,
  cancel generation and report how much the user actually heard, or the transcript includes words they never
  heard. The library's part is the transport, which ships: `priority` sends for control messages, and
  volatile audio frames with `maxBuffered` dropping stale ones while open. What's left is a guide showing
  `truncate { itemId, heardMs }` from playback position. Audio capture and playback stay in the app.
- **Dashboards of many runs.** Stream full tokens only for runs on screen and status alone for the rest.
  `useWebSocketTopic` already resubscribes when its topic changes, so this is a guide recipe plus a small
  `IntersectionObserver` helper that picks the topic. The same recipe can show a live cost meter from usage
  events and cancel a run that crosses a client-side budget.
### Business

- **Presence and live cursors** (`createWebSocketPresence`). Per-peer temporary state that expires, throttled
  through keyed sends.

### Tooling

- **Devtools overlay.** Shows sockets, topics, the queue and RTT.
- **Session recording and replay.** Record timestamped message logs to a file and replay them through a mock
  `WebSocket` at real speed, sped up, or with injected failures (through `react-websocket/chaos`). That gives
  reproducible bug reports ("attach your recording"), offline demos, and deterministic AI UI tests that don't
  call a model on every CI run.

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
  worth doing, but it belongs to the markdown renderer, not the transport. `batch: 'frame'` on
  `createWebSocketState` and `useWebSocketStream` covers the part that is the library's job.
- **Typed partial objects from streamed JSON** (`usePartialObject`). Useful, but it parses text from any
  transport, and AI SDKs already offer partial-object hooks. Worth revisiting as an option on `rpc.stream`
  (final value validated with the existing Standard Schema support).
