/** A URL, or a function resolving one before each connection attempt (e.g. with a fresh token). */
export type UrlSource = string | (() => string | Promise<string>);

export type Status = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'closed';

export interface Snapshot<In> {
  /** Connection state. */
  readonly status: Status;
  /** Most recent parsed message, kept across reconnects. */
  readonly lastMessage: In | undefined;
  /** Consecutive failed attempts since the last successful open. */
  readonly attempt: number;
}

export interface CloseInfo {
  readonly code: number;
  readonly reason: string;
  readonly wasClean: boolean;
}

export type SendData = Parameters<WebSocket['send']>[0];

export interface ReconnectOptions {
  /** Give up after this many consecutive failures. Default: Infinity. */
  maxAttempts?: number;
  /** Delay before the first retry, in ms. Default: 1000. */
  minDelay?: number;
  /** Upper bound for the delay, in ms. Default: 30000. */
  maxDelay?: number;
  /** Backoff multiplier. Default: 2. */
  factor?: number;
  /** Randomly shave up to this fraction off each delay (0–1). Default: 0.5. */
  jitter?: number;
  /** Return false to stop reconnecting after this close. Default: always reconnect. */
  shouldReconnect?: (close: CloseInfo) => boolean;
}

export interface HeartbeatOptions {
  /** Send `message` every `interval` ms while open. */
  interval: number;
  /** Default: 'ping'. */
  message?: string;
  /** Incoming data equal to this is swallowed instead of being delivered as a message. */
  pong?: string;
  /** Treat the connection as dead if nothing arrives within this many ms after a ping. */
  timeout?: number;
}

/** Minimal Standard Schema v1 interface (https://standardschema.dev): zod, valibot, arktype, … */
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

export type StandardSchemaResult<Output> =
  | { readonly value: Output; readonly issues?: undefined }
  | { readonly issues: ReadonlyArray<{ readonly message: string }> };

export interface WebSocketOptions<In = unknown, Out = unknown> {
  protocols?: string | string[];
  binaryType?: BinaryType;
  /** JSON.parse incoming and JSON.stringify outgoing messages. */
  json?: boolean;
  /** Custom decoder for incoming data; takes precedence over `json`. */
  parse?: (data: unknown) => unknown;
  /** Custom encoder for outgoing messages; takes precedence over `json`. */
  serialize?: (message: Out) => SendData;
  /** Validate (and type) incoming messages after parsing. */
  schema?: StandardSchemaV1<unknown, In>;
  /** `false` disables reconnecting. Default: true. */
  reconnect?: boolean | ReconnectOptions;
  heartbeat?: HeartbeatOptions;
  /** Buffer `send()` calls made while not open and flush them on open. Default: true. */
  queue?: boolean;
  /** e.g. `console.debug` */
  logger?: (message: string, ...details: unknown[]) => void;
  /** WebSocket implementation. Default: the browser's global WebSocket. */
  WebSocket?: typeof WebSocket;
}

/** Raised (via the `error` event) when an incoming message fails `parse` or `schema`. */
export class MessageError extends Error {
  readonly data: unknown;
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

export interface EventMap<In> {
  open: (event: Event) => void;
  message: (message: In, event: MessageEvent) => void;
  close: (close: CloseInfo) => void;
  /** A socket error `Event`, a `MessageError`, or the error thrown while constructing the socket. */
  error: (error: Event | MessageError | Error) => void;
}

export interface WebSocketClient<In = unknown, Out = unknown> {
  readonly url: UrlSource;
  /** Resolves once open. Reading it starts an idle connection. Rejects if the client gives up or is closed. */
  readonly ready: Promise<void>;
  /** The underlying socket, if any. Escape hatch. */
  readonly socket: WebSocket | null;
  /** `useSyncExternalStore`-compatible store. */
  subscribe(listener: () => void): () => void;
  getSnapshot(): Snapshot<In>;
  on<K extends keyof EventMap<In>>(type: K, listener: EventMap<In>[K]): () => void;
  /** Sends now if open, otherwise queues (see `queue`). Returns true if sent immediately. */
  send(message: Out): boolean;
  connect(): void;
  /** Closes and stops reconnecting. Status becomes `closed`. */
  close(code?: number, reason?: string): void;
  /** Drops the current socket (if any) and connects again immediately. */
  reconnect(): void;
  /** Keep the connection alive while held. Returns the release function. */
  acquire(): () => void;
}
