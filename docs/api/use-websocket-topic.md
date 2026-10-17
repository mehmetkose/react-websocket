# useWebSocketTopic

Hold one or more topic subscriptions while the component is mounted.

```ts
function useWebSocketTopic(
  topics: WebSocketTopics | null | undefined,
  topic: string | readonly string[] | null | undefined
): void;
```

## Usage

```tsx
import { useWebSocketTopic } from 'react-websocket';
import { topics } from './live';

function Ticker({ symbol }: { symbol: string }) {
  useWebSocketTopic(topics, `prices:${symbol}`);
  // …
}

function Watchlist({ symbols }: { symbols: string[] }) {
  useWebSocketTopic(
    topics,
    symbols.map(s => `prices:${s}`)
  );
  // …
}
```

## Parameters

| Parameter | Type | |
| --- | --- | --- |
| `topics` | `WebSocketTopics \| null \| undefined` | From [`createWebSocketTopics`](./create-websocket-topics.md) |
| `topic` | `string \| string[] \| null \| undefined` | The topic or topics to hold. `null` holds nothing |

## Behavior

- **Shared.** Components holding the same topic share one subscription.
- **Follows changes.** Changing `topic` subscribes to the new one and unsubscribes from the old one. A new array with the same topics changes nothing.
- **StrictMode-safe.** StrictMode's double mount doesn't send an extra `unsubscribe`/`subscribe` pair.
- **Holds the connection** while mounted.
