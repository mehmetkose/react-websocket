import {
  createWebSocket,
  createWebSocketResponder,
  type IncomingRequest,
  type StandardSchemaV1,
  type WebSocketOptions,
  type WebSocketResponder
} from '../src/core';
import { MockImpl, MockWebSocket } from './mock';

type Params = { text: string };
type In =
  | { type: 'call'; id: number | string; method: string; params?: Params; timeout?: number }
  | { type: 'cancel'; id: number | string }
  | { type: 'chat' };
type Out = { type: 'result'; id: number | string; result?: unknown; error?: string };
type Result = { ok: boolean } | string;

let n = 0;

function setup(options: { timeout?: number } = {}, clientOptions: WebSocketOptions<In, Out> = {}) {
  const client = createWebSocket<In, Out>(`ws://responder/${++n}`, {
    WebSocket: MockImpl,
    json: true,
    reconnect: { jitter: 0, minDelay: 1000 },
    ...clientOptions
  });
  const tools = createWebSocketResponder(client, {
    request: message => (message.type === 'call' ? message : undefined),
    respond: (id, result: Result) => ({ type: 'result', id, result }),
    error: (id, error) => ({ type: 'result', id, error: String(error) }),
    cancel: message => (message.type === 'cancel' ? message.id : undefined),
    ...options
  });
  return { client, tools };
}

function connected(...args: Parameters<typeof setup>) {
  const result = setup(...args);
  result.client.connect();
  MockWebSocket.last.open();
  return result;
}

const sent = (socket = MockWebSocket.last) => socket.sent.map(data => JSON.parse(data as string));
const allSent = () => MockWebSocket.instances.flatMap(socket => sent(socket));
const receive = (message: In, socket = MockWebSocket.last) =>
  socket.receive(JSON.stringify(message));
