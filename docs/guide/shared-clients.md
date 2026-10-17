# Shared clients

A client is one WebSocket connection that any number of components can use. This page covers the two ways to share one, how the connection's lifetime is managed, and when to pick which.

## Two ways to share

### By URL

Every `useWebSocket(url)` call with the same URL (and the same `protocols`) shares one connection:

```tsx
import { useWebSocket } from 'react-websocket';

function Ticker() {
  const { lastMessage } = useWebSocket<string>('wss://api.example.com/prices');
  return <p>{lastMessage ?? '…'}</p>;
}

function Status() {
  const { status } = useWebSocket('wss://api.example.com/prices'); // same socket
  return <small>{status}</small>;
}
```

The connection's options come from **whichever component created it first**. Later hooks with the same URL reuse it as-is, and their connection options (`json`, `reconnect`, `schema`, …) are ignored. Their handlers (`onMessage`, `onOpen`, …) and `enabled` still apply. If two parts of your app need different options for the same URL, use a module-level client.

### With a module-level client

`createWebSocket` defines a connection once, outside any component. Import it wherever you need it:

```ts
// chat.ts
import { createWebSocket } from 'react-websocket';

export type ChatIn = { user: string; text: string };
export type ChatOut = { text: string };

export const chat = createWebSocket<ChatIn, ChatOut>('wss://api.example.com/chat', {
  json: true
});
```

Creating it doesn't connect. It connects when a hook first uses it.

Three hooks accept a client:

```tsx
import { useState } from 'react';
import { useWebSocket, useWebSocketEvent, useWebSocketStatus } from 'react-websocket';
import { chat, type ChatIn } from './chat';

// Re-renders on status changes and on every message.
function LastMessage() {
  const { lastMessage, status, send } = useWebSocket(chat);
  return (
    <p>
      {lastMessage?.text ?? '—'} ({status})
      <button onClick={() => send({ text: 'hi' })}>Say hi</button>
    </p>
  );
}

// Listens without re-rendering on each message; you decide what to store.
function Messages() {
  const [messages, setMessages] = useState<ChatIn[]>([]);
  useWebSocketEvent(chat, 'message', message => setMessages(list => [...list, message]));
  return (
    <ul>
      {messages.map((m, i) => (
        <li key={i}>
          {m.user}: {m.text}
        </li>
      ))}
    </ul>
  );
}

// Re-renders only when the status changes.
function ConnectionDot() {
  const status = useWebSocketStatus(chat);
  return <span className={`dot dot-${status}`} />;
}
```

With a client, `useWebSocket(chat, handlers)` accepts only handlers (`onOpen`, `onMessage`, `onClose`, `onError`) and `enabled`. Connection options belong to `createWebSocket`.

You can also call the client directly from anywhere, including event handlers and non-React code:

```ts
chat.send({ text: 'hello' }); // sends now, or queues until open
```

## Connection lifetime

Clients are reference-counted. You rarely need to open or close them yourself.

- **Opens** when the first hook using it mounts, or when something reads [`client.ready`](./suspense.md).
- **Stays open** while at least one mounted hook holds it.
- **Closes one tick after** the last hook unmounts, and its status goes back to `idle`. The delay is why StrictMode's mount → unmount → mount and route transitions reuse the socket instead of reconnecting. See [StrictMode, Activity and lifecycle](./lifecycle.md).

A hook with `enabled: false`, or `useWebSocket(null)`, doesn't hold the connection.

:::tip URL clients are forgotten when unused
When the last hook for a URL releases it, that URL's client is discarded. The next hook for that URL starts a fresh client, so `lastMessage` starts out `undefined` again. A module-level client is never discarded and keeps its `lastMessage`.
:::

### Keeping a connection open with `connect()`

Call `client.connect()` to keep a connection open even when no component is using it, for example to receive notifications for the whole session:

```ts
import { chat } from './chat';

chat.connect(); // stays open, independent of hooks, until close()
```

A connection started with `connect()` survives every hook unmounting. `close()` ends it and returns the client to reference counting.

### Holding a connection from non-React code

`client.acquire()` is what the hooks use under the hood. It returns a release function:

```ts
const release = chat.acquire(); // opens if idle
// …
release(); // closes a tick later if nothing else holds it
```

The release function is safe to call more than once.

### Closing and restarting

`client.close(code?, reason?)` closes the socket and stops reconnecting, for every component using it. The status becomes `closed`. Mounted hooks stay mounted but don't reopen it. To start again, call `connect()` or `reconnect()`. Once every hook unmounts, the client goes back to `idle`, and the next hook to mount opens it again.

## Which one should I use?

| | `useWebSocket(url)` | `createWebSocket(url)` + hooks |
| --- | --- | --- |
| Setup | None | One module-level definition |
| Sharing | Same URL + `protocols` | Same client object |
| Options | From the first component to mount | Defined once, in one place |
| URL changes | Follow props (``useWebSocket(`…/rooms/${id}`)``) | Fixed, or a function evaluated per attempt |
| `lastMessage` after everyone unmounts | Reset | Kept |
| Use outside components (`send`, `ready`, `on`) | Through the returned `client` | Directly |
| Typed `send`/`lastMessage` | Generics at each call site | Declared once |

A good rule: start with `useWebSocket(url)` for a connection used by one component. Once two components share it, or you need it in non-React code, move it to `createWebSocket`.

## See also

- [`createWebSocket`](../api/create-websocket.md) and the [`WebSocketClient`](../api/types.md#websocketclient) interface
- [`useWebSocketEvent`](../api/use-websocket-event.md) and [`useWebSocketStatus`](../api/use-websocket-status.md)
- [Performance](./performance.md) for high-frequency streams
