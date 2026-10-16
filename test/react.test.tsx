import { StrictMode, Suspense, use, useState } from 'react';
import { act, render, screen } from '@testing-library/react';
import {
  createWebSocket,
  useWebSocket,
  useWebSocketEvent,
  useWebSocketStatus,
  type WebSocketClient
} from '../src';
import { MockImpl, MockWebSocket } from './mock';

let n = 0;
const uniqueUrl = () => `ws://test/${++n}`;

beforeEach(() => {
  MockWebSocket.reset();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

function Status({ url, enabled = true }: { url: string; enabled?: boolean }) {
  const { status, lastMessage, send } = useWebSocket<string, string>(url, {
    WebSocket: MockImpl,
    enabled
  });
  return (
    <button onClick={() => send('hello')}>
      {status}:{lastMessage ?? '-'}
    </button>
  );
}

describe('useWebSocket(url)', () => {
  it('reports status and messages and sends', () => {
    render(<Status url={uniqueUrl()} />);
    expect(screen.getByRole('button').textContent).toBe('connecting:-');

    act(() => MockWebSocket.last.open());
    expect(screen.getByRole('button').textContent).toBe('open:-');

    act(() => MockWebSocket.last.receive('hi'));
    expect(screen.getByRole('button').textContent).toBe('open:hi');

    act(() => screen.getByRole('button').click());
    expect(MockWebSocket.last.sent).toEqual(['hello']);
  });

  it('shares one socket between components using the same URL', () => {
    const url = uniqueUrl();
    render(
      <>
        <Status url={url} />
        <Status url={url} />
      </>
    );
    expect(MockWebSocket.instances).toHaveLength(1);
    act(() => MockWebSocket.last.receive('x'));
    expect(screen.getAllByRole('button').map(b => b.textContent)).toEqual(['connecting:x', 'connecting:x']);
  });

  it('opens a single socket under StrictMode', () => {
    render(
      <StrictMode>
        <Status url={uniqueUrl()} />
      </StrictMode>
    );
    act(() => vi.runAllTimers());
    expect(MockWebSocket.instances).toHaveLength(1);
    expect(MockWebSocket.last.closedWith).toBeUndefined();
  });

  it('closes after unmount', () => {
    const { unmount } = render(<Status url={uniqueUrl()} />);
    act(() => MockWebSocket.last.open());
    unmount();
    expect(MockWebSocket.last.closedWith).toBeUndefined();
    act(() => vi.runAllTimers());
    expect(MockWebSocket.last.closedWith).toEqual({ code: undefined, reason: undefined });
  });

  it('connects and disconnects with `enabled`', () => {
    const url = uniqueUrl();
    const { rerender } = render(<Status url={url} enabled={false} />);
    expect(MockWebSocket.instances).toHaveLength(0);
    expect(screen.getByRole('button').textContent).toBe('idle:-');

    rerender(<Status url={url} enabled />);
    expect(MockWebSocket.instances).toHaveLength(1);

    rerender(<Status url={url} enabled={false} />);
    act(() => vi.runAllTimers());
    expect(MockWebSocket.last.closedWith).toBeDefined();
    expect(screen.getByRole('button').textContent).toBe('idle:-');
  });

  it('stays idle for a null url', () => {
    function Null() {
      const { status, send } = useWebSocket(null);
      return <span>{`${status}:${send('x')}`}</span>;
    }
    render(<Null />);
    expect(screen.getByText('idle:false')).toBeTruthy();
    expect(MockWebSocket.instances).toHaveLength(0);
  });

  it('calls the latest handlers without reconnecting when they change', () => {
    const url = uniqueUrl();
    const seen: string[] = [];
    function Listener({ tag }: { tag: string }) {
      useWebSocket<string>(url, {
        WebSocket: MockImpl,
        onMessage: m => seen.push(`${tag}:${m}`)
      });
      return null;
    }
    const { rerender } = render(<Listener tag="a" />);
    act(() => MockWebSocket.last.open());
    act(() => MockWebSocket.last.receive('1'));
    rerender(<Listener tag="b" />);
    act(() => MockWebSocket.last.receive('2'));
    expect(seen).toEqual(['a:1', 'b:2']);
    expect(MockWebSocket.instances).toHaveLength(1);
  });

  it('returns stable send/close/reconnect functions', () => {
    const url = uniqueUrl();
    const sends = new Set<unknown>();
    function Probe() {
      const { send } = useWebSocket(url, { WebSocket: MockImpl });
      sends.add(send);
      return null;
    }
    render(<Probe />);
    act(() => MockWebSocket.last.open());
    act(() => MockWebSocket.last.receive('x'));
    expect(sends.size).toBe(1);
  });
});

describe('module-level clients', () => {
  let chat: WebSocketClient<string, string>;
  beforeEach(() => {
    chat = createWebSocket<string, string>(uniqueUrl(), { WebSocket: MockImpl });
  });

  it('useWebSocketEvent listens without re-rendering; useWebSocketStatus tracks status only', () => {
    const received: string[] = [];
    let renders = 0;
    function Feed() {
      renders++;
      const status = useWebSocketStatus(chat);
      useWebSocketEvent(chat, 'message', m => received.push(m));
      return <span>{status}</span>;
    }
    render(<Feed />);
    act(() => MockWebSocket.last.open());
    const rendersWhenOpen = renders;
    act(() => {
      MockWebSocket.last.receive('a');
      MockWebSocket.last.receive('b');
    });
    expect(received).toEqual(['a', 'b']);
    expect(renders).toBe(rendersWhenOpen);
    expect(screen.getByText('open')).toBeTruthy();
  });

  it('use(client.ready) suspends until connected', async () => {
    vi.useRealTimers();
    function Room() {
      use(chat.ready);
      const status = useWebSocketStatus(chat);
      return <span>room:{status}</span>;
    }
    await act(async () => {
      render(
        <Suspense fallback={<span>connecting…</span>}>
          <Room />
        </Suspense>
      );
    });
    expect(screen.getByText('connecting…')).toBeTruthy();
    expect(MockWebSocket.instances).toHaveLength(1);

    await act(async () => MockWebSocket.last.open());
    expect(await screen.findByText('room:open')).toBeTruthy();
    expect(MockWebSocket.instances).toHaveLength(1);
  });

  it('use(client.ready) does not suspend when already open', () => {
    chat.connect();
    MockWebSocket.last.open();
    void chat.ready;
    function Room() {
      use(chat.ready);
      return <span>ready</span>;
    }
    render(
      <Suspense fallback={<span>fallback</span>}>
        <Room />
      </Suspense>
    );
    expect(screen.getByText('ready')).toBeTruthy();
  });

  it('useWebSocket(client) exposes the client state and actions', () => {
    function Box() {
      const [count, setCount] = useState(0);
      const { status, send } = useWebSocket(chat, { onMessage: () => setCount(c => c + 1) });
      return <button onClick={() => send('ping')}>{`${status}:${count}`}</button>;
    }
    render(<Box />);
    act(() => MockWebSocket.last.open());
    act(() => MockWebSocket.last.receive('x'));
    act(() => screen.getByRole('button').click());
    expect(screen.getByRole('button').textContent).toBe('open:1');
    expect(MockWebSocket.last.sent).toEqual(['ping']);
  });
});
