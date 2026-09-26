import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      // http-proxy streams responses as they arrive, so SSE (/api/stream) passes through unbuffered.
      '/api': { target: 'http://localhost:4317', changeOrigin: true },
    },
  },
});
