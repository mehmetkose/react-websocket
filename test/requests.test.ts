import { createWebSocket, createWebSocketRequests, type SendOptions } from '../src/core';
import { MockImpl, MockWebSocket } from './mock';

type In = { type: 'reply'; id: number | string; ok?: string; error?: string } | { type: 'chat' };
type Out = { type: 'join'; room: string; id: number } | { type: 'chat' };
type Request = { type: 'join'; room: string };

let n = 0;

function setup(options: { timeout?: number } = {}) {
  const client = createWebSocket<In, Out>(`ws://requests/${++n}`, {
    WebSocket: MockImpl,
    json: true,
    reconnect: { jitter: 0, minDelay: 1000 }
  });
  const rpc = createWebSocketRequests(client, {
    send: (message: Request, id) => ({ ...message, id }),
    reply: message => (message.type === 'reply' ? message.id : undefined),
    error: message =>
      message.type === 'reply' && message.error ? new Error(message.error) : undefined,
    ...options
  });
  return { client, rpc };
}

const sent = (socket = MockWebSocket.last) => socket.sent.map(data => JSON.parse(data as string));
const reply = (message: In, socket = MockWebSocket.last) => socket.receive(JSON.stringify(message));

beforeEach(() => {
  MockWebSocket.reset();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('createWebSocketRequests', () => {
  it('sends a tagged request and resolves with the matching reply', async () => {
    const { client, rpc } = setup();
    client.connect();
    MockWebSocket.last.open();

    const first = rpc.request({ type: 'join', room: 'a' });
    const second = rpc.request({ type: 'join', room: 'b' });
    expect(sent()).toEqual([
      { type: 'join', room: 'a', id: 1 },
      { type: 'join', room: 'b', id: 2 }
    ]);
    expect(rpc.pending()).toBe(2);

    reply({ type: 'chat' });
    reply({ type: 'reply', id: 2, ok: 'b' });
    reply({ type: 'reply', id: '1', ok: 'a' }); // a string id matches too
    await expect(second).resolves.toEqual({ type: 'reply', id: 2, ok: 'b' });
    await expect(first).resolves.toEqual({ type: 'reply', id: '1', ok: 'a' });
    expect(rpc.pending()).toBe(0);
  });

  it('still delivers replies as ordinary messages', async () => {
    const { client, rpc } = setup();
    const onMessage = vi.fn();
    client.on('message', onMessage);
    client.connect();
    MockWebSocket.last.open();
    const request = rpc.request({ type: 'join', room: 'a' });
    reply({ type: 'reply', id: 1 });
    await request;
    expect(onMessage).toHaveBeenCalledWith({ type: 'reply', id: 1 }, expect.anything());
  });

  it('rejects with what error() returns', async () => {
    const { client, rpc } = setup();
    client.connect();
    MockWebSocket.last.open();
    const request = rpc.request({ type: 'join', room: 'full' });
    reply({ type: 'reply', id: 1, error: 'room is full' });
    await expect(request).rejects.toThrow('room is full');
  });

  it('times out with a TimeoutError and ignores a late reply', async () => {
    const { client, rpc } = setup({ timeout: 1000 });
    client.connect();
    MockWebSocket.last.open();
    const fast = rpc.request({ type: 'join', room: 'a' }, { timeout: 100 });
    const slow = rpc.request({ type: 'join', room: 'b' });

    vi.advanceTimersByTime(100);
    await expect(fast).rejects.toMatchObject({ name: 'TimeoutError' });
    expect(rpc.pending()).toBe(1);
    vi.advanceTimersByTime(900);
    await expect(slow).rejects.toMatchObject({ name: 'TimeoutError' });

    reply({ type: 'reply', id: 1 }); // nothing waits for it anymore
    expect(rpc.pending()).toBe(0);
  });

  it('never times out with timeout: Infinity', () => {
    const { client, rpc } = setup({ timeout: Infinity });
    client.connect();
    MockWebSocket.last.open();
    void rpc.request({ type: 'join', room: 'a' });
    vi.advanceTimersByTime(60_000);
    expect(rpc.pending()).toBe(1);
  });

  it('rejects with the abort reason', async () => {
    const { client, rpc } = setup();
    client.connect();
    MockWebSocket.last.open();
    const controller = new AbortController();
    const request = rpc.request({ type: 'join', room: 'a' }, { signal: controller.signal });
    controller.abort(new Error('left the screen'));
    await expect(request).rejects.toThrow('left the screen');
    expect(rpc.pending()).toBe(0);

    await expect(
      rpc.request({ type: 'join', room: 'b' }, { signal: AbortSignal.abort('already') })
    ).rejects.toBe('already');
    expect(sent()).toHaveLength(1); // the pre-aborted request was never sent
  });

  it('queues a request made while connecting and matches its reply after open', async () => {
    const { client, rpc } = setup();
    client.connect();
    const request = rpc.request({ type: 'join', room: 'a' });
    MockWebSocket.last.open();
    expect(sent()).toEqual([{ type: 'join', room: 'a', id: 1 }]);
    reply({ type: 'reply', id: 1 });
    await expect(request).resolves.toMatchObject({ id: 1 });
  });

  it('holds the connection while a request is pending', async () => {
    const { client, rpc } = setup();
    const request = rpc.request({ type: 'join', room: 'a' });
    expect(client.getSnapshot().status).toBe('connecting');
    MockWebSocket.last.open();
    reply({ type: 'reply', id: 1 });
    await request;
    vi.advanceTimersByTime(0);
    expect(client.getSnapshot().status).toBe('idle');
  });

  it('rejects sent requests when their connection drops, but keeps queued ones', async () => {
    const { client, rpc } = setup();
    client.connect();
    MockWebSocket.last.open();
    const lost = rpc.request({ type: 'join', room: 'a' });
    MockWebSocket.last.finishClose(1006);
    await expect(lost).rejects.toThrow('connection was lost');

    const queued = rpc.request({ type: 'join', room: 'b' });
    vi.advanceTimersByTime(1000);
    MockWebSocket.last.open();
    expect(sent()).toEqual([{ type: 'join', room: 'b', id: 2 }]);
    reply({ type: 'reply', id: 2 });
    await expect(queued).resolves.toMatchObject({ id: 2 });
  });

  it('rejects sent requests on reconnect()', async () => {
    const { client, rpc } = setup();
    client.connect();
    MockWebSocket.last.open();
    const request = rpc.request({ type: 'join', room: 'a' });
    client.reconnect();
    await expect(request).rejects.toThrow('connection was lost');
  });

  it('rejects everything on close(), and requests on a closed client', async () => {
    const { client, rpc } = setup();
    client.connect();
    const queued = rpc.request({ type: 'join', room: 'a' });
    client.close();
    await expect(queued).rejects.toThrow('closed before the request was answered');
    await expect(rpc.request({ type: 'join', room: 'b' })).rejects.toThrow('WebSocket is closed');
  });

  it('rejects a volatile request right away when not open', async () => {
    const { client, rpc } = setup();
    client.connect();
    await expect(rpc.request({ type: 'join', room: 'a' }, { volatile: true })).rejects.toThrow(
      'request dropped'
    );
    MockWebSocket.last.open();
    expect(sent()).toEqual([]);
  });

  it('rejects when there is no WebSocket implementation', async () => {
    const client = createWebSocket<In, Out>('ws://x', {
      WebSocket: undefined,
      json: true
    });
    const original = globalThis.WebSocket;
    vi.stubGlobal('WebSocket', undefined);
    try {
      const rpc = createWebSocketRequests(client, {
        send: (message: Request, id) => ({ ...message, id }),
        reply: () => undefined
      });
      await expect(rpc.request({ type: 'join', room: 'a' })).rejects.toThrow('WebSocket is idle');
    } finally {
      vi.stubGlobal('WebSocket', original);
    }
  });

  it('dispose() rejects pending requests and stops matching', async () => {
    const { client, rpc } = setup();
    client.connect();
    MockWebSocket.last.open();
    const request = rpc.request({ type: 'join', room: 'a' });
    rpc.dispose();
    await expect(request).rejects.toThrow('disposed');
  });
});

describe('types', () => {
  it('takes In and Out from the client and Req from the send annotation', () => {
    const { rpc, client } = setup();
    expectTypeOf(rpc.request).parameter(0).toEqualTypeOf<Request>();
    expectTypeOf(rpc.request).returns.toEqualTypeOf<Promise<In>>();
    expectTypeOf(client.send).parameter(1).toEqualTypeOf<SendOptions | undefined>();
    rpc.dispose();
  });
});
