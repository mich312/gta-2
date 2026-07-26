import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

// Resolve the shared package straight to its TS source so client dev needs
// no build step and edits to shared/ hot-reload.
export default defineConfig({
  resolve: {
    alias: [
      {
        find: /^shared$/,
        replacement: fileURLToPath(new URL('../shared/src/index.ts', import.meta.url)),
      },
      {
        find: /^shared\/data\//,
        replacement: fileURLToPath(new URL('../shared/data/', import.meta.url)),
      },
    ],
  },
  server: { port: 5173 },
});
