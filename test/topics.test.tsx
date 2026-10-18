import { StrictMode } from 'react';
import { act, render } from '@testing-library/react';
import { createWebSocket, createWebSocketTopics, useWebSocketTopic } from '../src';
import { MockImpl, MockWebSocket } from './mock';

type Out = { type: 'sub' | 'unsub'; topic: string } | { type: 'chat'; text: string };

let n = 0;
const uniqueUrl = () => `ws://topics/${++n}`;

function setup(withUnsubscribe = true) {
  const client = createWebSocket<unknown, Out>(uniqueUrl(), { WebSocket: MockImpl, json: true });
  const topics = createWebSocketTopics(client, {
    subscribe: topic => ({ type: 'sub', topic }),
    unsubscribe: withUnsubscribe ? topic => ({ type: 'unsub', topic }) : undefined
  });
  return { client, topics };
}

const sent = (socket = MockWebSocket.last) => socket.sent.map(data => JSON.parse(data as string));

beforeEach(() => {
  MockWebSocket.reset();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('createWebSocketTopics', () => {
  it('subscribes on open, before messages queued while connecting', () => {
    const { client, topics } = setup();
    topics.acquire('a');
    client.send({ type: 'chat', text: 'hi' });
    expect(MockWebSocket.instances).toHaveLength(1); // acquiring a topic holds the connection
    MockWebSocket.last.open();
    expect(sent()).toEqual([
      { type: 'sub', topic: 'a' },
      { type: 'chat', text: 'hi' }
    ]);
  });

  it('sends nothing while the server is closing the socket, and subscribes again after', () => {
    const { client, topics } = setup();
    client.connect();
    MockWebSocket.last.open();
    let release = topics.acquire('a');
    // The server's close frame arrived: the socket is closing, and the status still `open`.
    MockWebSocket.last.readyState = 2;
    release();
    vi.advanceTimersByTime(0);
    release = topics.acquire('a');
    MockWebSocket.last.finishClose(1001);
    vi.advanceTimersByTime(1000);
    MockWebSocket.last.open();
    // Nothing queued: no unsubscribe after the subscription the new socket got.
    expect(sent()).toEqual([{ type: 'sub', topic: 'a' }]);
    release();
  });

  it('subscribes immediately when already open', () => {
    const { client, topics } = setup();
    client.connect();
    MockWebSocket.last.open();
    topics.acquire('a');
    expect(sent()).toEqual([{ type: 'sub', topic: 'a' }]);
  });

  it('shares a topic between holders and unsubscribes a tick after the last release', () => {
    const { client, topics } = setup();
    client.connect();
    MockWebSocket.last.open();
    const releaseA = topics.acquire('a');
    const releaseB = topics.acquire('a');
    expect(sent()).toEqual([{ type: 'sub', topic: 'a' }]);

    releaseA();
    releaseA(); // idempotent
    vi.runAllTimers();
    expect(sent()).toHaveLength(1);
    expect(topics.active()).toEqual(['a']);

    releaseB();
    expect(sent()).toHaveLength(1);
    vi.runAllTimers();
    expect(sent()).toEqual([
      { type: 'sub', topic: 'a' },
      { type: 'unsub', topic: 'a' }
    ]);
    expect(topics.active()).toEqual([]);
  });

  it('does not churn on release + re-acquire in the same tick (StrictMode)', () => {
    const { client, topics } = setup();
    client.connect();
    MockWebSocket.last.open();
    topics.acquire('a')();
    topics.acquire('a');
    vi.runAllTimers();
    expect(sent()).toEqual([{ type: 'sub', topic: 'a' }]);
  });

  it('resubscribes every held topic after a reconnect, and only those', () => {
    const { client, topics } = setup();
    client.connect();
    MockWebSocket.last.open();
    topics.acquire('a');
    const releaseB = topics.acquire('b');
    const first = MockWebSocket.last;

    first.finishClose(1006);
    releaseB(); // released while reconnecting: no unsubscribe on either socket
    vi.runAllTimers();
    MockWebSocket.last.open();

    expect(MockWebSocket.last).not.toBe(first);
    expect(sent()).toEqual([{ type: 'sub', topic: 'a' }]);
    expect(sent(first)).toEqual([
      { type: 'sub', topic: 'a' },
      { type: 'sub', topic: 'b' }
    ]);
  });

  it('subscribes on the new connection after migrate(), before the old one closes', () => {
    const { client, topics } = setup();
    client.connect();
    MockWebSocket.last.open();
    topics.acquire('a');
    const first = MockWebSocket.last;
    client.migrate();
    vi.advanceTimersByTime(0);
    MockWebSocket.last.open();
    expect(sent()).toEqual([{ type: 'sub', topic: 'a' }]);
    expect(first.closedWith).toEqual({ code: 1000, reason: 'migrated' });
  });

  it('works without an unsubscribe message', () => {
    const { client, topics } = setup(false);
    client.connect();
    MockWebSocket.last.open();
    topics.acquire('a')();
    vi.runAllTimers();
    expect(sent()).toEqual([{ type: 'sub', topic: 'a' }]);
  });

  it('releases the connection with the last topic', () => {
    const { client, topics } = setup();
    const release = topics.acquire('a');
    MockWebSocket.last.open();
    release();
    vi.runAllTimers();
    expect(client.getSnapshot().status).toBe('idle');
  });

  it('stops after dispose()', () => {
    const { client, topics } = setup();
    topics.acquire('a');
    topics.dispose();
    MockWebSocket.last.open();
    expect(sent()).toEqual([]);
    expect(client.getSnapshot().status).toBe('open');
  });
});

describe('useWebSocketTopic', () => {
  it('subscribes once under StrictMode and follows topic changes', () => {
    const { topics } = setup();
    function Ticker({ symbol }: { symbol: string | null }) {
      useWebSocketTopic(topics, symbol && `prices:${symbol}`);
      return null;
    }
    const view = (symbol: string | null) => (
      <StrictMode>
        <Ticker symbol={symbol} />
      </StrictMode>
    );
    const { rerender } = render(view('ACME'));
    act(() => MockWebSocket.last.open());
    act(() => vi.runAllTimers());
    expect(sent()).toEqual([{ type: 'sub', topic: 'prices:ACME' }]);

    rerender(view('INIT'));
    act(() => vi.runAllTimers());
    expect(sent()).toEqual([
      { type: 'sub', topic: 'prices:ACME' },
      { type: 'sub', topic: 'prices:INIT' },
      { type: 'unsub', topic: 'prices:ACME' }
    ]);

    rerender(view(null));
    act(() => vi.runAllTimers());
    expect(topics.active()).toEqual([]);
  });

  it('accepts several topics and ignores a new array with the same topics', () => {
    const { topics } = setup();
    const acquire = vi.spyOn(topics, 'acquire');
    function Watchlist({ symbols }: { symbols: string[] }) {
      useWebSocketTopic(
        topics,
        symbols.map(s => `prices:${s}`)
      );
      return null;
    }
    const { rerender } = render(<Watchlist symbols={['A', 'B']} />);
    act(() => MockWebSocket.last.open());
    rerender(<Watchlist symbols={['A', 'B']} />);
    expect(acquire).toHaveBeenCalledTimes(2);
    expect(topics.active()).toEqual(['prices:A', 'prices:B']);
    expect(sent()).toEqual([
      { type: 'sub', topic: 'prices:A' },
      { type: 'sub', topic: 'prices:B' }
    ]);
  });
});
