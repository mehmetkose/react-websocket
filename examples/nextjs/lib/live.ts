// The one connection the whole demo shares, and every manager built on it. This module has no
// 'use client': `react-websocket/core` has no hooks, so it's safe to import from anywhere, and the
// client only connects in a browser.
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
// 'approve' and 'pick_file' have no handler: a person answers them (see components/agent.tsx).
