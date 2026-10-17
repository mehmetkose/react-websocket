import { useEffect, useInsertionEffect, useMemo, useRef, useSyncExternalStore } from 'react';
// Import the client through the `core` entry: the build keeps it external, so both entries
// share one copy of it (and of `MessageError`).
import { createWebSocket } from './core';
import type { Latency, WebSocketLatency } from './latency';
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
const noopSubscribe = () => () => {};
const noopSend = () => false;
const noop = () => {};

// Same key as `ON_TEARDOWN` in ./client, which this entry must not import directly.
const ON_TEARDOWN = Symbol.for('react-websocket.onTeardown');

// Hooks given the same URL (and protocols) share one connection.
const registry = new Map<string, WebSocketClient<any, any>>();

function sharedClient<In, Out>(url: string, options: WebSocketOptions<In, Out>) {
  // Don't let server renders accumulate clients that can never be torn down.
  if (typeof window === 'undefined') return createWebSocket(url, options);
  const key = `${url}\u0000${JSON.stringify(options.protocols ?? null)}`;
  let client = registry.get(key) as WebSocketClient<In, Out> | undefined;
  if (!client) {
    const created: WebSocketClient<In, Out> = createWebSocket(url, {
      ...options,
      [ON_TEARDOWN]: () => {
        if (registry.get(key) === created) registry.delete(key);
      }
    } as WebSocketOptions<In, Out>);
    registry.set(key, created);
    client = created;
  }
  return client;
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
 *   connection. Its options come from whichever component created it first.
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
  const client =
    target == null ? null : typeof target === 'string' ? sharedClient(target, options) : target;
  const enabled = options.enabled ?? true;

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
  useHold(client, enabled);

  return {
    ...snapshot,
    send: client ? client.send : noopSend,
    close: client ? client.close : noop,
    reconnect: client ? client.reconnect : noop,
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
