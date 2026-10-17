---
description: 'useWebSocketPresence: render the other peers from createWebSocketPresence, such as live cursors, as they move, leave or time out.'
---

# useWebSocketPresence

The other peers from [`createWebSocketPresence`](./create-websocket-presence.md), such as their cursors. Re-renders when a peer's state arrives, it leaves, or it times out.

```ts
function useWebSocketPresence<P>(presence: WebSocketPresence<P> | null | undefined): readonly PresencePeer<P>[];
```

## Usage

```tsx
import { useWebSocketPresence } from 'react-websocket';
import { cursors } from './cursors';

function Cursors() {
  const peers = useWebSocketPresence(cursors);
  return peers.map(({ peer, state }) => <Cursor key={peer} x={state.x} y={state.y} />);
}
```

## Returns

`{ peer, state, updatedAt }[]`, in the order the peers first appeared. The same array until something changes. Empty for `null`, and on the server.

## Behavior

- **Holds the connection** while mounted, like `useWebSocket`.
- **Re-renders** on every update from another peer, which `maxRate` on their side keeps to a handful per second each.
