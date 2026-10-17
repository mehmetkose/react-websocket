import type { WebSocketClient } from './types';

/** Options for {@link createWebSocketLatency}: how pings and pongs look on the wire. */
export interface WebSocketLatencyOptions<In, Out> {
  /** The ping message, tagged with `id`. Sent with `volatile`, so pings are never queued. */
  ping: (id: number) => Out;
  /**
   * Recognize a pong: return the `id` of the ping it answers, and the server's clock
   * (`Date.now()` on the server, in ms) when it replied. Return `undefined` (or `null`)
   * for any other message. Without `time`, only the round-trip time is measured.
   */
  pong: (message: In) => { id: number | string; time?: number } | null | undefined;
  /**
   * How often to ping while open, in ms. The first ping goes out as soon as the socket opens.
   * @default 2000
   */
  interval?: number;
  /**
   * How many recent measurements to keep. `rtt` is their median, and `offset` comes from
   * the one with the lowest round trip, the most accurate estimate.
   * @default 5
   */
  samples?: number;
}

/** Latest latency measurements. A new object is created on every change. */
export interface Latency {
  /** Round-trip time in ms: the median of recent pings. `undefined` until the first pong. */
  readonly rtt: number | undefined;
  /**
   * Estimated server clock minus local clock, in ms. Add it to `Date.now()` for server time.
   * `undefined` until a pong carries `time`.
   */
  readonly offset: number | undefined;
}

/** Round-trip time and server clock offset for one client. Create with {@link createWebSocketLatency}. */
export interface WebSocketLatency {
  /** The client being measured. Hooks reading the latency keep it connected. */
  readonly client: WebSocketClient<any, any>;
  /** The current {@link Latency}. Returns the same object until it changes. */
  getSnapshot(): Latency;
  /** Called whenever a measurement changes. Compatible with `useSyncExternalStore`. */
  subscribe(listener: () => void): () => void;
  /** The estimated server time: `Date.now() + offset`, or `Date.now()` before any estimate. */
  serverNow(): number;
  /** Ping now instead of waiting for the next interval. Does nothing unless the socket is open. */
  ping(): void;
  /** Stop pinging and listening. Only needed for instances created dynamically. */
  dispose(): void;
}

const EMPTY: Latency = Object.freeze({ rtt: undefined, offset: undefined });

function median(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

/**
 * Measure round-trip time and estimate the server's clock, for ping displays, countdowns
 * and timestamps that must agree across players.
 *
 * Pings are sent on an interval while the socket is open, and paused otherwise. Measurements
 * from a previous connection are discarded on reconnect, but the last values stay readable
 * until new ones arrive. It doesn't open the connection by itself.
 *
 * Pongs are ordinary messages: they also reach `onMessage`, `lastMessage` and state stores.
 *
 * @example
 * ```ts
 * export const latency = createWebSocketLatency(game, {
 *   ping: id => ({ type: 'ping', id }),
 *   pong: message => (message.type === 'pong' ? { id: message.id, time: message.time } : undefined)
 * });
 *
 * // In a component:
 * const { rtt } = useWebSocketLatency(latency);
 *
 * // Anywhere: seconds left in a round that ends at the server's `endsAt`.
 * const left = (endsAt - latency.serverNow()) / 1000;
 * ```
 */
// `const` + `NoInfer`: take `In` and `Out` from the client only, and keep literals such as
// `type: 'ping'` from widening to `string` inside the callbacks.
export function createWebSocketLatency<In, const Out>(
  client: WebSocketClient<In, Out>,
  options: WebSocketLatencyOptions<NoInfer<In>, NoInfer<Out>>
): WebSocketLatency {
  const interval = options.interval ?? 2000;
  const keep = Math.max(1, options.samples ?? 5);
  const listeners = new Set<() => void>();
  let snapshot = EMPTY;
  // Ping id -> `performance.now()` when sent. Pongs that never come are evicted oldest first.
  const inFlight = new Map<string, number>();
  let samples: { rtt: number; offset: number | undefined }[] = [];
  let nextId = 0;
  let timer: ReturnType<typeof setInterval> | undefined;

  function ping() {
    if (client.getSnapshot().status !== 'open') return;
    const id = ++nextId;
    inFlight.set(String(id), performance.now());
    if (inFlight.size > keep * 2) inFlight.delete(inFlight.keys().next().value!);
    client.send(options.ping(id), { volatile: true });
  }

  function start() {
    stop();
    inFlight.clear();
    samples = [];
    ping();
    timer = setInterval(ping, interval);
  }

  function stop() {
    clearInterval(timer);
    timer = undefined;
  }

  function measure(id: string, serverTime: number | undefined) {
    const sentAt = inFlight.get(id);
    if (sentAt === undefined) return;
    inFlight.delete(id);
    const rtt = performance.now() - sentAt;
    // The server read its clock about halfway through the round trip.
    const offset = serverTime === undefined ? undefined : serverTime + rtt / 2 - Date.now();
    samples.push({ rtt, offset });
    if (samples.length > keep) samples.shift();

    let best: (typeof samples)[number] | undefined;
    for (const sample of samples) {
      if (sample.offset !== undefined && (!best || sample.rtt < best.rtt)) best = sample;
    }
    snapshot = {
      rtt: median(samples.map(sample => sample.rtt)),
      offset: best ? best.offset : snapshot.offset
    };
    for (const listener of [...listeners]) listener();
  }

  const offs = [
    client.on('open', start),
    client.on('message', message => {
      const pong = options.pong(message);
      if (pong != null) measure(String(pong.id), pong.time);
    }),
    client.subscribe(() => {
      if (client.getSnapshot().status !== 'open') stop();
    })
  ];
  if (client.getSnapshot().status === 'open') start();

  return {
    client,
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    serverNow: () => Date.now() + (snapshot.offset ?? 0),
    ping,
    dispose() {
      stop();
      offs.forEach(off => off());
    }
  };
}
