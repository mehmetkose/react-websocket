---
title: 'One WebSocket connection across browser tabs'
description: 'Share one WebSocket between all the tabs of a React app: a leader tab holds the connection, the others reach it over BroadcastChannel, and topics are shared without one tab unsubscribing another.'
---

# One connection across tabs

Every tab of an app opens its own WebSocket. A user with fifteen tabs of your dashboard open costs the server fifteen connections, fifteen sets of subscriptions, and fifteen copies of every message. `react-websocket/tabs` shares one connection between them:

```ts
// live.ts
import { createWebSocket } from 'react-websocket';
import { createTabsWebSocket } from 'react-websocket/tabs';

export const live = createWebSocket<LiveIn, LiveOut>('wss://api.example.com/live', {
  json: true,
  WebSocket: createTabsWebSocket()
});
```

That's the whole change. Each tab keeps its own client, with its own status, queue, reconnects, topics and hooks, but only one tab connects to the server.

## How it works

- **A leader.** The tabs elect one, with the [Web Locks API](https://developer.mozilla.org/en-US/docs/Web/API/Web_Locks_API), to hold the real connection. The others, and the leader's own clients, reach it over a [`BroadcastChannel`](https://developer.mozilla.org/en-US/docs/Web/API/BroadcastChannel).
- **Sends** from any tab go out on the shared connection. **Messages** from the server reach every tab.
- **Closes** reach every tab too, and each tab's client reconnects as usual, through the leader.
- **When the leading tab closes**, another tab takes over the lock and opens a new connection, and every tab's client reconnects through it. Topic subscriptions are sent again, as after any reconnect.
- **The shared connection** opens when a tab first needs it, and closes a second (`linger`) after the last tab lets go, so a reload doesn't close and reopen it.
- **A tab that closes** lets go on `pagehide`, with its topics, so the leader neither keeps the shared connection for it nor holds back an unsubscribe for a topic only it still held. A tab that goes into the back/forward cache lets go the same way, and its clients reconnect when it comes back.

In Chrome, three tabs using the same URL opened three connections without it, and one with it. Closing the leading tab moved the connection to another tab, and both remaining tabs went on receiving their topics.

## Topics

Tabs usually show different things, and share some. Two problems follow, and `topics` fixes both:

```ts
WebSocket: createTabsWebSocket({
  json: true,
  topics: {
    subscribe: message => (message.type === 'subscribe' ? message.topic : undefined),
    unsubscribe: message => (message.type === 'unsubscribe' ? message.topic : undefined),
    topic: message => message.topic
  }
});
```

- **One tab unsubscribing another.** If two tabs show `prices` and one closes its view, its `unsubscribe` would stop prices for both: the server only sees one connection. With `subscribe` and `unsubscribe`, the leader keeps track of which tabs hold each topic, and forwards an unsubscribe only when no other tab still holds it.
- **Every tab getting every topic.** With `topic`, a message goes only to the tabs that hold its topic, so a tab's [state](./state.md) doesn't reduce messages for topics it never asked for. Messages without a topic still go to every tab.

`json: true` hands the functions parsed messages. Recognize every message your app subscribes with: a message on a topic no tab holds is dropped. A message that isn't JSON, such as a [heartbeat](./reconnecting.md#heartbeats) `'ping'`, never reaches them, and one that throws counts as no topic, so `message.type` on a `null` doesn't stop the message.

Subscribes are always forwarded, so a tab that joins a topic gets what the server sends a new subscriber, such as a snapshot. The tabs that already hold the topic get it too, since it comes on the same connection. A [state](./state.md) that replaces itself with a snapshot handles that without doing anything, and [numbered feeds](./topics.md#numbered-feeds) drop events they've already delivered.

In Chrome, with tabs 1 and 2 showing `prices` and tab 3 showing `news`, prices reached tabs 1 and 2 and news only tab 3. When tab 1 let go of `prices`, the server never saw an unsubscribe, and tab 2 went on receiving prices.

## Things to know

- **Same origin, same browser.** `BroadcastChannel` and locks are per origin and browser profile, so tabs on other origins, or in a private window, have their own connection.
- **Each tab's own state.** Messages are delivered to each tab's client, which parses, validates and reduces them itself. Only the connection is shared.
- **A leader in the background.** Browsers slow down timers in background tabs, and the leader is often one. The relay is driven by events, not timers, so it keeps up, but [heartbeats](./reconnecting.md#heartbeats) with short timeouts may fire late there.
- **Where it can't share**, without `BroadcastChannel` or the Web Locks API, each tab opens its own connection, as without it.
- **Server rendering.** Like any `WebSocket` option, nothing connects during a server render.
- **Hot module reloading and tests.** `SharedSocket.dispose()` stops leading and listening in the current tab.

## See also

- [`react-websocket/tabs` API](../api/tabs.md)
- [Shared clients](./shared-clients.md): sharing one connection between the components of one tab
- [Topic subscriptions](./topics.md)
