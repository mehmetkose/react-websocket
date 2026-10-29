import {
  createWebSocket,
  createWebSocketRequests,
  createWebSocketState,
  retryableClose
} from 'react-websocket';
import {
  HEARTBEAT,
  OUTDATED,
  PROTOCOL,
  type ChatMessage,
  type ClientMessage,
  type ServerMessage
} from './protocol';

// The page's own origin: in development Vite forwards /ws to the Hono server, and in
// production Hono serves the page and the socket on one port.
function url() {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  // `v` tells the server which messages this page was built for.
  return `${protocol}//${location.host}/ws?v=${PROTOCOL}`;
}

/** The one connection the page shares. */
export const live = createWebSocket<ServerMessage, ClientMessage>(url, {
  json: true,
  // Five quiet seconds after a ping count as a dead connection, and the client reconnects.
  heartbeat: { interval: 10_000, timeout: 5000, message: HEARTBEAT, pong: HEARTBEAT },
  queue: { limit: 20 },
  // An outdated page stops instead of reconnecting, and asks the user to reload.
  reconnect: { shouldReconnect: close => close.code !== OUTDATED && retryableClose(close) },
  logger: console.debug
});

// The server asks long-lived connections to move. `migrate()` opens the new connection before
// it closes this one, so the status stays `open` and no message is missed.
live.on('message', message => {
  if (message.type === 'reconnect') live.migrate({ within: message.within });
});

/** The server got the message and said no. Sending it again gets the same answer. */
export class Refused extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'Refused';
  }
}

/** Chat messages, each answered by the server: `chat.request()` resolves once it's posted. */
export const chat = createWebSocketRequests(live, {
  send: (message: { key: string; text: string }, id) => ({ type: 'chat', id, ...message }),
  reply: message =>
    message.type === 'posted' || message.type === 'refused' ? message.id : undefined,
  error: message => (message.type === 'refused' ? new Refused(message.reason) : undefined),
  // Counts from the call, so it also covers a message that waits in the queue for a reconnect.
  timeout: 30_000
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
      // Answers to `chat` and the server's notices are for other parts of the page.
      default:
        return state;
    }
  }
});
