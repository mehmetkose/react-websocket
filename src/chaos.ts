/** A duration in ms, or `[min, max]` for a uniformly random one each time it's used. */
export type ChaosRange = number | readonly [min: number, max: number];

/** Faults to inject. All are off by default. Change them on a running class with `configure()`. */
export interface ChaosFaults {
  /**
   * Turn the random faults off without forgetting them. The controls (`drop()`, `stall()`,
   * `inject()`) work either way.
   * @default true
   */
  enabled?: boolean;
  /**
   * One-way delay in ms, added to the handshake (`open`), to every incoming message and to every
   * send. Order is preserved, as on a real connection. A round trip takes about twice this.
   * @default 0
   * @example
   * ```ts
   * latency: [50, 400]
   * ```
   */
  latency?: ChaosRange;
  /**
   * Probability (0–1) that a message is lost. A number applies to both directions.
   * @default 0
   * @example
   * ```ts
   * loss: { in: 0.05 } // lose 5% of incoming messages, none of the sends
   * ```
   */
  loss?: number | { in?: number; out?: number };
  /**
   * Probability (0–1) that a connection attempt fails before opening: `error`, then `close`
   * with code `1006`. The server never sees the attempt.
   * @default 0
   */
  refuse?: number;
  /**
   * Each open connection drops after a lifetime in this range, in ms: `error`, then `close` with
   * code `1006`, as when the network goes away.
   * @default false
   * @example
   * ```ts
   * drop: [10_000, 30_000]
   * ```
   */
  drop?: ChaosRange | false;
  /**
   * Each open connection goes silent after a lifetime in this range, in ms, like a socket left
   * half-open by a sleeping laptop: nothing arrives, sends vanish, `readyState` stays `OPEN`, and
   * no `close` event fires. Only a heartbeat timeout (or `close()`) gets out of it.
   * @default false
   */
  stall?: ChaosRange | false;
  /**
   * Probability (0–1) that an incoming message is cut short at a random point. Text also gets a
   * U+FFFD appended, so it never parses as JSON.
   * @default 0
   */
  corrupt?: number;
}

/** Options for {@link createChaosWebSocket}. */
export interface ChaosOptions extends ChaosFaults {
  /**
   * The `WebSocket` implementation to wrap, e.g. a mock in tests or the `ws` package in Node.
   * @default the global `WebSocket`, in browsers only
   */
  WebSocket?: typeof WebSocket;
  /**
   * Seed the random faults, so a run can be repeated. Each connection gets its own sequence, so
   * "the 3rd connection is refused" holds however much traffic the others carried.
   * @default unseeded (`Math.random`)
   */
  seed?: number;
  /**
   * Receives a message for every injected fault.
   * @example
   * ```ts
   * logger: console.warn
   * ```
   */
  logger?: (message: string, ...details: unknown[]) => void;
}

/**
 * Inject faults by hand into every connection made by one chaos class: from a dev panel, a
 * keyboard shortcut, the console or a test.
 */
export interface ChaosControls {
  /** Change faults while running, merged into the current ones. Open connections restart their `drop` and `stall` timers. */
  configure(faults: ChaosFaults): void;
  /**
   * Drop every connection now: `error`, then `close` with code `1006`. Pass a code to simulate the
   * server closing instead, e.g. `drop(4001, 'unauthorized')`: a clean close with no `error`.
   */
  drop(code?: number, reason?: string): void;
  /** Make every open connection go silent (see the `stall` option). */
  stall(): void;
  /**
   * Deliver `data` to every open connection as if the server had sent it, after any `latency`.
   * It is never lost or corrupted. Use it to try messages your server doesn't send.
   */
  inject(data: unknown): void;
}

/** A `WebSocket` class to pass as the `WebSocket` option, with {@link ChaosControls} as static methods. */
export type ChaosWebSocket = typeof WebSocket & ChaosControls;

