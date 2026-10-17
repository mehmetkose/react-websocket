import { issueToken } from '@/lib/token';

// The WebSocket URL function fetches a fresh token here before every connection attempt.
// A real app would check the user's session first.
export function GET() {
  return Response.json({ token: issueToken() }, { headers: { 'Cache-Control': 'no-store' } });
}
