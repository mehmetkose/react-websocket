import { createWebSocket, MessageError, retryableClose, type StandardSchemaV1 } from '../src/core';
import { MockImpl, MockWebSocket } from './mock';

const noJitter = { jitter: 0, minDelay: 1000, maxDelay: 30_000 };

beforeEach(() => {
  MockWebSocket.reset();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('lifecycle', () => {
  it('is lazy until connect()', () => {
    const ws = createWebSocket('ws://x', { WebSocket: MockImpl });
    expect(MockWebSocket.instances).toHaveLength(0);
    expect(ws.getSnapshot().status).toBe('idle');

    ws.connect();
    expect(MockWebSocket.instances).toHaveLength(1);
    expect(ws.getSnapshot().status).toBe('connecting');

    MockWebSocket.last.open();
    expect(ws.getSnapshot().status).toBe('open');
  });

  it('passes protocols and binaryType through', () => {
    const ws = createWebSocket('ws://x', {
      WebSocket: MockImpl,
      protocols: ['v1'],
      binaryType: 'arraybuffer'
    });
    ws.connect();
    expect(MockWebSocket.last.protocols).toEqual(['v1']);
    expect(MockWebSocket.last.binaryType).toBe('arraybuffer');
  });

  it('notifies store subscribers with a new snapshot each change', () => {
    const ws = createWebSocket('ws://x', { WebSocket: MockImpl });
    const listener = vi.fn();
    ws.subscribe(listener);
    const before = ws.getSnapshot();
    ws.connect();
    expect(listener).toHaveBeenCalled();
    expect(ws.getSnapshot()).not.toBe(before);
  });

  it('fails permanently on a constructor error', () => {
    const ws = createWebSocket('invalid', { WebSocket: MockImpl });
    const onError = vi.fn();
    ws.on('error', onError);
    ws.connect();
    expect(ws.getSnapshot().status).toBe('closed');
    expect(onError).toHaveBeenCalledWith(expect.any(SyntaxError));
  });
});

describe('sending', () => {
  it('queues while connecting and flushes in order on open', () => {
    const ws = createWebSocket('ws://x', { WebSocket: MockImpl });
    expect(ws.send('a')).toBe(false);
    ws.connect();
    expect(ws.send('b')).toBe(false);
    MockWebSocket.last.open();
    expect(MockWebSocket.last.sent).toEqual(['a', 'b']);
    expect(ws.send('c')).toBe(true);
    expect(MockWebSocket.last.sent).toEqual(['a', 'b', 'c']);
  });

  it('sends messages from open listeners before the queue (auth handshakes)', () => {
    const ws = createWebSocket('ws://x', { WebSocket: MockImpl });
    ws.on('open', () => ws.send('auth'));
    ws.send('queued');
    ws.connect();
    MockWebSocket.last.open();
    expect(MockWebSocket.last.sent).toEqual(['auth', 'queued']);
  });

  it('does not flush the queue if an open listener closes the client', () => {
    const ws = createWebSocket('ws://x', { WebSocket: MockImpl });
    ws.on('open', () => ws.close());
    ws.send('queued');
    ws.connect();
    expect(() => MockWebSocket.last.open()).not.toThrow();
    expect(MockWebSocket.last.sent).toEqual([]);
  });

  it('drops instead of queueing when queue is false', () => {
    const ws = createWebSocket('ws://x', { WebSocket: MockImpl, queue: false });
    ws.connect();
    ws.send('a');
    MockWebSocket.last.open();
    expect(MockWebSocket.last.sent).toEqual([]);
  });

  it('drops the oldest queued message beyond queue.limit', () => {
    const logger = vi.fn();
    const ws = createWebSocket('ws://x', { WebSocket: MockImpl, queue: { limit: 2 }, logger });
    ws.connect();
    ws.send('a');
    ws.send('b');
    ws.send('c');
    expect(logger).toHaveBeenCalledWith(expect.stringContaining('queue limit (2)'));
    MockWebSocket.last.open();
    expect(MockWebSocket.last.sent).toEqual(['b', 'c']);
  });

  it('holds at most 100 messages by default', () => {
    const ws = createWebSocket('ws://x', { WebSocket: MockImpl });
    ws.connect();
    for (let i = 0; i < 150; i++) ws.send(i);
    MockWebSocket.last.open();
    expect(MockWebSocket.last.sent).toHaveLength(100);
    expect(MockWebSocket.last.sent[0]).toBe(50);

    const unbounded = createWebSocket('ws://y', {
      WebSocket: MockImpl,
      queue: { limit: Infinity }
    });
    unbounded.connect();
    for (let i = 0; i < 150; i++) unbounded.send(i);
    MockWebSocket.last.open();
    expect(MockWebSocket.last.sent).toHaveLength(150);
  });

  it('drops volatile messages while not open, and sends them when open', () => {
    const ws = createWebSocket('ws://x', { WebSocket: MockImpl });
    ws.connect();
    expect(ws.send('input', { volatile: true })).toBe(false);
    ws.send('chat');
    MockWebSocket.last.open();
    expect(MockWebSocket.last.sent).toEqual(['chat']);
    expect(ws.send('input', { volatile: true })).toBe(true);
    expect(MockWebSocket.last.sent).toEqual(['chat', 'input']);
  });

  it('keeps only the newest queued message per key, moved to the back', () => {
    const ws = createWebSocket('ws://x', { WebSocket: MockImpl });
    ws.connect();
    ws.send('pos 1', { key: 'pos' });
    ws.send('chat');
    ws.send('aim 1', { key: 'aim' });
    ws.send('pos 2', { key: 'pos' });
    MockWebSocket.last.open();
    expect(MockWebSocket.last.sent).toEqual(['chat', 'aim 1', 'pos 2']);
  });

  it('applies queue.limit after replacing a keyed message', () => {
    const ws = createWebSocket('ws://x', { WebSocket: MockImpl, queue: { limit: 2 } });
    ws.connect();
    ws.send('a');
    ws.send('pos 1', { key: 'pos' });
    ws.send('pos 2', { key: 'pos' });
    MockWebSocket.last.open();
    expect(MockWebSocket.last.sent).toEqual(['a', 'pos 2']);
  });

  it('calls onDrop for a message replaced by key or evicted by queue.limit', () => {
    const ws = createWebSocket('ws://x', { WebSocket: MockImpl, queue: { limit: 2 } });
    ws.connect();
    const dropped: string[] = [];
    const send = (data: string, key?: string) =>
      ws.send(data, { key, onDrop: () => dropped.push(data) });
    send('pos 1', 'pos');
    send('pos 2', 'pos');
    expect(dropped).toEqual(['pos 1']);
    send('a');
    send('b');
    expect(dropped).toEqual(['pos 1', 'pos 2']);
    MockWebSocket.last.open();
    expect(MockWebSocket.last.sent).toEqual(['a', 'b']);
    expect(dropped).toEqual(['pos 1', 'pos 2']);
  });

  it('drops a send with maxBuffered while the send buffer is above it', () => {
    const logger = vi.fn();
    const ws = createWebSocket('ws://x', { WebSocket: MockImpl, logger });
    ws.connect();
    MockWebSocket.last.open();
    const onDrop = vi.fn();
    MockWebSocket.last.bufferedAmount = 1000;
    expect(ws.send('frame 1', { maxBuffered: 999, onDrop })).toBe(false);
    expect(logger).toHaveBeenCalledWith(expect.stringContaining('maxBuffered'));
    expect(ws.send('frame 2', { maxBuffered: 1000 })).toBe(true);
    expect(ws.send('chat')).toBe(true);
    expect(MockWebSocket.last.sent).toEqual(['frame 2', 'chat']);
    // The message was never queued, so `send()` returning false is the only report.
    expect(onDrop).not.toHaveBeenCalled();
  });

  it('ignores maxBuffered while not open', () => {
    const ws = createWebSocket('ws://x', { WebSocket: MockImpl });
    ws.connect();
    MockWebSocket.last.bufferedAmount = 1000;
    expect(ws.send('queued', { maxBuffered: 0 })).toBe(false);
    MockWebSocket.last.open();
    expect(MockWebSocket.last.sent).toEqual(['queued']);
  });

  it('queues priority messages ahead of the others, after open listeners', () => {
    const ws = createWebSocket('ws://x', { WebSocket: MockImpl });
    ws.on('open', () => ws.send('auth'));
    ws.connect();
    ws.send('a');
    ws.send('p1', { priority: true });
    ws.send('b');
    ws.send('p2', { priority: true });
    ws.send('c');
    MockWebSocket.last.open();
    expect(MockWebSocket.last.sent).toEqual(['auth', 'p1', 'p2', 'a', 'b', 'c']);
  });

  it('replaces a keyed message within its block', () => {
    const ws = createWebSocket('ws://x', { WebSocket: MockImpl });
    ws.connect();
    ws.send('p1', { priority: true });
    ws.send('token 1', { key: 'token', priority: true });
    ws.send('p2', { priority: true });
    ws.send('a');
    ws.send('token 2', { key: 'token', priority: true });
    // An ordinary message replacing a priority one joins the ordinary block.
    ws.send('cancel 1', { key: 'cancel', priority: true });
    ws.send('cancel 2', { key: 'cancel' });
    MockWebSocket.last.open();
    expect(MockWebSocket.last.sent).toEqual(['p1', 'p2', 'token 2', 'a', 'cancel 2']);
  });

  it('evicts ordinary messages before priority ones beyond queue.limit', () => {
    const ws = createWebSocket('ws://x', { WebSocket: MockImpl, queue: { limit: 2 } });
    ws.connect();
    const dropped: string[] = [];
    const send = (data: string, priority?: boolean) =>
      ws.send(data, { priority, onDrop: () => dropped.push(data) });
    send('a');
    send('p1', true);
    send('p2', true);
    expect(dropped).toEqual(['a']);
    // Nothing ordinary is left to evict but the message just sent.
    send('b');
    expect(dropped).toEqual(['a', 'b']);
    // Only priority messages are queued: the oldest of them goes.
    send('p3', true);
    expect(dropped).toEqual(['a', 'b', 'p1']);
    MockWebSocket.last.open();
    expect(MockWebSocket.last.sent).toEqual(['p2', 'p3']);
  });

  it('ignores priority for volatile messages and while open', () => {
    const ws = createWebSocket('ws://x', { WebSocket: MockImpl });
    ws.connect();
    ws.send('a');
    expect(ws.send('input', { priority: true, volatile: true })).toBe(false);
    MockWebSocket.last.open();
    ws.send('b');
    expect(ws.send('p', { priority: true })).toBe(true);
    expect(MockWebSocket.last.sent).toEqual(['a', 'b', 'p']);
  });

  it('serializes with json or a custom serializer', () => {
    const json = createWebSocket<unknown, { n: number }>('ws://x', {
      WebSocket: MockImpl,
      json: true
    });
    json.connect();
    MockWebSocket.last.open();
    json.send({ n: 1 });
    expect(MockWebSocket.last.sent).toEqual(['{"n":1}']);

    const custom = createWebSocket<unknown, number>('ws://y', {
      WebSocket: MockImpl,
      json: true,
      serialize: n => `n=${n}`
    });
    custom.connect();
    MockWebSocket.last.open();
    custom.send(2);
    expect(MockWebSocket.last.sent).toEqual(['n=2']);
  });
});

describe('receiving', () => {
  it('delivers raw data by default and keeps lastMessage', () => {
    const ws = createWebSocket('ws://x', { WebSocket: MockImpl });
    const onMessage = vi.fn();
    ws.on('message', onMessage);
    ws.connect();
    MockWebSocket.last.open();
    MockWebSocket.last.receive('hi');
    expect(onMessage).toHaveBeenCalledWith('hi', expect.any(MessageEvent));
    expect(ws.getSnapshot().lastMessage).toBe('hi');
  });

  it('parses json and reports parse failures as MessageError', () => {
    const ws = createWebSocket<{ a: number }>('ws://x', { WebSocket: MockImpl, json: true });
    const onError = vi.fn();
    ws.on('error', onError);
    ws.connect();
    MockWebSocket.last.open();
    MockWebSocket.last.receive('{"a":1}');
    expect(ws.getSnapshot().lastMessage).toEqual({ a: 1 });

    MockWebSocket.last.receive('not json');
    expect(onError).toHaveBeenCalledWith(expect.any(MessageError));
    expect(onError.mock.calls[0]![0].data).toBe('not json');
    expect(ws.getSnapshot().lastMessage).toEqual({ a: 1 });
  });

  it('validates with a sync Standard Schema and infers the message type', () => {
    const schema: StandardSchemaV1<unknown, { n: number }> = {
      '~standard': {
        version: 1,
        vendor: 'test',
        validate: v =>
          typeof (v as any)?.n === 'number'
            ? { value: v as { n: number } }
            : { issues: [{ message: 'n must be a number' }] }
      }
    };
    const ws = createWebSocket('ws://x', { WebSocket: MockImpl, json: true, schema });
    const onError = vi.fn();
    ws.on('error', onError);
    ws.connect();
    MockWebSocket.last.open();

    MockWebSocket.last.receive('{"n":1}');
    const n: number | undefined = ws.getSnapshot().lastMessage?.n;
    expect(n).toBe(1);

    MockWebSocket.last.receive('{"n":"x"}');
    expect(onError.mock.calls[0]![0]).toBeInstanceOf(MessageError);
    expect(onError.mock.calls[0]![0].issues).toEqual([{ message: 'n must be a number' }]);
  });

  it('keeps message order with an async schema', async () => {
    const delays = [30, 0, 10];
    const schema: StandardSchemaV1<unknown, string> = {
      '~standard': {
        version: 1,
        vendor: 'test',
        validate: v =>
          new Promise(resolve => setTimeout(() => resolve({ value: v as string }), delays.shift()))
      }
    };
    const ws = createWebSocket('ws://x', { WebSocket: MockImpl, schema });
    const received: string[] = [];
    ws.on('message', m => received.push(m));
    ws.connect();
    MockWebSocket.last.open();
    MockWebSocket.last.receive('1');
    MockWebSocket.last.receive('2');
    MockWebSocket.last.receive('3');
    await vi.runAllTimersAsync();
    expect(received).toEqual(['1', '2', '3']);
  });

  it('keeps delivering after a listener throws with an async schema', async () => {
    const thrown: unknown[] = [];
    vi.spyOn(globalThis, 'queueMicrotask').mockImplementation(callback => {
      try {
        callback();
      } catch (error) {
        thrown.push(error);
      }
    });
    const schema: StandardSchemaV1<unknown, string> = {
      '~standard': {
        version: 1,
        vendor: 'test',
        validate: v => Promise.resolve({ value: v as string })
      }
    };
    const ws = createWebSocket('ws://x', { WebSocket: MockImpl, schema });
    const received: string[] = [];
    ws.on('message', m => received.push(m));
    ws.subscribe(() => {
      if (ws.getSnapshot().lastMessage === '1') throw new Error('listener failed');
    });
    ws.connect();
    MockWebSocket.last.open();
    MockWebSocket.last.receive('1');
    MockWebSocket.last.receive('2');
    MockWebSocket.last.receive('3');
    await vi.runAllTimersAsync();
    vi.restoreAllMocks();
    expect(received).toEqual(['1', '2', '3']);
    expect(thrown).toEqual([new Error('listener failed')]);
  });
});

describe('reconnecting', () => {
  it('backs off exponentially and resets after a successful open', () => {
    const ws = createWebSocket('ws://x', { WebSocket: MockImpl, reconnect: noJitter });
    ws.connect();
    MockWebSocket.last.open();
    MockWebSocket.last.finishClose(1006);
    expect(ws.getSnapshot()).toMatchObject({ status: 'reconnecting', attempt: 1 });

    vi.advanceTimersByTime(999);
    expect(MockWebSocket.instances).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(MockWebSocket.instances).toHaveLength(2);
    expect(ws.getSnapshot().status).toBe('reconnecting');

    MockWebSocket.last.finishClose(1006);
    expect(ws.getSnapshot().attempt).toBe(2);
    vi.advanceTimersByTime(1999);
    expect(MockWebSocket.instances).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(MockWebSocket.instances).toHaveLength(3);

    MockWebSocket.last.open();
    expect(ws.getSnapshot()).toMatchObject({ status: 'open', attempt: 0 });
  });

  it('caps the delay at maxDelay and applies jitter', () => {
    vi.spyOn(Math, 'random').mockReturnValue(1);
    const ws = createWebSocket('ws://x', {
      WebSocket: MockImpl,
      reconnect: { minDelay: 1000, maxDelay: 1500, jitter: 0.5 }
    });
    ws.connect();
    MockWebSocket.last.finishClose();
    vi.advanceTimersByTime(500); // 1000 * (1 - 0.5)
    expect(MockWebSocket.instances).toHaveLength(2);
    MockWebSocket.last.finishClose();
    vi.advanceTimersByTime(749); // min(1500, 2000) * 0.5 = 750
    expect(MockWebSocket.instances).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(MockWebSocket.instances).toHaveLength(3);
    vi.restoreAllMocks();
  });

  it('gives up after maxAttempts and rejects ready', async () => {
    const ws = createWebSocket('ws://x', {
      WebSocket: MockImpl,
      reconnect: { ...noJitter, maxAttempts: 1 }
    });
    const ready = ws.ready;
    await Promise.resolve();
    MockWebSocket.last.finishClose(1006);
    vi.advanceTimersByTime(1000);
    MockWebSocket.last.finishClose(1006);
    expect(ws.getSnapshot()).toMatchObject({ status: 'closed', attempt: 1 });
    await expect(ready).rejects.toThrow('code 1006');
  });

  it('respects shouldReconnect and reconnect: false', () => {
    const a = createWebSocket('ws://a', {
      WebSocket: MockImpl,
      reconnect: { shouldReconnect: close => close.code !== 4001 }
    });
    a.connect();
    MockWebSocket.last.finishClose(4001, 'unauthorized');
    expect(a.getSnapshot().status).toBe('closed');

    const b = createWebSocket('ws://b', { WebSocket: MockImpl, reconnect: false });
    b.connect();
    MockWebSocket.last.finishClose(1006);
    expect(b.getSnapshot().status).toBe('closed');
  });

  it('keeps backing off while connections close within minUptime', () => {
    const ws = createWebSocket('ws://x', { WebSocket: MockImpl, reconnect: noJitter });
    ws.connect();
    // The server accepts, then closes at once (e.g. rejecting the auth sent on open).
    const flap = () => {
      MockWebSocket.last.open();
      expect(ws.getSnapshot()).toMatchObject({ status: 'open', attempt: 0 });
      MockWebSocket.last.finishClose(4001);
    };
    for (const [attempt, delay] of [
      [1, 1000],
      [2, 2000],
      [3, 4000]
    ] as const) {
      flap();
      expect(ws.getSnapshot()).toMatchObject({ status: 'reconnecting', attempt });
      const sockets = MockWebSocket.instances.length;
      vi.advanceTimersByTime(delay - 1);
      expect(MockWebSocket.instances).toHaveLength(sockets);
      vi.advanceTimersByTime(1);
      expect(MockWebSocket.instances).toHaveLength(sockets + 1);
    }

    MockWebSocket.last.open();
    vi.advanceTimersByTime(4999);
    MockWebSocket.last.finishClose();
    expect(ws.getSnapshot().attempt).toBe(4); // one ms short of stable
    vi.advanceTimersByTime(8000);
    MockWebSocket.last.open();
    vi.advanceTimersByTime(5000);
    MockWebSocket.last.finishClose();
    expect(ws.getSnapshot().attempt).toBe(1);
    ws.close();
  });

  it('gives up on a server that keeps closing right after open', async () => {
    const ws = createWebSocket('ws://x', {
      WebSocket: MockImpl,
      reconnect: { ...noJitter, maxAttempts: 3 }
    });
    ws.connect();
    const ready = ws.ready;
    for (let i = 0; i < 4; i++) {
      MockWebSocket.last.open();
      MockWebSocket.last.finishClose(4001);
      vi.runOnlyPendingTimers();
    }
    expect(MockWebSocket.instances).toHaveLength(4);
    expect(ws.getSnapshot()).toMatchObject({ status: 'closed', attempt: 3 });
    // It had opened, so `ready` stayed resolved; a later read sees the failure.
    await expect(ready).resolves.toBeUndefined();
    await expect(ws.ready).rejects.toThrow('code 4001');
  });

  it('minUptime: 0 resets the backoff on every open', () => {
    const ws = createWebSocket('ws://x', {
      WebSocket: MockImpl,
      reconnect: { ...noJitter, minUptime: 0 }
    });
    ws.connect();
    MockWebSocket.last.open();
    vi.advanceTimersByTime(0);
    MockWebSocket.last.finishClose();
    vi.advanceTimersByTime(1000);
    MockWebSocket.last.open();
    vi.advanceTimersByTime(0);
    MockWebSocket.last.finishClose();
    expect(ws.getSnapshot().attempt).toBe(1);
    ws.close();
  });

  it("doesn't retry 1002, 1003 or 1008 by default", () => {
    for (const code of [1002, 1003, 1008]) {
      const ws = createWebSocket(`ws://${code}`, { WebSocket: MockImpl });
      ws.connect();
      MockWebSocket.last.open();
      MockWebSocket.last.finishClose(code, 'rejected');
      expect(ws.getSnapshot().status).toBe('closed');
    }
    vi.advanceTimersByTime(60_000);
    expect(MockWebSocket.instances).toHaveLength(3);

    expect(retryableClose({ code: 1008, reason: '', wasClean: true })).toBe(false);
    expect(retryableClose({ code: 1006, reason: '', wasClean: false })).toBe(true);
    expect(retryableClose({ code: 4000, reason: '', wasClean: false })).toBe(true);
  });

  it('replaces the default with a custom shouldReconnect', () => {
    const ws = createWebSocket('ws://x', {
      WebSocket: MockImpl,
      reconnect: { ...noJitter, shouldReconnect: () => true }
    });
    ws.connect();
    MockWebSocket.last.finishClose(1008);
    expect(ws.getSnapshot().status).toBe('reconnecting');
    ws.close();
  });

  it('picks each delay at random up to the backoff by default (full jitter)', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.75);
    const ws = createWebSocket('ws://x', { WebSocket: MockImpl });
    ws.connect();
    MockWebSocket.last.finishClose();
    vi.advanceTimersByTime(249); // 1000 * (1 - 0.75) = 250
    expect(MockWebSocket.instances).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(MockWebSocket.instances).toHaveLength(2);
    ws.close();
    vi.restoreAllMocks();
  });

  it('retries immediately when the browser comes back online', () => {
    const ws = createWebSocket('ws://x', { WebSocket: MockImpl, reconnect: noJitter });
    ws.connect();
    MockWebSocket.last.finishClose();
    expect(MockWebSocket.instances).toHaveLength(1);
    window.dispatchEvent(new Event('online'));
    expect(MockWebSocket.instances).toHaveLength(2);
    vi.advanceTimersByTime(5000);
    expect(MockWebSocket.instances).toHaveLength(2);
  });

  it('reconnect() replaces the socket immediately and reports the old close', () => {
    const ws = createWebSocket('ws://x', { WebSocket: MockImpl });
    const onClose = vi.fn();
    ws.on('close', onClose);
    ws.connect();
    const first = MockWebSocket.last;
    first.open();
    ws.reconnect();
    expect(first.closedWith).toEqual({ code: 1000, reason: 'reconnect' });
    expect(MockWebSocket.instances).toHaveLength(2);
    expect(ws.getSnapshot().status).toBe('connecting');

    first.finishClose(1000, 'reconnect');
    expect(onClose).toHaveBeenCalledWith({ code: 1000, reason: 'reconnect', wasClean: true });
    expect(ws.getSnapshot().status).toBe('connecting');
  });
});

