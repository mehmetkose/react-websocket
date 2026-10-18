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
   * it instead of resolving, e.g. for a server-side error reply. A stream throws it.
   */
  error?: (message: In) => unknown;
  /**
   * Whether a reply is the last one of a stream. `stream()` needs it. That reply is yielded
   * too, then the stream ends.
   */
  done?: (message: In) => boolean;
  /**
   * Build the message that tells the server to stop working on request `id`. Sent when this
   * side gives up: the request's `signal` aborts, it times out, a loop over a stream exits
   * early, or the manager is disposed. Not sent after the last reply, an error reply, a lost
   * connection or `close()`.
   */
  cancel?: (id: number) => Out;
  /**
   * Default time to wait for a reply, in ms. For a stream, the time to wait for each reply,
   * including the first. `Infinity` waits forever.
   * @default 10000
   */
  timeout?: number;
}

/** Per-call options for {@link WebSocketRequests.request} and {@link WebSocketRequests.stream}. */
export interface RequestOptions extends SendOptions {
  /**
   * Time to wait for a reply (for a stream, for each reply), in ms. Overrides the manager's
   * `timeout`.
   */
  timeout?: number;
  /** Abort the request. It rejects (a stream throws) with `signal.reason`. A late reply is ignored. */
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
  /**
   * Send a request and iterate over its replies, up to and including the one `done` matches.
   * Holds the connection until the stream ends. Needs the `done` option.
   *
   * `timeout` is the time to wait for each reply. Replies that arrive before the loop reads
   * them are buffered. The stream is one-shot: iterate it once.
   *
   * Fails where `request()` rejects, with the same errors, after yielding the replies already
   * received. Aborting `signal` throws `signal.reason` right away and discards them. Leaving
   * the loop early, aborting and timing out send `cancel`.
   *
   * @example
   * ```ts
   * for await (const reply of rpc.stream({ type: 'ask', prompt }, { signal })) {
   *   text += reply.delta;
   * }
   * ```
   */
  stream(message: Req, options?: RequestOptions): AsyncIterableIterator<In>;
  /** Number of requests and streams waiting for a reply. */
  pending(): number;
  /** Reject every pending request and stop listening. Only needed for managers created dynamically. */
  dispose(): void;
}

// Last id sent per client, shared by its managers so two of them never send the same id
// and resolve each other's requests with one reply.
const lastIds = new WeakMap<WebSocketClient<any, any>, number>();

const noop = () => {};

interface Pending<In> {
  /** The socket the request went out on, or `null` while it waits in the client's queue. */
  socket: WebSocket | null;
  /** A reply that isn't an error. */
  receive(reply: In): void;
  /** Settle, failed with `reason` or not. `cancel` tells the server to stop. Only the first call counts. */
  end(failed: boolean, reason?: unknown, cancel?: boolean): void;
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

  function endWhere(
    test: (entry: Pending<In>) => boolean,
    reason: () => unknown,
    cancel?: boolean
  ) {
    for (const entry of [...waiting.values()]) if (test(entry)) entry.end(true, reason(), cancel);
  }

  const offs = [
    client.on('message', message => {
      const id = options.reply(message);
      const entry = id == null ? undefined : waiting.get(String(id));
      if (!entry) return;
      const error = options.error?.(message);
      if (error === undefined) entry.receive(message);
      else entry.end(true, error);
    }),
    // `open` listeners run before the client flushes its queue: queued requests go out on this socket.
    client.on('open', () => {
      for (const entry of waiting.values()) entry.socket ??= client.socket;
    }),
    client.subscribe(() => {
      const { status } = client.getSnapshot();
      if (status === 'closed' || status === 'idle') {
        // The queue was cleared too, so nothing still waiting can be sent.
        endWhere(
          () => true,
          () => new Error('WebSocket was closed before the request was answered')
        );
      } else {
        endWhere(
          entry => entry.socket !== null && entry.socket !== client.socket,
          () => new Error('WebSocket connection was lost before the request was answered')
        );
      }
    })
  ];

