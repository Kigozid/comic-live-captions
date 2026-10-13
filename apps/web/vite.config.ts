import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  optimizeDeps: {
    include: ['clipper-lib'],
    exclude: ['sharp'],
  },
  resolve: {
    alias: {
      // Node-only modules stay on the API; these stubs keep the web bundle loadable.
      sharp: new URL('./src/sharp-browser-stub.ts', import.meta.url).pathname,
      'node:crypto': new URL('./src/node-crypto-browser-stub.ts', import.meta.url)
        .pathname,
      'node:path': new URL('./src/node-path-browser-stub.ts', import.meta.url)
        .pathname,
    },
  },
  server: {
    host: '127.0.0.1',
    port: Number(process.env.WEB_PORT ?? 5173),
    strictPort: true,
    proxy: {
      '/api': `http://127.0.0.1:${process.env.API_PORT ?? '3039'}`,
    },
  },
});

