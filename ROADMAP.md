# Roadmap

Ideas that have been checked against the current code (4.21.0) and are worth doing. Nothing here is a
promise or a schedule. Items marked **behavior change** alter a default, so they need either a major version
or an opt-in first.

What earlier versions of this list planned has shipped: see the [changelog](CHANGELOG.md). New ideas are
welcome in [discussions](https://github.com/mehmetkose/react-websocket/discussions).

## Features

These come from comparing the client with [Faye](https://faye.jcoglan.com)'s. None needs a wire protocol: as
with topics and requests, you describe your server's messages and the library keeps track of them. None is a
behavior change.

### Docs

- **Publish with acknowledgement.** A recipe for awaiting the server's acknowledgement of a message, like
  Faye's `publish().then()`. `createWebSocketRequests` already resolves on the acknowledgement and rejects on
  an error reply or a timeout, and `react-websocket/outbox` covers messages that must arrive across reloads.
- **Server-controlled reconnects.** A section in the reconnecting guide that maps the instructions a Faye
  server can give its clients onto what exists: "retry in N seconds" is a `1013` close with N as the reason
  (`retryAfter`), "reconnect fresh" is a message that calls `migrate()`, and "stop" is a close code of your
  own that `shouldReconnect` refuses.
- **Headers, proxies, TLS and compression in Node.** The Node section of the without-React guide only shows
  plain `ws`. Add a `ws` subclass that passes `headers`, a proxy `agent`, `ca` and `perMessageDeflate`, and
  reads the token in its constructor so every reconnect sends a fresh one.

### Topics

Each builds on the one before it, so they ship in this order.

- **A callback per topic.** A `topic(message)` option tells the manager which topic a message belongs to.
  Then `topics.on(topic, listener)` and `useWebSocketTopic(topics, topic, onMessage)` hold a subscription and
  receive only its messages, instead of every component filtering the client's message stream. Feeds already
  know each message's topic from `sequence`, so they need little extra work. Watch the topics size budget
  (1 kB).
- **Wildcard topics.** A `match(pattern, topic)` option, and a ready-made matcher for `*` (one level) and
  `**` (any depth) with a configurable separator (`/`, `:` or `.`), since servers differ. The listener also
  gets the topic that matched, like Faye's `withChannel`. The server still has to support wildcard
  subscriptions; the client only routes messages to listeners.
- **Subscribe confirmation.** `subscribed` and `rejected` options that recognize the server's replies. Then
  `topics.status(topic)` is `subscribing`, `subscribed` or `failed`, `topics.ready(topic)` is a promise that
  works with `use()`, and `useWebSocketTopic` returns `{ status, error }` (it returns nothing today). After a
  reconnect, a topic is `subscribing` again. A rejected topic isn't sent again until it's acquired again.

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
