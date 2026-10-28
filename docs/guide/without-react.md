---
title: 'WebSocket client without React'
description: 'react-websocket/core: the same reconnecting, queueing, typed WebSocket client for plain JavaScript, Node or a state library, with no React dependency.'
---

# Without React

This page covers `react-websocket/core`: the same reconnecting, queueing, typed client, usable from plain JavaScript, Node, or a state library.

## The core entry

```ts
import { createWebSocket, MessageError } from 'react-websocket/core';
```

`react-websocket/core` exports `createWebSocket`, `MessageError` and all the types. It doesn't import React and isn't marked `'use client'`, so it's safe in workers, Node scripts and server code. The main `react-websocket` entry re-exports everything from it, plus the hooks.

## The client API

```ts
import { createWebSocket } from 'react-websocket/core';

type In = { type: 'price'; symbol: string; price: number };
type Out = { type: 'subscribe'; symbol: string };

const prices = createWebSocket<In, Out>('wss://api.example.com/prices', { json: true });

// Events: open, message, close, error. Each `on` returns an unsubscribe function.
const off = prices.on('message', message => {
  console.log(message.symbol, message.price);
});
prices.on('close', ({ code, reason }) => console.log('closed', code, reason));
prices.on('error', error => console.error(error));

// Start, and stay connected until close().
prices.connect();

// Sent now if open, otherwise queued and sent on open.
prices.send({ type: 'subscribe', symbol: 'ACME' });

// Wait for the connection.
await prices.ready;

// Later:
off();
prices.close();
```

