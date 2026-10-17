# createWebSocketState

Keep state built from a client's messages with a reducer.

```ts
function createWebSocketState<S, In>(
  client: WebSocketClient<In, any>,
  options: { initialState: S; reduce: (state: S, message: In) => S }
): WebSocketState<S>;
```

Available from both `react-websocket` and `react-websocket/core`.

## Usage

```ts
import { createWebSocket, createWebSocketState } from 'react-websocket';

type Tick = { symbol: string; price: number };

const prices = createWebSocket<Tick>('wss://api.example.com/prices', { json: true });

export const priceState = createWebSocketState(prices, {
  initialState: {} as Record<string, number>,
  reduce: (state, tick) => ({ ...state, [tick.symbol]: tick.price })
});
```

Read it in components with [`useWebSocketState`](./use-websocket-state.md). The guide is [Message state](../guide/state.md).

## Parameters

| Parameter | Type | |
| --- | --- | --- |
| `client` | [`WebSocketClient<In>`](./types.md#websocketclient) | The client whose messages are reduced. `In` is taken from it |
| `options.initialState` | `S` | The state before any message, and what `reset()` returns to. Also used for server rendering |
| `options.reduce` | `(state: S, message: In) => S` | Pure. Return a new object to change the state, or the same `state` to ignore the message |

## Returns

`WebSocketState<S>`:

| Member | |
| --- | --- |
| `getState()` | The current state. Same object until it changes |
| `subscribe(listener)` | Called on every change. Returns an unsubscribe function. Compatible with `useSyncExternalStore` |
| `setState(update)` | Replace the state, or pass `state => next` to update it |
| `reset()` | Back to `initialState` |
| `dispose()` | Stop reducing messages. Only for stores created dynamically |
| `client` | The client |
| `initialState` | The initial state |

## Behavior

- **Listening.** It listens to `'message'` events from creation, and keeps state across reconnects.
- **Connection.** It doesn't open or hold the connection; [`useWebSocketState`](./use-websocket-state.md) holds it while mounted.
- **Notifications.** Subscribers are notified only when the state changes, by `Object.is`.
- **Errors.** A reducer that throws leaves the state unchanged; the error is re-thrown asynchronously.
