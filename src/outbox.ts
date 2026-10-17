// Types only: the built entry has no imports, and its declarations point at `core`'s.
import type { WebSocketClient } from './core';

/** What an outbox stores for each message. */
export interface OutboxRecord<M = unknown> {
  /** The message's idempotency key, sent with it every time. */
  readonly id: string;
  /** The message, as passed to `add()`. */
  readonly message: M;
  /** When it was added, from `Date.now()`. Entries are sent in this order. */
  readonly createdAt: number;
}

/** A message waiting in the outbox. */
export interface OutboxEntry<M = unknown> extends OutboxRecord<M> {
  /** Sent on the current connection, and waiting for the server's ack. */
  readonly sent: boolean;
}

/**
 * Where an outbox keeps its messages. The default, {@link indexedDBStorage}, keeps them across
 * reloads. Pass your own to store them elsewhere, or {@link memoryStorage} in tests.
 */
export interface OutboxStorage {
  /** Every stored record, in any order. */
  load(): Promise<OutboxRecord[]>;
  put(record: OutboxRecord): Promise<void>;
  delete(id: string): Promise<void>;
}

/** Options for {@link createWebSocketOutbox}. */
export interface WebSocketOutboxOptions<M, In, Out> {
  /**
   * Names the outbox's IndexedDB database, `react-websocket-outbox:<name>`. Give each outbox
   * its own. Unused with `storage`.
   */
  name: string;
  /**
   * Build the message to send for an entry, with its `id` as the idempotency key: the server
   * should do nothing for an id it has already handled, except acknowledge it again. Annotate
   * `message`: that's what `outbox.add()` accepts.
   */
  send: (message: M, id: string) => Out;
  /**
   * Recognize the server's acknowledgement and return the id it confirms, or `undefined` (or
   * `null`) for any other message. An entry stays until it's acknowledged, and is sent again
   * on every new connection until then. Without `ack`, an entry is removed once it has been
   * sent, so one sent just before the connection dropped can be lost.
   */
  ack?: (message: In) => string | null | undefined;
  /**
   * Drop an entry instead of sending it once it's older than this many ms. Checked when it
   * would be sent: on a new connection, and when stored entries are loaded.
   * @default Infinity
   */
  maxAge?: number;
  /** Called with each entry dropped by `maxAge`. */
  onExpire?: (entry: OutboxEntry<M>) => void;
  /**
   * Where to keep entries.
   * @default indexedDBStorage(name), or memoryStorage() where IndexedDB doesn't exist
   */
  storage?: OutboxStorage;
}

/** A persistent outbox on one client. Create with {@link createWebSocketOutbox}. */
export interface WebSocketOutbox<M> {
  /** The client the entries are sent on. */
  readonly client: WebSocketClient<any, any>;
  /**
   * Resolves once the entries stored by an earlier page load are back in the outbox, and
   * rejects if they couldn't be loaded. Nothing is sent before.
   */
  readonly ready: Promise<void>;
  /**
   * Add a message and send it as soon as the socket is open. Resolves with its id once it's
   * stored, and rejects if storing failed; the entry is still sent from memory then, but won't
   * survive a reload.
   * @param id - The idempotency key, e.g. an order number. A new random one by default.
   */
  add(message: M, id?: string): Promise<string>;
  /** Remove an entry without sending it again, e.g. when the user cancels it. */
  remove(id: string): Promise<void>;
  /** Remove every entry, e.g. on logout. */
  clear(): Promise<void>;
  /** The waiting entries, oldest first. A new array on every change. */
  getSnapshot(): readonly OutboxEntry<M>[];
  /** Get notified when the entries change. Compatible with `useSyncExternalStore`. */
  subscribe(listener: () => void): () => void;
  /** Stop sending and listening, and release the connection. Stored entries stay stored. */
  dispose(): void;
}

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** Keep outbox entries in IndexedDB, in the database `react-websocket-outbox:<name>`. */
export function indexedDBStorage(name: string): OutboxStorage {
  let db: Promise<IDBDatabase> | undefined;
  const store = async (mode: IDBTransactionMode) => {
    db ??= new Promise((resolve, reject) => {
      const open = indexedDB.open(`react-websocket-outbox:${name}`, 1);
      open.onupgradeneeded = () => open.result.createObjectStore('entries', { keyPath: 'id' });
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error);
    });
    return (await db).transaction('entries', mode).objectStore('entries');
  };
  return {
    load: async () => request((await store('readonly')).getAll()),
    async put(record) {
      await request((await store('readwrite')).put(record));
    },
    delete: async id => request((await store('readwrite')).delete(id))
  };
}

/** Keep outbox entries in memory only: they don't survive a reload. For tests and servers. */
export function memoryStorage(): OutboxStorage {
  const records = new Map<string, OutboxRecord>();
  return {
    load: async () => [...records.values()],
    put: async record => void records.set(record.id, record),
    delete: async id => void records.delete(id)
  };
}

