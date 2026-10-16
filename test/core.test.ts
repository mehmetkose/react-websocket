import { createWebSocket, MessageError, type StandardSchemaV1 } from '../src/core';
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

  it('drops instead of queueing when queue is false', () => {
    const ws = createWebSocket('ws://x', { WebSocket: MockImpl, queue: false });
    ws.connect();
    ws.send('a');
    MockWebSocket.last.open();
    expect(MockWebSocket.last.sent).toEqual([]);
  });

  it('serializes with json or a custom serializer', () => {
    const json = createWebSocket<unknown, { n: number }>('ws://x', { WebSocket: MockImpl, json: true });
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
    expect(onClose).toHaveBeenCalledWith({ code: 4000, reason: 'heartbeat timeout', wasClean: false });
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

  it('is a new pending promise while reconnecting', async () => {
    const ws = createWebSocket('ws://x', { WebSocket: MockImpl, reconnect: noJitter });
    ws.connect();
    MockWebSocket.last.open();
    const first = ws.ready;
    MockWebSocket.last.finishClose();
    const second = ws.ready;
    expect(second).not.toBe(first);
    expect((second as any).status).toBe('pending');
    vi.advanceTimersByTime(1000);
    MockWebSocket.last.open();
    await expect(second).resolves.toBeUndefined();
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
});
