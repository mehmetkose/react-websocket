# Roadmap

Ideas that have been checked against the current code and are worth doing. Nothing here is a promise or a
schedule. Items marked **behavior change** alter a default, so they need either a major version or an opt-in
first.

Everything planned for 4.x has shipped: see the [changelog](CHANGELOG.md). New ideas are welcome in
[discussions](https://github.com/mehmetkose/react-websocket/discussions).

## Considered, not planned

- **MCP over WebSocket.** SEP-1288 proposed a WebSocket transport for MCP, passing the auth token in the
  subprotocol list, and a browser reference client was planned to demonstrate it. The SEP was closed as dormant on
  2026-06-26 without a sponsor, and the 2026-07-28 MCP specification went the other way: a stateless protocol that
  retires `initialize` and sessions, replaces server-initiated requests with retried calls, and defines Streamable
  HTTP as its transport. A WebSocket client would target a proposal that isn't becoming a standard. If one returns,
  the `url` function and `protocols` option already cover its authentication, and `createWebSocketRequests` its
  requests.
- **Incremental markdown rendering for token streams.** Re-parsing only the last open block is real work
  worth doing, but it belongs to the markdown renderer, not the transport. `batch: 'frame'` on
  `createWebSocketState` and `useWebSocketStream` covers the part that is the library's job.
- **Typed partial objects from streamed JSON** (`usePartialObject`). Useful, but it parses text from any
  transport, and AI SDKs already offer partial-object hooks. Worth revisiting as an option on `rpc.stream`
  (final value validated with the existing Standard Schema support).
