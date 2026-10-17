import {
  MessageError,
  type CloseInfo,
  type EventMap,
  type ReconnectOptions,
  type SendData,
  type SendOptions,
  type Snapshot,
  type StandardSchemaResult,
  type UrlSource,
  type WebSocketClient,
  type WebSocketOptions
} from './types';

const OPEN = 1;

const RECONNECT_DEFAULTS = {
  maxAttempts: Infinity,
  minDelay: 1000,
  maxDelay: 30_000,
  factor: 2,
  jitter: 0.5
} satisfies ReconnectOptions;

type Timer = ReturnType<typeof setTimeout> | undefined;

// React's `use()` reads `status`/`value`/`reason` off a thenable to skip suspending
// when it is already settled.
type TrackedPromise = Promise<void> & {
  status: 'pending' | 'fulfilled' | 'rejected';
  value?: void;
  reason?: unknown;
};

interface Deferred {
  readonly promise: TrackedPromise;
  settled: boolean;
  resolve(): void;
  reject(reason: unknown): void;
}

function createDeferred(): Deferred {
  let resolve!: () => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  }) as TrackedPromise;
  promise.status = 'pending';
  // Nobody may be awaiting `ready`; don't surface that as an unhandled rejection.
  promise.catch(() => {});
  const deferred: Deferred = {
    promise,
    settled: false,
    resolve() {
      if (deferred.settled) return;
      deferred.settled = true;
      promise.status = 'fulfilled';
      promise.value = undefined;
      resolve();
    },
    reject(reason) {
      if (deferred.settled) return;
      deferred.settled = true;
      promise.status = 'rejected';
      promise.reason = reason;
      reject(reason);
    }
  };
  return deferred;
}

function rethrowAsync(error: unknown) {
  queueMicrotask(() => {
    throw error;
  });
}

function isThenable<T>(value: unknown): value is PromiseLike<T> {
  return typeof (value as PromiseLike<T> | null)?.then === 'function';
}

/**
 * @internal Option key for a callback run when the client tears down, which lets the hooks'
 * URL registry forget clients nobody holds anymore. A registered symbol rather than an export,
 * because the hooks entry imports the client from the `core` entry at runtime.
 */
const ON_TEARDOWN = Symbol.for('react-websocket.onTeardown');

