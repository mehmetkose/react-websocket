// Types only: the built entry has no imports, and its declarations point at `core`'s.
import type { WebSocketClient, WebSocketLatency } from './core';

/** A server snapshot, as returned by the `snapshot` option. */
export interface TimelineSnapshot<S> {
  /** Server time the state is for, in ms. Must increase from one snapshot to the next. */
  readonly time: number;
  /** The authoritative state at `time`. */
  readonly state: S;
  /**
   * `seq` of the last input from this client that the server applied before taking the
   * snapshot. Inputs up to it are confirmed and no longer predicted. Omit it to keep the
   * previous one.
   */
  readonly ack?: number;
}

/** Client-side prediction for your own inputs. See {@link WebSocketTimelineOptions.input}. */
export interface TimelineInputOptions<S, I, Out> {
  /**
   * Build the message for an input, tagged with its `seq`. Annotate `input`: that's what
   * `timeline.input()` accepts. Sent with `volatile`, so inputs are never replayed late.
   */
  send: (input: I, seq: number) => Out;
  /**
   * Apply one input to a state, exactly as the server does. Must be pure: return a new state
   * instead of changing `state`, which is a snapshot from the server.
   */
  predict: (state: S, input: I) => S;
  /**
   * Drop an input instead of sending it while more than this many bytes are already waiting in
   * the browser's send buffer (see `SendOptions.maxBuffered`). For input sent every tick on a
   * slow link. A dropped input isn't predicted.
   */
  maxBuffered?: number;
}

/** Options for {@link createWebSocketTimeline}. */
export interface WebSocketTimelineOptions<S, I, In, Out> {
  /** Recognize a snapshot. Return `undefined` (or `null`) for any other message. */
  snapshot: (message: In) => TimelineSnapshot<S> | null | undefined;
  /**
   * Blend two states. `t` runs from 0 (`from`) to 1 (`to`), and above 1 only when
   * extrapolating. Without it, `at()` steps from one snapshot to the next.
   */
  interpolate?: (from: S, to: S, t: number) => S;
  /**
   * How far behind the newest snapshot to render, in ms: enough to cover the snapshot
   * interval plus jitter, so there are usually two snapshots to blend between. A function is
   * read on every call, for a delay that adapts.
   * @default 100
   */
  delay?: number | (() => number);
  /**
   * How far past the newest snapshot `at()` may extrapolate when the next one is late, in ms.
   * Needs `interpolate`. `0` holds the newest state instead.
   * @default 0
   */
  extrapolate?: number;
  /**
   * How many snapshots to keep (at least 2).
   * @default 30
   */
  buffer?: number;
  /**
   * Take the server clock from `createWebSocketLatency` on the same client. Its pongs must use
   * the same clock as snapshot `time`. Without it, or before the first pong with a time, the
   * server clock is estimated from when snapshots arrive.
   */
  latency?: Pick<WebSocketLatency, 'getSnapshot' | 'serverNow'>;
  /** Send inputs tagged with a sequence number, and predict their effect until the server confirms them. */
  input?: TimelineInputOptions<S, I, Out>;
}

/** Server snapshots on a timeline, with your own inputs predicted on top. Create with {@link createWebSocketTimeline}. */
export interface WebSocketTimeline<S, I> {
  /** The client whose snapshots this timeline keeps. */
  readonly client: WebSocketClient<any, any>;
  /**
   * The state at `time` (by default `renderTime()`), interpolated between the snapshots around
   * it. For what the server moves, such as other players. `undefined` before any snapshot.
   */
  at(time?: number): S | undefined;
  /**
   * The newest snapshot with your unconfirmed inputs replayed on top. For what your inputs
   * move, such as your own player. Cached, so it's cheap to call every frame.
   */
  predicted(): S | undefined;
  /**
   * Send an input and predict it. Returns its `seq`, or `undefined` if it couldn't be sent
   * (the socket isn't open, or `maxBuffered` dropped it), in which case it isn't predicted.
   */
  input(input: I): number | undefined;
  /** The newest snapshot, as `snapshot` returned it. */
  latest(): TimelineSnapshot<S> | undefined;
  /**
   * The server time `at()` renders by default: the newest snapshot's time, give or take, minus
   * `delay`. It never goes backward until the timeline starts over. `undefined` before any snapshot.
   */
  renderTime(): number | undefined;
  /** How many inputs were sent but not confirmed yet. */
  pending(): number;
  /**
   * Called after each new snapshot and on `reset()`. Compatible with `useSyncExternalStore` for
   * `latest` and `pending`, but not for `at`, `predicted` or `renderTime`, which change with time.
   */
  subscribe(listener: () => void): () => void;
  /** Forget all snapshots and pending inputs now. `seq` keeps counting. */
  reset(): void;
  /** Stop listening. Only needed for timelines created dynamically. */
  dispose(): void;
}

// Unconfirmed inputs kept at most. A server that stops confirming would otherwise make every
// snapshot replay a growing list.
const MAX_PENDING = 1000;

/**
 * Keep server snapshots on a timeline for multiplayer games: render what the server moves
 * slightly in the past, interpolated between snapshots, and what your inputs move right away,
 * predicted and corrected when the server confirms them.
 *
 * Read it once per frame (in `requestAnimationFrame` or React Three Fiber's `useFrame`): `at()`
 * for everyone else, `predicted()` for you. It listens from creation, starts over on reconnect,
 * and doesn't open the connection by itself.
 *
 * @example
 * ```ts
 * import { createWebSocketTimeline } from 'react-websocket/timeline';
 *
 * export const timeline = createWebSocketTimeline(game, {
 *   snapshot: m => (m.type === 'snapshot' ? { time: m.time, ack: m.ack, state: m.world } : undefined),
 *   interpolate: (from, to, t) => lerpWorld(from, to, t),
 *   latency,
 *   input: {
 *     send: (input: Move, seq) => ({ type: 'input', seq, ...input }),
 *     predict: (world, input) => move(world, me, input)
 *   }
 * });
 *
 * // Every frame:
 * draw(timeline.at(), timeline.predicted());
 * // On a key press:
 * timeline.input({ dx: 1, dy: 0 });
 * ```
 */
