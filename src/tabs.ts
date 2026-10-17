// An entry with no imports: it only implements the `WebSocket` interface.

/** Recognize topic subscriptions, so tabs sharing a socket don't unsubscribe each other. */
export interface TabsTopics {
  /** The topic an outgoing message subscribes to, or `undefined`. */
  subscribe: (message: any) => string | null | undefined;
  /** The topic an outgoing message unsubscribes from, or `undefined`. */
  unsubscribe: (message: any) => string | null | undefined;
  /**
   * The topic of an incoming message, to deliver it only to the tabs that hold that topic.
   * Without it, every tab gets every message.
   */
  topic?: (message: any) => string | null | undefined;
}

/** Options for {@link createTabsWebSocket}. */
export interface TabsWebSocketOptions {
  /** The `WebSocket` the leading tab opens. Defaults to the global one. */
  WebSocket?: typeof WebSocket;
  /** Messages are JSON: the `topics` functions get them parsed. */
  json?: boolean;
  /** Share topic subscriptions between tabs. See {@link TabsTopics}. */
  topics?: TabsTopics;
  /**
   * How long the leading tab keeps the shared socket open after the last tab using it lets go,
   * in ms, so a reload doesn't close and reopen it.
   * @default 1000
   */
  linger?: number;
}

/** The class from {@link createTabsWebSocket}: a `WebSocket`, plus a way to stop sharing. */
export interface TabsWebSocket {
  new (url: string | URL, protocols?: string | string[]): WebSocket;
  readonly prototype: WebSocket;
  readonly CONNECTING: 0;
  readonly OPEN: 1;
  readonly CLOSING: 2;
  readonly CLOSED: 3;
  /**
   * Stop leading and listening in this tab: close the shared sockets it holds and let another
   * tab take over. For tests and hot module reloading; a closed tab does this by itself.
   */
  dispose(): void;
}

const CONNECTING = 0;
const OPEN = 1;
const CLOSING = 2;
const CLOSED = 3;

/** What tabs say to each other over the channel. */
type Signal =
  | { t: 'connect'; id: string }
  | { t: 'send'; id: string; data: unknown }
  | { t: 'disconnect'; id: string }
  | { t: 'open'; id: string; protocol: string }
  | { t: 'message'; data: unknown; to?: string[] }
  | { t: 'close'; code: number; reason: string; wasClean: boolean }
  | { t: 'leader' };

function closeEvent(code: number, reason: string, wasClean: boolean): Event {
  const init = { code, reason, wasClean };
  // Node 22 has no CloseEvent.
  return typeof CloseEvent === 'function'
    ? new CloseEvent('close', init)
    : Object.assign(new Event('close'), init);
}

let ids = 0;

/**
 * Share one WebSocket between all the tabs of an app. Pass the returned class as the
 * `WebSocket` option: every tab keeps its own client, with its own reconnects, queue, topics and
 * hooks, but only one tab, the leader, opens a connection to the server. The others reach it
 * through a `BroadcastChannel`. Users with ten tabs open cost the server one connection, not ten.
 *
 * - The leader is elected with the Web Locks API. When its tab closes, another tab takes over,
 *   and every tab's client reconnects through it.
 * - Each tab's sends go out on the shared socket. Every message from the server reaches every
 *   tab, or, with `topics`, only the tabs that hold its topic.
 * - With `topics`, an unsubscribe goes to the server only when no other tab still holds the topic.
 *
 * Where `BroadcastChannel` or the Web Locks API is missing, each tab opens its own socket, as
 * without this.
 *
 * @example
 * ```ts
 * import { createTabsWebSocket } from 'react-websocket/tabs';
 *
 * export const live = createWebSocket(url, {
 *   json: true,
 *   WebSocket: createTabsWebSocket({
 *     json: true,
 *     topics: {
 *       subscribe: message => (message.type === 'subscribe' ? message.topic : undefined),
 *       unsubscribe: message => (message.type === 'unsubscribe' ? message.topic : undefined),
 *       topic: message => message.topic
 *     }
 *   })
 * });
 * ```
 */
