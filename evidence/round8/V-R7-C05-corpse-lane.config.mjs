// Runner for V-R7-C05-corpse-lane.test.ts. The probe lives in evidence/, not
// in shared/test, so it is never part of the suite; vitest still needs the
// shared project's root to resolve its imports.
//
//   cd shared && node ../node_modules/vitest/vitest.mjs run \
//     --config ../evidence/round8/V-R7-C05-corpse-lane.config.mjs
export default {
  test: {
    name: 'V-R7-C05',
    root: new URL('../../shared/', import.meta.url).pathname,
    include: [new URL('./V-R7-C05-corpse-lane.test.ts', import.meta.url).pathname],
    environment: 'node',
    testTimeout: 180000,
  },
};
