// An entry with no imports: it only implements the `WebSocket` interface.

/** Options for {@link createWebTransportSocket}. */
export interface WebTransportSocketOptions {
  /**
   * The WebTransport URL for the client's WebSocket URL.
   * @default `ws:` and `wss:` become `https:`
   */
  url?: (url: string) => string;
  /** Options for the `WebTransport` constructor, e.g. `serverCertificateHashes` in development. */
  transport?: WebTransportOptions;
  /**
   * The `WebSocket` to connect with where WebTransport isn't available, or when a session can't be
   * established, to the client's own URL. `false` fails the connection instead.
   * @default the global WebSocket
   */
  fallback?: typeof WebSocket | false;
  /**
   * How long to wait for a WebTransport session before falling back, in ms. UDP is blocked on
   * some networks, where the attempt only fails after a long time.
   * @default 5000
   */
  timeout?: number;
  /**
   * Send `volatile` messages as datagrams, which can be lost even while connected. `false` sends
   * every message on the stream.
   * @default true
   */
  datagrams?: boolean;
}

/** The class from {@link createWebTransportSocket}. */
export interface WebTransportWebSocket {
  new (url: string | URL, protocols?: string | string[]): WebSocket;
  readonly prototype: WebSocket;
  readonly CONNECTING: 0;
  readonly OPEN: 1;
  readonly CLOSING: 2;
  readonly CLOSED: 3;
  /** Whether connections go over WebSocket now, because WebTransport is missing or failed. */
  readonly fallingBack: boolean;
}

const CONNECTING = 0;
const OPEN = 1;
const CLOSING = 2;
const CLOSED = 3;
const TEXT = 0;
const BINARY = 1;

/** The method the client calls for `volatile` sends, where a socket has it. */
const DATAGRAM = Symbol.for('react-websocket.datagram');

type Data = Parameters<WebSocket['send']>[0];

function closeEvent(code: number, reason: string, wasClean: boolean): Event {
  const init = { code, reason, wasClean };
  // Node 22 has no CloseEvent.
  return typeof CloseEvent === 'function'
    ? new CloseEvent('close', init)
    : Object.assign(new Event('close'), init);
}

function bytes(data: Exclude<Data, Blob>): [number, Uint8Array] {
  if (typeof data === 'string') return [TEXT, new TextEncoder().encode(data)];
  if (data instanceof ArrayBuffer) return [BINARY, new Uint8Array(data)];
  return [BINARY, new Uint8Array(data.buffer, data.byteOffset, data.byteLength)];
}

/**
 * Connect over [WebTransport](https://developer.mozilla.org/en-US/docs/Web/API/WebTransport_API)
 * behind the same client API. Pass the returned class as the `WebSocket` option: messages go on
 * one reliable, ordered stream, and `volatile` sends go as datagrams, which are never queued or
 * retransmitted, so stale input or cursor positions don't hold up what comes after them.
 *
 * Where WebTransport isn't available, or a session can't be established within `timeout`, it
 * connects with a WebSocket to the client's own URL instead, and keeps doing so for later
 * connections.
 *
 * The server speaks a small framing over WebTransport: see the guide.
 *
 * @example
 * ```ts
 * import { createWebTransportSocket } from 'react-websocket/webtransport';
 *
 * export const game = createWebSocket('wss://game.example.com/play', {
 *   json: true,
 *   WebSocket: createWebTransportSocket()
 * });
 *
 * game.send({ type: 'aim', angle }, { volatile: true }); // a datagram
 * ```
 */
