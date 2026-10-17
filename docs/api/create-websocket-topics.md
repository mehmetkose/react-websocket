# createWebSocketTopics

Manage reference-counted topic subscriptions that are sent again after every reconnect.

```ts
function createWebSocketTopics<Out>(
  client: WebSocketClient<any, Out>,
  options: {
    subscribe: (topic: string) => Out;
    unsubscribe?: (topic: string) => Out;
  }
): WebSocketTopics;
```

Available from both `react-websocket` and `react-websocket/core`.

## Usage

```ts
import { createWebSocket, createWebSocketTopics } from 'react-websocket';

type Out = { type: 'subscribe' | 'unsubscribe'; topic: string };

const live = createWebSocket<unknown, Out>('wss://api.example.com/live', { json: true });

export const topics = createWebSocketTopics(live, {
  subscribe: topic => ({ type: 'subscribe', topic }),
  unsubscribe: topic => ({ type: 'unsubscribe', topic })
});
```

Hold topics from components with [`useWebSocketTopic`](./use-websocket-topic.md). The guide is [Topic subscriptions](../guide/topics.md).

## Parameters

| Parameter | Type | |
| --- | --- | --- |
| `client` | [`WebSocketClient<any, Out>`](./types.md#websocketclient) | The client to send subscriptions on. `Out` is taken from it |
| `options.subscribe` | `(topic: string) => Out` | The message that subscribes to a topic |
| `options.unsubscribe` | `(topic: string) => Out` | Optional. The message that unsubscribes |

## Returns

`WebSocketTopics`:

| Member | |
| --- | --- |
| `acquire(topic)` | Hold `topic` and the client connection. Returns a release function, safe to call more than once |
| `active()` | The topics currently held |
| `dispose()` | Stop managing subscriptions. Only for managers created dynamically |
| `client` | The client |

## Behavior

- **Shared.** The first `acquire` of a topic sends `subscribe` if the socket is open. Otherwise it's sent on open. More holders send nothing.
- **Deferred unsubscribe.** A tick after the last release, `unsubscribe` is sent, unless the topic was acquired again in the meantime.
- **Reconnects.** On every open, every held topic is subscribed on the new socket, before the client flushes its send queue.
- **Never queued.** Subscription messages bypass the send queue, so nothing is sent twice.
- **Requires TypeScript 5.4+** for the inferred message types (it uses `NoInfer`).
