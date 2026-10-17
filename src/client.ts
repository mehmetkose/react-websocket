import {
  MessageError,
  type CloseInfo,
  type EventMap,
  type ReconnectOptions,
  type SendData,
  type MigrateOptions,
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
  jitter: 1,
  minUptime: 5000
} satisfies ReconnectOptions;

const QUEUE_LIMIT = 100;

// The longest delay `setTimeout` takes; anything longer fires at once.
const MAX_TIMEOUT = 2 ** 31 - 1;

type Timer = ReturnType<typeof setTimeout> | undefined;

/**
 * The default `reconnect.shouldReconnect`: retry every close except `1002` (protocol error),
 * `1003` (unsupported data) and `1008` (policy violation, often a rejected login), which
 * retrying the same way can't fix. Call it from your own `shouldReconnect` to keep that rule.
 *
 * @example
 * ```ts
 * createWebSocket(url, {
 *   // Also stop on our server's "invalid token" code.
 *   reconnect: { shouldReconnect: close => close.code !== 4001 && retryableClose(close) }
 * });
 * ```
 */
export function retryableClose(close: CloseInfo): boolean {
  return close.code !== 1002 && close.code !== 1003 && close.code !== 1008;
}

/**
 * The default `reconnect.retryAfter`: for a `1012` (Service Restart) or `1013` (Try Again Later)
 * close whose reason is a number of seconds, like an HTTP `Retry-After` header, that delay in ms.
 * Call it from your own `retryAfter` to keep reading it.
 *
 * @example
 * ```ts
 * createWebSocket(url, {
 *   // Our server also closes with 4429 and the delay in ms as the reason.
 *   reconnect: { retryAfter: close => (close.code === 4429 ? Number(close.reason) : retryAfter(close)) }
 * });
 * ```
 */
export function retryAfter(close: CloseInfo): number | undefined {
  return (close.code === 1012 || close.code === 1013) && /^\s*\d+(\.\d+)?\s*$/.test(close.reason)
    ? Number(close.reason) * 1000
    : undefined;
}

// How long a connection opened only by reading `ready` waits for a holder before closing.
// Long enough for React to retry a suspended render and commit its hooks.
const READY_GRACE = 5000;

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

