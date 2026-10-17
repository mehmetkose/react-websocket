---
title: 'Real-time games with WebSockets and React'
description: 'Networking for browser games over WebSockets in React: input that isn''t replayed late, snapshot interpolation, client-side prediction, an adaptive send rate, awaited requests, ping and server time, and rendering at 60 fps.'
---

# Real-time games

Browser games run into the same networking problems again and again: input replayed after a reconnect, choppy movement, controls that lag by a round trip, hand-rolled request ids, ping displays, timers that disagree between players, and React rendering at 60 fps. This page covers the tools for each.

react-websocket stays protocol-agnostic. You describe your messages once and it handles the bookkeeping. Snapshot interpolation and client-side prediction come from `react-websocket/timeline`. Rooms and matchmaking depend on your server, so they're left to you or to a game server framework. For all of it working together, run the [game example](https://github.com/mehmetkose/react-websocket/tree/main/examples/game).

## The setup

The examples on this page share one client:

```ts
// game.ts
import { createWebSocket } from 'react-websocket';

export type Player = { x: number; y: number };

export type GameIn =
  | { type: 'snapshot'; time: number; ack: number; you: string; players: Record<string, Player> }
  | { type: 'score'; scores: Record<string, number> }
  | { type: 'reply'; id: number; room?: string; error?: string }
  | { type: 'pong'; id: number; time: number };

export type GameOut =
  | { type: 'input'; seq: number; dx: number; dy: number }
  | { type: 'fire'; angle: number }
  | { type: 'aim'; angle: number }
  | { type: 'join'; room: string; id: number }
  | { type: 'ping'; id: number }
  | { type: 'resume'; session: string };

export const game = createWebSocket<GameIn, GameOut>('wss://game.example.com', { json: true });
```

## Input: don't replay stale messages

By default, `send()` while disconnected queues the message, and the queue is flushed when the socket opens. That's right for chat, but wrong for input. After a three-second drop, every buffered shot goes off at once.

Pass `volatile` for messages that are worthless once they're late:

```ts
game.send({ type: 'fire', angle }, { volatile: true });
```

A volatile message goes out immediately when the socket is open and is dropped otherwise. `send()` returns `false` when it was dropped.

For state where only the latest value matters, pass a `key` instead. While disconnected, sending again with the same key replaces the queued message, so only the newest one is sent on reconnect:

```ts
game.send({ type: 'aim', angle }, { key: 'aim' });
```

The replacement moves to the back of the queue, after anything you sent before it.

On a slow link, a message sent every tick can also pile up while the socket is open: the browser buffers what it can't send yet, and every message waits behind the ones before it. Add `maxBuffered` to drop a message while more than that many bytes are already waiting, so the buffer drains instead of growing:

```ts
game.send({ type: 'aim', angle }, { key: 'aim', maxBuffered: 4096 });
```

Use it for messages where the next one replaces this one anyway. Don't use it for one-shot actions such as fire or jump, which must arrive.

