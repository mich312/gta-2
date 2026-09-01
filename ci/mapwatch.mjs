/**
 * The iteration diff for the visual-map loop.
 *
 * `mapgen` is bit-deterministic — two runs of one command diff to 0 px — so a
 * fixed set of crops rendered every iteration turns "what changed?" into a
 * number instead of a story. Anything non-zero here is a real change to the
 * shipped city, and anything zero is a guarantee that nothing moved.
 *
 *   node ci/mapwatch.mjs <iteration>    render this iteration's watch set
 *   node ci/mapwatch.mjs <n> --diff <m> diff iteration n against iteration m
 *
 * Plates land in evidence/watch/iter<n>/. Keep the set FIXED across the loop:
 * a watch crop that moves because you re-aimed it tells you nothing.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

// Six boroughs, the water they meet, and the four places this project has
// already fixed something — those last are regression watches, not surveys.
export const WATCH = [
  ['city',        null,             'the whole map, 2 px a tile'],
  ['ravenhill',   '316,126,96,8',   'Ravenhill — the weave'],
  ['kelvin',      '536,126,96,8',   'Kelvin — tightest streets, alleys'],
  ['sunridge',    '380,484,96,8',   'Sunridge — the southern grid'],
  ['marshend',    '448,614,96,8',   'Marsh End — fringe and airfield'],
  ['portvasco',   '60,305,96,8',    'Port Vasco — across the sound'],
  ['gannet',      '63,602,96,8',    'Gannet Rock — air-only plateau'],
  ['docks',       '20,240,96,8',    'The Docks — contour fabric (A03)'],
  ['strait',      '420,280,96,8',   'the strait crossings (A01)'],
  ['hollis',      '350,400,96,8',   'Hollis Creek (A02)'],
  ['southshore',  '600,570,96,8',   'the south shore and lagoon'],
  ['ringroad',    '300,600,96,8',   'the ring road through open country'],
  ['marshpost',   '524,540,32,20',  'Marsh Post — landmark mass (A04)'],
  ['kelvinbridge','436,336,44,16',  'Kelvin Bridge deck (A01)'],
  ['shoulderb',   '267,312,100,8' , 'region B, the unclaimed shoulder (iter5 reach cut)'],
  ['headlanda',   '393,312,156,8' , 'region A, unclaimed and unfixed (iter5, escalated)'],
];

const MAPGEN = 'server/dist/tools/mapgen.js';

function render(iter) {
  const dir = join('evidence/watch', `iter${iter}`);
  mkdirSync(dir, { recursive: true });
  for (const [name, spec] of WATCH) {
    const out = join(dir, `${name}.png`);
    const args = [MAPGEN, `--out=${out}`];
    if (spec) {
      const p = spec.split(',');
      args.push(`--crop=${p[0]},${p[1]},${p[2]}`, `--scale=${p[3]}`);
    }
    execFileSync('node', args, { stdio: 'ignore' });
    process.stdout.write(`  rendered ${name}\n`);
  }
  return dir;
}

function diff(a, b) {
  const da = join('evidence/watch', `iter${a}`);
  const db = join('evidence/watch', `iter${b}`);
  let moved = 0;
  console.log(`\n  iter${b} → iter${a}\n`);
  console.log(`  ${'crop'.padEnd(15)}${'changed px'.padStart(14)}   what it watches`);
  console.log(`  ${'-'.repeat(15)}${'-'.repeat(14)}   ${'-'.repeat(38)}`);
  for (const [name, , what] of WATCH) {
    const fa = join(da, `${name}.png`), fb = join(db, `${name}.png`);
    if (!existsSync(fa) || !existsSync(fb)) { console.log(`  ${name.padEnd(15)}${'—'.padStart(14)}   (no baseline)`); continue; }
    let line = '';
    try {
      line = execFileSync('node', ['evidence/round1/D-pngdiff.mjs', fb, fa], { encoding: 'utf8' }).trim().split('\n').pop();
    } catch { line = 'ERR'; }
    const m = /differing px (\d+)\/(\d+) \(([\d.]+)%\)/.exec(line);
    const size = /SIZE DIFFER/.test(line);
    let cell;
    if (size) { cell = 'SIZE'; moved++; }
    else if (m) { const n = Number(m[1]); if (n > 0) moved++; cell = n === 0 ? '0' : `${m[1]} (${m[3]}%)`; }
    else cell = '?';
    console.log(`  ${name.padEnd(15)}${cell.padStart(14)}   ${what}`);
  }
  console.log(`\n  ${moved} of ${WATCH.length} watch crops moved.\n`);
}

const [iter, flag, other] = process.argv.slice(2);
if (!iter) { console.error('usage: node ci/mapwatch.mjs <iteration> [--diff <other>]'); process.exit(2); }
if (flag === '--diff') diff(iter, other);
else { console.log(`rendering watch set for iteration ${iter}`); const d = render(iter); console.log(`\n  ${WATCH.length} plates in ${d}\n`); }
