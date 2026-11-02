import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  // exposes HATCHET_CLIENT_TOKEN from .env to the page as import.meta.env.HATCHET_CLIENT_TOKEN
  envPrefix: 'HATCHET_CLIENT_',
  // The SDK is linked from a local checkout, outside node_modules, so Vite
  // needs telling to bundle its CommonJS. Not needed with the npm package.
  optimizeDeps: { include: ['@hatchet-dev/typescript-sdk/core'] },
  build: { commonjsOptions: { include: [/sdks\/typescript\/dist/, /node_modules/] } },
  server: { port: 5199, strictPort: true },
});
