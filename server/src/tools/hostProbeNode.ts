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
const worldgen = { ...loadWorldgenParams(), provingGround: false };
process.stdout.write(JSON.stringify(probeHashes(seed, worldgen, ticks)));
