import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// No dev proxy: the renderer reaches the main process over IPC, not HTTP, so it behaves the
// same whether it was loaded from this dev server or from the app:// protocol. The previous
// config existed only to read the server's token file and inject a bearer header.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
  },
});
