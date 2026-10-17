import { createWebSocket, createWebSocketLatency, createWebSocketState } from 'react-websocket';
import { createChaosWebSocket } from 'react-websocket/chaos';
import { createWebSocketTimeline } from 'react-websocket/timeline';
import { HEARTBEAT, type ClientMessage, type ServerMessage } from './protocol';
import { TICK_MS, lerpWorld, move, type Move, type World } from './sim';

/**
 * The network panel's faults. They're all off until you pick them; a real app would only use
 * this class in development.
 */
export const Chaos = createChaosWebSocket({ logger: console.warn });

function url() {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${location.host}/ws`;
}

export const game = createWebSocket<ServerMessage, ClientMessage>(url, {
  json: true,
  WebSocket: Chaos,
  // Snapshots arrive 20 times a second, so three quiet seconds mean a dead (stalled) link.
  heartbeat: { interval: 4000, timeout: 3000, message: HEARTBEAT, pong: HEARTBEAT }
});

export const latency = createWebSocketLatency(game, {
  ping: id => ({ type: 'ping', id }),
  pong: message => (message.type === 'pong' ? { id: message.id, time: message.time } : undefined),
  interval: 1000
});

/** What the panel switches. Read every frame, so changing it needs no re-render. */
export const settings = {
  interpolate: true,
  predict: true,
  ghost: true,
  autoDelay: false,
  delay: 100
};

// How unevenly snapshots arrive: arrival time minus server time, over the last two seconds.
const spread: number[] = [];
const jitter = () => (spread.length ? Math.max(...spread) - Math.min(...spread) : TICK_MS);

export const timeline = createWebSocketTimeline(game, {
  snapshot: message =>
    message.type === 'snapshot'
      ? {
          time: message.time,
          ack: message.ack,
          state: { you: message.you, players: message.players }
        }
      : undefined,
  interpolate: lerpWorld,
  latency,
  // Auto: one snapshot interval plus the jitter measured below.
  delay: () => (settings.autoDelay ? TICK_MS + jitter() : settings.delay),
  input: {
    send: (input: Move, seq) => ({ type: 'input', seq, ...input }),
    predict: (world, input): World => {
      const me = world.players[world.you];
      return me ? { ...world, players: { ...world.players, [world.you]: move(me, input) } } : world;
    },
    // On a congested link, skip inputs rather than queue them behind each other.
    maxBuffered: 4096
  }
});

timeline.subscribe(() => {
  const latest = timeline.latest();
  if (!latest) return;
  spread.push(performance.now() - latest.time);
  if (spread.length > 40) spread.shift();
});

export interface RosterEntry {
  id: string;
  color: string;
  bot: boolean;
  you: boolean;
}

/**
 * Who's playing, for the HUD. Snapshots arrive 20 times a second but the roster rarely changes:
 * the reducer keeps the same array while it doesn't, and `batch: 'frame'` caps renders anyway.
 */
export const roster = createWebSocketState(game, {
  initialState: [] as RosterEntry[],
  reduce: (state, message) => {
    if (message.type !== 'snapshot') return state;
    const ids = Object.keys(message.players);
    const same =
      ids.length === state.length &&
      ids.every((id, i) => state[i]!.id === id && state[i]!.you === (id === message.you));
    if (same) return state;
    return ids.map(id => ({
      id,
      color: message.players[id]!.color,
      bot: !!message.players[id]!.bot,
      you: id === message.you
    }));
  },
  batch: 'frame'
});
