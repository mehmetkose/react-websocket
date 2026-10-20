---
title: 'Build a team chat app with React and WebSockets'
description: 'A Slack-style team chat over one WebSocket: channels where each message arrives once and in order after a reconnect, an outbox that keeps unsent messages through reloads, unread counts synced across devices, typing and online status, and one connection for every tab.'
---

# Build a team chat app

This guide builds a team chat: channels, a list of who's online, typing indicators and unread counts. Showing a message as it arrives is the easy part. The hard parts are what users never think about until it goes wrong:

1. **Every message once, in order.** After a dropped connection, the client must get exactly what it missed: no gap, no duplicate, nothing out of order.
2. **A message typed is a message sent.** A dropped connection, a reload or a closed laptop shouldn't lose one, or send it twice.
3. **Unread counts that agree.** Read a channel on the laptop, and the phone's count goes to zero.
4. **Who's here, and nobody frozen online.** Someone who closes the tab disappears at once, and someone whose laptop died disappears soon after.
5. **Twelve tabs, one connection.** A user who keeps the chat open in several tabs costs the server one connection, not twelve.

| File | Runs in | |
| --- | --- | --- |
| `protocol.ts` | Both | The messages |
| `live.ts` | The browser | One connection for all tabs, the channels' feeds, unread counts, the outbox and presence |
| `Chat.tsx` | The browser | The page |
| `server.ts` | Node | Numbered channels, catching clients up, acknowledgements and presence |

## The protocol

Messages in a channel are numbered, one more each time, so a client can say where it left off. Everything else is plain messages:

```ts
// protocol.ts: imported by the browser and the server.
export type Message = { id: string; author: string; text: string; at: number };

export type Channel = {
  id: string;
  name: string;
  seq: number; // the number of its latest message
  read: number; // the number of the latest message this user has read
};

/** What a user shares with the others: whether they're typing, and where. */
export type Here = {
  typing: string | null; // a channel id
  user?: string; // set by the server
};

export type ChatIn =
  // A channel's messages, numbered per channel. `topic` is `channel:<id>`.
  | { type: 'message'; topic: string; seq: number; message: Message }
  | { type: 'history'; topic: string; seq: number; messages: Message[] }
  // Every channel the user is in, when the socket opens.
  | { type: 'channels'; channels: Channel[] }
  // A new message in any channel, for the unread counts.
  | { type: 'activity'; channel: string; seq: number }
  // The user read up to `seq`, on this or another device.
  | { type: 'read'; channel: string; seq: number }
  | { type: 'posted'; id: string }
  | { type: 'here'; peer: string; state: Here | null };

export type ChatOut =
  // Sent by every tab when its socket opens: the server replies with `channels` and who's here.
  | { type: 'hello' }
  | { type: 'subscribe'; topic: string; after?: number }
  | { type: 'unsubscribe'; topic: string }
  | { type: 'post'; id: string; channel: string; text: string }
  | { type: 'read'; channel: string; seq: number }
  | { type: 'here'; peer: string; state: Here }
  | { type: 'leave'; peer: string };
```

## The client

```ts
// live.ts
import {
  createWebSocket,
  createWebSocketFeeds,
  createWebSocketPresence,
  createWebSocketState
} from 'react-websocket';
import { createWebSocketOutbox } from 'react-websocket/outbox';
import { createTabsWebSocket } from 'react-websocket/tabs';
import type { Channel, ChatIn, ChatOut, Here, Message } from './protocol';

const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';

export const chat = createWebSocket<ChatIn, ChatOut>(`${scheme}//${location.host}/chat`, {
  json: true,
  // One connection for all the app's tabs. A channel's messages go only to the tabs showing it.
  WebSocket: createTabsWebSocket({
    json: true,
    topics: {
      subscribe: message => (message.type === 'subscribe' ? message.topic : undefined),
      unsubscribe: message => (message.type === 'unsubscribe' ? message.topic : undefined),
      topic: message => message.topic
    }
  })
});

// The tabs share the connection, so the server can't greet each tab when it opens: each one
// asks, from an `open` listener, which runs before anything it queued.
chat.on('open', () => chat.send({ type: 'hello' }));

export const feeds = createWebSocketFeeds(chat, {
  subscribe: (topic, after) => ({ type: 'subscribe', topic, after }),
  unsubscribe: topic => ({ type: 'unsubscribe', topic }),
  sequence: message => (message.type === 'message' ? message : undefined),
  snapshot: message => (message.type === 'history' ? message : undefined)
});

