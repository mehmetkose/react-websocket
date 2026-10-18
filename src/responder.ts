import type { WebSocketClient } from './types';

/** What `request` returns for a request: any object with these fields, such as the message itself. */
type RequestFields = { id: number | string; method: string; params?: unknown; timeout?: number };

/**
 * The type of `params` in `Q`, keeping `undefined` when they're optional and giving `undefined`
 * when there are none. (Inferring `params?: P` directly would drop the `undefined`.)
 */
type ParamsOf<Q> = Q extends unknown
  ? 'params' extends keyof Q
    ? Q['params' & keyof Q]
    : undefined
  : never;

/**
 * Options for {@link createWebSocketResponder}: how the server's requests and your replies look
 * on the wire.
 *
 * @typeParam Q - What `request` returns. Handlers receive its `params`.
 * @typeParam R - What handlers return, from the annotation on `respond`'s `result`.
 */
export interface WebSocketResponderOptions<Q extends RequestFields, R, In, Out> {
  /**
   * Recognize a request from the server: its `id`, the `method` handlers are registered for,
   * and the `params` they receive. Return `undefined` (or `null`) for any other message.
   * A `timeout` (in ms) overrides the manager's for this request.
   *
   * `params` come from the server, so validate them before acting on them.
   */
  request: (message: In) => Q | null | undefined;
  /** Build the reply to request `id`. Annotate `result` to type what handlers return. */
  respond: (id: number | string, result: R) => Out;
  /**
   * Build the error reply to request `id`: what a handler threw, a `NotFoundError` `DOMException`
   * when nothing is registered for the method, a `TimeoutError` after `timeout`, or an
   * `AbortError` from `dispose()`.
   */
  error: (id: number | string, error: unknown) => Out;
  /**
   * The id of a request the server withdrew, or `undefined` (or `null`) if the message isn't a
   * cancellation. The request's `signal` aborts and nothing is sent.
   */
  cancel?: (message: In) => number | string | null | undefined;
  /**
   * Time to answer a request, in ms. When it runs out, the `error` reply (a `TimeoutError`)
   * is sent and the request's `signal` aborts.
   * @default Infinity
   */
  timeout?: number;
}

/** A request from the server that hasn't been answered yet. */
export interface IncomingRequest<P = unknown, R = unknown> {
  /** The id the server sent. Replies carry it back. */
  readonly id: number | string;
  /** The method it was sent for. */
  readonly method: string;
  /** The `params` from `request`. They come from the server, so validate them. */
  readonly params: P;
  /**
   * Aborts when the answer is no longer wanted: the server cancelled the request, it timed out,
   * the connection it arrived on closed, the responder was disposed, or it was answered with
   * `respond` or `reject` while its handler was still running.
   */
  readonly signal: AbortSignal;
  /**
   * Reply with `result`. Only the first answer counts.
   * @returns `true` if the reply was sent, `false` if the request was already answered or is gone.
   */
  respond(result: R): boolean;
  /**
   * Reply with an error, built by the `error` option. Only the first answer counts.
   * @returns `true` if the reply was sent, `false` if the request was already answered or is gone.
   */
  reject(error: unknown): boolean;
}

/**
 * Answers a request in code. Return (or resolve) the result to reply with it; throw (or reject)
 * to send the `error` reply instead.
 */
export type RequestHandler<P = unknown, R = unknown> = (
  params: P,
  request: IncomingRequest<P, R>
) => R | PromiseLike<R>;

/** Answers the server's requests on one client. Create with {@link createWebSocketResponder}. */
export interface WebSocketResponder<P = unknown, R = unknown> {
  /** The client requests arrive on. Hooks reading the responder keep it connected. */
  readonly client: WebSocketClient<any, any>;
  /**
   * Answer requests for `method` until the returned function is called.
   *
   * With a `handler`, requests are answered in code. Without one, they wait in
   * {@link getSnapshot} until something calls `respond` or `reject` on them, e.g. a dialog
   * that asks the user. When several registrations exist for one method, the newest one takes
   * new requests, and unregistering it hands them back to the previous one. Requests for a
   * method with no registration get a `NotFoundError` reply.
   *
   * @returns An unregister function (safe to call more than once). Requests already waiting stay.
   */
  onRequest(method: string, handler?: RequestHandler<P, R>): () => void;
  /**
   * Requests waiting for an answer from outside a handler, oldest first. Returns the same array
   * until it changes.
   */
  getSnapshot(): readonly IncomingRequest<P, R>[];
  /** Called whenever {@link getSnapshot} changes. Compatible with `useSyncExternalStore`. */
  subscribe(listener: () => void): () => void;
  /**
   * Stop answering: send an `AbortError` reply to every request in flight and stop listening.
   * Only needed for responders created dynamically.
   */
  dispose(): void;
}

interface Entry {
  /** The socket the request arrived on. Its reply can only go back on that one. */
  readonly socket: WebSocket | null;
  /** Forget the request and abort its signal, without replying. */
  drop(reason: DOMException): void;
  /** Forget the request, abort its signal and send the `error` reply, both with `error`. */
  fail(error: DOMException): void;
}

const abortError = (message: string) => new DOMException(message, 'AbortError');

