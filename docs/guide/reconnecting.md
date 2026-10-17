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
| `retryAfter` | `retryAfter` | How long the server asked to wait after a given close, in ms. The default reads a delay in seconds from a `1012` or `1013` close |

`reconnect: false` disables reconnecting entirely. The first unexpected close then makes the status `closed`.

### Servers that close right after accepting

A server can accept a connection and close it at once, for example when it rejects the credentials sent from `onOpen`, or when it is overloaded. If every open reset the backoff, the client would come back about once a second, forever.

So a connection resets the backoff only once it has stayed open for `minUptime`. One that closes sooner counts as a failed attempt: the next delay is longer, and `maxAttempts` still applies. `minUptime: 0` resets on every open.

### Overloaded servers (1013)

A server that is shedding load can close with `1013` (Try Again Later). Coming back after a second, like after any other drop, would only add to the load, so the client waits longer:

- If the close reason is a number of seconds, like an HTTP `Retry-After` header (`ws.close(1013, '30')` on the server), the client waits that long, plus the usual backoff. Clients told the same delay still spread out over the backoff window instead of all coming back at once.
- Otherwise, its backoff starts at `maxDelay`: with the defaults, a delay picked at random between 0 and 30 seconds.

In both cases, coming back online or to the tab doesn't cut the wait short, and the close counts as a failed attempt, so `attempt` goes up and `maxAttempts` applies. `reconnect()` still connects at once.

Reading the delay is the `retryAfter` option, whose default is the exported `retryAfter` function. It reads a `1012` (Service Restart) close the same way, without the longer backoff: see [Deploys](#deploys-without-reconnect-storms). If your server says how long to wait in another way, for example with a code of its own and the delay in milliseconds, pass your own and call the default from it:

```ts
import { createWebSocket, retryAfter } from 'react-websocket';

const live = createWebSocket(url, {
  reconnect: {
    // 4429 is our server's "too many connections" code, with the delay in ms as the reason.
    retryAfter: close => (close.code === 4429 ? Number(close.reason) : retryAfter(close))
  }
});
```

It returns a delay in ms, or `undefined` when the server didn't ask for one. Anything else, such as `NaN` from a reason that isn't a number, is ignored.

### Deploys without reconnect storms

When a server restarts, every client it served reconnects at once, often to a new server that is still warming up, and each user's connection drops for a moment. Instead, the server can ask its clients to move before it stops, each at a random moment within a window, and `client.migrate()` follows:

```ts
const live = createWebSocket<Message>(url, { json: true });

// The server sends { type: 'reconnect', within: 30000 } before it shuts down.
live.on('message', message => {
  if (message.type === 'reconnect') live.migrate({ within: message.within, url: message.url });
});
```

`migrate()` waits a random time up to `within` ms, then opens a new connection and closes the current one once the new one is open. Until then the current connection keeps working, so there is no gap: the status stays `open`, `send()` doesn't queue, and messages keep arriving. `open` listeners run for the new connection as after any reconnect, so an auth handshake and [topic](./topics.md) subscriptions are sent on it. A request the old connection hadn't answered fails as on a lost connection.

- **`url`** moves the client to another server, for example from a blue to a green deployment. It can be a string, or a function called before the connection, like the client's own `url`. Later reconnects go there too, until the client is closed, gives up or is torn down. Without it, the new connection uses the client's current URL, and a load balancer can route it to a new instance.
- **If the new connection fails**, the current one stays. When the server stops, the client reconnects as after any other drop.
- **If the client isn't open** when its moment comes, only the URL changes, for its next attempt.

On the server, send the notice, wait for the window to pass, then close whoever is left with `1012` (Service Restart). Its reason can say, in seconds, when to come back: the default `retryAfter` reads it like a `1013`'s, so those clients wait that long plus the usual backoff instead of retrying within a second. With the [`ws`](https://github.com/websockets/ws) package:

```ts
process.on('SIGTERM', () => {
  for (const socket of wss.clients) {
    socket.send(JSON.stringify({ type: 'reconnect', within: 30_000 }));
  }
  setTimeout(() => {
    for (const socket of wss.clients) socket.close(1012, '5'); // back in 5 s
    wss.close();
  }, 35_000);
});
```

`migrate()` is also a gap-free `reconnect()`. Call it with no options to open a fresh connection, for example to pick up a refreshed token in a [`url` function](./authentication.md#refreshing-credentials), without the status leaving `open`.

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

So a laptop that wakes from sleep reconnects as soon as it can, not after a 30-second backoff. The exception is a wait the server asked for, with a [`1013` close](#overloaded-servers-1013) or your `retryAfter`.

While the connection is open, the same two events make the client check that it still works, if you configured a [heartbeat](#heartbeats). After sleep or a network change, a socket can be dead while `readyState` still says `OPEN`. So the client sends a ping right away and, with a `timeout`, reconnects if nothing comes back within it, instead of waiting for the next `interval`. Only one ping is outstanding at a time, so switching tabs back and forth doesn't flood the server.

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
- A ping also goes out right away when the browser comes back online or the tab becomes visible, so a connection that died while the laptop slept is found within `timeout`, not after up to `interval` more. See [Retrying right away](#retrying-right-away).

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
| `{ maxAge: 30_000 }` | Drop a message that has waited longer than 30 s instead of sending it |
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

:::tip Messages that must not be lost
The queue lives in memory, and a message leaves it once it's handed to the socket, even if the connection then drops before the server gets it. For orders, reports and anything else that must arrive, use the [offline outbox](./outbox.md): it keeps messages in IndexedDB until the server acknowledges them, across reloads.
:::

### Expiring stale messages

A message that waited through a long outage can be stale by the time it goes out: a "typing…" indicator, a price quote, a request the user has given up on. `maxAge` drops a queued message once it has waited longer than that many milliseconds, for the whole queue or per message:

```ts
const chat = createWebSocket(url, { json: true, queue: { maxAge: 60_000 } });

chat.send({ type: 'typing' }, { maxAge: 3000 }); // pointless after 3 s
chat.send({ type: 'message', text }); // up to a minute, from queue.maxAge
chat.send({ type: 'receipt', id }, { maxAge: Infinity }); // whenever we're back
```

A message's own `maxAge` overrides `queue.maxAge`. Without either, a message waits as long as the queue is kept.

The age is checked when the socket opens, before the queue is sent, and whenever another message is queued. A message dropped this way calls its [`onDrop`](../api/types.md#sendoptions), like one replaced by `key` or evicted by `limit`, and a [request](../api/create-websocket-requests.md) dropped this way rejects. The fresh messages go out first, then the `onDrop`s run, so one that sends again goes after them. Ages use `Date.now()`, so time the computer spends asleep counts.

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
