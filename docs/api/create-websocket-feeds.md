---
description: 'createWebSocketFeeds: topic subscriptions with numbered messages, delivered once and in order across reconnects, with gap detection, resume and snapshots.'
---

# createWebSocketFeeds

Subscribe to topics whose messages carry a sequence number, and get each message once, in order, across reconnects. Duplicates are dropped, a gap asks the server for what's missing, and each new connection resumes from the last number received.

```ts
function createWebSocketFeeds<In, Out>(
  client: WebSocketClient<In, Out>,
  options: {
    subscribe: (topic: string, after: number | undefined) => Out;
    unsubscribe?: (topic: string) => Out;
    resume?: (topic: string, after: number) => Out;
    sequence: (message: In) => { topic: string; seq: number } | null | undefined;
    snapshot?: (message: In) => { topic: string; seq: number } | null | undefined;
    onGap?: (topic: string, after: number, received: number) => void;
  }
): WebSocketFeeds<In>;
```

Available from both `react-websocket` and `react-websocket/core`. The guide is [Numbered feeds](../guide/topics.md#numbered-feeds).

## Usage

```ts
import { createWebSocket, createWebSocketFeeds, createWebSocketState } from 'react-websocket';

type LiveIn =
  | { type: 'event'; topic: string; seq: number; message: ChatMessage }
  | { type: 'snapshot'; topic: string; seq: number; messages: ChatMessage[] };
type LiveOut =
  | { type: 'subscribe'; topic: string; after?: number }
  | { type: 'unsubscribe'; topic: string };

const live = createWebSocket<LiveIn, LiveOut>('wss://chat.example.com', { json: true });

export const feeds = createWebSocketFeeds(live, {
  subscribe: (topic, after) => ({ type: 'subscribe', topic, after }),
  unsubscribe: topic => ({ type: 'unsubscribe', topic }),
  sequence: message => (message.type === 'event' ? message : undefined),
  snapshot: message => (message.type === 'snapshot' ? message : undefined)
});

export const room = createWebSocketState(feeds, {
  initialState: [] as ChatMessage[],
  reduce: (list, message) => (message.type === 'snapshot' ? message.messages : [...list, message.message])
});
```

```tsx
function Room() {
  useWebSocketTopic(feeds, 'room:42');
  const messages = useWebSocketState(room);
  // …
}
```

## Parameters

| Parameter | Type | |
| --- | --- | --- |
| `client` | [`WebSocketClient<In, Out>`](./types.md#websocketclient) | The client to subscribe on. `In` and `Out` are taken from it |
| `options.subscribe` | `(topic: string, after: number \| undefined) => Out` | The message that subscribes to `topic`. `after` is the number of the last message received on it, or `undefined` the first time. Sent on every new connection too |
| `options.unsubscribe` | `(topic: string) => Out` | Optional. The message that unsubscribes, a tick after the last holder releases a topic |
| `options.resume` | `(topic: string, after: number) => Out` | Optional. The message that asks for what came after `after` when messages went missing on an open connection. Default: `subscribe(topic, after)` |
| `options.sequence` | `(message: In) => FeedPosition \| null \| undefined` | Recognize a numbered message: `{ topic, seq }`. `undefined` for any other message. Returning the message itself works when it has those fields |
| `options.snapshot` | `(message: In) => FeedPosition \| null \| undefined` | Optional. Recognize a snapshot: a topic's whole state as of `seq`. Always delivered, and the numbering goes on from it |
| `options.onGap` | `(topic: string, after: number, received: number) => void` | Optional. Called when a message arrives after a gap, before the missing ones are asked for |

## Returns

A `WebSocketFeeds<In>`, which is also a [`WebSocketTopics`](./create-websocket-topics.md#returns):

| Member | |
| --- | --- |
| `on('message', listener)` | Listen to messages in order: numbered ones once each and without gaps, others as they arrive. Returns an unsubscribe function |
| `position(topic)` | The number of the last message delivered on `topic`, while it's held |
| `acquire(topic)` | Hold a subscription and the connection, as for topics. Returns a release function |
| `active()` | The topics currently held |
| `client` | The client |
| `dispose()` | Stop managing subscriptions and delivering messages |

Pass it to [`useWebSocketTopic`](./use-websocket-topic.md) to hold topics from components, and to [`createWebSocketState`](./create-websocket-state.md) in place of the client to reduce its messages.

## Behavior

| Message | What happens |
| --- | --- |
| The first numbered message on a held topic | Delivered. Numbering starts from it |
| Numbered one more than the last | Delivered |
| Numbered at or below the last | Dropped: a duplicate, such as a message replayed twice |
| Numbered further ahead | Held back (dropped), `onGap` is called, and `resume(topic, last)` is sent once. Later messages are held back too until the next expected one arrives |
| A snapshot | Delivered, whatever its number. Numbering goes on from it |
| Not numbered, or on a topic this doesn't hold | Delivered as it is |

- **Reconnects.** Every new connection sends `subscribe(topic, last)` for each held topic, before messages queued while disconnected, as topics do.
- **Releasing.** A tick after the last holder releases a topic, it's unsubscribed and its number forgotten, so holding it again starts with `after: undefined`.
- **What the server does.** For `subscribe` with an `after`, send the messages numbered after it, then go on live. If it can't, because they're no longer kept, send a snapshot. Treat a subscribe for a topic the connection already has as a request to resend from `after`, or give `resume` its own message.
