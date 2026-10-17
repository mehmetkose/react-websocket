/**
 * Where to connect: a URL, or a function that returns one (sync or async).
 *
 * A function is called before **every** connection attempt, including reconnects,
 * so it can put a fresh auth token in the URL. If it throws or rejects, that counts
 * as a failed attempt and is retried with backoff.
 *
 * @example
 * ```ts
 * createWebSocket(async () => `wss://api.example.com/live?token=${await getToken()}`);
 * ```
 */
export type UrlSource = string | (() => string | Promise<string>);

/**
 * Connection state.
 *
 * - `idle`: not connected and not trying to be. Nobody is using the client yet, or everyone stopped.
 * - `connecting`: the first attempt is in progress.
 * - `open`: connected. `send()` goes out immediately.
 * - `reconnecting`: the connection dropped (or an attempt failed) and a retry is scheduled or in progress.
 * - `closed`: stopped for good, by `close()` or after giving up on reconnecting.
 *   It stays closed until `connect()` or `reconnect()` is called, or every hook unmounts.
 */
export type Status = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'closed';

/** The client's state as seen by React. A new object is created on every change. */
export interface Snapshot<In> {
  /** Connection state. */
  readonly status: Status;
  /** Most recent message (after `parse`/`json` and `schema`), kept across reconnects. */
  readonly lastMessage: In | undefined;
  /**
   * Consecutive failed attempts since the last stable connection. A connection that closes
   * within `reconnect.minUptime` of opening counts as failed. `0` while open.
   */
  readonly attempt: number;
}

/** Details of a closed connection, from the browser's `CloseEvent`. */
export interface CloseInfo {
  /** Close code: `1000` is a normal close, `1006` an abnormal one (e.g. network loss), `4000`–`4999` are yours. */
  readonly code: number;
  /** Close reason sent by the side that closed the connection. Often empty. */
  readonly reason: string;
  /** Whether the closing handshake completed. */
  readonly wasClean: boolean;
}

/** Anything `WebSocket.prototype.send` accepts: a string, `Blob`, `ArrayBuffer` or typed array. */
export type SendData = Parameters<WebSocket['send']>[0];

/** Reconnect timing. Delay before attempt `n` = `min(maxDelay, minDelay * factor ** (n - 1))`, minus jitter. */
export interface ReconnectOptions {
  /**
   * Maximum consecutive reconnect attempts. When the last one fails too, the client
   * gives up: the status becomes `closed` and `ready` rejects. `0` never retries.
   * @default Infinity
   */
  maxAttempts?: number;
  /**
   * How long a connection must stay open, in ms, before the backoff resets. One that closes
   * sooner counts as a failed attempt, so a server that accepts and then closes right away
   * (e.g. rejecting the credentials sent on open) is retried with a growing delay, and
   * `maxAttempts` still applies. `0` resets on every open.
   * @default 5000
   */
  minUptime?: number;
  /**
   * Delay before the first retry, in ms.
   * @default 1000
   */
  minDelay?: number;
  /**
   * Upper bound for the delay, in ms.
   * @default 30000
   */
  maxDelay?: number;
  /**
   * Backoff multiplier applied per attempt.
   * @default 2
   */
  factor?: number;
  /**
   * Randomly shave up to this fraction (0–1) off each delay, so that many clients
   * dropped at once don't all reconnect at the same moment. The default `1` picks each
   * delay at random between 0 and the backoff ("full jitter").
   * @default 1
   */
  jitter?: number;
  /**
   * Called on every unexpected close. Return `false` to stop reconnecting.
   *
   * The default, `retryableClose`, retries everything except `1002` (protocol error), `1003`
   * (unsupported data) and `1008` (policy violation). Your own function replaces it; call
   * `retryableClose` from it to keep that rule, or return `true` to retry every close.
   *
   * @example
   * ```ts
   * import { retryableClose } from 'react-websocket';
   *
   * // Also stop when our server rejects the credentials.
   * shouldReconnect: close => close.code !== 4001 && retryableClose(close)
   * ```
   * @default retryableClose
   */
  shouldReconnect?: (close: CloseInfo) => boolean;
}

