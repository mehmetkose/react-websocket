import { z } from 'zod';

/**
 * Every message the demo server sends. The client validates each one with this schema
 * (the `schema` option), so a message that doesn't match is reported as a `MessageError`.
 */
export const serverMessage = z.discriminatedUnion('type', [
  // The first message on every connection: the name the server gave it.
  z.object({ type: z.literal('welcome'), name: z.string() }),
  z.object({
    type: z.literal('chat'),
    id: z.string(),
    from: z.string(),
    text: z.string(),
    at: z.number()
  }),
  z.object({ type: z.literal('price'), symbol: z.string(), price: z.number() }),
  z.object({
    type: z.literal('peer'),
    id: z.string(),
    x: z.number(),
    y: z.number(),
    // A hex color from the server's palette: it's painted as this peer's cursor.
    color: z.string().regex(/^#[0-9a-f]{6}$/i)
  }),
  z.object({ type: z.literal('leave'), id: z.string() }),
  z.object({
    type: z.literal('reply'),
    id: z.number(),
    value: z.string().optional(),
    error: z.string().optional()
  }),
  z.object({ type: z.literal('pong'), id: z.number(), time: z.number() }),
  // A request from the agent, answered by `createWebSocketResponder`.
  z.object({
    type: z.literal('call'),
    id: z.string(),
    method: z.string(),
    params: z.record(z.string(), z.string()),
    timeout: z.number().optional()
  }),
  z.object({ type: z.literal('cancel'), id: z.string() }),
  z.object({ type: z.literal('agent'), text: z.string() })
]);

export type ServerMessage = z.infer<typeof serverMessage>;

/** Every message the client sends. */
export type ClientMessage =
  | { type: 'chat'; text: string }
  | { type: 'subscribe' | 'unsubscribe'; topic: string }
  | { type: 'cursor'; x: number; y: number }
  | { type: 'color'; color: string }
  | { type: 'rpc'; id: number; method: RpcMethod }
  | { type: 'ping'; id: number }
  | { type: 'result'; id: number | string; result?: unknown; error?: string }
  | { type: 'agent'; task: 'email' | 'file' | 'stop' }
  | { type: 'chaos'; action: 'drop' | 'silence' | 'refuse' | 'garbage' };

export type RpcMethod = 'roll' | 'slow' | 'fail';

export const SYMBOLS = ['ACME', 'GLOBEX', 'INITECH', 'UMBRELLA'] as const;
