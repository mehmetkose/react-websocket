import type { WebSocketLatency } from './latency';
import type { WebSocketClient } from './types';

type Timer = ReturnType<typeof setTimeout>;

/** Options for {@link createWebSocketSendRate}. */
export interface WebSocketSendRateOptions {
  /**
   * Ticks per second while the connection keeps up.
   * @default 30
   */
  maxRate?: number;
  /**
   * The rate never drops below this, in ticks per second.
   * @default 5
   */
  minRate?: number;
  /**
   * Bytes waiting in the browser's send buffer (`socket.bufferedAmount`) above which a tick
   * sends nothing and the rate halves.
   * @default 1024
   */
  maxBuffered?: number;
  /**
   * Measurements from `createWebSocketLatency` on the same client. With them, a round-trip time
   * that rises also lowers the rate. Without them, only the send buffer is watched.
   */
  latency?: Pick<WebSocketLatency, 'getSnapshot'>;
  /**
   * How far `rtt` may rise above the lowest one measured on this connection before the rate
   * halves, in ms. A steady high ping keeps the full rate; only a rising one counts.
   * @default 100
   */
  maxRttIncrease?: number;
}

/** The current send rate. A new object is created on every change. */
export interface SendRate {
  /** Ticks per second, rounded. */
  readonly rate: number;
  /**
   * Whether the last tick found the link congested: the send buffer above `maxBuffered`, or
   * `rtt` risen more than `maxRttIncrease`.
   */
  readonly congested: boolean;
}

/** Keyed sends coalesced at a rate that adapts to the link. Create with {@link createWebSocketSendRate}. */
export interface WebSocketSendRate<Out> {
  /** The client the messages are sent on. */
  readonly client: WebSocketClient<any, Out>;
  /**
   * Send `message` at the next tick. A message with the same `key` still waiting for it is
   * replaced, so only the newest one goes out. Sent with `volatile`.
   */
  send(message: Out, key: string): void;
  /** Send everything waiting now, e.g. right before a one-shot action that must carry the latest aim. */
  flush(): void;
  /** The current {@link SendRate}. Returns the same object until it changes. */
  getSnapshot(): SendRate;
  /** Called whenever the rate or `congested` changes. Compatible with `useSyncExternalStore`. */
  subscribe(listener: () => void): () => void;
  /** Stop sending and listening. Only needed for instances created dynamically. */
  dispose(): void;
}

const VOLATILE = { volatile: true };

/**
 * Send high-rate state, such as aim, cursor or position, at a rate that adapts to the
 * connection. Messages are coalesced per key between ticks. The rate drops by half when the
 * send buffer fills up or the round trip grows, and climbs back one tick per second at a time
 * when the link keeps up, so players on a poor connection degrade smoothly instead of building
 * up lag.
 *
 * Ticks run only while the socket is open and something is waiting. Messages waiting during a
 * reconnect go out after it; `close()` drops them. It doesn't open the connection by itself.
 *
 * @example
 * ```ts
 * export const stream = createWebSocketSendRate(game, { latency, maxRate: 30 });
 *
 * // On every pointer move: at most 30 a second, fewer on a congested link.
 * stream.send({ type: 'aim', angle }, 'aim');
 * ```
 */
export function createWebSocketSendRate<Out>(
  client: WebSocketClient<any, Out>,
  options: WebSocketSendRateOptions = {}
): WebSocketSendRate<Out> {
  const { maxBuffered = 1024, latency, maxRttIncrease = 100 } = options;
  const maxRate = options.maxRate ?? 30;
  const minRate = Math.min(options.minRate ?? 5, maxRate);
  const listeners = new Set<() => void>();
  // Insertion order is send order: a replaced message moves to the end.
  const pending = new Map<string, Out>();
  let rate = maxRate;
  let snapshot: SendRate = { rate: maxRate, congested: false };
  let last = -Infinity; // `performance.now()` at the last tick
  let best = Infinity; // the lowest `rtt` on this connection
  let slow = false; // `rtt` has risen too far above `best`
  let measured: unknown; // the latency snapshot already reacted to
  let timer: Timer | undefined;
  let disposed = false;

  function flush() {
    for (const [key, message] of pending) {
      if (!client.send(message, VOLATILE)) return; // not open: keep the rest for later
      pending.delete(key);
    }
  }

  function publish(congested: boolean) {
    const rounded = Math.round(rate);
    if (rounded === snapshot.rate && congested === snapshot.congested) return;
    snapshot = { rate: rounded, congested };
    for (const listener of [...listeners]) listener();
  }

  function schedule() {
    if (disposed || timer !== undefined || !pending.size || client.getSnapshot().status !== 'open')
      return;
    // Right away after a pause, otherwise one interval after the last tick.
    timer = setTimeout(tick, Math.max(0, last + 1000 / rate - performance.now()));
  }

  function stop() {
    clearTimeout(timer);
    timer = undefined;
  }

  // Additive increase, multiplicative decrease, as TCP does.
  function tick() {
    timer = undefined;
    last = performance.now();
    const measurement = latency?.getSnapshot();
    if (measurement !== measured) {
      // React to each measurement once.
      measured = measurement;
      const rtt = measurement?.rtt;
      if (rtt !== undefined) {
        best = Math.min(best, rtt);
        slow = rtt - best > maxRttIncrease;
        if (slow) rate /= 2;
      }
    }
    // Checked once per tick, not per message, so messages in one tick don't count against each other.
    const full = (client.socket?.bufferedAmount ?? 0) > maxBuffered;
    if (full) rate /= 2;
    else {
      flush();
      if (!slow) rate++;
    }
    rate = Math.min(maxRate, Math.max(minRate, rate));
    publish(full || slow);
    schedule();
  }

  const offs = [
    client.on('open', () => {
      // A new connection may take a different route: measure its best round trip afresh, and
      // ignore the last connection's measurement, which stays readable until a new one arrives.
      best = Infinity;
      slow = false;
      measured = latency?.getSnapshot();
      schedule(); // after the client's own queue, which is sent once `open` listeners return
    }),
    client.subscribe(() => {
      const { status } = client.getSnapshot();
      if (status !== 'open') stop();
      // Like the client's queue: kept through a reconnect, dropped by `close()` or giving up.
      if (status === 'closed' || status === 'idle') pending.clear();
    })
  ];

  return {
    client,
    send(message, key) {
      pending.delete(key);
      pending.set(key, message);
      schedule();
    },
    flush,
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    dispose() {
      disposed = true;
      stop();
      pending.clear();
      offs.forEach(off => off());
    }
  };
}
