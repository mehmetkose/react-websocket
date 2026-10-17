---
title: 'WebSocket auto-reconnect and heartbeats'
description: 'How react-websocket reconnects a dropped WebSocket: exponential backoff with jitter, retries when the network or tab returns, heartbeats, and the send queue.'
---

# Reconnecting and heartbeats

Connections drop: networks change, laptops sleep, servers deploy. This page covers how the client recovers, how to tune it, how to show it in your UI, and how messages sent while disconnected are handled.

## Connection states

`status` is always one of five values:

| Status | Meaning |
| --- | --- |
| `idle` | Not connected and not trying to be. Nothing is using the client yet, or everything stopped. |
| `connecting` | The first attempt (or the first after `reconnect()`) is in progress. |
| `open` | Connected. `send()` goes out immediately. |
| `reconnecting` | The connection dropped or an attempt failed. A retry is scheduled or in progress. |
| `closed` | Stopped for good, by `close()` or after giving up. |

The usual transitions:

```text
idle ──hook mounts──▶ connecting ──open──▶ open
                          │                  │
                       failed             dropped
                          ▼                  ▼
                     reconnecting ◀──────────┘
                      │        │
                    open    gave up / shouldReconnect → false
                      ▼        ▼
                     open    closed

any state ──close()──▶ closed ──connect() / reconnect()──▶ connecting
any state ──last hook unmounts──▶ idle
```

`attempt` counts consecutive failed attempts. It is `0` while open, and it resets once a connection has stayed open for `minUptime` (5 seconds by default). A connection that closes sooner counts as a failed attempt, so `attempt` carries on from where it was.

## Backoff

After an unexpected close, the client waits and tries again. The delay before attempt `n` is:

```text
delay = min(maxDelay, minDelay × factor^(n − 1)) × (1 − jitter × random())
```

With the defaults (`minDelay: 1000`, `factor: 2`, `maxDelay: 30000`, `jitter: 1`), the delays before jitter are 1 s, 2 s, 4 s, 8 s, 16 s, then 30 s for every attempt after that. Full jitter then picks each delay at random between 0 and that value, so thousands of clients dropped by the same server deploy spread their reconnects over the whole window instead of arriving together. A lower `jitter` keeps more of each delay: with `0.5`, it is between half and all of it.

