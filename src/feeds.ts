import { createWebSocketTopics, ON_RELEASE, type WebSocketTopics } from './topics';
import type { WebSocketClient } from './types';

/** Where a numbered message belongs: its topic, and its sequence number in that topic. */
export interface FeedPosition {
  readonly topic: string;
  /** One more than the message before it on the same topic. */
  readonly seq: number;
}

/** Options for {@link createWebSocketFeeds}: the messages your server expects and sends. */
export interface WebSocketFeedsOptions<In, Out> {
  /**
   * The message that subscribes to `topic`. `after` is the sequence number of the last message
   * received on it, so the server can send the ones after it, or `undefined` the first time.
   * Sent on every new connection too.
   */
  subscribe: (topic: string, after: number | undefined) => Out;
  /** The message that unsubscribes from `topic`. Omit it if your server has none. */
  unsubscribe?: (topic: string) => Out;
  /**
   * The message that asks for what came after `after` when messages went missing on an open
   * connection. Defaults to `subscribe(topic, after)`.
   */
  resume?: (topic: string, after: number) => Out;
  /** Recognize a numbered message: its topic and sequence number. `undefined` for any other. */
  sequence: (message: In) => FeedPosition | null | undefined;
  /**
   * Recognize a snapshot: a topic's whole state as of `seq`, which the server sends when it
   * can't replay the messages after `after`. It's always delivered, and the numbering goes on
   * from it.
   */
  snapshot?: (message: In) => FeedPosition | null | undefined;
  /** Called when a message arrives after a gap, before the missing ones are asked for. */
  onGap?: (topic: string, after: number, received: number) => void;
}

/**
 * Topic subscriptions whose messages are numbered. A {@link WebSocketTopics}, so
 * `useWebSocketTopic` takes it, and a message source for `createWebSocketState`.
 * Create with {@link createWebSocketFeeds}.
 */
export interface WebSocketFeeds<In> extends WebSocketTopics {
  /**
   * Listen to messages in order: numbered ones once each and without gaps, others as they
   * arrive. Returns an unsubscribe function.
   */
  on(type: 'message', listener: (message: In, event: MessageEvent) => void): () => void;
  /** The sequence number of the last message delivered on `topic`, while it's held. */
  position(topic: string): number | undefined;
}

/**
 * Subscribe to topics whose messages carry a sequence number, and get each message once, in
 * order, across reconnects:
 *
 * - On every new connection, each held topic is subscribed again with `after`, the last
 *   number received, so the server sends what was missed instead of everything.
 * - A message numbered at or below the last one is a duplicate and is dropped.
 * - A message that skips numbers is held back, and the topic asks for what's missing (`resume`)
 *   once, so nothing is delivered out of order.
 * - A server that can't replay sends a `snapshot`, and the numbering goes on from it.
 *
 * Listen with `feeds.on('message', …)`, or pass `feeds` to `createWebSocketState` in place of
 * the client. Hold topics with `useWebSocketTopic(feeds, topic)` or `feeds.acquire(topic)`.
 *
 * @example
 * ```ts
 * export const feeds = createWebSocketFeeds(live, {
 *   subscribe: (topic, after) => ({ type: 'subscribe', topic, after }),
 *   unsubscribe: topic => ({ type: 'unsubscribe', topic }),
 *   sequence: message => (message.type === 'event' ? message : undefined),
 *   snapshot: message => (message.type === 'snapshot' ? message : undefined)
 * });
 *
 * export const chat = createWebSocketState(feeds, { initialState: [], reduce: addMessage });
 * ```
 */
// `NoInfer`: take `In` and `Out` from the client only.
export function createWebSocketFeeds<In, const Out>(
  client: WebSocketClient<In, Out>,
  options: WebSocketFeedsOptions<NoInfer<In>, NoInfer<Out>>
): WebSocketFeeds<In> {
  // The last number delivered per topic, from its first message until nothing holds it.
  const last = new Map<string, number>();
  // Topics that asked for missing messages, so a burst after a gap asks only once.
  const resuming = new Set<string>();
  const listeners = new Set<(message: In, event: MessageEvent) => void>();
  const topics = createWebSocketTopics(client, {
    subscribe: topic => options.subscribe(topic, last.get(topic)),
    unsubscribe: options.unsubscribe,
    [ON_RELEASE]: topic => {
      last.delete(topic);
      resuming.delete(topic);
    }
  });

  const offs = [
    // The new connection subscribes again with `after`, which asks for what's missing.
    client.on('open', () => resuming.clear()),
    client.on('message', (message, event) => {
      const snapshot = options.snapshot?.(message);
      const position = snapshot ?? options.sequence(message);
      if (position) {
        const { topic, seq } = position;
        const prev = last.get(topic);
        if (prev !== undefined && !snapshot && seq !== prev + 1) {
          // Not the next one: a duplicate, or one after a gap, which waits for those before it.
          if (seq > prev && !resuming.has(topic)) {
            resuming.add(topic);
            options.onGap?.(topic, prev, seq);
            client.send((options.resume ?? options.subscribe)(topic, prev), { volatile: true });
          }
          return;
        }
        // Count from the first message on a topic this holds, not on one it doesn't.
        if (prev !== undefined || topics.active().includes(topic)) last.set(topic, seq);
        resuming.delete(topic);
      }
      for (const listener of [...listeners]) {
        try {
          listener(message, event);
        } catch (error) {
          queueMicrotask(() => {
            throw error;
          });
        }
      }
    })
  ];

  return {
    ...topics,
    on(_type, listener) {
      // Wrapped, so the same function can be added twice and removed independently.
      const entry = (message: In, event: MessageEvent) => listener(message, event);
      listeners.add(entry);
      return () => {
        listeners.delete(entry);
      };
    },
    position: topic => last.get(topic),
    dispose() {
      topics.dispose();
      for (const off of offs) off();
    }
  };
}
