---
title: 'Build a real-time action game with React and WebSockets'
description: 'A walkthrough of a multiplayer browser game over one WebSocket: a fixed-tick Node server, snapshot interpolation, client-side prediction, an adaptive send rate, a ping display and a 60 fps canvas, file by file.'
---

# Build a real-time action game

This guide walks through the repository's [game example](https://github.com/mehmetkose/react-websocket/tree/main/examples/game) file by file: dots in an arena, a Node server that runs the game 20 times a second, and a React client that draws it at 60 fps. Every block on this page is copied from the example, so you can run what you read:

```sh
# From the repository root: build the library, install it in the example, and start both servers.
npm run example:game
```

Then open http://localhost:5180, move with the arrow keys or WASD, and aim with the mouse. A second tab is a second player.

Fast games need what a chat app doesn't:

1. **Your own moves can't wait for the server.** A key press has to move your dot in the next frame, not a round trip later. The client predicts, and the server corrects it.
2. **Everyone else moves smoothly.** Snapshots arrive 20 times a second, unevenly. Drawing them as they come looks choppy, so the client draws a little in the past, between two snapshots.
3. **Late input is worthless.** A move queued during a reconnect shouldn't go off after it.
4. **A slow link shouldn't fall further and further behind.** The client sends less when the network can't keep up.
5. **60 frames a second, outside React.** React renders the HUD a few times a second. The canvas never goes through it.

[Real-time games](../guide/games.md) explains each technique. This page shows them working together.

| File | Runs in | |
| --- | --- | --- |
| `src/sim.ts` | Both | The rules: `move()` and `lerpWorld()` |
| `src/protocol.ts` | Both | The messages |
| `server.ts` | Node | The fixed tick: applies inputs in order, sends each player a snapshot |
| `src/net.ts` | The browser | The client, latency, the timeline, the send rate, the roster and the network faults |
| `src/Canvas.tsx` | The browser | The render loop: keys in, inputs out, a frame drawn |
| `src/Hud.tsx` | The browser | Status, ping, the send rate and the player list |
| `src/DevPanel.tsx` | The browser | Makes the network worse, to compare |

## The rules

The client predicts your moves with the same function the server applies them with, so the two agree unless an input is lost. Put the rules in a module both import:

```ts
// The game's rules, shared by the server and the client. The client predicts your moves with
// the same `move()` the server applies, so the two agree unless an input is lost.

/** The server applies inputs and sends snapshots this often: 20 times a second. */
export const TICK_MS = 50;
/** One input step. The client samples the keys 60 times a second. */
export const STEP_MS = 1000 / 60;
/** Steps one input may carry: 200 ms, enough for the lowest adaptive send rate (5 a second). */
export const MAX_STEPS = 12;
/**
 * Steps the server allows each player per tick: a little above real time (3), so a late burst of
 * inputs catches up, up to `BURST` steps at once. Nobody moves much faster than real time.
 */
export const STEPS_PER_TICK = 4;
export const BURST = 24;

export const ARENA = { width: 640, height: 400 };
export const RADIUS = 12;
const SPEED = 0.24; // px per ms

export interface Player {
  x: number;
  y: number;
  color: string;
  /** Where the player aims, in radians. */
  angle?: number;
  bot?: boolean;
}

/** A direction held for `steps` steps. */
export interface Move {
  dx: -1 | 0 | 1;
  dy: -1 | 0 | 1;
  steps: number;
}

/** What the timeline keeps: every player, and which one is you. */
export interface World {
  you: string;
  players: Record<string, Player>;
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

export function move(player: Player, input: Move): Player {
  // Diagonals aren't faster.
  const distance = (SPEED * STEP_MS * input.steps) / (Math.hypot(input.dx, input.dy) || 1);
  return {
    ...player,
    x: clamp(player.x + input.dx * distance, RADIUS, ARENA.width - RADIUS),
    y: clamp(player.y + input.dy * distance, RADIUS, ARENA.height - RADIUS)
  };
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/** Blend two snapshots. A player who just joined appears where they are instead of sliding in. */
export function lerpWorld(from: World, to: World, t: number): World {
  const players: Record<string, Player> = {};
  for (const [id, end] of Object.entries(to.players)) {
    const start = from.players[id] ?? end;
    players[id] = { ...end, x: lerp(start.x, end.x, t), y: lerp(start.y, end.y, t) };
  }
  return { you: to.you, players };
}
```

