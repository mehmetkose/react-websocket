---
description: 'createTabsWebSocket from react-websocket/tabs: a WebSocket class that shares one connection between all the tabs of an app.'
---

# createTabsWebSocket

A `WebSocket` class that shares one connection between all the tabs of an app. Pass it as the [`WebSocket`](./options.md#websocket) option.

```ts
function createTabsWebSocket(options?: {
  WebSocket?: typeof WebSocket;
  json?: boolean;
  topics?: {
    subscribe: (message: any) => string | null | undefined;
    unsubscribe: (message: any) => string | null | undefined;
    topic?: (message: any) => string | null | undefined;
  };
  linger?: number;
}): TabsWebSocket;
```

Available only from `react-websocket/tabs`. It has no React dependency and no imports, and its size (about 1.7 kB min+gzip) is separate from the main entry's. The guide is [One connection across tabs](../guide/tabs.md).

## Usage

```ts
import { createWebSocket } from 'react-websocket';
import { createTabsWebSocket } from 'react-websocket/tabs';

export const live = createWebSocket(url, { json: true, WebSocket: createTabsWebSocket() });
```

## Parameters

| Option | Type | |
| --- | --- | --- |
| `WebSocket` | `typeof WebSocket` | Optional. The `WebSocket` the leading tab opens, and each tab where sharing isn't possible. Default: the global one |
| `json` | `boolean` | Optional. Messages are JSON, so the `topics` functions get them parsed |
| `topics.subscribe` | `(message) => string \| null \| undefined` | The topic an outgoing message subscribes to |
| `topics.unsubscribe` | `(message) => string \| null \| undefined` | The topic an outgoing message unsubscribes from. It's forwarded only when no other tab holds the topic |
| `topics.topic` | `(message) => string \| null \| undefined` | Optional. The topic of an incoming message, which then goes only to the tabs that hold it. A message on a topic no tab holds is dropped |
| `linger` | `number` | Optional. How long the leading tab keeps the shared connection after the last tab lets go, in ms. Default `1000` |

## Returns

A `TabsWebSocket`: a class with the `WebSocket` interface, to pass as the `WebSocket` option, plus:

| Member | |
| --- | --- |
| `dispose()` | Stop leading and listening in this tab: close the shared connections it holds and let another tab take over. For hot module reloading and tests |

## Behavior

| | |
| --- | --- |
| Opening | A tab's socket opens once the leader's connection is open, at once if it already is |
| `send()` | Relayed to the leader, which sends it on the shared connection |
| Messages | Relayed to every tab's open socket, or only to the tabs holding its topic |
| The server closes | Every tab's socket closes with the same code, and each client reconnects |
| A tab's `close()` | Closes only that tab's socket. The shared connection closes `linger` ms after the last one |
| The leading tab closes | Another tab leads. Sockets open through the old leader close with `1006`, and their clients reconnect through the new one |
| `bufferedAmount` | `0`: the leader's buffer isn't visible to other tabs, so `maxBuffered` doesn't drop sends |
| No `BroadcastChannel` or locks | Each tab opens its own connection |
| No `window` | The constructor throws, so nothing connects during a server render |
