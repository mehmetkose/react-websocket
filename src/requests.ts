import type { SendOptions, WebSocketClient } from './types';

/** Options for {@link createWebSocketRequests}: how requests and replies look on the wire. */
export interface WebSocketRequestsOptions<Req, In, Out> {
  /**
   * Build the outgoing message for `request(message)`, tagged with `id`. Annotate `message`
   * to type what `request()` accepts.
   */
  send: (message: Req, id: number) => Out;
  /**
   * The id an incoming message replies to, or `undefined` (or `null`) if it isn't a reply.
   * A string id matches the number it was sent as, so either echo works.
   */
  reply: (message: In) => number | string | null | undefined;
  /**
   * Called on a reply. Return something other than `undefined` to reject the request with
   * it instead of resolving, e.g. for a server-side error reply.
   */
  error?: (message: In) => unknown;
  /**
   * Default time to wait for a reply, in ms. `Infinity` waits forever.
   * @default 10000
   */
  timeout?: number;
}

/** Per-call options for {@link WebSocketRequests.request}. */
export interface RequestOptions extends SendOptions {
  /** Time to wait for a reply, in ms. Overrides the manager's `timeout`. */
  timeout?: number;
  /** Abort the request. It rejects with `signal.reason`. A late reply is ignored. */
  signal?: AbortSignal;
}

/** Request/response over one client. Create with {@link createWebSocketRequests}. */
export interface WebSocketRequests<Req, In> {
  /** The client requests are sent on. */
  readonly client: WebSocketClient<any, any>;
  /**
   * Send a request and resolve with its reply. Holds the connection until it settles.
   *
   * Rejects with a `TimeoutError` `DOMException` after `timeout`, with `signal.reason` when
   * aborted, and with an `Error` when the connection it was sent on closes (the reply can
   * no longer arrive) or the client stops. A request made while disconnected is queued like
   * any other message and waits for the connection; it rejects if it is dropped from the
   * queue (replaced by a newer request with the same `key`, or evicted by `queue.limit`).
   */
  request(message: Req, options?: RequestOptions): Promise<In>;
  /** Number of requests waiting for a reply. */
  pending(): number;
  /** Reject every pending request and stop listening. Only needed for managers created dynamically. */
  dispose(): void;
}

// Last id sent per client, shared by its managers so two of them never send the same id
// and resolve each other's requests with one reply.
const lastIds = new WeakMap<WebSocketClient<any, any>, number>();

interface Pending<In> {
  resolve(reply: In): void;
  reject(reason: unknown): void;
  /** The socket the request went out on, or `null` while it waits in the client's queue. */
  socket: WebSocket | null;
}

/**
 * Send requests and await their replies, matched by an id the library generates.
 *
 * Replies are ordinary messages: they also reach `onMessage`, `lastMessage` and state stores.
 *
 * @example
 * ```ts
 * type Request = { type: 'join'; room: string } | { type: 'leave' };
 *
 * export const rpc = createWebSocketRequests(game, {
 *   send: (message: Request, id) => ({ ...message, id }),
 *   reply: message => (message.type === 'reply' ? message.id : undefined),
 *   error: message => (message.type === 'reply' && message.error ? new Error(message.error) : undefined)
 * });
 *
 * const reply = await rpc.request({ type: 'join', room: 'lobby' }, { timeout: 5000 });
 * ```
 */
// `const` + `NoInfer`: `In` and `Out` come from the client only, with literals kept unwidened;
// `Req` comes from how `send` annotates its parameter.
export function createWebSocketRequests<Req, In, const Out>(
  client: WebSocketClient<In, Out>,
  options: WebSocketRequestsOptions<Req, NoInfer<In>, NoInfer<Out>>
): WebSocketRequests<Req, In> {
  const waiting = new Map<string, Pending<In>>();

  function rejectWhere(test: (entry: Pending<In>) => boolean, reason: () => unknown) {
    for (const entry of [...waiting.values()]) if (test(entry)) entry.reject(reason());
  }

  const offs = [
    client.on('message', message => {
      const id = options.reply(message);
      const entry = id == null ? undefined : waiting.get(String(id));
      if (!entry) return;
      const error = options.error?.(message);
      if (error === undefined) entry.resolve(message);
      else entry.reject(error);
    }),
    // `open` listeners run before the client flushes its queue: queued requests go out on this socket.
    client.on('open', () => {
      for (const entry of waiting.values()) entry.socket ??= client.socket;
    }),
    client.subscribe(() => {
      const { status } = client.getSnapshot();
      if (status === 'closed' || status === 'idle') {
        // The queue was cleared too, so nothing still waiting can be sent.
        rejectWhere(
          () => true,
          () => new Error('WebSocket was closed before the request was answered')
        );
      } else {
        rejectWhere(
          entry => entry.socket !== null && entry.socket !== client.socket,
          () => new Error('WebSocket connection was lost before the request was answered')
        );
      }
    })
  ];

  return {
    client,
    request(message, requestOptions = {}) {
      const { signal } = requestOptions;
      if (signal?.aborted) return Promise.reject(signal.reason);

      const id = (lastIds.get(client) ?? 0) + 1;
      lastIds.set(client, id);
      const key = String(id);
      const timeout = requestOptions.timeout ?? options.timeout ?? 10_000;

      return new Promise<In>((resolve, reject) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const release = client.acquire();
        const onAbort = () => entry.reject(signal!.reason);

        function settle() {
          waiting.delete(key);
          clearTimeout(timer);
          signal?.removeEventListener('abort', onAbort);
          release();
        }

        const entry: Pending<In> = {
          socket: null,
          resolve(reply) {
            settle();
            resolve(reply);
          },
          reject(reason) {
            settle();
            reject(reason);
          }
        };
        waiting.set(key, entry);
        signal?.addEventListener('abort', onAbort, { once: true });
        if (timeout > 0 && timeout < Infinity) {
          timer = setTimeout(
            () =>
              entry.reject(
                new DOMException(`Request ${id} timed out after ${timeout}ms`, 'TimeoutError')
              ),
            timeout
          );
        }

        const { status } = client.getSnapshot();
        if (status === 'closed' || status === 'idle') {
          // Closed until someone reconnects it, or (idle after acquiring) it can't connect here.
          entry.reject(new Error(`WebSocket is ${status}: request not sent`));
          return;
        }
        let sent: boolean;
        try {
          sent = client.send(options.send(message, id), {
            ...requestOptions,
            onDrop() {
              entry.reject(new Error('Request was dropped from the send queue before it was sent'));
              requestOptions.onDrop?.();
            }
          });
        } catch (error) {
          entry.reject(error);
          return;
        }
        if (sent) entry.socket = client.socket;
        // Open but not sent: `maxBuffered` dropped it, and nothing will send it later.
        else if (client.socket?.readyState === 1)
          entry.reject(new Error('WebSocket send buffer is full: request dropped'));
        else if (requestOptions.volatile)
          entry.reject(new Error('WebSocket is not open: request dropped'));
      });
    },
    pending: () => waiting.size,
    dispose() {
      offs.forEach(off => off());
      rejectWhere(
        () => true,
        () => new Error('Requests were disposed')
      );
    }
  };
}
