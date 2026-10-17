import { createChaosWebSocket } from '../src/chaos';
import {
  createWebSocket,
  createWebSocketSendRate,
  type Latency,
  type WebSocketSendRateOptions
} from '../src/core';
import { MockImpl, MockWebSocket } from './mock';

type Out = { type: 'aim'; angle: number } | { type: 'pos'; x: number } | { type: 'chat' };

let n = 0;

function setup(options?: WebSocketSendRateOptions) {
  const client = createWebSocket<unknown, Out>(`ws://rate/${++n}`, {
    WebSocket: MockImpl,
    json: true,
    reconnect: { jitter: 0, minDelay: 1000 }
  });
  const stream = createWebSocketSendRate(client, options);
  return { client, stream };
}

function connected(options?: WebSocketSendRateOptions) {
  const result = setup(options);
  result.client.connect();
  MockWebSocket.last.open();
  return result;
}

const aim = (angle: number): Out => ({ type: 'aim', angle });
const sent = (socket = MockWebSocket.last) => socket.sent.map(data => JSON.parse(data as string));

/** Send aim every 10 ms for `ms`, as a game loop would. */
function play(stream: { send(message: Out, key: string): void }, ms: number) {
  for (let t = 0; t < ms; t += 10) {
    stream.send(aim(t), 'aim');
    vi.advanceTimersByTime(10);
  }
}