- **An input is a direction held for some steps** of 1/60 s. The client sends one when the direction changes, or at the send rate, so a 120 Hz display doesn't move you twice as fast, and a slow link sends fewer, bigger inputs.
- **`lerpWorld`** blends two snapshots for interpolation. A player who just joined appears where they are instead of sliding in from nowhere.

## The protocol

```ts
// The messages, shared by the server and the client.
import type { Move, Player } from './sim.ts';

export type ServerMessage =
  // Sent to each player every tick. `time` is the server's clock, and `ack` the last input
  // `seq` it applied from this player.
  | { type: 'snapshot'; time: number; ack: number; you: string; players: Record<string, Player> }
  | { type: 'pong'; id: number; time: number };

export type ClientMessage =
  | ({ type: 'input'; seq: number } & Move)
  | { type: 'aim'; angle: number }
  | { type: 'ping'; id: number };

/** Sent as plain text both ways, outside JSON, to keep the connection alive. */
export const HEARTBEAT = 'heartbeat';
```

Every snapshot carries the server's `time`, for interpolation, and `ack`, the last input this player's server applied, for prediction. The heartbeat is a plain string outside JSON, so neither side parses it.

## The server

### Players and the clock

```ts
const port = Number(process.env.PORT ?? 8788);

// A clock that never goes backward, for snapshots and pongs alike, so the client's latency
// estimate and its timeline agree.
const now = () => performance.timeOrigin + performance.now();

interface Client {
  socket: WebSocket;
  player: Player;
  /** Inputs received but not applied yet, in `seq` order. */
  inputs: ({ seq: number } & Move)[];
  /** The last `seq` received, to ignore repeats. */
  received: number;
  /** The last `seq` applied, sent back as `ack`. */
  ack: number;
  /** Steps this player may still move: refilled every tick, up to `BURST`. */
  tokens: number;
}
```

Snapshots and pongs use one clock that never goes backward, so the client's estimate of the server's clock and its timeline agree.

### Inputs

```ts
const server = new WebSocketServer({ port, path: '/ws' });

server.on('connection', socket => {
  const id = `p${++joined}`;
  const client: Client = {
    socket,
    player: spawn(joined),
    inputs: [],
    received: 0,
    ack: 0,
    tokens: BURST
  };
  clients.set(id, client);
  socket.on('error', console.error);

  socket.on('message', raw => {
    const data = String(raw);
    // Answer the client's heartbeat so it knows the connection is alive.
    if (data === HEARTBEAT) return socket.send(HEARTBEAT);
    const message = parse(data);
    if (message?.type === 'ping') send(socket, { type: 'pong', id: message.id, time: now() });
    else if (message?.type === 'aim') client.player = { ...client.player, angle: message.angle };
    // Sequence numbers only go up; don't assume they start at 1 on a new connection.
    else if (message?.type === 'input' && message.seq > client.received) {
      client.received = message.seq;
      client.inputs.push(message);
    }
  });
  socket.on('close', () => clients.delete(id));
});
```

An input is queued, not applied. Sequence numbers only go up, so a repeat is ignored, and they keep counting across reconnects, so the server never assumes they start at 1. `parse` checks each message's shape, and that an input covers no more than `MAX_STEPS`.

### The tick

```ts
setInterval(() => {
  const time = now();
  for (const client of clients.values()) {
    // Apply inputs in order, with the same `move()` the client predicts with. A burst bigger
    // than the player's tokens waits for the next ticks, so nobody moves faster than real time.
    client.tokens = Math.min(BURST, client.tokens + STEPS_PER_TICK);
    while (client.inputs.length && client.inputs[0]!.steps <= client.tokens) {
      const input = client.inputs.shift()!;
      client.tokens -= input.steps;
      client.player = move(client.player, input);
      client.ack = input.seq;
    }
  }

  const players: Record<string, Player> = {};
  for (let i = 0; i < BOTS; i++) players[`bot${i + 1}`] = botAt(i, time);
  for (const [id, client] of clients) players[id] = client.player;
  for (const [id, client] of clients) {
    send(client.socket, { type: 'snapshot', time, ack: client.ack, you: id, players });
  }
}, TICK_MS);
```

Each player gets their own snapshot, with `you` set to their id and `ack` to their last applied input. The tokens stop a player from moving faster than real time: a burst of inputs that arrives at once, after a slow patch, is spread over the next ticks.

## The client

### The connection and the clock

```ts
/**
 * The network panel's faults. They're all off until you pick them; a real app would only use
 * this class in development.
 */
export const Chaos = createChaosWebSocket({ logger: console.warn });

function url() {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${location.host}/ws`;
}

