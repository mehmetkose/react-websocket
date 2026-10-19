---
title: 'Build live notifications with React and WebSockets'
description: 'In-app notifications over one WebSocket shared by every tab: an unread badge, a feed that resumes from the last notice after a reload, mark-as-read that survives going offline, desktop notifications, and sign-out everywhere.'
---

# Build live notifications

This guide builds the notification bell that sits in the header of every page of an app: a badge with the unread count, a list, and a system notification when the tab is in the background. It's a small component, but it's mounted in every tab the user has open, which is where the trouble starts:

1. **Every tab connects.** A user with ten tabs open costs the server ten connections, all receiving the same notices.
2. **Every reload starts over.** Loading the whole list again on every page load, in every tab, is wasted work, and the bell shows nothing until it arrives.
3. **Read state must agree everywhere.** A notice read in one tab, or on the phone, should stop counting in all of them, even if it was read while offline.
4. **One notice, one popup.** Every hidden tab receives the notice. Each showing it would pop up ten system notifications.
5. **Signing out means everywhere.** Every tab should stop receiving the user's notices at once.
6. **It renders on the server.** The bell lives in a layout that's server-rendered, so nothing in it may touch the browser before hydration.

| File | Runs in | |
| --- | --- | --- |
| `protocol.ts` | Both | The messages |
| `live.ts` | The browser, and imported on the server | The shared connection, the inbox and mark-as-read |
| `desktop.ts` | The browser | System notifications while the tab is hidden |
| `notification-bell.tsx` | The browser | The bell |
| `app/layout.tsx` | The server | Where the bell goes in a Next.js app |
| `auth.ts`, `server.ts` | Node | Tokens, inboxes and the connection |

## The protocol

The user's notices are one numbered feed, `inbox`: the latest notices, then each new notice and each read, numbered.

```ts
// protocol.ts: imported by the browser and the server.
export type Notice = {
  id: string;
  title: string;
  body: string;
  url: string;
  at: number; // Date.now() on the server when it was created
  read: boolean;
};

export type NotifyIn =
  // On the `inbox` topic: the latest notices as of `seq`, then numbered changes.
  | { type: 'inbox'; topic: string; seq: number; notices: Notice[] }
  | { type: 'notice'; topic: string; seq: number; notice: Notice }
  | { type: 'read'; topic: string; seq: number; ids: string[] }
  // The server has applied a mark-read with this idempotency key.
  | { type: 'ack'; id: string };

export type NotifyOut =
  | { type: 'auth'; token: string }
  | { type: 'subscribe'; topic: string; after?: number }
  | { type: 'unsubscribe'; topic: string }
  | { type: 'mark-read'; id: string; ids: string[] };
```

## The client

### One connection for every tab

```ts
// live.ts: safe to import during a server render. Nothing connects there.
import {
  createWebSocket,
  createWebSocketFeeds,
  createWebSocketState,
  retryableClose
} from 'react-websocket/core';
import { createWebSocketOutbox } from 'react-websocket/outbox';
import { createTabsWebSocket } from 'react-websocket/tabs';
import type { Notice, NotifyIn, NotifyOut } from './protocol';

let token = '';

export const notify = createWebSocket<NotifyIn, NotifyOut>(
  async () => {
    // A fresh token for every attempt. It goes in the first message, not the URL: tabs share
    // a connection per URL, so a token in the URL would give every tab its own.
    const response = await fetch('/api/socket-token', { method: 'POST' });
    if (!response.ok) throw new Error(`No token: HTTP ${response.status}`);
    token = ((await response.json()) as { token: string }).token;
    return `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/notifications`;
  },
  {
    json: true,
    // One connection for every tab of the app.
    WebSocket: createTabsWebSocket({
      json: true,
      topics: {
        subscribe: message => (message.type === 'subscribe' ? message.topic : undefined),
        unsubscribe: message => (message.type === 'unsubscribe' ? message.topic : undefined)
      }
    }),
    // 4401: signed out. Reconnecting won't help.
    reconnect: { shouldReconnect: close => close.code !== 4401 && retryableClose(close) }
  }
);

// Before anything else on every connection: this listener runs before the subscriptions.
notify.on('open', () => notify.send({ type: 'auth', token }));
```

