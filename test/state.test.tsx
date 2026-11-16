import { StrictMode } from 'react';
import { act, render, screen } from '@testing-library/react';
import { createWebSocket, createWebSocketState, useWebSocketState } from '../src';
import { MockImpl, MockWebSocket } from './mock';

type Tick = { symbol: string; price: number };
type Prices = Record<string, number>;

let n = 0;
const uniqueUrl = () => `ws://state/${++n}`;

function setup(batch?: 'frame') {
  const client = createWebSocket<Tick>(uniqueUrl(), { WebSocket: MockImpl, json: true });
  const store = createWebSocketState(client, {
    initialState: {} as Prices,
    reduce: (state, tick) =>
      state[tick.symbol] === tick.price ? state : { ...state, [tick.symbol]: tick.price },
    batch
  });
  return { client, store };
}

function connected(batch?: 'frame') {
  const result = setup(batch);
  result.client.connect();
  MockWebSocket.last.open();
  return result;
}

const tick = (symbol: string, price: number) =>
  MockWebSocket.last.receive(JSON.stringify({ symbol, price }));

beforeEach(() => {
  MockWebSocket.reset();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('createWebSocketState', () => {
  it('reduces messages into state and notifies on change only', () => {
    const { client, store } = setup();
    const listener = vi.fn();
    store.subscribe(listener);
    client.connect();
    MockWebSocket.last.open();

    tick('ACME', 1);
    expect(store.getState()).toEqual({ ACME: 1 });
    tick('ACME', 1); // the reducer returns the same state: no notification
    expect(listener).toHaveBeenCalledTimes(1);
    tick('INIT', 2);
    expect(store.getState()).toEqual({ ACME: 1, INIT: 2 });
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('keeps state across reconnects and supports setState, reset and dispose', () => {
    const { client, store } = setup();
    client.connect();
    MockWebSocket.last.open();
    tick('ACME', 1);
    MockWebSocket.last.finishClose();
    vi.runOnlyPendingTimers();
    MockWebSocket.last.open();
    expect(store.getState()).toEqual({ ACME: 1 });

    store.setState(state => ({ ...state, LOCAL: 9 }));
    expect(store.getState()).toEqual({ ACME: 1, LOCAL: 9 });
    store.reset();
    expect(store.getState()).toBe(store.initialState);

    store.dispose();
    tick('ACME', 5);
    expect(store.getState()).toEqual({});
  });

  it('does not open the connection by itself', () => {
    setup();
    expect(MockWebSocket.instances).toHaveLength(0);
  });
});

describe("batch: 'frame'", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('keeps the state current and notifies once per animation frame', () => {
    const { store } = connected('frame');
    const listener = vi.fn();
    store.subscribe(listener);
    tick('ACME', 1);
    tick('ACME', 2);
    tick('INIT', 3);
    expect(store.getState()).toEqual({ ACME: 2, INIT: 3 });
    expect(listener).not.toHaveBeenCalled();
    vi.advanceTimersToNextFrame();
    expect(listener).toHaveBeenCalledTimes(1);
    vi.advanceTimersToNextFrame();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('stays quiet when the state is back where it was by the frame', () => {
    const { store } = connected('frame');
    const listener = vi.fn();
    tick('ACME', 1);
    vi.advanceTimersToNextFrame();
    store.subscribe(listener);
    const before = store.getState();
    tick('ACME', 2);
    store.setState(before); // undoes the tick before anyone heard of it
    vi.advanceTimersToNextFrame();
    expect(listener).not.toHaveBeenCalled();
  });

  it('notifies setState and reset right away, with any changes waiting for the frame', () => {
    const { store } = connected('frame');
    const listener = vi.fn();
    store.subscribe(listener);
    tick('ACME', 1);
    store.setState(state => ({ ...state, LOCAL: 9 }));
    expect(listener).toHaveBeenCalledTimes(1);
    vi.advanceTimersToNextFrame();
    expect(listener).toHaveBeenCalledTimes(1); // nothing new by the frame

    store.reset();
    expect(listener).toHaveBeenCalledTimes(2);
    expect(store.getState()).toBe(store.initialState);
  });

  it('waits about 16 ms where there are no animation frames', () => {
    vi.stubGlobal('requestAnimationFrame', undefined);
    const { store } = connected('frame');
    const listener = vi.fn();
    store.subscribe(listener);
    tick('ACME', 1);
    tick('ACME', 2);
    vi.advanceTimersByTime(15);
    expect(listener).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('stops reducing on dispose(), delivering what came before', () => {
    const { store } = connected('frame');
    const listener = vi.fn();
    store.subscribe(listener);
    tick('ACME', 1);
    store.dispose();
    tick('ACME', 2);
    vi.advanceTimersToNextFrame();
    expect(listener).toHaveBeenCalledTimes(1);
    expect(store.getState()).toEqual({ ACME: 1 });
  });
});

describe('useWebSocketState', () => {
  it('re-renders only when the selected value changes and holds the connection', () => {
    const { store } = setup();
    let renders = 0;
    function Acme() {
      renders++;
      const price = useWebSocketState(store, state => state.ACME);
      return <p>{price ?? '-'}</p>;
    }
    const { unmount } = render(<Acme />);
    expect(MockWebSocket.instances).toHaveLength(1);
    act(() => MockWebSocket.last.open());
    const before = renders;

    act(() => tick('OTHER', 1));
    expect(renders).toBe(before);
    act(() => tick('ACME', 42));
    expect(screen.getByRole('paragraph').textContent).toBe('42');
    expect(renders).toBe(before + 1);

    unmount();
    act(() => vi.runAllTimers());
    expect(MockWebSocket.last.closedWith).toBeDefined();
  });

  it('returns the whole state without a selector', () => {
    const { store } = setup();
    function All() {
      const prices = useWebSocketState(store);
      return <p>{Object.keys(prices).join(',') || '-'}</p>;
    }
    render(<All />);
    act(() => MockWebSocket.last.open());
    act(() => tick('ACME', 1));
    expect(screen.getByRole('paragraph').textContent).toBe('ACME');
  });

  it('keeps an object-building selector stable with a custom isEqual', () => {
    const { store } = setup();
    let renders = 0;
    const shallow = (a: { count: number }, b: { count: number }) => a.count === b.count;
    function Count() {
      renders++;
      const { count } = useWebSocketState(
        store,
        state => ({ count: Object.keys(state).length }),
        shallow
      );
      return <p>{count}</p>;
    }
    render(
      <StrictMode>
        <Count />
      </StrictMode>
    );
    act(() => MockWebSocket.last.open());
    act(() => tick('ACME', 1));
    const before = renders;
    act(() => tick('ACME', 2)); // state changes, count doesn't
    expect(renders).toBe(before);
    expect(screen.getByRole('paragraph').textContent).toBe('1');
  });

  it('follows a selector that depends on props', () => {
    const { store } = setup();
    function Price({ symbol }: { symbol: string }) {
      return <p>{useWebSocketState(store, state => state[symbol]) ?? '-'}</p>;
    }
    const { rerender } = render(<Price symbol="ACME" />);
    act(() => MockWebSocket.last.open());
    act(() => {
      tick('ACME', 1);
      tick('INIT', 2);
    });
    expect(screen.getByRole('paragraph').textContent).toBe('1');
    rerender(<Price symbol="INIT" />);
    expect(screen.getByRole('paragraph').textContent).toBe('2');
  });

  it("renders once per frame with batch: 'frame'", () => {
    const { store } = setup('frame');
    let renders = 0;
    function Acme() {
      renders++;
      return <p>{useWebSocketState(store, state => state.ACME) ?? '-'}</p>;
    }
    render(<Acme />);
    act(() => MockWebSocket.last.open());
    const before = renders;
    // Each message is its own task, as in a browser.
    act(() => tick('ACME', 1));
    act(() => tick('ACME', 2));
    act(() => tick('ACME', 3));
    expect(renders).toBe(before);
    act(() => vi.advanceTimersToNextFrame());
    expect(renders).toBe(before + 1);
    expect(screen.getByRole('paragraph').textContent).toBe('3');
  });
});

// Transitions that meet another one under way: a waiting frame, a failing reducer, a reconnect.
describe('transitions under way', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('leaves the state as it was when the reducer throws, and reduces the next message', () => {
    const thrown: unknown[] = [];
    vi.spyOn(globalThis, 'queueMicrotask').mockImplementation(callback => {
      try {
        callback();
      } catch (error) {
        thrown.push(error);
      }
    });
    const client = createWebSocket<Tick>(uniqueUrl(), { WebSocket: MockImpl, json: true });
    const store = createWebSocketState(client, {
      initialState: {} as Prices,
      reduce: (state, { symbol, price }) => {
        if (price < 0) throw new Error('bad price');
        return { ...state, [symbol]: price };
      },
      batch: 'frame'
    });
    const listener = vi.fn();
    store.subscribe(listener);
    client.connect();
    MockWebSocket.last.open();
    tick('ACME', 1);
    tick('ACME', -1);
    tick('INIT', 2);
    vi.advanceTimersToNextFrame();
    expect(store.getState()).toEqual({ ACME: 1, INIT: 2 });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(thrown).toEqual([new Error('bad price')]);
  });

  it('says nothing when reset() undoes changes still waiting for their frame', () => {
    const { store } = connected('frame');
    const listener = vi.fn();
    store.subscribe(listener);
    tick('ACME', 1);
    store.reset(); // nobody heard of ACME yet
    vi.advanceTimersToNextFrame();
    expect(listener).not.toHaveBeenCalled();
    tick('ACME', 2);
    vi.advanceTimersToNextFrame();
    expect(listener).toHaveBeenCalledTimes(1);
    expect(store.getState()).toEqual({ ACME: 2 });
  });

  it('reduces messages from the connection a migrate() switch replaced, then the new one', () => {
    const { client, store } = connected();
    const first = MockWebSocket.last;
    client.migrate();
    vi.advanceTimersByTime(0);
    const second = MockWebSocket.last;
    first.receive(JSON.stringify({ symbol: 'ACME', price: 1 })); // before the switch
    second.open();
    second.receive(JSON.stringify({ symbol: 'ACME', price: 2 }));
    expect(store.getState()).toEqual({ ACME: 2 });
  });

  it('keeps its state through close() and connect(), until reset()', () => {
    const { client, store } = connected();
    tick('ACME', 1);
    client.close();
    expect(store.getState()).toEqual({ ACME: 1 });
    client.connect();
    MockWebSocket.last.open();
    tick('INIT', 2);
    expect(store.getState()).toEqual({ ACME: 1, INIT: 2 });
    store.reset();
    expect(store.getState()).toBe(store.initialState);
  });
});