/**
 * Answer requests the server sends: run a handler for tools that only exist in the browser
 * (selection, clipboard, geolocation), or let a person answer, e.g. to approve an agent's action.
 * The reverse of `createWebSocketRequests`.
 *
 * Every request gets exactly one reply while its connection lives: the handler's result, an
 * `error` reply when it throws, has no registration or times out. When the connection a request
 * arrived on closes, the request is dropped and nothing is sent, since the server can't match a
 * reply on a new connection. Replies are never queued.
 *
 * Requests are ordinary messages: they also reach `onMessage`, `lastMessage` and state stores.
 *
 * @example
 * ```ts
 * export const tools = createWebSocketResponder(agent, {
 *   request: message => (message.type === 'call' ? message : undefined),
 *   respond: (id, result: unknown) => ({ type: 'result', id, result }),
 *   error: (id, error) => ({ type: 'result', id, error: String(error) })
 * });
 *
 * tools.onRequest('get_selection', () => window.getSelection()?.toString() ?? '');
 *
 * // In a component: requests a person answers.
 * const approvals = useAgentApproval(tools, 'approve');
 * approvals[0]?.respond({ approved: true });
 * ```
 */
// `const` + `NoInfer`: `In` and `Out` come from the client only, with literals kept unwidened;
// `Q` comes from what `request` returns and `R` from how `respond` annotates `result`.
export function createWebSocketResponder<Q extends RequestFields, R, In, const Out>(
  client: WebSocketClient<In, Out>,
  options: WebSocketResponderOptions<Q, R, NoInfer<In>, NoInfer<Out>>
): WebSocketResponder<ParamsOf<Q>, R> {
  type P = ParamsOf<Q>;
  const entries = new Map<string, Entry>();
  const registrations = new Map<string, { handler?: RequestHandler<P, R> }[]>();
  const listeners = new Set<() => void>();
  let waiting: readonly IncomingRequest<P, R>[] = [];

  function setWaiting(next: readonly IncomingRequest<P, R>[]) {
    waiting = next;
    for (const listener of [...listeners]) listener();
  }

  /**
   * Send a reply, or an `error` reply if building or encoding it throws. Only while open: never
   * queued, and not `volatile`, which can be a datagram that never arrives.
   */
  function reply(id: number | string, build: () => Out): boolean {
    if (client.socket?.readyState !== 1) return false;
    try {
      return client.send(build());
    } catch (error) {
      return client.send(options.error(id, error));
    }
  }

  function receive(incoming: Q) {
    const { id, method } = incoming;
    const key = String(id);
    if (entries.has(key)) return; // sent again while it is being answered
    const registration = registrations.get(method)?.at(-1);
    if (!registration) {
      const error = new DOMException(`No handler for request method "${method}"`, 'NotFoundError');
      reply(id, () => options.error(id, error));
      return;
    }

    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let done = false;
    let running = false;

    function settle(build: (() => Out) | null, reason?: unknown) {
      if (done) return false;
      done = true;
      entries.delete(key);
      clearTimeout(timer);
      if (waiting.includes(request)) setWaiting(waiting.filter(entry => entry !== request));
      if (reason !== undefined) controller.abort(reason);
      return build ? reply(id, build) : false;
    }

    // An answer from outside the handler makes the handler's work moot.
    const answeredElsewhere = () =>
      running ? abortError(`Request ${id} was answered elsewhere`) : undefined;
    const request: IncomingRequest<P, R> = {
      id,
      method,
      params: incoming.params as P,
      signal: controller.signal,
      respond: result => settle(() => options.respond(id, result), answeredElsewhere()),
      reject: error => settle(() => options.error(id, error), answeredElsewhere())
    };
    const fail = (error: DOMException) => {
      settle(() => options.error(id, error), error);
    };
    // Registered before the handler runs, so a handler that closes the socket drops its own request.
    entries.set(key, {
      socket: client.socket,
      drop: reason => {
        settle(null, reason);
      },
      fail
    });

    const timeout = incoming.timeout ?? options.timeout ?? Infinity;
    if (timeout > 0 && timeout < Infinity) {
      timer = setTimeout(
        () =>
          fail(
            new DOMException(`Request ${id} was not answered within ${timeout}ms`, 'TimeoutError')
          ),
        timeout
      );
    }

    const { handler } = registration;
    if (!handler) {
      setWaiting([...waiting, request]);
      return;
    }
    running = true;
    // Also catches a handler that throws synchronously.
    new Promise<R>(resolve => resolve(handler(request.params, request))).then(
      result => {
        running = false;
        request.respond(result);
      },
      error => {
        running = false;
        request.reject(error);
      }
    );
  }

  const offs = [
    client.on('message', message => {
      const incoming = options.request(message);
      if (incoming != null) {
        receive(incoming);
        return;
      }
      const id = options.cancel?.(message);
      if (id != null) {
        entries.get(String(id))?.drop(abortError(`Request ${id} was cancelled`));
      }
    }),
    // Every close, reconnect and teardown replaces `client.socket` and notifies.
    client.subscribe(() => {
      for (const entry of [...entries.values()]) {
        if (entry.socket !== client.socket) {
          entry.drop(abortError('WebSocket connection was lost before the request was answered'));
        }
      }
    })
  ];

  return {
    client,
    onRequest(method, handler) {
      let stack = registrations.get(method);
      if (!stack) registrations.set(method, (stack = []));
      const registration = { handler };
      stack.push(registration);
      return () => {
        const index = stack.indexOf(registration);
        if (index !== -1) stack.splice(index, 1);
      };
    },
    getSnapshot: () => waiting,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    dispose() {
      offs.forEach(off => off());
      registrations.clear();
      for (const entry of [...entries.values()]) entry.fail(abortError('Responder was disposed'));
    }
  };
}
