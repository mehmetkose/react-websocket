---
title: 'A Hono WebSocket server with a React client'
description: 'Pair a Hono WebSocket server with a Vite and React client using react-websocket: message types shared by both sides, upgradeWebSocket on Node.js, a dev proxy, room state that survives reconnects, messages the server acknowledges, a server that tells clients when to come back, a bot in Node, and one port in production.'
---

# Hono

This recipe builds a small chat room with a list of who's online. The server is [Hono](https://hono.dev/) on Node.js, the client is Vite and React, and both sides import the same message types. The server answers every message, tells clients when to come back, and lets in a bot that runs in Node. It follows the repository's [Hono example](https://github.com/mehmetkose/react-websocket/tree/main/examples/hono), so you can run everything on this page:

```sh
# From the repository root: build the library, install it in the example, and start both servers.
npm run example:hono
```

Then open http://localhost:5173 in two tabs and say hello.

## The short version

- Write your messages once, as TypeScript types in a file both sides import.
- On the server, `upgradeWebSocket` from `@hono/node-server` turns a route into a WebSocket endpoint.
- In development, Vite forwards `/ws` to the Hono server, so the page connects to its own address.
- On the client, keep the room in a [`createWebSocketState`](../guide/state.md) store, and let the server's `welcome` message refresh it after every reconnect.
- Send chat messages as [requests](../api/create-websocket-requests.md), so each one waits for the server's `posted` or `refused`, and a retry with the same key isn't posted twice.
- Let the server decide: a full room closes with `1013` and a delay, a long-lived connection is asked to `migrate()`, and an outdated page is closed with a code the client doesn't retry.
- In Node, a `ws` subclass sends headers, so a bot can join with a token.
- In production, Hono serves the built page and the socket on one port.

## Install

```sh
# The server
npm install hono @hono/node-server ws
# The client
npm install react react-dom react-websocket
npm install --save-dev vite @vitejs/plugin-react
```

## Share the message types

Put every message in one file. The server and the client both import it, so if you change a message, TypeScript checks both ends:

```ts
// src/protocol.ts
// The messages both sides speak. The server and the client import the same types, so a change
// here is checked on both ends.

/**
 * Bump this when a message changes shape. Clients send it when they connect, and the server
 * turns away pages built for another version, so tabs left open across a deploy reload.
 */
export const PROTOCOL = 1;

/** The close code for a client built for another `PROTOCOL`: reload, don't reconnect. */
export const OUTDATED = 4426;

export interface ChatMessage {
  id: string;
  from: string;
  text: string;
  at: number;
}

/** Every message the server sends. */
export type ServerMessage =
  // The first message on every connection, including reconnects: who you are and what you missed.
  | { type: 'welcome'; name: string; history: ChatMessage[] }
  | { type: 'chat'; message: ChatMessage }
  | { type: 'presence'; online: string[] }
  // The answer to a `chat` message, with its id: posted, or refused with a reason.
  | { type: 'posted'; id: number }
  | { type: 'refused'; id: number; reason: string }
  // Move to a new connection at a random moment in the next `within` ms.
  | { type: 'reconnect'; within: number };

/**
 * Every message the client sends. `id` is new on every attempt, so the answer finds its
 * request. `key` stays the same when the user retries, so the server posts it once.
 */
export type ClientMessage = { type: 'chat'; id: number; key: string; text: string };

/** The client's heartbeat ping and the server's reply, sent as plain text rather than JSON. */
export const HEARTBEAT = 'heartbeat';
```

## The server

`@hono/node-server` handles WebSocket connections itself, since version 2. Give `serve()` a `ws` server created with `noServer: true`, and `upgradeWebSocket` works on any route:

```ts
// server.ts (trimmed: the full file also checks incoming messages, recognizes the bot's token
// and serves the built page)
import { serve, upgradeWebSocket } from '@hono/node-server';
import { Hono } from 'hono';
import type { WSContext } from 'hono/ws';
import { WebSocketServer } from 'ws';
import {
  HEARTBEAT,
  OUTDATED,
  PROTOCOL,
  type ChatMessage,
  type ServerMessage
} from './src/protocol.ts';

const port = Number(process.env.PORT ?? 8787);
// More connections than this, and newcomers are asked to come back later.
const maxMembers = Number(process.env.MAX_MEMBERS) || 50;
// Connections older than this, in ms, are asked to move to a new one.
const maxAge = Number(process.env.MAX_AGE) || 60 * 60_000;

// Hono has no rooms or broadcast of its own: keep the open sockets and loop over them. Keyed by
// connection, because a client moving to a new connection holds two for a moment.
const members = new Map<number, { name: string; ws: WSContext }>();
const history: ChatMessage[] = [];
// The keys of messages already posted, so a client's retry isn't posted twice.
const posted = new Set<string>();
let connections = 0;
let guests = 0;

function send(ws: WSContext, message: ServerMessage) {
  ws.send(JSON.stringify(message));
}

function broadcast(message: ServerMessage) {
  for (const member of members.values()) send(member.ws, message);
}

function online() {
  return [...new Set(Array.from(members.values(), member => member.name))];
}

const app = new Hono();

app.get(
  '/ws',
  // Middleware before `upgradeWebSocket` can turn the upgrade down, e.g. without a session.
  // This factory runs once per request, so its variables belong to that connection.
  upgradeWebSocket(c => {
    const version = c.req.query('v');
    const bot = isBot(c.req.header('authorization'));
    let id = 0;
    let moveTimer: ReturnType<typeof setTimeout> | undefined;
    return {
      onOpen(_event, ws) {
        // A page from before a deploy that changed the messages. Reconnecting won't help it,
        // reloading will. A status on the upgrade response would reach the browser as a bare
        // 1006, so accept the connection and close it with a code.
        if (version !== String(PROTOCOL)) return ws.close(OUTDATED, 'Reload to update');
        // Come back in 30 seconds. The client waits that long, plus its usual backoff.
        if (members.size >= maxMembers) return ws.close(1013, '30');
        // Named on open: the factory also runs for plain GETs that never upgrade.
        id = ++connections;
        const name = bot ? 'bot' : `guest-${++guests}`;
        members.set(id, { name, ws });
        // Ask long-lived connections to move, so tabs left open spread over servers added since.
        // The client opens the new connection before it closes this one.
        moveTimer = setTimeout(() => send(ws, { type: 'reconnect', within: 10_000 }), maxAge);
        send(ws, { type: 'welcome', name, history });
        broadcast({ type: 'presence', online: online() });
      },
      onMessage(event, ws) {
        // Answer the client's heartbeat so it knows the connection is alive.
        if (event.data === HEARTBEAT) return ws.send(HEARTBEAT);
        const member = members.get(id);
        const message = parse(event.data);
        if (!member || !message) return;
        // Every chat message gets an answer with its id: refused, or posted.
        const text = message.text.trim();
        if (!text) return send(ws, { type: 'refused', id: message.id, reason: 'It is empty' });
        if (text.length > 500) {
          return send(ws, { type: 'refused', id: message.id, reason: 'Over 500 characters' });
        }
        // A retry of a message already posted gets its answer again, but isn't posted twice.
        if (!posted.has(message.key)) {
          posted.add(message.key);
          if (posted.size > 1000) posted.delete(posted.values().next().value!);
          const chat = { id: crypto.randomUUID(), from: member.name, text, at: Date.now() };
          history.push(chat);
          if (history.length > 50) history.shift();
          broadcast({ type: 'chat', message: chat });
        }
        send(ws, { type: 'posted', id: message.id });
      },
      onClose() {
        clearTimeout(moveTimer);
        // Turned away in onOpen: it never joined.
        if (!members.delete(id)) return;
        broadcast({ type: 'presence', online: online() });
      }
    };
  })
);

serve(
  {
    fetch: app.fetch,
    port,
    // Turns on `upgradeWebSocket`. The server must be created with `noServer: true`.
    websocket: { server: new WebSocketServer({ noServer: true }) }
  },
  info => console.log(`> Hono WebSocket server on ws://localhost:${info.port}/ws`)
);
```

A few things worth knowing:

- **Do side effects in `onOpen`.** The function you pass to `upgradeWebSocket` runs for every request to the route, before Hono checks that it's a WebSocket. A crawler, a health check or a browser tab runs it too, and then gets a 404. `onOpen` only runs once a socket is really open, so that's where each guest gets a name.
- **There's no broadcast built in.** Hono gives you one socket at a time. The server keeps the open ones in a `Map` and loops over it.
- **`welcome` goes out on every connection,** including reconnects. It tells the client who it is and what it missed, so the client never has to ask.
- **Every chat message gets an answer.** `posted` once it's in the room, or `refused` with a reason, each with the message's `id`. The client's promise settles on it. See [Publishing with an acknowledgement](../recipes.md#publishing-with-an-acknowledgement).
- **The server tells clients when to come back.** A full room closes with `1013` and the seconds to wait, a long-lived connection gets a `reconnect` notice, and a page built for another `PROTOCOL` is closed with `OUTDATED`, a code the client doesn't retry. See [Letting the server decide](../guide/reconnecting.md#letting-the-server-decide).
- **The heartbeat reply.** The client sends `heartbeat` every 10 seconds, and the server sends it straight back. A connection that died without closing is noticed and replaced.

### Turning connections down

Middleware before `upgradeWebSocket` runs first, so it can say no before the socket opens. The client sees a failed connection and tries again with backoff:

```ts
app.get(
  '/ws',
  async (c, next) => {
    if (!(await isSignedIn(c))) return c.text('Unauthorized', 401);
    await next();
  },
  upgradeWebSocket(c => ({ /* ... */ }))
);
```

To stop the client from retrying when its credentials are wrong, see [Authentication](../guide/authentication.md#stop-retrying-when-credentials-are-rejected).

### Other runtimes

The same `upgradeWebSocket` handler shape works on Bun, Deno and Cloudflare Workers. Import it from `hono/bun`, `hono/deno` or `hono/cloudflare-workers` instead.

## Forward `/ws` in development

Vite serves the page on port 5173, and Hono listens on 8787. A proxy forwards `/ws` from one to the other, so the page connects to its own address in development and in production alike:

```ts
// vite.config.ts
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  server: {
    // The page connects to /ws on its own origin; forward it to the Hono server (server.ts).
    proxy: { '/ws': { target: 'http://localhost:8787', ws: true } }
  }
});
```

`ws: true` is the important part: it tells Vite to forward WebSocket connections, not only normal requests.

## The client

One module holds the connection and the room:

```ts
// src/live.ts
import {
  createWebSocket,
  createWebSocketRequests,
  createWebSocketState,
  retryableClose
} from 'react-websocket';
import {
  HEARTBEAT,
  OUTDATED,
  PROTOCOL,
  type ChatMessage,
  type ClientMessage,
  type ServerMessage
} from './protocol';

