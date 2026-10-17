---
description: 'createWebSocketPresence: share per-peer state such as cursors over a WebSocket, throttled and refreshed, with peers that expire when they go quiet.'
---

# createWebSocketPresence

Share per-peer state that expires, for presence, live cursors and selections.

```ts
function createWebSocketPresence<P, In, Out>(
  client: WebSocketClient<In, Out>,
  options: {
    send: (state: P) => Out;
    leave?: () => Out;
    receive: (message: In) => { peer: string; state: P | null } | null | undefined;
    timeout?: number;
    refresh?: number;
    maxRate?: number;
  }
): WebSocketPresence<P>;
```

Available from both `react-websocket` and `react-websocket/core`. Render the peers with [`useWebSocketPresence`](./use-websocket-presence.md). The guide is [Presence and live cursors](../guide/presence.md).

## Usage

```ts
export const cursors = createWebSocketPresence(room, {
  send: (cursor: { x: number; y: number }) => ({ type: 'cursor', cursor }),
  leave: () => ({ type: 'leave' }),
  receive: message => (message.type === 'cursor' ? { peer: message.peer, state: message.cursor } : undefined)
});

window.addEventListener('pointermove', event => cursors.set({ x: event.clientX, y: event.clientY }));
```

Annotate `send`'s `state` parameter: that's what `cursors.set()` accepts.

## Parameters

| Parameter | Type | |
| --- | --- | --- |
| `client` | [`WebSocketClient<In, Out>`](./types.md#websocketclient) | The client to share on. `In` and `Out` are taken from it |
| `options.send` | `(state: P) => Out` | The message that shares this client's state |
| `options.leave` | `() => Out` | Optional. The message that says this client left, sent by `leave()` |
| `options.receive` | `(message: In) => { peer, state } \| null \| undefined` | Recognize another peer's state, or `state: null` when it left. `undefined` for any other message |
| `options.timeout` | `number` | Optional. Forget a peer nothing has arrived from for this long, in ms. Default `30000` |
| `options.refresh` | `number` | Optional. Send this client's state again this often while it doesn't change, in ms. Default `timeout / 3` |
| `options.maxRate` | `number` | Optional. Sends per second at most; changes in between are coalesced, the newest last. Default `20` |

## Returns

A `WebSocketPresence<P>`:

| Member | |
| --- | --- |
| `set(state)` | Share this client's state: throttled to `maxRate`, refreshed, and sent again on every new connection |
| `leave()` | Stop sharing, drop an update not sent yet, and send `leave` |
| `getSnapshot()` | The other peers, `{ peer, state, updatedAt }[]`, in the order they first appeared. A new array on every change |
| `subscribe(listener)` | Get notified when the peers change. Compatible with `useSyncExternalStore` |
| `client` | The client |
| `dispose()` | Stop sharing and listening |

## Behavior

- **Volatile.** Updates are sent with `volatile`, so none is queued while disconnected; a new connection gets the current state from an `open` listener.
- **Expiry.** A peer is removed `timeout` ms after its last update, by a single timer for the next one due.
- **Connection.** It doesn't open the connection; `useWebSocketPresence` holds it while mounted.
