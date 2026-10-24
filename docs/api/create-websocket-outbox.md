---
description: 'createWebSocketOutbox: keep WebSocket messages in IndexedDB until the server acknowledges them, across reconnects and page reloads, with idempotency keys. From react-websocket/outbox.'
---

# createWebSocketOutbox

Keep messages until the server acknowledges them, across reconnects and page reloads. Each message is stored (in IndexedDB by default) and sent with an idempotency key, and sent again on every new connection until the server acknowledges that key.

```ts
function createWebSocketOutbox<M, In, Out>(
  client: WebSocketClient<In, Out>,
  options: {
    name: string;
    send: (message: M, id: string) => Out;
    ack?: (message: In) => string | null | undefined;
    maxAge?: number;
    onExpire?: (entry: OutboxEntry<M>) => void;
    storage?: OutboxStorage;
  }
): WebSocketOutbox<M>;
```

Available only from `react-websocket/outbox`. It has no React dependency, and its size (about 1.1 kB min+gzip) is separate from the main entry's. List its entries in React with [`useWebSocketOutbox`](./use-websocket-outbox.md).

## Usage

```ts
import { createWebSocket } from 'react-websocket';
import { createWebSocketOutbox } from 'react-websocket/outbox';

export const pos = createWebSocket<PosIn, PosOut>('wss://pos.example.com', { json: true });

export const orders = createWebSocketOutbox(pos, {
  name: 'orders',
  send: (order: Order, id) => ({ type: 'order', id, order }),
  ack: message => (message.type === 'ack' ? message.id : undefined)
});
```

```ts
await orders.add({ table: 4, items }); // stored; sent now or as soon as the socket opens
```

Annotate `send`'s `message` parameter: that's what `outbox.add()` accepts. The guide is [Offline outbox](../guide/outbox.md).

## Parameters

| Parameter | Type | |
| --- | --- | --- |
| `client` | [`WebSocketClient<In, Out>`](./types.md#websocketclient) | The client to send on. `In` and `Out` are taken from it |
| `options.name` | `string` | Names the IndexedDB database, `react-websocket-outbox:<name>`. Give each outbox its own. Unused with `storage` |
| `options.send` | `(message: M, id: string) => Out` | Build the message to send, with `id` as its idempotency key |
| `options.ack` | `(message: In) => string \| null \| undefined` | Optional. Recognize the server's acknowledgement and return the id it confirms. An entry stays until it's acknowledged. Without `ack`, an entry is removed once sent |
| `options.maxAge` | `number` | Optional. Drop an entry instead of sending it once it's older than this many ms. Checked on every new connection and when stored entries are loaded. Default `Infinity` |
| `options.onExpire` | `(entry: OutboxEntry<M>) => void` | Optional. Called with each entry dropped by `maxAge`, e.g. to tell the user an order didn't go through |
| `options.storage` | [`OutboxStorage`](#outboxstorage) | Optional. Where to keep entries. Default: `indexedDBStorage(name)`, or `memoryStorage()` where IndexedDB doesn't exist (a server render) |

## Returns

A `WebSocketOutbox<M>`:

| Member | |
| --- | --- |
| `add(message, id?)` | Add a message and send it as soon as the socket is open. Resolves with its id once it's stored (once IndexedDB has committed it), and rejects if storing failed (it's still sent from memory then, but won't survive a reload). Without `ack`, a message sent right away isn't stored, and it resolves at once. Pass `id` to use your own idempotency key, such as an order number. Adding an id again replaces that entry and moves it to the end |
| `remove(id)` | Remove an entry without sending it again, e.g. when the user cancels it. Also works before stored entries are loaded. Other tabs' outboxes with the same `name` drop it too |
| `clear()` | Remove every entry at once, including ones other tabs stored, e.g. on logout: every entry that exists when it's called, whatever clock stored it. Stored entries that weren't loaded yet are never sent, and other tabs' outboxes with the same `name` drop theirs. Only entries added after the call stay. Resolves once they're deleted from storage |
| `getSnapshot()` | The waiting entries, oldest first: [`OutboxEntry<M>[]`](#outboxentry). A new array on every change |
| `subscribe(listener)` | Get notified when the entries change. Compatible with `useSyncExternalStore` |
| `ready` | Resolves once entries stored by an earlier page load are back, and rejects if they couldn't be loaded. Nothing is sent before it settles |
| `client` | The client |
| `dispose()` | Stop sending and listening, and release the connection. Stored entries stay stored |

### OutboxEntry

```ts
interface OutboxEntry<M> {
  readonly id: string; // the idempotency key
  readonly message: M; // as passed to add()
  readonly createdAt: number; // Date.now() when it was added
  readonly sent: boolean; // sent on the current connection, waiting for its ack
}
```

### OutboxStorage

```ts
interface OutboxStorage {
  load(): Promise<OutboxRecord[]>; // every stored record, in any order
  put(record: OutboxRecord): Promise<void>;
  delete(id: string): Promise<void>;
}

interface OutboxRecord {
  readonly id: string;
  readonly message: unknown;
  readonly createdAt: number;
}
```

`react-websocket/outbox` exports two: `indexedDBStorage(name)`, the default, and `memoryStorage()`, which keeps entries in memory only, for tests. Write your own to keep entries somewhere else, such as a native app's storage. Messages must survive whatever your storage does to them: IndexedDB stores anything the [structured clone algorithm](https://developer.mozilla.org/en-US/docs/Web/API/Web_Workers_API/Structured_clone_algorithm) can copy.

## Behavior

- **At least once.** An entry is sent when it's added if the socket is open, and again on every new connection until the server acknowledges its id, including after [`migrate()`](../guide/reconnecting.md#deploys-without-reconnect-storms). The server must handle an id it has already seen by acknowledging it again, without acting twice.
- **In order.** Entries are sent oldest first. After a reload, nothing is sent until the stored entries are back, so they go before new ones.
- **Holds the connection.** While entries are waiting, the outbox holds the client's connection open, as a mounted hook would, so they're delivered even if no component uses the client.
- **Not the client's queue.** Entries are sent only while the socket is open, and resent by the outbox itself, so `queue` options and `send()` options don't apply to them. They go out from an `open` listener, ahead of the client's own queue. Over [WebTransport](./webtransport.md) they go on the reliable stream, never as datagrams.
- **Tabs.** Each tab loads the stored entries when its outbox is created and sends them, so two open tabs can both send an entry. The idempotency key makes that harmless. Tabs tell each other over a `BroadcastChannel` named after the outbox when an entry is acknowledged or removed, or the outbox cleared, so the others drop it too.
- **The database.** The IndexedDB connection closes when another page deletes or upgrades the database, and opens again on the next write.
- **Errors.** If `send` throws, the error surfaces where it was called: from `add()`, or asynchronously on a new connection.
