import { Activity, StrictMode, Suspense, use, useEffect, useState } from 'react';
import { act, render, screen } from '@testing-library/react';
import { hydrateRoot } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import {
  createWebSocket,
  useWebSocket,
  useWebSocketEvent,
  useWebSocketStatus,
  type UseWebSocketOptions,
  type WebSocketClient
} from '../src';
import { MockImpl, MockWebSocket } from './mock';

// React 18 has neither `use` nor `<Activity>`; CI also runs this suite against it.
const itReact19 = it.skipIf(typeof use !== 'function');
const itActivity = it.skipIf(typeof Activity === 'undefined');

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
    expect(screen.getAllByRole('button').map(b => b.textContent)).toEqual([
      'connecting:x',
      'connecting:x'
    ]);
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

  itActivity('releases the connection while hidden by <Activity> and reconnects when shown', () => {
    const url = uniqueUrl();
    const view = (mode: 'visible' | 'hidden') => (
      <Activity mode={mode}>
        <Status url={url} />
      </Activity>
    );
    const { rerender } = render(view('visible'));
    act(() => MockWebSocket.last.open());

    rerender(view('hidden'));
    act(() => vi.runAllTimers());
    expect(MockWebSocket.instances).toHaveLength(1);
    expect(MockWebSocket.last.closedWith).toBeDefined();

    // Like a remount: the URL's only user left, so it starts from a fresh client.
    rerender(view('visible'));
    act(() => vi.runAllTimers());
    expect(MockWebSocket.instances.filter(s => !s.closedWith)).toHaveLength(1);
    expect(screen.getByRole('button').textContent).toBe('connecting:-');
    act(() => MockWebSocket.last.open());
    expect(screen.getByRole('button').textContent).toBe('open:-');
  });

  itActivity("keeps a module-level client's lastMessage across <Activity> hide/show", () => {
    const client = createWebSocket<string>(uniqueUrl(), { WebSocket: MockImpl });
    function Last() {
      const { status, lastMessage } = useWebSocket(client);
      return <p>{`${status}:${lastMessage ?? '-'}`}</p>;
    }
    const view = (mode: 'visible' | 'hidden') => (
      <Activity mode={mode}>
        <Last />
      </Activity>
    );
    const { rerender } = render(view('visible'));
    act(() => MockWebSocket.last.open());
    act(() => MockWebSocket.last.receive('kept'));

    rerender(view('hidden'));
    act(() => vi.runAllTimers());
    expect(client.getSnapshot().status).toBe('idle');

    rerender(view('visible'));
    expect(screen.getByRole('paragraph').textContent).toBe('connecting:kept');
    expect(MockWebSocket.instances).toHaveLength(2);
  });

  itActivity('does not open a socket for content pre-rendered in a hidden <Activity>', () => {
    render(
      <Activity mode="hidden">
        <Status url={uniqueUrl()} />
      </Activity>
    );
    act(() => vi.runAllTimers());
    expect(MockWebSocket.instances).toHaveLength(0);
  });

  it('opens a single socket when hydrating under StrictMode', async () => {
    const url = uniqueUrl();
    const container = document.createElement('div');
    container.innerHTML = renderToString(<Status url={url} />);
    document.body.append(container);
    await act(async () => {
      hydrateRoot(
        container,
        <StrictMode>
          <Status url={url} />
        </StrictMode>
      );
    });
    act(() => vi.runAllTimers());
    expect(MockWebSocket.instances).toHaveLength(1);
    expect(MockWebSocket.last.closedWith).toBeUndefined();
    expect(container.textContent).toBe('connecting:-');
    container.remove();
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

describe('shared URL clients', () => {
  it("doesn't let a render React throws away open the connection or decide its options", () => {
    const url = uniqueUrl();
    const never = new Promise<never>(() => {});
    function Discarded(): null {
      useWebSocket(url, { WebSocket: MockImpl, json: false });
      throw never;
    }
    function Real() {
      const { lastMessage } = useWebSocket<{ price: number }>(url, {
        WebSocket: MockImpl,
        json: true
      });
      return <p>{typeof lastMessage}</p>;
    }
    const { rerender, container } = render(
      <Suspense fallback="loading">
        <Discarded />
      </Suspense>
    );
    expect(MockWebSocket.instances).toHaveLength(0);

    rerender(<Real />);
    act(() => MockWebSocket.last.open());
    act(() => MockWebSocket.last.receive('{"price":42}'));
    expect(MockWebSocket.instances).toHaveLength(1);
    expect(container.textContent).toBe('object');
  });

  it('gives components that mount together one socket, and delivers what they send on mount', () => {
    const url = uniqueUrl();
    function Sender({ text }: { text: string }) {
      const { send } = useWebSocket<string, string>(url, { WebSocket: MockImpl });
      useEffect(() => {
        send(text);
      }, [send, text]);
      return null;
    }
    render(
      <StrictMode>
        <Sender text="a" />
        <Sender text="b" />
      </StrictMode>
    );
    expect(MockWebSocket.instances).toHaveLength(1);
    act(() => MockWebSocket.last.open());
    // StrictMode mounts, unmounts and mounts again, so each sends twice.
    expect(MockWebSocket.last.sent).toEqual(['a', 'b', 'a', 'b']);
  });

  it('uses the options of the first component to commit', () => {
    const url = uniqueUrl();
    function Reader({ json }: { json: boolean }) {
      const { lastMessage } = useWebSocket(url, { WebSocket: MockImpl, json });
      return <p>{typeof lastMessage}</p>;
    }
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const first = render(<Reader json />);
    const second = render(<Reader json={false} />);
    act(() => MockWebSocket.last.open());
    act(() => MockWebSocket.last.receive('{"a":1}'));
    expect(first.container.textContent).toBe('object');
    expect(second.container.textContent).toBe('object');
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });

  it('lets a disabled component follow the shared client, and open its own once it is gone', () => {
    const url = uniqueUrl();
    const view = (showOpener: boolean, enabled: boolean) => (
      <>
        {showOpener && <Status url={url} />}
        <Status url={url} enabled={enabled} />
      </>
    );
    const { rerender } = render(view(true, false));
    act(() => MockWebSocket.last.open());
    expect(screen.getAllByRole('button').map(button => button.textContent)).toEqual([
      'open:-',
      'open:-'
    ]);

    // The opener leaves: the connection closes, and the disabled one shows its own, idle client.
    rerender(view(false, false));
    act(() => vi.runAllTimers());
    expect(screen.getByRole('button').textContent).toBe('idle:-');

    rerender(view(false, true));
    expect(MockWebSocket.instances).toHaveLength(2);
    act(() => MockWebSocket.last.open());
    expect(screen.getByRole('button').textContent).toBe('open:-');
  });
});

describe('conflicting options for a shared URL', () => {
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    warn.mockRestore();
  });

  type Options = UseWebSocketOptions<unknown, unknown>;

  // A new schema object on every call.
  const inlineSchema = () => ({
    '~standard': { version: 1 as const, vendor: 'test', validate: (value: unknown) => ({ value }) }
  });

  // `options` runs on every render, like options written inline in a component.
  function Hook({ url, options }: { url: string; options: () => Options }) {
    useWebSocket(url, { WebSocket: MockImpl, ...options() });
    return null;
  }

  it('warns once when a component passes different options than the one that opened it', () => {
    const url = uniqueUrl();
    const view = () => (
      <>
        <Hook url={url} options={() => ({ json: true })} />
        <Hook url={url} options={() => ({ reconnect: { maxAttempts: 3 } })} />
      </>
    );
    const { rerender } = render(view());
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]![0]).toContain(
      `useWebSocket("${url}") was given different json, reconnect than the component`
    );
    rerender(view());
    expect(warn).toHaveBeenCalledOnce();
  });

  it("doesn't warn for the same options written inline, or left at their defaults", () => {
    const url = uniqueUrl();
    const options = (): Options => ({
      parse: data => JSON.parse(String(data)),
      reconnect: { maxAttempts: 3, shouldReconnect: close => close.code !== 4001 },
      queue: { limit: 10 },
      onMessage: () => {}
    });
    render(
      <>
        <Hook url={url} options={options} />
        <Hook url={url} options={() => ({ ...options(), json: false, binaryType: 'blob' })} />
        <Hook url={url} options={() => ({ ...options(), onMessage: undefined, enabled: false })} />
      </>
    );
    expect(warn).not.toHaveBeenCalled();
  });

  it("doesn't warn when the component that opened it re-renders with new inline values", () => {
    const url = uniqueUrl();
    const view = () => <Hook url={url} options={() => ({ json: true, schema: inlineSchema() })} />;
    const { rerender } = render(view());
    rerender(view());
    expect(warn).not.toHaveBeenCalled();
  });

  it("doesn't warn under StrictMode", () => {
    render(
      <StrictMode>
        <Hook url={uniqueUrl()} options={() => ({ json: true, reconnect: { maxAttempts: 3 } })} />
      </StrictMode>
    );
    act(() => vi.runAllTimers());
    expect(warn).not.toHaveBeenCalled();
  });

  // React 18 gives StrictMode's second render a new `useId`, so there it compares the two
  // renders' options, and a schema created during render differs between them.
  itReact19("doesn't warn under StrictMode with a schema created during render", () => {
    render(
      <StrictMode>
        <Hook url={uniqueUrl()} options={() => ({ json: true, schema: inlineSchema() })} />
      </StrictMode>
    );
    act(() => vi.runAllTimers());
    expect(warn).not.toHaveBeenCalled();
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

  itReact19('use(client.ready) suspends until connected', async () => {
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

  itReact19('use(client.ready) does not suspend when already open', () => {
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

  itReact19('use(client.ready) keeps content on screen during an automatic reconnect', () => {
    chat.connect();
    MockWebSocket.last.open();
    function Room() {
      use(chat.ready);
      return <span>room:{useWebSocketStatus(chat)}</span>;
    }
    render(
      <Suspense fallback={<span>fallback</span>}>
        <Room />
      </Suspense>
    );
    act(() => MockWebSocket.last.finishClose(1006));
    expect(screen.getByText('room:reconnecting')).toBeTruthy();
    expect(screen.queryByText('fallback')).toBeNull();
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

describe('reported issues', () => {
  it('#46: changing the url reconnects to the new one', () => {
    const [first, second] = [uniqueUrl(), uniqueUrl()];
    const { rerender } = render(<Status url={first} />);
    act(() => MockWebSocket.last.open());
    const old = MockWebSocket.last;

    rerender(<Status url={second} />);
    expect(MockWebSocket.last.url).toBe(second);
    expect(screen.getByRole('button').textContent).toBe('connecting:-');
    act(() => vi.runAllTimers());
    expect(old.closedWith).toBeDefined();

    act(() => MockWebSocket.last.open());
    act(() => MockWebSocket.last.receive('from second'));
    expect(screen.getByRole('button').textContent).toBe('open:from second');
  });

  it('#51 #38 #5: onOpen, onClose (with code and reason) and onError reach the component', () => {
    const calls: unknown[] = [];
    const url = uniqueUrl();
    function Watcher() {
      useWebSocket(url, {
        WebSocket: MockImpl,
        json: true,
        onOpen: () => calls.push('open'),
        onClose: close => calls.push(close),
        onError: error => calls.push(error instanceof Error ? error.name : error.type)
      });
      return null;
    }
    render(<Watcher />);
    act(() => MockWebSocket.last.open());
    act(() => MockWebSocket.last.receive('not json'));
    act(() => MockWebSocket.last.onerror?.(new Event('error')));
    act(() => MockWebSocket.last.finishClose(4001, 'session expired'));
    expect(calls).toEqual([
      'open',
      'MessageError',
      'error',
      { code: 4001, reason: 'session expired', wasClean: false }
    ]);
  });

  it('#50: close() disconnects for good, without unmounting', () => {
    function Closer() {
      const { status, close } = useWebSocket(url, { WebSocket: MockImpl });
      return <button onClick={() => close()}>{status}</button>;
    }
    const url = uniqueUrl();
    render(<Closer />);
    act(() => MockWebSocket.last.open());
    act(() => screen.getByRole('button').click());
    act(() => MockWebSocket.last.finishClose(1000));
    act(() => vi.advanceTimersByTime(60_000));
    expect(screen.getByRole('button').textContent).toBe('closed');
    expect(MockWebSocket.instances).toHaveLength(1);
  });

  it('#37: send() needs no ref and serializes objects with json', () => {
    function Sender() {
      const { send } = useWebSocket<unknown, { hello: string }>(url, {
        WebSocket: MockImpl,
        json: true
      });
      return <button onClick={() => send({ hello: 'server' })}>send</button>;
    }
    const url = uniqueUrl();
    render(<Sender />);
    act(() => screen.getByRole('button').click()); // before open: queued
    act(() => MockWebSocket.last.open());
    expect(MockWebSocket.last.sent).toEqual(['{"hello":"server"}']);
  });
});
