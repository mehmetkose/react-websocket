// One process serves the Next.js app and the demo's WebSocket endpoint on the same port.
// Next.js route handlers can't accept WebSocket upgrades, so this is a custom server:
// https://nextjs.org/docs/app/guides/custom-server
import { createServer } from 'node:http';
import next from 'next';
import { handleUpgrade } from './demo-server.ts';

const port = Number(process.env.PORT ?? 3000);
const dev = process.env.NODE_ENV !== 'production';
const app = next({ dev, port });
await app.prepare();
const handle = app.getRequestHandler();
const nextUpgrade = app.getUpgradeHandler();

const server = createServer((request, response) => void handle(request, response));
server.on('upgrade', (request, socket, head) => {
  const { pathname } = new URL(request.url ?? '/', 'http://localhost');
  if (pathname === '/ws') handleUpgrade(request, socket, head);
  else void nextUpgrade(request, socket, head); // Next.js dev tools and hot reload
});
server.listen(port, () => {
  console.log(
    `> react-websocket demo on http://localhost:${port} (${dev ? 'development' : 'production'})`
  );
});
