---
description: 'createWebSocketSendRate: send high-rate state such as aim or cursor positions at a rate that adapts to the connection, coalesced per key.'
---

# createWebSocketSendRate

Send high-rate state, such as aim, cursor or position, at a rate that adapts to the connection. Messages are coalesced per key between ticks, and the rate drops when the link is congested.

```ts
function createWebSocketSendRate<Out>(
  client: WebSocketClient<unknown, Out>,
  options?: {
    maxRate?: number;
    minRate?: number;
    maxBuffered?: number;
    latency?: WebSocketLatency;
    maxRttIncrease?: number;
  }
): WebSocketSendRate<Out>;
```

Available from both `react-websocket` and `react-websocket/core`.

## Usage

```ts
import { createWebSocketSendRate } from 'react-websocket';
import { game, latency } from './game';

export const stream = createWebSocketSendRate(game, { latency, maxRate: 30 });
```

Send as often as you like, for example on every pointer move. At most `maxRate` messages per key go out each second, fewer on a congested link, and each one is the newest:

```ts
canvas.addEventListener('pointermove', event => {
  stream.send({ type: 'aim', angle: angleTo(event) }, 'aim');
});
```

The guide is [Real-time games](../guide/games.md#poor-connections-adaptive-send-rate).

## Parameters

| Parameter | Type | |
| --- | --- | --- |
| `client` | [`WebSocketClient<In, Out>`](./types.md#websocketclient) | The client to send on. `Out` is taken from it |
| `options.maxRate` | `number` | Optional. Ticks per second while the connection keeps up. Default `30` |
| `options.minRate` | `number` | Optional. The rate never drops below this. Default `5` |
| `options.maxBuffered` | `number` | Optional. Bytes waiting in the browser's send buffer above which a tick sends nothing and the rate halves. Default `1024` |
| `options.latency` | [`WebSocketLatency`](./create-websocket-latency.md) | Optional. Measurements on the same client. With them, a rising round trip lowers the rate too |
| `options.maxRttIncrease` | `number` | Optional. How far `rtt` may rise above the lowest one on this connection before the rate halves, in ms. Default `100` |

## Returns

`WebSocketSendRate<Out>`:

| Member | |
| --- | --- |
| `send(message, key)` | Send `message` at the next tick, replacing any message with the same `key` still waiting for it |
| `flush()` | Send everything waiting now, e.g. right before a one-shot action that must carry the latest aim |
| `getSnapshot()` | The current [`SendRate`](#sendrate). Returns the same object until it changes |
| `subscribe(listener)` | Get notified when the rate or `congested` changes. Returns an unsubscribe function |
| `dispose()` | Stop sending and listening. Only for instances created dynamically |
| `client` | The client |

### SendRate

```ts
interface SendRate {
  /** Ticks per second, rounded. */
  readonly rate: number;
  /** Whether the last tick found the send buffer full or the round trip risen. */
  readonly congested: boolean;
}
```

Show it in a HUD with `useSyncExternalStore(stream.subscribe, stream.getSnapshot)`.

## Behavior

- **Coalescing.** Between ticks, only the newest message per key is kept. A replaced message moves to the end, so keys go out in the order they were last sent. Every message needs a key: send one-shot actions such as fire or jump with `client.send` instead, after `flush()` if they must follow the latest state.
- **Ticks.** A tick runs only while the socket is open and something is waiting. The first message after a pause goes out on the next task, and later ones at most `rate` times a second. Messages are sent with `volatile`.
- **Adapting.** At each tick, if more than `maxBuffered` bytes are waiting in the send buffer, nothing is sent and the rate halves. Otherwise everything waiting is sent and the rate climbs by one. With `latency`, each new measurement whose `rtt` is more than `maxRttIncrease` above the lowest one on this connection halves the rate too, and stops it climbing until the round trip comes back down. The rate stays between `minRate` and `maxRate`. From 5 back to 30 takes about two seconds.
- **Steady high ping is fine.** Only a round trip that rises counts, so a player who is far away but on a good link keeps the full rate.
- **Reconnects.** Messages waiting during a reconnect are kept and go out after it, after `open` listeners and the client's own queue. `close()` and giving up drop them. The lowest round trip is measured afresh on each connection, and the rate carries over.
- **Doesn't connect.** It doesn't open or hold the connection.
- **Not for inputs you predict.** Coalescing drops messages, and an input dropped this way would never be confirmed. For [timeline](./create-websocket-timeline.md) inputs, read `getSnapshot().rate` to decide how often to call `timeline.input()`, and put the steps in between into one input. The rate only adapts on ticks, so this works while you also stream something, such as aim, through `send()`.