Tune it with the [`reconnect`](../api/options.md#reconnect) option:

```ts
import { createWebSocket } from 'react-websocket';

export const live = createWebSocket('wss://api.example.com/live', {
  reconnect: {
    minDelay: 500,
    maxDelay: 10_000,
    factor: 1.5,
    jitter: 0.3,
    minUptime: 10_000,
    maxAttempts: 20
  }
});
```

| Option | Default | |
| --- | --- | --- |
| `maxAttempts` | `Infinity` | Give up after this many consecutive failed retries |
| `minDelay` | `1000` | Delay before the first retry, in ms |
| `maxDelay` | `30000` | Upper bound for any delay, in ms |
| `factor` | `2` | Multiplier per attempt |
| `jitter` | `1` | Fraction (0–1) randomly shaved off each delay |
| `minUptime` | `5000` | How long a connection must stay open before the backoff resets, in ms |
| `shouldReconnect` | `retryableClose` | Return `false` to stop after a given close. The default stops on `1002`, `1003` and `1008` |

`reconnect: false` disables reconnecting entirely. The first unexpected close then makes the status `closed`.

### Servers that close right after accepting

A server can accept a connection and close it at once, for example when it rejects the credentials sent from `onOpen`, or when it is overloaded. If every open reset the backoff, the client would come back about once a second, forever.

So a connection resets the backoff only once it has stayed open for `minUptime`. One that closes sooner counts as a failed attempt: the next delay is longer, and `maxAttempts` still applies. `minUptime: 0` resets on every open.

### Giving up

When `maxAttempts` is reached, or `shouldReconnect` returns `false`, the client stops:

- the status becomes `closed`;
- [`ready`](./suspense.md) rejects with an `Error` describing the last close;
- the send queue is cleared.

Some closes can't be fixed by trying again the same way, so by default the client gives up on them at once:

| Code | Meaning |
| --- | --- |
| `1002` | Protocol error |
| `1003` | Unsupported data |
| `1008` | Policy violation, often a rejected login or origin |

Every other close is retried, including `1001` (going away), `1006` (network loss) and `1011` (server error). This rule is the default `shouldReconnect`, exported as `retryableClose`. Your own `shouldReconnect` replaces it, so call `retryableClose` from yours to keep it, for example to also stop on your server's own code for an invalid token:

```ts
import { createWebSocket, retryableClose } from 'react-websocket';

const live = createWebSocket(url, {
  reconnect: {
    // 4001 is our server's "invalid token" code.
    shouldReconnect: close => close.code !== 4001 && retryableClose(close)
  }
});
```

To retry every close, pass `shouldReconnect: () => true`.

`shouldReconnect` receives a [`CloseInfo`](../api/types.md#closeinfo) (`code`, `reason`, `wasClean`). It isn't consulted after `close()`, which never reconnects.

An exception from the `WebSocket` constructor (for example a malformed URL) is never retried, because retrying can't fix it. It is reported to `onError` and the status becomes `closed`. A [`url` function](./authentication.md) that throws or rejects, on the other hand, counts as a failed attempt and is retried.

### Retrying right away

While a retry is scheduled, the client skips the rest of the wait and retries immediately when:

- the browser fires `online` (the network came back), or
- the tab becomes visible again (`visibilitychange`).

So a laptop that wakes from sleep reconnects as soon as it can, not after a 30-second backoff.

### Manual control

Both actions are on the hook result and on the client, and keep the same identity between renders:

- `reconnect()` drops the current socket (if any) and connects again immediately, with the backoff reset. It also restarts a `closed` client.
- `close(code?, reason?)` closes with `1000` by default and stops reconnecting. See [Shared clients](./shared-clients.md#closing-and-restarting).

## Showing it in the UI

`status` and `attempt` are all you need for a connection banner:

```tsx
import { useWebSocket } from 'react-websocket';

function ConnectionBanner() {
  const { status, attempt, reconnect } = useWebSocket('wss://api.example.com/live');

  if (status === 'reconnecting') {
    return <div role="status">Reconnecting… (attempt {attempt})</div>;
  }
  if (status === 'closed') {
    return (
      <div role="alert">
        Disconnected. <button onClick={reconnect}>Try again</button>
      </div>
    );
  }
  return null;
}
```

With a module-level client, `useWebSocketStatus(client)` re-renders only on status changes. Use `useWebSocket(client)` when you also want `attempt`.

## Heartbeats

Some proxies and load balancers silently drop connections that look idle, and a dead network link can take minutes to surface as a close. A heartbeat handles both:

```ts
const live = createWebSocket('wss://api.example.com/live', {
  heartbeat: {
    interval: 25_000, // send a ping every 25 s while open
    message: 'ping', // default
    pong: 'pong', // swallow the server's replies
    timeout: 5_000 // no data at all within 5 s of a ping → reconnect
  }
});
```

- `message` is sent as-is on every `interval`. It doesn't go through `serialize` or `json`, so for a JSON protocol pass a string such as `'{"type":"ping"}'`.
- Incoming data exactly equal to `pong` is swallowed. It doesn't update `lastMessage` or reach `onMessage`.
- With `timeout`, **any** incoming data counts as a sign of life, not only the pong. If nothing at all arrives within `timeout` ms of a ping, the connection is treated as dead. The client closes it with code `4000` (reason `'heartbeat timeout'`), reports the close, and reconnects with the normal backoff. Your `shouldReconnect` sees code `4000`.

The heartbeat requires your server to answer pings with some data. Browsers can't send protocol-level ping frames, so this is an application-level ping.

:::tip Try it
A dead connection is hard to produce on purpose. [`Chaos.stall()`](./chaos.md#trigger-faults-on-demand) makes one in development: the socket stays open but goes silent, so you can watch your `timeout` catch it.
:::

## The send queue

`send()` works in any state. While the socket isn't open, messages are queued and sent in order as soon as it opens, including after a reconnect:

```ts
chat.send({ text: 'sent while offline' }); // returns false: queued
// …connection opens…
// the queued message goes out first, then anything sent afterwards
```

| `queue` | Behaviour while not open |
| --- | --- |
| `true` (default) | Queue up to 100 messages; when full, the **oldest** is dropped |
| `{ limit: 500 }` | Queue up to 500 |
| `{ limit: Infinity }` | Queue every message |
| `false` | Drop the message (logged via `logger`) |

The queue is cleared when you call `close()` and when the client gives up reconnecting, so stale messages aren't sent on a later connection.

:::tip Size the queue for your outages
The 100-message default keeps a long outage from building up a backlog that floods the server on reconnect. A dropped message is logged via `logger` and calls its [`onDrop`](../api/types.md#sendoptions). Raise `limit` if your app sends more than that while offline and every message matters, or use `queue: false` for messages that are only meaningful in real time, such as presence or cursor updates.
:::

You can also decide per message. `send(message, { volatile: true })` drops a message that would be queued, and `send(message, { key: 'cursor' })` keeps only the newest queued message with that key:

```ts
chat.send({ text: 'hello' }); // queued while offline
chat.send({ type: 'typing' }, { volatile: true }); // dropped while offline
chat.send({ type: 'cursor', x, y }, { key: 'cursor' }); // only the newest is queued
```

`send()` returns `true` only when the message went out immediately. Use it if you need to know whether a message was queued.

### Control messages first

Messages queued while offline go out in order. A control message such as "cancel" or "stop" shouldn't wait behind a backlog of input or audio frames, so pass `priority`:

```ts
agent.send({ type: 'cancel', runId }, { priority: true });
```

Priority messages go out ahead of everything queued without `priority`, in the order they were sent. Messages sent from `open` listeners, such as an auth handshake, still go first. When the queue is full, ordinary messages are evicted before priority ones.

`priority` only reorders the queue. Once the socket is open, a message goes straight to the browser's send buffer, and nothing can overtake what's already there. To keep that buffer short, send high-rate streams with `maxBuffered`, which drops a message while more than that many bytes are waiting:

```ts
voice.send(frame, { volatile: true, maxBuffered: 64 * 1024 });
```

## Debugging

Pass a `logger` to see attempts, delays, heartbeat timeouts and dropped messages:

```ts
createWebSocket(url, { logger: console.debug });
// connecting wss://api.example.com/live
// closed { code: 1006, reason: '', wasClean: false }
// reconnecting in 734ms (attempt 1)
```

## See also

- Options: [`reconnect`](../api/options.md#reconnect), [`heartbeat`](../api/options.md#heartbeat), [`queue`](../api/options.md#queue), [`logger`](../api/options.md#logger)
- [Authentication](./authentication.md): fresh tokens on every reconnect
- [Chaos testing](./chaos.md): drop, stall and delay connections in development
- [Troubleshooting](../troubleshooting.md)
