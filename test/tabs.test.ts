import { createWebSocket } from '../src/core';
import { createTabsWebSocket, type TabsWebSocket } from '../src/tabs';
import { MockImpl, MockWebSocket } from './mock';

/** A Web Locks API with one queue per name, as the browser keeps across all tabs. */
function fakeLocks() {
  const queues = new Map<string, (() => unknown)[]>();
  const held = new Set<string>();
  const next = (name: string) => {
    const run = queues.get(name)?.shift();
    if (!run) return void held.delete(name);
    held.add(name);
    void Promise.resolve(run()).finally(() => next(name));
  };
  return {
    request(name: string, callback: () => unknown) {
      if (!queues.has(name)) queues.set(name, []);
      queues.get(name)!.push(callback);
      if (!held.has(name)) next(name);
      return Promise.resolve();
    }
  };
}

/** jsdom has no `navigator.locks`. */
const setLocks = (locks: unknown) =>
  Object.defineProperty(navigator, 'locks', { value: locks, configurable: true });

const tabs: TabsWebSocket[] = [];
/** A new "tab": its own class, and so its own agents, on the shared locks and channels. */
function tab(options: Parameters<typeof createTabsWebSocket>[0] = {}) {
  const Shared = createTabsWebSocket({ WebSocket: MockImpl, linger: 50, ...options });
  tabs.push(Shared);
  return Shared;
}

let n = 0;
let url = '';
const clients: ReturnType<typeof createWebSocket>[] = [];
const client = (Shared: TabsWebSocket, json = false) => {
  const created = createWebSocket(url, {
    WebSocket: Shared as unknown as typeof WebSocket,
    json,
    reconnect: { minDelay: 20, maxDelay: 20, jitter: 0, minUptime: 0 }
  });
  clients.push(created);
  return created;
};
const sent = () => MockWebSocket.instances.flatMap(socket => socket.sent);

beforeEach(() => {
  MockWebSocket.reset();
  url = `ws://tabs/${++n}`;
  setLocks(fakeLocks());
});

afterEach(() => {
  for (const created of clients.splice(0)) created.close();
  for (const Shared of tabs.splice(0)) Shared.dispose();
  delete (navigator as { locks?: unknown }).locks;
  vi.unstubAllGlobals();
});

