import type { APIRoute } from 'astro';
import { issueToken } from '../../lib/token';

// Rendered on demand: every request gets a new token. The rest of the site is prerendered.
export const prerender = false;

// The WebSocket URL function fetches a fresh token here before every connection attempt.
// A real app would check the user's session first.
export const GET: APIRoute = () =>
  Response.json({ token: issueToken() }, { headers: { 'Cache-Control': 'no-store' } });