// The page's own origin: in development Vite forwards /ws to the Hono server, and in
// production Hono serves the page and the socket on one port.
function url() {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  // `v` tells the server which messages this page was built for.
  return `${protocol}//${location.host}/ws?v=${PROTOCOL}`;
}

/** The one connection the page shares. */
export const live = createWebSocket<ServerMessage, ClientMessage>(url, {
  json: true,
  // Five quiet seconds after a ping count as a dead connection, and the client reconnects.
  heartbeat: { interval: 10_000, timeout: 5000, message: HEARTBEAT, pong: HEARTBEAT },
  queue: { limit: 20 },
  // An outdated page stops instead of reconnecting, and asks the user to reload.
  reconnect: { shouldReconnect: close => close.code !== OUTDATED && retryableClose(close) },
  logger: console.debug
});

// The server asks long-lived connections to move. `migrate()` opens the new connection before
// it closes this one, so the status stays `open` and no message is missed.
live.on('message', message => {
  if (message.type === 'reconnect') live.migrate({ within: message.within });
});

/** The server got the message and said no. Sending it again gets the same answer. */
export class Refused extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'Refused';
  }
}

/** Chat messages, each answered by the server: `chat.request()` resolves once it's posted. */
export const chat = createWebSocketRequests(live, {
  send: (message: { key: string; text: string }, id) => ({ type: 'chat', id, ...message }),
  reply: message =>
    message.type === 'posted' || message.type === 'refused' ? message.id : undefined,
  error: message => (message.type === 'refused' ? new Refused(message.reason) : undefined),
  // Counts from the call, so it also covers a message that waits in the queue for a reconnect.
  timeout: 30_000
});

