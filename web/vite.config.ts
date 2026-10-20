import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/** The Python server: the API, the job files, and the built pages in production. */
const api = process.env.SLIDR_MANAGER_API ?? 'http://127.0.0.1:8765';

// Two pages: the studio, and the page the server opens in a headless browser to convert a
// design's HTML with the app's engine, render it and run the app's design check (render.html).
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 5175,
    strictPort: true,
    proxy: { '/api': { target: api, changeOrigin: false } },
  },
  build: {
    target: 'chrome120',
    // The conversion engine and the renderer are large, and served from this machine.
    chunkSizeWarningLimit: 2000,
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL('index.html', import.meta.url)),
        render: fileURLToPath(new URL('render.html', import.meta.url)),
      },
    },
  },
});