describe('close()', () => {
  it('stops reconnecting, reports the close and clears the queue', () => {
    const ws = createWebSocket('ws://x', { WebSocket: MockImpl, reconnect: noJitter });
    const onClose = vi.fn();
    ws.on('close', onClose);
    ws.connect();
    const socket = MockWebSocket.last;
    socket.open();
    ws.close(1000, 'bye');
    expect(socket.closedWith).toEqual({ code: 1000, reason: 'bye' });
    expect(ws.getSnapshot().status).toBe('closed');

    socket.finishClose(1000, 'bye');
    expect(onClose).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(60_000);
    expect(MockWebSocket.instances).toHaveLength(1);
  });

  it('cancels a pending retry', () => {
    const ws = createWebSocket('ws://x', { WebSocket: MockImpl, reconnect: noJitter });
    ws.connect();
    MockWebSocket.last.finishClose();
    ws.close();
    vi.advanceTimersByTime(60_000);
    expect(MockWebSocket.instances).toHaveLength(1);
    expect(ws.getSnapshot().status).toBe('closed');
  });
});

describe('heartbeat', () => {
  it('pings, swallows pongs, and reconnects when the server goes quiet', () => {
    const ws = createWebSocket('ws://x', {
      WebSocket: MockImpl,
      reconnect: noJitter,
      heartbeat: { interval: 1000, message: 'ping', pong: 'pong', timeout: 500 }
    });
    const onMessage = vi.fn();
    const onClose = vi.fn();
    ws.on('message', onMessage);
    ws.on('close', onClose);
    ws.connect();
    const socket = MockWebSocket.last;
    socket.open();

    vi.advanceTimersByTime(1000);
    expect(socket.sent).toEqual(['ping']);
    socket.receive('pong');
    expect(onMessage).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1000);
    vi.advanceTimersByTime(500);
    expect(socket.closedWith).toEqual({ code: 4000, reason: 'heartbeat timeout' });
    expect(onClose).toHaveBeenCalledWith({
      code: 4000,
      reason: 'heartbeat timeout',
      wasClean: false
    });
    expect(ws.getSnapshot().status).toBe('reconnecting');

    socket.finishClose(4000); // late close of the dead socket is ignored
    expect(onClose).toHaveBeenCalledOnce();
  });
});