export const game = createWebSocket<ServerMessage, ClientMessage>(url, {
  json: true,
  WebSocket: Chaos,
  // Snapshots arrive 20 times a second, so three quiet seconds after a ping mean a dead link.
  heartbeat: { interval: 4000, timeout: 3000, message: HEARTBEAT, pong: HEARTBEAT }
});

export const latency = createWebSocketLatency(game, {
  ping: id => ({ type: 'ping', id }),
  pong: message => (message.type === 'pong' ? { id: message.id, time: message.time } : undefined),
  interval: 1000
});
```

- **`Chaos`** wraps the socket so the panel below can add latency, lose messages, and drop or stall the connection. With no faults set, it passes everything through. A real app uses it only in development: see [Chaos testing](../guide/chaos.md).
- **The heartbeat** catches a connection that went silent without closing. Snapshots arrive 20 times a second, so a few quiet seconds mean it's dead.
- **`latency`** pings once a second. The HUD shows the round trip, and the timeline uses the server's clock it estimates.

### The send rate and the timeline

```ts
/**
 * Aim, streamed every frame, goes out at up to 30 a second, fewer when the send buffer fills up
 * or the round trip rises. With `settings.adaptive`, inputs follow the same rate.
 */
export const stream = createWebSocketSendRate(game, { latency, maxRate: 30 });

// How unevenly snapshots arrive: arrival time minus server time, over the last two seconds.
const spread: number[] = [];
const jitter = () => (spread.length ? Math.max(...spread) - Math.min(...spread) : TICK_MS);

export const timeline = createWebSocketTimeline(game, {
  snapshot: message =>
    message.type === 'snapshot'
      ? {
          time: message.time,
          ack: message.ack,
          state: { you: message.you, players: message.players }
        }
      : undefined,
  interpolate: lerpWorld,
  latency,
  // Auto: one snapshot interval plus the jitter measured below.
  delay: () => (settings.autoDelay ? TICK_MS + jitter() : settings.delay),
  input: {
    send: (input: Move, seq) => ({ type: 'input', seq, ...input }),
    predict: (world, input): World => {
      const me = world.players[world.you];
      return me ? { ...world, players: { ...world.players, [world.you]: move(me, input) } } : world;
    },
    // On a congested link, skip inputs rather than queue them behind each other.
    maxBuffered: 4096
  }
});

timeline.subscribe(() => {
  const latest = timeline.latest();
  if (!latest) return;
  spread.push(performance.now() - latest.time);
  if (spread.length > 40) spread.shift();
});
```

- **`stream`** sends aim at up to 30 a second, and fewer when the round trip rises or the send buffer fills. Only the newest aim per key is kept between ticks. See [Poor connections](../guide/games.md#poor-connections-adaptive-send-rate).
- **`timeline`** keeps snapshots by server time. `at()` blends the two around the render time for everyone else, and `predicted()` replays your unconfirmed inputs on the newest snapshot for you. See [Smooth movement](../guide/games.md#smooth-movement-snapshot-interpolation) and [Responsive controls](../guide/games.md#responsive-controls-prediction-and-reconciliation).
- **The automatic delay** renders one snapshot interval plus the jitter it measures behind the newest snapshot: as far back as the connection needs, and no further.
- **`maxBuffered`** skips an input while 4 KB are already waiting to go out, instead of queueing it behind the others.

### The roster

```ts
/**
 * Who's playing, for the HUD. Snapshots arrive 20 times a second but the roster rarely changes:
 * the reducer keeps the same array while it doesn't, and `batch: 'frame'` caps renders anyway.
 */
