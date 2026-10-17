import { act, render } from '@testing-library/react';
import { IDBFactory } from 'fake-indexeddb';
import { createWebSocket, useWebSocketOutbox } from '../src';
import {
  createWebSocketOutbox,
  indexedDBStorage,
  memoryStorage,
  type OutboxRecord,
  type OutboxStorage,
  type WebSocketOutbox
} from '../src/outbox';
import { MockImpl, MockWebSocket } from './mock';

type In = { type: 'ack'; id: string } | { type: 'chat' };
type Out = { type: 'order'; id: string; order: Order };
type Order = { table: number };

let n = 0;

function setup(
  options: { storage?: OutboxStorage; ack?: boolean; maxAge?: number; onExpire?: () => void } = {}
) {
  const client = createWebSocket<In, Out>(`ws://outbox/${++n}`, {
    WebSocket: MockImpl,
    json: true,
    reconnect: { jitter: 0, minDelay: 1000 }
  });
  const storage = options.storage ?? memoryStorage();
  const outbox = createWebSocketOutbox(client, {
    name: 'orders',
    storage,
    send: (order: Order, id) => ({ type: 'order', id, order }),
    ack:
      options.ack === false ? undefined : message => (message.type === 'ack' ? message.id : null),
    maxAge: options.maxAge,
    onExpire: options.onExpire
  });
  return { client, outbox, storage };
}

const sent = (socket = MockWebSocket.last) => socket.sent.map(data => JSON.parse(data as string));
const ack = (id: string, socket = MockWebSocket.last) =>
  socket.receive(JSON.stringify({ type: 'ack', id }));
const ids = (outbox: WebSocketOutbox<Order>) => outbox.getSnapshot().map(entry => entry.id);

/** Let storage promises settle. */
const settle = () => act(async () => {});

