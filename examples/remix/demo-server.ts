// The demo's WebSocket backend. It speaks the protocol in app/live/public/protocol.ts and plays
// every part the page needs: a chat room, a price feed, an RPC endpoint, a clock, and an "agent"
// that sends requests to the browser. Nothing here is part of react-websocket; any server would do.
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type RawData, type WebSocket } from 'ws';
import {
  SYMBOLS,
  type ClientMessage,
  type RpcMethod,
  type ServerMessage
} from './app/live/public/protocol.ts';
import { verifyToken } from './app/live/token.ts';

// The demo server's clock runs ahead on purpose, so the latency card has an offset to measure.
const CLOCK_SKEW = 2500;
const COLORS = ['#e5484d', '#30a46c', '#0090ff', '#f76b15', '#8e4ec6', '#12a594'];

interface Peer {
  socket: WebSocket;
  name: string;
  topics: Set<string>;
  /** Set by the "Go silent" button: ignore this client, heartbeats included. */
  silent: boolean;
  cursor: { x: number; y: number; color: string };
  /** Requests sent to this client, waiting for its `result`. */
  calls: Map<string, (reply: { result?: unknown; error?: string }) => void>;
  run: AbortController | null;
}

const peers = new Set<Peer>();
const wss = new WebSocketServer({ noServer: true });
let names = 0;
let calls = 0;

/**
 * Accept a WebSocket upgrade on `/ws` if its token is valid. Returns `false` for other paths,
 * without touching the socket, so another handler can take them.
 */
export function handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): boolean {
  const url = new URL(request.url ?? '/', 'http://localhost');
  if (url.pathname !== '/ws') return false;
  if (!verifyToken(url.searchParams.get('token'))) {
    socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
    return true;
  }
  wss.handleUpgrade(request, socket, head, connected);
  return true;
}

function connected(socket: WebSocket) {
  const peer: Peer = {
    socket,
    name: `guest-${++names}`,
    topics: new Set(),
    silent: false,
    cursor: { x: 0.5, y: 0.5, color: COLORS[names % COLORS.length]! },
    calls: new Map(),
    run: null
  };
  peers.add(peer);
  send(peer, { type: 'welcome', name: peer.name });
  for (const other of peers)
    if (other !== peer) send(peer, { type: 'peer', id: other.name, ...other.cursor });
  broadcastPeer(peer);

  socket.on('message', (data, isBinary) => {
    if (!peer.silent) receive(peer, data, isBinary);
  });
  socket.on('close', () => {
    peers.delete(peer);
    peer.run?.abort(new Error('The connection closed'));
    for (const other of peers) send(other, { type: 'leave', id: peer.name });
  });
}

function send(peer: Peer, message: ServerMessage) {
  if (!peer.silent && peer.socket.readyState === peer.socket.OPEN)
    peer.socket.send(JSON.stringify(message));
}

function receive(peer: Peer, data: RawData, isBinary: boolean) {
  // Text frames arrive as a Buffer; this protocol has no binary messages.
  if (isBinary || !Buffer.isBuffer(data)) return;
  const text = data.toString();
  // The client's heartbeat (sent as-is, not JSON): answer it so the client knows we're alive.
  if (text === 'heartbeat') {
    peer.socket.send('heartbeat');
    return;
  }
  let message: ClientMessage;
  try {
    message = JSON.parse(text) as ClientMessage;
  } catch {
    return;
  }

  switch (message.type) {
    case 'chat':
      for (const other of peers) {
        send(other, {
          type: 'chat',
          id: crypto.randomUUID(),
          from: peer.name,
          text: message.text,
          at: Date.now()
        });
      }
      break;
    case 'subscribe':
      peer.topics.add(message.topic);
      break;
    case 'unsubscribe':
      peer.topics.delete(message.topic);
      break;
    case 'cursor':
      peer.cursor = { ...peer.cursor, x: message.x, y: message.y };
      broadcastPeer(peer);
      break;
    case 'color':
      peer.cursor = { ...peer.cursor, color: message.color };
      broadcastPeer(peer);
      break;
    case 'rpc':
      answerRpc(peer, message.id, message.method);
      break;
    case 'ping':
      send(peer, { type: 'pong', id: message.id, time: Date.now() + CLOCK_SKEW });
      break;
    case 'result':
      peer.calls.get(String(message.id))?.(message);
      break;
    case 'agent':
      peer.run?.abort(new Error('Stopped'));
      peer.run = null;
      if (message.task !== 'stop') startRun(peer, message.task);
      break;
    case 'chaos':
      chaos(peer, message.action);
      break;
  }
}

