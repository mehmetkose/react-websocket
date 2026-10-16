import { useEffect, useInsertionEffect, useRef, useSyncExternalStore } from 'react';
import { createClient } from './client';
import type {
  CloseInfo,
  EventMap,
  Snapshot,
  Status,
  WebSocketClient,
  WebSocketOptions
} from './types';

export interface WebSocketHandlers<In> {
  onOpen?: (event: Event) => void;
  onMessage?: (message: In, event: MessageEvent) => void;
  onClose?: (close: CloseInfo) => void;
  onError?: (error: Event | Error) => void;
  /** `false` releases this component's hold on the connection and stops its handlers. Default: true. */
  enabled?: boolean;
}

export interface UseWebSocketOptions<In, Out>
  extends WebSocketOptions<In, Out>,
    WebSocketHandlers<In> {}

export interface UseWebSocketResult<In, Out> extends Snapshot<In> {
  send: (message: Out) => boolean;
  close: (code?: number, reason?: string) => void;
  reconnect: () => void;
  client: WebSocketClient<In, Out> | null;
}

const IDLE: Snapshot<never> = Object.freeze({ status: 'idle', lastMessage: undefined, attempt: 0 });
const idleSnapshot = () => IDLE;
const idleStatus = (): Status => 'idle';
const noopSubscribe = () => () => {};
const noopSend = () => false;
const noop = () => {};

// Hooks given the same URL (and protocols) share one connection.
const registry = new Map<string, WebSocketClient<any, any>>();

function sharedClient<In, Out>(url: string, options: WebSocketOptions<In, Out>) {
  // Don't let server renders accumulate clients that can never be torn down.
  if (typeof window === 'undefined') return createClient(url, options);
  const key = `${url}\u0000${JSON.stringify(options.protocols ?? null)}`;
  let client = registry.get(key) as WebSocketClient<In, Out> | undefined;
  if (!client) {
    const created: WebSocketClient<In, Out> = createClient(url, options, () => {
      if (registry.get(key) === created) registry.delete(key);
    });
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
 * Connect to `url` (shared by every hook using the same URL) or use a client from
 * `createWebSocket()`. Pass `null` to stay disconnected.
 *
 * Re-renders on status changes and on every message; for high-frequency streams
 * prefer `useWebSocketEvent` + `useWebSocketStatus`.
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

/** Listen to a client's events without re-rendering. Keeps the connection open while mounted. */
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

/** Just the connection status; re-renders only when it changes. Keeps the connection open while mounted. */
export function useWebSocketStatus(client: WebSocketClient<any, any> | null | undefined): Status {
  const status = useSyncExternalStore(
    client ? client.subscribe : noopSubscribe,
    client ? () => client.getSnapshot().status : idleStatus,
    idleStatus
  );
  useHold(client ?? null, true);
  return status;
}