describe('createTabsWebSocket', () => {
  it('opens one socket for every tab, and gives every tab its messages', async () => {
    const a = client(tab());
    const b = client(tab());
    const received = { a: [] as unknown[], b: [] as unknown[] };
    a.on('message', message => received.a.push(message));
    b.on('message', message => received.b.push(message));
    a.connect();
    b.connect();
    await vi.waitFor(() => expect(MockWebSocket.instances).toHaveLength(1));
    MockWebSocket.last.open();
    await vi.waitFor(() => {
      expect(a.getSnapshot().status).toBe('open');
      expect(b.getSnapshot().status).toBe('open');
    });

    a.send('from a');
    b.send('from b');
    await vi.waitFor(() => expect(sent()).toEqual(['from a', 'from b']));
    MockWebSocket.last.receive('hello');
    await vi.waitFor(() => expect(received).toEqual({ a: ['hello'], b: ['hello'] }));
    expect(MockWebSocket.instances).toHaveLength(1);
  });

  it("doesn't let a tab unsubscribe a topic another tab holds, and routes topics", async () => {
    const options = {
      json: true,
      topics: {
        subscribe: (m: any) => (m.type === 'sub' ? m.topic : undefined),
        unsubscribe: (m: any) => (m.type === 'unsub' ? m.topic : undefined),
        topic: (m: any) => m.topic
      }
    };
    const a = client(tab(options), true);
    const b = client(tab(options), true);
    const received = { a: [] as unknown[], b: [] as unknown[] };
    a.on('message', (m: any) => received.a.push(m.topic ?? m.text));
    b.on('message', (m: any) => received.b.push(m.topic ?? m.text));
    a.connect();
    b.connect();
    await vi.waitFor(() => expect(MockWebSocket.instances).toHaveLength(1));
    MockWebSocket.last.open();
    await vi.waitFor(() => expect(b.getSnapshot().status).toBe('open'));
    expect(a.getSnapshot().status).toBe('open');

    a.send({ type: 'sub', topic: 'x' });
    b.send({ type: 'sub', topic: 'x' });
    b.send({ type: 'sub', topic: 'y' });
    await vi.waitFor(() => expect(sent()).toHaveLength(3));
    MockWebSocket.last.receive(JSON.stringify({ topic: 'x' }));
    MockWebSocket.last.receive(JSON.stringify({ topic: 'y' }));
    MockWebSocket.last.receive(JSON.stringify({ topic: 'nobody' }));
    MockWebSocket.last.receive(JSON.stringify({ text: 'everyone' }));
    await vi.waitFor(() => expect(received.b).toEqual(['x', 'y', 'everyone']));
    expect(received.a).toEqual(['x', 'everyone']);

    a.send({ type: 'unsub', topic: 'x' });
    b.send({ type: 'unsub', topic: 'y' });
    await vi.waitFor(() => expect(sent()).toHaveLength(4));
    b.send({ type: 'unsub', topic: 'x' });
    await vi.waitFor(() => expect(sent()).toHaveLength(5));
    expect(
      sent()
        .slice(3)
        .map(data => JSON.parse(data as string))
    ).toEqual([
      { type: 'unsub', topic: 'y' },
      { type: 'unsub', topic: 'x' }
    ]);
  });

  it('lets go of a tab that goes away, with its topics, without its client closing', async () => {
    const options = {
      json: true,
      topics: {
        subscribe: (m: any) => (m.type === 'sub' ? m.topic : undefined),
        unsubscribe: (m: any) => (m.type === 'unsub' ? m.topic : undefined)
      }
    };
    const a = client(tab(options), true);
    a.connect();
    await vi.waitFor(() => expect(MockWebSocket.instances).toHaveLength(1));
    MockWebSocket.last.open();
    await vi.waitFor(() => expect(a.getSnapshot().status).toBe('open'));
    const listen = vi.spyOn(window, 'addEventListener');
    // A page that goes away runs nothing more, so its client doesn't reconnect.
    const b = createWebSocket(url, {
      WebSocket: tab(options) as unknown as typeof WebSocket,
      json: true,
      reconnect: false
    });
    clients.push(b);
    b.connect();
    await vi.waitFor(() => expect(b.getSnapshot().status).toBe('open'));
    const pagehide = listen.mock.calls.find(([type]) => type === 'pagehide')![1] as () => void;
    listen.mockRestore();
    a.send({ type: 'sub', topic: 'news' });
    b.send({ type: 'sub', topic: 'news' });
    await vi.waitFor(() => expect(sent()).toHaveLength(2));

    pagehide(); // b's page closes
    expect(b.getSnapshot().status).toBe('closed');
    a.send({ type: 'unsub', topic: 'news' });
    await vi.waitFor(() => expect(sent()).toHaveLength(3));
    expect(JSON.parse(sent()[2] as string)).toEqual({ type: 'unsub', topic: 'news' });
    // Nothing holds the shared socket once a lets go.
    a.close();
    await vi.waitFor(() => expect(MockWebSocket.last.closedWith).toBeDefined());
  });

  it('passes on messages that are not JSON, such as heartbeat pings, with topics', async () => {
    // As in the guide: these throw for a message that isn't an object.
    const a = client(
      tab({
        json: true,
        topics: {
          subscribe: (m: any) => (m.type === 'subscribe' ? m.topic : undefined),
          unsubscribe: (m: any) => (m.type === 'unsubscribe' ? m.topic : undefined),
          topic: (m: any) => m.topic
        }
      })
    );
    const received: unknown[] = [];
    a.on('message', message => received.push(message));
    a.connect();
    await vi.waitFor(() => expect(MockWebSocket.instances).toHaveLength(1));
    MockWebSocket.last.open();
    await vi.waitFor(() => expect(a.getSnapshot().status).toBe('open'));
    a.send('ping');
    a.send('null');
    await vi.waitFor(() => expect(sent()).toEqual(['ping', 'null']));
    MockWebSocket.last.receive('pong');
    MockWebSocket.last.receive('42');
    await vi.waitFor(() => expect(received).toEqual(['pong', '42']));
  });

  it('hands over to another tab when the leading one goes away', async () => {
    const first = tab();
    const a = client(first);
    a.connect();
    await vi.waitFor(() => expect(MockWebSocket.instances).toHaveLength(1));
    const b = client(tab());
    b.connect();
    MockWebSocket.last.open();
    await vi.waitFor(() => expect(b.getSnapshot().status).toBe('open'));

    // The leading tab closes: the next one leads, and b reconnects through it.
    first.dispose();
    a.close(); // the closed tab's page is gone with it
    await vi.waitFor(() => expect(MockWebSocket.instances).toHaveLength(2));
    MockWebSocket.last.open();
    await vi.waitFor(() => expect(b.getSnapshot().status).toBe('open'));
    b.send('after the handover');
    await vi.waitFor(() => expect(MockWebSocket.last.sent).toEqual(['after the handover']));
  });

  it('closes the shared socket a while after the last tab lets go, and reports its closes', async () => {
    const a = client(tab());
    const closes: number[] = [];
    a.on('close', close => closes.push(close.code));
    a.connect();
    await vi.waitFor(() => expect(MockWebSocket.instances).toHaveLength(1));
    const shared = MockWebSocket.last;
    shared.open();
    await vi.waitFor(() => expect(a.getSnapshot().status).toBe('open'));

    // The server closes: every tab's client sees it and reconnects.
    shared.finishClose(1012);
    await vi.waitFor(() => expect(closes).toEqual([1012]));
    await vi.waitFor(() => expect(MockWebSocket.instances).toHaveLength(2));
    MockWebSocket.last.open();
    await vi.waitFor(() => expect(a.getSnapshot().status).toBe('open'));

    a.close();
    expect(a.getSnapshot().status).toBe('closed');
    await vi.waitFor(() =>
      expect(MockWebSocket.last.closedWith).toEqual({ code: 1000, reason: undefined })
    );
  });

  it('opens its own socket where the Web Locks API is missing', async () => {
    setLocks(undefined);
    const a = client(tab());
    const received: unknown[] = [];
    a.on('message', message => received.push(message));
    a.connect();
    expect(MockWebSocket.instances).toHaveLength(1);
    MockWebSocket.last.open();
    expect(a.getSnapshot().status).toBe('open');
    a.send('direct');
    MockWebSocket.last.receive('back');
    expect(MockWebSocket.last.sent).toEqual(['direct']);
    expect(received).toEqual(['back']);
    a.close();
    MockWebSocket.last.finishClose(1000);
  });

  it('gives binary messages the binaryType asked for where the Web Locks API is missing', () => {
    setLocks(undefined);
    const Shared = tab();
    const blobs = createWebSocket(url, { WebSocket: Shared as unknown as typeof WebSocket });
    const buffers = createWebSocket(url, {
      WebSocket: Shared as unknown as typeof WebSocket,
      binaryType: 'arraybuffer'
    });
    clients.push(blobs, buffers);
    const received: unknown[] = [];
    blobs.on('message', message => received.push(message));
    buffers.on('message', message => received.push(message));
    blobs.connect();
    buffers.connect();
    for (const socket of MockWebSocket.instances) {
      // Its own socket hands over ArrayBuffers, which it turns into what was asked for.
      expect(socket.binaryType).toBe('arraybuffer');
      socket.open();
      socket.receive(new ArrayBuffer(2));
    }
    expect(received[0]).toBeInstanceOf(Blob);
    expect(received[1]).toBeInstanceOf(ArrayBuffer);
  });

  it('throws during a server render, like any WebSocket would be missing', () => {
    const Shared = tab();
    vi.stubGlobal('window', undefined);
    expect(() => new Shared('ws://x')).toThrow('server render');
  });
});
