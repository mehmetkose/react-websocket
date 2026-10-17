// The messages, shared by the server and the client.
import type { Move, Player } from './sim.ts';

export type ServerMessage =
  // Sent to each player every tick. `time` is the server's clock, and `ack` the last input
  // `seq` it applied from this player.
  | { type: 'snapshot'; time: number; ack: number; you: string; players: Record<string, Player> }
  | { type: 'pong'; id: number; time: number };

export type ClientMessage = ({ type: 'input'; seq: number } & Move) | { type: 'ping'; id: number };

/** Sent as plain text both ways, outside JSON, to keep the connection alive. */
export const HEARTBEAT = 'heartbeat';
