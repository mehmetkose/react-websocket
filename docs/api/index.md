---
title: 'React WebSocket API reference'
description: 'Every hook, function, class and type react-websocket exports, from useWebSocket and createWebSocket to topics, state, requests and latency. All typed.'
---

# API reference

Everything the package exports. All exports are typed, and every type has inline documentation that your editor shows on hover.

## Entry points

| Import | Contents | Notes |
| --- | --- | --- |
| `react-websocket` | Hooks, `createWebSocket`, `MessageError`, types | Marked `'use client'` for Server Components frameworks |
| `react-websocket/core` | `createWebSocket`, the other `create*` functions, `MessageError`, types | No React dependency. Use it in workers, Node, or other frameworks |
| `react-websocket/timeline` | `createWebSocketTimeline`, its types | For multiplayer games. No React dependency |
| `react-websocket/outbox` | `createWebSocketOutbox`, `indexedDBStorage`, `memoryStorage`, their types | Messages kept until acknowledged, across reloads. No React dependency |
| `react-websocket/chaos` | `createChaosWebSocket`, its types | A development tool. No React dependency |

Every entry point ships as ESM and CommonJS with type declarations for each.

## Hooks

| Hook | Use it to | Re-renders on |
| --- | --- | --- |
| [`useWebSocket(url \| client, options?)`](./use-websocket.md) | Connect and read status and the latest message | Status changes and every message |
| [`useWebSocketEvent(client, type, listener)`](./use-websocket-event.md) | Handle events without re-rendering | Never |
| [`useWebSocketStatus(client)`](./use-websocket-status.md) | Show connection status | Status changes only |
| [`useWebSocketTopic(topics, topic)`](./use-websocket-topic.md) | Hold topic subscriptions that survive reconnects | Never |
| [`useWebSocketState(store, selector?, isEqual?)`](./use-websocket-state.md) | Read state reduced from messages | The selected value changes |
| [`useWebSocketLatency(latency)`](./use-websocket-latency.md) | Show round-trip time | A new measurement, about once per ping |
| [`useAgentApproval(responder, method)`](./use-agent-approval.md) | Render requests from the server that a person answers | A request arrives or goes away |
| [`useWebSocketStream(rpc, options?)`](./use-websocket-stream.md) | Stream the replies to a request into a value, such as tokens into an answer, with Stop | Every reply, or once per frame |
| [`useWebSocketOutbox(outbox)`](./use-websocket-outbox.md) | List the messages waiting in an outbox | A message is added, sent or acknowledged |

## Functions