const call = (
  id: number | string,
  method: string,
  extra: { params?: Params; timeout?: number } = {}
) => receive({ type: 'call', id, method, ...extra });
const never = () => new Promise<never>(() => {});
// Let handler promises settle.
const flush = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => {
  MockWebSocket.reset();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('createWebSocketResponder', () => {
  it('replies with what the handler returns or resolves', async () => {
    const { tools } = connected();
    const signals: AbortSignal[] = [];
    tools.onRequest('echo', (params, request) => {
      signals.push(request.signal);
      return params?.text ?? '';
    });
    tools.onRequest('later', async () => ({ ok: true }));
    call(1, 'echo', { params: { text: 'hi' } });
    call('a', 'later');
    await flush();
    expect(sent()).toEqual([
      { type: 'result', id: 1, result: 'hi' },
      { type: 'result', id: 'a', result: { ok: true } }
    ]);
    expect(signals[0]!.aborted).toBe(false); // finishing normally doesn't abort
  });

  it('replies however full the send buffer is', async () => {
    const { tools } = connected();
    tools.onRequest('echo', params => params?.text ?? '');
    MockWebSocket.last.bufferedAmount = 10_000_000;
    call(1, 'echo', { params: { text: 'hi' } });
    await flush();
    expect(sent()).toEqual([{ type: 'result', id: 1, result: 'hi' }]);
  });

  it('sends the error reply when the handler throws or rejects', async () => {
    const { tools } = connected();
    tools.onRequest('sync', () => {
      throw new Error('nope');
    });
    tools.onRequest('async', () => Promise.reject(new Error('later')));
    call(1, 'sync');
    call(2, 'async');
    await flush();
    expect(sent()).toEqual([
      { type: 'result', id: 1, error: 'Error: nope' },
      { type: 'result', id: 2, error: 'Error: later' }
    ]);
  });

  it('replies NotFoundError for a method with no registration', () => {
    const { tools } = connected();
    const off = tools.onRequest('approve');
    off();
    call(1, 'approve');
    call(2, 'unknown');
    expect(sent()).toEqual([
      { type: 'result', id: 1, error: expect.stringContaining('NotFoundError') },
      { type: 'result', id: 2, error: expect.stringContaining('NotFoundError') }
    ]);
  });

  it('keeps requests without a handler waiting until they are answered', () => {
    const { tools } = connected();
    const listener = vi.fn();
    tools.subscribe(listener);
    const off = tools.onRequest('approve');
    call(1, 'approve', { params: { text: 'refund' } });
    call(2, 'approve');
    expect(sent()).toEqual([]);
    const waiting = tools.getSnapshot();
    expect(waiting).toMatchObject([
      { id: 1, method: 'approve', params: { text: 'refund' } },
      { id: 2, method: 'approve', params: undefined }
    ]);
    expect(tools.getSnapshot()).toBe(waiting);

    off(); // requests already waiting stay
    expect(tools.getSnapshot()).toBe(waiting);
    expect(waiting[0]!.respond({ ok: true })).toBe(true);
    expect(waiting[1]!.reject(new Error('denied'))).toBe(true);
    expect(sent()).toEqual([
      { type: 'result', id: 1, result: { ok: true } },
      { type: 'result', id: 2, error: 'Error: denied' }
    ]);
    expect(tools.getSnapshot()).toEqual([]);
    expect(listener).toHaveBeenCalledTimes(4);
  });

  it('gives new requests to the newest registration, and back to the previous one', async () => {
    const { tools } = connected();
    tools.onRequest('who', () => 'first');
    const off = tools.onRequest('who', () => 'second');
    call(1, 'who');
    await flush();
    off();
    off(); // safe to call twice
    call(2, 'who');
    await flush();
    expect(sent()).toEqual([
      { type: 'result', id: 1, result: 'second' },
      { type: 'result', id: 2, result: 'first' }
    ]);
  });

  it('counts only the first answer', () => {
    const { tools } = connected();
    tools.onRequest('approve');
    call(1, 'approve');
    const [request] = tools.getSnapshot();
    expect(request!.respond({ ok: true })).toBe(true);
    expect(request!.respond({ ok: false })).toBe(false);
    expect(request!.reject('late')).toBe(false);
    expect(sent()).toEqual([{ type: 'result', id: 1, result: { ok: true } }]);
  });

  it("aborts the handler's signal when the request is answered elsewhere", async () => {
    const { tools } = connected();
    let request!: IncomingRequest<Params | undefined, Result>;
    tools.onRequest('slow', (_, r) => {
      request = r;
      return never();
    });
    call(1, 'slow');
    expect(tools.getSnapshot()).toEqual([]); // handled requests aren't listed
    expect(request.respond('done')).toBe(true);
    expect(request.signal.reason).toMatchObject({ name: 'AbortError' });
    await flush();
    expect(sent()).toEqual([{ type: 'result', id: 1, result: 'done' }]);
  });

  it('times out with a TimeoutError reply', () => {
    const { tools } = connected({ timeout: 1000 });
    let signal!: AbortSignal;
    tools.onRequest('approve');
    tools.onRequest('slow', (_, request) => {
      signal = request.signal;
      return never();
    });
    call(1, 'approve');
    call(2, 'slow', { timeout: 100 }); // the server's timeout wins

    vi.advanceTimersByTime(100);
    expect(sent()).toEqual([
      { type: 'result', id: 2, error: expect.stringContaining('TimeoutError') }
    ]);
    expect(signal.reason).toMatchObject({ name: 'TimeoutError' });
    expect(tools.getSnapshot()).toHaveLength(1);

    vi.advanceTimersByTime(900);
    expect(sent()[1]).toEqual({
      type: 'result',
      id: 1,
      error: expect.stringContaining('TimeoutError')
    });
    expect(tools.getSnapshot()).toEqual([]);
  });

  it('waits forever by default', () => {
    const { tools } = connected();
    tools.onRequest('approve');
    call(1, 'approve');
    vi.advanceTimersByTime(3_600_000);
    expect(tools.getSnapshot()).toHaveLength(1);
    expect(sent()).toEqual([]);
  });

  it('drops a request the server cancels, without replying', () => {
    const { tools } = connected();
    let signal!: AbortSignal;
    tools.onRequest('approve');
    tools.onRequest('slow', (_, request) => {
      signal = request.signal;
      return never();
    });
    call(1, 'approve');
    call(2, 'slow');
    const [waiting] = tools.getSnapshot();
    receive({ type: 'cancel', id: '1' }); // a string id matches too
    receive({ type: 'cancel', id: 2 });
    receive({ type: 'cancel', id: 3 }); // unknown ids are ignored
    expect(tools.getSnapshot()).toEqual([]);
    expect(waiting!.signal.reason).toMatchObject({ name: 'AbortError' });
    expect(signal.reason).toMatchObject({ name: 'AbortError' });
    expect(waiting!.respond({ ok: true })).toBe(false);
    expect(sent()).toEqual([]);
  });

  it.each([
    ['the connection drops', () => MockWebSocket.last.finishClose(1006)],
    ['reconnect() is called', (client: ReturnType<typeof setup>['client']) => client.reconnect()],
    ['close() is called', (client: ReturnType<typeof setup>['client']) => client.close()]
  ])('drops requests without replying when %s', async (_, end) => {
    const { client, tools } = connected();
    let resolve!: (result: Result) => void;
    tools.onRequest('approve');
    tools.onRequest('slow', () => new Promise<Result>(r => (resolve = r)));
    call(1, 'approve');
    call(2, 'slow');
    const [waiting] = tools.getSnapshot();

    end(client);
    expect(tools.getSnapshot()).toEqual([]);
    expect(waiting!.signal.reason).toMatchObject({ name: 'AbortError' });

    vi.advanceTimersByTime(1000); // reconnect, if it will
    if (MockWebSocket.instances.length > 1) MockWebSocket.last.open();
    expect(waiting!.respond({ ok: true })).toBe(false);
    resolve('late'); // never sent to the next connection
    await flush();
    expect(allSent()).toEqual([]);
  });

  it('drops requests when the heartbeat times out', () => {
    const { tools } = connected({}, { heartbeat: { interval: 1000, timeout: 500 } });
    tools.onRequest('approve');
    call(1, 'approve');
    vi.advanceTimersByTime(1500);
    expect(tools.getSnapshot()).toEqual([]);
    expect(MockWebSocket.last.sent).toEqual(['ping']); // no reply
  });

  it('drops a request whose handler closes the connection', async () => {
    const { client, tools } = connected();
    let signal!: AbortSignal;
    tools.onRequest('quit', (_, request) => {
      signal = request.signal;
      client.close();
      return 'bye';
    });
    call(1, 'quit');
    await flush();
    expect(signal.reason).toMatchObject({ name: 'AbortError' });
    expect(sent()).toEqual([]);
  });

  it('ignores a request whose id is already in flight', () => {
    const { tools } = connected();
    const handler = vi.fn(never);
    tools.onRequest('slow', handler);
    tools.onRequest('approve');
    call(1, 'slow');
    call('1', 'slow');
    expect(handler).toHaveBeenCalledOnce();

    call(5, 'approve');
    call(5, 'approve');
    expect(tools.getSnapshot()).toHaveLength(1);
    tools.getSnapshot()[0]!.respond({ ok: true });
    call(5, 'approve'); // free again once answered
    expect(tools.getSnapshot()).toHaveLength(1);
  });

  it("sends the error reply when the result can't be encoded", async () => {
    const { tools } = connected();
    tools.onRequest('cyclic', () => {
      const value: Record<string, unknown> = {};
      value.self = value;
      return value as never;
    });
    call(1, 'cyclic');
    await flush();
    expect(sent()).toEqual([
      { type: 'result', id: 1, error: expect.stringContaining('TypeError') }
    ]);
  });

  it('answers requests on a client that was already open', async () => {
    const client = createWebSocket<In, Out>('ws://responder/open', {
      WebSocket: MockImpl,
      json: true
    });
    client.connect();
    MockWebSocket.last.open();
    const tools = createWebSocketResponder(client, {
      request: message => (message.type === 'call' ? message : undefined),
      respond: (id, result: string) => ({ type: 'result', id, result }),
      error: (id, error) => ({ type: 'result', id, error: String(error) })
    });
    tools.onRequest('ping', () => 'pong');
    call(1, 'ping');
    await flush();
    expect(sent()).toEqual([{ type: 'result', id: 1, result: 'pong' }]);
  });

  it("doesn't hold the connection", () => {
    const { client, tools } = setup();
    tools.onRequest('approve');
    expect(MockWebSocket.instances).toHaveLength(0);

    const release = client.acquire();
    MockWebSocket.last.open();
    call(1, 'approve');
    release();
    vi.advanceTimersByTime(0);
    expect(client.getSnapshot().status).toBe('idle');
    expect(tools.getSnapshot()).toEqual([]); // dropped with its connection
  });

  it('keeps requests and cancellations in order with an async schema', async () => {
    const delays = [30, 0];
    const schema: StandardSchemaV1<unknown, In> = {
      '~standard': {
        version: 1,
        vendor: 'test',
        validate: value =>
          new Promise(resolve => setTimeout(() => resolve({ value: value as In }), delays.shift()))
      }
    };
    const { tools } = connected({}, { schema });
    tools.onRequest('approve');
    call(1, 'approve');
    receive({ type: 'cancel', id: 1 }); // validated first, delivered second
    await vi.runAllTimersAsync();
    expect(tools.getSnapshot()).toEqual([]);
    expect(sent()).toEqual([]);
  });

  it('dispose() sends AbortError replies and stops answering', () => {
    const { tools } = connected();
    let signal!: AbortSignal;
    tools.onRequest('approve');
    tools.onRequest('slow', (_, request) => {
      signal = request.signal;
      return never();
    });
    call(1, 'approve');
    call(2, 'slow');
    tools.dispose();
    expect(sent()).toEqual([
      { type: 'result', id: 1, error: expect.stringContaining('AbortError') },
      { type: 'result', id: 2, error: expect.stringContaining('AbortError') }
    ]);
    expect(signal.reason).toMatchObject({ name: 'AbortError' });
    expect(tools.getSnapshot()).toEqual([]);
    call(3, 'approve');
    expect(sent()).toHaveLength(2);
  });

  it('still delivers requests as ordinary messages', () => {
    const { client, tools } = connected();
    const onMessage = vi.fn();
    client.on('message', onMessage);
    tools.onRequest('approve');
    call(1, 'approve');
    expect(onMessage).toHaveBeenCalledWith(
      { type: 'call', id: 1, method: 'approve' },
      expect.anything()
    );
  });
});

describe('types', () => {
  it('takes In and Out from the client, params from request and R from the respond annotation', () => {
    const { tools } = setup();
    // `params` are optional in `In`, so handlers may get `undefined`.
    expectTypeOf(tools).toEqualTypeOf<WebSocketResponder<Params | undefined, Result>>();
    expectTypeOf(tools.getSnapshot()).toEqualTypeOf<
      readonly IncomingRequest<Params | undefined, Result>[]
    >();
    tools.dispose();
  });

  it('types params as the request returns them', () => {
    const client = createWebSocket<In, Out>('ws://responder/types');
    const replies = {
      respond: (id: number | string, result: number) => ({ type: 'result' as const, id, result }),
      error: (id: number | string, error: unknown) => ({
        type: 'result' as const,
        id,
        error: String(error)
      })
    };
    const required = createWebSocketResponder(client, {
      ...replies,
      request: m => (m.type === 'call' ? { ...m, params: m.params ?? { text: '' } } : undefined)
    });
    const mapped = createWebSocketResponder(client, {
      ...replies,
      request: m =>
        m.type === 'call' ? { id: m.id, method: m.method, params: m.params?.text } : undefined
    });
    const none = createWebSocketResponder(client, {
      ...replies,
      request: m => (m.type === 'call' ? { id: m.id, method: m.method } : undefined)
    });
    expectTypeOf(required).toEqualTypeOf<WebSocketResponder<Params, number>>();
    expectTypeOf(mapped).toEqualTypeOf<WebSocketResponder<string | undefined, number>>();
    expectTypeOf(none).toEqualTypeOf<WebSocketResponder<undefined, number>>();

    createWebSocketResponder(client, {
      // @ts-expect-error a request needs an id
      request: m => (m.type === 'call' ? { method: m.method } : undefined),
      respond: (id, result) => ({ type: 'result', id, result }),
      error: (id, error) => ({ type: 'result', id, error: String(error) })
    });
    createWebSocketResponder(client, {
      request: m => (m.type === 'call' ? m : undefined),
      // @ts-expect-error replies must be an `Out`
      respond: (id, result) => ({ type: 'other', id, result }),
      error: (id, error) => ({ type: 'result', id, error: String(error) })
    });
  });
});