/** Application-level keep-alive. Useful behind proxies that drop idle connections. */
export interface HeartbeatOptions {
  /** Send `message` every `interval` ms while open. */
  interval: number;
  /**
   * Sent as-is (it is not passed through `serialize` or `json`).
   * @default 'ping'
   */
  message?: string;
  /** Incoming data equal to this string is swallowed instead of being delivered as a message. */
  pong?: string;
  /**
   * If nothing at all arrives within this many ms after a ping, the connection is
   * treated as dead: it closes with code `4000` and reconnects.
   */
  timeout?: number;
}

/** Per-message options for `send()`. */
export interface SendOptions {
  /**
   * Drop the message instead of queueing it when the socket isn't open. For data that
   * is stale by the time a reconnect finishes, such as player input or cursor positions.
   * @default false
   */
  volatile?: boolean;
  /**
   * Keep only the newest queued message with this key. Sending again with the same key
   * while disconnected replaces the earlier one, which moves to the back of the queue
   * (or of the `priority` messages, for a priority one).
   * For state where only the latest value matters, such as "my position is now (x, y)".
   */
  key?: string;
  /**
   * Queue this message ahead of every message queued without `priority`, after earlier
   * priority messages. For control messages that must not wait behind a backlog, such as
   * cancel, interrupt or a token refresh. Messages sent from `open` listeners still go first.
   *
   * It only matters while the socket isn't open: once a message is handed to the browser,
   * nothing can overtake it. To keep that buffer short, send bulky streams with `maxBuffered`.
   * @default false
   */
  priority?: boolean;
  /**
   * Drop the message instead of sending it while more than this many bytes are already
   * waiting in the browser's send buffer (`socket.bufferedAmount`). For high-rate streams on
   * a slow link, such as audio frames or per-tick input, where a late message is worse than
   * none. `send()` returns `false`, and `onDrop` isn't called.
   *
   * Only checked while the socket is open: a message queued while disconnected is sent on
   * open regardless. `bufferedAmount` includes what you sent earlier in the same task, so set
   * it well above one burst of messages.
   *
   * @example
   * ```ts
   * voice.send(frame, { volatile: true, maxBuffered: 64 * 1024 });
   * ```
   */
  maxBuffered?: number;
  /**
   * Called if the message is dropped from the queue without being sent: replaced by a
   * newer message with the same `key`, or evicted by `queue.limit`. Not called when the
   * queue is cleared because the client closed or gave up, or when `send()` drops the
   * message right away (`volatile` while not open, or `maxBuffered`) and returns `false`.
   */
  onDrop?: () => void;
}

/** Bounds for the send queue. */
export interface QueueOptions {
  /**
   * Maximum number of messages held while not connected. When full, the oldest
   * message is dropped, skipping `priority` messages unless nothing else is queued.
   * `Infinity` keeps every message.
   * @default 100
   */
  limit?: number;
}

/**
 * The minimal [Standard Schema v1](https://standardschema.dev) interface, implemented
 * by zod (3.24+), valibot (1.0+), arktype (2.0+) and others. You don't need to
 * import this; pass your schema object directly.
 */
export interface StandardSchemaV1<Input = unknown, Output = Input> {
  readonly '~standard': {
    readonly version: 1;
    readonly vendor: string;
    readonly validate: (
      value: unknown
    ) => StandardSchemaResult<Output> | Promise<StandardSchemaResult<Output>>;
    readonly types?: { readonly input: Input; readonly output: Output } | undefined;
  };
}

/** The result of a Standard Schema `validate` call. */
export type StandardSchemaResult<Output> =
  | { readonly value: Output; readonly issues?: undefined }
  | { readonly issues: ReadonlyArray<{ readonly message: string }> };

