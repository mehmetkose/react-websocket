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
