---
description: 'The TypeScript types react-websocket exports: Status, Snapshot, CloseInfo, MessageError, EventMap, SendOptions, WebSocketClient and more.'
---

# Types

All types are exported from both `react-websocket` and `react-websocket/core`.

```ts
import type { Status, Snapshot, WebSocketClient } from 'react-websocket';
```

### Status

```ts
type Status = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'closed';
```

| Status | Meaning |
| --- | --- |
| `idle` | Not connected and not trying to be. Nobody uses the client yet, or everyone stopped |
| `connecting` | The first attempt is in progress |
| `open` | Connected. `send()` goes out immediately |
| `reconnecting` | The connection dropped or an attempt failed. A retry is scheduled or in progress |
| `closed` | Stopped by `close()` or after giving up. Stays closed until `connect()` or `reconnect()`, or until every hook unmounts |

### Snapshot

The client state that hooks render from. A new object is created on every change, and the same object is returned while nothing changes.

```ts
interface Snapshot<In> {
  readonly status: Status;
  /** Most recent message (after parse/json and schema), kept across reconnects. */
  readonly lastMessage: In | undefined;
  /** Consecutive failed attempts since the last successful open. 0 while open. */
  readonly attempt: number;
}
```

### CloseInfo

```ts
interface CloseInfo {
  readonly code: number;
  readonly reason: string;
  readonly wasClean: boolean;
}
```

Passed to `onClose`, the `'close'` event and `shouldReconnect`. Common codes: `1000` normal closure, `1001` going away, `1006` abnormal closure (no close frame, such as a network loss), `1008` policy violation, `1011` server error, `4000` heartbeat timeout (from this library), `4000`–`4999` application-defined.

### MessageError

```ts
class MessageError extends Error {
  name: string; // 'MessageError'
  /** The raw event.data that failed. */
  readonly data: unknown;
  /** Schema issues, when the message failed `schema`. */
  readonly issues: ReadonlyArray<{ readonly message: string }> | undefined;
  /** The error thrown by parse/JSON.parse or the schema, if any. */
  readonly cause?: unknown;
}
```

Reported through `onError` and the `'error'` event when an incoming message fails `parse`/`json` or `schema`. The message is not delivered.

```ts
import { MessageError } from 'react-websocket';

useWebSocket(url, {
  json: true,
  schema: Message,
  onError(error) {
    if (error instanceof MessageError) {
      reportToSentry(error, { extra: { data: error.data, issues: error.issues } });
    }
  }
});
```

### EventMap

The events a client emits and their listener signatures. Use them with `client.on(type, listener)` and [`useWebSocketEvent`](./use-websocket-event.md).

```ts
interface EventMap<In> {
  open: (event: Event) => void;
  message: (message: In, event: MessageEvent) => void;
  close: (close: CloseInfo) => void;
  error: (error: Event | MessageError | Error) => void;
}
```

| Event | When |
| --- | --- |
| `open` | A socket opened, initially or after a reconnect. Listeners run before queued messages are sent, so a handshake sent from here goes first |
| `message` | A message arrived and passed `parse` and `schema` |
| `close` | A socket closed, whether or not it will be retried |
| `error` | A socket error `Event`, a `MessageError`, or the `Error` thrown by the `WebSocket` constructor or a `url` function |

An exception thrown by a listener is re-thrown asynchronously, so it reaches your global error reporting without stopping other listeners.

### UrlSource

```ts
type UrlSource = string | (() => string | Promise<string>);
```

A function is called before every connection attempt, including reconnects. If it throws or rejects, that counts as a failed attempt and is retried with backoff. See [Authentication](../guide/authentication.md).

### SendData

```ts
type SendData = string | ArrayBufferLike | Blob | ArrayBufferView;
```

Whatever `WebSocket.prototype.send` accepts in your TypeScript DOM lib.

### SendOptions

Per-message options for `send()`.

```ts
interface SendOptions {
  /** Drop the message instead of queueing it when the socket isn't open. */
  volatile?: boolean;
  /** Keep only the newest queued message with this key. */
  key?: string;
  /** Queue ahead of every message queued without `priority`. */
  priority?: boolean;
  /** While open, drop the message if more than this many bytes are already buffered. */
  maxBuffered?: number;
  /** Called if the message is dropped from the queue without being sent. */
  onDrop?: () => void;
}
```

