import { defineConfig, type Plugin } from 'vite';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const sharedSrc = fileURLToPath(new URL('../shared/src/', import.meta.url));
const serverSrc = fileURLToPath(new URL('../server/src/', import.meta.url));

/**
 * Resolve the NodeNext `.js` specifiers in shared/ and server/ sources to the
 * `.ts` files they mean.
 *
 * Both packages are compiled by `tsc` with `moduleResolution: NodeNext`,
 * which requires imports to name the *emitted* file (`./session.js`). Vite
 * resolves specifiers literally, so pointing it at the TypeScript sources
 * needs this bridge. It only fires for relative specifiers whose importer is
 * inside those two directories, so a genuine `.js` file elsewhere still
 * resolves as itself.
 */
function tsSourceSpecifiers(): Plugin {
  return {
    name: 'ts-source-specifiers',
    enforce: 'pre',
    resolveId(source, importer) {
      if (!importer || !source.startsWith('.') || !source.endsWith('.js')) return null;
      if (!importer.startsWith(sharedSrc) && !importer.startsWith(serverSrc)) return null;
      const abs = fileURLToPath(new URL(source, `file://${importer}`));
      const ts = abs.replace(/\.js$/, '.ts');
      return existsSync(ts) ? ts : null;
    },
  };
}

// Resolve the shared package straight to its TS source so client dev needs
// no build step and edits to shared/ hot-reload. `server/` is aliased the
// same way, for the offline host: the worker runs the real server code
// (SHIP.md T1), not a copy of it.
export default defineConfig({
  plugins: [tsSourceSpecifiers()],
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
      { find: /^server\//, replacement: serverSrc },
    ],
  },
  server: {
    port: 5173,
    // The server sources live outside client/, so Vite has to be told they
    // are fair game to serve in dev.
    fs: { allow: [fileURLToPath(new URL('..', import.meta.url))] },
  },
});