function createClient<In = unknown, Out = unknown>(
  url: UrlSource,
  options: WebSocketOptions<In, Out> & { [ON_TEARDOWN]?: () => void } = {}
): WebSocketClient<In, Out> {
  const onTeardown = options[ON_TEARDOWN];
  const log = options.logger ?? (() => {});
  const retry =
    options.reconnect === false
      ? null
      : {
          ...RECONNECT_DEFAULTS,
          ...(typeof options.reconnect === 'object' ? options.reconnect : {})
        };
  const queueLimit =
    options.queue === false
      ? 0
      : typeof options.queue === 'object'
        ? Math.max(0, options.queue.limit ?? Infinity)
        : Infinity;

  let snapshot: Snapshot<In> = { status: 'idle', lastMessage: undefined, attempt: 0 };
  const storeListeners = new Set<() => void>();
  const listeners: { [K in keyof EventMap<In>]: Set<EventMap<In>[K]> } = {
    open: new Set(),
    message: new Set(),
    close: new Set(),
    error: new Set()
  };

  let ws: WebSocket | null = null;
  let wanted = false;
  let refs = 0;
  // Set by a public `connect()`: stay connected after the last hook releases, until `close()`.
  let pinned = false;
  let pending: { data: SendData; key: string | undefined }[] = [];
  let ready: Deferred | null = null;
  // Opened at least once since the client was last started. `ready` stays resolved through
  // automatic reconnects so `use(client.ready)` doesn't swap content for a fallback on every blip.
  let opened = false;
  let unavailable: Deferred | null = null;
  let startScheduled = false;
  let inbox: Promise<void> | null = null;
  // Bumped per connection attempt so a slow `url()` can't resurrect a cancelled one.
  let generation = 0;
  let windowBound = false;
  let retryTimer: Timer;
  let teardownTimer: Timer;
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  let pongTimer: Timer;

  function set(patch: Partial<Snapshot<In>>) {
    snapshot = { ...snapshot, ...patch };
    for (const listener of [...storeListeners]) listener();
  }

  function emit<K extends keyof EventMap<In>>(type: K, ...args: Parameters<EventMap<In>[K]>) {
    for (const listener of [...listeners[type]]) {
      try {
        (listener as (...a: Parameters<EventMap<In>[K]>) => void)(...args);
      } catch (error) {
        rethrowAsync(error);
      }
    }
  }

  function getImpl(): typeof WebSocket | undefined {
    if (options.WebSocket) return options.WebSocket;
    // Node has a global WebSocket too; don't connect from a server render.
    return typeof window === 'undefined' ? undefined : globalThis.WebSocket;
  }

  function rejectReady(reason: unknown) {
    if (!ready || ready.settled) ready = createDeferred();
    ready.reject(reason);
  }

  function retryNow() {
    if (retryTimer !== undefined) {
      log('network or visibility change, retrying now');
      open();
    }
  }

  function onVisibilityChange() {
    if (document.visibilityState === 'visible') retryNow();
  }

  function bindWindow() {
    if (windowBound || typeof window === 'undefined') return;
    windowBound = true;
    window.addEventListener('online', retryNow);
    document.addEventListener('visibilitychange', onVisibilityChange);
  }

  function unbindWindow() {
    if (!windowBound) return;
    windowBound = false;
    window.removeEventListener('online', retryNow);
    document.removeEventListener('visibilitychange', onVisibilityChange);
  }

  function startHeartbeat(socket: WebSocket) {
    const heartbeat = options.heartbeat;
    if (!heartbeat) return;
    heartbeatTimer = setInterval(() => {
      socket.send(heartbeat.message ?? 'ping');
      if (heartbeat.timeout && pongTimer === undefined) {
        pongTimer = setTimeout(() => {
          log('heartbeat timeout');
          // The close handshake may never finish on a dead link, so don't wait for it.
          detach(socket, false);
          socket.close(4000, 'heartbeat timeout');
          handleClose({ code: 4000, reason: 'heartbeat timeout', wasClean: false });
        }, heartbeat.timeout);
      }
    }, heartbeat.interval);
  }

  function stopHeartbeat() {
    clearInterval(heartbeatTimer);
    clearTimeout(pongTimer);
    heartbeatTimer = pongTimer = undefined;
  }

  /** Stop tracking `socket`. Its eventual close event is still reported unless `reportClose` is false. */
  function detach(socket: WebSocket, reportClose: boolean) {
    if (ws === socket) ws = null;
    socket.onopen = socket.onmessage = socket.onerror = null;
    socket.onclose = reportClose
      ? event => emit('close', { code: event.code, reason: event.reason, wasClean: event.wasClean })
      : null;
  }

  function backoff(attempt: number) {
    const { minDelay, maxDelay, factor, jitter } = retry!;
    const base = Math.min(maxDelay, minDelay * factor ** (attempt - 1));
    return Math.round(base * (1 - jitter * Math.random()));
  }

  function open() {
    clearTimeout(retryTimer);
    retryTimer = undefined;
    const Impl = getImpl();
    if (!Impl) return;
    const id = ++generation;
    set({ status: snapshot.attempt === 0 ? 'connecting' : 'reconnecting' });

    let target: string | Promise<string>;
    try {
      target = typeof url === 'string' ? url : url();
    } catch (error) {
      urlFailed(error);
      return;
    }
    if (typeof target === 'string') {
      start(Impl, target);
      return;
    }
    Promise.resolve(target).then(
      resolved => {
        if (id === generation && wanted) start(Impl, resolved);
      },
      error => {
        if (id === generation && wanted) urlFailed(error);
      }
    );
  }

  /** `url()` threw or rejected (e.g. a token refresh failed): count it as a failed attempt. */
  function urlFailed(error: unknown) {
    const reason = error instanceof Error ? error : new Error(String(error));
    log('url() failed', reason);
    emit('error', reason);
    retryOrFail({ code: 1006, reason: 'url() failed', wasClean: false }, reason);
  }

  function start(Impl: typeof WebSocket, target: string) {
    let socket: WebSocket;
    try {
      socket = new Impl(target, options.protocols);
    } catch (error) {
      // e.g. an invalid URL; retrying won't help.
      emit('error', error as Error);
      fail(error);
      return;
    }
    if (options.binaryType) socket.binaryType = options.binaryType;
    ws = socket;
    log('connecting', target);

    socket.onopen = event => {
      log('open');
      opened = true;
      set({ status: 'open', attempt: 0 });
      startHeartbeat(socket);
      ready?.resolve();
      // `open` listeners go first, so a handshake sent from `onOpen` (e.g. auth) precedes
      // whatever was queued while disconnected.
      emit('open', event);
      if (ws !== socket) return; // a listener closed or replaced it
      const queued = pending;
      pending = [];
      for (const { data } of queued) socket.send(data);
    };
    socket.onmessage = event => receive(event, socket);
    socket.onerror = event => emit('error', event);
    socket.onclose = event => {
      detach(socket, false);
      handleClose({ code: event.code, reason: event.reason, wasClean: event.wasClean });
    };
  }

  function handleClose(info: CloseInfo) {
    stopHeartbeat();
    log('closed', info);
    retryOrFail(info);
    emit('close', info);
  }

  function retryOrFail(info: CloseInfo, error?: Error) {
    if (
      wanted &&
      retry &&
      snapshot.attempt < retry.maxAttempts &&
      (retry.shouldReconnect?.(info) ?? true)
    ) {
      const attempt = snapshot.attempt + 1;
      const delay = backoff(attempt);
      set({ status: 'reconnecting', attempt });
      log(`reconnecting in ${delay}ms (attempt ${attempt})`);
      retryTimer = setTimeout(open, delay);
    } else {
      fail(
        error ??
          new Error(`WebSocket closed (code ${info.code}${info.reason ? `: ${info.reason}` : ''})`)
      );
    }
  }

  function fail(reason: unknown) {
    wanted = false;
    opened = false;
    unbindWindow();
    pending = [];
    set({ status: 'closed' });
    rejectReady(reason);
  }

  function receive(event: MessageEvent, socket: WebSocket) {
    clearTimeout(pongTimer);
    pongTimer = undefined;
    if (options.heartbeat?.pong !== undefined && event.data === options.heartbeat.pong) return;

    // Async schema validation must not reorder messages.
    const run = () => decode(event, socket);
    if (inbox) {
      const next: Promise<void> = inbox.then(run).then(() => {
        if (inbox === next) inbox = null;
      });
      inbox = next;
      return;
    }
    const result = run();
    if (result) {
      const next: Promise<void> = result.then(() => {
        if (inbox === next) inbox = null;
      });
      inbox = next;
    }
  }

  function decode(event: MessageEvent, socket: WebSocket): void | Promise<void> {
    let value: unknown;
    try {
      value = options.parse
        ? options.parse(event.data)
        : options.json
          ? JSON.parse(event.data as string)
          : event.data;
    } catch (cause) {
      emit('error', new MessageError('Failed to parse message', event.data, { cause }));
      return;
    }

    const schema = options.schema;
    if (!schema) return deliver(value as In, event, socket);

    let result: ReturnType<(typeof schema)['~standard']['validate']>;
    try {
      result = schema['~standard'].validate(value);
    } catch (cause) {
      emit('error', new MessageError('Schema validation threw', event.data, { cause }));
      return;
    }
    if (isThenable<StandardSchemaResult<In>>(result)) {
      return Promise.resolve(result).then(
        r => validated(r, event, socket),
        cause => emit('error', new MessageError('Schema validation threw', event.data, { cause }))
      );
    }
    validated(result, event, socket);
  }

  function validated(result: StandardSchemaResult<In>, event: MessageEvent, socket: WebSocket) {
    if (result.issues) {
      emit(
        'error',
        new MessageError('Message failed schema validation', event.data, { issues: result.issues })
      );
    } else {
      deliver(result.value, event, socket);
    }
  }

  function deliver(message: In, event: MessageEvent, socket: WebSocket) {
    if (ws !== socket) return; // closed or replaced while validating
    set({ lastMessage: message });
    emit('message', message, event);
  }

  function send(message: Out, sendOptions?: SendOptions): boolean {
    const data = options.serialize
      ? options.serialize(message)
      : options.json
        ? JSON.stringify(message)
        : (message as SendData);
    if (ws && ws.readyState === OPEN) {
      ws.send(data);
      return true;
    }
    if (queueLimit === 0 || sendOptions?.volatile) {
      log('dropped message: socket is not open');
      return false;
    }
    if (!getImpl()) {
      // e.g. during a server render: this client can never connect, so don't hold on to it.
      log('dropped message: no WebSocket implementation available');
      return false;
    }
    const key = sendOptions?.key;
    if (key !== undefined) pending = pending.filter(entry => entry.key !== key);
    pending.push({ data, key });
    if (pending.length > queueLimit) {
      pending.shift();
      log(`dropped oldest queued message: queue limit (${queueLimit}) reached`);
    }
    return false;
  }

  function begin() {
    wanted = true;
    // Starting over after `close()` or giving up: wait for a new connection.
    if (snapshot.status === 'idle' || snapshot.status === 'closed') {
      opened = false;
      if (ready?.settled) ready = null;
    }
    snapshot = { ...snapshot, attempt: 0 }; // open() notifies
    bindWindow();
    open();
  }

  /** Start connecting unless already wanted. Used by holders (`acquire`, `ready`). */
  function ensureConnecting() {
    if (wanted || !getImpl()) return;
    begin();
  }

  function connect() {
    pinned = true;
    ensureConnecting();
  }

  function stop(code?: number, reason?: string) {
    wanted = false;
    generation++;
    clearTimeout(retryTimer);
    retryTimer = undefined;
    stopHeartbeat();
    unbindWindow();
    pending = [];
    if (ws) {
      const socket = ws;
      detach(socket, true);
      socket.close(code, reason);
    }
  }

  function close(code = 1000, reason?: string) {
    pinned = false;
    opened = false;
    stop(code, reason);
    set({ status: 'closed', attempt: 0 });
    rejectReady(new Error('WebSocket was closed'));
  }

  function reconnect() {
    if (!getImpl()) return;
    clearTimeout(retryTimer);
    retryTimer = undefined;
    stopHeartbeat();
    if (ws) {
      const socket = ws;
      detach(socket, true);
      socket.close(1000, 'reconnect');
    }
    begin();
  }

  function teardown() {
    if (refs > 0 || pinned) return;
    // Someone may be suspended on `ready`; let the attempt finish.
    if (ready && !ready.settled) return;
    stop();
    ready = null;
    opened = false;
    set({ status: 'idle', attempt: 0 });
    onTeardown?.();
  }

  function acquire() {
    refs++;
    clearTimeout(teardownTimer);
    if (snapshot.status === 'idle') ensureConnecting();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (--refs > 0) return;
      // Deferred so StrictMode's unmount/remount and route transitions don't churn the socket.
      clearTimeout(teardownTimer);
      teardownTimer = setTimeout(teardown, 0);
    };
  }

  return {
    url,
    get ready() {
      if (!getImpl()) {
        if (!unavailable) {
          unavailable = createDeferred();
          unavailable.reject(
            new Error('react-websocket: no WebSocket available here (server render?)')
          );
        }
        return unavailable.promise;
      }
      if (snapshot.status === 'idle' && !startScheduled) {
        // `ready` is read during render; start outside of it.
        startScheduled = true;
        queueMicrotask(() => {
          startScheduled = false;
          if (snapshot.status === 'idle') ensureConnecting();
        });
      }
      if (!ready) {
        ready = createDeferred();
        if (opened) ready.resolve();
      }
      return ready.promise;
    },
    get socket() {
      return ws;
    },
    subscribe(listener) {
      storeListeners.add(listener);
      return () => {
        storeListeners.delete(listener);
      };
    },
    getSnapshot: () => snapshot,
    on(type, listener) {
      // Wrap so the same function can be subscribed twice and unsubscribed independently.
      const entry = ((...args: unknown[]) =>
        (listener as (...a: unknown[]) => void)(...args)) as typeof listener;
      listeners[type].add(entry);
      return () => {
        listeners[type].delete(entry);
      };
    },
    send,
    connect,
    close,
    reconnect,
    acquire
  };
}

/**
 * Create a WebSocket client, usually at module level, to share across components.
 *
 * Nothing connects until a hook uses it, `ready` is read, or `connect()` is called.
 * It closes one tick after the last hook unmounts, unless `connect()` was called.
 *
 * @param url - A URL, or a function (sync or async) called before every connection
 *   attempt, e.g. to put a fresh auth token in the URL on each reconnect.
 * @typeParam In - Type of incoming messages. Inferred from `options.schema` if given.
 * @typeParam Out - Type accepted by `send()`.
 *
 * @example
 * ```ts
 * type ChatIn = { user: string; text: string };
 * type ChatOut = { text: string };
 *
 * export const chat = createWebSocket<ChatIn, ChatOut>('wss://api.example.com/chat', { json: true });
 * ```
 */
export function createWebSocket<In = unknown, Out = unknown>(
  url: UrlSource,
  options?: WebSocketOptions<In, Out>
): WebSocketClient<In, Out> {
  return createClient(url, options);
}
