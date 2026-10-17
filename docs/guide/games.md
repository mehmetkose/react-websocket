---
title: 'Real-time games with WebSockets and React'
description: 'Networking for browser games over WebSockets in React: input that isn''t replayed late, awaited requests, ping and server time, and rendering at 60 fps.'
---

# Real-time games

Browser games run into the same networking problems again and again: input replayed after a reconnect, hand-rolled request ids, ping displays, timers that disagree between players, and React rendering at 60 fps. This page covers the tools for each.

react-websocket stays protocol-agnostic. You describe your messages once and it handles the bookkeeping. Interpolation, prediction and rooms depend on your game's tick model, so they're left to you or to a game server framework.

## The setup

The examples on this page share one client:

```ts
// game.ts
import { createWebSocket } from 'react-websocket';

export type GameIn =
  | { type: 'state'; players: Record<string, { x: number; y: number }> }
  | { type: 'reply'; id: number; room?: string; error?: string }
  | { type: 'pong'; id: number; time: number };

export type GameOut =
  | { type: 'input'; dx: number; dy: number }
  | { type: 'aim'; angle: number }
  | { type: 'join'; room: string; id: number }
  | { type: 'ping'; id: number }
  | { type: 'resume'; session: string };

export const game = createWebSocket<GameIn, GameOut>('wss://game.example.com', { json: true });
```

## Input: don't replay stale messages

By default, `send()` while disconnected queues the message, and the queue is flushed when the socket opens. That's right for chat, but wrong for input. After a three-second drop, every buffered `move left` arrives at once and the player teleports.

Pass `volatile` for messages that are worthless once they're late:

```ts
game.send({ type: 'input', dx, dy }, { volatile: true });
```

A volatile message goes out immediately when the socket is open and is dropped otherwise. `send()` returns `false` when it was dropped.

For state where only the latest value matters, pass a `key` instead. While disconnected, sending again with the same key replaces the queued message, so only the newest one is sent on reconnect:

```ts
game.send({ type: 'aim', angle }, { key: 'aim' });
```

The replacement moves to the back of the queue, after anything you sent before it.

On a slow link, continuous input can also pile up while the socket is open: the browser buffers what it can't send yet, and every message waits behind the ones before it. Add `maxBuffered` to drop a message while more than that many bytes are already waiting, so the buffer drains instead of growing:

```ts
game.send({ type: 'input', dx, dy }, { volatile: true, maxBuffered: 4096 });
```

Use it for input sent every tick, where the next message replaces this one anyway. Don't use it for one-shot actions such as fire or jump, which must arrive.

| Message | Use |
| --- | --- |
| Chat, purchases, "ready" | Default: queue and send in order |
| Fire, jump and other one-shot input | `{ volatile: true }` |
| Movement input sent every tick | `{ volatile: true, maxBuffered: 4096 }` |
| Aim, cursor or position snapshots | `{ key: 'aim' }` |
| "Leave", "pause" and other control messages | `{ priority: true }`, ahead of anything queued |

## Requests: await the server's answer

"Join a room and wait for the answer" needs a request id, a map of pending promises, a timeout, and cleanup on disconnect. `createWebSocketRequests` does that bookkeeping. You tell it where the id goes and how to recognize a reply:

```ts
// rpc.ts
import { createWebSocketRequests } from 'react-websocket';
import { game } from './game';

type Request = { type: 'join'; room: string };

export const rpc = createWebSocketRequests(game, {
  send: (message: Request, id) => ({ ...message, id }),
  reply: message => (message.type === 'reply' ? message.id : undefined),
  error: message => (message.type === 'reply' && message.error ? new Error(message.error) : undefined),
  timeout: 5000
});
```

Annotate `send`'s `message` parameter: that's what `request()` accepts. Then:

```tsx
async function join(room: string) {
  try {
    const reply = await rpc.request({ type: 'join', room });
    if (reply.type === 'reply') navigate(`/play/${reply.room}`);
  } catch (error) {
    showToast(String(error)); // 'room is full', a timeout, or a lost connection
  }
}
```

A request rejects instead of hanging forever:

| When | Rejects with |
| --- | --- |
| No reply within `timeout` (default 10 s) | A `DOMException` named `TimeoutError` |
| `error(reply)` returns something | That value |
| The connection it was sent on closes | An `Error`. The reply can no longer arrive, even after a reconnect |
| `close()`, or the client gives up | An `Error` |
| Its `signal` aborts | `signal.reason` |

A request made while disconnected waits in the queue and goes out on the next connection. Its timeout still runs. Pass `{ volatile: true }` to reject right away instead. A pending request also holds the connection, so `await rpc.request(...)` works outside React too.

Cancel requests a component no longer needs:

```tsx
useEffect(() => {
  const controller = new AbortController();
  rpc.request({ type: 'join', room }, { signal: controller.signal }).then(setLobby, () => {});
  return () => controller.abort();
}, [room]);
```

