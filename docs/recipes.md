---
title: 'React WebSocket recipes and real-world guides'
description: 'Framework recipes for Next.js, Astro, Remix, Hono and Tornado, real-world guides that build whole real-time apps in React, client and server, and short patterns: message routing, request/response, acknowledged publishes, presence and typing indicators, polling, optimistic sends, logging.'
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

A chat room with a Hono server on Node.js, a Vite and React client, message types both sides import, and a bot in Node.

`upgradeWebSocket`&nbsp;· Vite proxy&nbsp;· `createWebSocketState`&nbsp;· `createWebSocketRequests`&nbsp;· `migrate()`&nbsp;· `heartbeat`

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

## Publishing with an acknowledgement

`send()` returns once the message is handed to the socket or queued. It can't tell you whether the server received the message, or whether it accepted it. Pub/sub clients such as Faye return a promise from `publish()` that settles when the server answers. [`createWebSocketRequests`](./api/create-websocket-requests.md) gives you the same promise: the server answers each publish with its id, and the promise resolves on that answer, or rejects on a refusal, a timeout or a lost connection.

```ts
// live.ts
import { createWebSocket, createWebSocketRequests } from 'react-websocket';

type LiveIn =
  | { type: 'event'; topic: string; data: unknown }
  | { type: 'published'; id: number }
  | { type: 'refused'; id: number; reason: string };

type LiveOut =
  | { type: 'subscribe' | 'unsubscribe'; topic: string }
  | { type: 'publish'; id: number; key: string; topic: string; data: unknown };

/** A message to publish. `key` identifies it, so a retry isn't published twice. */
export type Publish = { key: string; topic: string; data: unknown };

/** The server said no, e.g. no permission for that topic. Sending it again won't help. */
export class PublishRefused extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'PublishRefused';
  }
}

export const live = createWebSocket<LiveIn, LiveOut>('wss://api.example.com/live', { json: true });

export const publishes = createWebSocketRequests(live, {
  send: (message: Publish, id) => ({ type: 'publish', id, ...message }),
  reply: message => (message.type === 'event' ? undefined : message.id),
  error: message => (message.type === 'refused' ? new PublishRefused(message.reason) : undefined),
  timeout: 15_000
});
```

Every publish carries two identifiers. `id` belongs to the request: the library generates a new one on every call, so the answer finds its promise. `key` is yours: keep it when you retry, and the server publishes each key once.

```tsx
// Composer.tsx
import { useState } from 'react';
import { PublishRefused, publishes } from './live';

type Post = {
  key: string;
  text: string;
  state: 'sending' | 'sent' | 'refused' | 'unconfirmed';
  reason?: string;
};

export function Composer({ room }: { room: string }) {
  const [text, setText] = useState('');
  const [post, setPost] = useState<Post>();

  // A retry passes the same key, so the server won't publish the message twice.
  async function submit(text: string, key: string = crypto.randomUUID()) {
    setPost({ key, text, state: 'sending' });
    try {
      await publishes.request({ key, topic: `room:${room}`, data: { text } });
      setPost({ key, text, state: 'sent' });
    } catch (error) {
      if (error instanceof PublishRefused) {
        setPost({ key, text, state: 'refused', reason: error.message });
      } else {
        setPost({ key, text, state: 'unconfirmed' });
      }
    }
  }

  return (
    <>
      <form
        onSubmit={event => {
          event.preventDefault();
          submit(text);
          setText('');
        }}
      >
        <input value={text} onChange={event => setText(event.target.value)} />
        <button disabled={!text || post?.state === 'sending'}>Send</button>
      </form>
      {post?.state === 'sending' && <p role="status">Sending…</p>}
      {post?.state === 'sent' && <p role="status">Sent</p>}
      {post?.state === 'refused' && <p role="alert">Not sent: {post.reason}</p>}
      {post?.state === 'unconfirmed' && (
        <p role="alert">
          No answer from the server.{' '}
          <button onClick={() => submit(post.text, post.key)}>Try again</button>
        </p>
      )}
    </>
  );
}
```

What a failure means:

- **Refused.** The server got the message and said no, and `error` turned its answer into a `PublishRefused`. Show the reason. Sending it again gets the same answer.
- **Anything else.** A `TimeoutError`, a lost connection, or a request dropped from the send queue. The server may have published the message or not, so it's unconfirmed. Retrying with the same `key` is safe either way.
- **Lost connections fail at once.** An answer can only arrive on the connection the publish went out on, so when that connection closes, the promise rejects right away instead of waiting for `timeout`.
- **Offline.** A publish made while disconnected waits in the send queue and goes out on the next connection. Its `timeout` counts from the call, so pick one that covers a reconnect, or pass `{ volatile: true }` as the second argument of `request()` to fail at once instead.
- **Acknowledged isn't received.** The answer means the server accepted the message and handed it out, not that every subscriber has it. Subscribers that were offline catch up through [numbered feeds](./guide/topics.md#numbered-feeds).

On the server, answer every publish with its `id`: `refused` when it isn't allowed, `published` once it's handed out. Publish each `key` once, and answer a repeat with `published` again so the client's retry resolves:

```ts
// server.ts, with the `ws` package
import { WebSocketServer } from 'ws';
import { broadcast, mayPublish } from './topics'; // your own rules and fan-out

type Publish = { type: 'publish'; id: number; key: string; topic: string; data: unknown };

/** A publish message, if it has the fields it needs. */
function parse(data: string): Publish | undefined {
  try {
    const message = JSON.parse(data);
    if (
      message?.type === 'publish' &&
      Number.isInteger(message.id) &&
      typeof message.key === 'string' &&
      typeof message.topic === 'string'
    )
      return message;
  } catch {
    // Not JSON.
  }
  return undefined;
}

// Keys already published. A database table with an expiry in production.
const published = new Set<string>();

const wss = new WebSocketServer({ port: 8080 });

wss.on('connection', socket => {
  socket.on('error', console.error);
  socket.on('message', data => {
    const message = parse(String(data));
    if (!message) return socket.close(1003, 'Invalid message');
    const { id, key, topic } = message;
    if (!mayPublish(socket, topic)) {
      socket.send(JSON.stringify({ type: 'refused', id, reason: 'Not allowed in this room' }));
      return;
    }
    if (!published.has(key)) {
      published.add(key);
      broadcast(topic, message.data);
    }
    socket.send(JSON.stringify({ type: 'published', id }));
  });
});
```

A request lives in memory: a reload loses it, and nothing retries it for you. For messages that must arrive, such as an order, use the [offline outbox](./guide/outbox.md) instead. It keeps each message in IndexedDB and sends it again on every new connection until the server acknowledges it. It has no promise per message, though, and no refusal: the server acknowledges everything it has handled, allowed or not, or the outbox would send a refused message forever. Report a refusal in a message of its own.

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

To await the server's answer as a promise instead, with refusals and retries, see [Publishing with an acknowledgement](#publishing-with-an-acknowledgement).

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
