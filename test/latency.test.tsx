import { act, render } from '@testing-library/react';
import { createWebSocket, createWebSocketLatency, useWebSocketLatency } from '../src';
import type { WebSocketLatency } from '../src';
import { MockImpl, MockWebSocket } from './mock';

type In = { type: 'pong'; id: number; time?: number } | { type: 'chat' };
type Out = { type: 'ping'; id: number } | { type: 'chat' };

let n = 0;

function setup(options: { interval?: number; samples?: number } = {}) {
  const client = createWebSocket<In, Out>(`ws://latency/${++n}`, {
    WebSocket: MockImpl,
    json: true,
    reconnect: { jitter: 0, minDelay: 1000 }
  });
  const latency = createWebSocketLatency(client, {
    ping: id => ({ type: 'ping', id }),
    pong: message => (message.type === 'pong' ? { id: message.id, time: message.time } : undefined),
    ...options
  });
  return { client, latency };
}

const sent = (socket = MockWebSocket.last) => socket.sent.map(data => JSON.parse(data as string));
const pong = (id: number, time?: number, socket = MockWebSocket.last) =>
  socket.receive(JSON.stringify({ type: 'pong', id, time }));

beforeEach(() => {
  MockWebSocket.reset();
  vi.useFakeTimers({ now: 1_000_000 });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('createWebSocketLatency', () => {
  it('pings on open, before the queue, and then on every interval', () => {
    const { client } = setup({ interval: 1000 });
    client.connect();
    client.send({ type: 'chat' });
    MockWebSocket.last.open();
    expect(sent()).toEqual([{ type: 'ping', id: 1 }, { type: 'chat' }]);
    vi.advanceTimersByTime(1000);
    expect(sent().at(-1)).toEqual({ type: 'ping', id: 2 });
  });

  it('measures the round trip and the server clock offset', () => {
    const { client, latency } = setup();
    client.connect();
    MockWebSocket.last.open();
    expect(latency.getSnapshot()).toEqual({ rtt: undefined, offset: undefined });
    expect(latency.serverNow()).toBe(Date.now());

    vi.advanceTimersByTime(100);
    // The server's clock is 5 s ahead; it replied halfway through the 100 ms round trip.
    pong(1, Date.now() - 50 + 5000);
    expect(latency.getSnapshot()).toEqual({ rtt: 100, offset: 5000 });
    expect(latency.serverNow()).toBe(Date.now() + 5000);
  });

  it('reports the median round trip and the offset from the fastest sample', () => {
    const { client, latency } = setup({ interval: 1000, samples: 3 });
    client.connect();
    MockWebSocket.last.open();
    const roundTrip = (id: number, rtt: number, offset: number) => {
      vi.advanceTimersByTime(rtt);
      pong(id, Date.now() - rtt / 2 + offset);
      vi.advanceTimersByTime(1000 - rtt);
    };
    roundTrip(1, 300, 900);
    roundTrip(2, 40, 1000);
    roundTrip(3, 100, 1100);
    expect(latency.getSnapshot()).toEqual({ rtt: 100, offset: 1000 });

    roundTrip(4, 500, 0); // pushes out the 300 ms sample
    expect(latency.getSnapshot()).toEqual({ rtt: 100, offset: 1000 });
    roundTrip(5, 60, 1050); // pushes out the 40 ms one
    expect(latency.getSnapshot()).toEqual({ rtt: 100, offset: 1050 });
  });

  it('measures only the round trip when pongs carry no time, keeping a previous offset', () => {
    const { client, latency } = setup({ interval: 1000 });
    client.connect();
    MockWebSocket.last.open();
    vi.advanceTimersByTime(20);
    pong(1);
    expect(latency.getSnapshot()).toEqual({ rtt: 20, offset: undefined });
  });

  it('ignores unknown and repeated pongs, and notifies only on a measurement', () => {
    const { client, latency } = setup();
    const listener = vi.fn();
    latency.subscribe(listener);
    client.connect();
    MockWebSocket.last.open();
    pong(42);
    MockWebSocket.last.receive(JSON.stringify({ type: 'chat' }));
    expect(listener).not.toHaveBeenCalled();
    pong(1);
    pong(1);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('pauses while disconnected and starts over on reconnect, keeping the last values', () => {
    const { client, latency } = setup({ interval: 1000 });
    client.connect();
    MockWebSocket.last.open();
    vi.advanceTimersByTime(80);
    pong(1, Date.now());
    const before = latency.getSnapshot();

    const first = MockWebSocket.last;
    first.finishClose(1006);
    vi.advanceTimersByTime(999);
    expect(MockWebSocket.instances).toHaveLength(1);
    expect(sent(first)).toHaveLength(1); // no pings while reconnecting
    vi.advanceTimersByTime(1);
    expect(latency.getSnapshot()).toBe(before);

    MockWebSocket.last.open();
    expect(sent()).toEqual([{ type: 'ping', id: 2 }]);
    vi.advanceTimersByTime(10);
    pong(2, Date.now());
    expect(latency.getSnapshot().rtt).toBe(10); // the 80 ms sample from the old socket is gone
  });

  it('pings however full the send buffer is, so congestion shows in rtt', () => {
    const { client } = setup({ interval: 1000 });
    client.connect();
    MockWebSocket.last.open();
    MockWebSocket.last.bufferedAmount = 10_000_000;
    vi.advanceTimersByTime(1000);
    expect(sent()).toEqual([
      { type: 'ping', id: 1 },
      { type: 'ping', id: 2 }
    ]);
  });

  it('never queues pings', () => {
    const { client, latency } = setup();
    client.connect();
    latency.ping();
    MockWebSocket.last.open();
    expect(sent()).toEqual([{ type: 'ping', id: 1 }]);
  });

  it('starts right away on a client that is already open, and stops on dispose()', () => {
    const client = createWebSocket<In, Out>('ws://latency/open', {
      WebSocket: MockImpl,
      json: true
    });
    client.connect();
    MockWebSocket.last.open();
    const latency = createWebSocketLatency(client, {
      ping: id => ({ type: 'ping', id }),
      pong: () => undefined,
      interval: 1000
    });
    expect(sent()).toEqual([{ type: 'ping', id: 1 }]);
    latency.dispose();
    vi.advanceTimersByTime(5000);
    expect(sent()).toHaveLength(1);
  });
});

describe('useWebSocketLatency', () => {
  function Ping({ latency }: { latency: WebSocketLatency }) {
    const { rtt } = useWebSocketLatency(latency);
    return <span>{rtt === undefined ? '–' : `${rtt} ms`}</span>;
  }

  it('renders measurements and holds the connection while mounted', () => {
    const { client, latency } = setup();
    const view = render(<Ping latency={latency} />);
    expect(view.container.textContent).toBe('–');
    expect(client.getSnapshot().status).toBe('connecting');

    act(() => MockWebSocket.last.open());
    act(() => {
      vi.advanceTimersByTime(30);
      pong(1);
    });
    expect(view.container.textContent).toBe('30 ms');

    view.unmount();
    act(() => vi.advanceTimersByTime(0));
    expect(client.getSnapshot().status).toBe('idle');
  });
});
