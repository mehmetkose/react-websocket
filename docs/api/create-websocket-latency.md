# createWebSocketLatency

Measure round-trip time and estimate the server's clock with application-level pings.

```ts
function createWebSocketLatency<In, Out>(
  client: WebSocketClient<In, Out>,
  options: {
    ping: (id: number) => Out;
    pong: (message: In) => { id: number | string; time?: number } | null | undefined;
    interval?: number;
    samples?: number;
  }
): WebSocketLatency;
```

Available from both `react-websocket` and `react-websocket/core`.

## Usage

```ts
import { createWebSocket, createWebSocketLatency } from 'react-websocket';

type In = { type: 'pong'; id: number; time: number } | { type: 'state' };
type Out = { type: 'ping'; id: number };

const game = createWebSocket<In, Out>('wss://game.example.com', { json: true });

export const latency = createWebSocketLatency(game, {
  ping: id => ({ type: 'ping', id }),
  pong: message => (message.type === 'pong' ? { id: message.id, time: message.time } : undefined)
});
```

Your server answers each ping with its id and its own `Date.now()`:

```ts
socket.send(JSON.stringify({ type: 'pong', id: message.id, time: Date.now() }));
```

Read the measurements in components with [`useWebSocketLatency`](./use-websocket-latency.md). The guide is [Real-time games](../guide/games.md#ping-and-server-time).

## Parameters

| Parameter | Type | |
| --- | --- | --- |
| `client` | [`WebSocketClient<In, Out>`](./types.md#websocketclient) | The client to measure. `In` and `Out` are taken from it |
| `options.ping` | `(id: number) => Out` | The ping message, tagged with `id` |
| `options.pong` | `(message: In) => { id, time? } \| null \| undefined` | Recognize a pong: the `id` it answers, and optionally the server's clock in ms. `undefined` for any other message |
| `options.interval` | `number` | Optional. Time between pings while open, in ms. Default `2000` |
| `options.samples` | `number` | Optional. How many recent measurements to keep. Default `5` |

## Returns

`WebSocketLatency`:

| Member | |
| --- | --- |
| `getSnapshot()` | The current [`Latency`](#latency). Returns the same object until it changes |
| `subscribe(listener)` | Get notified when a measurement changes. Returns an unsubscribe function |
| `serverNow()` | The estimated server time: `Date.now() + offset`, or `Date.now()` before any estimate |
| `ping()` | Ping now instead of waiting for the next interval. Does nothing unless open |
| `dispose()` | Stop pinging and listening. Only for instances created dynamically |
| `client` | The client |

### Latency

```ts
interface Latency {
  /** Round-trip time in ms, the median of recent pings. */
  readonly rtt: number | undefined;
  /** Server clock minus local clock, in ms. */
  readonly offset: number | undefined;
}
```

Both are `undefined` until the first pong. `offset` stays `undefined` if pongs carry no `time`.

## Behavior

- **Pings while open.** The first ping goes out as soon as the socket opens, before messages queued while disconnected. After that, one goes out every `interval`. Pings pause while not open, and they are sent with `volatile`, so they're never queued.
- **Smoothing.** `rtt` is the median of the last `samples` round trips, so one slow ping doesn't make it jump. `offset` comes from the sample with the lowest round trip, the most accurate estimate. It assumes the server read its clock halfway through the round trip.
- **Reconnects.** Samples from the previous connection are discarded when a new one opens. The last values stay readable until a new pong arrives.
- **Doesn't connect.** It starts measuring whenever the client is open, but doesn't hold the connection. `useWebSocketLatency` does.
- **Pongs are messages.** Pongs also reach `onMessage`, `lastMessage` and state stores. With `useWebSocket`, that's one extra render per interval.
- **Not a heartbeat.** It doesn't detect dead connections. Use the [`heartbeat`](./options.md#heartbeat) option for that. Both can run on the same client.
- **Requires TypeScript 5.4+** for the inferred message types (it uses `NoInfer`).
