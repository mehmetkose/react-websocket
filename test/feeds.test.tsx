import { act, render } from '@testing-library/react';
import {
  createWebSocket,
  createWebSocketFeeds,
  createWebSocketState,
  useWebSocketState,
  useWebSocketTopic
} from '../src';
import type { StandardSchemaV1 } from '../src/core';
import { DatagramImpl, DatagramMockWebSocket, MockImpl, MockWebSocket } from './mock';

type In =
  | { type: 'event'; topic: string; seq: number; text: string }
  | { type: 'snapshot'; topic: string; seq: number; texts: string[] }
  | { type: 'pong' };
type Out =
  | { type: 'subscribe'; topic: string; after?: number }
  | { type: 'unsubscribe'; topic: string }
  | { type: 'resume'; topic: string; after: number };

let n = 0;

function setup(extra: { resume?: boolean; onGap?: () => void } = {}) {
  const client = createWebSocket<In, Out>(`ws://feeds/${++n}`, {
    WebSocket: MockImpl,
    json: true,
    reconnect: { jitter: 0, minDelay: 1000 }
  });
  const feeds = createWebSocketFeeds(client, {
    subscribe: (topic, after) => ({ type: 'subscribe', topic, after }),
    unsubscribe: topic => ({ type: 'unsubscribe', topic }),
    resume: extra.resume ? (topic, after) => ({ type: 'resume', topic, after }) : undefined,
    sequence: message => (message.type === 'event' ? message : undefined),
    snapshot: message => (message.type === 'snapshot' ? message : undefined),
    onGap: extra.onGap
  });
  const received: string[] = [];
  feeds.on('message', message => {
    if (message.type === 'event') received.push(message.text);
    if (message.type === 'snapshot') received.push(`snapshot:${message.texts.join('')}`);
    if (message.type === 'pong') received.push('pong');
  });
  return { client, feeds, received };
}

const event = (seq: number, text = String(seq), topic = 'room') =>
  MockWebSocket.last.receive(JSON.stringify({ type: 'event', topic, seq, text }));
const sent = (socket = MockWebSocket.last) => socket.sent.map(data => JSON.parse(data as string));

