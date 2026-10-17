import {
  useEffect,
  useId,
  useInsertionEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type RefObject
} from 'react';
// Import the client through the `core` entry: the build keeps it external, so both entries
// share one copy of it (and of `MessageError`).
import { createWebSocket } from './core';
import type { AgUiAgent, AgUiThread } from './ag-ui';
import type { Latency, WebSocketLatency } from './latency';
import type { OutboxEntry, WebSocketOutbox } from './outbox';
import type { PresencePeer, WebSocketPresence } from './presence';
// Types only: a value import from anything but `./core` would bundle a second copy into this entry.
import type { RequestOptions, WebSocketRequests } from './requests';
import type { IncomingRequest, WebSocketResponder } from './responder';
import type { AgentRun, WebSocketRuns } from './runs';
import type { WebSocketState } from './state';
import type { WebSocketTopics } from './topics';
import type {
  CloseInfo,
  EventMap,
  SendOptions,
  Snapshot,
  Status,
  WebSocketClient,
  WebSocketOptions
} from './types';

/**
 * Per-component event handlers. They always see the component's latest props and
 * state, and changing them never reconnects.
 */
export interface WebSocketHandlers<In> {
  /** The socket opened (initially or after a reconnect). */
  onOpen?: (event: Event) => void;
  /** A message arrived and passed `parse`/`json` and `schema`. */
  onMessage?: (message: In, event: MessageEvent) => void;
  /** A socket closed. Called whether or not it will be retried. */
  onClose?: (close: CloseInfo) => void;
  /** A socket error `Event`, a `MessageError`, or an `Error` from the constructor or `url` function. */
  onError?: (error: Event | Error) => void;
  /**
   * `false` releases this component's hold on the connection and stops its handlers.
   * The connection closes once nothing else holds it.
   * @default true
   */
  enabled?: boolean;
}

/** Options for `useWebSocket(url, options)`: connection options plus handlers. */
export interface UseWebSocketOptions<In, Out>
  extends WebSocketOptions<In, Out>, WebSocketHandlers<In> {}

/** What `useWebSocket` returns: the current {@link Snapshot} plus stable actions. */
export interface UseWebSocketResult<In, Out> extends Snapshot<In> {
  /**
   * Send now, or queue until open (see {@link SendOptions} for volatile and keyed sends).
   * Returns `true` if sent immediately. Stable identity.
   */
  send: (message: Out, options?: SendOptions) => boolean;
  /** Close and stop reconnecting (for every component sharing the connection). Stable identity. */
  close: (code?: number, reason?: string) => void;
  /** Drop the socket and connect again right away. Stable identity. */
  reconnect: () => void;
  /** The underlying client, or `null` when the URL is `null`/`undefined`. */
  client: WebSocketClient<In, Out> | null;
}

const IDLE: Snapshot<never> = Object.freeze({ status: 'idle', lastMessage: undefined, attempt: 0 });
const idleSnapshot = () => IDLE;
const idleStatus = (): Status => 'idle';
const NO_LATENCY: Latency = Object.freeze({ rtt: undefined, offset: undefined });
const noLatency = () => NO_LATENCY;
// Not frozen: a call would keep it in bundles that never use the hook.
const NO_REQUESTS: readonly never[] = [];
const noRequests = () => NO_REQUESTS;
const noopSubscribe = () => () => {};
const noopSend = () => false;
const noop = () => {};

// Same key as `ON_TEARDOWN` in ./client, which this entry must not import directly.
const ON_TEARDOWN = Symbol.for('react-websocket.onTeardown');

// Hooks given the same URL (and protocols) share one connection: the client of the first
// component to commit. It's registered from an effect, never during render, so a render React
// throws away can't decide the connection's options or leave a client behind.
const registry = new Map<string, WebSocketClient<any, any>>();
// Development only: where `react-websocket/devtools` finds the clients hooks share by URL.
if (process.env.NODE_ENV !== 'production') {
  (globalThis as Record<symbol, unknown>)[Symbol.for('react-websocket.registry')] = registry;
}
const registryListeners = new Set<() => void>();