// `const` + `NoInfer`: take `In` and `Out` from the client only. `S` comes from `snapshot`, and
// `I` from how `input.send` annotates its parameter (`never` without `input`).
export function createWebSocketTimeline<In, const Out, S, I = never>(
  client: WebSocketClient<In, Out>,
  options: WebSocketTimelineOptions<S, I, NoInfer<In>, NoInfer<Out>>
): WebSocketTimeline<S, I> {
  const { interpolate, latency, input: inputs } = options;
  const delay = options.delay ?? 100;
  const extrapolate = options.extrapolate ?? 0;
  const keep = Math.max(2, options.buffer ?? 30);
  const listeners = new Set<() => void>();

  // Oldest first, `time` strictly increasing. `arrived` is `performance.now()` on receipt.
  let buffer: { snapshot: TimelineSnapshot<S>; arrived: number }[] = [];
  // Server time minus `performance.now()`, from the least delayed snapshot in the buffer.
  let arrival = -Infinity;
  // The last render time handed out, so that it never goes backward.
  let rendered = -Infinity;
  // A new connection opened: its first snapshot replaces the buffer.
  let stale = false;
  let seq = 0;
  let pending: { seq: number; input: I }[] = [];
  let prediction: S | undefined;
  // How many pending inputs `prediction` includes. `-1`: start again from the newest snapshot.
  let folded = -1;

  function notify() {
    for (const listener of [...listeners]) listener();
  }

  function clear() {
    buffer = [];
    arrival = rendered = -Infinity;
    stale = false;
  }

  function receive(snapshot: TimelineSnapshot<S>) {
    if (stale) clear();
    const newest = buffer.at(-1);
    // A WebSocket keeps order, so this is a duplicate or a server clock that stepped back.
    if (newest && snapshot.time <= newest.snapshot.time) return;
    buffer.push({ snapshot, arrived: performance.now() });
    if (buffer.length > keep) buffer.shift();
    arrival = -Infinity;
    for (const entry of buffer) arrival = Math.max(arrival, entry.snapshot.time - entry.arrived);
    const { ack } = snapshot;
    if (ack != null) pending = pending.filter(entry => entry.seq > ack);
    folded = -1;
    notify();
  }

  function renderTime() {
    if (!buffer.length) return;
    const measured = latency?.getSnapshot();
    // The server time of a snapshot arriving now: half a round trip behind the server's clock.
    const edge =
      measured?.offset !== undefined && measured.rtt !== undefined
        ? latency!.serverNow() - measured.rtt / 2
        : performance.now() + arrival;
    rendered = Math.max(rendered, edge - (typeof delay === 'function' ? delay() : delay));
    return rendered;
  }

  function at(time?: number): S | undefined {
    const n = buffer.length;
    if (!n) return;
    const t = time ?? renderTime()!;
    const last = buffer[n - 1]!.snapshot;
    if (t >= last.time) {
      const previous = buffer[n - 2]?.snapshot;
      if (!previous || !interpolate || !extrapolate || t === last.time) return last.state;
      const capped = Math.min(t, last.time + extrapolate);
      return interpolate(
        previous.state,
        last.state,
        (capped - previous.time) / (last.time - previous.time)
      );
    }
    // Reads are usually near the newest snapshot, so search from the end.
    let i = n - 2;
    while (i >= 0 && buffer[i]!.snapshot.time > t) i--;
    if (i < 0) return buffer[0]!.snapshot.state;
    const from = buffer[i]!.snapshot;
    const to = buffer[i + 1]!.snapshot;
    return !interpolate || t === from.time
      ? from.state
      : interpolate(from.state, to.state, (t - from.time) / (to.time - from.time));
  }

  function predicted(): S | undefined {
    const newest = buffer.at(-1);
    if (!newest) return;
    if (folded < 0) {
      prediction = newest.snapshot.state;
      folded = 0;
    }
    // Usually zero or one new input per frame; all of them once after each snapshot.
    while (folded < pending.length) {
      prediction = inputs!.predict(prediction!, pending[folded]!.input);
      folded++; // after `predict`, so one that throws is retried rather than skipped
    }
    return prediction;
  }

  const offs = [
    // Inputs on the old connection will never be confirmed. Keep showing the old snapshots
    // until the new connection sends its first one.
    client.on('open', () => {
      pending = [];
      folded = -1;
      stale = true;
    }),
    // A `snapshot` that throws leaves the timeline unchanged; the client re-throws it asynchronously.
    client.on('message', message => {
      const snapshot = options.snapshot(message);
      if (snapshot != null) receive(snapshot);
    })
  ];

  return {
    client,
    at,
    predicted,
    input(value) {
      const next = seq + 1;
      // Recorded only once it's sent, so a dropped input never shows as a move the server didn't make.
      const message = inputs!.send(value, next);
      if (!client.send(message, { volatile: true, maxBuffered: inputs!.maxBuffered })) return;
      seq = next;
      pending.push({ seq, input: value });
      if (pending.length > MAX_PENDING) {
        pending.shift();
        folded = -1;
      }
      return seq;
    },
    latest: () => buffer.at(-1)?.snapshot,
    renderTime,
    pending: () => pending.length,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    reset() {
      clear();
      pending = [];
      folded = -1;
      notify();
    },
    dispose() {
      offs.forEach(off => off());
    }
  };
}
