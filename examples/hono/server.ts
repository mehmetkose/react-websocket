// The example's Hono server: a chat room on /ws, and in production the built client too.
// Nothing here is part of react-websocket; any WebSocket server would do.
import { timingSafeEqual } from 'node:crypto';
import { serve, upgradeWebSocket } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import type { WSContext } from 'hono/ws';
import { WebSocketServer } from 'ws';
import {
  HEARTBEAT,
  OUTDATED,
  PROTOCOL,
  type ChatMessage,
  type ClientMessage,
  type ServerMessage
} from './src/protocol.ts';

const port = Number(process.env.PORT ?? 8787);
// More connections than this, and newcomers are asked to come back later.
const maxMembers = Number(process.env.MAX_MEMBERS) || 50;
// Connections older than this, in ms, are asked to move to a new one.
const maxAge = Number(process.env.MAX_AGE) || 60 * 60_000;
// bot.ts sends this as a bearer token. Only development has a default.
const botToken =
  process.env.BOT_TOKEN ?? (process.env.NODE_ENV === 'production' ? undefined : 'dev-bot-token');

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

function parse(data: unknown): ClientMessage | undefined {
  if (typeof data !== 'string') return;
  try {
    const message = JSON.parse(data) as Partial<ClientMessage>;
    if (
      message.type === 'chat' &&
      Number.isInteger(message.id) &&
      typeof message.key === 'string' &&
      message.key.length <= 100 &&
      typeof message.text === 'string'
    )
      return message as ClientMessage;
  } catch {
    // Not JSON: ignore it.
  }
}

/** Whether an `Authorization` header carries the bot's token. */
function isBot(authorization: string | undefined) {
  if (!botToken || !authorization) return false;
  const given = Buffer.from(authorization);
  const expected = Buffer.from(`Bearer ${botToken}`);
  return given.length === expected.length && timingSafeEqual(given, expected);
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
