// The example's game server: a fixed tick that applies inputs in order and sends each player a
// snapshot. Nothing here is part of react-websocket; any WebSocket server would do.
import { WebSocketServer, type WebSocket } from 'ws';
import { HEARTBEAT, type ClientMessage, type ServerMessage } from './src/protocol.ts';
import {
  BOTS,
  BURST,
  MAX_STEPS,
  STEPS_PER_TICK,
  TICK_MS,
  botAt,
  move,
  spawn,
  type Move,
  type Player
} from './src/sim.ts';

const port = Number(process.env.PORT ?? 8788);

// A clock that never goes backward, for snapshots and pongs alike, so the client's latency
// estimate and its timeline agree.
const now = () => performance.timeOrigin + performance.now();

interface Client {
  socket: WebSocket;
  player: Player;
  /** Inputs received but not applied yet, in `seq` order. */
  inputs: ({ seq: number } & Move)[];
  /** The last `seq` received, to ignore repeats. */
  received: number;
  /** The last `seq` applied, sent back as `ack`. */
  ack: number;
  /** Steps this player may still move: refilled every tick, up to `BURST`. */
  tokens: number;
}

const clients = new Map<string, Client>();
let joined = 0;

function send(socket: WebSocket, message: ServerMessage) {
  socket.send(JSON.stringify(message));
}

const direction = (value: unknown) => value === -1 || value === 0 || value === 1;

function parse(data: string): ClientMessage | undefined {
  try {
    const message = JSON.parse(data) as ClientMessage;
    if (message.type === 'ping' && typeof message.id === 'number') return message;
    if (message.type === 'aim' && Number.isFinite(message.angle)) return message;
    if (
      message.type === 'input' &&
      Number.isInteger(message.seq) &&
      direction(message.dx) &&
      direction(message.dy) &&
      Number.isInteger(message.steps) &&
      message.steps >= 1 &&
      message.steps <= MAX_STEPS
    )
      return message;
  } catch {
    // Not JSON: ignore it.
  }
}

const server = new WebSocketServer({ port, path: '/ws' });

server.on('connection', socket => {
  const id = `p${++joined}`;
  const client: Client = {
    socket,
    player: spawn(joined),
    inputs: [],
    received: 0,
    ack: 0,
    tokens: BURST
  };
  clients.set(id, client);

  socket.on('message', raw => {
    const data = String(raw);
    // Answer the client's heartbeat so it knows the connection is alive.
    if (data === HEARTBEAT) return socket.send(HEARTBEAT);
    const message = parse(data);
    if (message?.type === 'ping') send(socket, { type: 'pong', id: message.id, time: now() });
    else if (message?.type === 'aim') client.player = { ...client.player, angle: message.angle };
    // Sequence numbers only go up; don't assume they start at 1 on a new connection.
    else if (message?.type === 'input' && message.seq > client.received) {
      client.received = message.seq;
      client.inputs.push(message);
    }
  });
  socket.on('close', () => clients.delete(id));
});

setInterval(() => {
  const time = now();
  for (const client of clients.values()) {
    // Apply inputs in order, with the same `move()` the client predicts with. A burst bigger
    // than the player's tokens waits for the next ticks, so nobody moves faster than real time.
    client.tokens = Math.min(BURST, client.tokens + STEPS_PER_TICK);
    while (client.inputs.length && client.inputs[0]!.steps <= client.tokens) {
      const input = client.inputs.shift()!;
      client.tokens -= input.steps;
      client.player = move(client.player, input);
      client.ack = input.seq;
    }
  }

  const players: Record<string, Player> = {};
  for (let i = 0; i < BOTS; i++) players[`bot${i + 1}`] = botAt(i, time);
  for (const [id, client] of clients) players[id] = client.player;
  for (const [id, client] of clients) {
    send(client.socket, { type: 'snapshot', time, ack: client.ack, you: id, players });
  }
}, TICK_MS);

console.log(`Game server on ws://localhost:${port}/ws (${1000 / TICK_MS} ticks a second)`);
