---
title: 'React WebSocket performance'
description: 'What re-renders when WebSocket messages arrive, how to batch high-frequency streams in React, and what react-websocket costs in bundle size.'
---

# Performance

This page explains when components re-render, how to handle high-frequency streams, and what the library costs in bundle size.

## What re-renders when

| Hook | Re-renders on |
| --- | --- |
| [`useWebSocket`](../api/use-websocket.md) | Every status change **and every message** (`lastMessage` changes) |
| [`useWebSocketStatus`](../api/use-websocket-status.md) | Status changes only |
| [`useWebSocketEvent`](../api/use-websocket-event.md) | Never. It calls your listener instead |
| [`useWebSocketState`](../api/use-websocket-state.md) | Only when its selected value changes |

`useWebSocket` is the convenient choice for chat, notifications and other streams of a few messages per second. For market data, telemetry, cursors or anything that can send dozens of messages per second, split the work:

- `useWebSocketStatus(client)` for the connection indicator.
- `useWebSocketEvent(client, 'message', listener)` to receive messages without rendering, and update state on your own schedule.
- Or reduce messages into a store with [`createWebSocketState`](./state.md), and let each component select only its slice with `useWebSocketState`. With 500 symbols streaming, a `<Price symbol="ACME" />` re-renders only when ACME changes.

## Batching a fast stream

React already batches state updates made in the same task, but each WebSocket message is its own task, so every message is a render. Reduce the stream into a store with `batch: 'frame'`, and its readers render at most once per animation frame:

```tsx
import { createWebSocket, createWebSocketState, useWebSocketState } from 'react-websocket';

type Tick = { symbol: string; price: number };

const ticks = createWebSocket<Tick>('wss://api.example.com/ticks', { json: true });

const prices = createWebSocketState(ticks, {
  initialState: {} as Record<string, number>,
  reduce: (state, tick) => ({ ...state, [tick.symbol]: tick.price }),
  batch: 'frame'
});

export function Prices() {
  const all = useWebSocketState(prices);
  return (
    <ul>
      {Object.entries(all).map(([symbol, price]) => (
        <li key={symbol}>
          {symbol}: {price}
        </li>
      ))}
    </ul>
  );
}
```

A few things to note:

- Messages are still reduced as they arrive, so `prices.getState()` is always current. Only the renders wait for the frame.
- Browsers pause animation frames in background tabs. The store keeps up, and the list renders the latest prices when the tab is visible again.
- To throttle further, say to four renders a second, buffer in a [`useWebSocketEvent`](../api/use-websocket-event.md) listener and flush with `setTimeout(…, 250)`.
- If you only need the latest value and never render it (say, to send it with the next order), keep it in a ref and skip state entirely.

## Expensive derived UI

When a message triggers expensive rendering (a big chart, a filtered table), keep the input responsive by marking that work as non-urgent.

Wrap the state update in `startTransition`:

```tsx
import { startTransition, useState } from 'react';

useWebSocketEvent(feed, 'message', rows => {
  startTransition(() => setRows(rows));
});
```

Or defer the expensive child with `useDeferredValue`:

```tsx
import { useDeferredValue } from 'react';

const { lastMessage } = useWebSocket(feed);
const deferred = useDeferredValue(lastMessage);
return <BigChart data={deferred} />; // wrap BigChart in memo()
```

Keep updates that must feel instant, like a connection indicator or the message the user just sent, outside of transitions.

## React Compiler and memoization

The hooks are compatible with the [React Compiler](https://react.dev/learn/react-compiler) and with hand-written memoization:

- **Handlers don't need `useCallback`.** `onMessage`, `onOpen`, `onClose`, `onError` and `useWebSocketEvent` listeners always see your latest props and state, and passing a new function never reconnects.
- **The options object doesn't need `useMemo`.** For URL hooks, connection options are read once, when the shared client is created.
- **Returned actions are stable.** `send`, `close` and `reconnect` from `useWebSocket` keep the same identity across renders, so you can pass them to memoized children or list them in effect dependencies.
- **Snapshots are immutable.** `getSnapshot()` returns the same object until something changes, as `useSyncExternalStore` requires.

## Bundle size

| Entry | Import | Size (min + gzip) |
| --- | --- | --- |
| `react-websocket` | `useWebSocket` | ~3.7 kB |
| `react-websocket/core` | `createWebSocket` | ~3.3 kB |

Sizes are measured by [size-limit](https://github.com/ai/size-limit) in CI, with budgets that fail the build if they grow. React is a peer dependency and not counted.

- **Zero dependencies.** Nothing else is installed with the package.
- **Tree-shakeable.** The package is marked `"sideEffects": false` and ships ES modules, so bundlers drop what you don't import.
- **`react-websocket/core`** has no React import at all; see [Without React](./without-react.md).
