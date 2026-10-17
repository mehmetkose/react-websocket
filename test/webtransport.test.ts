import { createWebSocket } from '../src/core';
import { createWebTransportSocket } from '../src/webtransport';
import { MockImpl, MockWebSocket } from './mock';

/** A stream pair the test drives: what the client writes is collected, and `push` feeds it. */
function pipe() {
  const written: Uint8Array[] = [];
  let push!: (chunk: Uint8Array) => void;
  let end!: () => void;
  const readable = new ReadableStream<Uint8Array>({
    start(controller) {
      push = chunk => controller.enqueue(chunk);
      end = () => controller.close();
    }
  });
  const writable = new WritableStream<Uint8Array>({
    write(chunk) {
      written.push(chunk);
    }
  });
  return {
    readable,
    writable,
    written,
    push: (chunk: Uint8Array) => push(chunk),
    end: () => end()
  };
}

/** A stand-in for the browser's WebTransport. */
class FakeTransport {
  static instances: FakeTransport[] = [];
  static get last() {
    return FakeTransport.instances.at(-1)!;
  }
  stream = pipe();
  datagramPipe = pipe();
  datagrams = {
    readable: this.datagramPipe.readable,
    writable: this.datagramPipe.writable,
    maxDatagramSize: 20
  };
  resolveReady!: () => void;
  rejectReady!: (error: unknown) => void;
  ready = new Promise<void>((resolve, reject) => {
    this.resolveReady = resolve;
    this.rejectReady = reject;
  });
  resolveClosed!: (info: { closeCode?: number; reason?: string }) => void;
  rejectClosed!: (error: unknown) => void;
  closed = new Promise<{ closeCode?: number; reason?: string }>((resolve, reject) => {
    this.resolveClosed = resolve;
    this.rejectClosed = reject;
  });
  closedWith: { closeCode?: number; reason?: string } | undefined;
  constructor(
    public url: string,
    public options?: unknown
  ) {
    FakeTransport.instances.push(this);
    this.ready.catch(() => {});
    this.closed.catch(() => {});
  }
  async createBidirectionalStream() {
    return { readable: this.stream.readable, writable: this.stream.writable };
  }
  close(info?: { closeCode?: number; reason?: string }) {
    this.closedWith = info ?? {};
    this.resolveClosed(info ?? { closeCode: 0, reason: '' });
  }
}

function frame(type: number, payload: Uint8Array | string) {
  const body = typeof payload === 'string' ? new TextEncoder().encode(payload) : payload;
  const bytes = new Uint8Array(body.byteLength + 5);
  new DataView(bytes.buffer).setUint8(0, type);
  new DataView(bytes.buffer).setUint32(1, body.byteLength);
  bytes.set(body, 5);
  return bytes;
}

const decode = (bytes: Uint8Array) => ({
  type: bytes[0],
  text: new TextDecoder().decode(bytes.slice(5))
});

async function connected(options: Parameters<typeof createWebTransportSocket>[0] = {}) {
  const Transport = createWebTransportSocket({ fallback: MockImpl, ...options });
  const client = createWebSocket('wss://game.example.com/play', {
    WebSocket: Transport as unknown as typeof WebSocket,
    binaryType: 'arraybuffer',
    reconnect: false
  });
  const received: unknown[] = [];
  const closes: string[] = [];
  client.on('message', message => received.push(message));
  client.on('close', close => closes.push(`${close.code} ${close.reason}`));
  client.connect();
  return { Transport, client, received, closes };
}