function subscribeRegistry(listener: () => void) {
  registryListeners.add(listener);
  return () => {
    registryListeners.delete(listener);
  };
}

function registryChanged() {
  for (const listener of [...registryListeners]) listener();
}

// Development only: the options (and `useId` of the component) each URL client was created with,
// to warn when another component passes different ones for the same URL.
const origins = new WeakMap<
  WebSocketClient<any, any>,
  { options: WebSocketOptions<any, any>; id: string }
>();
const warned = new Set<string>();

// The options that shape a shared connection, with what leaving one out means.
const CONNECTION_OPTIONS: { [K in keyof WebSocketOptions]-?: unknown } = {
  protocols: undefined, // part of the registry key
  binaryType: 'blob',
  json: false,
  parse: undefined,
  serialize: undefined,
  schema: undefined,
  reconnect: true,
  heartbeat: undefined,
  queue: true,
  logger: undefined, // debugging only
  WebSocket: undefined
};
const IGNORED_OPTIONS = new Set(['protocols', 'logger']);

// Inline functions and objects are new on every render: compare them by source and by field.
const sameValue = (a: unknown, b: unknown) =>
  Object.is(a, b) ||
  (typeof a === 'function' && typeof b === 'function' && String(a) === String(b));

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype;

function sameOption(a: unknown, b: unknown) {
  if (sameValue(a, b)) return true;
  if (!isPlainObject(a) || !isPlainObject(b)) return false;
  return [...Object.keys(a), ...Object.keys(b)].every(key => sameValue(a[key], b[key]));
}

function warnOnConflict(
  url: string,
  key: string,
  client: WebSocketClient<any, any>,
  options: WebSocketOptions<any, any>,
  id: string
) {
  const origin = origins.get(client);
  if (!origin || origin.id === id || warned.has(`${key}\u0000${id}`)) return;
  const differing = (Object.keys(CONNECTION_OPTIONS) as (keyof WebSocketOptions)[]).filter(
    name =>
      !IGNORED_OPTIONS.has(name) &&
      !sameOption(
        origin.options[name] ?? CONNECTION_OPTIONS[name],
        options[name] ?? CONNECTION_OPTIONS[name]
      )
  );
  if (!differing.length) return;
  warned.add(`${key}\u0000${id}`);
  console.warn(
    `react-websocket: useWebSocket("${url}") was given different ${differing.join(', ')} than ` +
      `the component that opened this shared connection. They are ignored: every component ` +
      `using the URL gets the first one's options. Pass the same options, or define the ` +
      `connection once with createWebSocket().`
  );
}

/** The client shared for `key`, or `own` until a component using it has committed. */
const shared_ = (key: string | null, own: WebSocketClient<any, any> | null) =>
  key === null ? null : (registry.get(key) ?? own);

/** A component's own client for a URL. It becomes the shared one if the component commits first. */
function ownClient<In, Out>(
  url: string,
  key: string,
  options: WebSocketOptions<In, Out>,
  id: string
): WebSocketClient<In, Out> {
  const created: WebSocketClient<In, Out> = createWebSocket(url, {
    ...options,
    [ON_TEARDOWN]: () => {
      if (registry.get(key) === created) {
        registry.delete(key);
        registryChanged();
      }
    }
  } as WebSocketOptions<In, Out>);
  if (process.env.NODE_ENV !== 'production') origins.set(created, { options, id });
  return created;
}

/** Always-current value for use inside effects and event listeners (a `useEffectEvent` stand-in). */
function useLatest<T>(value: T) {
  const ref = useRef(value);
  useInsertionEffect(() => {
    ref.current = value;
  });
  return ref;
}

function useHold(client: WebSocketClient<any, any> | null, enabled: boolean) {
  useEffect(() => {
    if (client && enabled) return client.acquire();
  }, [client, enabled]);
}

