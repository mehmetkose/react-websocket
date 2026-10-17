---
description: 'useWebSocketOutbox: the messages waiting in a react-websocket outbox, for a "3 orders waiting to sync" banner that updates as the server acknowledges them.'
---

# useWebSocketOutbox

The messages waiting in an [outbox](./create-websocket-outbox.md), oldest first. Re-renders when they change.

```ts
function useWebSocketOutbox<M>(outbox: WebSocketOutbox<M> | null | undefined): readonly OutboxEntry<M>[];
```

## Usage

```tsx
import { useWebSocketOutbox } from 'react-websocket';
import { orders } from './orders';

function SyncBanner() {
  const waiting = useWebSocketOutbox(orders);
  if (!waiting.length) return null;
  const sending = waiting.filter(entry => entry.sent).length;
  return (
    <p role="status">
      {waiting.length} orders waiting to sync{sending ? `, ${sending} sent` : ''}
    </p>
  );
}
```

## Parameters

| Parameter | Type | |
| --- | --- | --- |
| `outbox` | `WebSocketOutbox<M> \| null \| undefined` | From [`createWebSocketOutbox`](./create-websocket-outbox.md). `null` or `undefined` lists nothing |

## Returns

The waiting [`OutboxEntry<M>`](./create-websocket-outbox.md#outboxentry)s: `id`, `message`, `createdAt`, and `sent`, which is `true` while an entry has been sent on the current connection and waits for the server's acknowledgement.

## Behavior

- **Doesn't hold the connection.** The outbox itself holds it while anything is waiting.
- **Server rendering.** The list is empty on the server and during hydration, then shows the stored entries once they're loaded.
- **Stable.** The same array is returned until something changes, so it's safe in effect dependencies.
