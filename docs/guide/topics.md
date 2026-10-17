# Topic subscriptions

Many servers multiplex one socket into topics or channels: `prices:ACME`, `room:42`, `user:7:notifications`. You send a `subscribe` message to start receiving one and an `unsubscribe` message to stop. This page shows how to manage those subscriptions so they're shared between components and **survive reconnects**.

## The reconnect problem

A server forgets a connection's subscriptions when the connection drops. After the client reconnects, the socket is open again, the status says `open`, and no data arrives, because nobody subscribed on the new connection. It's one of the most common WebSocket bugs, and it usually shows up in production as "the dashboard froze".

`createWebSocketTopics` fixes it: it remembers which topics are in use and subscribes to all of them again every time the socket opens.

## Setup

Describe your server's messages once, next to the client:

```ts
// live.ts
import { createWebSocket, createWebSocketTopics } from 'react-websocket';

type LiveIn = { topic: string; data: unknown };
type LiveOut = { type: 'subscribe' | 'unsubscribe'; topic: string };

export const live = createWebSocket<LiveIn, LiveOut>('wss://api.example.com/live', { json: true });

export const topics = createWebSocketTopics(live, {
  subscribe: topic => ({ type: 'subscribe', topic }),
  unsubscribe: topic => ({ type: 'unsubscribe', topic })
});
```

The messages are checked against the client's `Out` type. Leave out `unsubscribe` if your server has no such message.

## Subscribing from components

`useWebSocketTopic` holds a topic while the component is mounted:

```tsx
import { useState } from 'react';
import { useWebSocketEvent, useWebSocketTopic } from 'react-websocket';
import { live, topics } from './live';

function Ticker({ symbol }: { symbol: string }) {
  const [price, setPrice] = useState<number>();
  useWebSocketTopic(topics, `prices:${symbol}`);
  useWebSocketEvent(live, 'message', message => {
    if (message.topic === `prices:${symbol}`) setPrice(message.data as number);
  });
  return <p>{symbol}: {price ?? '—'}</p>;
}
```

- **Shared.** Two `<Ticker symbol="ACME" />` components send one `subscribe`. The `unsubscribe` goes out when the last one unmounts.
- **Follows props.** Changing `symbol` subscribes to the new topic and unsubscribes from the old one.
- **Holds the connection.** You don't need another hook to keep the socket open.
- **Optional.** Pass `null` to hold nothing.

Pass an array to hold several topics. A new array with the same topics doesn't resubscribe:

```tsx
useWebSocketTopic(
  topics,
  watchlist.map(symbol => `prices:${symbol}`)
);
```

To keep the received data in one place instead of in each component, combine topics with [message state](./state.md).

## What gets sent, and when

| Event | Sent |
| --- | --- |
| First holder of a topic, socket open | `subscribe(topic)` immediately |
| First holder of a topic, socket not open | Nothing yet; sent when it opens |
| More holders of the same topic | Nothing |
| Last holder releases it | `unsubscribe(topic)` one tick later, if no one acquired it again |
| The socket opens or reconnects | `subscribe(topic)` for every held topic |
| Released while disconnected | Nothing; the new connection never subscribes to it |

Subscriptions are never put in the send queue. On open, they're sent **before** messages you queued while disconnected, so those messages reach a server that already knows your subscriptions.

The one-tick delay before `unsubscribe` is the same trick the client uses for connections. StrictMode's mount → unmount → mount, `<Activity>` toggles and route transitions don't send `unsubscribe` + `subscribe` pairs.

:::tip Authentication first
`open` listeners run in the order they were added, and topics subscribe from one. If your server needs an auth message before anything else, add your auth listener (`live.on('open', …)`) **before** calling `createWebSocketTopics`. See [First-message auth](./authentication.md#first-message-auth).
:::

## Outside React

`topics.acquire(topic)` does what the hook does and returns a release function:

```ts
const release = topics.acquire('prices:ACME'); // also holds the connection
// …
release();
```

`topics.active()` lists the topics currently held, which is handy in tests and debugging.

## See also

- [`createWebSocketTopics`](../api/create-websocket-topics.md) and [`useWebSocketTopic`](../api/use-websocket-topic.md)
- [Message state](./state.md)
- [Reconnecting and heartbeats](./reconnecting.md)