export function createWebTransportSocket(
  options: WebTransportSocketOptions = {}
): WebTransportWebSocket {
  const mapUrl = options.url ?? ((url: string) => url.replace(/^ws(s?):/, 'https:'));
  const timeout = options.timeout ?? 5000;
  let fallingBack = false;

  class WebTransportSocket extends EventTarget implements WebSocket {
    static readonly CONNECTING = CONNECTING;
    static readonly OPEN = OPEN;
    static readonly CLOSING = CLOSING;
    static readonly CLOSED = CLOSED;
    readonly CONNECTING = CONNECTING;
    readonly OPEN = OPEN;
    readonly CLOSING = CLOSING;
    readonly CLOSED = CLOSED;

    readonly url: string;
    readonly extensions = '';
    onopen: WebSocket['onopen'] = null;
    onmessage: WebSocket['onmessage'] = null;
    onerror: WebSocket['onerror'] = null;
    onclose: WebSocket['onclose'] = null;
    binaryType: BinaryType = 'blob';
    protocol = '';

    #state: WebSocket['readyState'] = CONNECTING;
    #transport: WebTransport | undefined;
    #writer: WritableStreamDefaultWriter<Uint8Array> | undefined;
    #datagrams: WritableStreamDefaultWriter<Uint8Array> | undefined;
    #inner: WebSocket | undefined;
    // Bytes handed to the stream and not yet written, like `bufferedAmount`.
    #buffered = 0;
    // Sends waiting for a Blob to be read, so they keep their order.
    #chain: Promise<void> | undefined;

    static get fallingBack() {
      return fallingBack || typeof WebTransport !== 'function';
    }

    constructor(url: string | URL, protocols?: string | string[]) {
      super();
      if (typeof window === 'undefined') {
        throw new Error('react-websocket/webtransport: no WebSocket here (server render?)');
      }
      for (const type of ['open', 'message', 'error', 'close'] as const) {
        this.addEventListener(type, event =>
          (this[`on${type}`] as ((event: Event) => void) | null)?.call(this, event)
        );
      }
      this.url = String(url);
      if (fallingBack || typeof WebTransport !== 'function') {
        this.#fallBack(protocols);
        return;
      }
      void this.#connect(protocols);
    }

    get readyState() {
      return this.#state;
    }

    get bufferedAmount() {
      return this.#inner?.bufferedAmount ?? this.#buffered;
    }

    send(data: Data) {
      if (this.#state === CONNECTING) {
        throw new DOMException('WebSocket is still in CONNECTING state', 'InvalidStateError');
      }
      if (this.#state !== OPEN) return;
      if (this.#inner) return this.#inner.send(data);
      if (data instanceof Blob || this.#chain) {
        const chain = (this.#chain ?? Promise.resolve()).then(async () => {
          this.#write(...bytes(data instanceof Blob ? await data.arrayBuffer() : data));
          if (this.#chain === chain) this.#chain = undefined;
        });
        this.#chain = chain;
        return;
      }
      this.#write(...bytes(data));
    }

    /** A `volatile` send from the client: a datagram, unless it's too big for one. */
    [DATAGRAM](data: Data) {
      const transport = this.#transport;
      if (
        options.datagrams === false ||
        this.#inner ||
        !transport ||
        data instanceof Blob ||
        this.#state !== OPEN
      ) {
        return this.send(data);
      }
      const [type, payload] = bytes(data);
      if (payload.byteLength + 1 > transport.datagrams.maxDatagramSize) return this.send(data);
      const datagram = new Uint8Array(payload.byteLength + 1);
      datagram[0] = type;
      datagram.set(payload, 1);
      this.#datagrams!.write(datagram).catch(() => {});
    }

    close(code = 1000, reason = '') {
      if (this.#state >= CLOSING) return;
      const connecting = this.#state === CONNECTING;
      this.#state = CLOSING;
      if (this.#inner) return this.#inner.close(code, reason);
      if (!connecting) return this.#transport!.close({ closeCode: code, reason });
      // Not open yet: give up on the session, and report this close rather than its failure.
      this.#transport?.close();
      setTimeout(() => this.#end(code, reason, true), 0);
    }

    async #connect(protocols: string | string[] | undefined) {
      let transport: WebTransport;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        transport = this.#transport = new WebTransport(mapUrl(this.url), options.transport);
        await Promise.race([
          transport.ready,
          new Promise((_, reject) => (timer = setTimeout(reject, timeout, new Error('timeout'))))
        ]);
        const stream = await transport.createBidirectionalStream();
        if (this.#state !== CONNECTING) return transport.close();
        this.#writer = stream.writable.getWriter();
        this.#datagrams = transport.datagrams.writable.getWriter();
        void this.#read(stream.readable.getReader());
        void this.#readDatagrams(transport.datagrams.readable.getReader());
      } catch {
        // No session: fall back to a WebSocket for this connection and the ones after it.
        this.#transport?.close();
        this.#transport = undefined;
        if (this.#state !== CONNECTING) return this.#end(1006, '', false);
        if (options.fallback === false) {
          this.dispatchEvent(new Event('error'));
          return this.#end(1006, '', false);
        }
        fallingBack = true;
        return this.#fallBack(protocols);
      } finally {
        clearTimeout(timer);
      }
      transport.closed.then(
        // A session ended without a code reports 0: like a WebSocket closed without a status.
        info => this.#end(info.closeCode || 1005, info.reason ?? '', true),
        () => {
          this.dispatchEvent(new Event('error'));
          this.#end(1006, '', false);
        }
      );
      this.#state = OPEN;
      this.dispatchEvent(new Event('open'));
    }

    #fallBack(protocols: string | string[] | undefined) {
      const Impl =
        options.fallback === false ? undefined : (options.fallback ?? globalThis.WebSocket);
      if (!Impl) {
        throw new Error('react-websocket/webtransport: no WebTransport, and no fallback');
      }
      const inner = (this.#inner = new Impl(this.url, protocols));
      inner.binaryType = 'arraybuffer';
      inner.onopen = () => {
        this.protocol = inner.protocol;
        this.#state = OPEN;
        this.dispatchEvent(new Event('open'));
      };
      inner.onmessage = event => this.#message(event.data);
      inner.onerror = () => this.dispatchEvent(new Event('error'));
      inner.onclose = event => this.#end(event.code, event.reason, event.wasClean);
    }

    #write(type: number, payload: Uint8Array) {
      const frame = new Uint8Array(payload.byteLength + 5);
      const view = new DataView(frame.buffer);
      view.setUint8(0, type);
      view.setUint32(1, payload.byteLength);
      frame.set(payload, 5);
      this.#buffered += frame.byteLength;
      this.#writer!.write(frame).then(
        () => (this.#buffered -= frame.byteLength),
        () => {}
      );
    }

    /** Reassemble frames from the stream, whatever its chunks. */
    async #read(reader: ReadableStreamDefaultReader<Uint8Array>) {
      let buffer = new Uint8Array(0);
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) return;
          const joined = new Uint8Array(buffer.byteLength + value.byteLength);
          joined.set(buffer);
          joined.set(value, buffer.byteLength);
          buffer = joined;
          while (buffer.byteLength >= 5) {
            const view = new DataView(buffer.buffer, buffer.byteOffset);
            const length = view.getUint32(1);
            if (buffer.byteLength < 5 + length) break;
            this.#frame(view.getUint8(0), buffer.slice(5, 5 + length));
            buffer = buffer.slice(5 + length);
          }
        }
      } catch {
        // The session closed; `closed` reports it.
      }
    }

    async #readDatagrams(reader: ReadableStreamDefaultReader<Uint8Array>) {
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) return;
          if (value.byteLength) this.#frame(value[0]!, value.slice(1));
        }
      } catch {
        // The session closed; `closed` reports it.
      }
    }

    #frame(type: number, payload: Uint8Array) {
      this.#message(type === TEXT ? new TextDecoder().decode(payload) : payload.buffer);
    }

    #message(data: unknown) {
      if (this.#state !== OPEN) return;
      if (data instanceof ArrayBuffer && this.binaryType === 'blob') data = new Blob([data]);
      this.dispatchEvent(new MessageEvent('message', { data }));
    }

    #end(code: number, reason: string, wasClean: boolean) {
      if (this.#state === CLOSED) return;
      this.#state = CLOSED;
      this.dispatchEvent(closeEvent(code, reason, wasClean));
    }
  }

  return WebTransportSocket as unknown as WebTransportWebSocket;
}
