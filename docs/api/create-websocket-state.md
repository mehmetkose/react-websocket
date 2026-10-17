# createWebSocketState

Keep state built from a client's messages with a reducer.

```ts
function createWebSocketState<S, In>(
  client: WebSocketClient<In, any>,
  options: { initialState: S; reduce: (state: S, message: In) => S; batch?: 'frame' }
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
| `options.batch` | `'frame'` | Notify subscribers at most once per animation frame instead of once per message. `getState()` stays current. Default: notify on every change |

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
- **Batching.** With `batch: 'frame'`, messages are still reduced as they arrive, so `getState()` is always current, but subscribers hear about it once per animation frame, and not at all if the state is back where it was. `setState` and `reset` notify right away, including any changes still waiting for the frame. Without `requestAnimationFrame` (Node, some workers), it waits about 16 ms instead.
- **Background tabs.** Browsers pause animation frames in background tabs. A batched store keeps reducing, and subscribers hear about the latest state when the tab is visible again. If something must update while hidden (say, `document.title`), use an unbatched store or a `message` listener for it.
- **Errors.** A reducer that throws leaves the state unchanged; the error is re-thrown asynchronously.