beforeEach(() => {
  MockWebSocket.reset();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('createWebSocketOutbox', () => {
  it('sends each message with its id once open, and keeps it until the server acks it', async () => {
    const { outbox } = setup();
    await outbox.ready;
    const id = await outbox.add({ table: 4 }, 'o-1');
    expect(id).toBe('o-1');
    // Adding holds the connection.
    expect(MockWebSocket.instances).toHaveLength(1);
    expect(outbox.getSnapshot()).toMatchObject([{ id: 'o-1', message: { table: 4 }, sent: false }]);

    MockWebSocket.last.open();
    expect(sent()).toEqual([{ type: 'order', id: 'o-1', order: { table: 4 } }]);
    expect(outbox.getSnapshot()).toMatchObject([{ id: 'o-1', sent: true }]);

    ack('o-1');
    await settle();
    expect(outbox.getSnapshot()).toEqual([]);
  });

  it('sends unacknowledged messages again, in order and with the same ids, on every new connection', async () => {
    const { outbox } = setup();
    await outbox.ready;
    MockWebSocket.reset();
    outbox.add({ table: 1 }, 'a');
    outbox.add({ table: 2 }, 'b');
    MockWebSocket.last.open();
    ack('a');
    MockWebSocket.last.finishClose(1006);
    vi.advanceTimersByTime(1000);
    expect(outbox.getSnapshot()).toMatchObject([{ id: 'b', sent: false }]);

    MockWebSocket.last.open();
    expect(sent()).toEqual([{ type: 'order', id: 'b', order: { table: 2 } }]);
  });

  it("doesn't use the client's send queue", async () => {
    const { client, outbox } = setup();
    await outbox.ready;
    outbox.add({ table: 1 }, 'a');
    client.send({ type: 'order', id: 'direct', order: { table: 9 } });
    MockWebSocket.last.open();
    // Sent from the outbox's `open` listener, ahead of the client's queue, and only once.
    expect(sent().map(message => message.id)).toEqual(['a', 'direct']);
  });

  it('removes a message once sent when there is no ack', async () => {
    const { outbox, storage } = setup({ ack: false });
    await outbox.ready;
    await outbox.add({ table: 1 }, 'a');
    expect(await storage.load()).toHaveLength(1);
    MockWebSocket.last.open();
    await settle();
    expect(outbox.getSnapshot()).toEqual([]);
    expect(await storage.load()).toEqual([]);
  });

  it('restores stored messages after a reload and sends them before new ones', async () => {
    const storage = memoryStorage();
    const first = setup({ storage });
    await first.outbox.ready;
    await first.outbox.add({ table: 1 }, 'old');
    first.outbox.dispose();
    first.client.close();

    // A "reload": a new client and outbox on the same storage.
    const { outbox } = setup({ storage });
    outbox.add({ table: 2 }, 'new');
    MockWebSocket.last.open();
    // Nothing goes out until the stored messages are back.
    expect(sent()).toEqual([]);
    await settle();
    expect(ids(outbox)).toEqual(['old', 'new']);
    expect(sent().map(message => message.id)).toEqual(['old', 'new']);
  });

  it('drops messages older than maxAge instead of sending them', async () => {
    const onExpire = vi.fn();
    const { outbox, storage } = setup({ maxAge: 60_000, onExpire });
    await outbox.ready;
    MockWebSocket.reset();
    await outbox.add({ table: 1 }, 'stale');
    vi.advanceTimersByTime(30_000);
    await outbox.add({ table: 2 }, 'fresh');
    vi.advanceTimersByTime(30_001);
    MockWebSocket.last.open();
    expect(sent().map(message => message.id)).toEqual(['fresh']);
    expect(onExpire).toHaveBeenCalledWith(expect.objectContaining({ id: 'stale' }));
    await settle();
    expect((await storage.load()).map(record => record.id)).toEqual(['fresh']);
  });

  it('holds the connection while messages wait, and releases it when they are acknowledged', async () => {
    const { client, outbox } = setup();
    await outbox.ready;
    expect(client.getSnapshot().status).toBe('idle');
    outbox.add({ table: 1 }, 'a');
    MockWebSocket.last.open();
    ack('a');
    await settle();
    vi.advanceTimersByTime(0);
    expect(client.getSnapshot().status).toBe('idle');
  });

  it('remove() and clear() drop messages, including stored ones not loaded yet', async () => {
    const storage = memoryStorage();
    await storage.put({ id: 'stored', message: { table: 0 }, createdAt: 1 });
    const { outbox } = setup({ storage });
    // Before the stored messages are loaded.
    outbox.remove('stored');
    outbox.add({ table: 1 }, 'a');
    outbox.add({ table: 2 }, 'b');
    await settle();
    expect(ids(outbox)).toEqual(['a', 'b']);

    await outbox.remove('a');
    expect(ids(outbox)).toEqual(['b']);
    await storage.put({ id: 'other-tab', message: { table: 3 }, createdAt: 2 });
    await outbox.clear();
    expect(outbox.getSnapshot()).toEqual([]);
    expect(await storage.load()).toEqual([]);
  });

  it('moves a re-added id to the end', async () => {
    const { outbox } = setup();
    await outbox.ready;
    outbox.add({ table: 1 }, 'a');
    outbox.add({ table: 2 }, 'b');
    outbox.add({ table: 3 }, 'a');
    expect(ids(outbox)).toEqual(['b', 'a']);
    expect(outbox.getSnapshot()[1]!.message).toEqual({ table: 3 });
  });

  it('gives each message a unique id by default', async () => {
    const { outbox } = setup();
    const [a, b] = await Promise.all([outbox.add({ table: 1 }), outbox.add({ table: 2 })]);
    expect(a).toEqual(expect.any(String));
    expect(a).not.toBe(b);
  });

  it('still sends from memory when storage fails', async () => {
    const failing: OutboxStorage = {
      load: () => Promise.reject(new Error('blocked')),
      put: () => Promise.reject(new Error('quota')),
      delete: () => Promise.reject(new Error('blocked'))
    };
    const { outbox } = setup({ storage: failing });
    await expect(outbox.ready).rejects.toThrow('blocked');
    await settle();
    await expect(outbox.add({ table: 1 }, 'a')).rejects.toThrow('quota');
    MockWebSocket.last.open();
    expect(sent().map(message => message.id)).toEqual(['a']);
    ack('a');
    expect(outbox.getSnapshot()).toEqual([]);
  });

  it('sends unacknowledged messages on the new connection after migrate()', async () => {
    const { client, outbox } = setup();
    await outbox.ready;
    outbox.add({ table: 1 }, 'a');
    MockWebSocket.last.open();
    client.migrate();
    vi.advanceTimersByTime(0);
    MockWebSocket.last.open();
    expect(sent().map(message => message.id)).toEqual(['a']);
  });

  it('stops after dispose()', async () => {
    const { client, outbox } = setup();
    await outbox.ready;
    outbox.add({ table: 1 }, 'a');
    outbox.dispose();
    vi.advanceTimersByTime(0);
    expect(client.getSnapshot().status).toBe('idle');
    client.connect();
    MockWebSocket.last.open();
    expect(sent()).toEqual([]);
  });

  it('keeps messages in memory where there is no IndexedDB', async () => {
    const client = createWebSocket<In, Out>('ws://outbox/memory', { WebSocket: MockImpl });
    const outbox = createWebSocketOutbox(client, {
      name: 'memory',
      send: (order: Order, id) => ({ type: 'order' as const, id, order })
    });
    await expect(outbox.ready).resolves.toBeUndefined();
    await expect(outbox.add({ table: 1 }, 'a')).resolves.toBe('a');
  });
});

describe('indexedDBStorage', () => {
  beforeEach(() => {
    vi.useRealTimers();
    vi.stubGlobal('indexedDB', new IDBFactory());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('keeps records across instances with the same name, and apart from other names', async () => {
    const record: OutboxRecord = { id: 'a', message: { table: 1 }, createdAt: 1 };
    await indexedDBStorage('orders').put(record);
    await indexedDBStorage('orders').put({ ...record, id: 'b', createdAt: 2 });
    expect(await indexedDBStorage('orders').load()).toEqual([
      record,
      { ...record, id: 'b', createdAt: 2 }
    ]);
    expect(await indexedDBStorage('other').load()).toEqual([]);

    await indexedDBStorage('orders').delete('a');
    expect((await indexedDBStorage('orders').load()).map(r => r.id)).toEqual(['b']);
  });

  it('is the default where IndexedDB exists', async () => {
    const client = createWebSocket<In, Out>('ws://outbox/idb', { WebSocket: MockImpl });
    const options = {
      name: 'default',
      send: (order: Order, id: string) => ({ type: 'order' as const, id, order })
    };
    const first = createWebSocketOutbox(client, options);
    await first.add({ table: 7 }, 'kept');
    first.dispose();
    const second = createWebSocketOutbox(client, options);
    await second.ready;
    expect(second.getSnapshot()).toMatchObject([{ id: 'kept', message: { table: 7 } }]);
    second.dispose();
    client.close();
  });
});

describe('useWebSocketOutbox', () => {
  it('lists the waiting messages and re-renders when they change', async () => {
    const { outbox } = setup();
    await outbox.ready;
    function Banner() {
      const waiting = useWebSocketOutbox(outbox);
      return <p>{waiting.length} waiting</p>;
    }
    const { container } = render(<Banner />);
    expect(container.textContent).toBe('0 waiting');
    await act(async () => {
      outbox.add({ table: 1 }, 'a');
    });
    expect(container.textContent).toBe('1 waiting');
    MockWebSocket.last.open();
    await act(async () => ack('a'));
    expect(container.textContent).toBe('0 waiting');
  });

  it('lists nothing for null', () => {
    function Banner() {
      return <p>{useWebSocketOutbox(null).length} waiting</p>;
    }
    expect(render(<Banner />).container.textContent).toBe('0 waiting');
  });
});
