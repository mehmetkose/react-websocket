import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  server: {
    // The page connects to /ws on its own origin; forward it to the Hono server (server.ts).
    proxy: { '/ws': { target: 'http://localhost:8787', ws: true } }
  }
});