Replies are still ordinary messages: they reach `onMessage`, `lastMessage` and state stores too.

## Ping and server time

`createWebSocketLatency` pings on an interval while the socket is open and measures the round trip. If your server puts its clock in the pong, it also estimates the offset between the server's clock and the player's:

```ts
// latency.ts
import { createWebSocketLatency } from 'react-websocket';
import { game } from './game';

export const latency = createWebSocketLatency(game, {
  ping: id => ({ type: 'ping', id }),
  pong: message => (message.type === 'pong' ? { id: message.id, time: message.time } : undefined)
});
```

The server echoes the id and adds its own `Date.now()`:

```ts
// Server (Node, ws)
if (message.type === 'ping') socket.send(JSON.stringify({ type: 'pong', id: message.id, time: Date.now() }));
```

Show the ping with `useWebSocketLatency`:

```tsx
import { useWebSocketLatency } from 'react-websocket';
import { latency } from './latency';

function Ping() {
  const { rtt } = useWebSocketLatency(latency);
  return <span>{rtt === undefined ? '–' : `${Math.round(rtt)} ms`}</span>;
}
```

Use `latency.serverNow()` anywhere every player must see the same time, such as a countdown to a round that ends at the server's `endsAt`:

```ts
const secondsLeft = Math.max(0, (endsAt - latency.serverNow()) / 1000);
```

Player clocks are often seconds off. `Date.now()` would give each player a different countdown, but `serverNow()` corrects for the offset.

- `rtt` is the median of the last `samples` (default 5) round trips, so one slow ping doesn't make the number jump.
- `offset` comes from the fastest of those samples, which is the most accurate.
- Pings are `volatile` and pause while disconnected. After a reconnect, old samples are discarded, but the last values stay readable until new ones arrive, so a countdown doesn't jump.

## Rendering at 60 fps

Don't render game state through React on every message. Reduce messages into a store with [`createWebSocketState`](./state.md), and read it in your render loop with `getState()`, which never triggers a React render:

```ts
// world.ts
import { createWebSocketState } from 'react-websocket';
import { game } from './game';

export const world = createWebSocketState(game, {
  initialState: { players: {} as Record<string, { x: number; y: number }> },
  reduce: (state, message) => (message.type === 'state' ? { players: message.players } : state)
});
```

```tsx
function Canvas() {
  const ref = useRef<HTMLCanvasElement>(null);
  useWebSocketStatus(game); // holds the connection while mounted

  useEffect(() => {
    let frame = requestAnimationFrame(function draw() {
      drawPlayers(ref.current!, world.getState().players);
      frame = requestAnimationFrame(draw);
    });
    return () => cancelAnimationFrame(frame);
  }, []);

  return <canvas ref={ref} />;
}
```

With React Three Fiber, do the same in `useFrame(() => { … world.getState() … })`. Keep `useWebSocketState` for the HUD (score, health, the player list), where a selector re-renders only when its value changes. Pass `batch: 'frame'` to the store, so that even a HUD value that changes on every tick renders at most once per frame. `getState()` in the render loop stays current either way.

## Rejoining after a reconnect

The server forgets who a connection was when it drops. Identify again from an `open` listener: it runs before anything queued while disconnected is sent. Then start from a fresh snapshot:

```ts
game.on('open', () => {
  world.reset();
  game.send({ type: 'resume', session: sessionToken });
});
```

If the session token rotates, put it in the URL with a [URL function](./authentication.md#token-in-the-url) instead. If you hold [topics](./topics.md), they're subscribed again automatically.

## Binary protocols

For MessagePack, Protocol Buffers or a hand-packed format, receive `ArrayBuffer`s and plug in your codec:

```ts
import { decode, encode } from '@msgpack/msgpack';

export const game = createWebSocket<GameIn, GameOut>('wss://game.example.com', {
  binaryType: 'arraybuffer',
  parse: data => decode(data as ArrayBuffer),
  serialize: message => encode(message)
});
```

Everything on this page works the same with a binary codec.

## Background tabs

Browsers throttle timers in background tabs to about once per second, and sometimes to once per minute. That has two consequences:

- A short [`heartbeat.timeout`](./reconnecting.md#heartbeats) can fire because the tab is asleep, not because the server is dead. Keep the timeout well above a few seconds.
- Ping and countdown displays are only meaningful while visible. The client already retries right away when the tab becomes visible again.

## See also

- [`createWebSocketRequests`](../api/create-websocket-requests.md), [`createWebSocketLatency`](../api/create-websocket-latency.md), [`useWebSocketLatency`](../api/use-websocket-latency.md)
- [`SendOptions`](../api/types.md#sendoptions)
- [Message state](./state.md) and [Performance](./performance.md)