function broadcastPeer(peer: Peer) {
  for (const other of peers)
    if (other !== peer) send(other, { type: 'peer', id: peer.name, ...peer.cursor });
}

function answerRpc(peer: Peer, id: number, method: RpcMethod) {
  if (method === 'roll')
    send(peer, { type: 'reply', id, value: `🎲 ${1 + Math.floor(Math.random() * 6)}` });
  if (method === 'fail')
    send(peer, { type: 'reply', id, error: 'The server said no (on purpose)' });
  // Slower than the client's 2 s timeout: the request rejects with a TimeoutError first.
  if (method === 'slow')
    setTimeout(() => send(peer, { type: 'reply', id, value: 'finally done' }), 3000);
}

function chaos(peer: Peer, action: 'drop' | 'silence' | 'refuse' | 'garbage') {
  if (action === 'drop') peer.socket.terminate(); // no close frame: the client sees code 1006
  if (action === 'silence') peer.silent = true; // the client's heartbeat times out
  if (action === 'refuse') peer.socket.close(4003, 'Refused by the demo server');
  if (action === 'garbage') {
    peer.socket.send('this is not JSON');
    peer.socket.send(JSON.stringify({ type: 'price', symbol: 'ACME', price: 'cheap' }));
  }
}

// Prices: a random walk per symbol, sent to the clients subscribed to `price:<symbol>`.
const prices = new Map<string, number>(SYMBOLS.map(symbol => [symbol, 100 + Math.random() * 50]));
setInterval(() => {
  for (const [symbol, price] of prices) {
    const next = Math.max(1, price * (1 + (Math.random() - 0.5) / 50));
    prices.set(symbol, next);
    for (const peer of peers) {
      if (peer.topics.has(`price:${symbol}`)) {
        send(peer, { type: 'price', symbol, price: Math.round(next * 100) / 100 });
      }
    }
  }
}, 1000).unref();

// The agent: sends requests to the browser and waits for the results.

function say(peer: Peer, text: string) {
  send(peer, { type: 'agent', text });
}

/** Send a request to the browser and wait for its `result`. Aborting `signal` cancels it. */
function call(
  peer: Peer,
  method: string,
  params: Record<string, string>,
  signal: AbortSignal,
  timeout?: number
): Promise<unknown> {
  const id = `call-${++calls}`;
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      peer.calls.delete(id);
      send(peer, { type: 'cancel', id });
      reject(signal.reason);
    };
    peer.calls.set(id, reply => {
      peer.calls.delete(id);
      signal.removeEventListener('abort', onAbort);
      if (reply.error === undefined) resolve(reply.result);
      else reject(new Error(reply.error));
    });
    signal.addEventListener('abort', onAbort, { once: true });
    send(peer, { type: 'call', id, method, params, ...(timeout ? { timeout } : {}) });
  });
}

function startRun(peer: Peer, task: 'email' | 'file') {
  const run = new AbortController();
  peer.run = run;
  const steps = task === 'email' ? emailTask : fileTask;
  steps(peer, run.signal).then(
    () => {
      if (peer.run === run) peer.run = null;
    },
    (error: unknown) => {
      if (peer.run === run) peer.run = null;
      say(peer, run.signal.aborted ? 'Run stopped.' : `Run failed: ${(error as Error).message}`);
    }
  );
}

async function emailTask(peer: Peer, signal: AbortSignal) {
  say(peer, 'Reading the text you selected on this page…');
  const selection = String(await call(peer, 'get_selection', {}, signal));
  say(peer, `You selected: “${selection}”`);
  const locale = (await call(peer, 'get_locale', {}, signal)) as { timeZone: string };
  say(peer, `Your time zone is ${locale.timeZone}. Asking before I send anything…`);
  const summary = selection.length > 60 ? `${selection.slice(0, 60)}…` : selection;
  const answer = (await call(
    peer,
    'approve',
    { summary: `Email “${summary}” to team@example.com?` },
    signal,
    30_000
  )) as { approved: boolean };
  say(
    peer,
    answer.approved
      ? 'Approved: email sent (not really, this is a demo).'
      : 'Denied: nothing was sent.'
  );
}

async function fileTask(peer: Peer, signal: AbortSignal) {
  say(peer, 'I need a text file to summarize. Pick one below.');
  const file = (await call(
    peer,
    'pick_file',
    { reason: 'Pick a text file for the agent to read' },
    signal,
    60_000
  )) as { name: string; size: number; lines: number };
  say(peer, `Read ${file.name}: ${file.lines} lines, ${file.size} bytes.`);
}