/** @internal Method key for what `react-websocket/devtools` shows that the snapshot doesn't. */
const INSPECT = Symbol.for('react-websocket.inspect');

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
  const queue = typeof options.queue === 'object' ? options.queue : {};
  const queueLimit = options.queue === false ? 0 : Math.max(0, queue.limit ?? QUEUE_LIMIT);
  const queueMaxAge = queue.maxAge ?? Infinity;

  let snapshot: Snapshot<In> = { status: 'idle', lastMessage: undefined, attempt: 0 };
  const storeListeners = new Set<() => void>();
  const listeners: { [K in keyof EventMap<In>]: Set<EventMap<In>[K]> } = {
    open: new Set(),
    message: new Set(),
    close: new Set(),
    error: new Set()
  };

  let ws: WebSocket | null = null;
  // The new connection of a `migrate()`, until it opens and replaces `ws`.
  let incoming: WebSocket | null = null;
  // Where `migrate()` moved the client, used instead of `url` until it stops.
  let moved: UrlSource | undefined;
  let wanted = false;
  let refs = 0;
  // Set by a public `connect()`: stay connected after the last hook releases, until `close()`.
  let pinned = false;
  // Priority messages form the head of the queue, in the order they were sent.
  let pending: {
    data: SendData;
    key: string | undefined;
    priority: boolean | undefined;
    onDrop: (() => void) | undefined;
    // `Date.now()`, not `performance.now()`, which can stand still while the computer sleeps.
    expires: number;
  }[] = [];
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
  // Consecutive failed attempts, for the backoff. Unlike `snapshot.attempt`, which reads 0 while
  // open, it resets only once a connection stays up for `minUptime`, so a server that accepts
  // and then closes right away (e.g. rejecting the auth sent on open) still gets backed off.
  let failures = 0;
  // The pending retry waits because the server asked it to (1013 or `retryAfter`), so coming
  // back online or to the tab doesn't cut it short.
  let serverWait = false;
  let retryTimer: Timer;
  let migrateTimer: Timer;
  let teardownTimer: Timer;
  let stableTimer: Timer;
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  let pongTimer: Timer;

  function set(patch: Partial<Snapshot<In>>) {
    snapshot = { ...snapshot, ...patch };
    for (const listener of [...storeListeners]) {
      try {
        listener();
      } catch (error) {
        rethrowAsync(error);
      }
    }
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

  /** The network or the tab came back: retry now, or check that an open connection still works. */
  function wake() {
    if (retryTimer !== undefined) {
      if (serverWait) return;
      log('network or visibility change, retrying now');
      open();
    } else if (heartbeatTimer !== undefined && pongTimer === undefined) {
      // After sleep or a network change, a socket can be dead while still reading OPEN.
      log('network or visibility change, checking the connection');
      ping(ws!);
    }
  }

  function onVisibilityChange() {
    if (document.visibilityState === 'visible') wake();
  }

  function bindWindow() {
    if (windowBound || typeof window === 'undefined') return;
    windowBound = true;
    window.addEventListener('online', wake);
    document.addEventListener('visibilitychange', onVisibilityChange);
  }

  function unbindWindow() {
    if (!windowBound) return;
    windowBound = false;
    window.removeEventListener('online', wake);
    document.removeEventListener('visibilitychange', onVisibilityChange);
  }

  /** Send a heartbeat ping and, with a `timeout`, close the socket if nothing comes back. */
  function ping(socket: WebSocket) {
    const heartbeat = options.heartbeat!;
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
  }

  function startHeartbeat(socket: WebSocket) {
    if (options.heartbeat) heartbeatTimer = setInterval(ping, options.heartbeat.interval, socket);
  }

  /** Stop the timers that belong to the current open socket. */
  function stopSocketTimers() {
    clearInterval(heartbeatTimer);
    clearTimeout(pongTimer);
    clearTimeout(stableTimer);
    heartbeatTimer = pongTimer = stableTimer = undefined;
  }

  /** Stop tracking `socket`. Its eventual close event is still reported unless `reportClose` is false. */
  function detach(socket: WebSocket, reportClose: boolean) {
    if (ws === socket) ws = null;
    socket.onopen = socket.onmessage = socket.onerror = null;
    socket.onclose = reportClose
      ? event => emit('close', { code: event.code, reason: event.reason, wasClean: event.wasClean })
      : null;
  }

  /** The delay before attempt `n`; `slow` starts at `maxDelay`, for a server shedding load. */
  function backoff(attempt: number, slow: boolean) {
    const { minDelay, maxDelay, factor, jitter } = retry!;
    const base = slow ? maxDelay : Math.min(maxDelay, minDelay * factor ** (attempt - 1));
    return Math.round(base * (1 - jitter * Math.random()));
  }

  /** Stop a `migrate()` that hasn't switched yet. */
  function dropIncoming() {
    if (incoming) {
      detach(incoming, false);
      incoming.close();
      incoming = null;
    }
  }

  /**
   * Start a connection attempt. A `handoff` (from `migrate()`) opens beside the current
   * connection, which keeps working until the new one opens.
   */
  function open(handoff?: boolean) {
    if (!handoff) {
      clearTimeout(retryTimer);
      retryTimer = undefined;
      serverWait = false;
      dropIncoming();
    }
    const Impl = getImpl();
    if (!Impl) return;
    const id = ++generation;
    if (!handoff) set({ status: snapshot.attempt === 0 ? 'connecting' : 'reconnecting' });

    const source = moved ?? url;
    let target: string | Promise<string>;
    try {
      target = typeof source === 'string' ? source : source();
    } catch (error) {
      urlFailed(error, handoff);
      return;
    }
    if (typeof target === 'string') {
      start(Impl, target, handoff);
      return;
    }
    Promise.resolve(target).then(
      resolved => {
        if (id === generation && wanted) start(Impl, resolved, handoff);
      },
      error => {
        if (id === generation && wanted) urlFailed(error, handoff);
      }
    );
  }

  /**
   * `url()` threw or rejected (e.g. a token refresh failed): count it as a failed attempt,
   * unless it was for a handoff, which leaves the current connection in place.
   */
  function urlFailed(error: unknown, handoff?: boolean) {
    const reason = error instanceof Error ? error : new Error(String(error));
    log('url() failed', reason);
    emit('error', reason);
    if (!handoff) retryOrFail({ code: 1006, reason: 'url() failed', wasClean: false }, reason);
  }

  function start(Impl: typeof WebSocket, target: string, handoff?: boolean) {
    let socket: WebSocket;
    try {
      socket = new Impl(target, options.protocols);
    } catch (error) {
      // e.g. an invalid URL; retrying won't help.
      emit('error', error as Error);
      if (!handoff) fail(error);
      return;
    }
    if (options.binaryType) socket.binaryType = options.binaryType;
    if (handoff) incoming = socket;
    else ws = socket;
    log('connecting', target);

    socket.onopen = event => {
      if (handoff) {
        // The switch: the new connection takes over, then the old one closes. If the old one
        // dropped meanwhile, this one replaces the pending retry.
        incoming = null;
        clearTimeout(retryTimer);
        retryTimer = undefined;
        stopSocketTimers();
        if (ws) {
          const old = ws;
          detach(old, true);
          old.close(1000, 'migrated');
        }
        ws = socket;
      }
      log('open');
      opened = true;
      set({ status: 'open', attempt: 0 });
      if (retry) stableTimer = setTimeout(() => (failures = 0), retry.minUptime);
      startHeartbeat(socket);
      ready?.resolve();
      // Nobody holds it (it was started by reading `ready`, or the last holder left while
      // connecting): close it unless a holder turns up soon.
      if (refs === 0 && !pinned) {
        clearTimeout(teardownTimer);
        teardownTimer = setTimeout(teardown, READY_GRACE);
      }
      // `open` listeners go first, so a handshake sent from `onOpen` (e.g. auth) precedes
      // whatever was queued while disconnected.
      emit('open', event);
      if (ws !== socket) return; // a listener closed or replaced it
      const queued = pending;
      pending = [];
      const now = Date.now();
      for (const entry of queued) if (entry.expires >= now) socket.send(entry.data);
      // After the rest is sent, so an `onDrop` that sends again doesn't jump ahead of it.
      for (const entry of queued) if (entry.expires < now) expired(entry);
    };
    socket.onmessage = event => receive(event, socket);
    socket.onerror = event => {
      if (ws === socket) emit('error', event);
    };
    socket.onclose = event => {
      if (ws !== socket) {
        // A handoff that never opened: the current connection stays.
        incoming = null;
        log('migrate() failed', event.code);
        return;
      }
      detach(socket, false);
      handleClose({ code: event.code, reason: event.reason, wasClean: event.wasClean });
    };
  }

  function handleClose(info: CloseInfo) {
    stopSocketTimers();
    log('closed', info);
    retryOrFail(info);
    emit('close', info);
  }

  function retryOrFail(info: CloseInfo, error?: Error) {
    if (
      wanted &&
      retry &&
      failures < retry.maxAttempts &&
      (retry.shouldReconnect ?? retryableClose)(info)
    ) {
      const attempt = ++failures;
      const asked = (retry.retryAfter ?? retryAfter)(info);
      const named = asked! >= 0; // not for undefined, NaN or a negative delay
      // A server that names a delay gets it, plus the usual backoff so clients told the same
      // delay don't all return at once. An overloaded one (1013) gets the longest backoff.
      const delay = Math.min(
        MAX_TIMEOUT,
        named ? asked! + backoff(attempt, false) : backoff(attempt, info.code === 1013)
      );
      serverWait = named || info.code === 1013;
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

  /** Forget `migrate()`: its timer, its connection and the URL it moved to. */
  function stopMigrating() {
    clearTimeout(migrateTimer);
    migrateTimer = undefined;
    dropIncoming();
    moved = undefined;
  }

  function migrate({ url: to, within }: MigrateOptions = {}) {
    clearTimeout(migrateTimer);
    dropIncoming();
    migrateTimer = setTimeout(
      () => {
        migrateTimer = undefined;
        if (!wanted) return;
        if (to !== undefined) moved = to;
        // Not connected: the next attempt goes to the new URL.
        if (snapshot.status === 'open') open(true);
      },
      // Each client picks its own moment, so a server's request doesn't move everyone at once.
      Math.min(MAX_TIMEOUT, Math.random() * (within ?? 0))
    );
  }

  function fail(reason: unknown) {
    wanted = false;
    opened = false;
    unbindWindow();
    stopMigrating();
    pending = [];
    // `failures`, not 0: a connection that kept closing right after open was still failing.
    set({ status: 'closed', attempt: failures });
    rejectReady(reason);
  }

  function receive(event: MessageEvent, socket: WebSocket) {
    clearTimeout(pongTimer);
    pongTimer = undefined;
    if (options.heartbeat?.pong !== undefined && event.data === options.heartbeat.pong) return;

    // Async schema validation must not reorder messages.
    const run = () => decode(event, socket);
    if (inbox) {
      // One failed delivery must not stop the chain, or every later message is dropped.
      const next: Promise<void> = inbox
        .then(run)
        .catch(rethrowAsync)
        .then(() => {
          if (inbox === next) inbox = null;
        });
      inbox = next;
      return;
    }
    const result = run();
    if (result) {
      const next: Promise<void> = result.catch(rethrowAsync).then(() => {
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

  function send(message: Out, sendOptions: SendOptions = {}): boolean {
    const data = options.serialize
      ? options.serialize(message)
      : options.json
        ? JSON.stringify(message)
        : (message as SendData);
    const { key, priority, maxBuffered } = sendOptions;
    if (ws && ws.readyState === OPEN) {
      // A late frame is worse than none: let a congested buffer drain instead of growing it.
      if (maxBuffered !== undefined && ws.bufferedAmount > maxBuffered) {
        log('dropped message: send buffer above maxBuffered');
        return false;
      }
      ws.send(data);
      return true;
    }
    if (queueLimit === 0 || sendOptions.volatile) {
      log('dropped message: socket is not open');
      return false;
    }
    if (!getImpl()) {
      // e.g. during a server render: this client can never connect, so don't hold on to it.
      log('dropped message: no WebSocket implementation available');
      return false;
    }
    const now = Date.now();
    // Drop what's too old to send, and an older message with the same key. Their `onDrop`s run
    // once the queue is updated, so one that sends again doesn't lose its message.
    const before = pending;
    pending = before.filter(
      entry => entry.expires >= now && (key === undefined || entry.key !== key)
    );
    for (const entry of before) {
      if (!pending.includes(entry)) (entry.expires < now ? expired : dropped)(entry);
    }
    let head = pending.findIndex(entry => !entry.priority);
    if (head < 0) head = pending.length;
    const entry = {
      data,
      key,
      priority,
      onDrop: sendOptions.onDrop,
      expires: now + (sendOptions.maxAge ?? queueMaxAge)
    };
    if (priority) pending.splice(head++, 0, entry);
    else pending.push(entry);
    if (pending.length > queueLimit) {
      // The oldest ordinary message goes first; priority ones only when nothing else is left.
      dropped(pending.splice(head < pending.length ? head : 0, 1)[0]!);
      log(`dropped oldest queued message: queue limit (${queueLimit}) reached`);
    }
    return false;
  }

  function expired(entry: (typeof pending)[number]) {
    log('dropped queued message: older than maxAge');
    dropped(entry);
  }

  function dropped(entry: (typeof pending)[number]) {
    try {
      entry.onDrop?.();
    } catch (error) {
      rethrowAsync(error);
    }
  }

  function begin() {
    wanted = true;
    // Starting over after `close()` or giving up: wait for a new connection.
    if (snapshot.status === 'idle' || snapshot.status === 'closed') {
      opened = false;
      if (ready?.settled) ready = null;
    }
    failures = 0;
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
    failures = 0;
    stopSocketTimers();
    unbindWindow();
    stopMigrating();
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
    stopSocketTimers();
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
    migrate,
    acquire,
    [INSPECT]: () => ({ queued: pending.length })
  } as WebSocketClient<In, Out>;
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
