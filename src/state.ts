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
}

/**
 * State derived from a client's messages. Read it with `useWebSocketState(store, selector)`,
 * or with `getState`/`subscribe` outside React.
 *
 * @typeParam S - The state type. Don't use a function type: `setState` treats functions as updaters.
 */
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
  client: WebSocketClient<In, any>,
  // `In` comes from the client only, not from how `reduce` annotates its parameter.
  options: WebSocketStateOptions<S, NoInfer<In>>
): WebSocketState<S> {
  const { initialState, reduce } = options;
  let state = initialState;
  const listeners = new Set<() => void>();

  function setState(update: S | ((state: S) => S)) {
    const next = typeof update === 'function' ? (update as (state: S) => S)(state) : update;
    if (Object.is(next, state)) return;
    state = next;
    for (const listener of [...listeners]) listener();
  }

  // A throwing reducer leaves the state unchanged; the client re-throws the error asynchronously.
  const off = client.on('message', message => setState(current => reduce(current, message)));

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
    setState,
    reset: () => setState(initialState),
    dispose: off
  };
}
