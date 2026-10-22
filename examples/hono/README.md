# react-websocket Hono example

A chat room with a list of who's online: a [Hono](https://hono.dev/) WebSocket server on Node.js plus a Vite + React 19 client. Both sides import the same message types.

A walkthrough of this example is in the [Hono recipe](https://mehmetkose.github.io/react-websocket/recipes/hono).

```sh
# From the repository root: build the library, install it here, and start both servers.
npm run example:hono
```

Then open http://localhost:5173 in two tabs and send messages. Stop the server (or edit `server.ts`, which restarts it) to watch the client go to `reconnecting`. Messages you send meanwhile are queued and delivered once it's back, and the `welcome` message brings back the history.

## Files

```
server.ts          The Hono app: the chat room on /ws, and the built client in production
src/protocol.ts    The messages, shared by the server and the client
src/live.ts        The shared client and the room state (createWebSocket, createWebSocketState)
src/App.tsx        The page: status, who's online, messages and the composer
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

Hono has no rooms or broadcast of its own, so `server.ts` keeps the open sockets in a `Map` and loops over them. The client sends a `heartbeat` every 10 seconds and the server answers it, so a connection that died without closing is noticed and replaced.

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