export const roster = createWebSocketState(game, {
  initialState: [] as RosterEntry[],
  reduce: (state, message) => {
    if (message.type !== 'snapshot') return state;
    const ids = Object.keys(message.players);
    const same =
      ids.length === state.length &&
      ids.every((id, i) => state[i]!.id === id && state[i]!.you === (id === message.you));
    if (same) return state;
    return ids.map(id => ({
      id,
      color: message.players[id]!.color,
      bot: !!message.players[id]!.bot,
      you: id === message.you
    }));
  },
  batch: 'frame'
});
```

Snapshots arrive 20 times a second, but the list of players rarely changes. The reducer returns the same array while it doesn't, so the HUD doesn't re-render, and `batch: 'frame'` caps renders at one a frame anyway.

## The render loop

Everything per frame happens in one `requestAnimationFrame` loop, outside React:

```tsx
    let last = performance.now();
    let carry = 0;
    let dropped = 0;
    // Steps taken but not sent yet, all in one direction. Sent every frame, or with
    // `settings.adaptive`, as fewer, bigger inputs at the rate the send-rate stream picks.
    let batch: Move = { dx: 0, dy: 0, steps: 0 };
    let sentAt = 0;

    function send(now: number) {
      if (!batch.steps) return;
      // An input that can't be sent is gone: the timeline doesn't predict it, so don't keep it.
      if (timeline.input(batch) === undefined && game.getSnapshot().status === 'open') dropped++;
      batch = { ...batch, steps: 0 };
      sentAt = now;
    }

    let frame = requestAnimationFrame(function loop(now) {
      // Fixed 60 Hz steps, whatever the display's refresh rate.
      carry = Math.min(carry + now - last, 5 * STEP_MS);
      last = now;
      const steps = Math.floor(carry / STEP_MS);
      carry -= steps * STEP_MS;
      const { dx, dy } = direction(held);
      if (dx !== batch.dx || dy !== batch.dy) {
        send(now);
        batch = { dx, dy, steps: 0 };
      }
      if (dx || dy) batch = { ...batch, steps: Math.min(MAX_STEPS, batch.steps + steps) };
      // Half a step early is on time: frames don't land exactly on the interval.
      const interval = settings.adaptive ? 1000 / stream.getSnapshot().rate - STEP_MS / 2 : 0;
      if (now - sentAt >= interval || batch.steps === MAX_STEPS) send(now);

      const latest = timeline.latest()?.state;
      const others = settings.interpolate ? timeline.at() : latest;
      const mine = settings.predict ? timeline.predicted() : others;
      if (others && mine) {
        const you = mine.you;
        const players = { ...others.players };
        let me = mine.players[you];
        if (me) {
          // Show the steps waiting to be sent too, so a lower send rate doesn't make you jerky.
          if (settings.predict && batch.steps) me = move(me, batch);
          // Aim from where you're drawn, streamed at the adaptive rate.
          if (pointer) {
            const angle = Math.atan2(pointer.y - me.y, pointer.x - me.x);
            me = { ...me, angle };
            stream.send({ type: 'aim', angle }, 'aim');
          }
          players[you] = me;
        }
        draw(context, players, you, settings.ghost ? latest?.players[you] : undefined);
      }

      // How far the render time is behind the newest snapshot. At 0 or below, `at()` has run
      // out of snapshots and holds still: raise the delay.
      const newest = timeline.latest()?.time;
      const rendered = timeline.renderTime();
      if (newest !== undefined && rendered !== undefined) {
        const margin = Math.round(newest - rendered);
        stats.current!.textContent = `Buffered ahead: ${margin} ms · Unconfirmed inputs: ${timeline.pending()} · Skipped inputs (congestion): ${dropped}`;
        stats.current!.dataset.starved = String(margin <= 0);
      }
      frame = requestAnimationFrame(loop);
    });
```

1. **Fixed steps.** Time is cut into 1/60 s steps whatever the display's refresh rate, and held keys add steps to the input being built.
2. **Send.** When the direction changes, or at the send rate's interval, `timeline.input()` sends the input `volatile` and predicts it. An input it can't send is gone, so the loop doesn't keep it.
3. **Draw.** Everyone else from `at()`, yourself from `predicted()`, plus the steps not sent yet, so a low send rate doesn't make you jerky. Aim is streamed from where you're drawn.
4. **Show the margin.** How far the render time is behind the newest snapshot. At 0 or below, `at()` has run out of snapshots to blend.

`useWebSocketStatus(game)` in the component holds the connection while the canvas is mounted. Nothing in the loop sets React state.

## The HUD

```tsx
const ms = (value: number | undefined) => (value === undefined ? '–' : `${Math.round(value)} ms`);

// `latest` changes when the timeline notifies, so it's safe to read through
// useSyncExternalStore. `at()` and `predicted()` change with time and aren't.
const getAck = () => timeline.latest()?.ack;