beforeEach(() => {
  MockWebSocket.reset();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('createWebSocketSendRate', () => {
  it('sends the newest message per key at the next tick', () => {
    const { stream } = connected();
    stream.send(aim(1), 'aim');
    stream.send({ type: 'pos', x: 1 }, 'pos');
    stream.send(aim(2), 'aim');
    expect(sent()).toEqual([]);
    vi.advanceTimersByTime(0); // the first send after a pause goes out right away
    expect(sent()).toEqual([{ type: 'pos', x: 1 }, aim(2)]);
  });

  it('ticks at most maxRate times a second', () => {
    const { stream } = connected({ maxRate: 25 });
    stream.send(aim(1), 'aim');
    vi.advanceTimersByTime(0);
    stream.send(aim(2), 'aim');
    vi.advanceTimersByTime(39);
    expect(sent()).toEqual([aim(1)]);
    vi.advanceTimersByTime(1);
    expect(sent()).toEqual([aim(1), aim(2)]);
  });

  it('waits for open, then sends after open listeners and the client queue', () => {
    const { client, stream } = setup();
    client.on('open', () => client.send({ type: 'chat' }));
    client.connect();
    client.send({ type: 'pos', x: 0 });
    stream.send(aim(1), 'aim');
    vi.advanceTimersByTime(100);
    expect(MockWebSocket.last.sent).toEqual([]);
    MockWebSocket.last.open();
    vi.advanceTimersByTime(0);
    expect(sent()).toEqual([{ type: 'chat' }, { type: 'pos', x: 0 }, aim(1)]);
  });

  it('keeps the newest per key through a reconnect, and drops them on close()', () => {
    const { client, stream } = connected();
    MockWebSocket.last.finishClose();
    stream.send(aim(1), 'aim');
    stream.send(aim(2), 'aim');
    stream.flush(); // can't send yet: kept
    vi.advanceTimersByTime(1000);
    MockWebSocket.last.open();
    vi.advanceTimersByTime(0);
    expect(sent()).toEqual([aim(2)]); // once, and never through the client's queue

    stream.send(aim(3), 'aim');
    client.close();
    client.connect();
    MockWebSocket.last.open();
    vi.advanceTimersByTime(100);
    expect(sent()).toEqual([]);
  });

  it('halves the rate while the send buffer is full, and climbs back when it drains', () => {
    const { stream } = connected({ maxBuffered: 1000 });
    MockWebSocket.last.bufferedAmount = 1001;
    stream.send(aim(1), 'aim');
    vi.advanceTimersByTime(0);
    expect(stream.getSnapshot()).toEqual({ rate: 15, congested: true });
    expect(sent()).toEqual([]); // held back, still the newest

    play(stream, 1000);
    expect(stream.getSnapshot()).toEqual({ rate: 5, congested: true }); // minRate

    MockWebSocket.last.bufferedAmount = 0;
    play(stream, 200);
    expect(sent()).toHaveLength(1); // the newest aim, once the buffer drained
    expect(stream.getSnapshot()).toEqual({ rate: 6, congested: false });
    play(stream, 2000);
    expect(stream.getSnapshot()).toEqual({ rate: 30, congested: false });
  });

  it('keeps minRate at or below maxRate', () => {
    const { stream } = connected({ maxRate: 3, minRate: 10 });
    MockWebSocket.last.bufferedAmount = 10_000;
    play(stream, 2000);
    expect(stream.getSnapshot()).toEqual({ rate: 3, congested: true });
  });

  it('halves the rate once per measurement while the round trip has risen', () => {
    let measurement: Latency = { rtt: undefined, offset: undefined };
    const { stream } = connected({ latency: { getSnapshot: () => measurement } });
    measurement = { rtt: 50, offset: undefined };
    play(stream, 100);
    expect(stream.getSnapshot()).toEqual({ rate: 30, congested: false });

    measurement = { rtt: 200, offset: undefined }; // 150 ms above the best
    play(stream, 50);
    expect(stream.getSnapshot()).toEqual({ rate: 15, congested: true });
    play(stream, 1000);
    expect(stream.getSnapshot()).toEqual({ rate: 15, congested: true }); // and stops climbing

    measurement = { rtt: 120, offset: undefined }; // within 100 ms of the best again
    play(stream, 2000);
    expect(stream.getSnapshot()).toEqual({ rate: 30, congested: false });
  });

  it('measures the best round trip afresh on each connection', () => {
    let measurement: Latency = { rtt: undefined, offset: undefined };
    const { stream } = connected({ latency: { getSnapshot: () => measurement } });
    measurement = { rtt: 50, offset: undefined };
    play(stream, 100);
    MockWebSocket.last.finishClose();
    vi.advanceTimersByTime(1000);
    MockWebSocket.last.open();
    measurement = { rtt: 300, offset: undefined }; // a slower route, but steady
    play(stream, 500);
    expect(stream.getSnapshot()).toEqual({ rate: 30, congested: false });
  });

  it('notifies only when the rate or congestion changes', () => {
    const { stream } = connected();
    const listener = vi.fn();
    const off = stream.subscribe(listener);
    const before = stream.getSnapshot();
    play(stream, 500);
    expect(stream.getSnapshot()).toBe(before);
    expect(listener).not.toHaveBeenCalled();

    MockWebSocket.last.bufferedAmount = 10_000;
    play(stream, 40);
    expect(listener).toHaveBeenCalledTimes(1);
    off();
    play(stream, 1000);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('flush() sends everything waiting now', () => {
    const { stream } = connected();
    stream.send(aim(1), 'aim');
    stream.flush();
    expect(sent()).toEqual([aim(1)]);
    vi.advanceTimersByTime(100);
    expect(sent()).toEqual([aim(1)]);
  });

  it('runs no timers while not open or after dispose()', () => {
    const { client, stream } = setup();
    stream.send(aim(1), 'aim');
    expect(vi.getTimerCount()).toBe(0);
    client.connect();
    MockWebSocket.last.open();
    expect(vi.getTimerCount()).toBe(1);
    stream.dispose();
    expect(vi.getTimerCount()).toBe(0);
    stream.send(aim(2), 'aim');
    vi.advanceTimersByTime(100);
    expect(sent()).toEqual([]);
  });

  it("doesn't open the connection by itself", () => {
    const { stream } = setup();
    stream.send(aim(1), 'aim');
    expect(MockWebSocket.instances).toHaveLength(0);
  });

  it('slows down on a slow link and recovers when it clears', () => {
    const Chaos = createChaosWebSocket({ WebSocket: MockImpl, latency: 200 });
    const client = createWebSocket<unknown, string>('ws://chaos', { WebSocket: Chaos });
    const stream = createWebSocketSendRate(client, { maxBuffered: 1000 });
    client.connect();
    MockWebSocket.last.open();
    vi.advanceTimersByTime(200);
    const pump = (ms: number) => {
      for (let t = 0; t < ms; t += 10) {
        stream.send('x'.repeat(300), 'pos');
        vi.advanceTimersByTime(10);
      }
    };
    pump(1000);
    expect(stream.getSnapshot().rate).toBeLessThan(30);

    Chaos.configure({ latency: 0 });
    pump(3000);
    expect(stream.getSnapshot()).toEqual({ rate: 30, congested: false });
  });

  it('accepts only what the client sends', () => {
    const { stream } = setup();
    expectTypeOf(stream.send).parameter(0).toEqualTypeOf<Out>();
    // @ts-expect-error not a message this client sends
    stream.send({ type: 'fire' }, 'fire');
  });
});
