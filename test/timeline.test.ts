import { createWebSocket, createWebSocketLatency } from '../src/core';
import {
  createWebSocketTimeline,
  type WebSocketTimeline,
  type WebSocketTimelineOptions
} from '../src/timeline';
import { MockImpl, MockWebSocket } from './mock';

type World = { x: number };
type Move = { dx: number };
type In =
  | { type: 'snapshot'; time: number; x: number; ack?: number }
  | { type: 'pong'; id: number; time?: number }
  | { type: 'chat' };
type Out = { type: 'input'; seq: number; dx: number } | { type: 'ping'; id: number };

let n = 0;

function client() {
  return createWebSocket<In, Out>(`ws://timeline/${++n}`, {
    WebSocket: MockImpl,
    json: true,
    reconnect: { jitter: 0, minDelay: 1000 }
  });
}

function setup(extra: Partial<WebSocketTimelineOptions<World, Move, In, Out>> = {}) {
  const game = client();
  const interpolate = vi.fn((from: World, to: World, t: number) => ({
    x: from.x + (to.x - from.x) * t
  }));
  const predict = vi.fn((state: World, input: Move) => ({ x: state.x + input.dx }));
  const timeline = createWebSocketTimeline(game, {
    snapshot: m =>
      m.type === 'snapshot' ? { time: m.time, ack: m.ack, state: { x: m.x } } : undefined,
    interpolate,
    input: { send: (input: Move, seq) => ({ type: 'input', seq, ...input }), predict },
    ...extra
  });
  return { game, timeline, interpolate, predict };
}

function connected(extra?: Parameters<typeof setup>[0]) {
  const result = setup(extra);
  result.game.connect();
  MockWebSocket.last.open();
  return result;
}

const snap = (time: number, x: number, ack?: number) =>
  MockWebSocket.last.receive(JSON.stringify({ type: 'snapshot', time, x, ack }));
const sent = (socket = MockWebSocket.last) => socket.sent.map(data => JSON.parse(data as string));

