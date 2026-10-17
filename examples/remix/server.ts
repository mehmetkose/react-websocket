// One process serves the Remix app and the demo's WebSocket endpoint on the same port. The
// router turns Requests into Responses, and a WebSocket upgrade isn't one, so upgrades are
// handled on the Node server underneath.
import * as http from 'node:http';
import { createRequestListener } from 'remix/node-fetch-server';
import { router } from './app/router.ts';
import { handleUpgrade } from './demo-server.ts';

const port = Number(process.env.PORT ?? 44100);

const server = http.createServer(createRequestListener(router.fetch));
server.on('upgrade', (request, socket, head) => {
  if (!handleUpgrade(request, socket, head)) socket.destroy();
});
server.listen(port, () => {
  console.log(
    `> react-websocket Remix demo on http://localhost:${port} (${process.env.NODE_ENV ?? 'development'})`
  );
});