/**
 * Connect to a WebSocket and re-render with its status and latest message.
 *
 * - With a URL, every component using the same URL (and `protocols`) shares one
 *   connection. Its options come from the first of them to mount; in development, a
 *   component passing different ones gets a console warning. A render React throws away
 *   never decides them.
 * - With a client from `createWebSocket()`, options are the client's; only handlers
 *   and `enabled` apply here.
 * - With `null` or `undefined`, nothing connects and the status stays `idle`.
 *
 * The connection opens on mount and closes one tick after the last component using it
 * unmounts, so StrictMode and `<Activity>` don't open duplicate sockets.
 *
 * Re-renders on status changes and on every message. For high-frequency streams use
 * `useWebSocketEvent` and `useWebSocketStatus` instead.
 *
 * @example
 * ```tsx
 * const { status, lastMessage, send } = useWebSocket<Price, Order>('wss://api.example.com/prices', {
 *   json: true,
 *   onMessage: price => console.log(price)
 * });
 * ```
 */
export function useWebSocket<In = unknown, Out = unknown>(
  url: string | null | undefined,
  options?: UseWebSocketOptions<In, Out>
): UseWebSocketResult<In, Out>;
export function useWebSocket<In, Out>(
  client: WebSocketClient<In, Out> | null | undefined,
  options?: WebSocketHandlers<In>
): UseWebSocketResult<In, Out>;
export function useWebSocket<In, Out>(
  target: string | WebSocketClient<In, Out> | null | undefined,
  options: UseWebSocketOptions<In, Out> = {}
): UseWebSocketResult<In, Out> {
  const id = useId();
  const url = typeof target === 'string' ? target : null;
  const key = url === null ? null : `${url}\u0000${JSON.stringify(options.protocols ?? null)}`;
  // This component's own client for the URL, made once per URL: connection options are read
  // when it's created, as for the shared client it may become.
  const make = () => ({ key, client: key === null ? null : ownClient(url!, key, options, id) });
  const [made, setMade] = useState(make);
  let own = made.client;
  if (made.key !== key) {
    const next = make();
    own = next.client;
    setMade(next);
  }
  // The shared client once a component using the URL has committed; this one's own until then.
  const shared = useSyncExternalStore(
    subscribeRegistry,
    () => shared_(key, own),
    () => own
  ) as WebSocketClient<In, Out> | null;
  const client =
    key === null ? ((target as WebSocketClient<In, Out> | null | undefined) ?? null) : shared;
  const enabled = options.enabled ?? true;
  if (process.env.NODE_ENV !== 'production' && client !== own && key !== null) {
    warnOnConflict(url!, key, client!, options, id);
  }

  const snapshot = useSyncExternalStore<Snapshot<In>>(
    client ? client.subscribe : noopSubscribe,
    client ? client.getSnapshot : idleSnapshot,
    idleSnapshot
  );

  const handlers = useLatest(options);
  useEffect(() => {
    if (!client || !enabled) return;
    const offs = [
      client.on('open', event => handlers.current.onOpen?.(event)),
      client.on('message', (message, event) => handlers.current.onMessage?.(message, event)),
      client.on('close', info => handlers.current.onClose?.(info)),
      client.on('error', error => handlers.current.onError?.(error))
    ];
    return () => offs.forEach(off => off());
  }, [client, enabled, handlers]);
  useEffect(() => {
    if (key === null || !enabled) return;
    // The first component to commit shares its client. A component that rendered before then,
    // with its own, holds the shared one right away and re-renders with it.
    if (!registry.has(key)) {
      registry.set(key, own!);
      registryChanged();
    }
    return registry.get(key)!.acquire();
  }, [key, own, client, enabled]);
  useHold(key === null ? client : null, enabled);

  // For a URL, act on the shared client at call time, so a message sent from a mount effect
  // before this component re-renders with the shared client still reaches it.
  const actions = useMemo(
    () =>
      key === null
        ? null
        : {
            send: (message: Out, sendOptions?: SendOptions) =>
              shared_(key, own)!.send(message, sendOptions),
            close: (code?: number, reason?: string) => shared_(key, own)!.close(code, reason),
            reconnect: () => shared_(key, own)!.reconnect()
          },
    [key, own]
  );

  return {
    ...snapshot,
    send: actions ? actions.send : client ? client.send : noopSend,
    close: actions ? actions.close : client ? client.close : noop,
    reconnect: actions ? actions.reconnect : client ? client.reconnect : noop,
    client
  };
}