describe('ready', () => {
  it('starts an idle connection, resolves on open and exposes its status to use()', async () => {
    const ws = createWebSocket('ws://x', { WebSocket: MockImpl });
    const ready = ws.ready;
    expect(ws.ready).toBe(ready);
    expect(MockWebSocket.instances).toHaveLength(0); // started outside render
    await Promise.resolve();
    expect(MockWebSocket.instances).toHaveLength(1);

    MockWebSocket.last.open();
    await expect(ready).resolves.toBeUndefined();
    expect((ready as any).status).toBe('fulfilled');
    expect(ws.ready).toBe(ready);
  });

  it('stays resolved while reconnecting automatically', () => {
    const ws = createWebSocket('ws://x', { WebSocket: MockImpl, reconnect: noJitter });
    ws.connect();
    MockWebSocket.last.open();
    const first = ws.ready;
    MockWebSocket.last.finishClose();
    expect(ws.getSnapshot().status).toBe('reconnecting');
    expect(ws.ready).toBe(first);
    expect((first as any).status).toBe('fulfilled');
  });

  it('is resolved when first read during a reconnect after having opened', () => {
    const ws = createWebSocket('ws://x', { WebSocket: MockImpl, reconnect: noJitter });
    ws.connect();
    MockWebSocket.last.open();
    MockWebSocket.last.finishClose();
    expect((ws.ready as any).status).toBe('fulfilled');
  });

  it('rejects after giving up and is pending again after reconnect()', async () => {
    const ws = createWebSocket('ws://x', {
      WebSocket: MockImpl,
      reconnect: { ...noJitter, maxAttempts: 1 }
    });
    ws.connect();
    MockWebSocket.last.open();
    MockWebSocket.last.finishClose();
    vi.advanceTimersByTime(1000);
    MockWebSocket.last.finishClose();
    expect(ws.getSnapshot().status).toBe('closed');
    await expect(ws.ready).rejects.toThrow('code 1006');

    ws.reconnect();
    const next = ws.ready;
    expect((next as any).status).toBe('pending');
    MockWebSocket.last.open();
    await expect(next).resolves.toBeUndefined();
  });

  it('rejects after close() and is fresh again after connect()', async () => {
    const ws = createWebSocket('ws://x', { WebSocket: MockImpl });
    ws.connect();
    const pending = ws.ready;
    ws.close();
    await expect(pending).rejects.toThrow('closed');
    expect(ws.ready).toBe(pending); // stays rejected; reading it doesn't reconnect
    expect(MockWebSocket.instances).toHaveLength(1);

    ws.connect();
    expect(ws.ready).not.toBe(pending);
  });
});

