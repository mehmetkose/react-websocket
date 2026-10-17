import { StrictMode } from 'react';
import { act, render, screen } from '@testing-library/react';
import { createWebSocket, createWebSocketState, useWebSocketState } from '../src';
import { MockImpl, MockWebSocket } from './mock';

type Tick = { symbol: string; price: number };
type Prices = Record<string, number>;

let n = 0;
const uniqueUrl = () => `ws://state/${++n}`;

function setup() {
  const client = createWebSocket<Tick>(uniqueUrl(), { WebSocket: MockImpl, json: true });
  const store = createWebSocketState(client, {
    initialState: {} as Prices,
    reduce: (state, tick) =>
      state[tick.symbol] === tick.price ? state : { ...state, [tick.symbol]: tick.price }
  });
  return { client, store };
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
});