beforeEach(() => {
  MockWebSocket.reset();
  FakeTransport.instances = [];
  vi.stubGlobal('WebTransport', FakeTransport);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('createWebTransportSocket', () => {
  it('connects over WebTransport, with messages framed on one stream', async () => {
    const { client, received } = await connected();
    expect(FakeTransport.last.url).toBe('https://game.example.com/play');
    FakeTransport.last.resolveReady();
    await vi.waitFor(() => expect(client.getSnapshot().status).toBe('open'));

    client.send('hello');
    client.send(new Uint8Array([1, 2]));
    await vi.waitFor(() =>
      expect(FakeTransport.last.stream.written.map(decode)).toEqual([
        { type: 0, text: 'hello' },
        { type: 1, text: '\x01\x02' }
      ])
    );

    // Frames split and joined across chunks.
    const both = new Uint8Array([...frame(0, 'one'), ...frame(1, new Uint8Array([9]))]);
    FakeTransport.last.stream.push(both.slice(0, 4));
    FakeTransport.last.stream.push(both.slice(4, 10));
    FakeTransport.last.stream.push(both.slice(10));
    await vi.waitFor(() => expect(received).toHaveLength(2));
    expect(received[0]).toBe('one');
    expect(new Uint8Array(received[1] as ArrayBuffer)).toEqual(new Uint8Array([9]));
  });

  it('sends volatile messages as datagrams, unless too big for one', async () => {
    const { client, received } = await connected();
    FakeTransport.last.resolveReady();
    await vi.waitFor(() => expect(client.getSnapshot().status).toBe('open'));
    client.send('aim 10', { volatile: true });
    client.send('a much longer message', { volatile: true });
    await vi.waitFor(() => expect(FakeTransport.last.datagramPipe.written).toHaveLength(1));
    const [datagram] = FakeTransport.last.datagramPipe.written;
    expect(datagram![0]).toBe(0);
    expect(new TextDecoder().decode(datagram!.slice(1))).toBe('aim 10');
    await vi.waitFor(() =>
      expect(FakeTransport.last.stream.written.map(decode)).toEqual([
        { type: 0, text: 'a much longer message' }
      ])
    );

    FakeTransport.last.datagramPipe.push(new Uint8Array([0, ...new TextEncoder().encode('pos')]));
    await vi.waitFor(() => expect(received).toEqual(['pos']));
  });

  it('sends everything on the stream with `datagrams: false`', async () => {
    const { client } = await connected({ datagrams: false });
    FakeTransport.last.resolveReady();
    await vi.waitFor(() => expect(client.getSnapshot().status).toBe('open'));
    client.send('aim', { volatile: true });
    await vi.waitFor(() =>
      expect(FakeTransport.last.stream.written.map(decode)).toEqual([{ type: 0, text: 'aim' }])
    );
    expect(FakeTransport.last.datagramPipe.written).toEqual([]);
  });

  it('reports the close code and reason of the session', async () => {
    const { client, closes } = await connected();
    FakeTransport.last.resolveReady();
    await vi.waitFor(() => expect(client.getSnapshot().status).toBe('open'));
    FakeTransport.last.resolveClosed({ closeCode: 4001, reason: 'kicked' });
    await vi.waitFor(() => expect(closes).toEqual(['4001 kicked']));
  });

  it('reports 1005 for a session closed without a code, and 1006 when it fails', async () => {
    const first = await connected();
    FakeTransport.last.resolveReady();
    await vi.waitFor(() => expect(first.client.getSnapshot().status).toBe('open'));
    FakeTransport.last.resolveClosed({ closeCode: 0, reason: '' });
    await vi.waitFor(() => expect(first.closes).toEqual(['1005 ']));

    const second = await connected();
    const errors: unknown[] = [];
    second.client.on('error', error => errors.push(error));
    FakeTransport.last.resolveReady();
    await vi.waitFor(() => expect(second.client.getSnapshot().status).toBe('open'));
    FakeTransport.last.rejectClosed(new Error('lost'));
    await vi.waitFor(() => expect(second.closes).toEqual(['1006 ']));
    expect(errors).toHaveLength(1);
  });

  it('closes the session with the code the app gives', async () => {
    const { client, closes } = await connected();
    FakeTransport.last.resolveReady();
    await vi.waitFor(() => expect(client.getSnapshot().status).toBe('open'));
    client.close(4002, 'bye');
    expect(FakeTransport.last.closedWith).toEqual({ closeCode: 4002, reason: 'bye' });
    await vi.waitFor(() => expect(closes).toEqual(['4002 bye']));
  });

  it('falls back to a WebSocket when a session fails, and keeps doing so', async () => {
    const { Transport, client, received } = await connected();
    expect(Transport.fallingBack).toBe(false);
    FakeTransport.last.rejectReady(new Error('UDP blocked'));
    await vi.waitFor(() => expect(MockWebSocket.instances).toHaveLength(1));
    expect(MockWebSocket.last.url).toBe('wss://game.example.com/play');
    MockWebSocket.last.open();
    MockWebSocket.last.receive('over websocket');
    expect(client.getSnapshot().status).toBe('open');
    expect(received).toEqual(['over websocket']);
    client.send('hi', { volatile: true });
    expect(MockWebSocket.last.sent).toEqual(['hi']);
    expect(Transport.fallingBack).toBe(true);

    client.reconnect();
    expect(FakeTransport.instances).toHaveLength(1);
    expect(MockWebSocket.instances).toHaveLength(2);
    client.close();
  });

  it('falls back after `timeout` when no session comes', async () => {
    vi.useFakeTimers();
    const { client } = await connected({ timeout: 1000 });
    await vi.advanceTimersByTimeAsync(999);
    expect(MockWebSocket.instances).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(MockWebSocket.instances).toHaveLength(1);
    client.close();
    vi.useRealTimers();
  });

  it('fails instead with `fallback: false`, and uses a WebSocket where WebTransport is missing', async () => {
    const { client, closes } = await connected({ fallback: false });
    const errors: unknown[] = [];
    client.on('error', error => errors.push(error));
    FakeTransport.last.rejectReady(new Error('no'));
    await vi.waitFor(() => expect(closes).toEqual(['1006 ']));
    expect(errors).toHaveLength(1);

    vi.stubGlobal('WebTransport', undefined);
    const missing = await connected();
    expect(missing.Transport.fallingBack).toBe(true);
    expect(MockWebSocket.instances).toHaveLength(1);
    missing.client.close();
    expect(() => new (createWebTransportSocket({ fallback: false }))('wss://x')).toThrow(
      'no fallback'
    );
  });

  it('reports the close the app asked for while connecting', async () => {
    const { client, closes } = await connected();
    client.close(4003, 'never mind');
    await vi.waitFor(() => expect(closes).toEqual(['4003 never mind']));
    FakeTransport.last.resolveReady();
  });

  it('keeps the order of a Blob and what follows it, and counts what is buffered', async () => {
    const { client, Transport } = await connected();
    FakeTransport.last.resolveReady();
    await vi.waitFor(() => expect(client.getSnapshot().status).toBe('open'));
    client.send(new Blob(['first']));
    client.send('second');
    expect(client.socket!.bufferedAmount).toBe(0);
    await vi.waitFor(() =>
      expect(FakeTransport.last.stream.written.map(decode)).toEqual([
        { type: 1, text: 'first' },
        { type: 0, text: 'second' }
      ])
    );
    await vi.waitFor(() => expect(client.socket!.bufferedAmount).toBe(0));
    expect(Transport.OPEN).toBe(1);
  });

  it('throws during a server render', () => {
    const Transport = createWebTransportSocket();
    vi.stubGlobal('window', undefined);
    expect(() => new Transport('wss://x')).toThrow('server render');
  });
});
