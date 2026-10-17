import { act, render } from '@testing-library/react';
import { createWebSocket, createWebSocketPresence, useWebSocketPresence } from '../src';
import { MockImpl, MockWebSocket } from './mock';

type Cursor = { x: number; y: number };
type In = { type: 'cursor'; peer: string; cursor: Cursor | null } | { type: 'chat' };
type Out = { type: 'cursor'; cursor: Cursor } | { type: 'leave' };

let n = 0;

function setup(extra: { timeout?: number; refresh?: number; leave?: boolean } = {}) {
  const client = createWebSocket<In, Out>(`ws://presence/${++n}`, {
    WebSocket: MockImpl,
    json: true,
    reconnect: { jitter: 0, minDelay: 1000 }
  });
  const presence = createWebSocketPresence(client, {
    send: (cursor: Cursor) => ({ type: 'cursor', cursor }),
    leave: extra.leave === false ? undefined : () => ({ type: 'leave' }),
    receive: message =>
      message.type === 'cursor' ? { peer: message.peer, state: message.cursor } : undefined,
    timeout: extra.timeout,
    refresh: extra.refresh,
    maxRate: 10
  });
  return { client, presence };
}

const sent = () => MockWebSocket.last.sent.map(data => JSON.parse(data as string));
const peerMoves = (peer: string, cursor: Cursor | null) =>
  MockWebSocket.last.receive(JSON.stringify({ type: 'cursor', peer, cursor }));

beforeEach(() => {
  MockWebSocket.reset();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('createWebSocketPresence', () => {
  it('sends at most maxRate updates per second, the newest one last', () => {
    const { client, presence } = setup();
    client.connect();
    MockWebSocket.last.open();
    for (let x = 1; x <= 50; x++) {
      presence.set({ x, y: 0 });
      vi.advanceTimersByTime(10); // 50 moves over half a second
    }
    vi.advanceTimersByTime(100);
    const xs = sent().map(message => message.cursor.x);
    expect(xs.length).toBeLessThanOrEqual(6);
    expect(xs[0]).toBe(1);
    expect(xs.at(-1)).toBe(50);
  });

  it('sends its state again on every new connection, not from the queue', () => {
    const { client, presence } = setup();
    client.connect();
    presence.set({ x: 1, y: 1 });
    presence.set({ x: 2, y: 2 });
    vi.advanceTimersByTime(200);
    MockWebSocket.last.open();
    expect(sent()).toEqual([{ type: 'cursor', cursor: { x: 2, y: 2 } }]);
    MockWebSocket.last.finishClose(1006);
    vi.advanceTimersByTime(1000);
    MockWebSocket.last.open();
    expect(sent()).toEqual([{ type: 'cursor', cursor: { x: 2, y: 2 } }]);
  });

  it('refreshes its state while it stays the same', () => {
    const { client, presence } = setup({ timeout: 3000 });
    client.connect();
    MockWebSocket.last.open();
    presence.set({ x: 1, y: 1 });
    vi.advanceTimersByTime(3000); // refresh every 1000 ms by default
    expect(sent()).toHaveLength(4);
  });

  it('tracks the other peers, and forgets those that leave or go quiet', () => {
    const { client, presence } = setup({ timeout: 5000 });
    client.connect();
    MockWebSocket.last.open();
    peerMoves('a', { x: 1, y: 1 });
    peerMoves('b', { x: 2, y: 2 });
    vi.advanceTimersByTime(3000);
    peerMoves('a', { x: 3, y: 3 });
    expect(presence.getSnapshot().map(({ peer, state }) => [peer, state.x])).toEqual([
      ['a', 3],
      ['b', 2]
    ]);

    vi.advanceTimersByTime(2000); // b has been quiet for 5 s
    expect(presence.getSnapshot().map(({ peer }) => peer)).toEqual(['a']);
    peerMoves('a', null);
    expect(presence.getSnapshot()).toEqual([]);
    peerMoves('a', null); // already gone
    MockWebSocket.last.receive(JSON.stringify({ type: 'chat' }));
    expect(presence.getSnapshot()).toEqual([]);
  });

  it('leave() stops sharing, cancels a pending update and says goodbye', () => {
    const { client, presence } = setup();
    client.connect();
    MockWebSocket.last.open();
    presence.set({ x: 1, y: 1 });
    presence.set({ x: 2, y: 2 }); // pending
    presence.leave();
    vi.advanceTimersByTime(60_000);
    expect(sent()).toEqual([{ type: 'cursor', cursor: { x: 1, y: 1 } }, { type: 'leave' }]);
    presence.set({ x: 5, y: 5 });
    expect(sent().at(-1)).toEqual({ type: 'cursor', cursor: { x: 5, y: 5 } });
  });

  it('leaves silently without a leave message', () => {
    const { client, presence } = setup({ leave: false });
    client.connect();
    MockWebSocket.last.open();
    presence.leave();
    expect(sent()).toEqual([]);
  });

  it('stops after dispose()', () => {
    const { client, presence } = setup();
    client.connect();
    MockWebSocket.last.open();
    presence.set({ x: 1, y: 1 });
    presence.dispose();
    vi.advanceTimersByTime(60_000);
    peerMoves('a', { x: 1, y: 1 });
    expect(sent()).toHaveLength(1);
    expect(presence.getSnapshot()).toEqual([]);
  });
});

describe('useWebSocketPresence', () => {
  it('renders the peers and holds the connection', () => {
    const { client, presence } = setup();
    function Cursors() {
      return (
        <p>
          {useWebSocketPresence(presence)
            .map(({ peer, state }) => `${peer}@${state.x}`)
            .join()}
        </p>
      );
    }
    const { container, unmount } = render(<Cursors />);
    expect(client.getSnapshot().status).toBe('connecting');
    act(() => MockWebSocket.last.open());
    act(() => peerMoves('a', { x: 7, y: 0 }));
    expect(container.textContent).toBe('a@7');
    unmount();
    act(() => vi.advanceTimersByTime(0));
    expect(client.getSnapshot().status).toBe('idle');
  });

  it('lists nothing for null', () => {
    function Cursors() {
      return <p>{useWebSocketPresence(null).length}</p>;
    }
    expect(render(<Cursors />).container.textContent).toBe('0');
  });
});
