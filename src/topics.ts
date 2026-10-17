import type { WebSocketClient } from './types';

type Timer = ReturnType<typeof setTimeout>;

/** Options for {@link createWebSocketTopics}: the messages your server expects. */
export interface WebSocketTopicsOptions<Out> {
  /** The message that subscribes to `topic`. */
  subscribe: (topic: string) => Out;
  /** The message that unsubscribes from `topic`. Omit it if your server has none. */
  unsubscribe?: (topic: string) => Out;
}

/** Reference-counted topic subscriptions on one client. Create with {@link createWebSocketTopics}. */
export interface WebSocketTopics {
  /** The client the subscription messages are sent on. */
  readonly client: WebSocketClient<any, any>;
  /**
   * Hold a subscription to `topic`, and the client's connection, until the returned
   * function is called. The release function is safe to call more than once.
   */
  acquire(topic: string): () => void;
  /** The topics currently held, in the order they were first acquired. */
  active(): string[];
  /** Stop managing subscriptions. Only needed for managers created dynamically. */
  dispose(): void;
}

/**
 * Manage topic subscriptions that survive reconnects.
 *
 * - The first holder of a topic sends `subscribe(topic)`. Later holders share it.
 * - A tick after the last holder releases it, `unsubscribe(topic)` is sent, so StrictMode
 *   and route transitions don't churn subscriptions.
 * - After every reconnect, every held topic is subscribed again on the new socket, before
 *   messages queued while disconnected are sent.
 *
 * Subscriptions are only sent while the socket is open; nothing is queued for them.
 *
 * @example
 * ```ts
 * export const topics = createWebSocketTopics(live, {
 *   subscribe: topic => ({ type: 'subscribe', topic }),
 *   unsubscribe: topic => ({ type: 'unsubscribe', topic })
 * });
 *
 * // In a component:
 * useWebSocketTopic(topics, `prices:${symbol}`);
 * ```
 */
// `const` + `NoInfer`: take `Out` from the client only, and keep literals such as
// `type: 'subscribe'` from widening to `string` inside the callbacks.
export function createWebSocketTopics<const Out>(
  client: WebSocketClient<any, Out>,
  options: WebSocketTopicsOptions<NoInfer<Out>>
): WebSocketTopics {
  const counts = new Map<string, number>();
  const pendingRemoval = new Map<string, Timer>();
  // Topics subscribed on `sentOn`. A new socket starts with none, whatever the old one had.
  let sentOn: WebSocket | null = null;
  let sent = new Set<string>();

  function isOpen() {
    return client.getSnapshot().status === 'open' && client.socket !== null;
  }

  function subscribe(topic: string) {
    if (!isOpen()) return; // sent on `open` instead
    if (client.socket !== sentOn) {
      sentOn = client.socket;
      sent = new Set();
    }
    if (sent.has(topic)) return;
    sent.add(topic);
    client.send(options.subscribe(topic));
  }

  function unsubscribe(topic: string) {
    if (!isOpen() || client.socket !== sentOn || !sent.delete(topic)) return;
    if (options.unsubscribe) client.send(options.unsubscribe(topic));
  }

  // `open` listeners run before the client flushes its queue.
  const off = client.on('open', () => {
    sentOn = client.socket;
    sent = new Set();
    for (const topic of counts.keys()) subscribe(topic);
  });

  return {
    client,
    acquire(topic) {
      const releaseConnection = client.acquire();
      clearTimeout(pendingRemoval.get(topic));
      pendingRemoval.delete(topic);
      counts.set(topic, (counts.get(topic) ?? 0) + 1);
      subscribe(topic);

      let released = false;
      return () => {
        if (released) return;
        released = true;
        const remaining = (counts.get(topic) ?? 1) - 1;
        if (remaining > 0) {
          counts.set(topic, remaining);
        } else {
          counts.delete(topic);
          pendingRemoval.set(
            topic,
            setTimeout(() => {
              pendingRemoval.delete(topic);
              if (!counts.has(topic)) unsubscribe(topic);
            }, 0)
          );
        }
        releaseConnection();
      };
    },
    active: () => [...counts.keys()],
    dispose() {
      off();
      for (const timer of pendingRemoval.values()) clearTimeout(timer);
      pendingRemoval.clear();
    }
  };
}
