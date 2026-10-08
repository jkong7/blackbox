import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));
const target = process.env.BLACKBOX_API ?? 'http://localhost:7790';

export default defineConfig({
  root,
  plugins: [react()],
  build: {
    outDir: fileURLToPath(new URL('./dist', import.meta.url)),
    emptyOutDir: true,
    chunkSizeWarningLimit: 1500,
  },
  server: {
    port: 5190,
    proxy: {
      '/api': { target, changeOrigin: true },
      '/v1': { target, changeOrigin: true },
    },
  },
});
