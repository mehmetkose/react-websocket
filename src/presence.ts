import type { WebSocketClient } from './types';

type Timer = ReturnType<typeof setTimeout> | undefined;

/** Another client's shared state, such as its cursor or what it's selected. */
export interface PresencePeer<P> {
  /** The peer's id, as the server reports it. */
  readonly peer: string;
  readonly state: P;
  /** When its state last arrived, from `Date.now()`. */
  readonly updatedAt: number;
}

/** Options for {@link createWebSocketPresence}: the messages your server relays. */
export interface WebSocketPresenceOptions<P, In, Out> {
  /** The message that shares this client's state with the others. Annotate `state`. */
  send: (state: P) => Out;
  /** The message that says this client left, sent by `leave()`. Omit it if the server has none. */
  leave?: () => Out;
  /**
   * Recognize another peer's state: its id and state, or `state: null` when it left. `undefined`
   * for any other message.
   */
  receive: (message: In) => { readonly peer: string; readonly state: P | null } | null | undefined;
  /**
   * Forget a peer that hasn't sent its state for this long, in ms, as if it had left. Covers
   * peers whose connection died without the server noticing.
   * @default 30000
   */
  timeout?: number;
  /**
   * Send this client's state again this often while it doesn't change, in ms, so the others
   * don't forget it.
   * @default timeout / 3
   */
  refresh?: number;
  /**
   * How many times per second this client's state may be sent. Changes in between are
   * coalesced: the newest goes out at the end of the interval.
   * @default 20
   */
  maxRate?: number;
}

/** Shared per-peer state that expires. Create with {@link createWebSocketPresence}. */
export interface WebSocketPresence<P> {
  /** The client the state is shared on. */
  readonly client: WebSocketClient<any, any>;
  /**
   * Share this client's state, e.g. on every pointer move. It's sent at most `maxRate` times per
   * second, the newest only, and again on every new connection and every `refresh`.
   */
  set(state: P): void;
  /** Stop sharing, and send `leave`. `set()` shares again. */
  leave(): void;
  /** The other peers, in the order they first appeared. A new array on every change. */
  getSnapshot(): readonly PresencePeer<P>[];
  /** Get notified when the peers change. Compatible with `useSyncExternalStore`. */
  subscribe(listener: () => void): () => void;
  /** Stop sharing and listening. */
  dispose(): void;
}

const VOLATILE = { volatile: true };

/**
 * Share per-peer state that expires, for presence, live cursors and selections.
 *
 * - `set(state)` shares this client's state, throttled to `maxRate` sends per second with the
 *   newest winning, and sent again on every new connection and every `refresh`, so it's never
 *   queued stale while disconnected.
 * - Other peers' states come from `receive`. A peer is forgotten when it leaves (`state: null`)
 *   or when nothing has arrived from it for `timeout`.
 *
 * The server relays each client's state to the others, tagged with a peer id, and says
 * `state: null` when a client disconnects.
 *
 * @example
 * ```ts
 * export const cursors = createWebSocketPresence(room, {
 *   send: (cursor: { x: number; y: number }) => ({ type: 'cursor', cursor }),
 *   leave: () => ({ type: 'leave' }),
 *   receive: message => (message.type === 'cursor' ? { peer: message.peer, state: message.cursor } : undefined)
 * });
 *
 * window.addEventListener('pointermove', event => cursors.set({ x: event.clientX, y: event.clientY }));
 * ```
 */
// `NoInfer`: take `In` and `Out` from the client only; `P` comes from how `send` annotates `state`.
export function createWebSocketPresence<P, In, const Out>(
  client: WebSocketClient<In, Out>,
  options: WebSocketPresenceOptions<P, NoInfer<In>, NoInfer<Out>>
): WebSocketPresence<P> {
  const timeout = options.timeout ?? 30_000;
  const interval = 1000 / (options.maxRate ?? 20);
  const peers = new Map<string, PresencePeer<P>>();
  const listeners = new Set<() => void>();
  let snapshot: readonly PresencePeer<P>[] = [];
  // This client's state while it's shared, and when it was last sent.
  let own: { state: P } | undefined;
  let lastSent = -Infinity;
  let sendTimer: Timer;
  let refreshTimer: ReturnType<typeof setInterval> | undefined;
  let expiryTimer: Timer;

  function changed() {
    snapshot = [...peers.values()];
    for (const listener of [...listeners]) listener();
  }

  function sendNow() {
    clearTimeout(sendTimer);
    sendTimer = undefined;
    if (!own) return;
    lastSent = Date.now();
    // Volatile: a new connection gets the newest state from the `open` listener instead.
    client.send(options.send(own.state), VOLATILE);
  }

  function expire() {
    expiryTimer = undefined;
    const now = Date.now();
    let next = Infinity;
    let removed = false;
    for (const [peer, entry] of peers) {
      const at = entry.updatedAt + timeout;
      if (at <= now) removed = peers.delete(peer);
      else next = Math.min(next, at);
    }
    if (next < Infinity) expiryTimer = setTimeout(expire, next - now);
    if (removed) changed();
  }

  const offs = [
    client.on('open', sendNow),
    client.on('message', message => {
      const update = options.receive(message);
      if (!update) return;
      if (update.state === null) {
        if (!peers.delete(update.peer)) return;
      } else {
        peers.set(update.peer, { peer: update.peer, state: update.state, updatedAt: Date.now() });
        expiryTimer ??= setTimeout(expire, timeout);
      }
      changed();
    })
  ];

  return {
    client,
    set(state) {
      own = { state };
      refreshTimer ??= setInterval(sendNow, options.refresh ?? timeout / 3);
      if (sendTimer !== undefined) return; // the newest goes out when it fires
      const wait = lastSent + interval - Date.now();
      if (wait <= 0) sendNow();
      else sendTimer = setTimeout(sendNow, wait);
    },
    leave() {
      own = undefined;
      clearTimeout(sendTimer);
      sendTimer = undefined;
      clearInterval(refreshTimer);
      refreshTimer = undefined;
      if (options.leave) client.send(options.leave(), VOLATILE);
    },
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    dispose() {
      own = undefined;
      clearTimeout(sendTimer);
      clearInterval(refreshTimer);
      clearTimeout(expiryTimer);
      for (const off of offs) off();
    }
  };
}