Movement you want to show right away goes through [the timeline](#responsive-controls-prediction-and-reconciliation) instead, which sends it `volatile` for you and takes `maxBuffered` too.

| Message | Use |
| --- | --- |
| Chat, purchases, "ready" | Default: queue and send in order |
| Fire, jump and other one-shot input | `{ volatile: true }` |
| Aim, cursor or position, sent every tick | `{ key: 'aim', maxBuffered: 4096 }`, or [an adaptive send rate](#poor-connections-adaptive-send-rate) |
| "Leave", "pause" and other control messages | `{ priority: true }`, ahead of anything queued |
| Movement you predict | `timeline.input()` |

:::tip Over WebTransport
With [`react-websocket/webtransport`](./webtransport.md), `volatile` messages go as datagrams: they skip the queue on the network too, so a lost one never holds up the next. They can also be lost while connected, so keep fire and jump on ordinary sends there, or pass `datagrams: false`.
:::

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

## Smooth movement: snapshot interpolation

Servers usually send the world 10 to 30 times a second. Drawing each snapshot as it arrives looks choppy, and network jitter makes the gaps uneven. The fix is to render slightly in the past, between two snapshots you already have, and blend them.

`createWebSocketTimeline`, from `react-websocket/timeline`, keeps snapshots by server time and does the blending:

```ts
// timeline.ts
import { createWebSocketTimeline } from 'react-websocket/timeline';
import { game, type Player } from './game';
import { latency } from './latency';

export type World = { you: string; players: Record<string, Player> };

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

function lerpWorld(from: World, to: World, t: number): World {
  const players: Record<string, Player> = {};
  for (const [id, end] of Object.entries(to.players)) {
    const start = from.players[id] ?? end; // a player who just joined doesn't slide in
    players[id] = { x: lerp(start.x, end.x, t), y: lerp(start.y, end.y, t) };
  }
  return { you: to.you, players };
}

export const timeline = createWebSocketTimeline(game, {
  snapshot: message =>
    message.type === 'snapshot'
      ? { time: message.time, ack: message.ack, state: { you: message.you, players: message.players } }
      : undefined,
  interpolate: lerpWorld,
  latency
});
```

`timeline.at()` returns the world at `timeline.renderTime()`, about `delay` ms (default 100) behind the newest snapshot, blended between the two snapshots around that time. Call it every frame.

- **Picking `delay`.** It should cover the time between snapshots plus jitter, about two intervals. At 20 snapshots a second (50 ms apart), the default 100 ms survives one late snapshot. Too little and `at()` runs out of snapshots and holds still. Too much and everything lags.
- **Late snapshots.** When the render time passes the newest snapshot, `at()` holds it. With `extrapolate: 50`, it continues the motion for up to 50 ms instead, which hides one late snapshot but overshoots when a player stops.
- **The clock.** With `latency`, the timeline uses the server clock from pings. Without it, it estimates the clock from when snapshots arrive, which works too.

To render only as far behind as the connection needs, pass a function. This one measures how unevenly snapshots arrive:

```ts
const spread: number[] = [];
const jitter = () => (spread.length ? Math.max(...spread) - Math.min(...spread) : 50);

export const timeline = createWebSocketTimeline(game, {
  // …as above
  delay: () => 50 + jitter() // the snapshot interval, plus jitter
});

timeline.subscribe(() => {
  const latest = timeline.latest();
  if (!latest) return;
  spread.push(performance.now() - latest.time); // arrival minus server time, offset doesn't matter
  if (spread.length > 40) spread.shift();
});
```

The render time never goes backward, so when the delay grows, the world slows down for a moment instead of jumping back.

## Responsive controls: prediction and reconciliation

Rendering in the past is right for other players, but not for your own: a key press would take a round trip plus the delay to show up. Instead, apply your input right away, and let the server correct you.

Give the timeline an `input` option:

```ts
// timeline.ts
import { move, type Move } from './sim'; // shared with the server

export const timeline = createWebSocketTimeline(game, {
  // snapshot, interpolate and latency as above
  input: {
    send: (input: Move, seq) => ({ type: 'input', seq, ...input }),
    predict: (world, input) => ({
      ...world,
      players: { ...world.players, [world.you]: move(world.players[world.you]!, input) }
    }),
    maxBuffered: 4096
  }
});
```

Then send movement with `timeline.input()` instead of `send()`:

```ts
timeline.input({ dx: 1, dy: 0 });
```

What happens:

1. Each input gets a sequence number, `seq`, and is sent `volatile`. If it can't be sent (the socket isn't open, or the buffer is above `maxBuffered`), `input()` returns `undefined` and nothing is predicted.
2. `timeline.predicted()` returns the newest snapshot with every input the server hasn't confirmed replayed on top, with `predict`.
3. Each snapshot carries `ack`, the last `seq` the server applied. Confirmed inputs are dropped, and the rest are replayed on the new snapshot. If the server disagreed, say you walked into a wall only it knew about, your player snaps to where the server says, plus the inputs still on their way.

`predict` must do exactly what the server does. Share the simulation: put `move()` in a module both import. Annotate `send`'s `input` parameter, since that's what `timeline.input()` accepts.

### Drawing both

Draw other players from `at()` and yourself from `predicted()`:

```ts
const world = timeline.at();
const mine = timeline.predicted();
if (world && mine) draw({ ...world.players, [mine.you]: mine.players[mine.you]! });
```

Your player is drawn in the present, and everyone else about `delay` plus half a round trip in the past. That's the usual trade-off. Where it matters, such as hit detection, tell the server what you saw: send `seen: timeline.renderTime()` with the shot, and let the server rewind the other players to that time. That's called lag compensation.

### Smoothing corrections

A misprediction makes your player jump. To hide small ones, ease the drawn position toward the predicted one each frame instead of drawing it as is:

```ts
const target = mine.players[mine.you]!;
shown.x += (target.x - shown.x) * 0.3;
shown.y += (target.y - shown.y) * 0.3;
```

## Poor connections: adaptive send rate

A player on a slow link can't upload 60 messages a second. The browser buffers what it can't send yet, every message waits behind the ones before it, and the lag keeps growing. `maxBuffered` stops the growth by dropping messages, but it's better not to send them in the first place.

`createWebSocketSendRate` sends state such as aim or a cursor at a rate that adapts. It ticks up to `maxRate` times a second, halves the rate when the send buffer fills up or the round trip rises, and climbs back one tick a second at a time while the link keeps up. Between ticks, only the newest message per key is kept:

```ts
// stream.ts
import { createWebSocketSendRate } from 'react-websocket';
import { game } from './game';
import { latency } from './latency';

export const stream = createWebSocketSendRate(game, { latency, maxRate: 30 });
```

```ts
// Every frame, or on every pointer move: at most 30 a second, fewer on a congested link.
stream.send({ type: 'aim', angle }, 'aim');
```

Before a one-shot action that must carry the newest state, flush what's waiting:

```ts
stream.flush();
game.send({ type: 'fire', angle }, { volatile: true });
```

A steady high ping keeps the full rate. Only a round trip that rises counts, because that's what a filling queue looks like.

Don't send predicted inputs through it: coalescing drops messages, and a dropped input is never confirmed. Use the rate to send fewer, bigger inputs instead. Each input says how many simulation steps it covers, and both `predict` and the server apply them all:

```ts
// In the render loop, once per 60 Hz step while a key is held:
steps++;
if (performance.now() - lastInput >= 1000 / stream.getSnapshot().rate) {
  timeline.input({ dx, dy, steps });
  steps = 0;
  lastInput = performance.now();
}
```

The timeline only predicts inputs it has sent, so draw your player with the steps not sent yet on top: `move(mine, { dx, dy, steps })`. The rate adapts on ticks, so this works while you stream something, such as aim, through `send()`. `stream.getSnapshot()` returns `{ rate, congested }` for a HUD. The [game example](https://github.com/mehmetkose/react-websocket/tree/main/examples/game) has a switch to compare.

## The server's side

The timeline needs four things from your server:

- **A `time` on every snapshot**, in ms, from a clock that never goes backward. Use the same clock for pongs, so `latency` and the timeline agree. In Node, `performance.timeOrigin + performance.now()` works for both.
- **An `ack` for each client**: the last input `seq` the server applied from that client. If one message goes to everyone, include every player's ack and pick yours out in `snapshot`.
- **Inputs applied in `seq` order**, with the same code as `predict`. Ignore a `seq` at or below the last one applied. Sequence numbers keep counting across reconnects, so don't expect them to start at 1.
- **A fixed tick.** Apply queued inputs and send snapshots at a steady rate, such as 20 times a second.

```ts
// Server (Node, ws)
const now = () => performance.timeOrigin + performance.now();

setInterval(() => {
  for (const player of players.values()) {
    for (const input of player.inputs.splice(0)) {
      if (input.seq <= player.ack) continue;
      player.position = move(player.position, input);
      player.ack = input.seq;
    }
  }
  const positions = Object.fromEntries([...players].map(([id, player]) => [id, player.position]));
  for (const [id, player] of players) {
    const snapshot = { type: 'snapshot', time: now(), ack: player.ack, you: id, players: positions };
    player.socket.send(JSON.stringify(snapshot));
  }
}, 50);
```

The [game example](https://github.com/mehmetkose/react-websocket/tree/main/examples/game) has a complete server.

If your server sends deltas instead of the full world, rebuild it in `snapshot` from the previous one: `state: apply(timeline.latest()?.state, message.delta)`.

## Rendering at 60 fps

Don't render game state through React on every message. Read the timeline in your render loop instead: `at()` and `predicted()` never trigger a React render.

```tsx
function Canvas() {
  const ref = useRef<HTMLCanvasElement>(null);
  useWebSocketStatus(game); // holds the connection while mounted

  useEffect(() => {
    let frame = requestAnimationFrame(function draw() {
      const world = timeline.at();
      const mine = timeline.predicted();
      if (world && mine) {
        drawPlayers(ref.current!, { ...world.players, [mine.you]: mine.players[mine.you]! });
      }
      frame = requestAnimationFrame(draw);
    });
    return () => cancelAnimationFrame(frame);
  }, []);

  return <canvas ref={ref} />;
}
```

With React Three Fiber, do the same in `useFrame(() => { … timeline.at() … })`. For a slow or turn-based game that doesn't need interpolation, reduce messages into a [`createWebSocketState`](./state.md) store and read `getState()` in the loop the same way.

Keep [`useWebSocketState`](../api/use-websocket-state.md) for the HUD (score, health, the player list), where a selector re-renders only when its value changes. Pass `batch: 'frame'`, so that even a value that changes on every tick renders at most once per frame:

```ts
// scores.ts
export const scores = createWebSocketState(game, {
  initialState: {} as Record<string, number>,
  reduce: (state, message) => (message.type === 'score' ? message.scores : state),
  batch: 'frame'
});
```

Don't read `at()`, `predicted()` or `renderTime()` through `useSyncExternalStore`: they change with time, not when the timeline notifies. `timeline.pending()` and `timeline.latest()` are fine there.

## Rejoining after a reconnect

The server forgets who a connection was when it drops. Identify again from an `open` listener: it runs before anything queued while disconnected is sent.

```ts
game.on('open', () => {
  game.send({ type: 'resume', session: sessionToken });
});
```

The timeline starts over by itself: it drops inputs the old connection never confirmed, and keeps showing the last frame until the first snapshot on the new connection. Don't call `timeline.reset()` from `open`, or the screen goes blank until then. Reset any state stores that the new connection fills from scratch.

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

Browsers throttle timers in background tabs to about once per second, and sometimes to once per minute, and stop animation frames. That has three consequences:

- A short [`heartbeat.timeout`](./reconnecting.md#heartbeats) can fire because the tab is asleep, not because the server is dead. Keep the timeout well above a few seconds.
- Ping and countdown displays are only meaningful while visible. The client already retries right away when the tab becomes visible again.
- Animation frames stop, so nothing reads the timeline. When the tab is visible again, the render time catches up with the present at once.

## See also

- [`createWebSocketTimeline`](../api/create-websocket-timeline.md), [`createWebSocketSendRate`](../api/create-websocket-send-rate.md), [`createWebSocketRequests`](../api/create-websocket-requests.md), [`createWebSocketLatency`](../api/create-websocket-latency.md), [`useWebSocketLatency`](../api/use-websocket-latency.md)
- The [game example](https://github.com/mehmetkose/react-websocket/tree/main/examples/game): a multiplayer demo with a network panel
- [`SendOptions`](../api/types.md#sendoptions)
- [Message state](./state.md) and [Performance](./performance.md)