- **[`createTabsWebSocket`](../guide/tabs.md)** elects one tab to hold the connection. The others reach it over a `BroadcastChannel`, and every tab keeps its own client, state and hooks. With `topics`, one tab closing its bell can't unsubscribe the others.
- **The token goes in a message, not the URL.** Tabs share a connection per URL, so a token in the URL, fresh for every attempt, would give each tab a URL of its own and a connection of its own. The URL function still fetches a fresh token before every attempt, and an `open` listener sends it first, before the subscriptions. See [First-message auth](../guide/authentication.md#first-message-auth).
- **`4401`** is the server saying the user signed out. The client doesn't retry it, so a signed-out tab stays disconnected instead of knocking on the door every few seconds.

### The inbox, from where you left off

```ts
export type Inbox = { seq?: number; notices: Notice[] };

const CACHE = 'notifications';

function readCache(): Inbox {
  try {
    return JSON.parse(localStorage.getItem(CACHE) ?? '') as Inbox;
  } catch {
    return { notices: [] }; // nothing cached, or a server render
  }
}

const cached = readCache();

export const feeds = createWebSocketFeeds(notify, {
  // After a reload, carry on from the cached notices instead of loading them all again.
  subscribe: (topic, after) => ({ type: 'subscribe', topic, after: after ?? cached.seq }),
  unsubscribe: topic => ({ type: 'unsubscribe', topic }),
  sequence: message => (message.type === 'notice' || message.type === 'read' ? message : undefined),
  snapshot: message => (message.type === 'inbox' ? message : undefined)
});

const markRead = (notices: Notice[], ids: string[]) =>
  notices.map(notice => (ids.includes(notice.id) ? { ...notice, read: true } : notice));

export const inbox = createWebSocketState(feeds, {
  // Empty, like the server render, so hydration matches. The cache is applied right after.
  initialState: { notices: [] } as Inbox,
  reduce: (state, message): Inbox => {
    switch (message.type) {
      case 'inbox':
        return { seq: message.seq, notices: message.notices };
      case 'notice':
        return { seq: message.seq, notices: [message.notice, ...state.notices].slice(0, 50) };
      case 'read':
        return { seq: message.seq, notices: markRead(state.notices, message.ids) };
      default:
        return state;
    }
  }
});

inbox.setState(cached);
inbox.subscribe(() => {
  try {
    localStorage.setItem(CACHE, JSON.stringify(inbox.getState()));
  } catch {
    // Storage is full or blocked: the next page load fetches the notices again.
  }
});
```

- **The cache.** Every change to the inbox is saved to `localStorage`, so the next page load shows the notices at once.
- **Resuming after a reload.** [Feeds](../guide/topics.md#numbered-feeds) forget their position when the page goes away, so `subscribe` falls back on the cached one: the server sends only what changed since. With no cache, or one the server can't resume from, it sends the latest notices.
- **Hydration.** `initialState` is empty, like the server render, and the cache is applied with `setState` right after. Hooks read `initialState` during hydration, so the server's HTML and the first client render agree, and the cached notices render right after.

### Marking as read, and signing out

```ts
// Kept in IndexedDB until the server acknowledges them, through reconnects and reloads.
export const reads = createWebSocketOutbox(notify, {
  name: 'reads',
  send: (ids: string[], id) => ({ type: 'mark-read', id, ids }),
  ack: message => (message.type === 'ack' ? message.id : undefined)
});

export function read(ids: string[]) {
  if (!ids.length) return;
  inbox.setState(state => ({ ...state, notices: markRead(state.notices, ids) }));
  void reads.add(ids);
}

// Signed out, in this tab or another: forget this user's notices.
notify.on('close', ({ code }) => {
  if (code !== 4401) return;
  localStorage.removeItem(CACHE);
  inbox.reset();
  void reads.clear();
});
```

`read()` updates the badge at once, then adds the read to an [outbox](../guide/outbox.md): it's kept in IndexedDB and sent until the server acknowledges it, through reconnects and reloads. The server turns it into a numbered `read`, which every tab and every device of the user receives.

## The bell

```tsx
// notification-bell.tsx
'use client';
import { useEffect, useState } from 'react';
import {
  useWebSocketOutbox,
  useWebSocketState,
  useWebSocketStatus,
  useWebSocketTopic
} from 'react-websocket';
import './desktop';
import { feeds, inbox, notify, read, reads } from './live';

export function NotificationBell() {
  const status = useWebSocketStatus(notify);
  useWebSocketTopic(feeds, 'inbox');
  const notices = useWebSocketState(inbox, state => state.notices);
  const syncing = useWebSocketOutbox(reads).length;
  const [open, setOpen] = useState(false);
  const [permission, setPermission] = useState<NotificationPermission | 'unsupported'>();

  // Only the browser knows: read it after hydration, so the server render matches.
  useEffect(() => {
    setPermission(typeof Notification === 'undefined' ? 'unsupported' : Notification.permission);
  }, []);

  if (status === 'closed') return <a href="/login">Sign in</a>;
  const unread = notices.filter(notice => !notice.read);
  return (
    <div className="bell">
      <button aria-expanded={open} onClick={() => setOpen(!open)}>
        Notifications{unread.length > 0 && <span className="badge">{unread.length}</span>}
      </button>
      {open && (
        <div role="dialog" aria-label="Notifications">
          <button onClick={() => read(unread.map(notice => notice.id))}>Mark all read</button>
          {syncing > 0 && <span role="status">Syncing…</span>}
          <ul>
            {notices.map(notice => (
              <li key={notice.id} className={notice.read ? 'read' : undefined}>
                <a href={notice.url} onClick={() => read([notice.id])}>
                  <strong>{notice.title}</strong> {notice.body}
                </a>
              </li>
            ))}
          </ul>
          {permission === 'default' && (
            <button onClick={() => void Notification.requestPermission().then(setPermission)}>
              Notify me when this tab is in the background
            </button>
          )}
        </div>
      )}
    </div>
  );
}
```

- **`useWebSocketTopic`** holds the `inbox` feed while the bell is mounted. Each tab holds it, and the shared connection carries it once.
- **The badge** counts unread notices. It updates in every tab: here when the user reads, elsewhere when the server's `read` arrives.
- **"Syncing…"** shows while reads wait in the outbox for the server, such as while offline.
- **The permission** for system notifications is read after hydration, since the server can't know it. `Notification.requestPermission()` runs from the click, as browsers require.

### Desktop notifications

```ts
// desktop.ts: a system notification for each new notice while the tab is hidden.
import { feeds } from './live';

feeds.on('message', message => {
  if (message.type !== 'notice' || !document.hidden) return;
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
  const { notice } = message;
  // Caught up after a reconnect: too old to pop up now. It's in the list.
  if (Date.now() - notice.at > 60_000) return;
  // Every hidden tab gets the message. The same tag shows it once.
  const shown = new Notification(notice.title, { body: notice.body, tag: notice.id });
  shown.onclick = () => {
    window.focus();
    location.assign(notice.url);
  };
});
```

- **Only while hidden.** A visible tab already shows the badge.
- **Once.** Every hidden tab receives the notice and creates a notification, but they share its id as their `tag`, and a notification with the same tag replaces the one before instead of adding another.
- **Not after a reconnect.** Notices that arrive more than a minute late, caught up after the laptop slept, go in the list without a popup.

## In a Next.js layout

The bell goes in the root layout, so every page has it. The layout stays a Server Component. The bell is a Client Component (`'use client'`), and `live.ts` is safe to import during the server render: `react-websocket/core`, the outbox and the tabs class don't connect there, and `readCache()` catches the missing `localStorage`.

```tsx
// app/layout.tsx: a Server Component. The bell is a Client Component inside it.
import type { ReactNode } from 'react';
import { NotificationBell } from './notification-bell';

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <header>
          <NotificationBell />
        </header>
        {children}
      </body>
    </html>
  );
}
```

The server's HTML has the bell with no notices. After hydration, it shows the cached ones, then connects. See [Server rendering and Next.js](../guide/ssr.md).

## The server

### Tokens

```ts
// auth.ts: short-lived socket tokens, signed with a secret only the server knows.
import { createHmac, timingSafeEqual } from 'node:crypto';

const secret = process.env.SOCKET_SECRET ?? '';
const sign = (payload: string) => createHmac('sha256', secret).update(payload).digest('base64url');

export function issueToken(userId: string) {
  const payload = `${userId}.${Date.now() + 60_000}`; // valid for a minute
  return `${payload}.${sign(payload)}`;
}

/** The user's id, if the token is ours and hasn't expired. Ids mustn't contain a `.`. */
export function verifyToken(token: string): string | undefined {
  const [userId, expires, signature = ''] = token.split('.');
  const expected = sign(`${userId}.${expires}`);
  if (signature.length !== expected.length) return undefined;
  if (!timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return undefined;
  return Number(expires) > Date.now() ? userId : undefined;
}
```

A token is the user's id, an expiry a minute away, and a signature only the server can make. `verifyToken` is synchronous, so a `subscribe` right behind the `auth` message never arrives before the connection knows its user.

### Inboxes

```ts
// server.ts
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import { issueToken, verifyToken } from './auth.ts';
import { userFromRequest } from './session.ts';
import type { Notice, NotifyIn, NotifyOut } from './protocol.ts';

type Change = Extract<NotifyIn, { type: 'notice' | 'read' }>;
type Inbox = { seq: number; notices: Notice[]; history: Change[] };

const inboxes = new Map<string, Inbox>(); // by user: your database
const connections = new Map<string, Set<WebSocket>>(); // each user's sockets: one per browser
const subscribed = new WeakSet<WebSocket>();
const handled = new Set<string>(); // mark-read keys already applied: your database

function send(socket: WebSocket, message: NotifyIn) {
  socket.send(JSON.stringify(message));
}

function inboxOf(userId: string) {
  let inbox = inboxes.get(userId);
  if (!inbox) inboxes.set(userId, (inbox = { seq: 0, notices: [], history: [] }));
  return inbox;
}

/** Number a change, keep it for connections that come back, and send it to the live ones. */
function publish(userId: string, change: (seq: number) => Change) {
  const inbox = inboxOf(userId);
  const numbered = change(++inbox.seq);
  inbox.history.push(numbered);
  if (inbox.history.length > 200) inbox.history.shift();
  for (const socket of connections.get(userId) ?? []) {
    if (subscribed.has(socket)) send(socket, numbered);
  }
}

function subscribe(socket: WebSocket, userId: string, after: number | undefined) {
  subscribed.add(socket);
  const inbox = inboxOf(userId);
  const oldest = inbox.history[0]?.seq ?? inbox.seq + 1;
  // New, too far behind, or ahead of us (a cache from before a reset): the latest notices.
  if (after === undefined || after < oldest - 1 || after > inbox.seq) {
    const notices = inbox.notices.slice(0, 50);
    return send(socket, { type: 'inbox', topic: 'inbox', seq: inbox.seq, notices });
  }
  for (const change of inbox.history) if (change.seq > after) send(socket, change);
}

/** Called by the rest of your backend: someone commented, a build finished… */
export function createNotice(userId: string, notice: Omit<Notice, 'id' | 'at' | 'read'>) {
  const created = { ...notice, id: randomUUID(), at: Date.now(), read: false };
  const inbox = inboxOf(userId);
  inbox.notices = [created, ...inbox.notices].slice(0, 200);
  publish(userId, seq => ({ type: 'notice', topic: 'inbox', seq, notice: created }));
}

/** Called by your logout handler: every tab of every browser of the user is signed out. */
export function signOut(userId: string) {
  for (const socket of connections.get(userId) ?? []) socket.close(4401, 'Signed out');
}
```

- **`publish`** numbers each change, keeps the last 200 for connections that come back, and sends it to the user's live connections: one per browser, whatever the number of tabs.
- **`subscribe`** sends the changes after `after`, or the latest notices when it can't: a new subscriber, one too far behind, or one with a cache from before the server's history began.
- **`createNotice` and `signOut`** are for the rest of your backend: call `createNotice` when someone comments, a build finishes, an invoice is paid. Call `signOut` from your logout handler, and every tab of every browser of the user closes with `4401`.

### The connection

```ts
function connected(socket: WebSocket) {
  let userId: string | undefined;

  socket.on('message', data => {
    const message = JSON.parse(String(data)) as NotifyOut; // validate it in production
    if (message.type === 'auth') {
      // Every tab sends its own, on the one connection they share: all for the same user.
      const user = verifyToken(message.token);
      if (!user || (userId && user !== userId)) return socket.close(4401, 'Signed out');
      userId = user;
      let sockets = connections.get(userId);
      if (!sockets) connections.set(userId, (sockets = new Set()));
      sockets.add(socket);
      return;
    }
    if (!userId) return socket.close(4401, 'Signed out');

    switch (message.type) {
      case 'subscribe':
        subscribe(socket, userId, message.after);
        break;
      case 'unsubscribe':
        subscribed.delete(socket);
        break;
      case 'mark-read': {
        // Sent again after a reconnect, and by every tab that stored it: apply it once.
        if (!handled.has(message.id)) {
          handled.add(message.id);
          const inbox = inboxOf(userId);
          inbox.notices = inbox.notices.map(notice =>
            message.ids.includes(notice.id) ? { ...notice, read: true } : notice
          );
          publish(userId, seq => ({ type: 'read', topic: 'inbox', seq, ids: message.ids }));
        }
        send(socket, { type: 'ack', id: message.id });
        break;
      }
    }
  });

  socket.on('close', () => {
    if (userId) connections.get(userId)?.delete(socket);
  });
}

// Your app's API, which already knows the signed-in user from its session.
const server = createServer(async (request, response) => {
  const userId = request.method === 'POST' ? await userFromRequest(request) : undefined;
  if (!userId) return response.writeHead(401).end();
  if (request.url === '/api/socket-token') {
    response.setHeader('Content-Type', 'application/json');
    return response.end(JSON.stringify({ token: issueToken(userId) }));
  }
  if (request.url === '/api/logout') {
    signOut(userId);
    return response.writeHead(204).end();
  }
  response.writeHead(404).end();
});

new WebSocketServer({ server, path: '/notifications' }).on('connection', connected);
server.listen(Number(process.env.PORT ?? 8080));
```

- **Every tab sends `auth`** on the connection they share. They're all the same user, so later ones change nothing. One for a different user closes the connection.
- **A read is applied once.** Every tab that stored it sends it, and it's sent again after each reconnect until it's acknowledged. `handled` remembers the keys already applied.

## When things go wrong

| What happens | What the user sees | Why |
| --- | --- | --- |
| They open another tab | The same badge, at once | The cache. The tab joins the shared connection, and the server sends only what's new since the cache |
| They read a notice | The badge goes down, in every tab | `read()` updates this tab at once. The server's numbered `read` updates the others |
| They read while offline, then reload | The notice stays read, and "Syncing…" until the connection is back | The cache keeps the read state. The outbox keeps the read in IndexedDB and sends it on the next connection |
| The leading tab closes | Nothing | Another tab takes over the connection. Every tab's client reconnects through it and subscribes again from its position |
| The laptop sleeps for an hour | The notices that came meanwhile, in the list, without popups | Feeds ask for what came after the last one. Notices more than a minute old don't pop up |
| They sign out in one tab | "Sign in" in every tab | The server closes the shared connection with `4401`. Every tab forgets the cache, the inbox and unsent reads |

In Chrome, against the server on this page: two tabs opened one connection to the server. Three notices created on the server showed in both tabs. A notice read in the second tab went from a badge of 3 to 2 in the first. A reload of the second tab subscribed with `after: 4`, received nothing it already had, and showed its badge from the cache, on the same connection. Two notices read while the server was down survived a reload of that tab in IndexedDB, and went out once when the server came back. Signing out on the server showed "Sign in" in both tabs.

System notifications weren't tested in that run: the automated browser can't accept the permission prompt.

## Testing it

Pass `storage: memoryStorage()` to the outbox in tests, and drive the socket with a mock, as in [Testing](../guide/testing.md). `createTabsWebSocket` falls back to a socket per tab where `BroadcastChannel` or the Web Locks API is missing, as in some test environments, so the same tests work with and without it.

## See also

- [One connection across tabs](../guide/tabs.md)
- [Numbered feeds](../guide/topics.md#numbered-feeds) and [Offline outbox](../guide/outbox.md)
- [Authentication](../guide/authentication.md) and [Server rendering and Next.js](../guide/ssr.md)
- [`createTabsWebSocket`](../api/tabs.md), [`createWebSocketFeeds`](../api/create-websocket-feeds.md), [`createWebSocketOutbox`](../api/create-websocket-outbox.md), [`useWebSocketOutbox`](../api/use-websocket-outbox.md)