/**
 * Connection options, shared by `createWebSocket(url, options)` and `useWebSocket(url, options)`.
 *
 * @typeParam In - Type of incoming messages (after `parse`/`json`/`schema`).
 * @typeParam Out - Type accepted by `send()`.
 */
export interface WebSocketOptions<In = unknown, Out = unknown> {
  /** Sub-protocol(s) passed to the `WebSocket` constructor. */
  protocols?: string | string[];
  /**
   * How binary messages are exposed.
   * @default 'blob'
   */
  binaryType?: BinaryType;
  /**
   * `JSON.parse` incoming and `JSON.stringify` outgoing messages. Messages that fail
   * to parse are reported to `onError` as a {@link MessageError} and not delivered.
   * @default false
   */
  json?: boolean;
  /**
   * Custom decoder for incoming `event.data`. Takes precedence over `json`.
   * Throwing reports a {@link MessageError} and drops the message.
   */
  parse?: (data: unknown) => unknown;
  /** Custom encoder for outgoing messages. Takes precedence over `json`. */
  serialize?: (message: Out) => SendData;
  /**
   * Validate incoming messages (after parsing) with any Standard Schema library.
   * Invalid messages are reported to `onError` as a {@link MessageError} and not delivered.
   * The message type `In` is inferred from it.
   *
   * @example
   * ```ts
   * createWebSocket(url, { json: true, schema: z.object({ price: z.number() }) });
   * ```
   */
  schema?: StandardSchemaV1<unknown, In>;
  /**
   * Reconnect with exponential backoff after an unexpected close. `false` disables it.
   * @default true
   */
  reconnect?: boolean | ReconnectOptions;
  /** Send a ping on an interval and, optionally, reconnect when the server goes quiet. */
  heartbeat?: HeartbeatOptions;
  /**
   * Buffer `send()` calls made while not connected and send them, in order, on open
   * (right after `open` listeners run). It holds up to 100 messages, dropping the oldest;
   * `{ limit }` changes that. `false` drops messages instead of queueing them.
   * The queue is cleared by `close()` or when the client gives up.
   * @default true
   */
  queue?: boolean | QueueOptions;
  /**
   * Receives debug messages about connection attempts, retries and dropped messages.
   * @example
   * ```ts
   * logger: console.debug
   * ```
   */
  logger?: (message: string, ...details: unknown[]) => void;
  /**
   * `WebSocket` implementation to use, e.g. a mock in tests or the `ws` package in Node.
   * When omitted, the global `WebSocket` is used in browsers. During a server render
   * (no `window`), nothing connects unless an implementation is passed.
   */
  WebSocket?: typeof WebSocket;
}

/**
 * Reported via the `error` event (and `onError`) when an incoming message can't be
 * decoded by `parse`/`json` or fails `schema` validation. The message is not delivered.
 *
 * @example
 * ```ts
 * onError(error) {
 *   if (error instanceof MessageError) report(error.data, error.issues);
 * }
 * ```
 */
export class MessageError extends Error {
  /** The raw `event.data` that failed. */
  readonly data: unknown;
  /** Schema validation issues, when the message failed `schema`. */
  readonly issues: ReadonlyArray<{ readonly message: string }> | undefined;

  constructor(
    message: string,
    data: unknown,
    options?: { cause?: unknown; issues?: ReadonlyArray<{ readonly message: string }> }
  ) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'MessageError';
    this.data = data;
    this.issues = options?.issues;
  }
}