function randomId() {
  // `randomUUID` needs a secure context; plain-HTTP pages fall back to a timestamp and random digits.
  return (
    globalThis.crypto?.randomUUID?.() ??
    `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
  );
}

const noop = () => {};

/**
 * Keep messages until the server acknowledges them, across reconnects and page reloads, for
 * apps that must not lose a message on flaky Wi-Fi: point of sale, field service, warehouses.
 *
 * - `add(message)` stores the message (in IndexedDB by default) and sends it, tagged with an
 *   idempotency key, as soon as the socket is open.
 * - It stays until the server acknowledges that key (`ack`). Every new connection sends the
 *   unacknowledged entries again, in order, so the server must ignore a key it has already
 *   handled and acknowledge it again.
 * - After a reload, the stored entries are loaded and sent before new ones.
 * - While entries are waiting, the outbox holds the client's connection open.
 *
 * Its entries don't go through the client's send queue, so `queue` options don't apply to them.
 *
 * @example
 * ```ts
 * import { createWebSocketOutbox } from 'react-websocket/outbox';
 *
 * export const orders = createWebSocketOutbox(pos, {
 *   name: 'orders',
 *   send: (order: Order, id) => ({ type: 'order', id, order }),
 *   ack: message => (message.type === 'ack' ? message.id : undefined)
 * });
 *
 * await orders.add({ table: 4, items });
 * ```
 */
// `const` + `NoInfer`: take `In` and `Out` from the client only; `M` comes from how `send`
// annotates its parameter.
export function createWebSocketOutbox<M, In, const Out>(
  client: WebSocketClient<In, Out>,
  options: WebSocketOutboxOptions<M, NoInfer<In>, NoInfer<Out>>
): WebSocketOutbox<M> {
  const storage =
    options.storage ??
    (typeof indexedDB === 'undefined' ? memoryStorage() : indexedDBStorage(options.name));
  const maxAge = options.maxAge ?? Infinity;
  // Insertion order is `createdAt` order: entries loaded from storage are sorted in.
  let entries = new Map<string, OutboxEntry<M>>();
  let snapshot: readonly OutboxEntry<M>[] = [];
  const listeners = new Set<() => void>();
  let loaded = false;
  // Removed (or acknowledged) before the stored entries were loaded: don't restore them.
  const removed = new Set<string>();
  let disposed = false;
  let release: (() => void) | undefined;
  // A strictly increasing `createdAt`, so entries added in the same ms keep their order.
  let lastCreated = 0;

  function changed() {
    snapshot = [...entries.values()];
    // Hold the connection while anything is waiting, so it gets delivered.
    if (snapshot.length && !release && !disposed) release = client.acquire();
    else if (!snapshot.length && release) {
      release();
      release = undefined;
    }
    for (const listener of [...listeners]) listener();
  }

  // Also deletes a stored entry that isn't loaded yet, so it doesn't come back.
  function forget(id: string) {
    if (!loaded) removed.add(id);
    if (entries.delete(id)) changed();
    return storage.delete(id);
  }

  function flush() {
    if (!loaded || disposed || client.getSnapshot().status !== 'open') return;
    const now = Date.now();
    let sent = false;
    for (const entry of [...entries.values()]) {
      if (entry.sent) continue;
      if (now - entry.createdAt > maxAge) {
        forget(entry.id).catch(noop);
        options.onExpire?.(entry);
      } else if (client.send(options.send(entry.message, entry.id), { volatile: true })) {
        if (!options.ack) forget(entry.id).catch(noop);
        else {
          entries.set(entry.id, { ...entry, sent: true });
          sent = true;
        }
      }
    }
    if (sent) changed();
  }

  const ready = storage
    .load()
    .then(records => {
      if (disposed) return;
      // Entries added meanwhile are newer than the stored ones, unless one has the same id.
      entries = new Map(
        [
          ...records.filter(record => !entries.has(record.id) && !removed.has(record.id)),
          ...entries.values()
        ]
          .sort((a, b) => a.createdAt - b.createdAt)
          .map(record => [record.id, { ...record, sent: false } as OutboxEntry<M>])
      );
      changed();
    })
    // Even without its stored entries, the outbox works from memory.
    .finally(() => {
      loaded = true;
      removed.clear();
      flush();
    });
  // Nobody may be awaiting `ready`; don't surface that as an unhandled rejection.
  ready.catch(noop);

  /** What was sent on the last connection may not have arrived: send it again on the next. */
  function unsend() {
    let changes = false;
    for (const entry of entries.values()) {
      if (entry.sent) {
        entries.set(entry.id, { ...entry, sent: false });
        changes = true;
      }
    }
    if (changes) changed();
  }

  const offs = [
    // Also after `migrate()`, where the status stays `open`.
    client.on('open', () => {
      unsend();
      flush();
    }),
    client.subscribe(() => {
      if (client.getSnapshot().status !== 'open') unsend();
    }),
    client.on('message', message => {
      const id = options.ack?.(message);
      if (id != null) forget(String(id)).catch(noop);
    })
  ];

  return {
    client,
    ready,
    add(message, id = randomId()) {
      lastCreated = Math.max(Date.now(), lastCreated + 1);
      const record: OutboxRecord<M> = { id, message, createdAt: lastCreated };
      // Re-adding an id moves it to the end, as a new message.
      entries.delete(id);
      entries.set(id, { ...record, sent: false });
      changed();
      flush();
      return storage.put(record).then(() => id);
    },
    remove: forget,
    async clear() {
      await ready.catch(noop);
      entries.clear();
      changed();
      // Including what other tabs stored since this one loaded.
      await Promise.all((await storage.load()).map(record => storage.delete(record.id)));
    },
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    dispose() {
      disposed = true;
      for (const off of offs) off();
      release?.();
      release = undefined;
    }
  };
}
