---
title: 'WebSocket topic subscriptions'
description: 'Manage WebSocket topic and channel subscriptions in React: shared between components, reference-counted, and sent again after every reconnect.'
---

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

Subscriptions are never put in the send queue. On open, they're sent **before** messages you queued while disconnected, so those messages reach a server that already knows your subscriptions. While the server is closing the socket, which still reads `open` until its close event, nothing is sent: the next connection subscribes to what's held then.

The one-tick delay before `unsubscribe` is the same trick the client uses for connections. StrictMode's mount → unmount → mount, `<Activity>` toggles and route transitions don't send `unsubscribe` + `subscribe` pairs.

:::tip Authentication first
`open` listeners run in the order they were added, and topics subscribe from one. If your server needs an auth message before anything else, add your auth listener (`live.on('open', …)`) **before** calling `createWebSocketTopics`. See [First-message auth](./authentication.md#first-message-auth).
:::

## Numbered feeds

Resubscribing fixes the frozen dashboard, but it can't say what happened while the connection was down. A chat room, a scoreboard or an order book needs more: every message, exactly once, in order. If the server numbers the messages on each topic, `createWebSocketFeeds` gives you that. It's a topics manager whose subscribe message says where you left off:

```ts
// live.ts
import { createWebSocket, createWebSocketFeeds, createWebSocketState } from 'react-websocket';

type LiveIn =
  | { type: 'event'; topic: string; seq: number; message: ChatMessage }
  | { type: 'snapshot'; topic: string; seq: number; messages: ChatMessage[] };
type LiveOut =
  | { type: 'subscribe'; topic: string; after?: number }
  | { type: 'unsubscribe'; topic: string };

export const live = createWebSocket<LiveIn, LiveOut>('wss://chat.example.com', { json: true });

export const feeds = createWebSocketFeeds(live, {
  subscribe: (topic, after) => ({ type: 'subscribe', topic, after }),
  unsubscribe: topic => ({ type: 'unsubscribe', topic }),
  sequence: message => (message.type === 'event' ? message : undefined),
  snapshot: message => (message.type === 'snapshot' ? message : undefined)
});

// Reduce the feed's messages, not the client's: each once, in order.
export const room = createWebSocketState(feeds, {
  initialState: [] as ChatMessage[],
  reduce: (list, message) => (message.type === 'snapshot' ? message.messages : [...list, message.message])
});
```

Components hold topics exactly as before, with `useWebSocketTopic(feeds, 'room:42')`. What changes is what reaches `room`:

- **After a reconnect**, each held topic is subscribed with `after`, the number of the last message received, so the server sends only what was missed.
- **Duplicates are dropped.** A message numbered at or below the last one never reaches your reducer, even if the server replays more than it needs to.
- **Gaps are filled.** A message that skips numbers is held back, and the feed asks the server once for what's missing (`resume`, which defaults to subscribing again with `after`). Nothing is delivered out of order.
- **Snapshots are the fallback.** When the server no longer has the messages after `after`, or it restarted and its numbers are behind the client's, it sends the topic's whole state with its current number. The snapshot is always delivered, and numbering goes on from it.

Messages that aren't numbered, and those on topics the feed doesn't hold, pass through untouched, so `feeds` can stand in for the client wherever you listen to messages: `feeds.on('message', …)` or `createWebSocketState(feeds, …)`.

The server keeps a short history per topic. With the [`ws`](https://github.com/websockets/ws) package, the subscribe handler looks like this:

```ts
function subscribe(socket: WebSocket, topic: string, after: number | undefined) {
  const feed = feeds.get(topic)!; // { seq, history: { seq, message }[] }
  const oldest = feed.history[0]?.seq ?? feed.seq + 1;
  // Too old for the history, or ahead of a server that restarted: send the whole state.
  if (after === undefined || after < oldest - 1 || after > feed.seq) {
    send(socket, { type: 'snapshot', topic, seq: feed.seq, messages: currentState(topic) });
  } else {
    for (const entry of feed.history) {
      if (entry.seq > after) send(socket, { type: 'event', topic, seq: entry.seq, message: entry.message });
    }
  }
  subscribers(topic).add(socket);
}
```

See [`createWebSocketFeeds`](../api/create-websocket-feeds.md) for every option.

## Outside React

`topics.acquire(topic)` does what the hook does and returns a release function:

```ts
const release = topics.acquire('prices:ACME'); // also holds the connection
// …
release();
```

`topics.active()` lists the topics currently held, which is handy in tests and debugging.

## See also

- [`createWebSocketTopics`](../api/create-websocket-topics.md), [`createWebSocketFeeds`](../api/create-websocket-feeds.md) and [`useWebSocketTopic`](../api/use-websocket-topic.md)
- [Message state](./state.md)
- [Reconnecting and heartbeats](./reconnecting.md)
- [Build a team chat app](../recipes/team-chat.md): numbered feeds for channels, with unread counts and catching up after a reconnect
