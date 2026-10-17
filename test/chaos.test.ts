import { createChaosWebSocket, type ChaosOptions, type ChaosWebSocket } from '../src/chaos';
import { createWebSocket, MessageError, type StandardSchemaV1 } from '../src/core';
import { MockImpl, MockWebSocket } from './mock';

const noJitter = { jitter: 0, minDelay: 1000, maxDelay: 30_000 };

beforeEach(() => {
  MockWebSocket.reset();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function chaos(options: ChaosOptions = {}) {
  return createChaosWebSocket({ WebSocket: MockImpl, ...options });
}

/** Record a socket's events as strings. */
function record(socket: WebSocket) {
  const events: string[] = [];
  socket.onopen = () => events.push('open');
  socket.onmessage = event => events.push(`message ${String(event.data)}`);
  socket.onerror = () => events.push('error');
  socket.onclose = event => events.push(`close ${event.code} ${event.wasClean}`);
  return events;
}

function thrown(fn: () => void) {
  try {
    fn();
  } catch (error) {
    return error;
  }
}

describe('without faults', () => {
  it('passes everything through synchronously', () => {
    const socket = new (chaos())('ws://x', ['v1']);
    const events = record(socket);
    const close = vi.fn();
    socket.addEventListener('close', close);
    const inner = MockWebSocket.last;
    expect(inner.protocols).toEqual(['v1']);
    expect(socket.url).toBe('ws://x');
    expect(socket.readyState).toBe(0);

    inner.open();
    expect(socket.readyState).toBe(1);
    inner.receive('hello');
    inner.onerror?.(new Event('error'));
    socket.send('hi');
    expect(inner.sent).toEqual(['hi']);

    socket.close(1000, 'bye');
    expect(socket.readyState).toBe(2);
    expect(inner.closedWith).toEqual({ code: 1000, reason: 'bye' });
    inner.finishClose(1000, 'bye');
    expect(socket.readyState).toBe(3);
    expect(events).toEqual(['open', 'message hello', 'error', 'close 1000 true']);

    const event = close.mock.calls[0]![0] as CloseEvent;
    expect(event).toBeInstanceOf(CloseEvent);
    expect(event).toMatchObject({ code: 1000, reason: 'bye', wasClean: true });
    expect(event.target).toBe(socket);
  });

  it('forwards binaryType, protocol and extensions, and has the constants', () => {
    const Chaos = chaos();
    const socket = new Chaos('ws://x');
    expect(socket.binaryType).toBe('blob');
    socket.binaryType = 'arraybuffer';
    expect(MockWebSocket.last.binaryType).toBe('arraybuffer');
    expect(socket.binaryType).toBe('arraybuffer');
    expect(socket.protocol).toBe('');
    expect(socket.extensions).toBe('');
    expect(socket.bufferedAmount).toBe(0);
    expect([Chaos.CONNECTING, Chaos.OPEN, Chaos.CLOSING, Chaos.CLOSED]).toEqual([0, 1, 2, 3]);
    expect([socket.CONNECTING, socket.OPEN, socket.CLOSING, socket.CLOSED]).toEqual([0, 1, 2, 3]);
  });

  it('throws like a browser on early sends and invalid close codes', () => {
    const socket = new (chaos())('ws://x');
    expect(thrown(() => socket.send('x'))).toMatchObject({ name: 'InvalidStateError' });
    expect(thrown(() => socket.close(1006))).toMatchObject({ name: 'InvalidAccessError' });
    expect(socket.readyState).toBe(0);

    MockWebSocket.last.open();
    socket.close();
    socket.send('late');
    socket.close(); // already closing
    expect(MockWebSocket.last.sent).toEqual([]);
  });

  it('lets constructor errors through without tracking the socket', () => {
    const logger = vi.fn();
    const Chaos = chaos({ logger });
    expect(() => new Chaos('invalid')).toThrow('invalid url');
    Chaos.drop();
    expect(logger).not.toHaveBeenCalled();
  });
});

describe('latency', () => {
  it('delays the handshake, messages and sends', () => {
    const socket = new (chaos({ latency: 100 }))('ws://x');
    const events = record(socket);
    const inner = MockWebSocket.last;
    inner.open();
    inner.receive('welcome'); // sent right after the open, so it waits behind it

    vi.advanceTimersByTime(99);
    expect(socket.readyState).toBe(0);
    expect(events).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(events).toEqual(['open']);
    vi.advanceTimersToNextTimer(); // each event is its own task
    expect(events).toEqual(['open', 'message welcome']);

    socket.send('héllo');
    expect(socket.bufferedAmount).toBe(6);
    vi.advanceTimersByTime(99);
    expect(inner.sent).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(inner.sent).toEqual(['héllo']);
    expect(socket.bufferedAmount).toBe(0);
  });

  it('keeps order when the delay varies', () => {
    const socket = new (chaos({ latency: [0, 1000], seed: 1 }))('ws://x');
    const received: unknown[] = [];
    socket.onmessage = event => received.push(event.data);
    const inner = MockWebSocket.last;
    inner.open();
    vi.advanceTimersByTime(1000);

    const numbers = [...Array(50).keys()];
    for (const n of numbers) {
      inner.receive(n);
      socket.send(String(n));
    }
    vi.advanceTimersByTime(500);
    expect(received.length).toBeLessThan(50);
    vi.advanceTimersByTime(60_000);
    expect(received).toEqual(numbers);
    expect(inner.sent).toEqual(numbers.map(String));
  });

  it('closes after pending sends, and stops delivering', () => {
    const socket = new (chaos({ latency: 100 }))('ws://x');
    const events = record(socket);
    const inner = MockWebSocket.last;
    inner.open();
    vi.advanceTimersByTime(100);

    inner.receive('late');
    socket.send('bye');
    socket.close(1000);
    expect(inner.closedWith).toBeUndefined();
    vi.advanceTimersByTime(100);
    expect(inner.sent).toEqual(['bye']);
    vi.advanceTimersToNextTimer();
    expect(inner.closedWith).toEqual({ code: 1000, reason: undefined });

    inner.finishClose(1000);
    vi.advanceTimersByTime(100);
    expect(events).toEqual(['open', 'close 1000 true']);
  });

  it('never opens when closed during the handshake', () => {
    const socket = new (chaos({ latency: 100 }))('ws://x');
    const events = record(socket);
    const inner = MockWebSocket.last;
    inner.open();
    socket.close();
    vi.advanceTimersByTime(100);
    inner.finishClose(1000);
    vi.advanceTimersByTime(100);
    expect(events).toEqual(['close 1000 true']);
  });
});

describe('lost and corrupt messages', () => {
  it('loses messages in both directions', () => {
    const logger = vi.fn();
    const socket = new (chaos({ loss: 1, logger }))('ws://x');
    const events = record(socket);
    const inner = MockWebSocket.last;
    inner.open();
    inner.receive('a');
    socket.send('b');
    expect(events).toEqual(['open']);
    expect(inner.sent).toEqual([]);
    expect(logger).toHaveBeenCalledWith('chaos: lost an incoming message', 'a');
    expect(logger).toHaveBeenCalledWith('chaos: lost an outgoing message', 'b');
  });

  it('loses messages in one direction', () => {
    const socket = new (chaos({ loss: { out: 1 } }))('ws://x');
    const events = record(socket);
    const inner = MockWebSocket.last;
    inner.open();
    inner.receive('a');
    socket.send('b');
    expect(events).toEqual(['open', 'message a']);
    expect(inner.sent).toEqual([]);
  });

  it('corrupts incoming messages', () => {
    const logger = vi.fn();
    const socket = new (chaos({ corrupt: 1, seed: 7, logger }))('ws://x');
    const received: unknown[] = [];
    socket.onmessage = event => received.push(event.data);
    const inner = MockWebSocket.last;
    inner.open();

    const json = JSON.stringify({ type: 'price', symbol: 'ACME', price: 101.5 });
    inner.receive(json);
    inner.receive(new ArrayBuffer(16));
    inner.receive(new Blob(['abcdef']));
    inner.receive(42);

    const [text, buffer, blob, other] = received;
    expect(() => JSON.parse(text as string)).toThrow();
    expect(text).toMatch(/�$/);
    expect(buffer).toBeInstanceOf(ArrayBuffer);
    expect((buffer as ArrayBuffer).byteLength).toBeLessThan(16);
    expect((blob as Blob).size).toBeLessThan(6);
    expect(other).toBe('�');
    expect(logger).toHaveBeenCalledWith('chaos: corrupted a message', json);
  });
});

describe('refused connections', () => {
  it('fail before reaching the server', () => {
    const logger = vi.fn();
    const socket = new (chaos({ refuse: 1, logger }))('ws://x');
    // Handlers attached after construction still see the refusal.
    const events = record(socket);
    expect(MockWebSocket.instances).toHaveLength(0);
    expect(socket.url).toBe('ws://x');
    expect(socket.binaryType).toBe('blob');
    expect(events).toEqual([]);

    vi.advanceTimersByTime(0);
    expect(events).toEqual(['error', 'close 1006 false']);
    expect(socket.readyState).toBe(3);
    expect(logger).toHaveBeenCalledWith('chaos: refused', 'ws://x');
  });

  it('close once when closed while refusing', () => {
    const socket = new (chaos({ refuse: 1, latency: 100 }))('ws://x');
    const events = record(socket);
    socket.close();
    vi.advanceTimersByTime(100);
    expect(events).toEqual(['error', 'close 1006 false']);
  });
});

describe('dropped connections', () => {
  it('drop after their lifetime', () => {
    const logger = vi.fn();
    const socket = new (chaos({ drop: 5000, logger }))('ws://x');
    const events = record(socket);
    const inner = MockWebSocket.last;
    inner.open();
    vi.advanceTimersByTime(4999);
    expect(events).toEqual(['open']);
    vi.advanceTimersByTime(1);
    expect(events).toEqual(['open', 'error', 'close 1006 false']);
    expect(inner.closedWith).toEqual({ code: 4999, reason: 'chaos' });
    expect(logger).toHaveBeenCalledWith('chaos: dropped', 'ws://x');

    inner.finishClose(4999, 'chaos');
    expect(events).toHaveLength(3);
  });

  it('drop on demand, whether open or connecting', () => {
    const Chaos = chaos();
    const open = new Chaos('ws://a');
    const connecting = new Chaos('ws://b');
    const [innerOpen, innerConnecting] = MockWebSocket.instances;
    innerOpen!.open();
    const openEvents = record(open);
    const connectingEvents = record(connecting);

    Chaos.drop();
    expect(openEvents).toEqual(['error', 'close 1006 false']);
    expect(connectingEvents).toEqual(['error', 'close 1006 false']);
    expect(innerConnecting!.closedWith).toEqual({ code: 4999, reason: 'chaos' });
  });

  it('simulate a server close when given a code', () => {
    const Chaos = chaos();
    const socket = new Chaos('ws://x');
    const close = vi.fn();
    const error = vi.fn();
    socket.addEventListener('close', close);
    socket.addEventListener('error', error);
    MockWebSocket.last.open();

    Chaos.drop(4001, 'unauthorized');
    expect(error).not.toHaveBeenCalled();
    expect(close.mock.calls[0]![0]).toMatchObject({
      code: 4001,
      reason: 'unauthorized',
      wasClean: true
    });
  });

  it('spare a socket opened from a close listener', () => {
    const Chaos = chaos();
    const socket = new Chaos('ws://x');
    let next: WebSocket | undefined;
    socket.onclose = () => {
      next = new Chaos('ws://x');
    };
    MockWebSocket.last.open();
    Chaos.drop();
    expect(next!.readyState).toBe(0);
    MockWebSocket.last.open();
    expect(next!.readyState).toBe(1);
  });
});

describe('stalls', () => {
  it('go silent without closing', () => {
    const logger = vi.fn();
    const Chaos = chaos({ logger });
    const socket = new Chaos('ws://x');
    const events = record(socket);
    const inner = MockWebSocket.last;
    inner.open();

    Chaos.stall();
    expect(logger).toHaveBeenCalledWith('chaos: stalled', 'ws://x');
    inner.receive('lost');
    socket.send('void');
    expect(socket.readyState).toBe(1);
    expect(inner.sent).toEqual([]);
    expect(socket.bufferedAmount).toBe(4);

    inner.finishClose(1006);
    expect(events).toEqual(['open']);
    expect(socket.readyState).toBe(1);
  });

  it('start after their lifetime and drop messages already on the way', () => {
    const socket = new (chaos({ stall: 1000, latency: 100 }))('ws://x');
    const events = record(socket);
    const inner = MockWebSocket.last;
    inner.open();
    vi.advanceTimersByTime(1050);
    inner.receive('in flight');
    vi.advanceTimersByTime(50);
    inner.receive('after');
    vi.advanceTimersByTime(1000);
    expect(events).toEqual(['open']);
  });

  it('close without a handshake', () => {
    const Chaos = chaos();
    const socket = new Chaos('ws://x');
    const events = record(socket);
    const inner = MockWebSocket.last;
    inner.open();
    Chaos.stall();

    socket.close(4000, 'heartbeat timeout');
    expect(inner.closedWith).toEqual({ code: 4000, reason: 'heartbeat timeout' });
    expect(socket.readyState).toBe(2);
    vi.advanceTimersByTime(0);
    expect(events).toEqual(['open', 'close 1006 false']);
  });
});

describe('controls', () => {
  it('inject messages into open connections only', () => {
    const Chaos = chaos({ latency: 100, loss: 1, corrupt: 1 });
    const open = new Chaos('ws://a');
    const connecting = new Chaos('ws://b');
    const openEvents = record(open);
    const connectingEvents = record(connecting);
    MockWebSocket.instances[0]!.open();
    vi.advanceTimersByTime(100);

    Chaos.inject('{"price":"cheap"}');
    vi.advanceTimersByTime(99);
    expect(openEvents).toEqual(['open']);
    vi.advanceTimersByTime(1);
    expect(openEvents).toEqual(['open', 'message {"price":"cheap"}']);
    expect(connectingEvents).toEqual([]);

    Chaos.stall();
    Chaos.inject('again');
    vi.advanceTimersByTime(100);
    expect(openEvents).toHaveLength(2);
  });

  it('arm and disarm drops on open connections', () => {
    const Chaos = chaos();
    const socket = new Chaos('ws://x');
    const events = record(socket);
    MockWebSocket.last.open();

    Chaos.configure({ drop: 1000 });
    vi.advanceTimersByTime(500);
    Chaos.configure({ latency: 10 }); // doesn't restart the lifetime
    vi.advanceTimersByTime(500);
    expect(events).toEqual(['open', 'error', 'close 1006 false']);

    const next = new Chaos('ws://x');
    const nextEvents = record(next);
    MockWebSocket.last.open();
    vi.advanceTimersByTime(10);
    Chaos.configure({ drop: false });
    vi.advanceTimersByTime(5000);
    expect(nextEvents).toEqual(['open']);
  });

  it('pass everything through while disabled, except the controls', () => {
    const Chaos = chaos({ enabled: false, latency: 100, loss: 1, refuse: 1, drop: 10 });
    const socket = new Chaos('ws://x');
    const events = record(socket);
    const inner = MockWebSocket.last;
    inner.open();
    inner.receive('a');
    socket.send('b');
    vi.advanceTimersByTime(1000);
    expect(events).toEqual(['open', 'message a']);
    expect(inner.sent).toEqual(['b']);

    Chaos.stall();
    inner.receive('c');
    expect(events).toEqual(['open', 'message a']);

    Chaos.configure({ enabled: true });
    vi.advanceTimersByTime(10);
    expect(events).toEqual(['open', 'message a', 'error', 'close 1006 false']);
  });
});

describe('seed', () => {
  function outcomes(seed: number) {
    MockWebSocket.reset();
    const Chaos = chaos({ seed, refuse: 0.5, drop: [1000, 60_000] });
    const start = Date.now();
    const results: string[] = [];
    for (let i = 0; i < 20; i++) {
      const before = MockWebSocket.instances.length;
      const socket = new Chaos('ws://x');
      const refused = MockWebSocket.instances.length === before;
      if (!refused) MockWebSocket.last.open();
      socket.onclose = () => results.push(refused ? `${i} refused` : `${i} ${Date.now() - start}`);
    }
    vi.advanceTimersByTime(60_000);
    return results;
  }

  it('repeats the same faults', () => {
    const first = outcomes(42);
    expect(first).toHaveLength(20);
    expect(first.filter(result => result.endsWith('refused')).length).toBeGreaterThan(0);
    expect(first.filter(result => result.endsWith('refused')).length).toBeLessThan(20);
    expect(outcomes(42)).toEqual(first);
    expect(outcomes(43)).not.toEqual(first);
  });

  it("doesn't let one connection's traffic change the next one's faults", () => {
    function secondDrop(messages: number) {
      MockWebSocket.reset();
      const Chaos = chaos({
        seed: 3,
        loss: 0.5,
        corrupt: 0.5,
        latency: [0, 50],
        drop: [1000, 60_000]
      });
      new Chaos('ws://x');
      MockWebSocket.last.open();
      for (let i = 0; i < messages; i++) MockWebSocket.last.receive('x');
      const start = Date.now();
      const second = new Chaos('ws://y');
      MockWebSocket.last.open();
      let droppedAfter = 0;
      second.onclose = () => (droppedAfter = Date.now() - start);
      vi.advanceTimersByTime(70_000);
      return droppedAfter;
    }
    const quiet = secondDrop(0);
    expect(quiet).toBeGreaterThan(0);
    expect(secondDrop(50)).toBe(quiet);
  });
});

it('builds close events without a global CloseEvent', () => {
  vi.stubGlobal('CloseEvent', undefined);
  const socket = new (chaos())('ws://x');
  const close = vi.fn();
  socket.addEventListener('close', close);
  MockWebSocket.last.open();
  MockWebSocket.last.finishClose(4001, 'nope');
  expect(close.mock.calls[0]![0]).toMatchObject({
    type: 'close',
    code: 4001,
    reason: 'nope',
    wasClean: false
  });
});

describe('with createWebSocket', () => {
  it('reconnects after a drop', () => {
    const client = createWebSocket('ws://x', {
      WebSocket: chaos({ drop: 5000 }),
      reconnect: noJitter
    });
    const onClose = vi.fn();
    client.on('close', onClose);
    client.connect();
    MockWebSocket.last.open();
    expect(client.getSnapshot().status).toBe('open');

    vi.advanceTimersByTime(5000);
    expect(client.getSnapshot().status).toBe('reconnecting');
    expect(onClose).toHaveBeenCalledWith({ code: 1006, reason: '', wasClean: false });
    vi.advanceTimersByTime(1000);
    expect(MockWebSocket.instances).toHaveLength(2);
    MockWebSocket.last.open();
    expect(client.getSnapshot().status).toBe('open');
  });

  it('notices a stall with a heartbeat timeout', () => {
    const Chaos = chaos();
    const client = createWebSocket('ws://x', {
      WebSocket: Chaos,
      reconnect: noJitter,
      heartbeat: { interval: 1000, pong: 'pong', timeout: 500 }
    });
    const onClose = vi.fn();
    client.on('close', onClose);
    client.connect();
    const inner = MockWebSocket.last;
    inner.open();
    vi.advanceTimersByTime(1000);
    inner.receive('pong');
    expect(inner.sent).toEqual(['ping']);

    Chaos.stall();
    vi.advanceTimersByTime(1500);
    expect(inner.sent).toEqual(['ping']); // the second ping vanished
    expect(client.getSnapshot().status).toBe('reconnecting');
    expect(onClose).toHaveBeenCalledExactlyOnceWith({
      code: 4000,
      reason: 'heartbeat timeout',
      wasClean: false
    });
    expect(inner.closedWith).toEqual({ code: 4000, reason: 'heartbeat timeout' });
  });

  it('reports corrupt messages as MessageError', () => {
    const client = createWebSocket('ws://x', { WebSocket: chaos({ corrupt: 1 }), json: true });
    const onError = vi.fn();
    client.on('error', onError);
    client.connect();
    MockWebSocket.last.open();
    MockWebSocket.last.receive(JSON.stringify({ n: 1 }));
    expect(onError.mock.calls[0]![0]).toBeInstanceOf(MessageError);
    expect(client.getSnapshot().lastMessage).toBeUndefined();
  });

  it('reports injected messages that fail the schema', () => {
    const schema: StandardSchemaV1<unknown, { price: number }> = {
      '~standard': {
        version: 1,
        vendor: 'test',
        validate: value =>
          typeof (value as { price?: unknown }).price === 'number'
            ? { value: value as { price: number } }
            : { issues: [{ message: 'price must be a number' }] }
      }
    };
    const Chaos = chaos();
    const client = createWebSocket('ws://x', { WebSocket: Chaos, json: true, schema });
    const onError = vi.fn();
    client.on('error', onError);
    client.connect();
    MockWebSocket.last.open();

    Chaos.inject(JSON.stringify({ price: 'cheap' }));
    expect(onError.mock.calls[0]![0]).toMatchObject({
      name: 'MessageError',
      issues: [{ message: 'price must be a number' }]
    });
  });

  it('recovers once refusals stop', () => {
    const Chaos = chaos({ refuse: 1 });
    const client = createWebSocket('ws://x', { WebSocket: Chaos, reconnect: noJitter });
    client.connect();
    vi.advanceTimersByTime(0);
    expect(client.getSnapshot()).toMatchObject({ status: 'reconnecting', attempt: 1 });
    vi.advanceTimersByTime(1001); // the retry at 1000 ms, refused a task later
    expect(client.getSnapshot()).toMatchObject({ status: 'reconnecting', attempt: 2 });

    Chaos.configure({ refuse: 0 });
    vi.advanceTimersByTime(2000);
    expect(MockWebSocket.instances).toHaveLength(1);
    MockWebSocket.last.open();
    expect(client.getSnapshot().status).toBe('open');
  });

  it('queues sends until the delayed open', () => {
    const client = createWebSocket<string, string>('ws://x', {
      WebSocket: chaos({ latency: 100 })
    });
    client.connect();
    MockWebSocket.last.open();
    expect(client.send('hello')).toBe(false);
    vi.advanceTimersByTime(100);
    expect(client.getSnapshot().status).toBe('open');
    vi.advanceTimersByTime(100);
    expect(MockWebSocket.last.sent).toEqual(['hello']);
  });

  it('drops sends with maxBuffered while a slow link holds earlier ones', () => {
    const client = createWebSocket<string, string>('ws://x', {
      WebSocket: chaos({ latency: 100 })
    });
    client.connect();
    MockWebSocket.last.open();
    vi.advanceTimersByTime(100);
    expect(client.send('x'.repeat(600))).toBe(true);
    expect(client.send('frame 1', { maxBuffered: 500 })).toBe(false);
    vi.advanceTimersByTime(100); // the buffer drains
    expect(client.send('frame 2', { maxBuffered: 500 })).toBe(true);
    vi.advanceTimersByTime(100);
    expect(MockWebSocket.last.sent).toEqual(['x'.repeat(600), 'frame 2']);
  });
});

it('is typed as a WebSocket class with controls', () => {
  const Chaos = createChaosWebSocket({ WebSocket: MockImpl });
  const impl: typeof WebSocket = Chaos;
  createWebSocket('ws://x', { WebSocket: Chaos });
  expectTypeOf(Chaos).toEqualTypeOf<ChaosWebSocket>();
  // @ts-expect-error the seed is fixed at creation
  Chaos.configure({ seed: 1 });
  expect(impl).toBe(Chaos);
});