export interface Room {
  me: string;
  online: string[];
  messages: ChatMessage[];
}

/** The room as the server last described it. Kept across reconnects, refreshed by `welcome`. */
export const room = createWebSocketState(live, {
  initialState: { me: '', online: [], messages: [] } as Room,
  reduce: (state, message): Room => {
    switch (message.type) {
      // Sent on every connection, so the history replaces what we had rather than repeating it.
      case 'welcome':
        return { ...state, me: message.name, messages: message.history };
      case 'chat':
        return { ...state, messages: [...state.messages, message.message].slice(-50) };
      case 'presence':
        return { ...state, online: message.online };
      // Answers to `chat` and the server's notices are for other parts of the page.
      default:
        return state;
    }
  }
});
```

- **`heartbeat`** uses the same `HEARTBEAT` string as the server. Setting `pong` means the reply is swallowed instead of reaching your components as a message.
- **`shouldReconnect`** keeps the default rule (`retryableClose`) and adds one: an `OUTDATED` close is final. The status becomes `closed`, and the page asks the user to reload.
- **`migrate()`** answers the server's `reconnect` notice. The new connection opens first, then the old one closes, so the status stays `open` throughout. You see it as a new guest name.
- **`chat`** is a [request manager](../api/create-websocket-requests.md): `chat.request({ key, text })` sends a `chat` message with a fresh `id` and resolves when the server answers `posted`. A `refused` answer rejects with `Refused`. A timeout or a lost connection rejects with anything else.
- **`room`** keeps the latest state from the messages. It stays on screen while the client reconnects, and `welcome` replaces the history afterwards, so nothing shows up twice. The answers and notices meant for other parts of the page pass through it unchanged.

Components read only the part of the room they need, so the online list doesn't re-render for every chat message:

```tsx
// src/App.tsx (trimmed)
function Online() {
  // Re-renders only when the list changes, not on every chat message.
  const online = useWebSocketState(room, state => state.online);
  return (
    <p className="muted">
      {online.length} online: {online.join(', ')}
    </p>
  );
}
```

Messages go through `chat`, so each one waits for the server's answer. A message stays in a list under the form until then. It disappears once it's posted, since the room shows it, and otherwise it says what happened:

```tsx
// src/App.tsx (trimmed)
interface Pending {
  key: string;
  text: string;
  state: 'sending' | 'refused' | 'unconfirmed';
  reason?: string;
}

