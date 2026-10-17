import { StrictMode, useEffect } from 'react';
import { act, render } from '@testing-library/react';
import {
  createWebSocket,
  createWebSocketRequests,
  useWebSocketStream,
  type SendOptions,
  type UseWebSocketStreamResult,
  type WebSocketRequests
} from '../src';
import { MockImpl, MockWebSocket } from './mock';

type In =
  | { type: 'reply'; id: number | string; ok?: string; error?: string }
  | { type: 'chunk'; id: number; text: string }
  | { type: 'chat' };
type Out =
  | { type: 'join'; room: string; id: number }
  | { type: 'cancel'; id: number }
  | { type: 'chat' };
type Request = { type: 'join'; room: string };

let n = 0;

function setup(
  options: {
    timeout?: number;
    done?: (message: In) => boolean;
    cancel?: (id: number) => Out;
  } = {}
) {
  const client = createWebSocket<In, Out>(`ws://requests/${++n}`, {
    WebSocket: MockImpl,
    json: true,
    reconnect: { jitter: 0, minDelay: 1000 }
  });
  const rpc = createWebSocketRequests(client, {
    send: (message: Request, id) => ({ ...message, id }),
    reply: message => (message.type === 'chat' ? undefined : message.id),
    error: message =>
      message.type === 'reply' && message.error ? new Error(message.error) : undefined,
    ...options
  });
  return { client, rpc };
}

// Streams end on a `reply`, and `cancel` tells the server to stop.
const STREAM = {
  done: (message: In) => message.type === 'reply',
  cancel: (id: number): Out => ({ type: 'cancel', id })
};

const sent = (socket = MockWebSocket.last) => socket.sent.map(data => JSON.parse(data as string));
const sentEverywhere = () => MockWebSocket.instances.flatMap(socket => sent(socket));
const reply = (message: In, socket = MockWebSocket.last) => socket.receive(JSON.stringify(message));
const chunk = (id: number, text: string) => reply({ type: 'chunk', id, text });
const join = (room: string, id: number) => ({ type: 'join', room, id });
const cancel = (id: number) => ({ type: 'cancel', id });
const ended = { done: true, value: undefined };