/**
 * Listen to a client's events without re-rendering the component. The listener always
 * sees the latest props and state. Keeps the connection open while mounted.
 *
 * @example
 * ```tsx
 * useWebSocketEvent(chat, 'message', message => setMessages(list => [...list, message]));
 * ```
 */
export function useWebSocketEvent<In, K extends keyof EventMap<In>>(
  client: WebSocketClient<In, any> | null | undefined,
  type: K,
  listener: EventMap<In>[K]
): void {
  const latest = useLatest(listener);
  useEffect(() => {
    if (!client) return;
    const off = client.on(type, ((...args: unknown[]) =>
      (latest.current as (...a: unknown[]) => void)(...args)) as EventMap<In>[K]);
    const release = client.acquire();
    return () => {
      off();
      release();
    };
  }, [client, type, latest]);
}

/**
 * The connection status of a client. Re-renders only when the status changes, not on
 * messages. Keeps the connection open while mounted.
 *
 * @example
 * ```tsx
 * const status = useWebSocketStatus(chat); // 'idle' | 'connecting' | 'open' | 'reconnecting' | 'closed'
 * ```
 */
export function useWebSocketStatus(client: WebSocketClient<any, any> | null | undefined): Status {
  const status = useSyncExternalStore(
    client ? client.subscribe : noopSubscribe,
    client ? () => client.getSnapshot().status : idleStatus,
    idleStatus
  );
  useHold(client ?? null, true);
  return status;
}

const identity = <T>(value: T) => value;

/**
 * Read state built from messages by `createWebSocketState`. Re-renders only when the
 * selected value changes (by `isEqual`, default `Object.is`), however often messages
 * arrive. Keeps the connection open while mounted.
 *
 * On the server, and during hydration, it reads from `initialState`.
 *
 * @example
 * ```tsx
 * const acme = useWebSocketState(priceState, state => state.ACME);
 * ```
 */
export function useWebSocketState<S>(store: WebSocketState<S>): S;
export function useWebSocketState<S, T>(
  store: WebSocketState<S>,
  selector: (state: S) => T,
  isEqual?: (a: T, b: T) => boolean
): T;
export function useWebSocketState<S, T>(
  store: WebSocketState<S>,
  selector: (state: S) => T = identity as (state: S) => T,
  isEqual: (a: T, b: T) => boolean = Object.is
): T {
  const [getSelection, getServerSelection] = useMemo(() => {
    // Return the previous selection while the state is unchanged or the result is equal,
    // so inline selectors that build objects don't re-render (or loop) on every message.
    const memoized = (read: () => S) => {
      let memo: { state: S; selection: T } | undefined;
      return () => {
        const state = read();
        if (memo && Object.is(memo.state, state)) return memo.selection;
        const selection = selector(state);
        if (memo && isEqual(memo.selection, selection)) {
          memo = { state, selection: memo.selection };
          return memo.selection;
        }
        memo = { state, selection };
        return selection;
      };
    };
    return [memoized(store.getState), memoized(() => store.initialState)] as const;
  }, [store, selector, isEqual]);

  const selection = useSyncExternalStore(store.subscribe, getSelection, getServerSelection);
  useHold(store.client, true);
  return selection;
}

/**
 * Subscribe to one topic (or several) while mounted, through a `createWebSocketTopics`
 * manager. Components holding the same topic share one subscription, and it is sent again
 * after every reconnect. Keeps the connection open while mounted. `null` holds nothing.
 *
 * @example
 * ```tsx
 * useWebSocketTopic(topics, `prices:${symbol}`);
 * useWebSocketTopic(topics, watchlist.map(symbol => `prices:${symbol}`));
 * ```
 */
