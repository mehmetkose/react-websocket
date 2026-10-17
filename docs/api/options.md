# Options

`WebSocketOptions<In, Out>` configures a connection. Pass it to [`createWebSocket(url, options)`](./create-websocket.md) or [`useWebSocket(url, options)`](./use-websocket.md).

```ts
createWebSocket<In, Out>('wss://api.example.com/live', {
  protocols: ['v2.json'],
  json: true,
  schema: Message,
  reconnect: { maxAttempts: 10, shouldReconnect: close => close.code !== 4001 },
  heartbeat: { interval: 25_000, pong: 'pong', timeout: 5_000 },
  queue: { limit: 500 },
  logger: console.debug
});
```

## Summary

| Option | Type | Default |
| --- | --- | --- |
| [`protocols`](#protocols) | `string \| string[]` | none |
| [`binaryType`](#binarytype) | `'blob' \| 'arraybuffer'` | `'blob'` |
| [`json`](#json) | `boolean` | `false` |
| [`parse`](#parse) | `(data: unknown) => unknown` | none |
| [`serialize`](#serialize) | `(message: Out) => SendData` | none |
| [`schema`](#schema) | `StandardSchemaV1<unknown, In>` | none |
| [`reconnect`](#reconnect) | `boolean \| ReconnectOptions` | `true` |
| [`heartbeat`](#heartbeat) | `HeartbeatOptions` | none |
| [`queue`](#queue) | `boolean \| QueueOptions` | `true` |
| [`logger`](#logger) | `(message: string, ...details: unknown[]) => void` | none |
| [`WebSocket`](#websocket) | `typeof WebSocket` | global `WebSocket` (browser only) |

Incoming data goes through `parse` (or `json`), then `schema`, before it reaches `lastMessage` and `onMessage`. Outgoing messages go through `serialize` (or `json`).

## Connection

### protocols

Sub-protocol(s) passed to the [`WebSocket` constructor](https://developer.mozilla.org/docs/Web/API/WebSocket/WebSocket). With `useWebSocket(url)`, connections are shared per URL **and** protocols.

```ts
{ protocols: ['graphql-transport-ws'] }
```

### binaryType

How binary messages are exposed: `'blob'` (the browser default) or `'arraybuffer'`.

```ts
{ binaryType: 'arraybuffer', parse: data => new Uint8Array(data as ArrayBuffer) }
```

### WebSocket

The `WebSocket` implementation to use. In browsers it defaults to the global `WebSocket`. During a server render (when there is no `window`), the client never connects unless you pass an implementation here.

Use it for tests (a mock) or for Node (the [`ws`](https://github.com/websockets/ws) package):

```ts
import WebSocket from 'ws';
createWebSocket(url, { WebSocket: WebSocket as unknown as typeof globalThis.WebSocket });
```

In development, pass a class from [`createChaosWebSocket`](./chaos.md) to add latency, lost messages and dropped connections. See [Chaos testing](../guide/chaos.md).

## Messages

### json

`JSON.parse` incoming messages and `JSON.stringify` outgoing ones.

Incoming data that isn't valid JSON is not delivered. It is reported to `onError` as a [`MessageError`](./types.md#messageerror) with the original `data`.

### parse

A custom decoder for incoming `event.data`. It takes precedence over `json`. If it throws, the message is reported to `onError` as a `MessageError` (with the thrown error as `cause`) and not delivered.

```ts
{ parse: data => decodeMsgPack(data as ArrayBuffer) }
```

### serialize

A custom encoder for outgoing messages. It takes precedence over `json`. It must return something `WebSocket.send` accepts: a string, `Blob`, `ArrayBuffer` or typed array.

```ts
{ serialize: (message: Out) => encodeMsgPack(message) }
```

### schema

Validate incoming messages, after parsing, with any [Standard Schema](https://standardschema.dev) library: zod 3.24+, valibot 1.0+, arktype 2.0+ and others. Invalid messages are reported to `onError` as a `MessageError` with `issues` and are not delivered. The `In` type is inferred from the schema.

```ts
import { z } from 'zod';

const Tick = z.object({ symbol: z.string(), price: z.number() });
const ticks = createWebSocket('wss://api.example.com/ticks', { json: true, schema: Tick });
// ticks.getSnapshot().lastMessage: { symbol: string; price: number } | undefined
```

Async schemas are supported. Messages are still delivered in the order they arrived.

## Reliability

### reconnect

Reconnect with exponential backoff after an unexpected close or a failed attempt. `false` disables reconnecting. An object tunes it:

| Field | Type | Default | |
| --- | --- | --- | --- |
| `maxAttempts` | `number` | `Infinity` | Maximum consecutive reconnect attempts. When the last one fails, the client gives up: the status becomes `'closed'` and `ready` rejects |
| `minDelay` | `number` | `1000` | Delay before the first retry, in ms |
| `maxDelay` | `number` | `30000` | Upper bound for the delay, in ms |
| `factor` | `number` | `2` | Backoff multiplier |
| `jitter` | `number` | `1` | Randomly shave up to this fraction (0–1) off each delay |
| `minUptime` | `number` | `5000` | How long a connection must stay open before the backoff resets, in ms. One that closes sooner counts as a failed attempt. `0` resets on every open |
| `shouldReconnect` | `(close: CloseInfo) => boolean` | `retryableClose` | Return `false` to stop reconnecting after this close. The default retries every close except `1002`, `1003` and `1008` |
| `retryAfter` | `(close: CloseInfo) => number \| undefined` | `retryAfter` | How long the server asked to wait before the next attempt, in ms, or `undefined`. The default reads a `1012` or `1013` close whose reason is a number of seconds |

The delay before attempt *n* is `min(maxDelay, minDelay × factor^(n−1))`, minus up to `jitter` of it at random. With the defaults, each delay is picked at random between 0 and 1 s, 2 s, 4 s, 8 s, … up to 30 s.

When `retryAfter` returns a delay, the client waits that long plus the usual delay. A `1013` (Try Again Later) close that names no delay starts the backoff at `maxDelay` instead. See [Overloaded servers](../guide/reconnecting.md#overloaded-servers-1013).

While a retry is scheduled, the client also retries immediately when the browser fires `online` or the page becomes visible again, unless the server asked it to wait.

A `shouldReconnect` of your own replaces the default. Call the exported `retryableClose` from it to keep the default rule:

```ts
import { createWebSocket, retryableClose } from 'react-websocket';

createWebSocket(url, {
  reconnect: {
    maxAttempts: 8,
    // 4001: our server's "invalid token" close code
    shouldReconnect: close => close.code !== 4001 && retryableClose(close)
  }
});
```

See [Reconnecting and heartbeats](../guide/reconnecting.md).

### heartbeat

Send a ping on an interval while open. Use it to keep connections alive through proxies that close idle connections, and, with `timeout`, to detect connections that died without a close event.

| Field | Type | Default | |
| --- | --- | --- | --- |
| `interval` | `number` | required | Send `message` every `interval` ms while open |
| `message` | `string` | `'ping'` | Sent as-is, not passed through `serialize` or `json` |
| `pong` | `string` | none | Incoming data equal to this is swallowed instead of delivered |
| `timeout` | `number` | none | If **nothing** arrives within this many ms after a ping, close with code `4000` and reconnect |

```ts
{ heartbeat: { interval: 25_000, message: 'ping', pong: 'pong', timeout: 5_000 } }
```

Any incoming message counts as a sign of life, not just `pong`.

### queue

Buffer `send()` calls made while not connected, and send them in order when the socket opens.

| Value | Behavior |
| --- | --- |
| `true` (default) | Queue at most 100 messages, like `{ limit: 100 }` |
| `{ limit: n }` | Queue at most `n` messages. When full, the oldest is dropped (and logged), skipping `priority` messages unless nothing else is queued. `Infinity` keeps every message |
| `false` | Don't queue. `send()` while not open drops the message and returns `false` |

To decide per message instead, pass [`SendOptions`](./types.md#sendoptions) to `send()`: `{ volatile: true }` drops one message, `{ key }` keeps only the newest queued message per key, and `{ priority: true }` queues a message ahead of the others.

Queued messages are sent right after `open` listeners run, so a handshake sent from `onOpen` goes out first. See [First-message auth](../guide/authentication.md#first-message-auth). The queue is cleared by `close()` and when the client gives up reconnecting.

```ts
{ queue: { limit: 500 } }
```

## Debugging

### logger

Receives debug messages about connection attempts, retries, heartbeat timeouts and dropped messages.

```ts
{ logger: (message, ...details) => console.debug('[ws]', message, ...details) }
```

## Hook-only options

`useWebSocket(url, options)` also accepts `onOpen`, `onMessage`, `onClose`, `onError` and `enabled`. See [Handlers](./use-websocket.md#handlers).
