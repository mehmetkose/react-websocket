---
title: 'React WebSocket recipes and real-world guides'
description: 'Framework recipes for Next.js, Astro, Remix, Hono and Tornado, real-world guides that build whole real-time apps in React, client and server, and short patterns: message routing, request/response, presence and typing indicators, polling, optimistic sends, logging.'
---

# Recipes

Three kinds of page live here. The framework recipes show how to set react-websocket up in the framework or server you already use. The real-world guides build a whole app, client and server, and show what happens when the network misbehaves. The patterns at the end are short and self-contained: copy what you need.

## Frameworks

Each recipe follows one of the repository's [examples](https://github.com/mehmetkose/react-websocket/tree/main/examples), so you can run what you read: where the client goes, where the WebSocket server goes, and the catches particular to that framework.

<div className="rws-guides rp-toc-exclude">

<section>

#### [Next.js](./recipes/nextjs.md)

Hooks in Client Components, a client that Server Components can import, Suspense for the first connection, and a custom server for the socket.

`'use client'`&nbsp;· `react-websocket/core`&nbsp;· custom server&nbsp;· `browser()`

</section>

<section>

#### [Astro](./recipes/astro.md)

Islands that share one connection, state for islands that hydrate late, and a connection that survives page changes.

`client:visible`&nbsp;· `client:only`&nbsp;· `<ClientRouter />`&nbsp;· `transition:persist`

</section>

<section>

#### [Remix 3](./recipes/remix.md)

No React needed: the client from `core`, small bindings that stand in for the hooks, and client entries on one socket.

`react-websocket/core`&nbsp;· bindings&nbsp;· `clientEntry`&nbsp;· `queueTask`

</section>

<section>

#### [Hono](./recipes/hono.md)

A chat room with a Hono server on Node.js, a Vite and React client, and message types both sides import.

`upgradeWebSocket`&nbsp;· Vite proxy&nbsp;· `createWebSocketState`&nbsp;· `heartbeat`

</section>

<section>

#### [Tornado (Python)](./recipes/tornado.md)

A broadcast chat with a Python server run by uv: origin checks, pings that drop dead connections, and a heartbeat for the browser.

`WebSocketHandler`&nbsp;· `check_origin`&nbsp;· `websocket_ping_interval`&nbsp;· uv

</section>

</div>

## Real-world guides

Each guide's code is complete and type-checked against the library, and was run in Chrome against its server, with stand-ins for third-party APIs where a guide uses one.

### AI apps

<div className="rws-guides rp-toc-exclude">

<section>

#### [AI chatbot](./recipes/ai-chatbot.md)

Streamed answers that survive reconnects and reloads, a Stop button that stops the model, and tools the user approves. The server calls Claude.

`createWebSocketRuns`&nbsp;· `useAgentRun`&nbsp;· `createWebSocketResponder`&nbsp;· `useAgentApproval`

</section>

<section>

#### [AI image and video generator](./recipes/ai-media-generator.md)

A queue with live positions, progress and previews, jobs that carry on through reloads, and one gallery on every device.

`createWebSocketRuns`&nbsp;· `useAgentRun`&nbsp;· `createWebSocketState`&nbsp;· `heartbeat`

</section>

<section>

#### [Voice assistant and text to speech](./recipes/voice-assistant.md)

Microphone audio up, the answer down, interruptions cut back to what was heard, and narration that streams and downloads.

`volatile`&nbsp;· `maxBuffered`&nbsp;· `priority`&nbsp;· `createWebSocketRequests`

</section>

</div>

### Multiplayer games

<div className="rws-guides rp-toc-exclude">

<section>

#### [Multiplayer party game](./recipes/party-game.md)

A trivia host screen and phones: rooms with a join code, a countdown every screen agrees on, answers counted once, and phones that rejoin after they sleep.

`createWebSocketRequests`&nbsp;· `createWebSocketPresence`&nbsp;· `createWebSocketLatency`&nbsp;· `createWebSocketState`

</section>

<section>

#### [Real-time action game](./recipes/action-game.md)

The game example, file by file: a fixed-tick server, prediction and interpolation, an adaptive send rate and a 60 fps canvas.

`react-websocket/timeline`&nbsp;· `createWebSocketSendRate`&nbsp;· `createWebSocketLatency`&nbsp;· `react-websocket/chaos`

