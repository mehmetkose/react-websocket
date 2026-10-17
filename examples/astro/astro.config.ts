import node from '@astrojs/node';
import react from '@astrojs/react';
import { defineConfig } from 'astro/config';
import { handleUpgrade } from './demo-server.ts';

export default defineConfig({
  integrations: [
    react(),
    {
      // Astro endpoints can't accept WebSocket upgrades, so in development this attaches the
      // demo's WebSocket server to Astro's dev server. Upgrades for other paths (Vite's hot
      // reload) are left alone. In production, server.ts does the same job.
      name: 'demo-websocket',
      hooks: {
        'astro:server:setup': ({ server }) => {
          server.httpServer?.on('upgrade', handleUpgrade);
        }
      }
    }
  ],
  // Pages are prerendered to static HTML; only /api/token runs on demand. Middleware mode lets
  // server.ts serve the build from its own HTTP server, next to the WebSocket endpoint.
  adapter: node({ mode: 'middleware' })
});
