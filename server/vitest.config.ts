import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

// Tests run against shared SOURCE (no build step needed): alias the package
// name to the TS entrypoint.
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
  test: {
    name: 'server',
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // The city is 768x768 tiles. A test that walks it for half a dozen seeds
    // is doing half a million tile reads a seed, and several bake it as well
    // — legitimately seconds of work, not a hang.
    testTimeout: 60_000,
  },
});
