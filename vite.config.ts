import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5199,
    strictPort: true,
    // the backend (server/server.ts) is the page's only way into Hatchet
    proxy: { '/api': 'http://localhost:8787' },
  },
});