/** The messages of the channels on screen, by topic: each once, in order. */
export const messages = createWebSocketState(feeds, {
  initialState: {} as Record<string, Message[]>,
  reduce: (byTopic, message) => {
    if (message.type === 'history') return { ...byTopic, [message.topic]: message.messages };
    if (message.type !== 'message') return byTopic;
    const list = byTopic[message.topic] ?? [];
    return { ...byTopic, [message.topic]: [...list, message.message] };
  }
});

/** Every channel, with what's in it and what this user has read. */
export const channels = createWebSocketState(chat, {
  initialState: [] as Channel[],
  reduce: (list, message) => {
    if (message.type === 'channels') return message.channels;
    if (message.type !== 'activity' && message.type !== 'read') return list;
    const field = message.type === 'activity' ? 'seq' : 'read';
    return list.map(channel =>
      channel.id === message.channel && channel[field] < message.seq
        ? { ...channel, [field]: message.seq }
        : channel
    );
  }
});

export function markRead(channel: string, seq: number) {
  // Only the newest is worth sending: one still queued is replaced.
  chat.send({ type: 'read', channel, seq }, { key: `read:${channel}` });
}

export const outbox = createWebSocketOutbox(chat, {
  name: 'chat',
  send: (draft: { channel: string; text: string }, id) => ({ type: 'post', id, ...draft }),
  ack: message => (message.type === 'posted' ? message.id : undefined)
});

// Each tab is a peer of its own: the server sees one connection for all of them.
const tab = crypto.randomUUID();

export const here = createWebSocketPresence(chat, {
  send: (state: Here) => ({ type: 'here', peer: tab, state }),
  leave: () => ({ type: 'leave', peer: tab }),
  receive: message => (message.type === 'here' ? message : undefined)
});

// Before the tabs' own `pagehide` listener lets go of the shared connection.
addEventListener('pagehide', () => here.leave());
addEventListener('pageshow', event => event.persisted && here.set({ typing: null }));
```

- **[`createTabsWebSocket`](../guide/tabs.md)** makes every tab of the app share one connection: one tab holds it, and the others reach it over a `BroadcastChannel`. With `topics`, a channel's messages go only to the tabs showing it, and one tab leaving a channel doesn't unsubscribe another.
- **`hello`** is what tabs change on the server. A tab's socket opens through the tab that holds the connection, and the server never hears about it, so it can't greet each tab with the channel list. Each tab asks instead, from an `open` listener, before anything it queued.
- **`feeds`** holds the open channel as a [numbered feed](../guide/topics.md#numbered-feeds). After a reconnect it subscribes again with the number of the last message it got, drops anything it already has, and asks again when a number is skipped. The `messages` store reduces the feed's messages, not the client's, so its reducer sees each message once, in order.
- **`channels`** keeps the unread counts: the newest number in each channel, and the newest one this user has read. Both only go up, so messages that arrive late can't move a count back.
- **`markRead`** sends with a `key`: while disconnected, only the newest read per channel waits in the queue.
- **`outbox`** keeps each message in IndexedDB until the server acknowledges it, and sends it again on every connection until then. See [Offline outbox](../guide/outbox.md).
- **`here`** shares who's online and typing with [presence](../guide/presence.md). The tabs share one connection, so the server can't tell them apart: each tab names itself. `pagehide` sends `leave`, so a closed tab disappears at once instead of after 30 seconds. The listener is added when the module loads, before the first connection adds the tabs' own `pagehide` listener, so the `leave` goes out before the tab lets go of the connection.

## The page

```tsx
// Chat.tsx
import { useEffect, useRef, useState } from 'react';
import {
  useWebSocketOutbox,
  useWebSocketPresence,
  useWebSocketState,
  useWebSocketTopic
} from 'react-websocket';
import { channels, feeds, here, markRead, messages, outbox } from './live';

export function Chat() {
  const list = useWebSocketState(channels);
  const [open, setOpen] = useState('general');

  // Online while the chat is on screen.
  useEffect(() => {
    here.set({ typing: null });
    return () => here.leave();
  }, []);

  return (
    <div className="chat">
      <nav>
        {list.map(channel => (
          <button
            key={channel.id}
            aria-current={channel.id === open}
            onClick={() => setOpen(channel.id)}
          >
            # {channel.name}
            {channel.id !== open && channel.seq > channel.read && (
              <b aria-label="unread"> {channel.seq - channel.read}</b>
            )}
          </button>
        ))}
        <Online />
      </nav>
      <Room key={open} channel={open} />
    </div>
  );
}