describe('acquire()', () => {
  it('shares one socket and tears down a tick after the last release', () => {
    const ws = createWebSocket('ws://x', { WebSocket: MockImpl });
    const releaseA = ws.acquire();
    const releaseB = ws.acquire();
    expect(MockWebSocket.instances).toHaveLength(1);
    MockWebSocket.last.open();

    releaseA();
    releaseA(); // idempotent
    vi.runAllTimers();
    expect(ws.getSnapshot().status).toBe('open');

    releaseB();
    expect(ws.getSnapshot().status).toBe('open');
    vi.runAllTimers();
    expect(ws.getSnapshot().status).toBe('idle');
    expect(MockWebSocket.last.closedWith).toBeDefined();
  });

  it('survives release + re-acquire in the same tick (StrictMode)', () => {
    const ws = createWebSocket('ws://x', { WebSocket: MockImpl });
    const release = ws.acquire();
    release();
    const releaseAgain = ws.acquire();
    vi.runAllTimers();
    expect(MockWebSocket.instances).toHaveLength(1);
    expect(MockWebSocket.last.closedWith).toBeUndefined();
    releaseAgain();
  });

  it('does not tear down while someone waits on ready', () => {
    const ws = createWebSocket('ws://x', { WebSocket: MockImpl });
    const release = ws.acquire();
    void ws.ready;
    release();
    vi.runAllTimers();
    expect(ws.getSnapshot().status).toBe('connecting');
  });

  it('closes a connection nobody holds a few seconds after ready resolves', async () => {
    const ws = createWebSocket('ws://x', { WebSocket: MockImpl });
    void ws.ready; // e.g. a Suspense render that was then abandoned
    await Promise.resolve();
    MockWebSocket.last.open();
    vi.advanceTimersByTime(4999);
    expect(ws.getSnapshot().status).toBe('open');
    vi.advanceTimersByTime(1);
    expect(ws.getSnapshot().status).toBe('idle');
    expect(MockWebSocket.last.closedWith).toBeDefined();
  });

  it('closes after ready resolves when the last holder left while connecting', () => {
    const ws = createWebSocket('ws://x', { WebSocket: MockImpl });
    const release = ws.acquire();
    void ws.ready;
    release();
    vi.runAllTimers();
    MockWebSocket.last.open();
    vi.runAllTimers();
    expect(ws.getSnapshot().status).toBe('idle');
  });

  it('keeps a ready-opened connection when a holder arrives within the grace period', async () => {
    const ws = createWebSocket('ws://x', { WebSocket: MockImpl });
    void ws.ready;
    await Promise.resolve();
    MockWebSocket.last.open();
    vi.advanceTimersByTime(1000); // React retries the suspended render and commits
    ws.acquire();
    vi.runAllTimers();
    expect(ws.getSnapshot().status).toBe('open');
  });

  it('keeps a connect()ed client open after the last release, until close()', () => {
    const ws = createWebSocket('ws://x', { WebSocket: MockImpl });
    ws.connect();
    const release = ws.acquire();
    MockWebSocket.last.open();
    release();
    vi.runAllTimers();
    expect(ws.getSnapshot().status).toBe('open');
    expect(MockWebSocket.last.closedWith).toBeUndefined();

    ws.close();
    expect(ws.getSnapshot().status).toBe('closed');
    // After close() it is reference-counted again.
    const releaseAgain = ws.acquire();
    ws.reconnect();
    releaseAgain();
    vi.runAllTimers();
    expect(ws.getSnapshot().status).toBe('idle');
  });
});

