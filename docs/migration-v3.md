---
title: 'Migrating from react-websocket v3'
description: 'Upgrade from react-websocket v3 to v4: safer reconnect and queue defaults, what changed, and the one-line options that restore the v3 behaviour.'
---

# Migrating from v3

v4 changes no APIs. It changes four defaults so that a client is safe to put in front of a real server without tuning: a server that keeps rejecting it isn't hammered, a deploy doesn't cause a reconnect storm, and a long outage doesn't replay an unbounded backlog. Each change has an option that restores the v3 behaviour.

## At a glance

| | v3 | v4 | Restore v3 |
| --- | --- | --- | --- |
| Backoff reset | On every open | Once a connection stays open for 5 s | `reconnect: { minUptime: 0 }` |
| Close codes `1002`, `1003`, `1008` | Retried | Not retried: the client gives up | `reconnect: { shouldReconnect: () => true }` |
| Jitter | `0.5`: each delay between half and all of the backoff | `1`: each delay between 0 and the backoff | `reconnect: { jitter: 0.5 }` |
| Send queue | Unbounded | 100 messages, oldest dropped first | `queue: { limit: Infinity }` |

## The backoff resets only after a stable connection

In v3, the backoff and `attempt` reset as soon as a socket opened. A server that accepted the connection and then closed it right away, for example to reject the credentials sent from `onOpen`, got a new connection about once a second, forever, and `maxAttempts` never ran out.

In v4, a connection resets the backoff only once it has stayed open for [`reconnect.minUptime`](./api/options.md#reconnect) (5000 ms by default). One that closes sooner counts as a failed attempt: the next delay is longer, `attempt` keeps counting, and `maxAttempts` applies. `attempt` is still `0` while a connection is open.

If your server closes connections on purpose shortly after opening them, lower `minUptime`, or set it to `0` for the v3 behaviour.

## Some close codes aren't retried

v3 retried every close unless `shouldReconnect` said otherwise. v4's default `shouldReconnect` is the new [`retryableClose`](./guide/reconnecting.md#giving-up) export, which stops on:

- `1002` (protocol error),
- `1003` (unsupported data),
- `1008` (policy violation, often a rejected login).

On these the client gives up right away: the status becomes `closed`, `ready` rejects, and the send queue is cleared.

A `shouldReconnect` of your own still replaces the default entirely, so if you already pass one, nothing changes for you. To keep the new rule as well, call `retryableClose` from it:

```ts
import { createWebSocket, retryableClose } from 'react-websocket';

const live = createWebSocket(url, {
  reconnect: { shouldReconnect: close => close.code !== 4001 && retryableClose(close) }
});
```

## Full jitter

v3 shaved up to half off each delay (`jitter: 0.5`), so every client dropped by the same deploy came back within the same half of the window: all of them between 0.5 and 1 s for the first retry. v4 defaults to `jitter: 1`, which picks each delay at random between 0 and the backoff, and spreads the same clients over the whole window.

Some first retries now happen sooner than 500 ms. If you set `jitter` yourself, nothing changes.

## The send queue holds 100 messages

The v3 queue had no limit, so everything sent during a long outage was replayed on reconnect. v4 keeps the newest 100 messages. When the queue is full, the oldest ordinary message is dropped first, then the oldest `priority` one. A dropped message calls its `onDrop`, is logged through `logger`, and, for a request from `createWebSocketRequests`, rejects the request.

Set `queue: { limit }` to a size that fits your app, `{ limit: Infinity }` for the v3 behaviour, or `queue: false` to queue nothing.

## New in v4

- A development warning when `useWebSocket(url)` hooks with the same URL pass different connection options. Only the first component's options take effect, so the warning names the options that are ignored. See [Shared clients](./guide/shared-clients.md#by-url).