function Room({ channel }: { channel: string }) {
  const topic = `channel:${channel}`;
  useWebSocketTopic(feeds, topic);
  const list = useWebSocketState(messages, byTopic => byTopic[topic]);
  const waiting = useWebSocketOutbox(outbox);

  // Read up to the newest message whenever it changes while the tab is visible.
  useEffect(() => {
    const read = () => {
      const seq = feeds.position(topic);
      if (seq && document.visibilityState === 'visible') markRead(channel, seq);
    };
    read();
    document.addEventListener('visibilitychange', read);
    return () => document.removeEventListener('visibilitychange', read);
  }, [channel, topic, list]);

  // Sent, but not back from the server yet.
  const pending = waiting.filter(
    entry => entry.message.channel === channel && !list?.some(message => message.id === entry.id)
  );

  return (
    <section>
      <ol>
        {list?.map(message => (
          <li key={message.id}>
            <b>{message.author}</b> {message.text}
          </li>
        ))}
        {pending.map(entry => (
          <li key={entry.id} className="pending">
            <b>You</b> {entry.message.text}{' '}
            <small>{entry.sent ? 'Sending…' : 'Not sent yet'}</small>
          </li>
        ))}
      </ol>
      <Typing channel={channel} />
      <Composer channel={channel} />
    </section>
  );
}

function Online() {
  const peers = useWebSocketPresence(here);
  const users = [...new Set(peers.map(peer => peer.state.user))];
  return <p>{users.length ? `Online: ${users.join(', ')}` : 'Nobody else is here'}</p>;
}

function Typing({ channel }: { channel: string }) {
  const peers = useWebSocketPresence(here);
  const typing = peers.filter(peer => peer.state.typing === channel);
  const names = [...new Set(typing.map(peer => peer.state.user))];
  if (!names.length) return null;
  return <p role="status">{names.join(', ')} typing…</p>;
}

function Composer({ channel }: { channel: string }) {
  const [text, setText] = useState('');
  const typing = useRef(false);
  const idle = useRef<ReturnType<typeof setTimeout>>(undefined);

  function setTyping(now: boolean) {
    clearTimeout(idle.current);
    if (now) idle.current = setTimeout(() => setTyping(false), 3000);
    if (typing.current === now) return;
    typing.current = now;
    here.set({ typing: now ? channel : null });
  }

  // Leaving the channel stops the typing indicator there.
  useEffect(
    () => () => {
      clearTimeout(idle.current);
      if (typing.current) here.set({ typing: null });
    },
    []
  );

  return (
    <form
      onSubmit={event => {
        event.preventDefault();
        if (!text.trim()) return;
        outbox.add({ channel, text }).catch(console.error);
        setText('');
        setTyping(false);
      }}
    >
      <input
        value={text}
        onChange={event => {
          setText(event.target.value);
          setTyping(event.target.value !== '');
        }}
      />
      <button>Send</button>
    </form>
  );
}
```

- **A channel on screen** is a held topic: `useWebSocketTopic` subscribes when `Room` mounts and unsubscribes when it unmounts. Switching channels remounts `Room` with a new `key`.
- **Reading** happens whenever the newest message changes while the tab is visible, and when the tab becomes visible again. `feeds.position(topic)` is the number of the last message the feed delivered.
- **Unsent messages** come from the outbox, below the channel's messages, until the server's copy arrives with the same id. "Not sent yet" means the connection is down, and "Sending…" that it went out and waits for its acknowledgement.
- **Typing** starts with the first keystroke, and stops three seconds after the last one, when the message is sent, or when the user leaves the channel. The composer calls `here.set()` only when it starts or stops, and presence refreshes the state in between.

## The server

The server numbers each channel's messages, keeps the last thousand to catch clients up, and answers every message with its id. It runs in Node 22.18 or later without a build step, which is why it imports `.ts` files by name. Everything lives in memory here: keep the channels, their numbers and the handled ids in your database.

### Channels and catching up

```ts
// server.ts
import { createServer } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import { userFromCookie } from './auth.ts';
import type { ChatIn, ChatOut, Here, Message } from './protocol.ts';

