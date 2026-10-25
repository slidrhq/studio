import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Two pages: the studio's window, and the page the studio opens in a hidden window to convert a
// design's HTML with the app's engine, render it and run the app's design check (render.html).
// Tauri serves the build (src-tauri/tauri.conf.json), and the dev server while the studio is
// worked on (`pnpm tauri dev`).
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    host: '127.0.0.1',
    port: 5175,
    strictPort: true,
    // The studio's own working files are not the pages' sources.
    watch: { ignored: ['**/src-tauri/**', '**/.data*/**'] },
  },
  build: {
    target: 'chrome120',
    // The conversion engine and the renderer are large, and served from the studio itself.
    chunkSizeWarningLimit: 2000,
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL('index.html', import.meta.url)),
        render: fileURLToPath(new URL('render.html', import.meta.url)),
      },
    },
  },
});