type Data = Parameters<WebSocket['send']>[0];
type Timer = ReturnType<typeof setTimeout>;

const CONNECTING = 0;
const OPEN = 1;
const CLOSING = 2;
const CLOSED = 3;

function mulberry32(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick(range: ChaosRange, random: () => number) {
  return typeof range === 'number' ? range : range[0] + (range[1] - range[0]) * random();
}

function size(data: Data) {
  return new Blob([data as BlobPart]).size;
}

/** Cut `data` short at a random point. Text also gets U+FFFD, which no JSON document ends with. */
function garble(data: unknown, random: () => number): unknown {
  if (typeof data === 'string') return data.slice(0, Math.floor(random() * data.length)) + '�';
  const binary = data as { slice?: (start: number, end: number) => unknown } & Partial<Blob>;
  if (typeof binary?.slice !== 'function') return '�';
  const length = binary.size ?? (data as ArrayBuffer).byteLength;
  return binary.slice(0, Math.floor(random() * length));
}

function closeEvent(code: number, reason: string, wasClean: boolean): Event {
  const init = { code, reason, wasClean };
  // Node 22 has no CloseEvent.
  return typeof CloseEvent === 'function'
    ? new CloseEvent('close', init)
    : Object.assign(new Event('close'), init);
}

/**
 * Events delayed in order: each runs in its own task, no earlier than the one before it,
 * because a WebSocket never reorders. With no delay and nothing waiting, it runs right away.
 */
function createQueue() {
  let items: { at: number; run: () => void; data?: Data }[] = [];
  let timer: Timer | undefined;
  function next() {
    const head = items[0];
    if (timer !== undefined || !head) return;
    timer = setTimeout(() => {
      timer = undefined;
      try {
        items.shift()!.run();
      } finally {
        next();
      }
    }, head.at - Date.now());
  }
  return {
    push(delay: number, run: () => void, data?: Data) {
      if (delay <= 0 && !items.length) return run();
      items.push({ at: Math.max(Date.now() + delay, items.at(-1)?.at ?? 0), run, data });
      next();
    },
    clear() {
      items = [];
      clearTimeout(timer);
      timer = undefined;
    },
    bytes: () =>
      items.reduce((sum, item) => sum + (item.data === undefined ? 0 : size(item.data)), 0)
  };
}

/**
 * Create a `WebSocket` class that injects network faults: latency, lost and corrupt messages,
 * refused, dropped and silently stalled connections. Pass it as the `WebSocket` option in
 * development to see how your app behaves on a bad network.
 *
 * Each call returns a new class with its own faults, controls and random sequence.
 *
 * @example
 * ```ts
 * import { createWebSocket } from 'react-websocket';
 * import { createChaosWebSocket } from 'react-websocket/chaos';
 *
 * export const Chaos = createChaosWebSocket({ latency: [50, 400], drop: [10_000, 30_000] });
 *
 * export const live = createWebSocket('wss://api.example.com/live', {
 *   WebSocket: import.meta.env.DEV ? Chaos : undefined
 * });
 *
 * Chaos.stall(); // later, from a dev panel or the console
 * ```
 */
export function createChaosWebSocket(options: ChaosOptions = {}): ChaosWebSocket {
  const { WebSocket: wrapped, seed, logger, ...initial } = options;
  const log = logger ?? (() => {});
  let faults: ChaosFaults = initial;
  const live = new Set<ChaosSocket>();
  let count = 0;

  const enabled = () => faults.enabled !== false;
  const chance = (probability: number | undefined, random: () => number) =>
    enabled() && !!probability && random() < probability;
  const delay = (random: () => number) =>
    enabled() && faults.latency ? pick(faults.latency, random) : 0;
  const loss = (direction: 'in' | 'out') =>
    typeof faults.loss === 'object' ? faults.loss[direction] : faults.loss;
  // Independent sequences per connection and purpose, so one connection's traffic doesn't shift
  // the faults of the next.
  const stream = (n: number, k: number) =>
    seed === undefined ? Math.random : mulberry32(seed + Math.imul(3 * n + k, 0x9e3779b9));

  class ChaosSocket extends EventTarget implements WebSocket {
    static readonly CONNECTING = CONNECTING;
    static readonly OPEN = OPEN;
    static readonly CLOSING = CLOSING;
    static readonly CLOSED = CLOSED;
    readonly CONNECTING = CONNECTING;
    readonly OPEN = OPEN;
    readonly CLOSING = CLOSING;
    readonly CLOSED = CLOSED;

    readonly url: string;
    onopen: WebSocket['onopen'] = null;
    onmessage: WebSocket['onmessage'] = null;
    onerror: WebSocket['onerror'] = null;
    onclose: WebSocket['onclose'] = null;

    #state: WebSocket['readyState'] = CONNECTING;
    #inner: WebSocket | undefined;
    #binaryType: BinaryType = 'blob';
    #stalled = false;
    // Bytes sent into a stall: they never leave, like data stuck in a dead connection's buffer.
    #unsent = 0;
    #life: () => number;
    #in: () => number;
    #out: () => number;
    #incoming = createQueue();
    #outgoing = createQueue();
    #timers: Timer[] = [];

    static configure(next: ChaosFaults) {
      faults = { ...faults, ...next };
      if (!('drop' in next || 'stall' in next || 'enabled' in next)) return;
      for (const socket of [...live]) if (socket.#state === OPEN) socket.#arm();
    }

    static drop(code = 1006, reason = '') {
      // A copy: a close listener may connect again, and the new socket must survive.
      for (const socket of [...live]) socket.#drop(code, reason);
    }

    static stall() {
      for (const socket of [...live]) socket.#stall();
    }

    static inject(data: unknown) {
      for (const socket of [...live]) {
        if (socket.#state === OPEN) socket.#receive(() => socket.#message(data));
      }
    }

    constructor(url: string | URL, protocols?: string | string[]) {
      super();
      const Impl = wrapped ?? (typeof window === 'undefined' ? undefined : globalThis.WebSocket);
      if (!Impl) {
        throw new Error('react-websocket/chaos: no WebSocket to wrap here (server render?)');
      }
      for (const type of ['open', 'message', 'error', 'close'] as const) {
        this.addEventListener(type, event =>
          (this[`on${type}`] as ((event: Event) => void) | null)?.call(this, event)
        );
      }
      const n = ++count;
      this.#life = stream(n, 0);
      this.#in = stream(n, 1);
      this.#out = stream(n, 2);

      if (chance(faults.refuse, this.#life)) {
        log('chaos: refused', String(url));
        this.url = String(url);
        live.add(this);
        // Never synchronously: the caller attaches its handlers after construction.
        setTimeout(() => this.#end(1006, '', false, true), delay(this.#life));
        return;
      }

      const inner = new Impl(url, protocols);
      this.#inner = inner;
      this.url = inner.url;
      live.add(this);
      // Never set back to null: the `ws` package throws an unhandled error without an error handler.
      inner.onopen = () =>
        this.#receive(() => {
          if (this.#state !== CONNECTING) return;
          this.#state = OPEN;
          this.#arm();
          this.dispatchEvent(new Event('open'));
        }, this.#life);
      inner.onmessage = event => {
        if (this.#state === CLOSED || this.#stalled) return;
        if (chance(loss('in'), this.#in)) return log('chaos: lost an incoming message', event.data);
        let data: unknown = event.data;
        if (chance(faults.corrupt, this.#in)) {
          data = garble(data, this.#in);
          log('chaos: corrupted a message', event.data);
        }
        this.#receive(() => this.#message(data));
      };
      inner.onerror = () => this.#receive(() => this.dispatchEvent(new Event('error')));
      inner.onclose = event =>
        this.#receive(() => this.#end(event.code, event.reason, event.wasClean));
    }

    get readyState() {
      return this.#state;
    }

    get binaryType() {
      return this.#inner?.binaryType ?? this.#binaryType;
    }

    set binaryType(value) {
      this.#binaryType = value;
      if (this.#inner) this.#inner.binaryType = value;
    }

    get bufferedAmount() {
      return (this.#inner?.bufferedAmount ?? 0) + this.#outgoing.bytes() + this.#unsent;
    }

    get protocol() {
      return this.#inner?.protocol ?? '';
    }

    get extensions() {
      return this.#inner?.extensions ?? '';
    }

    send(data: Data) {
      if (this.#state === CONNECTING) {
        throw new DOMException('WebSocket is still in CONNECTING state', 'InvalidStateError');
      }
      if (this.#state !== OPEN) return;
      if (this.#stalled) {
        this.#unsent += size(data);
        return;
      }
      if (chance(loss('out'), this.#out)) return log('chaos: lost an outgoing message', data);
      const inner = this.#inner!;
      this.#outgoing.push(
        delay(this.#out),
        () => {
          if (inner.readyState === OPEN) inner.send(data);
        },
        data
      );
    }

    close(code?: number, reason?: string) {
      if (code !== undefined && code !== 1000 && !(code >= 3000 && code <= 4999)) {
        throw new DOMException(`Invalid close code ${code}`, 'InvalidAccessError');
      }
      if (this.#state >= CLOSING) return;
      const connecting = this.#state === CONNECTING;
      this.#state = CLOSING;
      const inner = this.#inner;
      if (inner && !this.#stalled) {
        // After anything still being sent, like a real close frame.
        this.#outgoing.push(delay(this.#out), () => inner.close(code, reason));
        return;
      }
      // Refused or stalled: the server can't answer, so the close handshake never completes.
      inner?.close(code, reason);
      setTimeout(() => this.#end(1006, '', false, connecting), 0);
    }

    /** Queue an event from the server, unless the connection is gone or silent. */
    #receive(run: () => void, random = this.#in) {
      if (this.#state === CLOSED || this.#stalled) return;
      this.#incoming.push(delay(random), () => {
        if (!this.#stalled) run();
      });
    }

    #message(data: unknown) {
      // Browsers don't deliver messages after `close()`.
      if (this.#state === OPEN) this.dispatchEvent(new MessageEvent('message', { data }));
    }

    /** (Re)start the `drop` and `stall` timers. */
    #arm() {
      for (const timer of this.#timers) clearTimeout(timer);
      this.#timers = [];
      if (!enabled()) return;
      const { drop, stall } = faults;
      if (drop !== undefined && drop !== false) {
        this.#timers.push(setTimeout(() => this.#drop(1006, ''), pick(drop, this.#life)));
      }
      if (stall !== undefined && stall !== false) {
        this.#timers.push(setTimeout(() => this.#stall(), pick(stall, this.#life)));
      }
    }

    #drop(code: number, reason: string) {
      log('chaos: dropped', this.url);
      this.#end(code, reason, code !== 1006, code === 1006);
    }

    #stall() {
      if (this.#state !== OPEN || this.#stalled) return;
      this.#stalled = true;
      log('chaos: stalled', this.url);
    }

    /** The only way to CLOSED, so it happens once. */
    #end(code: number, reason: string, wasClean: boolean, error = false) {
      if (this.#state === CLOSED) return;
      this.#state = CLOSED;
      live.delete(this);
      this.#incoming.clear();
      this.#outgoing.clear();
      for (const timer of this.#timers) clearTimeout(timer);
      // Free the server side of a connection we dropped, and say why in its logs.
      const inner = this.#inner;
      if (inner && inner.readyState < CLOSING) inner.close(4999, 'chaos');
      if (error) this.dispatchEvent(new Event('error'));
      this.dispatchEvent(closeEvent(code, reason, wasClean));
    }
  }

  return ChaosSocket;
}