/** Status, ping and the player list. Renders a few times a second at most. */
export function Hud() {
  const status = useWebSocketStatus(game);
  const { rtt, offset } = useWebSocketLatency(latency);
  const ack = useSyncExternalStore(timeline.subscribe, getAck, () => undefined);
  const players = useWebSocketState(roster);
  const { rate, congested } = useSyncExternalStore(
    stream.subscribe,
    stream.getSnapshot,
    stream.getSnapshot
  );
```

The HUD renders when the status changes, about once a second for the ping, when the confirmed input changes, when the roster changes, and when the send rate changes. `timeline.latest()` is safe to read through `useSyncExternalStore`, since it changes only when the timeline notifies. `at()` and `predicted()` change with time, and are read in the render loop instead.

## The network panel

```tsx
// One-way delays: a round trip takes about twice as long.
const PRESETS: Record<string, ChaosRange> = {
  LAN: 0,
  Good: 30,
  Mobile: [60, 120],
  Bad: [100, 300]
};

/** Network faults (through react-websocket/chaos) and rendering switches, to compare. */
export function DevPanel() {
  const [network, setNetwork] = useState('LAN');
  const [loss, setLoss] = useState({ in: 0, out: 0 });
  const [view, setView] = useState(settings);

  function pick(name: string) {
    setNetwork(name);
    Chaos.configure({ latency: PRESETS[name]! });
  }

  function lose(direction: 'in' | 'out', on: boolean) {
    const next = { ...loss, [direction]: on ? 0.05 : 0 };
    setLoss(next);
    Chaos.configure({ loss: next });
  }

  function change(patch: Partial<typeof settings>) {
    Object.assign(settings, patch); // read by the render loop on the next frame
    setView({ ...settings });
  }
```

`Chaos.configure()` changes the faults on the open connection. The rendering switches write to `settings`, which the render loop reads every frame, so no re-render is needed.

## What happens on a bad network

| Try | What you see | Why |
| --- | --- | --- |
| Pick "Bad" (100–300 ms each way) | Your dot still moves the moment you press a key. The other tab's dot moves smoothly, but behind | Prediction for you, interpolation for the others |
| Turn off "Predict my moves" | Every key press waits a round trip and the render delay | `predicted()` was hiding the round trip |
| Turn off "Interpolate others" | Other dots jump 20 times a second, unevenly | The newest snapshot, drawn as it arrives |
| Turn on "Lose 5% of my inputs" | Your dot snaps back a little now and then | The server never applied the lost inputs, and reconciliation corrects the prediction |
| Drop the connection | The last frame stays on screen, then the game carries on from a fresh snapshot | The timeline keeps its last frame until the new connection's first snapshot |
| Stall it | The same, a few seconds later | The heartbeat notices the silence |
| Set the delay to 0 | Other dots stutter | There's rarely a newer snapshot to blend toward |

In Chrome, against a copy of the example built from the library's source: on a LAN, your dot moved 20 ms after the key press and the server confirmed the move 70 ms after it. With "Bad", your dot still moved 5 ms after the key press, and the server's confirmation came 506 ms after it, with a 462 ms round trip. Switching to "Bad" while aiming, the send rate fell from 30 to 15, 8, then 5 a second within two seconds of the round trip rising from 4 ms to 405 ms. A dropped connection was back in 651 ms, with its first snapshot 49 ms later. A stalled one was noticed after 4.9 s, the 4 s ping interval plus the 3 s timeout at most, and was back 30 ms after that. With "Mobile" (60–120 ms each way), a delay of 0 left 78% of frames with no newer snapshot to blend toward. 100 ms, or the automatic delay, left none.

## Making it yours

The example leaves out what depends on your game:

- **Rooms and matchmaking.** Give each room its own set of players and tick, and join one with [`createWebSocketRequests`](../guide/games.md#requests-await-the-servers-answer), as in [Build a multiplayer party game](./party-game.md).
- **Rejoining.** The server forgets who a connection was. Send a session token from an `open` listener, as in [Rejoining after a reconnect](../guide/games.md#rejoining-after-a-reconnect).
- **Hit detection.** Your shots are aimed at where others were drawn, about `delay` plus half a round trip in the past. Send `seen: timeline.renderTime()` with each shot, and rewind the others to that time on the server.
- **Big worlds.** Send deltas instead of every player, and rebuild the world in the timeline's `snapshot` option. With many messages a tick, a [binary codec](../guide/games.md#binary-protocols) helps.
- **WebTransport.** With [`react-websocket/webtransport`](../guide/webtransport.md), `volatile` inputs travel as datagrams, so a lost one never holds up the next.

## See also

- [Real-time games](../guide/games.md): each technique on this page, explained
- [`createWebSocketTimeline`](../api/create-websocket-timeline.md), [`createWebSocketSendRate`](../api/create-websocket-send-rate.md), [`createWebSocketLatency`](../api/create-websocket-latency.md)
- [Chaos testing](../guide/chaos.md) and [Performance](../guide/performance.md)
- [Build a multiplayer party game](./party-game.md): rooms, a shared countdown and answers counted once