  /**
   * Send `message` as a new request. `next` gets each reply that isn't an error and returns
   * whether it was the last; `done` runs once, when the request ends. Returns a function that
   * ends it from this side and tells the server.
   */
  function start(
    message: Req,
    requestOptions: RequestOptions,
    next: (reply: In) => boolean,
    done: (failed: boolean, reason?: unknown) => void
  ): () => void {
    const { signal, priority } = requestOptions;
    if (signal?.aborted) {
      done(true, signal.reason);
      return noop;
    }

    if (client.getSnapshot().status === 'closed') {
      // Closed until someone reconnects it. Holding it would start it again, or leave it idle.
      done(true, new Error('WebSocket is closed: request not sent'));
      return noop;
    }
    const id = (lastIds.get(client) ?? 0) + 1;
    lastIds.set(client, id);
    const key = String(id);
    const timeout = requestOptions.timeout ?? options.timeout ?? 10_000;
    const release = client.acquire();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onAbort = () => entry.end(true, signal!.reason, true);

    function arm() {
      clearTimeout(timer);
      if (timeout > 0 && timeout < Infinity) {
        timer = setTimeout(
          () =>
            entry.end(
              true,
              new DOMException(`Request ${id} timed out after ${timeout}ms`, 'TimeoutError'),
              true
            ),
          timeout
        );
      }
    }

    const entry: Pending<In> = {
      socket: null,
      receive(reply) {
        if (next(reply)) entry.end(false);
        else arm();
      },
      end(failed, reason, cancel) {
        if (!waiting.delete(key)) return;
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        release();
        done(failed, reason);
        if (cancel && options.cancel) {
          try {
            // Still queued, it can't be taken back: queue the cancel right behind it. Once sent,
            // the cancel only means something on that connection, so drop it unless that one is
            // still open. Not `volatile`, which can be a datagram that never arrives.
            if (!entry.socket) client.send(options.cancel(id), { priority });
            else if (entry.socket === client.socket && entry.socket.readyState === 1) {
              client.send(options.cancel(id));
            }
          } catch (error) {
            queueMicrotask(() => {
              throw error;
            });
          }
        }
      }
    };
    waiting.set(key, entry);
    signal?.addEventListener('abort', onAbort, { once: true });
    arm();

    if (client.getSnapshot().status === 'idle') {
      // Idle after acquiring: it can't connect here (a server render).
      entry.end(true, new Error('WebSocket is idle: request not sent'));
    } else {
      try {
        const sent = client.send(options.send(message, id), {
          ...requestOptions,
          onDrop() {
            entry.end(
              true,
              new Error('Request was dropped from the send queue before it was sent')
            );
            requestOptions.onDrop?.();
          }
        });
        if (sent) entry.socket = client.socket;
        // Open but not sent: `maxBuffered` dropped it, and nothing will send it later.
        else if (client.socket?.readyState === 1)
          entry.end(true, new Error('WebSocket send buffer is full: request dropped'));
        else if (requestOptions.volatile)
          entry.end(true, new Error('WebSocket is not open: request dropped'));
      } catch (error) {
        entry.end(true, error);
      }
    }
    return () => entry.end(false, undefined, true);
  }

  return {
    client,
    request(message, requestOptions = {}) {
      return new Promise<In>((resolve, reject) => {
        start(
          message,
          requestOptions,
          reply => {
            resolve(reply);
            return true;
          },
          (failed, reason) => {
            if (failed) reject(reason);
          }
        );
      });
    },
    stream(message, requestOptions = {}) {
      const last = options.done;
      if (!last) throw new TypeError('stream() needs the `done` option');
      const replies: In[] = [];
      let ended: [failed: boolean, reason: unknown] | undefined;
      let wake = noop;
      const stop = start(
        message,
        requestOptions,
        reply => {
          replies.push(reply);
          wake();
          return last(reply);
        },
        (failed, reason) => {
          // Aborting stops right away; any other end comes after the replies already received.
          if (requestOptions.signal?.aborted) replies.length = 0;
          ended = [failed, reason];
          wake();
        }
      );

      async function* read() {
        try {
          for (;;) {
            if (replies.length) yield replies.shift()!;
            else if (ended) {
              if (ended[0]) throw ended[1];
              return;
            } else await new Promise<void>(resolve => (wake = resolve));
          }
        } finally {
          stop();
        }
      }

      const iterator = read();
      const close = iterator.return;
      // A generator closed before its first `next()` skips `finally`, and one closed during a
      // `next()` waits for it: stop first, so leaving a loop tells the server right away.
      iterator.return = value => {
        stop();
        return close.call(iterator, value);
      };
      return iterator;
    },
    pending: () => waiting.size,
    dispose() {
      offs.forEach(off => off());
      endWhere(
        () => true,
        () => new Error('Requests were disposed'),
        true
      );
    }
  };
}
