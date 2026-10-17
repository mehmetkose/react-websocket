# API reference

Everything the package exports. All exports are typed, and every type has inline documentation that your editor shows on hover.

## Entry points

| Import | Contents | Notes |
| --- | --- | --- |
| `react-websocket` | Hooks, `createWebSocket`, `MessageError`, types | Marked `'use client'` for Server Components frameworks |
| `react-websocket/core` | `createWebSocket`, `MessageError`, types | No React dependency. Use it in workers, Node, or other frameworks |

Both entry points ship as ESM and CommonJS with type declarations for each.

## Hooks

| Hook | Use it to | Re-renders on |
| --- | --- | --- |
| [`useWebSocket(url \| client, options?)`](./use-websocket.md) | Connect and read status and the latest message | Status changes and every message |
| [`useWebSocketEvent(client, type, listener)`](./use-websocket-event.md) | Handle events without re-rendering | Never |
| [`useWebSocketStatus(client)`](./use-websocket-status.md) | Show connection status | Status changes only |
| [`useWebSocketTopic(topics, topic)`](./use-websocket-topic.md) | Hold topic subscriptions that survive reconnects | Never |
| [`useWebSocketState(store, selector?, isEqual?)`](./use-websocket-state.md) | Read state reduced from messages | The selected value changes |

## Functions

| Function | |
| --- | --- |
| [`createWebSocket(url, options?)`](./create-websocket.md) | Create a client to share across components or use outside React |
| [`createWebSocketTopics(client, options)`](./create-websocket-topics.md) | Manage reference-counted topic subscriptions, resent after every reconnect |
| [`createWebSocketState(client, options)`](./create-websocket-state.md) | Keep state reduced from a client's messages |

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
| [`WebSocketHandlers`](./use-websocket.md#handlers) | `onOpen`, `onMessage`, `onClose`, `onError`, `enabled` |
| [`WebSocketClient`](./types.md#websocketclient) | The client returned by `createWebSocket` |
| [`Status`](./types.md#status) | `'idle' \| 'connecting' \| 'open' \| 'reconnecting' \| 'closed'` |
| [`Snapshot`](./types.md#snapshot) | `{ status, lastMessage, attempt }` |
| [`CloseInfo`](./types.md#closeinfo) | `{ code, reason, wasClean }` |
| [`EventMap`](./types.md#eventmap) | Events and listener signatures |
| [`UrlSource`](./types.md#urlsource) | A URL string or a function returning one |
| [`SendData`](./types.md#senddata) | What `WebSocket.send` accepts |
| [`ReconnectOptions`](./options.md#reconnect) | Backoff settings |
| [`HeartbeatOptions`](./options.md#heartbeat) | Keep-alive settings |
| [`QueueOptions`](./options.md#queue) | Send queue limit |
| [`WebSocketTopics`](./create-websocket-topics.md#returns) | The topic manager from `createWebSocketTopics` |
| [`WebSocketTopicsOptions`](./create-websocket-topics.md#parameters) | `{ subscribe, unsubscribe? }` |
| [`WebSocketState`](./create-websocket-state.md#returns) | The store from `createWebSocketState` |
| [`WebSocketStateOptions`](./create-websocket-state.md#parameters) | `{ initialState, reduce }` |
| [`StandardSchemaV1`](./types.md#standardschemav1) | The schema interface zod, valibot and arktype implement |
