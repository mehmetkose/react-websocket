---
description: 'createWebSocketTimeline: snapshot interpolation, client-side prediction and server reconciliation for multiplayer games, from react-websocket/timeline.'
---

# createWebSocketTimeline

Keep server snapshots on a timeline for multiplayer games. Render what the server moves slightly in the past, interpolated between snapshots, and what your inputs move right away, predicted and corrected when the server confirms them.

```ts
function createWebSocketTimeline<In, Out, S, I>(
  client: WebSocketClient<In, Out>,
  options: {
    snapshot: (message: In) => { time: number; state: S; ack?: number } | null | undefined;
    interpolate?: (from: S, to: S, t: number) => S;
    delay?: number | (() => number);
    extrapolate?: number;
    buffer?: number;
    latency?: WebSocketLatency;
    input?: {
      send: (input: I, seq: number) => Out;
      predict: (state: S, input: I) => S;
      maxBuffered?: number;
    };
  }
): WebSocketTimeline<S, I>;
```

Available only from `react-websocket/timeline`. It has no React dependency, and its size (about 0.85 kB min+gzip) is separate from the main entry's.

## Usage

```ts
import { createWebSocketTimeline } from 'react-websocket/timeline';
import { game, latency } from './game';
import { lerpWorld, move, type Move } from './sim';

export const timeline = createWebSocketTimeline(game, {
  snapshot: message =>
    message.type === 'snapshot'
      ? { time: message.time, ack: message.ack, state: { you: message.you, players: message.players } }
      : undefined,
  interpolate: lerpWorld,
  latency,
  input: {
    send: (input: Move, seq) => ({ type: 'input', seq, ...input }),
    predict: (world, input) => ({
      ...world,
      players: { ...world.players, [world.you]: move(world.players[world.you]!, input) }
    })
  }
});
```

Then, once per frame:

```ts
const world = timeline.at(); // everyone, interpolated, ~100 ms in the past
const mine = timeline.predicted(); // the newest snapshot plus your unconfirmed inputs
if (world && mine) draw({ ...world.players, [mine.you]: mine.players[mine.you]! });
```

And on input:

```ts
timeline.input({ dx: 1, dy: 0 });
```

