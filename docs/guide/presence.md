---
title: 'Presence and live cursors over WebSockets'
description: 'Show who is here and where their cursor is: per-peer state shared over a WebSocket, throttled, refreshed, and expired when a peer disappears without saying goodbye.'
---

# Presence and live cursors

Collaborative apps show who else is here: avatars in a corner, cursors moving across a canvas, the cell someone has selected. Each client shares a small piece of state, and sees everyone else's. Done naively, it goes wrong in three ways:

- **Floods.** A pointer moves hundreds of times a second. Sending each move costs bandwidth and server time, and everyone else has to render them.
- **Ghosts.** A laptop sleeps or a tab crashes, the server doesn't notice for a while, and that cursor stays frozen on everyone's screen.
- **Stale replays.** A cursor queued during a reconnect goes out once it's long out of date.

`createWebSocketPresence` handles all three:

```ts
// cursors.ts
import { createWebSocket, createWebSocketPresence } from 'react-websocket';

type Cursor = { x: number; y: number; name: string };
type RoomIn = { type: 'cursor'; peer: string; cursor: Cursor | null };
type RoomOut = { type: 'cursor'; cursor: Cursor } | { type: 'leave' };

export const room = createWebSocket<RoomIn, RoomOut>('wss://draw.example.com/room/42', { json: true });

export const cursors = createWebSocketPresence(room, {
  send: (cursor: Cursor) => ({ type: 'cursor', cursor }),
  leave: () => ({ type: 'leave' }),
  receive: message => (message.type === 'cursor' ? { peer: message.peer, state: message.cursor } : undefined)
});
```

```tsx
import { useWebSocketPresence } from 'react-websocket';
import { cursors } from './cursors';

function Canvas({ name }: { name: string }) {
  const peers = useWebSocketPresence(cursors);
  return (
    <div
      onPointerMove={event => cursors.set({ x: event.clientX, y: event.clientY, name })}
      onPointerLeave={() => cursors.leave()}
    >
      {peers.map(({ peer, state }) => (
        <Cursor key={peer} {...state} />
      ))}
    </div>
  );
}
```

## Sharing your state

`cursors.set(state)` can be called on every pointer move:

- **Throttled.** It sends at most `maxRate` times per second (20 by default). Moves in between are coalesced, and the newest goes out at the end of the interval, so the last position always arrives.
- **Refreshed.** While your state doesn't change, it's sent again every `refresh` ms (a third of `timeout` by default), so the others don't forget you.
- **Never stale.** It's sent with `volatile`, so nothing is queued while disconnected. Every new connection sends the current state instead.

`cursors.leave()` stops sharing and sends `leave`, if you gave one. Call `set()` to share again.

## Seeing the others

`useWebSocketPresence(cursors)` returns the other peers, `{ peer, state, updatedAt }`, in the order they first appeared, and keeps the connection open while mounted. A peer goes away when:

- the server says it left: `receive` returns `state: null`, or
- nothing has arrived from it for `timeout` ms (30 s by default). This catches the ghosts: a peer whose connection died without the server telling anyone.

Keep `refresh` well below `timeout`, so a peer that's still there but idle isn't dropped. The defaults leave room for two lost refreshes.

## The server's side

The server relays each client's state to the others in the room, tagged with an id for the sender, and tells them `state: null` when a client sends `leave` or disconnects. It doesn't echo a client's own state back to it. It's also good to send a newcomer the current state of everyone in the room, so they don't wait for the next refresh.

```ts
// With the `ws` package.
socket.on('message', data => {
  const message = JSON.parse(String(data));
  const cursor = message.type === 'cursor' ? message.cursor : message.type === 'leave' ? null : undefined;
  if (cursor === undefined) return;
  for (const other of room.clients) {
    if (other !== socket) other.send(JSON.stringify({ type: 'cursor', peer: socket.id, cursor }));
  }
});
socket.on('close', () => {
  for (const other of room.clients) other.send(JSON.stringify({ type: 'cursor', peer: socket.id, cursor: null }));
});
```

A peer that reconnects usually gets a new id from the server, so it shows up as a new peer while its old one times out. If your users have stable ids, send yours with the state and use it as `peer`.

## See also

- [`createWebSocketPresence`](../api/create-websocket-presence.md) and [`useWebSocketPresence`](../api/use-websocket-presence.md)
- [Topic subscriptions](./topics.md): join the room's topic, so presence goes to the right people
- [Real-time games](./games.md): `createWebSocketSendRate` for state that's sent every tick
- [Build a multiplayer party game](../recipes/party-game.md): presence that shows which phones are still here
- [Build a team chat app](../recipes/team-chat.md) and [Build a collaborative whiteboard](../recipes/collaborative-whiteboard.md): presence in whole apps, with typing indicators and live cursors