async function collect<T>(replies: AsyncIterable<T>) {
  const all: T[] = [];
  for await (const value of replies) all.push(value);
  return all;
}

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

  it('rejects requests the old connection had not answered after migrate()', async () => {
    const { client, rpc } = setup();
    client.connect();
    MockWebSocket.last.open();
    const before = rpc.request({ type: 'join', room: 'a' });
    client.migrate();
    vi.advanceTimersByTime(0);
    // Sent while moving: still on the old connection.
    const during = rpc.request({ type: 'join', room: 'b' });
    MockWebSocket.last.open();
    await expect(before).rejects.toThrow('connection was lost');
    await expect(during).rejects.toThrow('connection was lost');

    const after = rpc.request({ type: 'join', room: 'c' });
    expect(sent()).toEqual([{ type: 'join', room: 'c', id: 3 }]);
    reply({ type: 'reply', id: 3 });
    await expect(after).resolves.toMatchObject({ id: 3 });
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

  it('rejects a request dropped by maxBuffered right away', async () => {
    const { client, rpc } = setup();
    client.connect();
    MockWebSocket.last.open();
    MockWebSocket.last.bufferedAmount = 1000;
    await expect(rpc.request({ type: 'join', room: 'a' }, { maxBuffered: 100 })).rejects.toThrow(
      'send buffer is full'
    );
    expect(rpc.pending()).toBe(0);
    expect(sent()).toEqual([]);
  });

  it('sends a queued priority request before earlier ones', () => {
    const { client, rpc } = setup();
    client.connect();
    rpc.request({ type: 'join', room: 'a' });
    rpc.request({ type: 'join', room: 'b' }, { priority: true });
    MockWebSocket.last.open();
    expect(sent()).toEqual([
      { type: 'join', room: 'b', id: 2 },
      { type: 'join', room: 'a', id: 1 }
    ]);
  });

  it('rejects a keyed request replaced in the queue by a newer one', async () => {
    const { client, rpc } = setup();
    client.connect();
    const first = rpc.request({ type: 'join', room: 'a' }, { key: 'join', timeout: Infinity });
    const second = rpc.request({ type: 'join', room: 'b' }, { key: 'join', timeout: Infinity });
    await expect(first).rejects.toThrow('dropped from the send queue');
    expect(rpc.pending()).toBe(1);
    MockWebSocket.last.open();
    expect(sent()).toEqual([{ type: 'join', room: 'b', id: 2 }]);
    reply({ type: 'reply', id: 2 });
    await expect(second).resolves.toMatchObject({ id: 2 });
  });

  it('rejects a request evicted by queue.limit, and still calls its own onDrop', async () => {
    const client = createWebSocket<In, Out>('ws://requests/limit', {
      WebSocket: MockImpl,
      json: true,
      queue: { limit: 1 }
    });
    const rpc = createWebSocketRequests(client, {
      send: (message: Request, id) => ({ ...message, id }),
      reply: message => (message.type === 'reply' ? message.id : undefined)
    });
    client.connect();
    const onDrop = vi.fn();
    const first = rpc.request({ type: 'join', room: 'a' }, { onDrop });
    const second = rpc.request({ type: 'join', room: 'b' });
    await expect(first).rejects.toThrow('dropped from the send queue');
    expect(onDrop).toHaveBeenCalledOnce();
    client.close();
    await expect(second).rejects.toThrow('closed');
  });

  it('gives each request a unique id across managers on one client', async () => {
    const { client, rpc } = setup();
    const other = createWebSocketRequests(client, {
      send: (message: Request, id) => ({ ...message, id }),
      reply: message => (message.type === 'reply' ? message.id : undefined)
    });
    client.connect();
    MockWebSocket.last.open();
    const a = rpc.request({ type: 'join', room: 'a' });
    const b = other.request({ type: 'join', room: 'b' });
    expect(sent().map(message => message.id)).toEqual([1, 2]);
    reply({ type: 'reply', id: 1, ok: 'a' });
    await expect(a).resolves.toMatchObject({ ok: 'a' });
    expect(other.pending()).toBe(1);
    reply({ type: 'reply', id: 2, ok: 'b' });
    await expect(b).resolves.toMatchObject({ ok: 'b' });
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

describe('cancel', () => {
  it('is sent when a request is aborted, times out or is disposed', async () => {
    const { client, rpc } = setup({ ...STREAM, timeout: 1000 });
    client.connect();
    MockWebSocket.last.open();

    const controller = new AbortController();
    const aborted = rpc.request({ type: 'join', room: 'a' }, { signal: controller.signal });
    controller.abort('stop');
    await expect(aborted).rejects.toBe('stop');

    const timedOut = rpc.request({ type: 'join', room: 'b' });
    vi.advanceTimersByTime(1000);
    await expect(timedOut).rejects.toMatchObject({ name: 'TimeoutError' });

    const disposed = rpc.request({ type: 'join', room: 'c' });
    rpc.dispose();
    await expect(disposed).rejects.toThrow('disposed');

    expect(sent()).toEqual([
      join('a', 1),
      cancel(1),
      join('b', 2),
      cancel(2),
      join('c', 3),
      cancel(3)
    ]);
  });

  it('is not sent after a reply, an error reply, a lost connection or close()', async () => {
    const { client, rpc } = setup(STREAM);
    client.connect();
    MockWebSocket.last.open();

    const answered = rpc.request({ type: 'join', room: 'a' });
    reply({ type: 'reply', id: 1 });
    await expect(answered).resolves.toMatchObject({ id: 1 });
    const failed = rpc.request({ type: 'join', room: 'b' });
    reply({ type: 'reply', id: 2, error: 'full' });
    await expect(failed).rejects.toThrow('full');
    const lost = rpc.request({ type: 'join', room: 'c' });
    MockWebSocket.last.finishClose(1006);
    await expect(lost).rejects.toThrow('connection was lost');

    vi.advanceTimersByTime(1000);
    MockWebSocket.last.open();
    const closed = rpc.request({ type: 'join', room: 'd' });
    client.close();
    await expect(closed).rejects.toThrow('closed');

    expect(sentEverywhere().filter(message => message.type === 'cancel')).toEqual([]);
  });

  it('queues behind a request that has not been sent yet', () => {
    const { client, rpc } = setup(STREAM);
    client.connect();
    client.send({ type: 'chat' });
    const ordinary = new AbortController();
    rpc.request({ type: 'join', room: 'a' }, { signal: ordinary.signal }).catch(() => {});
    const urgent = new AbortController();
    rpc
      .request({ type: 'join', room: 'b' }, { signal: urgent.signal, priority: true })
      .catch(() => {});
    client.send({ type: 'chat' });
    ordinary.abort();
    urgent.abort();
    MockWebSocket.last.open();
    // A priority request's cancel joins it at the head of the queue, after it.
    expect(sent()).toEqual([
      join('b', 2),
      cancel(2),
      { type: 'chat' },
      join('a', 1),
      { type: 'chat' },
      cancel(1)
    ]);
  });

  it("is dropped, not queued for the next connection, while the request's socket is closing", async () => {
    const { client, rpc } = setup(STREAM);
    client.connect();
    MockWebSocket.last.open();
    const controller = new AbortController();
    const request = rpc.request({ type: 'join', room: 'a' }, { signal: controller.signal });
    MockWebSocket.last.readyState = 2; // the server started closing it
    controller.abort('stop');
    await expect(request).rejects.toBe('stop');
    MockWebSocket.last.finishClose(1006);
    vi.advanceTimersByTime(1000);
    MockWebSocket.last.open();
    expect(sent()).toEqual([]);
  });

  it('reports a cancel builder that throws, and still ends every request', async () => {
    const thrown: unknown[] = [];
    const spy = vi.spyOn(globalThis, 'queueMicrotask').mockImplementation(callback => {
      try {
        callback();
      } catch (error) {
        thrown.push(error);
      }
    });
    try {
      const { client, rpc } = setup({
        ...STREAM,
        cancel: () => {
          throw new Error('bad cancel');
        }
      });
      client.connect();
      const first = rpc.request({ type: 'join', room: 'a' });
      const second = rpc.request({ type: 'join', room: 'b' });
      rpc.dispose();
      await expect(first).rejects.toThrow('disposed');
      await expect(second).rejects.toThrow('disposed');
      expect(thrown).toEqual([new Error('bad cancel'), new Error('bad cancel')]);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('stream', () => {
  it('yields replies in order, up to and including the last one', async () => {
    const { client, rpc } = setup(STREAM);
    client.connect();
    MockWebSocket.last.open();

    const replies = rpc.stream({ type: 'join', room: 'a' });
    expect(sent()).toEqual([join('a', 1)]); // sent right away, before anything reads it
    expect(rpc.pending()).toBe(1);
    chunk(1, 'Hel');
    chunk(1, 'lo');
    reply({ type: 'reply', id: 1, ok: 'end' });
    chunk(1, 'late');
    expect(rpc.pending()).toBe(0);

    await expect(collect(replies)).resolves.toEqual([
      { type: 'chunk', id: 1, text: 'Hel' },
      { type: 'chunk', id: 1, text: 'lo' },
      { type: 'reply', id: 1, ok: 'end' }
    ]);
    await expect(replies.next()).resolves.toEqual(ended);
    expect(sent()).toEqual([join('a', 1)]); // no cancel after the last reply
  });

  it('wakes a waiting read, and still delivers replies as ordinary messages', async () => {
    const { client, rpc } = setup(STREAM);
    const onMessage = vi.fn();
    client.on('message', onMessage);
    client.connect();
    MockWebSocket.last.open();
    const replies = rpc.stream({ type: 'join', room: 'a' });
    const first = replies.next();
    chunk(1, 'a');
    await expect(first).resolves.toEqual({
      done: false,
      value: { type: 'chunk', id: 1, text: 'a' }
    });
    expect(onMessage).toHaveBeenCalledOnce();
  });

  it('throws an error reply after the replies before it', async () => {
    const { client, rpc } = setup(STREAM);
    client.connect();
    MockWebSocket.last.open();
    const replies = rpc.stream({ type: 'join', room: 'a' });
    chunk(1, 'a');
    reply({ type: 'reply', id: 1, error: 'overloaded' });
    await expect(replies.next()).resolves.toMatchObject({ value: { text: 'a' } });
    await expect(replies.next()).rejects.toThrow('overloaded');
    await expect(replies.next()).resolves.toEqual(ended);
    expect(sent()).toEqual([join('a', 1)]);
  });

  it('times out between replies, not overall, and sends cancel', async () => {
    const { client, rpc } = setup({ ...STREAM, timeout: 1000 });
    client.connect();
    MockWebSocket.last.open();
    const replies = rpc.stream({ type: 'join', room: 'a' });
    vi.advanceTimersByTime(900);
    chunk(1, 'a');
    vi.advanceTimersByTime(900);
    chunk(1, 'b');
    vi.advanceTimersByTime(999);
    expect(rpc.pending()).toBe(1);
    vi.advanceTimersByTime(1);
    expect(rpc.pending()).toBe(0);
    expect(sent()).toEqual([join('a', 1), cancel(1)]);
    await expect(replies.next()).resolves.toMatchObject({ value: { text: 'a' } });
    await expect(replies.next()).resolves.toMatchObject({ value: { text: 'b' } });
    await expect(replies.next()).rejects.toMatchObject({ name: 'TimeoutError' });
  });

  it('throws the abort reason right away, drops buffered replies and sends cancel', async () => {
    const { client, rpc } = setup(STREAM);
    client.connect();
    MockWebSocket.last.open();
    const controller = new AbortController();
    const replies = rpc.stream({ type: 'join', room: 'a' }, { signal: controller.signal });
    chunk(1, 'a');
    controller.abort(new Error('stop'));
    expect(sent()).toEqual([join('a', 1), cancel(1)]);
    await expect(replies.next()).rejects.toThrow('stop');
    await expect(replies.next()).resolves.toEqual(ended);

    const already = rpc.stream(
      { type: 'join', room: 'b' },
      { signal: AbortSignal.abort('already') }
    );
    await expect(already.next()).rejects.toBe('already');
    expect(sent()).toHaveLength(2); // never sent
  });

  it('sends cancel when a loop exits early, but not after the last reply', async () => {
    const { client, rpc } = setup(STREAM);
    client.connect();
    MockWebSocket.last.open();

    const early = rpc.stream({ type: 'join', room: 'a' });
    chunk(1, 'a');
    for await (const _ of early) break;
    expect(sent()).toEqual([join('a', 1), cancel(1)]);
    expect(rpc.pending()).toBe(0);

    const finished = rpc.stream({ type: 'join', room: 'b' });
    reply({ type: 'reply', id: 2 });
    for await (const _ of finished) break;
    expect(sent()).toEqual([join('a', 1), cancel(1), join('b', 2)]);
  });

  it('return() cancels at once, before the first read and during one', async () => {
    const { client, rpc } = setup(STREAM);
    const unread = rpc.stream({ type: 'join', room: 'a' });
    expect(client.getSnapshot().status).toBe('connecting'); // the stream holds the connection
    MockWebSocket.last.open();
    await expect(unread.return!()).resolves.toEqual(ended);
    expect(sent()).toEqual([join('a', 1), cancel(1)]);
    act(() => vi.advanceTimersByTime(0));
    expect(client.getSnapshot().status).toBe('idle'); // and lets go of it

    client.connect();
    MockWebSocket.last.open();
    const reading = rpc.stream({ type: 'join', room: 'b' });
    const read = reading.next();
    const closing = reading.return!();
    expect(sent()).toEqual([join('b', 2), cancel(2)]);
    await expect(read).resolves.toEqual(ended);
    await expect(closing).resolves.toEqual(ended);
  });

  it('throws without cancel when its connection is lost, reconnected or closed', async () => {
    const { client, rpc } = setup(STREAM);
    client.connect();
    MockWebSocket.last.open();

    const lost = rpc.stream({ type: 'join', room: 'a' });
    chunk(1, 'a');
    MockWebSocket.last.finishClose(1006);
    await expect(lost.next()).resolves.toMatchObject({ value: { text: 'a' } });
    await expect(lost.next()).rejects.toThrow('connection was lost');

    vi.advanceTimersByTime(1000);
    MockWebSocket.last.open();
    const reconnected = rpc.stream({ type: 'join', room: 'b' });
    client.reconnect();
    await expect(reconnected.next()).rejects.toThrow('connection was lost');

    MockWebSocket.last.open();
    const closed = rpc.stream({ type: 'join', room: 'c' });
    client.close();
    await expect(closed.next()).rejects.toThrow('closed');

    expect(sentEverywhere().filter(message => message.type === 'cancel')).toEqual([]);
  });

  it('throws like request() rejects when it cannot be sent', async () => {
    const { client, rpc } = setup(STREAM);
    client.connect();
    const volatile = rpc.stream({ type: 'join', room: 'a' }, { volatile: true });
    await expect(volatile.next()).rejects.toThrow('not open');
    MockWebSocket.last.open();
    MockWebSocket.last.bufferedAmount = 100;
    const congested = rpc.stream({ type: 'join', room: 'b' }, { maxBuffered: 10 });
    await expect(congested.next()).rejects.toThrow('buffer is full');
    client.close();
    const closed = rpc.stream({ type: 'join', room: 'c' });
    await expect(closed.next()).rejects.toThrow('WebSocket is closed');
    expect(sentEverywhere()).toEqual([]);
  });

  it('dispose() throws in every stream and sends cancel', async () => {
    const { client, rpc } = setup(STREAM);
    client.connect();
    MockWebSocket.last.open();
    const replies = rpc.stream({ type: 'join', room: 'a' });
    rpc.dispose();
    expect(sent()).toEqual([join('a', 1), cancel(1)]);
    await expect(replies.next()).rejects.toThrow('disposed');
  });

  it('throws what the send builder throws', async () => {
    const { client, rpc } = setup(STREAM);
    const failing = createWebSocketRequests(client, {
      send: (_: Request): Out => {
        throw new Error('cannot build');
      },
      reply: () => undefined,
      ...STREAM
    });
    client.connect();
    await expect(failing.stream({ type: 'join', room: 'a' }).next()).rejects.toThrow(
      'cannot build'
    );
    await expect(failing.request({ type: 'join', room: 'a' })).rejects.toThrow('cannot build');
    expect(failing.pending()).toBe(0);
    rpc.dispose();
  });

  it('needs the done option', () => {
    const { rpc } = setup();
    expect(() => rpc.stream({ type: 'join', room: 'a' })).toThrow(TypeError);
    expect(rpc.pending()).toBe(0);
  });

  it('keeps a failure for the next read instead of rejecting unobserved', async () => {
    const { client, rpc } = setup(STREAM);
    client.connect();
    MockWebSocket.last.open();
    const replies = rpc.stream({ type: 'join', room: 'a' });
    MockWebSocket.last.finishClose(1006);
    // An unhandled rejection here would fail the run.
    await vi.advanceTimersByTimeAsync(0);
    await expect(replies.next()).rejects.toThrow('connection was lost');
  });
});

describe('useWebSocketStream', () => {
  type Rpc = WebSocketRequests<Request, In>;
  type Answer = UseWebSocketStreamResult<Request, string>;
  const text = (value: string, message: In) =>
    value + (message.type === 'chunk' ? message.text : '');

  function renderAnswer(rpc: Rpc | null, batch?: 'frame') {
    // What each render returned, latest last.
    const results: Answer[] = [];
    function View({ rpc }: { rpc: Rpc | null }) {
      const result = useWebSocketStream(rpc, { initial: '', reduce: text, batch });
      results.push(result);
      return <p>{result.value}</p>;
    }
    const view = render(<View rpc={rpc} />);
    const rerender = (next: Rpc | null) => view.rerender(<View rpc={next} />);
    const answer = {
      get current() {
        return results.at(-1)!;
      }
    };
    return { answer, results, view, rerender };
  }

  const start = (answer: { current: Answer }, room = 'a') =>
    act(async () => answer.current.start({ type: 'join', room }));
  const receive = (send: () => void) => act(async () => send());

  it('streams replies into the value and holds the connection while mounted', async () => {
    const { client, rpc } = setup(STREAM);
    const { answer, results, view } = renderAnswer(rpc);
    expect(answer.current.status).toBe('idle');
    expect(client.getSnapshot().status).toBe('connecting');
    act(() => MockWebSocket.last.open());

    await start(answer);
    expect(answer.current.status).toBe('streaming');
    await receive(() => chunk(1, 'Hel'));
    await receive(() => chunk(1, 'lo'));
    expect(view.container.textContent).toBe('Hello');
    await receive(() => reply({ type: 'reply', id: 1 }));
    expect(answer.current).toMatchObject({ status: 'done', value: 'Hello', error: undefined });
    expect(new Set(results.map(result => result.start)).size).toBe(1);
    expect(new Set(results.map(result => result.abort)).size).toBe(1);

    view.unmount();
    act(() => vi.advanceTimersByTime(0));
    expect(client.getSnapshot().status).toBe('idle');
  });

  it('collects the replies without reduce', async () => {
    const { client, rpc } = setup(STREAM);
    client.connect();
    MockWebSocket.last.open();
    const results: UseWebSocketStreamResult<Request, readonly In[]>[] = [];
    function List() {
      results.push(useWebSocketStream(rpc));
      return null;
    }
    render(<List />);
    expect(results.at(-1)!.value).toEqual([]);
    await act(async () => results.at(-1)!.start({ type: 'join', room: 'a' }));
    await receive(() => chunk(1, 'a'));
    await receive(() => reply({ type: 'reply', id: 1 }));
    expect(results.at(-1)!.value).toEqual([
      { type: 'chunk', id: 1, text: 'a' },
      { type: 'reply', id: 1 }
    ]);
    expectTypeOf(results.at(-1)!.value).toEqualTypeOf<readonly In[]>();
  });

  it("renders once per frame with batch: 'frame'", async () => {
    const { rpc } = setup(STREAM);
    const { answer, results, view } = renderAnswer(rpc, 'frame');
    act(() => MockWebSocket.last.open());
    await start(answer);
    const before = results.length;
    await receive(() => chunk(1, 'a'));
    await receive(() => chunk(1, 'b'));
    expect(results.length).toBe(before);
    act(() => vi.advanceTimersToNextFrame());
    expect(results.length).toBe(before + 1);
    expect(view.container.textContent).toBe('ab');

    // The last reply shows right away, and the frame it was waiting for finds nothing to do.
    await receive(() => chunk(1, 'c'));
    await receive(() => reply({ type: 'reply', id: 1 }));
    expect(answer.current).toMatchObject({ status: 'done', value: 'abc' });
    const after = results.length;
    act(() => vi.advanceTimersToNextFrame());
    expect(results.length).toBe(after);
  });

  it('waits about a frame without requestAnimationFrame', async () => {
    vi.stubGlobal('requestAnimationFrame', undefined);
    try {
      const { rpc } = setup(STREAM);
      const { answer, view } = renderAnswer(rpc, 'frame');
      act(() => MockWebSocket.last.open());
      await start(answer);
      await receive(() => chunk(1, 'a'));
      expect(view.container.textContent).toBe('');
      act(() => vi.advanceTimersByTime(16));
      expect(view.container.textContent).toBe('a');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('start() replaces the running stream, cancelling it and ignoring its replies', async () => {
    const { rpc } = setup(STREAM);
    const { answer, view } = renderAnswer(rpc);
    act(() => MockWebSocket.last.open());
    await start(answer, 'a');
    await receive(() => chunk(1, 'old'));
    await act(async () => {
      chunk(1, 'buffered'); // not read yet when the stream is replaced
      answer.current.start({ type: 'join', room: 'b' });
    });
    expect(sent()).toEqual([join('a', 1), cancel(1), join('b', 2)]);
    expect(answer.current).toMatchObject({ status: 'streaming', value: '' });
    await receive(() => chunk(2, 'new'));
    expect(view.container.textContent).toBe('new');
    expect(rpc.pending()).toBe(1);
  });

  it('abort() keeps the value, reports aborted and sends cancel', async () => {
    const { rpc } = setup(STREAM);
    const { answer } = renderAnswer(rpc);
    act(() => MockWebSocket.last.open());
    await start(answer);
    await receive(() => chunk(1, 'part'));
    await act(async () => answer.current.abort());
    expect(answer.current).toMatchObject({ status: 'aborted', value: 'part' });
    expect(sent()).toEqual([join('a', 1), cancel(1)]);
  });

  it('a new rpc and unmounting abort the stream', async () => {
    const { client, rpc } = setup(STREAM);
    const other = createWebSocketRequests(client, {
      send: (message: Request, id) => ({ ...message, id }),
      reply: message => (message.type === 'chat' ? undefined : message.id),
      ...STREAM
    });
    const { answer, rerender, view } = renderAnswer(rpc);
    act(() => MockWebSocket.last.open());
    await start(answer);
    await act(async () => rerender(other));
    expect(answer.current.status).toBe('aborted');
    expect(sent()).toEqual([join('a', 1), cancel(1)]);

    await start(answer, 'b');
    expect(other.pending()).toBe(1);
    await act(async () => view.unmount());
    expect(sent()).toEqual([join('a', 1), cancel(1), join('b', 2), cancel(2)]);
    expect(other.pending()).toBe(0);
  });

  it('reports a failed stream in error', async () => {
    const { rpc } = setup(STREAM);
    const { answer } = renderAnswer(rpc);
    act(() => MockWebSocket.last.open());
    await start(answer);
    await receive(() => reply({ type: 'reply', id: 1, error: 'overloaded' }));
    expect(answer.current.status).toBe('error');
    expect(answer.current.error).toEqual(new Error('overloaded'));

    await start(answer, 'b'); // starting again clears the error
    expect(answer.current).toMatchObject({ status: 'streaming', error: undefined });
    await receive(() => MockWebSocket.last.finishClose(1006));
    expect(answer.current.error).toEqual(
      new Error('WebSocket connection was lost before the request was answered')
    );
  });

  it('holds nothing without an rpc, and start() reports an error', async () => {
    const { answer } = renderAnswer(null);
    await start(answer);
    expect(answer.current.status).toBe('error');
    expect(answer.current.error).toBeInstanceOf(TypeError);
    expect(MockWebSocket.instances).toHaveLength(0);
  });

  it('leaves one live stream when StrictMode re-runs an effect that starts it', async () => {
    const { client, rpc } = setup(STREAM);
    function Auto() {
      const { start, value } = useWebSocketStream(rpc, { initial: '', reduce: text });
      useEffect(() => start({ type: 'join', room: 'a' }), [start]);
      return <p>{value}</p>;
    }
    const view = render(
      <StrictMode>
        <Auto />
      </StrictMode>
    );
    await act(async () => MockWebSocket.last.open());
    expect(rpc.pending()).toBe(1);
    expect(sent()).toEqual([join('a', 1), cancel(1), join('a', 2)]);
    await receive(() => chunk(2, 'live'));
    expect(view.container.textContent).toBe('live');
    expect(client.getSnapshot().status).toBe('open');
  });
});

describe('types', () => {
  it('takes In and Out from the client and Req from the send annotation', () => {
    const { rpc, client } = setup();
    expectTypeOf(rpc.request).parameter(0).toEqualTypeOf<Request>();
    expectTypeOf(rpc.request).returns.toEqualTypeOf<Promise<In>>();
    expectTypeOf(rpc.stream).parameter(0).toEqualTypeOf<Request>();
    expectTypeOf(rpc.stream).returns.toEqualTypeOf<AsyncIterableIterator<In>>();
    expectTypeOf(client.send).parameter(1).toEqualTypeOf<SendOptions | undefined>();
    rpc.dispose();
  });
});