Annotate `send`'s `input` parameter: that's what `timeline.input()` accepts. The guide is [Real-time games](../guide/games.md#smooth-movement-snapshot-interpolation).

## Parameters

| Parameter | Type | |
| --- | --- | --- |
| `client` | [`WebSocketClient<In, Out>`](./types.md#websocketclient) | The client the snapshots arrive on. `In` and `Out` are taken from it |
| `options.snapshot` | `(message: In) => TimelineSnapshot<S> \| null \| undefined` | Recognize a snapshot: its server `time`, its `state`, and optionally `ack`. `undefined` for any other message |
| `options.interpolate` | `(from: S, to: S, t: number) => S` | Optional. Blend two states, with `t` from 0 to 1 (above 1 only when extrapolating). Without it, `at()` steps from snapshot to snapshot |
| `options.delay` | `number \| (() => number)` | Optional. How far behind the newest snapshot to render, in ms: the snapshot interval plus jitter. A function is read on every call. Default `100` |
| `options.extrapolate` | `number` | Optional. How far past the newest snapshot `at()` may extrapolate when the next one is late, in ms. Needs `interpolate`. Default `0`: hold the newest state |
| `options.buffer` | `number` | Optional. How many snapshots to keep, at least 2. Default `30` |
| `options.latency` | [`WebSocketLatency`](./create-websocket-latency.md) | Optional. Take the server clock from pings. Without it, the clock is estimated from when snapshots arrive |
| `options.input.send` | `(input: I, seq: number) => Out` | The message for an input, tagged with its sequence number. Sent with `volatile` |
| `options.input.predict` | `(state: S, input: I) => S` | Apply one input to a state, exactly as the server does. Pure |
| `options.input.maxBuffered` | `number` | Optional. Drop an input while more than this many bytes wait in the send buffer, as [`SendOptions`](./types.md#sendoptions) does. A dropped input isn't predicted |

### TimelineSnapshot

```ts
interface TimelineSnapshot<S> {
  /** Server time the state is for, in ms. Must increase from one snapshot to the next. */
  readonly time: number;
  /** The authoritative state at `time`. */
  readonly state: S;
  /** `seq` of the last input from this client the server applied. Omit to keep the previous one. */
  readonly ack?: number;
}
```

## Returns

`WebSocketTimeline<S, I>`:

| Member | |
| --- | --- |
| `at(time?)` | The state at `time` (default `renderTime()`), interpolated. `undefined` before any snapshot |
| `predicted()` | The newest snapshot's state with unconfirmed inputs replayed. Cached, so it's cheap every frame |
| `input(input)` | Send an input and predict it. Returns its `seq`, or `undefined` if it couldn't be sent, in which case it isn't predicted |
| `latest()` | The newest snapshot, as `snapshot` returned it |
| `renderTime()` | The server time `at()` renders by default. It never goes backward until the timeline starts over |
| `pending()` | How many inputs were sent but not confirmed yet |
| `subscribe(listener)` | Called after each new snapshot and on `reset()`. Returns an unsubscribe function |
| `reset()` | Forget all snapshots and pending inputs now. `seq` keeps counting |
| `dispose()` | Stop listening. Only for timelines created dynamically |
| `client` | The client |

What `at()` returns, by render time:

| Render time | `at()` returns |
| --- | --- |
| No snapshot yet | `undefined` |
| Before the oldest snapshot | The oldest snapshot's state |
| Exactly at a snapshot | That snapshot's state, without calling `interpolate` |
| Between two snapshots | `interpolate(from, to, t)`, or `from` without `interpolate` |
| After the newest | The newest state, or extrapolated for up to `extrapolate` ms |

## Behavior

- **Clock.** The render time is `edge - delay`, where `edge` is the server time of a snapshot arriving now. With `latency`, that's `serverNow() - rtt / 2`, so `delay` doesn't depend on the player's ping. Without it, or before the first pong with a time, it's estimated from the least delayed of the buffered snapshots. Your pongs and your snapshots must use the same server clock.
- **Never backward.** `renderTime()` holds still instead of going backward, for example when a `delay` function grows or the clock estimate improves.
- **Ordering.** A snapshot whose `time` isn't after the newest one is ignored, along with its `ack`.
- **Inputs.** Inputs are sent with `volatile`, so they're never queued or replayed after a reconnect. Only inputs that were sent are predicted. Sequence numbers start at 1 and keep counting across reconnects and `reset()`, so a server that resumes sessions always sees them increase.
- **Reconciliation.** When a snapshot's `ack` confirms inputs, they're dropped, and `predicted()` replays the rest on top of the new snapshot. Up to 1000 unconfirmed inputs are kept.
- **Reconnects.** On `open`, unconfirmed inputs are dropped, since the old connection can't confirm them. The old snapshots stay visible until the new connection's first snapshot, which replaces them even if its time is earlier (a restarted server).
- **Doesn't connect.** It listens from creation but doesn't hold the connection. Hold it with [`useWebSocketStatus`](./use-websocket-status.md) in the component that renders the game.
- **Snapshots are messages.** Snapshots also reach `onMessage`, `lastMessage` and state stores. With `useWebSocket`, that's a render per snapshot, so prefer `useWebSocketStatus`.
- **Not a React store.** `at()`, `predicted()` and `renderTime()` change with time, not with notifications. Read them in `requestAnimationFrame` or React Three Fiber's `useFrame`, not with `useSyncExternalStore`. `latest()` and `pending()` are fine there.
- **Errors.** A `snapshot` that throws leaves the timeline unchanged, and the client re-throws the error asynchronously.
- **Requires TypeScript 5.4+** for the inferred message types (it uses `NoInfer`).