type Feed = { id: string; seq: number; history: { seq: number; message: Message }[] };

const KEPT = 1000; // messages kept per channel, to catch a client up after a reconnect
const SHOWN = 50; // messages in a channel's history for a client that starts fresh

const feeds = new Map<string, Feed>(); // use your database
for (const id of ['general', 'random']) feeds.set(id, { id, seq: 0, history: [] });

const read = new Map<string, number>(); // `${user}:${channel}`: the newest message read
const posted = new Set<string>(); // outbox ids already handled: a table in production
const subscribers = new Map<string, Set<WebSocket>>(); // topic: the sockets following it
const users = new Map<WebSocket, string>(); // socket: its user
const peers = new Map<string, { socket: WebSocket; state: Here }>(); // who's here

function send(socket: WebSocket, message: ChatIn) {
  socket.send(JSON.stringify(message));
}

function broadcast(message: ChatIn, except?: WebSocket) {
  for (const socket of users.keys()) if (socket !== except) send(socket, message);
}

function hello(socket: WebSocket, user: string) {
  const list = [...feeds.values()].map(({ id, seq }) => ({
    id,
    name: id,
    seq,
    read: read.get(`${user}:${id}`) ?? 0
  }));
  send(socket, { type: 'channels', channels: list });
  for (const [peer, { socket: other, state }] of peers) {
    if (other !== socket) send(socket, { type: 'here', peer, state });
  }
}

/** Catch a socket up on a channel, then follow it live. */
function subscribe(socket: WebSocket, topic: string, after: number | undefined) {
  const feed = feeds.get(topic.replace('channel:', ''));
  if (!feed) return;
  const oldest = feed.history[0]?.seq ?? feed.seq + 1;
  // A fresh start, a client too far behind, or one ahead of a server that lost its numbers.
  if (after === undefined || after < oldest - 1 || after > feed.seq) {
    const messages = feed.history.slice(-SHOWN).map(entry => entry.message);
    send(socket, { type: 'history', topic, seq: feed.seq, messages });
  } else {
    for (const { seq, message } of feed.history) {
      if (seq > after) send(socket, { type: 'message', topic, seq, message });
    }
  }
  const sockets = subscribers.get(topic) ?? new Set();
  subscribers.set(topic, sockets.add(socket));
}
```

- **A client that's behind by a few messages** gets just those, then everything new.
- **A client starting fresh, or too far behind,** gets the channel's history: the last 50 messages and the channel's number. The feed always delivers that snapshot, and numbering goes on from it.
- **A client ahead of the server** gets the history too. That only happens when the server lost its numbers, say a restart with nothing persisted. Without this, the client would drop the server's next messages as duplicates of ones it already had.

### Messages

```ts
function markRead(user: string, channel: string, seq: number) {
  const key = `${user}:${channel}`;
  if (seq <= (read.get(key) ?? 0)) return;
  read.set(key, seq);
  // Every device of the user clears its unread count.
  for (const [socket, owner] of users) {
    if (owner === user) send(socket, { type: 'read', channel, seq });
  }
}

type Post = Extract<ChatOut, { type: 'post' }>;

function post(socket: WebSocket, user: string, { id, channel, text }: Post) {
  const feed = feeds.get(channel);
  if (feed && !posted.has(id)) {
    posted.add(id);
    const message: Message = { id, author: user, text, at: Date.now() };
    const seq = ++feed.seq;
    feed.history.push({ seq, message });
    if (feed.history.length > KEPT) feed.history.shift();
    const topic = `channel:${feed.id}`;
    for (const other of subscribers.get(topic) ?? []) {
      send(other, { type: 'message', topic, seq, message });
    }
    broadcast({ type: 'activity', channel: feed.id, seq });
    markRead(user, feed.id, seq); // your own message isn't unread
  }
  // Acknowledge an id it has seen, too: the first acknowledgement may never have arrived.
  send(socket, { type: 'posted', id });
}
```

- **Each message id is handled once.** The outbox sends a message again on every connection until it's acknowledged, and two tabs can both send one they found in storage. A second copy gets an acknowledgement and nothing else.
- **`activity`** goes to everyone, in every channel, for the unread counts. Only the channel's subscribers get the message itself.
- **Your own messages** are marked read for you.

### The connection

```ts
function connected(socket: WebSocket, user: string) {
  users.set(socket, user);

  socket.on('message', data => {
    const message = JSON.parse(String(data)) as ChatOut; // validate it in production
    switch (message.type) {
      case 'hello':
        return hello(socket, user);
      case 'subscribe':
        return subscribe(socket, message.topic, message.after);
      case 'unsubscribe':
        return void subscribers.get(message.topic)?.delete(socket);
      case 'post':
        return post(socket, user, message);
      case 'read':
        return markRead(user, message.channel, message.seq);
      case 'here': {
        // Peers are named by user and tab: the user's tabs share this socket.
        const peer = `${user}:${message.peer}`;
        const state = { ...message.state, user };
        peers.set(peer, { socket, state });
        return broadcast({ type: 'here', peer, state }, socket);
      }
      case 'leave': {
        const peer = `${user}:${message.peer}`;
        peers.delete(peer);
        return broadcast({ type: 'here', peer, state: null }, socket);
      }
    }
  });

  socket.on('close', () => {
    users.delete(socket);
    for (const sockets of subscribers.values()) sockets.delete(socket);
    for (const [peer, entry] of peers) {
      if (entry.socket !== socket) continue;
      peers.delete(peer);
      broadcast({ type: 'here', peer, state: null });
    }
  });
}

