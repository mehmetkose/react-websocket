// The one connection the whole demo shares, and every manager built on it. Each island is a
// separate React root, but they all import this module, so they share one client (and one
// socket). It imports `react-websocket/core`, which has no React dependency, so the page's plain
// <script> uses it too. On the server, where Astro renders the islands, nothing connects.
import {
  createWebSocket,
  createWebSocketLatency,
  createWebSocketRequests,
  createWebSocketResponder,
  createWebSocketState,
  createWebSocketTopics
} from 'react-websocket/core';
import { serverMessage, type ClientMessage, type RpcMethod, type ServerMessage } from './protocol';

// Called before every connection attempt, including reconnects, so each one gets a fresh token.
async function url() {
  const response = await fetch('/api/token');
  if (!response.ok) throw new Error(`Token request failed: HTTP ${response.status}`);
  const { token } = (await response.json()) as { token: string };
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${location.host}/ws?token=${encodeURIComponent(token)}`;
}

export const live = createWebSocket<ServerMessage, ClientMessage>(url, {
  json: true,
  // Every message is validated; one that doesn't match is reported to `error` listeners.
  schema: serverMessage,
  // The demo server answers 'heartbeat' with 'heartbeat'. Three quiet seconds after a ping
  // count as a dead connection.
  heartbeat: { interval: 4000, timeout: 3000, message: 'heartbeat', pong: 'heartbeat' },
  // 4003 means the server refused this client: retrying won't help.
  reconnect: { maxDelay: 8000, shouldReconnect: close => close.code !== 4003 },
  queue: { limit: 50 },
  logger: console.debug
});

/**
 * The name the server gave this connection; a new connection gets a new name. Kept here rather
 * than in an island: islands hydrate in no fixed order, so the `welcome` message may arrive
 * before the one that shows it has mounted.
 */
export const me = createWebSocketState(live, {
  initialState: null as string | null,
  reduce: (state, message) => (message.type === 'welcome' ? message.name : state)
});

/** Price subscriptions, held by `useWebSocketTopic` and sent again after every reconnect. */
export const topics = createWebSocketTopics(live, {
  subscribe: topic => ({ type: 'subscribe', topic }),
  unsubscribe: topic => ({ type: 'unsubscribe', topic })
});

/** The latest price per symbol. */
export const prices = createWebSocketState(live, {
  initialState: {} as Record<string, number>,
  reduce: (state, message) =>
    message.type === 'price' ? { ...state, [message.symbol]: message.price } : state
});

export type Cursor = { x: number; y: number; color: string };

/** Other tabs' cursors. */
export const peers = createWebSocketState(live, {
  initialState: {} as Record<string, Cursor>,
  reduce: (state, message) => {
    if (message.type === 'peer') {
      return { ...state, [message.id]: { x: message.x, y: message.y, color: message.color } };
    }
    if (message.type === 'leave') {
      const { [message.id]: _left, ...rest } = state;
      return rest;
    }
    return state;
  }
});
// The server sends every cursor again on connect; drop the ones we may have missed leaving.
live.on('open', () => peers.reset());

/** Requests to the server, with timeouts. */
export const rpc = createWebSocketRequests(live, {
  send: (method: RpcMethod, id) => ({ type: 'rpc', id, method }),
  reply: message => (message.type === 'reply' ? message.id : undefined),
  error: message =>
    message.type === 'reply' && message.error ? new Error(message.error) : undefined,
  timeout: 2000
});

/** Round-trip time and the server's clock. */
export const latency = createWebSocketLatency(live, {
  ping: id => ({ type: 'ping', id }),
  pong: message => (message.type === 'pong' ? { id: message.id, time: message.time } : undefined)
});

/** Requests the agent on the server sends to this page. */
export const tools = createWebSocketResponder(live, {
  request: message => (message.type === 'call' ? message : undefined),
  respond: (id, result: unknown) => ({ type: 'result', id, result }),
  error: (id, error) => ({
    type: 'result',
    id,
    error: error instanceof Error ? `${error.name}: ${error.message}` : String(error)
  }),
  cancel: message => (message.type === 'cancel' ? message.id : undefined)
});

// Tools the agent may use without asking: they only read what's on this page.
tools.onRequest('get_selection', () => window.getSelection()?.toString().trim() || '(nothing)');
tools.onRequest('get_locale', () => ({
  language: navigator.language,
  timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone
}));
// 'approve' and 'pick_file' have no handler: a person answers them (see components/Agent.tsx).
