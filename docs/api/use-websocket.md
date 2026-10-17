---
title: 'useWebSocket: React WebSocket hook'
description: 'useWebSocket connects a React component to a WebSocket and re-renders with its status and latest message. Signatures, options, return value and examples.'
---

# useWebSocket

Connect to a WebSocket and re-render with its status and latest message.

```ts
function useWebSocket<In = unknown, Out = unknown>(
  url: string | null | undefined,
  options?: UseWebSocketOptions<In, Out>
): UseWebSocketResult<In, Out>;

function useWebSocket<In, Out>(
  client: WebSocketClient<In, Out> | null | undefined,
  options?: WebSocketHandlers<In>
): UseWebSocketResult<In, Out>;
```

## Usage

### With a URL

```tsx
import { useWebSocket } from 'react-websocket';

function Prices() {
  const { status, lastMessage } = useWebSocket<{ price: number }>('wss://api.example.com/prices', {
    json: true
  });
  return <p>{status === 'open' ? lastMessage?.price : status}</p>;
}
```

Every component that passes the same URL (and the same `protocols`) shares one connection. The first component to use a URL creates its client, and **its connection options are used for everyone**. Options passed by later components for the same URL are ignored, except handlers and `enabled`, which are per component. If two components need different options for the same URL, create separate clients with [`createWebSocket`](./create-websocket.md).

Changing `url` closes the old connection (once nothing else uses it) and opens the new one.

### With a client

```tsx
import { createWebSocket, useWebSocket } from 'react-websocket';

const chat = createWebSocket<ChatIn, ChatOut>('wss://api.example.com/chat', { json: true });

function Composer() {
  const { status, send } = useWebSocket(chat, {
    onMessage: message => console.log(message)
  });
  // …
}
```

Connection options come from `createWebSocket`. Only [handlers](#handlers) and `enabled` are accepted here.

### Disconnected

Pass `null` or `undefined` to stay disconnected. The status is `'idle'`, and `send` returns `false` without queueing.

```tsx
useWebSocket(roomId ? `wss://api.example.com/rooms/${roomId}` : null);
```

## Parameters

| Parameter | Type | |
| --- | --- | --- |
| `url` / `client` | `string \| WebSocketClient \| null \| undefined` | What to connect to |
| `options` | `UseWebSocketOptions` / `WebSocketHandlers` | See below |

### Options

With a URL, `options` accepts every [connection option](./options.md) plus the handlers below.

### Handlers

| Option | Type | |
| --- | --- | --- |
| `onOpen` | `(event: Event) => void` | The socket opened, initially or after a reconnect |
| `onMessage` | `(message: In, event: MessageEvent) => void` | A message arrived and passed `parse`/`json` and `schema` |
| `onClose` | `(close: CloseInfo) => void` | A socket closed, whether or not it will be retried |
| `onError` | `(error: Event \| Error) => void` | A socket error, a [`MessageError`](./types.md#messageerror), or an error from the constructor or `url` function |
| `enabled` | `boolean` | `false` releases this component's hold and stops its handlers. Default `true` |

Handlers always see the latest props and state, and changing them never reconnects. You don't need `useCallback`, `useEffectEvent` or the React Compiler for that.

Handlers belong to the component: they run only while it is mounted and `enabled`. Every component sharing a connection receives every event.

## Returns

`UseWebSocketResult<In, Out>`:

| Field | Type | |
| --- | --- | --- |
| `status` | [`Status`](./types.md#status) | `'idle'`, `'connecting'`, `'open'`, `'reconnecting'` or `'closed'` |
| `lastMessage` | `In \| undefined` | The most recent message, kept across reconnects |
| `attempt` | `number` | Consecutive failed attempts since the last successful open |
| `send` | `(message: Out, options?: SendOptions) => boolean` | Sends now, or queues until open (see [`SendOptions`](./types.md#sendoptions)). Returns `true` if sent immediately |
| `close` | `(code?: number, reason?: string) => void` | Closes and stops reconnecting, for every component sharing the connection |
| `reconnect` | `() => void` | Drops the socket and connects again immediately |
| `client` | `WebSocketClient<In, Out> \| null` | The underlying client, or `null` when disconnected |

`send`, `close` and `reconnect` keep the same identity across renders, so they are safe in dependency arrays and as props to memoized children.

## Behavior

- **Renders.** The component re-renders when the status changes and on **every message**. For high-frequency streams, use [`useWebSocketEvent`](./use-websocket-event.md) and [`useWebSocketStatus`](./use-websocket-status.md), which don't re-render per message. See [Performance](../guide/performance.md).
- **Lifecycle.** The connection opens on mount (in an Effect) and closes one tick after the last component using it unmounts. StrictMode and `<Activity>` don't create duplicate sockets. See [StrictMode, Activity and lifecycle](../guide/lifecycle.md).
- **Server rendering.** Renders `status: 'idle'` and never connects. See [Server rendering](../guide/ssr.md).
- **After `close()`.** The status stays `'closed'` while components remain mounted. Call `reconnect()` to start again. Once every component unmounts, the next mount connects normally.

## Caveats

- `useWebSocket(url)` with the same URL but different `json`, `schema` or `reconnect` options in two components uses the first component's options for both. Use `createWebSocket` instead.
- `lastMessage` is for "show the latest value" UIs. Don't collect messages by watching it in an Effect: if several messages arrive before React renders, you only see the last one. Use `onMessage` instead, which runs once per message.
