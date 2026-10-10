import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

// The SPA calls only its own origin: /api is proxied to the FastAPI server on 7310.
export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 5310,
    strictPort: true,
    proxy: { '/api': { target: 'http://127.0.0.1:7310', changeOrigin: false } },
  },
  preview: { host: '127.0.0.1', port: 5310, strictPort: true },
  test: { environment: 'node', include: ['src/**/*.test.ts'] },
});
