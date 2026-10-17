import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5180,
    strictPort: true,
    // The page connects to /ws on its own origin; forward it to the game server (server.ts).
    proxy: { '/ws': { target: 'http://localhost:8788', ws: true } }
  }
});
