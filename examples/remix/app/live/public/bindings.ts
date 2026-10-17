// react-websocket's hooks are thin wrappers over `react-websocket/core`: each one subscribes to a
// store, re-renders when it changes, and holds the connection open while mounted. These are the
// same wrappers for Remix components, one per hook. The library ships no Remix bindings; copy
// these into your app.
//
// Each binding starts after the component's first render in the browser (a queued task, which
// the server never runs) and stops when the component is removed (`handle.signal`). The getters
// they return give the server's value until then, so hydration matches the server's HTML.
import type { Handle } from 'remix/component';
import type {
  EventMap,
  IncomingRequest,
  Latency,
  Snapshot,
  Status,
  WebSocketClient,
  WebSocketLatency,
  WebSocketResponder,
  WebSocketState,
  WebSocketTopics
} from 'react-websocket/core';

type AnyHandle = Handle<any, any>;
type Client = WebSocketClient<any, any>;

/** Run `start` in the browser after the first render; its cleanups run when the component goes. */
function whileMounted(handle: AnyHandle, start: () => (() => void)[]) {
  handle.queueTask(() => {
    for (const stop of start()) handle.signal.addEventListener('abort', stop, { once: true });
  });
}

/**
 * Re-render when `read()` returns something new (by `Object.is`), however often the store
 * changes, and hold `client`'s connection. Like `useSyncExternalStore` with a selector.
 */
function select<T>(
  handle: AnyHandle,
  client: Client,
  subscribe: (listener: () => void) => () => void,
  read: () => T,
  initial: T
): () => T {
  let value = initial;
  const check = () => {
    const next = read();
    if (Object.is(next, value)) return;
    value = next;
    void handle.update();
  };
  whileMounted(handle, () => {
    const stops = [subscribe(check), client.acquire()];
    check(); // it may have changed since the server rendered `initial`
    return stops;
  });
  return () => value;
}

const IDLE: Snapshot<never> = { status: 'idle', lastMessage: undefined, attempt: 0 };
const NO_LATENCY: Latency = { rtt: undefined, offset: undefined };
const NO_REQUESTS: readonly IncomingRequest<any, any>[] = [];

/** `useWebSocket(client)`: the status, attempt and last message. Re-renders on every message. */
export function watchSnapshot<In>(handle: AnyHandle, client: WebSocketClient<In, any>) {
  return select<Snapshot<In>>(handle, client, client.subscribe, client.getSnapshot, IDLE);
}

/** `useWebSocketStatus(client)`: re-renders on status changes only. */
export function watchStatus(handle: AnyHandle, client: Client) {
  return select<Status>(
    handle,
    client,
    client.subscribe,
    () => client.getSnapshot().status,
    'idle'
  );
}

/** `useWebSocketState(store, selector)`: re-renders only when the selected value changes. */
export function watchState<S, T = S>(
  handle: AnyHandle,
  store: WebSocketState<S>,
  selector: (state: S) => T = state => state as unknown as T
) {
  return select(
    handle,
    store.client,
    store.subscribe,
    () => selector(store.getState()),
    selector(store.initialState)
  );
}

/** `useWebSocketLatency(latency)`: re-renders about once per ping. */
export function watchLatency(handle: AnyHandle, latency: WebSocketLatency) {
  return select(handle, latency.client, latency.subscribe, latency.getSnapshot, NO_LATENCY);
}

/** `useWebSocketEvent(client, type, listener)`: listens without re-rendering. */
export function listen<In, K extends keyof EventMap<In>>(
  handle: AnyHandle,
  client: WebSocketClient<In, any>,
  type: K,
  listener: EventMap<In>[K]
) {
  whileMounted(handle, () => [client.on(type, listener), client.acquire()]);
}

/** `useWebSocketTopic(topics, topic)`: subscribed while mounted, and after every reconnect. */
export function holdTopic(handle: AnyHandle, topics: WebSocketTopics, topic: string) {
  whileMounted(handle, () => [topics.acquire(topic)]);
}

/**
 * `useAgentApproval(responder, method)`: registers `method` without a handler, so its requests
 * wait for a person, and returns them. Re-renders when they change.
 */
export function watchRequests<P, R>(
  handle: AnyHandle,
  responder: WebSocketResponder<P, R>,
  method: string
): () => readonly IncomingRequest<P, R>[] {
  whileMounted(handle, () => [responder.onRequest(method)]);
  const waiting = select<readonly IncomingRequest<P, R>[]>(
    handle,
    responder.client,
    responder.subscribe,
    responder.getSnapshot,
    NO_REQUESTS
  );
  return () => waiting().filter(request => request.method === method);
}