beforeEach(() => {
  MockWebSocket.reset();
  vi.useFakeTimers({ now: 1_000_000 });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('sampling', () => {
  it('has nothing before the first snapshot', () => {
    const { timeline } = connected();
    expect(timeline.at()).toBeUndefined();
    expect(timeline.at(1000)).toBeUndefined();
    expect(timeline.latest()).toBeUndefined();
    expect(timeline.predicted()).toBeUndefined();
    expect(timeline.renderTime()).toBeUndefined();
  });

  it('interpolates between the snapshots around a time', () => {
    const { timeline, interpolate } = connected();
    snap(1000, 0);
    snap(1100, 10);
    snap(1200, 30);
    expect(timeline.at(1050)).toEqual({ x: 5 });
    expect(interpolate).toHaveBeenLastCalledWith({ x: 0 }, { x: 10 }, 0.5);
    expect(timeline.at(1175)).toEqual({ x: 25 });
  });

  it('steps without interpolate', () => {
    const { timeline } = connected({ interpolate: undefined });
    snap(1000, 0);
    snap(1100, 10);
    expect(timeline.at(1099)).toEqual({ x: 0 });
    expect(timeline.at(1100)).toEqual({ x: 10 });
  });

  it('returns the snapshot states themselves at, before and after them', () => {
    const { timeline, interpolate } = connected();
    snap(1000, 0);
    snap(1100, 10);
    const newest = timeline.latest()!.state;
    const oldest = timeline.at(1000);
    expect(timeline.at(900)).toBe(oldest);
    expect(timeline.at(1100)).toBe(newest);
    expect(timeline.at(5000)).toBe(newest);
    expect(interpolate).not.toHaveBeenCalled();
  });

  it('extrapolates up to extrapolate ms past the newest snapshot', () => {
    const { timeline } = connected({ extrapolate: 100 });
    snap(1000, 0);
    snap(1100, 10);
    expect(timeline.at(1150)).toEqual({ x: 15 });
    expect(timeline.at(1300)).toEqual({ x: 20 });
  });

  it("holds the newest state when it can't extrapolate", () => {
    const { timeline } = connected({ extrapolate: 100, interpolate: undefined });
    snap(1000, 0);
    expect(timeline.at(1050)).toEqual({ x: 0 }); // one snapshot
    snap(1100, 10);
    expect(timeline.at(1150)).toEqual({ x: 10 }); // no interpolate
  });

  it('keeps the newest buffer snapshots, at least 2', () => {
    const { timeline } = connected({ buffer: 3 });
    for (let i = 0; i < 5; i++) snap(1000 + i * 100, i);
    expect(timeline.at(0)).toEqual({ x: 2 });

    const two = connected({ buffer: 1 }).timeline;
    snap(1000, 0);
    snap(1100, 10);
    expect(two.at(1050)).toEqual({ x: 5 });
  });

  it('ignores duplicate and older snapshots, ack included, and other messages', () => {
    const { timeline } = connected();
    const listener = vi.fn();
    timeline.subscribe(listener);
    snap(1000, 0);
    timeline.input({ dx: 1 });
    timeline.input({ dx: 1 });
    snap(1000, 5, 2);
    snap(900, 5, 2);
    MockWebSocket.last.receive(JSON.stringify({ type: 'chat' }));
    expect(timeline.latest()).toEqual({ time: 1000, state: { x: 0 } });
    expect(timeline.pending()).toBe(2);
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

describe('render time', () => {
  it('is estimated from when snapshots arrive, whatever the server clock says', () => {
    const { timeline } = connected();
    snap(5000, 0);
    vi.advanceTimersByTime(30);
    expect(timeline.renderTime()).toBe(4930); // 5000 + 30 - delay
  });

  it('trusts the least delayed snapshot', () => {
    const { timeline } = connected();
    snap(1000, 0);
    vi.advanceTimersByTime(80);
    snap(1050, 5); // 30 ms later than the first one's pace
    expect(timeline.renderTime()).toBe(980);
  });

  it('follows the server clock from latency, half a round trip behind', () => {
    const game = client();
    const latency = createWebSocketLatency(game, {
      ping: id => ({ type: 'ping', id }),
      pong: m => (m.type === 'pong' ? { id: m.id, time: m.time } : undefined)
    });
    const timeline = createWebSocketTimeline(game, {
      snapshot: m => (m.type === 'snapshot' ? { time: m.time, state: m.x } : undefined),
      latency
    });
    game.connect();
    MockWebSocket.last.open(); // pings
    snap(5000, 0);
    expect(timeline.renderTime()).toBe(4900); // no clock estimate yet: from arrivals

    vi.advanceTimersByTime(100);
    MockWebSocket.last.receive(JSON.stringify({ type: 'pong', id: 1, time: Date.now() + 9950 }));
    expect(latency.getSnapshot()).toEqual({ rtt: 100, offset: 10_000 });
    expect(timeline.renderTime()).toBe(Date.now() + 10_000 - 50 - 100);
  });

  it('reads a delay function on every call, and never goes backward', () => {
    let delay = 100;
    const { timeline } = connected({ delay: () => delay });
    snap(5000, 0);
    expect(timeline.renderTime()).toBe(4900);
    delay = 200;
    expect(timeline.renderTime()).toBe(4900);
    vi.advanceTimersByTime(150);
    expect(timeline.renderTime()).toBe(4950);
  });

  it('is what at() renders by default', () => {
    const { timeline } = connected();
    snap(1000, 0);
    vi.advanceTimersByTime(100);
    snap(1100, 10);
    vi.advanceTimersByTime(50);
    expect(timeline.at()).toEqual({ x: 5 }); // at 1050
  });
});

describe('prediction', () => {
  it('sends inputs tagged with a sequence number and predicts them', () => {
    const { timeline } = connected();
    expect(timeline.input({ dx: 1 })).toBe(1);
    expect(timeline.input({ dx: 2 })).toBe(2);
    expect(sent()).toEqual([
      { type: 'input', seq: 1, dx: 1 },
      { type: 'input', seq: 2, dx: 2 }
    ]);
    expect(timeline.predicted()).toBeUndefined(); // nothing to predict from yet
    snap(1000, 10);
    expect(timeline.predicted()).toEqual({ x: 13 });
  });

  it('replays only the inputs the server has not applied yet', () => {
    const { timeline, predict } = connected();
    timeline.input({ dx: 1 });
    timeline.input({ dx: 2 });
    timeline.input({ dx: 3 });
    snap(1000, 10, 2);
    expect(timeline.pending()).toBe(1);
    predict.mockClear();
    expect(timeline.predicted()).toEqual({ x: 13 });
    expect(timeline.predicted()).toEqual({ x: 13 });
    expect(predict).toHaveBeenCalledTimes(1); // cached

    timeline.input({ dx: 4 });
    expect(timeline.predicted()).toEqual({ x: 17 });
    expect(predict).toHaveBeenCalledTimes(2); // only the new input

    snap(1050, 20, 3);
    expect(timeline.predicted()).toEqual({ x: 24 });
  });

  it('keeps pending inputs when a snapshot has no ack', () => {
    const { timeline } = connected();
    timeline.input({ dx: 1 });
    timeline.input({ dx: 1 });
    snap(1000, 0, 1);
    snap(1050, 0);
    expect(timeline.pending()).toBe(1);
    snap(1100, 0, 0);
    expect(timeline.pending()).toBe(1);
  });

  it("doesn't send or predict inputs while not open", () => {
    const { game, timeline } = setup();
    game.connect();
    expect(timeline.input({ dx: 1 })).toBeUndefined();
    expect(timeline.pending()).toBe(0);
    MockWebSocket.last.open();
    expect(sent()).toEqual([]); // never queued
    expect(timeline.input({ dx: 1 })).toBe(1); // the dropped input didn't use a number
  });

  it("doesn't predict an input dropped by maxBuffered", () => {
    const { timeline } = connected({
      input: {
        send: (input: Move, seq) => ({ type: 'input', seq, ...input }),
        predict: (state, input) => ({ x: state.x + input.dx }),
        maxBuffered: 100
      }
    });
    snap(1000, 0);
    MockWebSocket.last.bufferedAmount = 101;
    expect(timeline.input({ dx: 1 })).toBeUndefined();
    MockWebSocket.last.bufferedAmount = 100;
    expect(timeline.input({ dx: 2 })).toBe(1);
    expect(timeline.predicted()).toEqual({ x: 2 });
  });

  it('keeps at most 1000 unconfirmed inputs', () => {
    const { timeline } = connected();
    for (let i = 0; i < 1001; i++) timeline.input({ dx: 1 });
    expect(timeline.pending()).toBe(1000);
    snap(1000, 0);
    expect(timeline.predicted()).toEqual({ x: 1000 });
  });
});

describe('lifecycle', () => {
  it('starts over on reconnect, showing the old snapshots until a new one arrives', () => {
    const { timeline } = connected();
    timeline.input({ dx: 1 });
    timeline.input({ dx: 1 });
    snap(5000, 10);
    expect(timeline.predicted()).toEqual({ x: 12 });

    MockWebSocket.last.finishClose();
    vi.advanceTimersByTime(1000);
    MockWebSocket.last.open();
    expect(timeline.pending()).toBe(0); // never confirmed on the old connection
    expect(timeline.predicted()).toEqual({ x: 10 });
    expect(timeline.at(5000)).toEqual({ x: 10 });

    expect(timeline.input({ dx: 1 })).toBe(3); // numbers keep counting
    snap(100, 50); // earlier: the server restarted its clock
    expect(timeline.latest()).toEqual({ time: 100, state: { x: 50 } });
    expect(timeline.at(5000)).toEqual({ x: 50 });
    expect(timeline.predicted()).toEqual({ x: 51 });
  });

  it('reset() forgets everything now but keeps counting inputs', () => {
    const { timeline } = connected();
    const listener = vi.fn();
    const off = timeline.subscribe(listener);
    snap(1000, 0);
    timeline.input({ dx: 1 });
    timeline.reset();
    expect(listener).toHaveBeenCalledTimes(2);
    expect(timeline.latest()).toBeUndefined();
    expect(timeline.renderTime()).toBeUndefined();
    expect(timeline.pending()).toBe(0);
    expect(timeline.input({ dx: 1 })).toBe(2);

    off();
    snap(1000, 0);
    expect(listener).toHaveBeenCalledTimes(2);
    expect(timeline.latest()).toEqual({ time: 1000, state: { x: 0 } });
  });

  it('records snapshots on a client that was already open, until dispose()', () => {
    const game = client();
    game.connect();
    MockWebSocket.last.open();
    const timeline = createWebSocketTimeline(game, {
      snapshot: m => (m.type === 'snapshot' ? { time: m.time, state: m.x } : undefined)
    });
    snap(1000, 1);
    expect(timeline.latest()?.state).toBe(1);
    timeline.dispose();
    snap(1100, 2);
    expect(timeline.latest()?.state).toBe(1);
  });

  it("doesn't open the connection by itself", () => {
    setup();
    expect(MockWebSocket.instances).toHaveLength(0);
  });
});

describe('types', () => {
  it('takes In and Out from the client, S from snapshot and I from the input.send annotation', () => {
    const game = client();
    const timeline = createWebSocketTimeline(game, {
      snapshot: m => (m.type === 'snapshot' ? { time: m.time, state: { x: m.x } } : undefined),
      input: {
        send: (input: Move, seq) => ({ type: 'input', seq, dx: input.dx }),
        predict: (state, input) => ({ x: state.x + input.dx })
      }
    });
    expectTypeOf(timeline).toEqualTypeOf<WebSocketTimeline<World, Move>>();

    createWebSocketTimeline(game, {
      snapshot: () => undefined,
      // @ts-expect-error the client doesn't send this
      input: { send: (input: Move) => ({ type: 'move', dx: input.dx }), predict: state => state }
    });

    const viewer = createWebSocketTimeline(game, {
      snapshot: m => (m.type === 'snapshot' ? { time: m.time, state: m.x } : undefined)
    });
    expectTypeOf(viewer.at()).toEqualTypeOf<number | undefined>();
    // @ts-expect-error no `input` option
    expect(() => viewer.input({ dx: 1 })).toThrow();
  });
});
