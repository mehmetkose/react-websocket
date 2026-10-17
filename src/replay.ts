// An entry with no imports: it only implements the `WebSocket` interface.

/** Data in a recording: text as it was, binary as base64. */
export type RecordedData = string | { readonly binary: string };

/** One event of a recorded connection, `t` ms after it was created. */
export type RecordedEvent =
  | { readonly t: number; readonly type: 'open'; readonly protocol: string }
  | { readonly t: number; readonly type: 'send' | 'message'; readonly data: RecordedData }
  | { readonly t: number; readonly type: 'error' }
  | {
      readonly t: number;
      readonly type: 'close';
      readonly code: number;
      readonly reason: string;
      readonly wasClean: boolean;
    };

/** A recorded event before its time is known. */
type Untimed = RecordedEvent extends infer E
  ? E extends RecordedEvent
    ? Omit<E, 't'>
    : never
  : never;

/** A recorded session: every connection, in the order they were opened. Plain JSON. */
export interface WebSocketRecording {
  readonly format: 'react-websocket-recording';
  readonly version: 1;
  readonly connections: readonly {
    readonly url: string;
    /** When it was created, from `Date.now()`. */
    readonly at: number;
    readonly events: readonly RecordedEvent[];
  }[];
}

/** The class from {@link createRecordingWebSocket}: a `WebSocket` that records what it does. */
export interface RecordingWebSocket extends Statics {
  new (url: string | URL, protocols?: string | string[]): WebSocket;
  readonly prototype: WebSocket;
  /** Everything recorded so far, as a new plain object. */
  recording(): WebSocketRecording;
  /** Download the recording as a JSON file, e.g. from a "Report a problem" button. */
  save(filename?: string): void;
  /** Forget everything recorded so far. */
  clear(): void;
}

/** Options for {@link createReplayWebSocket}. */
export interface ReplayOptions {
  /**
   * How fast to replay: `1` is the recorded timing, `4` four times faster, `Infinity` as fast as
   * possible, each event in a task of its own.
   * @default 1
   */
  speed?: number;
  /**
   * Wait for the app to send before replaying what came after a send in the recording, so the
   * replay follows the app instead of the clock: a server's answer comes after the question,
   * however long the app takes to ask. `false` follows the recorded timing alone.
   * @default true
   */
  waitForSends?: boolean;
}

/** The class from {@link createReplayWebSocket}: a `WebSocket` that plays a recording back. */
export interface ReplayWebSocket extends Statics {
  new (url: string | URL, protocols?: string | string[]): WebSocket;
  readonly prototype: WebSocket;
  /** What the app sent during the replay, by connection, as recorded data. */
  readonly sent: readonly RecordedData[][];
  /** Resolves once every recorded connection has been played to its end. */
  readonly done: Promise<void>;
  /** Start again from the first recorded connection. */
  reset(): void;
}

interface Statics {
  readonly CONNECTING: 0;
  readonly OPEN: 1;
  readonly CLOSING: 2;
  readonly CLOSED: 3;
}

const CONNECTING = 0;
const OPEN = 1;
const CLOSING = 2;
const CLOSED = 3;

function closeEvent(code: number, reason: string, wasClean: boolean): Event {
  const init = { code, reason, wasClean };
  // Node 22 has no CloseEvent.
  return typeof CloseEvent === 'function'
    ? new CloseEvent('close', init)
    : Object.assign(new Event('close'), init);
}

function encode(bytes: ArrayBuffer | ArrayBufferView): RecordedData {
  const view =
    bytes instanceof ArrayBuffer
      ? new Uint8Array(bytes)
      : new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let text = '';
  for (const byte of view) text += String.fromCharCode(byte);
  return { binary: btoa(text) };
}

function decode(data: RecordedData, binaryType: BinaryType): unknown {
  if (typeof data === 'string') return data;
  const buffer = Uint8Array.from(atob(data.binary), char => char.charCodeAt(0)).buffer;
  return binaryType === 'blob' ? new Blob([buffer]) : buffer;
}

/** Shared by both classes: the `WebSocket` surface over a state and some events. */
class Base extends EventTarget {
  static readonly CONNECTING = CONNECTING;
  static readonly OPEN = OPEN;
  static readonly CLOSING = CLOSING;
  static readonly CLOSED = CLOSED;
  readonly CONNECTING = CONNECTING;
  readonly OPEN = OPEN;
  readonly CLOSING = CLOSING;
  readonly CLOSED = CLOSED;
  readonly url: string;
  readonly extensions = '';
  onopen: WebSocket['onopen'] = null;
  onmessage: WebSocket['onmessage'] = null;
  onerror: WebSocket['onerror'] = null;
  onclose: WebSocket['onclose'] = null;
  protocol = '';
  state: WebSocket['readyState'] = CONNECTING;