export function useWebSocketTopic(
  topics: WebSocketTopics | null | undefined,
  topic: string | readonly string[] | null | undefined
): void {
  // A stable key, so a new array with the same topics doesn't resubscribe.
  const key = topic == null ? null : JSON.stringify(typeof topic === 'string' ? [topic] : topic);
  useEffect(() => {
    if (!topics || key === null) return;
    const releases = (JSON.parse(key) as string[]).map(t => topics.acquire(t));
    return () => releases.forEach(release => release());
  }, [topics, key]);
}

/**
 * Read round-trip time and server clock offset from a `createWebSocketLatency` instance.
 * Re-renders when a measurement changes, about once per ping interval. Keeps the connection
 * open while mounted. On the server, and during hydration, both values are `undefined`.
 *
 * @example
 * ```tsx
 * const { rtt } = useWebSocketLatency(latency);
 * return <span>{rtt === undefined ? '–' : `${Math.round(rtt)} ms`}</span>;
 * ```
 */
export function useWebSocketLatency(latency: WebSocketLatency): Latency {
  const snapshot = useSyncExternalStore(latency.subscribe, latency.getSnapshot, noLatency);
  useHold(latency.client, true);
  return snapshot;
}

/**
 * The messages waiting in an outbox from `react-websocket/outbox`, oldest first, for a "3 orders
 * waiting to sync" banner. Re-renders when they change. `null` lists nothing. On the server the
 * list is empty.
 *
 * @example
 * ```tsx
 * const waiting = useWebSocketOutbox(orders);
 * if (!waiting.length) return null;
 * return <p role="status">{waiting.length} orders waiting to sync</p>;
 * ```
 */
export function useWebSocketOutbox<M>(
  outbox: WebSocketOutbox<M> | null | undefined
): readonly OutboxEntry<M>[] {
  return useSyncExternalStore(
    outbox?.subscribe ?? noopSubscribe,
    outbox?.getSnapshot ?? noRequests,
    noRequests
  );
}

const noRun = () => undefined;

/**
 * Whether an element is on screen, from an `IntersectionObserver`, for dashboards that stream
 * full detail only for what's visible: pick a topic with it and pass it to `useWebSocketTopic`,
 * which switches subscriptions when it changes. `initial` until the first observation, on the
 * server, and where `IntersectionObserver` doesn't exist.
 *
 * @example
 * ```tsx
 * const ref = useRef<HTMLElement>(null);
 * useWebSocketTopic(feeds, useInView(ref) ? `run:${id}:tokens` : `run:${id}:status`);
 * return <article ref={ref}>…</article>;
 * ```
 */