describe('reported issues', () => {
  it('#33: a successful reconnect resets the backoff', () => {
    const ws = createWebSocket('ws://x', { WebSocket: MockImpl, reconnect: noJitter });
    ws.connect();
    MockWebSocket.last.finishClose();
    vi.advanceTimersByTime(1000);
    MockWebSocket.last.finishClose();
    vi.advanceTimersByTime(2000);
    MockWebSocket.last.finishClose();
    vi.advanceTimersByTime(4000);
    expect(MockWebSocket.instances).toHaveLength(4);

    MockWebSocket.last.open();
    vi.advanceTimersByTime(5000); // stayed up for minUptime
    MockWebSocket.last.finishClose();
    expect(ws.getSnapshot().attempt).toBe(1);
    vi.advanceTimersByTime(1000); // back to minDelay, not 8000
    expect(MockWebSocket.instances).toHaveLength(5);
  });

  describe('#13: auth tokens via a url function', () => {
    it('resolves the url before every attempt', () => {
      let token = 0;
      const ws = createWebSocket(() => `ws://x?token=${++token}`, {
        WebSocket: MockImpl,
        reconnect: noJitter
      });
      ws.connect();
      expect(MockWebSocket.last.url).toBe('ws://x?token=1');
      MockWebSocket.last.finishClose();
      vi.advanceTimersByTime(1000);
      expect(MockWebSocket.last.url).toBe('ws://x?token=2');
    });

    it('waits for an async url and queues sends meanwhile', async () => {
      const ws = createWebSocket(async () => 'ws://x?token=abc', { WebSocket: MockImpl });
      ws.connect();
      ws.send('early');
      expect(ws.getSnapshot().status).toBe('connecting');
      expect(MockWebSocket.instances).toHaveLength(0);
      await vi.waitFor(() => expect(MockWebSocket.instances).toHaveLength(1));
      MockWebSocket.last.open();
      expect(MockWebSocket.last.sent).toEqual(['early']);
    });

    it('treats a failing url function as a failed attempt and retries', async () => {
      let calls = 0;
      const onError = vi.fn();
      const ws = createWebSocket(
        async () => {
          if (++calls === 1) throw new Error('token endpoint down');
          return 'ws://x';
        },
        { WebSocket: MockImpl, reconnect: noJitter }
      );
      ws.on('error', onError);
      ws.connect();
      await vi.waitFor(() => expect(ws.getSnapshot().status).toBe('reconnecting'));
      expect(onError).toHaveBeenCalledWith(
        expect.objectContaining({ message: 'token endpoint down' })
      );
      await vi.advanceTimersByTimeAsync(1000);
      expect(MockWebSocket.instances).toHaveLength(1);
    });

    it('drops a url that resolves after close()', async () => {
      let resolve!: (url: string) => void;
      const ws = createWebSocket(() => new Promise<string>(r => (resolve = r)), {
        WebSocket: MockImpl
      });
      ws.connect();
      ws.close();
      resolve('ws://x');
      await Promise.resolve();
      await Promise.resolve();
      expect(MockWebSocket.instances).toHaveLength(0);
      expect(ws.getSnapshot().status).toBe('closed');
    });
  });
});
