// The example's Hono server: a chat room on /ws, and in production the built client too.
// Nothing here is part of react-websocket; any WebSocket server would do.
import { serve, upgradeWebSocket } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import type { WSContext } from 'hono/ws';
import { WebSocketServer } from 'ws';
import {
  HEARTBEAT,
  type ChatMessage,
  type ClientMessage,
  type ServerMessage
} from './src/protocol.ts';

const port = Number(process.env.PORT ?? 8787);

// Hono has no rooms or broadcast of its own: keep the open sockets and loop over them.
const members = new Map<string, WSContext>();
const history: ChatMessage[] = [];
let guests = 0;

function send(ws: WSContext, message: ServerMessage) {
  ws.send(JSON.stringify(message));
}

function broadcast(message: ServerMessage) {
  for (const ws of members.values()) send(ws, message);
}

function parse(data: unknown): ClientMessage | undefined {
  if (typeof data !== 'string') return;
  try {
    const message = JSON.parse(data) as Partial<ClientMessage>;
    if (message.type === 'chat' && typeof message.text === 'string')
      return message as ClientMessage;
  } catch {
    // Not JSON: ignore it.
  }
}

const app = new Hono();

app.get(
  '/ws',
  // Middleware before `upgradeWebSocket` can turn the upgrade down, e.g. without a session.
  // This factory runs once per request, so its variables belong to that connection.
  upgradeWebSocket(() => {
    let name = '';
    return {
      onOpen(_event, ws) {
        // Named on open: the factory also runs for plain GETs that never upgrade.
        name = `guest-${++guests}`;
        members.set(name, ws);
        send(ws, { type: 'welcome', name, history });
        broadcast({ type: 'presence', online: [...members.keys()] });
      },
      onMessage(event, ws) {
        // Answer the client's heartbeat so it knows the connection is alive.
        if (event.data === HEARTBEAT) return ws.send(HEARTBEAT);
        const message = parse(event.data);
        const text = message?.text.trim().slice(0, 500);
        if (!text) return;
        const chat = { id: crypto.randomUUID(), from: name, text, at: Date.now() };
        history.push(chat);
        if (history.length > 50) history.shift();
        broadcast({ type: 'chat', message: chat });
      },
      onClose() {
        members.delete(name);
        broadcast({ type: 'presence', online: [...members.keys()] });
      }
    };
  })
);

// In development Vite serves the page and forwards /ws here (see vite.config.ts).
if (process.env.NODE_ENV === 'production') app.use('/*', serveStatic({ root: './dist' }));

serve(
  {
    fetch: app.fetch,
    port,
    // Turns on `upgradeWebSocket`. The server must be created with `noServer: true`.
    websocket: { server: new WebSocketServer({ noServer: true }) }
  },
  info => console.log(`> Hono WebSocket server on ws://localhost:${info.port}/ws`)
);