/** Events emitted by a client. Subscribe with `client.on(type, listener)` or `useWebSocketEvent`. */
export interface EventMap<In> {
  /**
   * The socket opened (initially or after a reconnect). Listeners run before queued
   * messages are sent, so a handshake sent from here goes out first.
   */
  open: (event: Event) => void;
  /** A message arrived and passed `parse` and `schema`. */
  message: (message: In, event: MessageEvent) => void;
  /** A socket closed, whether it will be retried or not. */
  close: (close: CloseInfo) => void;
  /**
   * A socket error `Event`, a {@link MessageError} for an undecodable or invalid message,
   * or the `Error` thrown by the `WebSocket` constructor or a `url` function.
   */
  error: (error: Event | MessageError | Error) => void;
}

/**
 * A WebSocket connection that reconnects, queues, decodes and can be shared.
 * Create one with `createWebSocket()`.
 *
 * The connection is reference-counted: it opens when the first hook mounts (or
 * `ready` is read) and closes one tick after the last hook unmounts. Calling
 * `connect()` keeps it open regardless, until `close()`.
 *
 * @typeParam In - Type of incoming messages.
 * @typeParam Out - Type accepted by `send()`.
 */
export interface WebSocketClient<In = unknown, Out = unknown> {
  /** The URL (or URL function) the client was created with. */
  readonly url: UrlSource;
  /**
   * A promise that resolves once the socket has opened. Reading it starts an idle client.
   *
   * It stays resolved through automatic reconnects, so `use(client.ready)` shows a
   * Suspense fallback only for the first connection, never on a network blip; use
   * `status` to show reconnects. It rejects when the client gives up reconnecting, when
   * `close()` is called, and during a server render. After that, `connect()` or
   * `reconnect()` make it a new pending promise.
   *
   * It is safe to pass to React 19's `use()`: the same promise is returned until its state
   * changes, and it carries `status`/`value`/`reason` so `use()` doesn't suspend when it is
   * already settled.
   */
  readonly ready: Promise<void>;
  /** The current underlying `WebSocket`, if any. An escape hatch; prefer the client's methods. */
  readonly socket: WebSocket | null;
  /** Subscribe to snapshot changes. Compatible with `useSyncExternalStore`. Returns an unsubscribe function. */
  subscribe(listener: () => void): () => void;
  /** The current {@link Snapshot}. Returns the same object until something changes. */
  getSnapshot(): Snapshot<In>;
  /**
   * Listen to an event. Returns an unsubscribe function. Listener errors are re-thrown
   * asynchronously, so one failing listener doesn't break the others.
   */
  on<K extends keyof EventMap<In>>(type: K, listener: EventMap<In>[K]): () => void;
  /**
   * Send a message (encoded with `serialize`/`json` if configured). If the socket isn't
   * open, the message is queued and sent on open (see the `queue` option), unless
   * `options.volatile` is set.
   * @returns `true` if it was sent immediately, `false` if it was queued or dropped
   *   (`volatile` while not open, or `maxBuffered` while open).
   *
   * @example
   * ```ts
   * game.send({ type: 'input', dx, dy }, { volatile: true }); // never replayed after a reconnect
   * game.send({ type: 'position', x, y }, { key: 'position' }); // only the newest is queued
   * game.send({ type: 'leave' }, { priority: true }); // ahead of everything already queued
   * ```
   */
  send(message: Out, options?: SendOptions): boolean;
  /**
   * Start connecting, and keep the connection open even when no hook is using the
   * client, until `close()` is called. Does nothing if already connecting or open.
   */
  connect(): void;
  /**
   * Close the connection and stop reconnecting. The status becomes `closed` and the
   * send queue is cleared. Mounted hooks stay mounted; call `connect()` or `reconnect()`
   * to start again.
   * @param code - Close code. @default 1000
   */
  close(code?: number, reason?: string): void;
  /**
   * Drop the current socket (if any) and connect again immediately, resetting the
   * backoff. Also restarts a `closed` client.
   */
  reconnect(): void;
  /**
   * Hold the connection open until the returned function is called. This is what the
   * hooks use; call it yourself to integrate with non-React code.
   * @returns A release function (safe to call more than once).
   */
  acquire(): () => void;
}
