// Production: one process serves the built Astro site and the demo's WebSocket endpoint on the
// same port. Astro endpoints can't accept WebSocket upgrades, so this mounts the Node adapter's
// middleware in Express (https://docs.astro.build/en/guides/integrations-guide/node/) and
// handles upgrades itself. In development, astro.config.ts attaches the same handler to
// Astro's dev server.
import express, { type RequestHandler } from 'express';
import { handleUpgrade } from './demo-server.ts';

const port = Number(process.env.PORT ?? 4321);

// Written by `npm run build`.
const entry = new URL('./dist/server/entry.mjs', import.meta.url);
const { handler: astro } = (await import(entry.href)) as { handler: RequestHandler };

const app = express();
app.use(express.static(`${import.meta.dirname}/dist/client`)); // prerendered pages and assets
app.use(astro); // on-demand routes: /api/token

const server = app.listen(port, () => {
  console.log(`> react-websocket Astro demo on http://localhost:${port}`);
});
server.on('upgrade', (request, socket, head) => {
  if (!handleUpgrade(request, socket, head)) socket.destroy();
});