</section>

</div>

### Collaboration

<div className="rws-guides rp-toc-exclude">

<section>

#### [Team chat](./recipes/team-chat.md)

Channels where every message arrives once and in order, an outbox that survives reloads, unread counts on every device, and one connection for all tabs.

`createWebSocketFeeds`&nbsp;· `react-websocket/outbox`&nbsp;· `createWebSocketPresence`&nbsp;· `react-websocket/tabs`

</section>

<section>

#### [Collaborative whiteboard](./recipes/collaborative-whiteboard.md)

Live cursors, strokes others watch as you draw, a snapshot for late joiners, drawing offline, and notes merged by Yjs.

`createWebSocketPresence`&nbsp;· `createWebSocketSendRate`&nbsp;· `createWebSocketFeeds`&nbsp;· `react-websocket/outbox`

</section>

</div>

### Live data

<div className="rws-guides rp-toc-exclude">

<section>

#### [Trading dashboard](./recipes/trading-dashboard.md)

A 500-symbol watchlist that streams only the rows on screen and renders once per frame, an order book that stays exact through lost messages, and orders placed exactly once.

`createWebSocketTopics`&nbsp;· `createWebSocketFeeds`&nbsp;· `useInView`&nbsp;· `batch: 'frame'`

</section>

<section>

#### [Live notifications](./recipes/live-notifications.md)

One connection for every tab, an unread badge that resumes from the last notice after a reload, reads that survive going offline, and sign-out everywhere.

`react-websocket/tabs`&nbsp;· `createWebSocketFeeds`&nbsp;· `react-websocket/outbox`&nbsp;· `useWebSocketOutbox`

</section>

<section>

#### [Delivery tracking](./recipes/delivery-tracking.md)

A courier marker that glides between GPS fixes without React renders, an ETA on the server's clock, and proof of delivery that gets through a dead zone.

`react-websocket/timeline`&nbsp;· `createWebSocketLatency`&nbsp;· `createWebSocketSendRate`&nbsp;· `react-websocket/outbox`

</section>

</div>

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

To switch rooms on one connection instead, keep a single client and let [topic subscriptions](./guide/topics.md) send the `join`/`leave` messages:

```ts
// rooms.ts
import { createWebSocket, createWebSocketTopics } from 'react-websocket';

type RoomIn = { roomId: string; user: string; text: string };
type RoomOut = { type: 'join' | 'leave'; roomId: string };

export const rooms = createWebSocket<RoomIn, RoomOut>('wss://api.example.com/rooms', { json: true });

export const roomTopics = createWebSocketTopics(rooms, {
  subscribe: roomId => ({ type: 'join', roomId }),
  unsubscribe: roomId => ({ type: 'leave', roomId })
});
```

```tsx
import { useWebSocketTopic } from 'react-websocket';
import { roomTopics } from './rooms';

function Room({ roomId }: { roomId: string }) {
  useWebSocketTopic(roomTopics, roomId); // joins roomId, leaves the previous one
  // …
}
```

Calling `send` from an effect yourself gets two things wrong. The server forgets rooms when the connection drops, so nothing joins them again after a reconnect. And `send` queues while disconnected, so a `leave` for a room you switched away from while offline goes out after the reconnect, for a room the new connection never joined. Topics join every held room again each time the socket opens, and never queue `join` or `leave`.

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
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  useWebSocketEvent(chat, 'message', event => {
    if (event.type !== 'typing') return;
    const { user } = event;
    setTyping(users => (users.includes(user) ? users : [...users, user]));
    // Restart this user's timer, so an earlier timeout doesn't hide them while they're still typing.
    clearTimeout(timers.current.get(user));
    timers.current.set(
      user,
      setTimeout(() => {
        timers.current.delete(user);
        setTyping(users => users.filter(u => u !== user));
      }, 3000)
    );
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
| Options | From the first component to mount | Defined once, with the client |
| URL from props/state | Natural: change the URL to switch | Create one client per URL, or use [topics](./guide/topics.md) for join/leave |
| Auth token per attempt | Not available (string URLs only) | `url` can be a function |
| Use outside React | No | Yes: `send`, `on`, `ready` work anywhere |

Start with `useWebSocket(url)` for a socket used by one component. Move to a [shared client](./guide/shared-clients.md) when several components, non-React code, or a URL function are involved.