| Member | |
| --- | --- |
| `connect()` | Start connecting and keep the connection open, even with no hooks using it, until `close()` |
| `close(code?, reason?)` | Close, stop reconnecting and clear the queue. Status becomes `closed` |
| `reconnect()` | Drop the socket and connect again now. Also restarts a `closed` client |
| `migrate({ url?, within? })` | Move to a new connection without a gap; see [Deploys](./reconnecting.md#deploys-without-reconnect-storms) |
| `send(message)` | Send now (returns `true`) or queue until open (returns `false`) |
| `on(type, listener)` | Listen to `open`, `message`, `close` or `error`. Returns an unsubscribe function |
| `subscribe(listener)` / `getSnapshot()` | A store of `{ status, lastMessage, attempt }`, compatible with `useSyncExternalStore` |
| `ready` | Resolves once connected; see [Suspense](./suspense.md) for its exact behaviour |
| `acquire()` | Hold the connection open; returns a release function |
| `socket` | The current underlying `WebSocket`, or `null` |

Full details are in the [`WebSocketClient` reference](../api/types.md#websocketclient).

### Watching state

`subscribe` notifies on every state change; read the new state with `getSnapshot()`:

```ts
const unsubscribe = prices.subscribe(() => {
  const { status, attempt } = prices.getSnapshot();
  statusElement.textContent = attempt ? `${status} (attempt ${attempt})` : status;
});
```

### Holding vs. connecting

There are two ways to keep a client connected:

- **`connect()`** pins the connection until `close()`. Use it for app-wide connections you open once.
- **`acquire()`** is reference-counted, which is what the hooks use. The connection opens on the first `acquire()` and closes one tick after the last release function is called. Use it when several independent parts of your code use the same client:

```ts
const release = prices.acquire();
// … later, when this part of the app no longer needs it:
release();
```

## Vanilla JavaScript

```html
<p id="status">idle</p>
<ul id="log"></ul>

<script type="module">
  import { createWebSocket } from 'https://esm.sh/react-websocket/core';

  const chat = createWebSocket('wss://api.example.com/chat', { json: true });
  const status = document.getElementById('status');
  const log = document.getElementById('log');

  chat.subscribe(() => (status.textContent = chat.getSnapshot().status));
  chat.on('message', message => {
    const item = document.createElement('li');
    item.textContent = `${message.user}: ${message.text}`;
    log.append(item);
  });
  chat.connect();
</script>
```

For components in other frameworks, the [Remix 3 recipe](../recipes/remix.md#bindings-hooks-for-remix-components) has small bindings that stand in for each hook, and the [Astro recipe](../recipes/astro.md#use-it-without-react) holds the connection from a custom element.

## Node

Outside a browser (no `window`), the client never reaches for a global `WebSocket` on its own, so that server renders don't open sockets. In Node, pass an implementation explicitly, either Node's built-in `WebSocket` (Node 22+) or the [`ws`](https://github.com/websockets/ws) package:

```ts
import WebSocket from 'ws';
import { createWebSocket } from 'react-websocket/core';

const feed = createWebSocket<{ event: string }>('wss://api.example.com/feed', {
  json: true,
  WebSocket: WebSocket as unknown as typeof globalThis.WebSocket,
  // `ws` delivers binary frames as Buffers by default; ask for browser-style ArrayBuffers.
  binaryType: 'arraybuffer',
  logger: console.debug
});

feed.on('message', ({ event }) => console.log(event));
feed.connect();

process.on('SIGINT', () => {
  feed.close();
  process.exit(0);
});
```

```ts
// Node 22+ built-in WebSocket
createWebSocket(url, { WebSocket: globalThis.WebSocket });
```

The immediate retry on `online` and `visibilitychange` only exists in browsers; in Node, reconnects follow the backoff alone.

### Headers, proxies and TLS

A browser [can't set headers](./authentication.md#browsers-cant-set-headers) on a WebSocket, but a Node client can, and it may also need a proxy or a private certificate authority. `ws` takes all of these as options, in a third constructor argument. The client only passes the URL and [`protocols`](../api/options.md#protocols), so put the options in a subclass:

```ts
// feed.ts
import { readFileSync } from 'node:fs';
import { HttpsProxyAgent } from 'https-proxy-agent';
import WebSocket from 'ws';
import { createWebSocket } from 'react-websocket/core';
import { getFreshToken } from './auth';

// Made once and shared by every connection.
const proxy = process.env.HTTPS_PROXY;
const agent = proxy ? new HttpsProxyAgent(proxy) : undefined;
const ca = readFileSync('certs/internal-ca.pem');
let token: string;

class NodeWebSocket extends WebSocket {
  constructor(url: string | URL, protocols?: string | string[]) {
    super(url, protocols, { headers: { Authorization: `Bearer ${token}` }, agent, ca });
    // End an attempt that hangs, at the proxy or at the server.
    const timer = setTimeout(() => this.terminate(), 10_000);
    this.once('open', () => clearTimeout(timer)).once('close', () => clearTimeout(timer));
  }
}

export const feed = createWebSocket<{ event: string }>(
  async () => {
    token = await getFreshToken();
    return 'wss://api.example.com/feed';
  },
  {
    json: true,
    WebSocket: NodeWebSocket as unknown as typeof globalThis.WebSocket,
    binaryType: 'arraybuffer'
  }
);
```

The client constructs a socket for every connection attempt, reconnects and [`migrate()`](./reconnecting.md#deploys-without-reconnect-storms) included. A constructor can't wait for a token, so the [URL function](./authentication.md#token-in-the-url) fetches it: it runs right before each attempt and may be async. Each connection then sends a fresh token.

The `ws` options that matter here:

| Option | |
| --- | --- |
| `headers` | Sent with the upgrade request: `Authorization`, `Cookie`, or anything else your server reads |
| `agent` | Connects through a proxy: [`https-proxy-agent`](https://www.npmjs.com/package/https-proxy-agent) for an HTTP proxy, [`socks-proxy-agent`](https://www.npmjs.com/package/socks-proxy-agent) for SOCKS |
| `ca` | Trusts a private certificate authority. Add `cert` and `key` for mutual TLS |
| `perMessageDeflate` | Compression. `ws` offers it by default and the server decides. Pass `false` for data that's already compressed, or an object to tune it |

The rest are in the [`ws` documentation](https://github.com/websockets/ws/blob/master/doc/ws.md#new-websocketaddress-protocols-options).

The timer matters in Node. A server that accepts the connection but never answers, or a proxy that never answers, would hold an attempt open forever: neither the client nor `ws` ends it on its own. `ws` has a `handshakeTimeout` option, but it doesn't start until the proxy has answered. `terminate()` ends the attempt with a `1006` close, and the client retries it with the usual backoff.

:::warning Don't turn off certificate checks
`rejectUnauthorized: false` gets past a certificate error by accepting any certificate, an attacker's included. Pass the certificate authority as `ca` instead.
:::

## State libraries

Connect a client to a store by forwarding events. Because the client is created at module level, nothing depends on React rendering.

### Zustand

Let the client own the connection and Zustand own your data. You don't need to copy `status` into the store: `useWebSocketStatus(client)` already reads it.

```ts
// chat.ts
import { create } from 'zustand';
import { createWebSocket } from 'react-websocket';

type In = { type: 'message'; id: string; text: string } | { type: 'ack'; id: string };
type Out = { type: 'send'; id: string; text: string };
type Message = { id: string; text: string; pending: boolean };

export const chat = createWebSocket<In, Out>('wss://api.example.com/chat', { json: true });

type ChatState = {
  messages: Message[];
  send(text: string): void;
  receive(message: In): void;
};

export const useChat = create<ChatState>()(set => ({
  messages: [],
  send(text) {
    const id = crypto.randomUUID();
    set(state => ({ messages: [...state.messages, { id, text, pending: true }] })); // optimistic
    chat.send({ type: 'send', id, text }); // queued while offline
  },
  receive(message) {
    if (message.type === 'ack') {
      set(state => ({
        messages: state.messages.map(m => (m.id === message.id ? { ...m, pending: false } : m))
      }));
    } else {
      set(state => ({ messages: [...state.messages, { ...message, pending: false }] }));
    }
  }
}));
```

Forward messages from one component mounted high in the tree. The socket is then open only while that part of the UI exists:

```tsx
import { useWebSocketEvent } from 'react-websocket';
import { chat, useChat } from './chat';

export function ChatConnection() {
  useWebSocketEvent(chat, 'message', message => useChat.getState().receive(message));
  return null;
}
```

Components read data with `useChat(state => state.messages)` and status with `useWebSocketStatus(chat)`, and send through store actions.

To keep the connection open for the whole session instead, forward with `chat.on('message', …)` at module level and call `chat.connect()`.

:::tip Do you need Zustand for this?
If the store only accumulates socket data, [`createWebSocketState`](./state.md) does the same with a reducer and per-component selectors, with no extra dependency. Reach for Zustand when many app actions also change the same data.
:::

### Redux Toolkit

```ts
import { configureStore, createSlice, type PayloadAction } from '@reduxjs/toolkit';
import { createWebSocket, type Status } from 'react-websocket/core';

type Order = { id: string; state: 'open' | 'filled' };

const orders = createSlice({
  name: 'orders',
  initialState: { status: 'idle' as Status, byId: {} as Record<string, Order> },
  reducers: {
    statusChanged: (state, action: PayloadAction<Status>) => {
      state.status = action.payload;
    },
    orderUpdated: (state, action: PayloadAction<Order>) => {
      state.byId[action.payload.id] = action.payload;
    }
  }
});

export const store = configureStore({ reducer: { orders: orders.reducer } });

const socket = createWebSocket<Order>('wss://api.example.com/orders', { json: true });
socket.subscribe(() => {
  const { status } = socket.getSnapshot();
  if (status !== store.getState().orders.status) store.dispatch(orders.actions.statusChanged(status));
});
socket.on('message', order => store.dispatch(orders.actions.orderUpdated(order)));
socket.connect();
```

To open the connection only while some component needs it, call `socket.acquire()` from that component's effect (or use a hook such as [`useWebSocketStatus`](../api/use-websocket-status.md), which holds the connection while mounted) instead of `connect()`.
