# useWebSocketStatus

Read a client's connection status. Re-renders only when the status changes.

```ts
function useWebSocketStatus(client: WebSocketClient<any, any> | null | undefined): Status;
```

## Usage

```tsx
import { useWebSocketStatus } from 'react-websocket';
import { chat } from './chat';

const labels = {
  idle: 'Offline',
  connecting: 'Connecting…',
  open: 'Online',
  reconnecting: 'Reconnecting…',
  closed: 'Disconnected'
} as const;

function ConnectionBadge() {
  const status = useWebSocketStatus(chat);
  return <span data-status={status}>{labels[status]}</span>;
}
```

## Parameters

| Parameter | Type | |
| --- | --- | --- |
| `client` | `WebSocketClient \| null \| undefined` | The client. `null` returns `'idle'` |

## Returns

A [`Status`](./types.md#status): `'idle'`, `'connecting'`, `'open'`, `'reconnecting'` or `'closed'`.

## Behavior

- **Status only.** Messages and `attempt` changes don't re-render. Use [`useWebSocket(client)`](./use-websocket.md) if you also need `attempt` or `lastMessage`.
- **Holds the connection.** While mounted, the component keeps the client connected.
- **Server rendering.** Returns `'idle'` on the server and during hydration.