  constructor(url: string | URL) {
    super();
    this.url = String(url);
    for (const type of ['open', 'message', 'error', 'close'] as const) {
      this.addEventListener(type, event =>
        (this[`on${type}`] as ((event: Event) => void) | null)?.call(this, event)
      );
    }
  }

  get readyState() {
    return this.state;
  }

  opened(protocol: string) {
    this.state = OPEN;
    this.protocol = protocol;
    this.dispatchEvent(new Event('open'));
  }

  received(data: unknown) {
    if (this.state === OPEN) this.dispatchEvent(new MessageEvent('message', { data }));
  }

  ended(code: number, reason: string, wasClean: boolean) {
    if (this.state === CLOSED) return;
    this.state = CLOSED;
    this.dispatchEvent(closeEvent(code, reason, wasClean));
  }
}

/**
 * A `WebSocket` class that records what its connections do: when each one opened, every message
 * sent and received, errors and closes. Pass it as the `WebSocket` option, and get the session
 * back with `recording()`, or download it with `save()`, to attach to a bug report or replay
 * with {@link createReplayWebSocket}.
 *
 * Recordings hold every message, so they can hold tokens and personal data: record in
 * development, or ask before saving one from a user's session.
 *
 * @example
 * ```ts
 * import { createRecordingWebSocket } from 'react-websocket/replay';
 *
 * export const Recorder = createRecordingWebSocket();
 * export const live = createWebSocket(url, { WebSocket: Recorder });
 *
 * reportButton.onclick = () => Recorder.save('session.json');
 * ```
 */
export function createRecordingWebSocket(
  options: { WebSocket?: typeof WebSocket } = {}
): RecordingWebSocket {
  let connections: { url: string; at: number; events: RecordedEvent[] }[] = [];

  class RecordingSocket extends Base implements WebSocket {
    #inner: WebSocket;
    #binaryType: BinaryType = 'blob';

    static recording(): WebSocketRecording {
      return JSON.parse(
        JSON.stringify({ format: 'react-websocket-recording', version: 1, connections })
      );
    }

    static save(filename = 'websocket-recording.json') {
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(RecordingSocket.recording(), null, 2)], {
          type: 'application/json'
        })
      );
      const link = Object.assign(document.createElement('a'), { href: url, download: filename });
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 0);
    }

    static clear() {
      connections = [];
    }

    constructor(url: string | URL, protocols?: string | string[]) {
      super(url);
      const Impl = options.WebSocket ?? globalThis.WebSocket;
      const inner = (this.#inner = new Impl(url, protocols));
      // Binary data arrives as an ArrayBuffer, to record it without waiting on a Blob.
      inner.binaryType = 'arraybuffer';
      const start = performance.now();
      const events: RecordedEvent[] = [];
      connections.push({ url: this.url, at: Date.now(), events });
      const record = (event: Untimed) =>
        events.push({ t: Math.round(performance.now() - start), ...event } as RecordedEvent);
      this.#record = record;
      inner.onopen = () => {
        record({ type: 'open', protocol: inner.protocol ?? '' });
        this.opened(inner.protocol);
      };
      inner.onmessage = event => {
        const data = event.data as string | ArrayBuffer;
        record({ type: 'message', data: typeof data === 'string' ? data : encode(data) });
        this.received(
          typeof data === 'string' || this.#binaryType !== 'blob' ? data : new Blob([data])
        );
      };
      inner.onerror = () => {
        record({ type: 'error' });
        this.dispatchEvent(new Event('error'));
      };
      inner.onclose = event => {
        record({ type: 'close', code: event.code, reason: event.reason, wasClean: event.wasClean });
        this.ended(event.code, event.reason, event.wasClean);
      };
    }

    #record: (event: Untimed) => void;

    get binaryType() {
      return this.#binaryType;
    }

    set binaryType(value) {
      this.#binaryType = value;
    }

    get bufferedAmount() {
      return this.#inner.bufferedAmount;
    }

    send(data: Parameters<WebSocket['send']>[0]) {
      this.#inner.send(data);
      if (typeof data === 'string') this.#record({ type: 'send', data });
      else if (data instanceof Blob) {
        // Recorded where it was sent; its bytes are filled in once read.
        const event = { type: 'send', data: { binary: '' } } as const;
        this.#record(event);
        void data.arrayBuffer().then(buffer => Object.assign(event.data, encode(buffer)));
      } else this.#record({ type: 'send', data: encode(data) });
    }

    close(code?: number, reason?: string) {
      if (this.state >= CLOSING) return;
      this.state = CLOSING;
      this.#inner.close(code, reason);
    }
  }

  return RecordingSocket as unknown as RecordingWebSocket;
}

