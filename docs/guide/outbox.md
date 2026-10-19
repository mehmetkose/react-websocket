---
title: 'Offline outbox for WebSocket messages'
description: 'Keep WebSocket messages in IndexedDB until the server acknowledges them, so orders and reports survive reconnects, page reloads and flaky Wi-Fi. Idempotent retries, in order.'
---

# Offline outbox

Point-of-sale terminals, field-service apps and warehouse scanners run on Wi-Fi that comes and goes, and their users reload, close the laptop, or lose battery. An order that only lived in memory is gone when that happens.

The client's [send queue](./reconnecting.md#the-send-queue) holds messages while the socket is down, but only in memory, and only until they're handed to the socket. A message sent just before the connection dropped may never have reached the server, and nothing sends it again. `createWebSocketOutbox`, from `react-websocket/outbox`, closes both gaps:

- **Stored.** Each message is kept in IndexedDB, so it survives a reload or a crash, and is sent when the page comes back.
- **Acknowledged.** It stays until the server acknowledges it, and is sent again on every new connection until then.
- **Idempotent.** It carries the same key every time, so the server can tell a retry from a new message.

## Setup

```ts
// orders.ts
import { createWebSocket } from 'react-websocket';
import { createWebSocketOutbox } from 'react-websocket/outbox';

type Order = { table: number; items: string[] };
type PosIn = { type: 'ack'; id: string } | { type: 'menu'; items: string[] };
type PosOut = { type: 'order'; id: string; order: Order };

export const pos = createWebSocket<PosIn, PosOut>('wss://pos.example.com', { json: true });

export const orders = createWebSocketOutbox(pos, {
  name: 'orders',
  send: (order: Order, id) => ({ type: 'order', id, order }),
  ack: message => (message.type === 'ack' ? message.id : undefined)
});
```

Then add messages from anywhere:

```ts
await orders.add({ table: 4, items: ['soup', 'bread'] });
```

`add()` stores the message and sends it right away if the socket is open, or as soon as it opens. It resolves with the message's id once it's stored. To use an id of your own, such as an order number, pass it: `orders.add(order, order.number)`.

While messages are waiting, the outbox holds the connection open, so they're delivered even if no component uses `pos`.

## The server's side

The server must do two things: acknowledge every message with its id, and do nothing for an id it has already handled except acknowledge it again. A message can arrive twice when the connection drops after the server handled it but before its acknowledgement got back, or when two tabs send the same stored message.

```ts
// With the `ws` package. `handled` would be a database table in production.
const handled = new Set<string>();

wss.on('connection', socket => {
  socket.on('message', data => {
    const message = JSON.parse(String(data));
    if (message.type !== 'order') return;
    if (!handled.has(message.id)) {
      saveOrder(message.order);
      handled.add(message.id);
    }
    socket.send(JSON.stringify({ type: 'ack', id: message.id }));
  });
});
```

Acknowledge only once the message is safe on your side, for example after the database write commits. Until the acknowledgement arrives, the client assumes the message may be lost.

## Showing what's waiting

[`useWebSocketOutbox`](../api/use-websocket-outbox.md) lists the waiting messages and re-renders as they're acknowledged:

```tsx
import { useWebSocketOutbox } from 'react-websocket';
import { orders } from './orders';

function SyncBanner() {
  const waiting = useWebSocketOutbox(orders);
  if (!waiting.length) return null;
  return <p role="status">{waiting.length} orders waiting to sync</p>;
}
```

Each entry has its `id`, `message`, `createdAt`, and `sent`: whether it has gone out on the current connection and waits for its acknowledgement.

## Messages that are too old

An order from yesterday may be worse than no order. `maxAge` drops a message instead of sending it once it's older than that, and `onExpire` lets you tell the user:

```ts
export const orders = createWebSocketOutbox(pos, {
  name: 'orders',
  send: (order: Order, id) => ({ type: 'order', id, order }),
  ack: message => (message.type === 'ack' ? message.id : undefined),
  maxAge: 4 * 60 * 60 * 1000, // 4 hours
  onExpire: entry => notify(`Order for table ${entry.message.table} was not sent`)
});
```

Age is checked when a message would be sent: on every new connection, and when stored messages are loaded after a reload. It uses `Date.now()`, so time the device spent asleep counts. For messages in the client's own queue, the same idea is [`queue.maxAge`](./reconnecting.md#expiring-stale-messages).

## Cancelling and logging out

```ts
await orders.remove(id); // the user cancelled this order
await orders.clear(); // on logout: forget everything, including what other tabs stored
```

## Things to know

- **Order.** Messages are sent oldest first. After a reload, nothing is sent until the stored messages are loaded, so they go before new ones.
- **Tabs.** Every open tab sends the stored messages it loaded. The idempotency key makes that harmless. A message acknowledged, removed or cleared in one tab is dropped in the others too, so a logout in one tab stops what the others would still send.
- **No acknowledgement?** Without `ack`, a message is removed once it has been handed to an open socket, and one sent right away is never stored. It still survives a reload while offline, but one sent just before the connection dropped can be lost.
- **Not the send queue.** Outbox messages don't go through the client's queue, so `queue` options don't apply to them. They're sent before what the client queued.
- **Storage.** The default is IndexedDB, in a database named `react-websocket-outbox:<name>`. Where IndexedDB doesn't exist, as in a server render, messages are kept in memory. If storing fails, for example when the device is out of space, `add()` rejects, but the message is still sent from memory. Pass `storage` to keep messages elsewhere, or `memoryStorage()` in tests.
- **Deploys.** After [`migrate()`](./reconnecting.md#deploys-without-reconnect-storms), unacknowledged messages are sent again on the new connection.

## Testing

Pass `storage: memoryStorage()` to keep tests independent of IndexedDB, and drive the socket with a mock, as in [Testing](./testing.md). To test persistence itself, create a second outbox on the same storage object: it loads what the first one stored, like a page after a reload.

## See also

- [`createWebSocketOutbox`](../api/create-websocket-outbox.md) and [`useWebSocketOutbox`](../api/use-websocket-outbox.md)
- [Reconnecting and heartbeats](./reconnecting.md): the send queue and `queue.maxAge`
- [Chaos testing](./chaos.md): drop connections at random and watch the outbox recover
- [Build a team chat app](../recipes/team-chat.md) and [Build a collaborative whiteboard](../recipes/collaborative-whiteboard.md): the outbox for chat messages and drawings
- [Build live notifications](../recipes/live-notifications.md): reads that survive going offline, and [Build live delivery tracking](../recipes/delivery-tracking.md): proof of delivery from a phone with no signal