| Function | |
| --- | --- |
| [`createWebSocket(url, options?)`](./create-websocket.md) | Create a client to share across components or use outside React |
| [`createWebSocketTopics(client, options)`](./create-websocket-topics.md) | Manage reference-counted topic subscriptions, resent after every reconnect |
| [`createWebSocketFeeds(client, options)`](./create-websocket-feeds.md) | Topic subscriptions with numbered messages: each delivered once and in order across reconnects, with resume and snapshots |
| [`createWebSocketState(client, options)`](./create-websocket-state.md) | Keep state reduced from a client's messages |
| [`createWebSocketRequests(client, options)`](./create-websocket-requests.md) | Send requests and await their replies or stream them, with timeouts and cancellation |
| [`createWebSocketLatency(client, options)`](./create-websocket-latency.md) | Measure round-trip time and estimate the server's clock |
| [`createWebSocketSendRate(client, options?)`](./create-websocket-send-rate.md) | Send aim, cursor or position at a rate that adapts to the connection, coalesced per key |
| [`createWebSocketResponder(client, options)`](./create-websocket-responder.md) | Answer requests the server sends, in code or from the UI |
| [`createWebSocketTimeline(client, options)`](./create-websocket-timeline.md) | Interpolate server snapshots and predict your own inputs, for multiplayer games. From `react-websocket/timeline` |
| [`createWebSocketOutbox(client, options)`](./create-websocket-outbox.md) | Keep messages in IndexedDB until the server acknowledges them, across reconnects and reloads. From `react-websocket/outbox` |
| [`createChaosWebSocket(options?)`](./chaos.md) | A `WebSocket` class that injects network faults in development. From `react-websocket/chaos` |
| [`retryableClose(close)`](../guide/reconnecting.md#giving-up) | The default `reconnect.shouldReconnect`: `false` for close codes `1002`, `1003` and `1008`. Call it from your own to keep that rule |
| [`retryAfter(close)`](../guide/reconnecting.md#overloaded-servers-1013) | The default `reconnect.retryAfter`: the delay in ms from a `1012` or `1013` close whose reason is a number of seconds. Call it from your own to keep reading it |

## Classes

| Class | |
| --- | --- |
| [`MessageError`](./types.md#messageerror) | Reported to `onError` when a message fails `parse` or `schema` |

## Types

| Type | |
| --- | --- |
| [`WebSocketOptions`](./options.md) | Connection options |
| [`UseWebSocketOptions`](./use-websocket.md#options) | `WebSocketOptions` plus handlers and `enabled` |
| [`UseWebSocketResult`](./use-websocket.md#returns) | What `useWebSocket` returns |
| [`UseWebSocketStreamOptions`](./use-websocket-stream.md#parameters) | `{ initial, reduce, batch? }` |
| [`UseWebSocketStreamResult`](./use-websocket-stream.md#returns) | `{ value, status, error, start, abort }` from `useWebSocketStream` |
| [`WebSocketHandlers`](./use-websocket.md#handlers) | `onOpen`, `onMessage`, `onClose`, `onError`, `enabled` |
| [`WebSocketClient`](./types.md#websocketclient) | The client returned by `createWebSocket` |
| [`Status`](./types.md#status) | `'idle' \| 'connecting' \| 'open' \| 'reconnecting' \| 'closed'` |
| [`Snapshot`](./types.md#snapshot) | `{ status, lastMessage, attempt }` |
| [`CloseInfo`](./types.md#closeinfo) | `{ code, reason, wasClean }` |
| [`EventMap`](./types.md#eventmap) | Events and listener signatures |
| [`UrlSource`](./types.md#urlsource) | A URL string or a function returning one |
| [`SendData`](./types.md#senddata) | What `WebSocket.send` accepts |
| [`SendOptions`](./types.md#sendoptions) | `{ volatile?, key?, priority?, maxBuffered?, maxAge?, onDrop? }` for `send()` |
| [`ReconnectOptions`](./options.md#reconnect) | Backoff settings |
| [`HeartbeatOptions`](./options.md#heartbeat) | Keep-alive settings |
| [`QueueOptions`](./options.md#queue) | Send queue limit and maximum age |
| [`WebSocketTopics`](./create-websocket-topics.md#returns) | The topic manager from `createWebSocketTopics` |
| [`WebSocketTopicsOptions`](./create-websocket-topics.md#parameters) | `{ subscribe, unsubscribe? }` |
| [`WebSocketFeeds`](./create-websocket-feeds.md#returns) | The feeds from `createWebSocketFeeds`: topics plus `on('message')` and `position()` |
| [`WebSocketFeedsOptions`](./create-websocket-feeds.md#parameters) | `{ subscribe, unsubscribe?, resume?, sequence, snapshot?, onGap? }` |
| [`FeedPosition`](./create-websocket-feeds.md#parameters) | `{ topic, seq }` |
| [`MessageSource`](./create-websocket-state.md#parameters) | Something with the client's `message` event, such as feeds, for `createWebSocketState` |
| [`WebSocketState`](./create-websocket-state.md#returns) | The store from `createWebSocketState` |
| [`WebSocketStateOptions`](./create-websocket-state.md#parameters) | `{ initialState, reduce, batch? }` |
| [`WebSocketRequests`](./create-websocket-requests.md#returns) | The request manager from `createWebSocketRequests` |
| [`WebSocketRequestsOptions`](./create-websocket-requests.md#parameters) | `{ send, reply, error?, done?, cancel?, timeout? }` |
| [`RequestOptions`](./create-websocket-requests.md#request-options) | `{ timeout?, signal?, volatile?, key?, priority?, maxBuffered? }` for `request()` and `stream()` |
| [`WebSocketLatency`](./create-websocket-latency.md#returns) | The latency tracker from `createWebSocketLatency` |
| [`WebSocketLatencyOptions`](./create-websocket-latency.md#parameters) | `{ ping, pong, interval?, samples? }` |
| [`Latency`](./create-websocket-latency.md#latency) | `{ rtt, offset }` |
| [`WebSocketSendRate`](./create-websocket-send-rate.md#returns) | The sender from `createWebSocketSendRate` |
| [`WebSocketSendRateOptions`](./create-websocket-send-rate.md#parameters) | `{ maxRate?, minRate?, maxBuffered?, latency?, maxRttIncrease? }` |
| [`SendRate`](./create-websocket-send-rate.md#sendrate) | `{ rate, congested }` |
| [`WebSocketResponder`](./create-websocket-responder.md#returns) | The responder from `createWebSocketResponder` |
| [`WebSocketResponderOptions`](./create-websocket-responder.md#parameters) | `{ request, respond, error, cancel?, timeout? }` |
| [`IncomingRequest`](./create-websocket-responder.md#incomingrequest) | `{ id, method, params, signal, respond, reject }` |
| [`RequestHandler`](./create-websocket-responder.md#onrequest) | `(params, request) => result \| Promise<result>` for `onRequest` |
| [`WebSocketTimeline`](./create-websocket-timeline.md#returns) | The timeline from `createWebSocketTimeline` |
| [`WebSocketTimelineOptions`](./create-websocket-timeline.md#parameters) | `{ snapshot, interpolate?, delay?, extrapolate?, buffer?, latency?, input? }` |
| [`TimelineSnapshot`](./create-websocket-timeline.md#timelinesnapshot) | `{ time, state, ack? }` |
| [`TimelineInputOptions`](./create-websocket-timeline.md#parameters) | `{ send, predict, maxBuffered? }` |
| [`WebSocketOutbox`](./create-websocket-outbox.md#returns) | The outbox from `createWebSocketOutbox` |
| [`WebSocketOutboxOptions`](./create-websocket-outbox.md#parameters) | `{ name, send, ack?, maxAge?, onExpire?, storage? }` |
| [`OutboxEntry`](./create-websocket-outbox.md#outboxentry) | `{ id, message, createdAt, sent }` |
| [`OutboxStorage`](./create-websocket-outbox.md#outboxstorage) | `{ load, put, delete }`, where an outbox keeps its messages |
| [`OutboxRecord`](./create-websocket-outbox.md#outboxstorage) | `{ id, message, createdAt }`, what an outbox stores |
| [`StandardSchemaV1`](./types.md#standardschemav1) | The schema interface zod, valibot and arktype implement |
| [`ChaosWebSocket`](./chaos.md#returns) | The class from `createChaosWebSocket`: `typeof WebSocket` plus its controls |
| [`ChaosOptions`](./chaos.md#parameters) | `{ WebSocket?, seed?, logger? }` plus the faults |
| [`ChaosFaults`](./chaos.md#types) | `{ enabled?, latency?, loss?, refuse?, drop?, stall?, corrupt? }` for `configure()` |
| [`ChaosControls`](./chaos.md#returns) | `configure`, `drop`, `stall` and `inject` |
| [`ChaosRange`](./chaos.md#types) | A duration in ms, or `[min, max]` |