function Composer() {
  const [text, setText] = useState('');
  // Messages the server hasn't posted. A posted message leaves the list: the room shows it.
  const [pending, setPending] = useState<Pending[]>([]);
  const offline = useWebSocketStatus(live) !== 'open';

  function update(key: string, change?: Partial<Pending>) {
    setPending(list =>
      change
        ? list.map(item => (item.key === key ? { ...item, ...change } : item))
        : list.filter(item => item.key !== key)
    );
  }

  // A retry passes the same key, so the server posts the message once.
  async function post(text: string, key: string) {
    update(key, { state: 'sending' });
    try {
      await chat.request({ key, text });
      update(key);
    } catch (error) {
      // A refusal is the server's answer. Anything else (a timeout, a lost connection) means
      // it may or may not have the message.
      update(
        key,
        error instanceof Refused
          ? { state: 'refused', reason: error.message }
          : { state: 'unconfirmed' }
      );
    }
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!text.trim()) return;
    const key = crypto.randomUUID();
    setPending(list => [...list, { key, text, state: 'sending' }]);
    // Sent now if open; otherwise queued and sent in order on reconnect.
    post(text, key);
    setText('');
  }

  return (
    <>
      <form className="row" onSubmit={submit}>
        <input value={text} onChange={e => setText(e.target.value)} placeholder="Say something" />
        <button>Send</button>
      </form>
      {pending.length > 0 && (
        <ul className="pending">
          {pending.map(item => (
            <li key={item.key} className="row">
              <span className="text">{item.text}</span>
              {item.state === 'sending' && (
                <span className="muted">
                  {offline ? 'waiting for the connection…' : 'sending…'}
                </span>
              )}
              {item.state === 'refused' && (
                <>
                  <span role="alert">Not posted: {item.reason}</span>
                  <button onClick={() => update(item.key)}>Dismiss</button>
                </>
              )}
              {item.state === 'unconfirmed' && (
                <>
                  <span role="alert">No answer from the server.</span>
                  <button onClick={() => post(item.text, item.key)}>Try again</button>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
```

- **Sending while offline** works as before: the message waits in the send queue and goes out when the connection is back. It says "waiting for the connection…" meanwhile.
- **Refused** is the server's answer, so the reason is shown and there's nothing to retry.
- **No answer** means the server may or may not have the message: the request timed out, or the connection dropped after it went out. Try again sends it with the same `key`, and the server posts each key once. A message that times out while it waits in the send queue still goes out when the connection is back, and the server posts it. Try again then gets `posted` straight away.

When the server closes the connection with advice, a `close` listener shows it. Listeners run after the status has changed, so an `OUTDATED` close finds it `closed`:

```tsx
// src/App.tsx (trimmed)
/** What the server asked for when it closed the connection, if anything. */
function ServerNotice() {
  const status = useWebSocketStatus(live);
  const [last, setLast] = useState<CloseInfo>();
  // `close` listeners run after the status has changed.
  useWebSocketEvent(live, 'close', setLast);
  if (status === 'closed' && last?.code === OUTDATED) {
    return (
      <p role="alert" className="row">
        A new version is available. <button onClick={() => location.reload()}>Reload</button>
      </p>
    );
  }
  if (status === 'reconnecting' && last?.code === 1013) {
    return (
      <p role="status" className="muted">
        The room is full. Trying again in about {last.reason} seconds.
      </p>
    );
  }
  return null;
}
```

To show a placeholder until the server first answers, suspend on `live.ready`:

```tsx
// src/App.tsx (trimmed)
function Connected({ children }: { children: ReactNode }) {
  use(live.ready); // suspends until the first connection opens, and not again on reconnects
  return children;
}

export default function App() {
  return (
    <>
      <Status />
      <ServerNotice />
      <Suspense fallback={<p className="muted">Waiting for the server…</p>}>
        <Connected>
          <Online />
          <Messages />
        </Connected>
      </Suspense>
      <Composer />
    </>
  );
}
```

The full [`App.tsx`](https://github.com/mehmetkose/react-websocket/blob/main/examples/hono/src/App.tsx) also has the status line and the message list.

## A bot in Node

A browser can't set headers on a WebSocket, but Node can. `bot.ts` joins the room with a bearer token in the `Authorization` header, which the server checks to name it `bot`, and answers messages that start with `@bot`. It uses `react-websocket/core`, which has no React, with a [`ws`](https://github.com/websockets/ws) subclass that adds the header, an optional proxy and a timer for attempts that hang:

```ts
// bot.ts
// A bot that joins the room from Node.js and answers messages that start with "@bot".
// A browser can't set headers on a WebSocket, but Node can: the bot sends a bearer token, and
// the server gives it its name.
//
//   npm run bot                                  # joins the room on localhost:8787
//   HTTPS_PROXY=http://proxy:3128 npm run bot    # through an HTTP proxy
import { HttpsProxyAgent } from 'https-proxy-agent';
import { createWebSocket, createWebSocketRequests, retryableClose } from 'react-websocket/core';
import WebSocket from 'ws';
import {
  HEARTBEAT,
  OUTDATED,
  PROTOCOL,
  type ClientMessage,
  type ServerMessage
} from './src/protocol.ts';

const server = process.env.SERVER ?? 'ws://localhost:8787';
const token = process.env.BOT_TOKEN ?? 'dev-bot-token';
// Made once and shared by every connection.
const proxy = process.env.HTTPS_PROXY;
const agent = proxy ? new HttpsProxyAgent(proxy) : undefined;

// The client constructs a socket for every attempt, reconnects and `migrate()` included, and
// passes only the URL and protocols. The subclass adds the rest. For a server whose certificate
// comes from a private authority, add `ca` here too.
class BotSocket extends WebSocket {
  constructor(url: string | URL, protocols?: string | string[]) {
    super(url, protocols, { headers: { Authorization: `Bearer ${token}` }, agent });
    // End an attempt that hangs, at the proxy or at the server. Neither the client nor `ws`
    // would, and `ws`'s `handshakeTimeout` doesn't start until a proxy has answered.
    const timer = setTimeout(() => this.terminate(), 10_000);
    this.once('open', () => clearTimeout(timer)).once('close', () => clearTimeout(timer));
  }
}

const live = createWebSocket<ServerMessage, ClientMessage>(`${server}/ws?v=${PROTOCOL}`, {
  json: true,
  WebSocket: BotSocket as unknown as typeof globalThis.WebSocket,
  heartbeat: { interval: 10_000, timeout: 5000, message: HEARTBEAT, pong: HEARTBEAT },
  reconnect: { shouldReconnect: close => close.code !== OUTDATED && retryableClose(close) },
  logger: console.log
});

const chat = createWebSocketRequests(live, {
  send: (message: { key: string; text: string }, id) => ({ type: 'chat', id, ...message }),
  reply: message =>
    message.type === 'posted' || message.type === 'refused' ? message.id : undefined,
  error: message => (message.type === 'refused' ? new Error(message.reason) : undefined)
});

let me = '';

live.on('message', message => {
  if (message.type === 'welcome') me = message.name;
  if (message.type === 'reconnect') live.migrate({ within: message.within });
  if (message.type !== 'chat') return;
  const { id, from, text } = message.message;
  if (from === me || !/^@bot\b/i.test(text)) return;
  // Keyed by the message it answers: with two bots running, the room gets one answer.
  chat
    .request({
      key: `answer:${id}`,
      text: `Hi ${from}! It's ${new Date().toLocaleTimeString()} here.`
    })
    .then(
      () => console.log(`answered ${from}`),
      error => console.error(`not answered: ${error}`)
    );
});

live.on('close', close => {
  if (close.code !== OUTDATED) return;
  console.error('The server speaks a newer protocol. Update the bot.');
  process.exit(1);
});

live.connect();

process.on('SIGINT', () => {
  live.close();
  process.exit(0);
});
```

- **The subclass** is constructed for every attempt, reconnects and `migrate()` included, so every connection carries the header and goes through the proxy. See [Headers, proxies and TLS](../guide/without-react.md#headers-proxies-and-tls).
- **The answer's key** is the id of the message it answers. With two bots running, both answer, and the server posts one.
- **An `OUTDATED` close** stops the bot: it speaks an older protocol than the server, and only updating it helps.

Run it next to the example with `npm run bot`, and say `@bot hello` in the room.

## Going to production

In production there's no Vite server, so Hono serves the built page too:

```ts
// server.ts (trimmed)
import { serveStatic } from '@hono/node-server/serve-static';

// In development Vite serves the page and forwards /ws here (see vite.config.ts).
if (process.env.NODE_ENV === 'production') app.use('/*', serveStatic({ root: './dist' }));
```

```sh
npm run build   # the client, into dist/
npm start       # Hono serves dist/ and /ws on http://localhost:8787
```

The client's `url()` uses the page's own address, so it needs no changes. In production, the server lets a bot in only if `BOT_TOKEN` is set, and the bot needs the same value.

## Try it

With the example running:

1. **Open two tabs.** Each one gets a guest name, and both show up in the online list.
2. **Start the bot** with `npm run bot` and say `@bot hello`. It joins as `bot` and answers.
3. **Send a message over 500 characters.** The server refuses it, and the reason shows under the form.
4. **Stop the server**, or edit `server.ts`, which restarts it. The client goes to `reconnecting`.
5. **Send a few messages while it's down.** They wait for the connection, and are posted once the server is back. Keep it down for more than 30 seconds, and they say there was no answer: Try again posts each one once.
6. **Watch the history.** After the reconnect, `welcome` brings it back without repeating anything.
7. **Fill the room.** Start the server with `MAX_MEMBERS=2` and open a third tab. It says the room is full and tries again in about 30 seconds.
8. **Watch a connection move.** Start the server with `MAX_AGE=15000`. Every 15 to 25 seconds, each tab gets a new guest name while its status stays `open`.
9. **Deploy a new protocol.** With the production build open (`npm run build && npm start`), stop the server, change `PROTOCOL` in `src/protocol.ts` to `2`, and start it again. The tab says a new version is available. Run `npm run build` and press Reload.

## See also

- [Message state](../guide/state.md): stores like `room`, with selectors
- [Reconnecting and heartbeats](../guide/reconnecting.md): backoff, heartbeats and the send queue
- [Letting the server decide](../guide/reconnecting.md#letting-the-server-decide): close codes and notices that tell clients when to come back
- [Publishing with an acknowledgement](../recipes.md#publishing-with-an-acknowledgement): the pattern behind `chat`
- [Headers, proxies and TLS](../guide/without-react.md#headers-proxies-and-tls): the subclass the bot uses
- [Messages and types](../guide/messages.md): JSON, schemas and one socket with many message types
- [Build a team chat app](./team-chat.md): channels, unread counts and an outbox that survives reloads
