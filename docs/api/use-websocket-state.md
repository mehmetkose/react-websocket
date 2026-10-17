# useWebSocketState

Read state built by [`createWebSocketState`](./create-websocket-state.md). Re-renders only when the selected value changes.

```ts
function useWebSocketState<S>(store: WebSocketState<S>): S;
function useWebSocketState<S, T>(
  store: WebSocketState<S>,
  selector: (state: S) => T,
  isEqual?: (a: T, b: T) => boolean
): T;
```

## Usage

```tsx
import { useWebSocketState } from 'react-websocket';
import { priceState } from './prices';

function Price({ symbol }: { symbol: string }) {
  const price = useWebSocketState(priceState, state => state[symbol]);
  return <p>{price ?? '—'}</p>;
}
```

## Parameters

| Parameter | Type | |
| --- | --- | --- |
| `store` | `WebSocketState<S>` | From `createWebSocketState` |
| `selector` | `(state: S) => T` | Picks what this component needs. Default: the whole state. May depend on props |
| `isEqual` | `(a: T, b: T) => boolean` | When it returns `true`, the previous value is kept and nothing re-renders. Default: `Object.is` |

## Returns

The selected value.

## Behavior

- **Renders.** It re-renders when the selected value changes, not on every message or on every change to other parts of the state.
- **Inline selectors.** Inline selectors are fine. If one returns a new object or array, pass an `isEqual` such as a shallow comparison.
- **Connection.** It holds the store's client connection while mounted, like the other hooks.
- **Server rendering.** On the server and during hydration, it selects from `initialState`.
