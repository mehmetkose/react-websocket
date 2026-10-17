import { createHmac, timingSafeEqual } from 'node:crypto';

// A demo secret. A real app reads it from the environment and never ships it to the browser.
const SECRET = process.env.DEMO_TOKEN_SECRET ?? 'react-websocket-demo';
const LIFETIME = 60_000;

/** A short-lived token for the WebSocket URL: its expiry time, signed. */
export function issueToken(now = Date.now()): string {
  const expires = String(now + LIFETIME);
  return `${expires}.${sign(expires)}`;
}

export function verifyToken(token: string | null, now = Date.now()): boolean {
  const [expires, signature] = token?.split('.') ?? [];
  if (!expires || !signature) return false;
  const expected = Buffer.from(sign(expires));
  const actual = Buffer.from(signature);
  return (
    actual.length === expected.length && timingSafeEqual(actual, expected) && Number(expires) > now
  );
}

function sign(value: string) {
  return createHmac('sha256', SECRET).update(value).digest('base64url');
}
