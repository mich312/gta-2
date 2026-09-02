import { loadSharedTuning, loadWorldgenParams } from '../tuning.js';
import { probeHashes } from './hostProbe.js';

/**
 * The Node half of the cross-host determinism check.
 *
 *   node server/dist/tools/hostProbeNode.js [seed] [ticks]
 *
 * Prints one JSON line. `ci/hostParity.mjs` runs the browser half against the
 * dev server and compares. See SHIP.md T1.
 */
const seed = Number.parseInt(process.argv[2] ?? '7', 10);
const ticks = Number.parseInt(process.argv[3] ?? '600', 10);

loadSharedTuning('normal');
// `HEIGHTS=1` runs the probe on the ground-with-height simulation (3D.md X2);
// the browser side reads the same choice off `?heights=1`.
const worldgen = { ...loadWorldgenParams(), provingGround: false, heights: process.env['HEIGHTS'] === '1' };
process.stdout.write(JSON.stringify(probeHashes(seed, worldgen, ticks)));
