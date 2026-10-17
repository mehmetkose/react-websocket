// The messages both sides speak. The server and the client import the same types, so a change
// here is checked on both ends.

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
  | { type: 'presence'; online: string[] };

/** Every message the client sends. */
export type ClientMessage = { type: 'chat'; text: string };

/** The client's heartbeat ping and the server's reply, sent as plain text rather than JSON. */
export const HEARTBEAT = 'heartbeat';
