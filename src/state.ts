import type { WebSocketClient } from './types';

/** Options for {@link createWebSocketState}. */
export interface WebSocketStateOptions<S, In> {
  /** The state before any message arrives, and what `reset()` returns to. */
  initialState: S;
  /**
   * Fold one incoming message into the state. Must be pure: return a new object for a
   * change, or the same `state` to ignore the message (subscribers aren't notified).
   */
  reduce: (state: S, message: In) => S;
  /**
   * `'frame'`: notify subscribers at most once per animation frame instead of once per
   * message, so a fast stream (tokens, tickers, game state) renders once per frame.
   * `getState()` is always current; only notifications wait. `setState` and `reset` still
   * notify right away.
   *
   * Browsers pause animation frames in background tabs: the state keeps up, and subscribers
   * hear about it when the tab is visible again. Without `requestAnimationFrame` (Node, some
   * workers), it waits about 16 ms instead.
   */
  batch?: 'frame';
}

/**
 * State derived from a client's messages. Read it with `useWebSocketState(store, selector)`,
 * or with `getState`/`subscribe` outside React.
 *
 * @typeParam S - The state type. Don't use a function type: `setState` treats functions as updaters.
 */
/**
 * Messages from somewhere other than the client itself, such as the in-order messages of
 * `createWebSocketFeeds`, for `createWebSocketState`.
 */
export interface MessageSource<In> {
  /** The client the messages come from. */
  readonly client: WebSocketClient<any, any>;
  on(type: 'message', listener: (message: In, event: MessageEvent) => void): () => void;
}

export interface WebSocketState<S> {
  /** The client whose messages this store reduces. Hooks reading the store keep it connected. */
  readonly client: WebSocketClient<any, any>;
  /** The `initialState` it was created with. Used for server rendering and hydration. */
  readonly initialState: S;
  /** The current state. Returns the same object until it changes. */
  getState(): S;
  /** Called whenever the state changes. Compatible with `useSyncExternalStore`. */
  subscribe(listener: () => void): () => void;
  /** Replace the state, or update it from the current one, e.g. for optimistic updates. */
  setState(update: S | ((state: S) => S)): void;
  /** Go back to `initialState`. */
  reset(): void;
  /** Stop reducing messages. Only needed for stores created dynamically rather than at module level. */
  dispose(): void;
}

/**
 * Keep state derived from a client's messages, like a reducer that runs on every message.
 * It starts listening immediately and keeps the state across reconnects; it doesn't open
 * the connection by itself.
 *
 * Pass feeds from `createWebSocketFeeds` in place of the client to reduce their messages
 * instead: numbered ones once each and in order.
 *
 * @example
 * ```ts
 * const prices = createWebSocket<Tick>('wss://api.example.com/prices', { json: true });
 *
 * export const priceState = createWebSocketState(prices, {
 *   initialState: {} as Record<string, number>,
 *   reduce: (state, tick) => ({ ...state, [tick.symbol]: tick.price })
 * });
 *
 * // In a component: re-renders only when ACME's price changes.
 * const acme = useWebSocketState(priceState, state => state.ACME);
 * ```
 */
export function createWebSocketState<S, In>(
  source: WebSocketClient<In, any> | MessageSource<In>,
  // `In` comes from the source only, not from how `reduce` annotates its parameter.
  options: WebSocketStateOptions<S, NoInfer<In>>
): WebSocketState<S> {
  const client = 'client' in source ? source.client : source;
  const { initialState, reduce, batch } = options;
  let state = initialState;
  // What subscribers were last told about, so a frame that finds nothing new stays quiet.
  let notified = state;
  let frame = false;
  const listeners = new Set<() => void>();

  function notify() {
    if (Object.is(state, notified)) return;
    notified = state;
    for (const listener of [...listeners]) listener();
  }

  function flush() {
    frame = false;
    notify();
  }

  function update(change: S | ((state: S) => S), later?: boolean) {
    const next = typeof change === 'function' ? (change as (state: S) => S)(state) : change;
    if (Object.is(next, state)) return;
    state = next;
    if (!later) notify();
    else if (!frame) {
      frame = true;
      // Node and some workers have no animation frames: wait about one instead.
      if (typeof requestAnimationFrame === 'function') requestAnimationFrame(flush);
      else setTimeout(flush, 16);
    }
  }

  // A throwing reducer leaves the state unchanged; the client re-throws the error asynchronously.
  const off = (source as MessageSource<In>).on('message', message =>
    update(current => reduce(current, message), batch === 'frame')
  );

  return {
    client,
    initialState,
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    setState: change => update(change),
    reset: () => update(initialState),
    dispose: off
  };
}