export function createTabsWebSocket(options: TabsWebSocketOptions = {}): TabsWebSocket {
  const linger = options.linger ?? 1000;
  // One per URL in this tab: it waits to lead, and leads while it holds the lock.
  const agents = new Map<string, { channel: BroadcastChannel; stop: () => void }>();

  const read = (data: unknown) => {
    if (!options.json || typeof data !== 'string') return data;
    try {
      return JSON.parse(data);
    } catch {
      return undefined;
    }
  };

  function agent(key: string, url: string, protocols: string | string[] | undefined) {
    if (agents.has(key)) return;
    const channel = new BroadcastChannel(key);
    const post = (signal: Signal) => channel.postMessage(signal);
    let real: WebSocket | undefined;
    // The tabs' sockets on the shared one, and whether each has been told it's open.
    const clients = new Map<string, boolean>();
    // Who holds each topic, so an unsubscribe waits for the last one.
    const holders = new Map<string, Set<string>>();
    let lingerTimer: ReturnType<typeof setTimeout> | undefined;
    let release: (() => void) | undefined;

    function opened(id: string) {
      clients.set(id, true);
      post({ t: 'open', id, protocol: real!.protocol });
    }

    function connect() {
      if (real) return;
      const Impl = options.WebSocket ?? globalThis.WebSocket;
      let socket: WebSocket;
      try {
        socket = real = new Impl(url, protocols);
      } catch {
        clients.clear();
        return post({ t: 'close', code: 1006, reason: '', wasClean: false });
      }
      socket.binaryType = 'arraybuffer';
      socket.onopen = () => {
        for (const [id, told] of clients) if (!told) opened(id);
      };
      socket.onmessage = event => {
        const topic = options.topics?.topic?.(read(event.data));
        if (topic == null) return post({ t: 'message', data: event.data });
        const to = [...(holders.get(topic) ?? [])];
        if (to.length) post({ t: 'message', data: event.data, to });
      };
      socket.onerror = () => {};
      socket.onclose = event => {
        if (real !== socket) return;
        real = undefined;
        clients.clear();
        holders.clear();
        post({ t: 'close', code: event.code, reason: event.reason, wasClean: event.wasClean });
      };
    }

    function send(id: string, data: unknown) {
      const { topics } = options;
      if (topics) {
        const message = read(data);
        const subscribed = topics.subscribe(message);
        if (subscribed != null) {
          if (!holders.has(subscribed)) holders.set(subscribed, new Set());
          holders.get(subscribed)!.add(id);
        }
        const unsubscribed = topics.unsubscribe(message);
        if (unsubscribed != null) {
          const set = holders.get(unsubscribed);
          set?.delete(id);
          if (set?.size) return; // another tab still holds it
          holders.delete(unsubscribed);
        }
      }
      if (real?.readyState === OPEN) real.send(data as Parameters<WebSocket['send']>[0]);
    }

    function handle(signal: Signal) {
      if (signal.t === 'connect') {
        clearTimeout(lingerTimer);
        clients.set(signal.id, false);
        connect();
        if (real?.readyState === OPEN) opened(signal.id);
      } else if (signal.t === 'send') {
        if (clients.get(signal.id)) send(signal.id, signal.data);
      } else if (signal.t === 'disconnect') {
        clients.delete(signal.id);
        for (const set of holders.values()) set.delete(signal.id);
        if (!clients.size) {
          clearTimeout(lingerTimer);
          lingerTimer = setTimeout(() => {
            if (clients.size || !real) return;
            // Forget it first: a tab connecting while it closes gets a new one.
            const socket = real;
            real = undefined;
            socket.close(1000);
          }, linger);
        }
      }
    }

    agents.set(key, {
      channel,
      stop() {
        clearTimeout(lingerTimer);
        channel.close();
        if (real) {
          real.onclose = null;
          real.close(1000);
        }
        release?.();
      }
    });
    void navigator.locks.request(key, () => {
      if (!agents.has(key)) return;
      channel.onmessage = event => handle(event.data as Signal);
      // Sockets that were using the tab that led before start over with this one.
      post({ t: 'leader' });
      // Lead until this tab goes away, or `dispose()`.
      return new Promise<void>(resolve => (release = resolve));
    });
  }

  const Fallback = options.WebSocket;

  class TabSocket extends EventTarget implements WebSocket {
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

    #id = `${Date.now().toString(36)}-${++ids}-${Math.random().toString(36).slice(2)}`;
    #state: WebSocket['readyState'] = CONNECTING;
    #channel: BroadcastChannel | undefined;
    // Without `BroadcastChannel` or locks: a socket of this tab's own.
    #inner: WebSocket | undefined;

    static dispose() {
      for (const { stop } of agents.values()) stop();
      agents.clear();
    }

    constructor(url: string | URL, protocols?: string | string[]) {
      super();
      if (typeof window === 'undefined') {
        throw new Error('react-websocket/tabs: no WebSocket here (server render?)');
      }
      for (const type of ['open', 'message', 'error', 'close'] as const) {
        this.addEventListener(type, event =>
          (this[`on${type}`] as ((event: Event) => void) | null)?.call(this, event)
        );
      }
      this.url = String(url);
      if (typeof BroadcastChannel === 'undefined' || !globalThis.navigator?.locks) {
        const inner = (this.#inner = new (Fallback ?? globalThis.WebSocket)(url, protocols));
        inner.onopen = () => this.#open(inner.protocol);
        inner.onmessage = event => this.#message(event.data);
        inner.onerror = () => this.dispatchEvent(new Event('error'));
        inner.onclose = event => this.#end(event.code, event.reason, event.wasClean);
        return;
      }
      const key = `react-websocket-tabs:${this.url}\u0000${JSON.stringify(protocols ?? null)}`;
      agent(key, this.url, protocols);
      const channel = (this.#channel = new BroadcastChannel(key));
      channel.onmessage = event => this.#signal(event.data as Signal);
      this.#post({ t: 'connect', id: this.#id });
    }

    get readyState() {
      return this.#state;
    }

    get bufferedAmount() {
      return this.#inner?.bufferedAmount ?? 0;
    }

    send(data: Parameters<WebSocket['send']>[0]) {
      if (this.#state === CONNECTING) {
        throw new DOMException('WebSocket is still in CONNECTING state', 'InvalidStateError');
      }
      if (this.#state !== OPEN) return;
      if (this.#inner) this.#inner.send(data);
      else this.#post({ t: 'send', id: this.#id, data });
    }

    close(code = 1000, reason = '') {
      if (this.#state >= CLOSING) return;
      this.#state = CLOSING;
      if (this.#inner) return this.#inner.close(code, reason);
      // Only this tab's socket closes; the shared one stays for the others.
      this.#post({ t: 'disconnect', id: this.#id });
      setTimeout(() => this.#end(code, reason, true), 0);
    }

    #post(signal: Signal) {
      this.#channel?.postMessage(signal);
    }

    #signal(signal: Signal) {
      if (signal.t === 'open') {
        if (signal.id === this.#id && this.#state === CONNECTING) this.#open(signal.protocol);
      } else if (signal.t === 'message') {
        if (!signal.to || signal.to.includes(this.#id)) this.#message(signal.data);
      } else if (signal.t === 'close') {
        if (this.#state !== CONNECTING) this.#end(signal.code, signal.reason, signal.wasClean);
        else {
          // The shared socket failed before this one opened.
          this.dispatchEvent(new Event('error'));
          this.#end(signal.code, signal.reason, false);
        }
      } else if (signal.t === 'leader') {
        // A new leading tab: start over with it, or ask it to connect us.
        if (this.#state === CONNECTING) this.#post({ t: 'connect', id: this.#id });
        else this.#end(1006, '', false);
      }
    }

    #open(protocol: string) {
      this.#state = OPEN;
      this.protocol = protocol;
      this.dispatchEvent(new Event('open'));
    }

    #message(data: unknown) {
      if (this.#state !== OPEN) return;
      if (data instanceof ArrayBuffer && this.binaryType === 'blob') data = new Blob([data]);
      this.dispatchEvent(new MessageEvent('message', { data }));
    }

    #end(code: number, reason: string, wasClean: boolean) {
      if (this.#state === CLOSED) return;
      this.#state = CLOSED;
      this.#channel?.close();
      this.dispatchEvent(closeEvent(code, reason, wasClean));
    }
  }

  return TabSocket as unknown as TabsWebSocket;
}
