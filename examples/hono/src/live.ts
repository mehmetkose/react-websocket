import { createWebSocket, createWebSocketState } from 'react-websocket';
import { HEARTBEAT, type ChatMessage, type ClientMessage, type ServerMessage } from './protocol';

// The page's own origin: in development Vite forwards /ws to the Hono server, and in
// production Hono serves the page and the socket on one port.
function url() {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${location.host}/ws`;
}

/** The one connection the page shares. */
export const live = createWebSocket<ServerMessage, ClientMessage>(url, {
  json: true,
  // Five quiet seconds after a ping count as a dead connection, and the client reconnects.
  heartbeat: { interval: 10_000, timeout: 5000, message: HEARTBEAT, pong: HEARTBEAT },
  queue: { limit: 20 },
  logger: console.debug
});

export interface Room {
  me: string;
  online: string[];
  messages: ChatMessage[];
}

/** The room as the server last described it. Kept across reconnects, refreshed by `welcome`. */
export const room = createWebSocketState(live, {
  initialState: { me: '', online: [], messages: [] } as Room,
  reduce: (state, message): Room => {
    switch (message.type) {
      // Sent on every connection, so the history replaces what we had rather than repeating it.
      case 'welcome':
        return { ...state, me: message.name, messages: message.history };
      case 'chat':
        return { ...state, messages: [...state.messages, message.message].slice(-50) };
      case 'presence':
        return { ...state, online: message.online };
    }
  }
});