export function useInView(
  ref: RefObject<Element | null>,
  options: { rootMargin?: string; threshold?: number; initial?: boolean } = {}
): boolean {
  const { rootMargin, threshold } = options;
  const [inView, setInView] = useState(options.initial ?? false);
  useEffect(() => {
    const element = ref.current;
    if (!element || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(
      entries => setInView(entries.at(-1)!.isIntersecting),
      { rootMargin, threshold }
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref, rootMargin, threshold]);
  return inView;
}

/**
 * The other peers' shared state from `createWebSocketPresence`, such as their cursors.
 * Re-renders when a peer's state arrives, it leaves, or it times out. Keeps the connection open
 * while mounted. On the server the list is empty.
 *
 * @example
 * ```tsx
 * const peers = useWebSocketPresence(cursors);
 * return peers.map(({ peer, state }) => <Cursor key={peer} x={state.x} y={state.y} />);
 * ```
 */
export function useWebSocketPresence<P>(
  presence: WebSocketPresence<P> | null | undefined
): readonly PresencePeer<P>[] {
  const peers = useSyncExternalStore(
    presence?.subscribe ?? noopSubscribe,
    presence?.getSnapshot ?? noRequests,
    noRequests
  );
  useHold(presence?.client ?? null, true);
  return peers;
}

/**
 * The thread of an AG-UI agent from `react-websocket/ag-ui`: its messages, shared state and
 * status, re-rendering on every event.
 *
 * @example
 * ```tsx
 * const thread = useAgUiAgent(agent);
 * return thread.messages.map(message => <Message key={message.id} message={message} />);
 * ```
 */
export function useAgUiAgent<S>(agent: AgUiAgent<S>): AgUiThread<S> {
  return useSyncExternalStore(agent.subscribe, agent.getSnapshot, agent.getSnapshot);
}

/**
 * A run from `createWebSocketRuns`, such as an agent's answer: its `value` reduced from the
 * events so far, and its `status`. Re-renders on every event. A run it doesn't know, such as one
 * started in another tab, is attached and followed from its first event. `undefined` while the
 * run is unknown, for a `null` id, and on the server.
 *
 * @example
 * ```tsx
 * const run = useAgentRun(runs, runId);
 * return (
 *   <>
 *     <Markdown>{run?.value ?? ''}</Markdown>
 *     {run?.status === 'streaming' && <button onClick={() => runs.abort(runId)}>Stop</button>}
 *   </>
 * );
 * ```
 */
export function useAgentRun<T>(
  runs: WebSocketRuns<any, T> | null | undefined,
  runId: string | null | undefined
): AgentRun<T> | undefined {
  const run = useSyncExternalStore(
    runs?.subscribe ?? noopSubscribe,
    () => (runs && runId ? runs.get(runId) : undefined),
    noRun
  );
  useEffect(() => {
    if (runs && runId) runs.attach(runId);
  }, [runs, runId]);
  return run;
}

/**
 * Requests for `method` that a person answers, e.g. an agent asking to run a tool. While mounted,
 * it registers `method` on the responder without a handler, so new requests wait here instead of
 * getting a `NotFoundError` reply. Call `respond` or `reject` on one to answer it. Re-renders
 * when the list changes. Keeps the connection open while mounted. `null` holds nothing.
 *
 * Requests stay listed after unmount until they are answered, time out, are cancelled or lose
 * their connection, so a remounted dialog shows them again. On the server the list is empty.
 *
 * @example
 * ```tsx
 * const [request] = useAgentApproval(tools, 'approve');
 * if (!request) return null;
 * return (
 *   <dialog open>
 *     {request.params.summary}
 *     <button onClick={() => request.respond({ approved: true })}>Approve</button>
 *     <button onClick={() => request.respond({ approved: false })}>Deny</button>
 *   </dialog>
 * );
 * ```
 */
export function useAgentApproval<P, R>(
  responder: WebSocketResponder<P, R> | null | undefined,
  method: string | null | undefined
): readonly IncomingRequest<P, R>[] {
  const waiting = useSyncExternalStore(
    responder ? responder.subscribe : noopSubscribe,
    responder ? responder.getSnapshot : noRequests,
    noRequests
  );
  useEffect(() => {
    if (responder && method != null) return responder.onRequest(method);
  }, [responder, method]);
  useHold(responder?.client ?? null, method != null);
  return useMemo(() => {
    const mine = waiting.filter(request => request.method === method);
    return mine.length ? mine : NO_REQUESTS;
  }, [waiting, method]);
}

/** Options for `useWebSocketStream` that fold replies into one value, e.g. tokens into text. */
export interface UseWebSocketStreamOptions<In, T> {
  /** The value before the first reply. `start()` resets to it. */
  initial: T;
  /** Fold a reply into the value. Return a new value instead of changing the old one. */
  reduce: (value: T, reply: In) => T;
  /**
   * `'frame'`: re-render at most once per animation frame instead of once per reply. Browsers
   * pause frames in background tabs; the value catches up when the tab is visible again.
   */
  batch?: 'frame';
}

/** What `useWebSocketStream` returns: the stream's progress plus stable actions. */
export interface UseWebSocketStreamResult<Req, T> {
  /** The replies so far, folded with `reduce`, or as an array without it. */
  readonly value: T;
  /**
   * `idle` until `start()`. `done` after the last reply, `error` when the stream failed (see
   * `error`), `aborted` after `abort()`. The value stays as it was when the stream ended.
   */
  readonly status: 'idle' | 'streaming' | 'done' | 'error' | 'aborted';
  /** Why the stream failed, while `status` is `error`. */
  readonly error: unknown;
  /** Reset the value and stream the replies to `message`, aborting the stream before. Stable identity. */
  start: (message: Req, options?: Omit<RequestOptions, 'signal'>) => void;
  /** Stop the stream and send the manager's `cancel`. Stable identity. */
  abort: () => void;
}

const append = <T>(list: readonly T[], reply: T): readonly T[] => [...list, reply];

// Node and some workers have no animation frames: wait about one instead.
function nextFrame(callback: () => void) {
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(callback);
  else setTimeout(callback, 16);
}

/**
 * Stream the replies to a request into a value, e.g. a model's tokens into its answer.
 * `start(message)` sends it with `rpc.stream()` and folds each reply in with `reduce`, or
 * collects the replies without it. Starting again aborts the stream before; so do `abort()`,
 * unmounting and a new `rpc`, and each sends the manager's `cancel`. Re-renders on every
 * reply, or once per frame with `batch: 'frame'`. Keeps the connection open while mounted.
 *
 * @example
 * ```tsx
 * const answer = useWebSocketStream(ask, {
 *   initial: '',
 *   reduce: (text, reply) => text + reply.delta,
 *   batch: 'frame'
 * });
 * return (
 *   <>
 *     <button onClick={() => answer.start({ prompt })}>Ask</button>
 *     <button onClick={answer.abort} disabled={answer.status !== 'streaming'}>Stop</button>
 *     <p>{answer.value}</p>
 *   </>
 * );
 * ```
 */
export function useWebSocketStream<Req, In, T>(
  rpc: WebSocketRequests<Req, In> | null | undefined,
  options: UseWebSocketStreamOptions<NoInfer<In>, T>
): UseWebSocketStreamResult<Req, T>;
export function useWebSocketStream<Req, In>(
  rpc: WebSocketRequests<Req, In> | null | undefined,
  options?: { batch?: 'frame' }
): UseWebSocketStreamResult<Req, readonly In[]>;
export function useWebSocketStream<Req, In>(
  rpc: WebSocketRequests<Req, In> | null | undefined,
  options: Partial<UseWebSocketStreamOptions<In, any>> = {}
): UseWebSocketStreamResult<Req, unknown> {
  type Status = UseWebSocketStreamResult<Req, unknown>['status'];
  const [state, setState] = useState<{ value: unknown; status: Status; error: unknown }>(() => ({
    value: options.reduce ? options.initial : NO_REQUESTS,
    status: 'idle',
    error: undefined
  }));
  const latest = useLatest({ rpc, options });
  const running = useRef<AbortController | null>(null);

  const actions = useMemo(
    () => ({
      abort: () => running.current?.abort(),
      start(message: Req, requestOptions?: Omit<RequestOptions, 'signal'>) {
        running.current?.abort();
        const controller = (running.current = new AbortController());
        const { reduce, initial, batch } = latest.current.options;
        const fold = reduce ?? append;
        let value: unknown = reduce ? initial : NO_REQUESTS;
        let frame = false;
        // A stream that was started over no longer shows; ending also skips a pending frame.
        const show = (status: Status, error?: unknown) => {
          frame = false;
          if (running.current === controller) setState({ value, status, error });
        };
        show('streaming');
        void (async () => {
          try {
            const replies = latest.current.rpc!.stream(message, {
              ...requestOptions,
              signal: controller.signal
            });
            for await (const reply of replies) {
              value = fold(value, reply);
              if (batch !== 'frame') show('streaming');
              else if (!frame) {
                frame = true;
                nextFrame(() => frame && show('streaming'));
              }
            }
            show('done');
          } catch (error) {
            if (controller.signal.aborted) show('aborted');
            else show('error', error);
          }
        })();
      }
    }),
    [latest]
  );
  // Unmounting, or replies from another manager: stop this one's stream.
  useEffect(() => actions.abort, [actions, rpc]);
  useHold(rpc?.client ?? null, true);

  return { ...state, ...actions };
}
