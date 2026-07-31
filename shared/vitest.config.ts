import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'shared',
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // The city is 768x768 tiles. A test that walks it for half a dozen seeds
    // is doing half a million tile reads a seed, and several bake it as well
    // — legitimately seconds of work, not a hang.
    testTimeout: 60_000,
  },
});
