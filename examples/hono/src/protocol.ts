// The messages both sides speak. The server and the client import the same types, so a change
// here is checked on both ends.

/**
 * Bump this when a message changes shape. Clients send it when they connect, and the server
 * turns away pages built for another version, so tabs left open across a deploy reload.
 */
export const PROTOCOL = 1;

/** The close code for a client built for another `PROTOCOL`: reload, don't reconnect. */
export const OUTDATED = 4426;

export interface ChatMessage {
  id: string;
  from: string;
  text: string;
  at: number;
}

/** Every message the server sends. */
export type ServerMessage =
  // The first message on every connection, including reconnects: who you are and what you missed.
  | { type: 'welcome'; name: string; history: ChatMessage[] }
  | { type: 'chat'; message: ChatMessage }
  | { type: 'presence'; online: string[] }
  // The answer to a `chat` message, with its id: posted, or refused with a reason.
  | { type: 'posted'; id: number }
  | { type: 'refused'; id: number; reason: string }
  // Move to a new connection at a random moment in the next `within` ms.
  | { type: 'reconnect'; within: number };

/**
 * Every message the client sends. `id` is new on every attempt, so the answer finds its
 * request. `key` stays the same when the user retries, so the server posts it once.
 */
export type ClientMessage = { type: 'chat'; id: number; key: string; text: string };

/** The client's heartbeat ping and the server's reply, sent as plain text rather than JSON. */
export const HEARTBEAT = 'heartbeat';
