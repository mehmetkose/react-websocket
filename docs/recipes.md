# Recipes

Patterns for common real-time features. Each one is self-contained; copy what you need.

[[toc]]

## Many message types on one socket

Pub/sub topics, Django Channels groups and similar features all deliver different kinds of message over the same socket. Tag each message on the server with a discriminant field, type it as a union, and route on the client:

```tsx
import { useState } from 'react';
import { createWebSocket, useWebSocketEvent } from 'react-websocket';

type LiveEvent =
  | { group: 'prices'; symbol: string; price: number }
  | { group: 'chat'; user: string; text: string }
  | { group: 'presence'; online: string[] };

export const live = createWebSocket<LiveEvent>('wss://api.example.com/ws', { json: true });

function ChatLog() {
  const [lines, setLines] = useState<string[]>([]);
  useWebSocketEvent(live, 'message', event => {
    // TypeScript narrows `event` from the `group` check.
    if (event.group === 'chat') setLines(list => [...list, `${event.user}: ${event.text}`]);
  });
  return (
    <ul>
      {lines.map((line, i) => (
        <li key={i}>{line}</li>
      ))}
    </ul>
  );
}
```

Each component listens for what it cares about, and they all share one connection. To validate the union at runtime, pass a [schema](./guide/messages.md).

## Request/response

WebSockets have no built-in replies. A common convention is to send an `id` with each request and have the server echo it in the reply. This helper wraps that in a promise with a timeout:

```ts
// rpc.ts
import { createWebSocket, type WebSocketClient } from 'react-websocket';

// Messages the server sends: replies carry the id of the request they answer.
type ServerMessage =
  | { type: 'reply'; id: string; result: unknown }
  | { type: 'failure'; id: string; error: string }
  | { type: 'event'; name: string; data: unknown };

type ClientMessage = { type: 'call'; id: string; method: string; params?: unknown };

export const api = createWebSocket<ServerMessage, ClientMessage>('wss://api.example.com/rpc', {
  json: true
});

export function request<Result>(
  client: WebSocketClient<ServerMessage, ClientMessage>,
  method: string,
  params?: unknown,
  { timeout = 10_000 }: { timeout?: number } = {}
): Promise<Result> {
  const id = crypto.randomUUID();
  return new Promise<Result>((resolve, reject) => {
    const off = client.on('message', message => {
      if (message.type === 'event' || message.id !== id) return;
      clearTimeout(timer);
      off();
      if (message.type === 'reply') resolve(message.result as Result);
      else reject(new Error(message.error));
    });
    const timer = setTimeout(() => {
      off();
      reject(new Error(`${method} timed out after ${timeout} ms`));
    }, timeout);
    client.send({ type: 'call', id, method, params });
  });
}
```

```ts
type User = { id: string; name: string };
const user = await request<User>(api, 'getUser', { id: '42' });
```

If the socket isn't open, the request is queued and sent on connect. The timer starts immediately, so pick a timeout that covers a reconnect. If the connection drops after the request was sent, the server may never reply; the timeout turns that into a rejection.

## Following a changing URL

With `useWebSocket(url)`, a new URL closes the old connection and opens the new one. Build the URL from state:

```tsx
function Room({ roomId }: { roomId: string }) {
  const { status, lastMessage } = useWebSocket<string>(
    `wss://api.example.com/rooms/${encodeURIComponent(roomId)}`
  );
  return (
    <p>
      {roomId} ({status}): {lastMessage}
    </p>
  );
}
```

Each distinct URL is its own shared connection. If the URL comes from a text field, debounce it so you don't connect on every keystroke.

To switch rooms on one connection instead, keep a single client and send `join`/`leave` messages from an effect:

```tsx
useEffect(() => {
  live.send({ type: 'join', roomId });
  return () => {
    live.send({ type: 'leave', roomId });
  };
}, [roomId]);
```

Sends made before the connection opens are queued, and the server should re-join rooms itself after a reconnect, or you can re-send `join` from an `open` listener.

## Presence and typing indicators

Send typing events at most every couple of seconds, and keep the list of who's typing in state:

```tsx
import { useRef, useState } from 'react';
import { createWebSocket, useWebSocketEvent } from 'react-websocket';

type In = { type: 'typing'; user: string } | { type: 'message'; user: string; text: string };
type Out = { type: 'typing' } | { type: 'message'; text: string };

const chat = createWebSocket<In, Out>('wss://api.example.com/chat', { json: true });