beforeEach(() => {
  MockWebSocket.reset();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('createWebSocketFeeds', () => {
  it('delivers each numbered message once, in order', () => {
    const { feeds, received } = setup();
    feeds.acquire('room');
    MockWebSocket.last.open();
    expect(sent()).toEqual([{ type: 'subscribe', topic: 'room' }]);
    event(1);
    event(2);
    event(2); // a duplicate
    event(1);
    event(3);
    expect(received).toEqual(['1', '2', '3']);
    expect(feeds.position('room')).toBe(3);
  });

  it('subscribes again after the last number on every new connection, and drops what it replays twice', () => {
    const { feeds, received } = setup();
    feeds.acquire('room');
    MockWebSocket.last.open();
    event(1);
    event(2);
    MockWebSocket.last.finishClose(1006);
    vi.advanceTimersByTime(1000);
    MockWebSocket.last.open();
    expect(sent()).toEqual([{ type: 'subscribe', topic: 'room', after: 2 }]);
    // A server replaying from further back: only the new ones get through.
    for (const seq of [1, 2, 3, 4]) event(seq);
    expect(received).toEqual(['1', '2', '3', '4']);
  });

  it('holds back a message after a gap and asks once for what is missing', () => {
    const onGap = vi.fn();
    const { feeds, received } = setup({ onGap });
    feeds.acquire('room');
    MockWebSocket.last.open();
    event(1);
    event(3);
    event(4);
    expect(received).toEqual(['1']);
    expect(onGap).toHaveBeenCalledOnce();
    expect(onGap).toHaveBeenCalledWith('room', 1, 3);
    expect(sent()).toEqual([
      { type: 'subscribe', topic: 'room' },
      { type: 'subscribe', topic: 'room', after: 1 }
    ]);

    // The server resends from 2; the live stream goes on.
    for (const seq of [2, 3, 4, 5]) event(seq);
    expect(received).toEqual(['1', '2', '3', '4', '5']);
    // A later gap asks again.
    event(7);
    expect(onGap).toHaveBeenCalledTimes(2);
  });

  it("asks for what's missing on the socket's reliable stream, not as a datagram", () => {
    const client = createWebSocket<In, Out>(`ws://feeds/${++n}`, {
      WebSocket: DatagramImpl,
      json: true
    });
    const feeds = createWebSocketFeeds(client, {
      subscribe: (topic, after) => ({ type: 'subscribe', topic, after }),
      sequence: message => (message.type === 'event' ? message : undefined)
    });
    feeds.acquire('room');
    MockWebSocket.last.open();
    event(1);
    event(3);
    expect(sent().at(-1)).toEqual({ type: 'subscribe', topic: 'room', after: 1 });
    expect((MockWebSocket.last as DatagramMockWebSocket).datagrams).toEqual([]);
  });

  it('uses resume for missing messages when given', () => {
    const { feeds } = setup({ resume: true });
    feeds.acquire('room');
    MockWebSocket.last.open();
    event(1);
    event(5);
    expect(sent().at(-1)).toEqual({ type: 'resume', topic: 'room', after: 1 });
  });

  it('asks again on a new connection after a gap', () => {
    const { feeds } = setup();
    feeds.acquire('room');
    MockWebSocket.last.open();
    event(1);
    event(3);
    MockWebSocket.last.finishClose(1006);
    vi.advanceTimersByTime(1000);
    MockWebSocket.last.open();
    expect(sent()).toEqual([{ type: 'subscribe', topic: 'room', after: 1 }]);
    event(4);
    expect(sent()).toHaveLength(2);
  });

  it('delivers a snapshot and goes on numbering from it', () => {
    const { feeds, received } = setup();
    feeds.acquire('room');
    MockWebSocket.last.open();
    event(1);
    event(9);
    MockWebSocket.last.receive(
      JSON.stringify({ type: 'snapshot', topic: 'room', seq: 10, texts: ['a', 'b'] })
    );
    event(10);
    event(11);
    expect(received).toEqual(['1', 'snapshot:ab', '11']);
    expect(feeds.position('room')).toBe(11);
  });

  it('passes other messages through, and counts only topics it holds', () => {
    const { feeds, received } = setup();
    feeds.acquire('room');
    MockWebSocket.last.open();
    MockWebSocket.last.receive(JSON.stringify({ type: 'pong' }));
    event(5, 'elsewhere', 'other');
    event(9, 'elsewhere again', 'other');
    expect(received).toEqual(['pong', 'elsewhere', 'elsewhere again']);
    expect(feeds.position('other')).toBeUndefined();
  });

  it('forgets a topic once nothing holds it', () => {
    const { client, feeds } = setup();
    client.connect(); // stays open without the topic
    const release = feeds.acquire('room');
    MockWebSocket.last.open();
    event(1);
    release();
    vi.advanceTimersByTime(0);
    expect(feeds.position('room')).toBeUndefined();
    feeds.acquire('room');
    expect(sent().slice(-2)).toEqual([
      { type: 'unsubscribe', topic: 'room' },
      { type: 'subscribe', topic: 'room' }
    ]);
  });

  it('keeps its place through StrictMode-style release and re-acquire', () => {
    const { feeds } = setup();
    const release = feeds.acquire('room');
    MockWebSocket.last.open();
    event(1);
    release();
    feeds.acquire('room');
    vi.advanceTimersByTime(0);
    expect(feeds.position('room')).toBe(1);
  });

  it('keeps delivering when a listener throws, and stops a listener that unsubscribes', () => {
    const thrown: unknown[] = [];
    vi.spyOn(globalThis, 'queueMicrotask').mockImplementation(callback => {
      try {
        callback();
      } catch (error) {
        thrown.push(error);
      }
    });
    const { feeds, received } = setup();
    const off = feeds.on('message', () => {
      throw new Error('listener failed');
    });
    feeds.acquire('room');
    MockWebSocket.last.open();
    event(1);
    off();
    event(2);
    vi.restoreAllMocks();
    expect(received).toEqual(['1', '2']);
    expect(thrown).toEqual([new Error('listener failed')]);
  });

  it('reset() forgets positions, so the next user subscribes from the start', () => {
    const { client, feeds, received } = setup();
    feeds.acquire('room');
    feeds.acquire('other');
    MockWebSocket.last.open();
    event(1);
    event(2);
    event(4, '4', 'other');
    feeds.reset('other');
    expect(feeds.position('other')).toBeUndefined();
    expect(feeds.position('room')).toBe(2);
    feeds.reset();
    expect(feeds.position('room')).toBeUndefined();

    // Logout, and another user signs in.
    client.close();
    client.connect();
    MockWebSocket.last.open();
    expect(sent()).toEqual([
      { type: 'subscribe', topic: 'room' },
      { type: 'subscribe', topic: 'other' }
    ]);
    event(1, 'next user 1');
    expect(received).toEqual(['1', '2', '4', 'next user 1']);
  });

  it('stops after dispose()', () => {
    const { feeds, received } = setup();
    feeds.acquire('room');
    MockWebSocket.last.open();
    feeds.dispose();
    event(1);
    expect(received).toEqual([]);
  });

  it('feeds a state store and the hooks', () => {
    const { client, feeds } = setup();
    const chat = createWebSocketState(feeds, {
      initialState: [] as string[],
      reduce: (list, message) =>
        message.type === 'event'
          ? [...list, message.text]
          : message.type === 'snapshot'
            ? message.texts
            : list
    });
    expect(chat.client).toBe(client);

    function Room() {
      useWebSocketTopic(feeds, 'room');
      return <p>{useWebSocketState(chat).join(',')}</p>;
    }
    const { container } = render(<Room />);
    act(() => MockWebSocket.last.open());
    act(() => {
      event(1, 'hi');
      event(1, 'hi');
      event(3, 'skipped ahead');
      event(2, 'there');
      event(3, 'again');
    });
    expect(container.textContent).toBe('hi,there,again');
  });
});

// Transitions that meet another one under way: a resume, a release or a `migrate()` switch.
describe('transitions under way', () => {
  const receive = (socket: MockWebSocket, seq: number) =>
    socket.receive(JSON.stringify({ type: 'event', topic: 'room', seq, text: String(seq) }));

  it('counts afresh after reset() with a resume in flight, and asks again at the next gap', () => {
    const { feeds, received } = setup({ resume: true });
    feeds.acquire('room');
    MockWebSocket.last.open();
    event(1);
    event(3); // asks for 2
    feeds.reset('room');
    event(2); // the answer, counted from the start
    event(3);
    event(5);
    expect(received).toEqual(['1', '2', '3']);
    expect(sent()).toEqual([
      { type: 'subscribe', topic: 'room' },
      { type: 'resume', topic: 'room', after: 1 },
      { type: 'resume', topic: 'room', after: 3 }
    ]);
  });

  it('subscribes from the start after a release with a resume in flight, and asks again at a gap', () => {
    const { client, feeds, received } = setup({ resume: true });
    client.connect(); // something else keeps the connection
    const release = feeds.acquire('room');
    MockWebSocket.last.open();
    event(1);
    event(3); // asks for 2
    release();
    vi.advanceTimersByTime(0);
    feeds.acquire('room');
    event(10);
    event(12);
    expect(received).toEqual(['1', '10']);
    expect(sent()).toEqual([
      { type: 'subscribe', topic: 'room' },
      { type: 'resume', topic: 'room', after: 1 },
      { type: 'unsubscribe', topic: 'room' },
      { type: 'subscribe', topic: 'room' },
      { type: 'resume', topic: 'room', after: 10 }
    ]);
  });

  it("delivers once what the connection migrate() replaced was still validating, and drops the new one's replay", async () => {
    const slow: StandardSchemaV1<unknown, In> = {
      '~standard': {
        version: 1,
        vendor: 'test',
        validate: value =>
          new Promise(resolve => setTimeout(() => resolve({ value: value as In }), 10))
      }
    };
    const client = createWebSocket<In, Out>(`ws://feeds/${++n}`, {
      WebSocket: MockImpl,
      json: true,
      schema: slow
    });
    const feeds = createWebSocketFeeds(client, {
      subscribe: (topic, after) => ({ type: 'subscribe', topic, after }),
      sequence: message => (message.type === 'event' ? message : undefined)
    });
    const received: string[] = [];
    feeds.on('message', message => {
      if (message.type === 'event') received.push(message.text);
    });
    feeds.acquire('room');
    client.connect();
    const first = MockWebSocket.last;
    first.open();
    receive(first, 1);
    await vi.advanceTimersByTimeAsync(10);
    client.migrate();
    vi.advanceTimersByTime(0);
    const second = MockWebSocket.last;
    receive(first, 2); // before the switch, still validating after it
    second.open(); // subscribes after 1, the last one delivered
    receive(second, 2); // so the server sends 2 again
    receive(second, 3);
    await vi.advanceTimersByTimeAsync(100);
    expect(received).toEqual(['1', '2', '3']);
    expect(sent(second)).toEqual([{ type: 'subscribe', topic: 'room', after: 1 }]);
    expect(feeds.position('room')).toBe(3);
  });

  it("doesn't ask for missing messages on a connection that isn't open", () => {
    const { client, feeds, received } = setup({ resume: true });
    feeds.acquire('room');
    MockWebSocket.last.open();
    event(1);
    const socket = MockWebSocket.last;
    client.close();
    receive(socket, 3); // arrives as it closes: not delivered, so nothing to ask for
    expect(received).toEqual(['1']);
    expect(sent(socket)).toEqual([{ type: 'subscribe', topic: 'room' }]);
  });
});
