# Message state

Most socket UIs show state built up from many messages: the latest price per symbol, a chat log, who's online. `createWebSocketState` keeps that state for you with a reducer, and `useWebSocketState` reads a slice of it. A component re-renders only when **its** slice changes, however many messages arrive.

## Setup

Write a reducer that folds one message into the state:

```ts
// prices.ts
import { createWebSocket, createWebSocketState } from 'react-websocket';

type Tick = { symbol: string; price: number };

export const prices = createWebSocket<Tick>('wss://api.example.com/prices', { json: true });

export const priceState = createWebSocketState(prices, {
  initialState: {} as Record<string, number>,
  reduce: (state, tick) =>
    state[tick.symbol] === tick.price ? state : { ...state, [tick.symbol]: tick.price }
});
```

The message type comes from the client, so `tick` is a `Tick`. Return the **same** state object to ignore a message. Nothing re-renders.

## Reading it

```tsx
import { useWebSocketState } from 'react-websocket';
import { priceState } from './prices';

function Price({ symbol }: { symbol: string }) {
  const price = useWebSocketState(priceState, state => state[symbol]);
  return <p>{symbol}: {price ?? '—'}</p>;
}
```

With 500 symbols streaming, each `<Price>` re-renders only when its own symbol's price changes. `useWebSocket` would re-render every component on every message.

Without a selector, you get the whole state:

```tsx
const all = useWebSocketState(priceState);
```

### Selectors that build objects

A selector may return a new object or array. Pass an equality function so equal results don't re-render:

```tsx
const shallow = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

const symbols = useWebSocketState(priceState, state => Object.keys(state).sort(), shallow);
```

Without `isEqual`, `Object.is` is used. That's right for selectors returning primitives or existing objects, such as `state => state.ACME`.

## Lifecycle

- **Listening.** The store listens from the moment it's created, so state keeps building while any component holds the connection, even if nothing reads the store at that moment.
- **Connection.** The store doesn't open the connection by itself. `useWebSocketState` holds it while mounted, like the other hooks.
- **Reconnects.** State is kept across reconnects. If your server sends a full snapshot after connecting, reset first:

  ```ts
  prices.on('open', () => priceState.reset());
  ```

- **Server rendering.** On the server and during hydration, `useWebSocketState` reads `initialState`, so the HTML and the first client render match.

## Writing to it

`setState` updates the state directly, for example for optimistic UI:

```ts
priceState.setState(state => ({ ...state, ACME: 101 }));
```

`reset()` returns to `initialState`.

## Combining with topics

Topics decide **what** the server sends, and state decides **where it goes**:

```tsx
import {
  createWebSocket,
  createWebSocketState,
  createWebSocketTopics,
  useWebSocketState,
  useWebSocketTopic
} from 'react-websocket';

type In = { topic: string; price: number };
type Out = { type: 'subscribe' | 'unsubscribe'; topic: string };

const live = createWebSocket<In, Out>('wss://api.example.com/live', { json: true });

export const topics = createWebSocketTopics(live, {
  subscribe: topic => ({ type: 'subscribe', topic }),
  unsubscribe: topic => ({ type: 'unsubscribe', topic })
});

export const latest = createWebSocketState(live, {
  initialState: {} as Record<string, number>,
  reduce: (state, m) => ({ ...state, [m.topic]: m.price })
});

export function Price({ symbol }: { symbol: string }) {
  const topic = `prices:${symbol}`;
  useWebSocketTopic(topics, topic);
  const price = useWebSocketState(latest, state => state[topic]);
  return <p>{symbol}: {price ?? '—'}</p>;
}
```

## Compared with Zustand or Redux

`createWebSocketState` covers state that comes **from the socket**. Keep using Zustand or Redux for app state, and for socket data that many unrelated actions also change. Both approaches are shown in [Without React](./without-react.md#zustand).

## Caveats

- **Pure reducers.** The reducer must be pure and return new objects for changes. Mutating `state` in place won't re-render anything.
- **Errors.** If the reducer throws, the state is left unchanged and the error is re-thrown asynchronously, so it reaches your error reporting.
- **Function state.** Don't make the state itself a function, because `setState` treats functions as updaters.
- **Dynamic stores.** Create stores at module level. If you create one dynamically, call `dispose()` when you're done with it.

## See also

- [`createWebSocketState`](../api/create-websocket-state.md) and [`useWebSocketState`](../api/use-websocket-state.md)
- [Topic subscriptions](./topics.md)
- [Performance](./performance.md)