| Option | |
| --- | --- |
| `volatile` | While not open, drop the message and return `false` instead of queueing it. For data that's stale by the time a reconnect finishes, such as player input |
| `key` | While not open, replace any queued message with the same key. The new one moves to the back of the queue (or of the priority messages, for a priority one). For state where only the latest value matters, such as an aim angle or a cursor position |
| `priority` | While not open, queue the message ahead of every message queued without `priority`, after earlier priority messages. Messages sent from `open` listeners still go first. For control messages that must not wait behind a backlog: cancel, interrupt, a token refresh |
| `maxBuffered` | While open, drop the message and return `false` if more than this many bytes are already waiting in the browser's send buffer (`socket.bufferedAmount`). For high-rate streams on a slow link, where a late message is worse than none |
| `onDrop` | Called if the queued message is dropped without being sent: replaced by a newer message with the same `key`, or evicted by [`queue.limit`](./options.md#queue). Not called when the queue is cleared because the client closed or gave up, or when `send()` drops the message right away and returns `false` |

`volatile`, `key` and `priority` only matter while the socket isn't open, and `maxBuffered` only while it is. Once a message is handed to the browser, nothing can overtake it, so `priority` can't jump ahead of data already sent. Keep that buffer short by sending bulky streams with `maxBuffered`.

```ts
game.send({ type: 'input', dx, dy }, { volatile: true, maxBuffered: 4096 });
game.send({ type: 'aim', angle }, { key: 'aim' });
game.send({ type: 'leave' }, { priority: true });
```

See [Real-time games](../guide/games.md#input-don-t-replay-stale-messages).

### StandardSchemaV1

The [Standard Schema](https://standardschema.dev) interface. zod (3.24+), valibot (1.0+), arktype (2.0+) and other libraries implement it, so you can pass their schemas directly to the [`schema`](./options.md#schema) option. You don't need to import this type.

### WebSocketClient

```ts
interface WebSocketClient<In = unknown, Out = unknown> {
  readonly url: UrlSource;
  readonly ready: Promise<void>;
  readonly socket: WebSocket | null;
  subscribe(listener: () => void): () => void;
  getSnapshot(): Snapshot<In>;
  on<K extends keyof EventMap<In>>(type: K, listener: EventMap<In>[K]): () => void;
  send(message: Out, options?: SendOptions): boolean;
  connect(): void;
  close(code?: number, reason?: string): void;
  reconnect(): void;
  acquire(): () => void;
}
```

| Member | |
| --- | --- |
| `url` | The URL or URL function the client was created with |
| `ready` | Resolves once the socket has opened. Reading it starts an idle client. It **stays resolved through automatic reconnects**, rejects when the client gives up, on `close()` and during a server render, and is a new pending promise after `connect()`/`reconnect()` restart a closed client. Safe to pass to React's `use()`. See [Suspense](../guide/suspense.md) |
| `socket` | The current `WebSocket`, or `null`. An escape hatch; prefer the client's methods |
| `subscribe(listener)` | Called whenever the snapshot changes. Compatible with `useSyncExternalStore` |
| `getSnapshot()` | The current [`Snapshot`](#snapshot) |
| `on(type, listener)` | Listen to an [event](#eventmap). Returns an unsubscribe function. Subscribing the same function twice creates two independent subscriptions |
| `send(message, options?)` | Encode and send now, or queue until open (see [`queue`](./options.md#queue) and [`SendOptions`](#sendoptions)). Returns `true` if sent immediately |
| `connect()` | Start connecting, and stay connected even with no hooks mounted, until `close()`. Does nothing if already connecting or open |
| `close(code = 1000, reason?)` | Close, stop reconnecting and clear the queue. Status becomes `'closed'` |
| `reconnect()` | Drop the current socket and connect again now, resetting the backoff. Also restarts a `'closed'` client |
| `acquire()` | Hold the connection open until the returned release function is called. The hooks use this; it's useful for non-React integrations. The release function is safe to call more than once |
