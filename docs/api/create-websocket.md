# createWebSocket

Create a WebSocket client to share across components or use outside React.

```ts
function createWebSocket<In = unknown, Out = unknown>(
  url: UrlSource,
  options?: WebSocketOptions<In, Out>
): WebSocketClient<In, Out>;
```

Available from both `react-websocket` and `react-websocket/core`.

## Usage

Create clients at module level, outside components:

```ts
// live.ts
import { createWebSocket } from 'react-websocket';

type LiveIn = { type: 'price'; symbol: string; price: number };
type LiveOut = { type: 'subscribe'; symbol: string };

export const live = createWebSocket<LiveIn, LiveOut>('wss://api.example.com/live', {
  json: true,
  heartbeat: { interval: 25_000, timeout: 5_000 }
});
```

Then use it from any component with [`useWebSocket(live)`](./use-websocket.md), [`useWebSocketEvent(live, …)`](./use-websocket-event.md) or [`useWebSocketStatus(live)`](./use-websocket-status.md), or directly:

```ts
live.send({ type: 'subscribe', symbol: 'ACME' });
const off = live.on('message', message => console.log(message.price));
```

:::warning Don't create clients during render
`createWebSocket` inside a component body creates a new client on every render. Create it at module level, or use `useWebSocket(url)` for per-component connections.
:::

## Parameters

| Parameter | Type | |
| --- | --- | --- |
| `url` | [`UrlSource`](./types.md#urlsource) | A URL, or a function (sync or async) called before **every** connection attempt |
| `options` | [`WebSocketOptions`](./options.md) | Connection options |

The `In` type is inferred from `options.schema` when you pass one.

## Returns

A [`WebSocketClient`](./types.md#websocketclient).

## Lifecycle

A client is lazy. Creating one opens nothing. It connects when:

1. a hook using it mounts (or `client.acquire()` is called),
2. `client.ready` is read, or
3. `client.connect()` is called.

It closes **one tick after the last hook unmounts** (or the last `acquire()` is released), and its status returns to `'idle'`. A connection started by reading `ready` that nothing holds closes a few seconds after it opens. Calling `connect()` opts out of that: the client then stays connected, reconnecting as needed, until you call `close()`.

| From | Event | To |
| --- | --- | --- |
| `idle` | A hook mounts, `ready` is read, or `connect()` | `connecting` |
| `connecting` | The socket opens | `open` |
| `connecting`, `open` | The connection fails or drops | `reconnecting` (backoff, then retry) |
| `reconnecting` | A retry opens | `open` |
| any | `close()`, or reconnecting gives up | `closed` |
| `closed` | `connect()` or `reconnect()` | `connecting` |
| any | The last hook unmounts (unless `connect()` was called) | `idle` |

The full picture, including backoff and heartbeats, is in [Reconnecting and heartbeats](../guide/reconnecting.md).

## Client methods

| Member | |
| --- | --- |
| `send(message, options?)` | Send now, or queue until open. `{ volatile: true }` drops instead of queueing, `{ key }` keeps only the newest queued message per key, `{ priority: true }` queues ahead of the others, and `{ maxBuffered }` drops while the send buffer is full. See [`SendOptions`](./types.md#sendoptions). Returns `true` if sent immediately |
| `on(type, listener)` | Listen to `'open'`, `'message'`, `'close'` or `'error'`. Returns an unsubscribe function |
| `connect()` | Connect, and stay connected until `close()` even with no hooks mounted |
| `close(code?, reason?)` | Close, stop reconnecting, clear the queue. Status becomes `'closed'` |
| `reconnect()` | Drop the socket and connect again now, resetting the backoff. Also restarts a `'closed'` client |
| `ready` | Promise that resolves once connected. See [Suspense](../guide/suspense.md) |
| `getSnapshot()` | Current `{ status, lastMessage, attempt }` |
| `subscribe(listener)` | Get notified when the snapshot changes. Returns an unsubscribe function |
| `acquire()` | Hold the connection open until the returned release function is called |
| `socket` | The current `WebSocket`, or `null`. Escape hatch |
| `url` | The `url` passed to `createWebSocket` |

Full signatures are in [`WebSocketClient`](./types.md#websocketclient).