/**
 * A `WebSocket` class that plays a recording back, without a server: each connection the client
 * opens replays the next recorded one, with its open, messages, errors and close, at the recorded
 * timing or faster. For reproducing a bug report, offline demos, and UI tests that don't call a
 * live backend, such as an AI model, on every run.
 *
 * By default, what came after a send in the recording waits until the app sends too, so the
 * replay follows the app. Wrap it with `createChaosWebSocket({ WebSocket: Replay })` to add
 * faults.
 *
 * @example
 * ```ts
 * import { createReplayWebSocket } from 'react-websocket/replay';
 * import recording from './fixtures/chat.json';
 *
 * const Replay = createReplayWebSocket(recording, { speed: Infinity });
 * render(<Chat client={createWebSocket(url, { WebSocket: Replay })} />);
 * await Replay.done;
 * ```
 */
export function createReplayWebSocket(
  recording: WebSocketRecording,
  options: ReplayOptions = {}
): ReplayWebSocket {
  const speed = options.speed ?? 1;
  const waitForSends = options.waitForSends ?? true;
  let next = 0;
  let sent: RecordedData[][] = [];
  let finish: () => void;
  let done = new Promise<void>(resolve => (finish = resolve));
  const live = new Set<ReplaySocket>();

  class ReplaySocket extends Base implements WebSocket {
    binaryType: BinaryType = 'blob';
    readonly bufferedAmount = 0;
    #events: readonly RecordedEvent[];
    #index = 0;
    #sent: RecordedData[] = [];
    // The recorded time the timeline is at, and the real time it was there.
    #recordedAt = 0;
    #realAt = performance.now();
    #timer: ReturnType<typeof setTimeout> | undefined;
    // Recorded sends passed so far, and whether the timeline waits for the app to send.
    #sends = 0;
    #paused = false;

    static get sent() {
      return sent;
    }

    static get done() {
      return done;
    }

    static reset() {
      for (const socket of live) socket.#stop();
      next = 0;
      sent = [];
      done = new Promise<void>(resolve => (finish = resolve));
    }

    constructor(url: string | URL, protocols?: string | string[]) {
      super(url);
      void protocols;
      const connection = recording.connections[next++];
      sent.push(this.#sent);
      // More connections than were recorded: refused, like a server that's gone.
      this.#events = connection?.events ?? [
        { t: 0, type: 'error' },
        { t: 0, type: 'close', code: 1006, reason: '', wasClean: false }
      ];
      live.add(this);
      this.#schedule();
    }

    send(data: Parameters<WebSocket['send']>[0]) {
      if (this.state === CONNECTING) {
        throw new DOMException('WebSocket is still in CONNECTING state', 'InvalidStateError');
      }
      if (this.state !== OPEN) return;
      this.#sent.push(
        typeof data === 'string' ? data : data instanceof Blob ? { binary: '' } : encode(data)
      );
      if (this.#paused) {
        this.#paused = false;
        this.#schedule();
      }
    }

    close(code = 1000, reason = '') {
      if (this.state >= CLOSING) return;
      this.state = CLOSING;
      this.#stop();
      setTimeout(() => this.ended(code, reason, true), 0);
    }

    #schedule(): void {
      clearTimeout(this.#timer);
      const event = this.#events[this.#index];
      if (!event || this.state === CLOSED) return this.#finished();
      if (event.type === 'send') {
        if (waitForSends) {
          // Wait until the app has sent as many messages, then go on from that moment.
          if (this.#sent.length <= this.#sends) return void (this.#paused = true);
          this.#recordedAt = event.t;
          this.#realAt = performance.now();
        }
        this.#index++;
        this.#sends++;
        return this.#schedule();
      }
      const wait = (event.t - this.#recordedAt) / speed - (performance.now() - this.#realAt);
      this.#timer = setTimeout(
        () => this.#play(event),
        Math.max(0, Number.isFinite(wait) ? wait : 0)
      );
    }

    #play(event: RecordedEvent) {
      this.#index++;
      this.#recordedAt = event.t;
      this.#realAt = performance.now();
      if (event.type === 'open') this.opened(event.protocol);
      else if (event.type === 'message') this.received(decode(event.data, this.binaryType));
      else if (event.type === 'error') this.dispatchEvent(new Event('error'));
      else if (event.type === 'close') {
        this.#stop();
        return this.ended(event.code, event.reason, event.wasClean);
      }
      this.#schedule();
    }

    #stop() {
      clearTimeout(this.#timer);
      this.#index = this.#events.length;
      this.#finished();
    }

    #finished() {
      live.delete(this);
      if (next >= recording.connections.length && !live.size) finish();
    }
  }

  return ReplaySocket as unknown as ReplayWebSocket;
}