export function Composer() {
  const [typing, setTyping] = useState<string[]>([]);
  const lastSent = useRef(0);

  useWebSocketEvent(chat, 'message', event => {
    if (event.type !== 'typing') return;
    setTyping(users => (users.includes(event.user) ? users : [...users, event.user]));
    setTimeout(() => setTyping(users => users.filter(u => u !== event.user)), 3000);
  });

  function onInput() {
    const now = Date.now();
    if (now - lastSent.current < 2000) return;
    lastSent.current = now;
    // Typing events are only useful live: don't queue them while disconnected.
    if (chat.getSnapshot().status === 'open') chat.send({ type: 'typing' });
  }

  return (
    <>
      <textarea onInput={onInput} />
      {typing.length > 0 && <p>{typing.join(', ')} typing…</p>}
    </>
  );
}
```

## Polling over a socket

The server decides when to push. If you need to ask on an interval, call `send` from your own timer:

```tsx
import { useEffect } from 'react';
import { useWebSocket } from 'react-websocket';

function Stats() {
  const { lastMessage, send, status } = useWebSocket<{ load: number }, { type: 'stats' }>(
    'wss://api.example.com/stats',
    { json: true }
  );

  useEffect(() => {
    if (status !== 'open') return; // don't pile up queued polls while offline
    send({ type: 'stats' });
    const id = setInterval(() => send({ type: 'stats' }), 5000);
    return () => clearInterval(id);
  }, [status, send]);

  return <p>Load: {lastMessage?.load ?? '…'}</p>;
}
```

## Optimistic sends

`send()` never throws for a disconnected socket: it queues the message and returns `false`. Show the message immediately, mark whether it actually went out, and confirm it when the server echoes it back:

```tsx
// Assumes the server acks each message: In includes { type: 'ack'; id: string },
// Out includes { type: 'message'; id: string; text: string }.
type Pending = { id: string; text: string; state: 'sent' | 'queued' | 'confirmed' };

function onSubmit(text: string) {
  const id = crypto.randomUUID();
  const sentNow = chat.send({ type: 'message', id, text });
  setMessages(list => [...list, { id, text, state: sentNow ? 'sent' : 'queued' }]);
}

useWebSocketEvent(chat, 'message', event => {
  if (event.type === 'ack') {
    setMessages(list => list.map(m => (m.id === event.id ? { ...m, state: 'confirmed' } : m)));
  }
});
```

Queued messages go out in order when the connection opens. To bound memory during a long outage, set [`queue: { limit }`](./api/options.md#queue). `close()` and giving up both clear the queue, so messages still marked `queued` at that point were never sent.

## Pausing a connection

`enabled: false` releases a component's hold on the connection. When no other component holds it, it closes; `enabled: true` connects again:

```tsx
function Ticker({ paused }: { paused: boolean }) {
  const { status, lastMessage } = useWebSocket<string>('wss://api.example.com/ticker', {
    enabled: !paused
  });
  return <p>{paused ? 'Paused' : `${status}: ${lastMessage ?? '…'}`}</p>;
}
```

A `null` URL works the same way: `useWebSocket(isLoggedIn ? url : null)`.

Content hidden by React's [`<Activity>`](./guide/lifecycle.md) releases its connections automatically.

## Logging and telemetry

The `logger` option receives the client's debug messages: connection attempts, retry delays, heartbeat timeouts and dropped messages. Route it to your telemetry, and listen to events for structured data:

```ts
import { createWebSocket, MessageError } from 'react-websocket';
import { telemetry } from './telemetry';

export const live = createWebSocket('wss://api.example.com/live', {
  json: true,
  logger: (message, ...details) => telemetry.debug(`[ws] ${message}`, details)
});

live.on('close', ({ code, reason, wasClean }) => {
  if (!wasClean) telemetry.warn('ws.close', { code, reason });
});

live.on('error', error => {
  if (error instanceof MessageError) telemetry.error('ws.bad_message', { data: error.data, issues: error.issues });
});

live.subscribe(() => {
  const { status, attempt } = live.getSnapshot();
  if (status === 'reconnecting') telemetry.count('ws.reconnect', { attempt });
});
```

In development, `logger: console.debug` is often all you need.

## Hook URL or shared client?

| | `useWebSocket(url)` | `createWebSocket()` + hooks |
| --- | --- | --- |
| Setup | Inline in a component | One module-level definition |
| Sharing | Components using the same URL share one socket | Explicit: everything importing the client shares it |
| Options | From whichever component created it first | Defined once, with the client |
| URL from props/state | Natural: change the URL to switch | Create one client per URL, or send join/leave messages |
| Auth token per attempt | Not available (string URLs only) | `url` can be a function |
| Use outside React | No | Yes: `send`, `on`, `ready` work anywhere |

Start with `useWebSocket(url)` for a socket used by one component. Move to a [shared client](./guide/shared-clients.md) when several components, non-React code, or a URL function are involved.