const server = createServer();
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', async (request, stream, head) => {
  const url = new URL(request.url ?? '/', 'http://localhost');
  // Any site can open a socket to yours with the user's cookies: check where it comes from.
  if (url.pathname !== '/chat' || request.headers.origin !== process.env.APP_ORIGIN) {
    return stream.destroy();
  }
  const user = await userFromCookie(request.headers.cookie);
  wss.handleUpgrade(request, stream, head, socket => {
    if (user) connected(socket, user);
    else socket.close(1008, 'Unauthorized'); // the client doesn't retry 1008
  });
});

server.listen(Number(process.env.PORT ?? 8080));
```

Peers are named by user and tab, since a user's tabs share one socket. When a socket closes, every peer on it leaves at once.

## When things go wrong

| What happens | What the user sees | Why |
| --- | --- | --- |
| The connection drops for a while | Nothing, then the messages they missed, in order | The feed subscribes again with the last number, and the server sends what came after |
| They send while offline | Their message with "Not sent yet", then sent when the connection is back | The outbox stores it, and sends it on the next connection |
| They reload with messages unsent | The same messages, still waiting, then sent | The outbox loads them from IndexedDB before sending anything new |
| A message goes out twice | One message | The server handles each id once, and acknowledges every copy |
| They read a channel on one device | The count goes to zero on the others | The server sends `read` to every socket of the user |
| They open a second tab | The same connection | `createTabsWebSocket`. The new tab says `hello` and gets the channel list |
| They close a tab | Others see them leave at once, if it was their last tab | `leave` on `pagehide` |
| Their laptop dies | Others see them leave within 30 seconds | Presence forgets a peer it hasn't heard from |
| The server restarts and lost its messages | The channel shows what the server has now | A client ahead of the server gets the history |

In Chrome, against the server on this page, with two users and three tabs:

- **Tabs.** Alice's two tabs opened one connection to the server, and each sent its own `hello` and `subscribe` over it.
- **Unread counts.** Two messages in a channel she wasn't showing showed "2" in both her tabs. Opening the channel in one tab cleared the count in both.
- **Resuming.** A connection closed and opened again while three messages were posted subscribed again from message 2, and got exactly those three, in order.
- **Reloading.** Two messages sent while the server was down survived a reload of the tab, went out once the server was back, and reached the other user once each.
- **Closing a tab.** Its `leave` reached the server before the tab let go of the connection, and the other user's list dropped that tab's peer within half a second.

## Testing it

Run two browser profiles, one per user, and several tabs in each. Stop the server while sending to watch the outbox, and use [`react-websocket/chaos`](../guide/chaos.md) to drop the connection at random. Pass `storage: memoryStorage()` to the outbox in unit tests, so they don't depend on IndexedDB.

## See also

- [Topic subscriptions and numbered feeds](../guide/topics.md#numbered-feeds), [`createWebSocketFeeds`](../api/create-websocket-feeds.md)
- [Offline outbox](../guide/outbox.md) and [`createWebSocketOutbox`](../api/create-websocket-outbox.md)
- [Presence and live cursors](../guide/presence.md) and [One connection across tabs](../guide/tabs.md)
- [Build a collaborative whiteboard](./collaborative-whiteboard.md): the same building blocks for drawing together
