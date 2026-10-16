# useWebSocketEvent

Listen to a client's events without re-rendering the component.

```ts
function useWebSocketEvent<In, K extends keyof EventMap<In>>(
  client: WebSocketClient<In, any> | null | undefined,
  type: K,
  listener: EventMap<In>[K]
): void;
```

## Usage

```tsx
import { useState } from 'react';
import { useWebSocketEvent } from 'react-websocket';
import { chat } from './chat';

function Messages() {
  const [messages, setMessages] = useState<ChatIn[]>([]);
  useWebSocketEvent(chat, 'message', message => setMessages(list => [...list, message]));
  return (
    <ul>
      {messages.map((m, i) => (
        <li key={i}>{m.text}</li>
      ))}
    </ul>
  );
}
```

## Parameters

| Parameter | Type | |
| --- | --- | --- |
| `client` | `WebSocketClient \| null \| undefined` | The client to listen to. `null` does nothing |
| `type` | `'open' \| 'message' \| 'close' \| 'error'` | The event |
| `listener` | `EventMap<In>[type]` | Called for each event. See [`EventMap`](./types.md#eventmap) |

| `type` | Listener signature |
| --- | --- |
| `'open'` | `(event: Event) => void` |
| `'message'` | `(message: In, event: MessageEvent) => void` |
| `'close'` | `(close: CloseInfo) => void` |
| `'error'` | `(error: Event \| MessageError \| Error) => void` |

## Behavior

- **No re-renders.** The hook never causes a render itself. Your listener decides whether to update state.
- **Latest listener.** The listener always sees the latest props and state. Changing it doesn't resubscribe or reconnect.
- **Holds the connection.** While mounted, the component keeps the client connected, just like `useWebSocket`.
- **One subscription per call.** Call the hook once per event type you need.

## Tips

- Combine it with [`useWebSocketStatus`](./use-websocket-status.md) for a component that shows status and handles messages, without re-rendering per message.
- For very high message rates, buffer messages in a ref and flush them to state once per animation frame. See [Performance](../guide/performance.md).
