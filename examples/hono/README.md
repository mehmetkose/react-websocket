# react-websocket Hono example

A chat room with a list of who's online: a [Hono](https://hono.dev/) WebSocket server on Node.js plus a Vite + React 19 client. Both sides import the same message types. The server answers every message, tells clients when to come back, and lets in a bot that runs in Node.

A walkthrough of this example is in the [Hono recipe](https://mehmetkose.github.io/react-websocket/recipes/hono).

```sh
# From the repository root: build the library, install it here, and start both servers.
npm run example:hono
```

Then open http://localhost:5173 in two tabs and send messages. Stop the server (or edit `server.ts`, which restarts it) to watch the client go to `reconnecting`. Messages you send meanwhile wait for the connection and are posted once it's back, and the `welcome` message brings back the history.

In another terminal, start the bot and say `@bot hello` in the room:

```sh
npm run bot
```

## What to try

- **Acknowledged messages.** Each message stays under the form until the server answers `posted`. A message over 500 characters is refused with a reason. With the server down for more than 30 seconds, a message says there was no answer, and Try again posts it once.
- **A full room.** `MAX_MEMBERS=2 npm run dev`, then open a third tab: the server closes it with `1013` and `30`, and the tab tries again in about 30 seconds.
- **Moving connections.** `MAX_AGE=15000 npm run dev`: each connection is asked to move after 15 seconds, and `migrate()` switches it to a new one while the status stays `open`.
- **An outdated page.** With the production build open, restart the server with a different `PROTOCOL` in `src/protocol.ts`. The page is closed with `4426`, stops reconnecting and asks you to reload.
- **The bot through a proxy.** `HTTPS_PROXY=http://localhost:3128 npm run bot` connects through an HTTP proxy.

| Variable | Where | |
| --- | --- | --- |
| `PORT` | server | Port to listen on. Default `8787` |
| `MAX_MEMBERS` | server | Connections allowed in the room. Default `50` |
| `MAX_AGE` | server | Age in ms after which a connection is asked to move. Default one hour |
| `BOT_TOKEN` | server, bot | The bot's bearer token. Defaults to `dev-bot-token` outside production. In production, the server lets no bot in without it |
| `SERVER` | bot | The server's address. Default `ws://localhost:8787` |
| `HTTPS_PROXY` | bot | An HTTP proxy to connect through |

## Files

```
server.ts          The Hono app: the chat room on /ws, and the built client in production
bot.ts             A bot that joins from Node.js with a token in a header (react-websocket/core, ws)
src/protocol.ts    The messages, shared by the server, the client and the bot
src/live.ts        The shared client, chat requests and the room state (createWebSocket,
                   createWebSocketRequests, createWebSocketState)
src/App.tsx        The page: status, server notices, who's online, messages and the composer
vite.config.ts     Forwards /ws to the Hono server in development
```

## How the server works

`@hono/node-server` handles WebSocket upgrades itself (since v2). Give `serve()` a `ws` server created with `noServer: true`, and `upgradeWebSocket` works on any route:

```ts
import { serve, upgradeWebSocket } from '@hono/node-server';
import { WebSocketServer } from 'ws';

app.get('/ws', upgradeWebSocket(() => ({ onMessage: (event, ws) => ws.send(event.data) })));
serve({ fetch: app.fetch, websocket: { server: new WebSocketServer({ noServer: true }) } });
```

The same `upgradeWebSocket` handler shape works on Bun, Deno and Cloudflare Workers: import it from `hono/bun`, `hono/deno` or `hono/cloudflare-workers` instead.

Middleware before `upgradeWebSocket` runs first, so you can turn a connection down before it opens. The client sees it as a failed connection and retries with backoff:

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

The function you pass to `upgradeWebSocket` runs for every request to the route, before Hono checks that it's a WebSocket upgrade. Plain GETs from crawlers, health checks or a browser tab run it too, and then get a 404. Do anything with side effects (counters, database writes, allocating resources) in `onOpen`, which only runs once a socket is open. That's why `server.ts` names each guest in `onOpen`.

Hono has no rooms or broadcast of its own, so `server.ts` keeps the open sockets in a `Map` and loops over them. It turns connections away in `onOpen`, after accepting them, rather than in middleware: a close code reaches the client, but a status on the upgrade response reaches a browser as a bare `1006`. The client sends a `heartbeat` every 10 seconds and the server answers it, so a connection that died without closing is noticed and replaced.

## Production

```sh
npm run build   # the client, into dist/
npm start       # Hono serves dist/ and /ws on http://localhost:8787
```

## Working on the library

The example installs the library from `../..` as a copy of the built package, the way an app would get it from npm. After changing the library, run this here and restart:

```sh
npm run update-library
```

`npm run typecheck` checks the server and the client together.
