# Roadmap

Ideas that have been checked against the current code (4.0.0) and are worth doing. Nothing here is a
promise or a schedule. Items marked **behavior change** alter a default, so they need either a major
version or an opt-in first.

## Features

These build on what exists already: the `WebSocket` injection option, `latency.serverNow()`, volatile and
keyed sends, and topics. Large ones should ship as separate entry points so the core budget stays small.

### Live data

- **One socket across tabs.** Elect a leader tab over `BroadcastChannel` (or use a `SharedWorker`) and
  multiplex topics through it. Users with 10–20 tabs open would cost one server connection instead of one per
  tab. A separate entry point.
- **WebTransport behind the same API.** Volatile sends map to datagrams and everything else to streams, with
  automatic fallback to WebSocket. Large and dependent on browser support, so it comes after the others.

### AI agents

- **Voice sessions with interruption.** On interruption the client must stop audio, discard queued frames,
  cancel generation and report how much the user actually heard, or the transcript includes words they never
  heard. The library's part is the transport, which ships: `priority` sends for control messages, and
  volatile audio frames with `maxBuffered` dropping stale ones while open. What's left is a guide showing
  `truncate { itemId, heardMs }` from playback position. Audio capture and playback stay in the app.

### Tooling

- **Devtools overlay.** Shows sockets, topics, the queue and RTT.
- **Session recording and replay.** Record timestamped message logs to a file and replay them through a mock
  `WebSocket` at real speed, sped up, or with injected failures (through `react-websocket/chaos`). That gives
  reproducible bug reports ("attach your recording"), offline demos, and deterministic AI UI tests that don't
  call a model on every CI run.

### Protocol adapters

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
