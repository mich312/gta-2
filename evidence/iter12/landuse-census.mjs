/* `landuse-staircase`, reimplemented off mapAudit's own definitions so a
 * candidate smoothing layer can be priced without touching the shipped tool
 * (another agent holds `server/src/tools/mapAudit.ts` this iteration).
 *
 * CONTROL, printed first and every run: with the layer set the tool ships
 * today (coast + bank + deck chains, plus the bevel plane) this must print
 * the tool's own line to the decimal —
 *     landuse-staircase   31   2703   2703.0   2427.0
 * If the SHIPPED row below does not read that, this instrument is lying and
 * nothing after it is evidence.
 *
 *   node evidence/iter12/landuse-census.mjs
 */
import { readFileSync } from 'node:fs';
import {
  decodeBakedCity, shoreChains, buildDeckCut, deriveBevels, BEV_NONE,
  T_TREES, T_FIELD, T_PARK, T_SAND,
} from '../../shared/dist/index.js';

const MIN_SPAN = 16;             // GATES.minSpan
const LANDUSE_UNCOVERED = 0.5;
const LANDUSE_MIN_PATCH = 60;
const FACE = [[0, -1], [0, 1], [-1, 0], [1, 0]];
const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const magOf = (n) => Math.max(1, Math.round(n));

const src = readFileSync('shared/src/world/city.data.ts', 'utf8');
const q0 = src.indexOf('"'), q1 = src.lastIndexOf('"');
const city = decodeBakedCity(JSON.parse(JSON.parse(src.slice(q0, q1 + 1))));
const W = city.widthTiles, H = city.heightTiles, tiles = city.tiles;
const at = (x, y) => (x < 0 || y < 0 || x >= W || y >= H ? -1 : tiles[y * W + x]);

function components(mask) {
  const seen = new Uint8Array(W * H);
  const out = [];
  for (let s = 0; s < mask.length; s++) {
    if (mask[s] === 0 || seen[s] === 1) continue;
    const bag = []; const stack = [s]; seen[s] = 1;
    while (stack.length) {
      const i = stack.pop(); bag.push(i);
      const x = i % W, y = (i - x) / W;
      for (const [dx, dy] of DIRS) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const j = ny * W + nx;
        if (seen[j] === 1 || mask[j] === 0) continue;
        seen[j] = 1; stack.push(j);
      }
    }
    out.push(bag);
  }
  return out;
}

const CUT = {
  inside: (t) => t === T_TREES,
  outside: (t) => t === T_FIELD || t === T_PARK || t === T_SAND,
};

let plane = { n: 0, mag: 0 };
function census(smoothed) {
  plane = { n: 0, mag: 0 };
  const mask = new Uint8Array(W * H);
  for (let i = 0; i < tiles.length; i++) mask[i] = CUT.inside(tiles[i]) ? 1 : 0;
  const out = [];
  for (const bag of components(mask)) {
    if (bag.length < LANDUSE_MIN_PATCH) continue;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const i of bag) {
      const x = i % W, y = (i - x) / W;
      if (x < x0) x0 = x; if (x > x1) x1 = x;
      if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
    const inBag = new Set(bag);
    let perimeter = 0;
    for (const i of bag) {
      const x = i % W, y = (i - x) / W;
      for (const [dx, dy] of FACE) if (CUT.outside(at(x + dx, y + dy))) perimeter++;
    }
    let faces = 0, dissolved = 0, mag = 0, bestRun = 0, bestX = 0, bestY = 0;
    for (const [dx, dy] of FACE) {
      const alongX = dx === 0;
      const u0 = alongX ? y0 : x0, u1 = alongX ? y1 : x1;
      const v0 = alongX ? x0 : y0, v1 = alongX ? x1 : y1;
      for (let u = u0; u <= u1; u++) {
        let run = 0;
        for (let v = v0; v <= v1 + 1; v++) {
          const x = alongX ? v : u, y = alongX ? u : v;
          const on = v <= v1 && inBag.has(y * W + x) && CUT.outside(at(x + dx, y + dy));
          if (on) {
            run++; faces++;
            if (smoothed(x, y) || smoothed(x + dx, y + dy)) dissolved++;
            continue;
          }
          if (run >= 2) {
            mag += run;
            if (run > bestRun) { bestRun = run; bestX = alongX ? v - run / 2 : u; bestY = alongX ? u : v - run / 2; }
          }
          run = 0;
        }
      }
    }
    if (faces === 0 || mag < MIN_SPAN) continue;
    const uncovered = (faces - dissolved) / faces;
    // The TILE PLANE, before the detector's own half-gate throws a wood out
    // for being repainted. This is the number that must NOT move: it is the
    // `TREES` mask's flat tile edge, and a repaint cannot touch it.
    plane.n += 1; plane.mag += magOf(mag);
    if (uncovered < LANDUSE_UNCOVERED) continue;
    out.push({
      tiles: bag.length, mag: magOf(mag), drawn: Math.round(magOf(mag) * uncovered),
      faces, dissolved, perimeter, bestRun,
      x: Math.max(0, Math.round(bestX) - 8), y: Math.max(0, Math.round(bestY) - 8),
    });
  }
  out.sort((p, q) => q.mag - p.mag);
  return out;
}

function row(label, f) {
  const p = plane;
  const n = f.length;
  const t = f.reduce((s, g) => s + g.mag, 0);
  const d = f.reduce((s, g) => s + g.drawn, 0);
  console.log(`  ${label.padEnd(26)} ${String(n).padStart(4)} ${String(t).padStart(8)} ${t.toFixed(1).padStart(10)} ${d.toFixed(1).padStart(10)}   ${String(p.n).padStart(4)} ${String(p.mag).padStart(7)}`);
  return { n, t, d, planeN: p.n, planeMag: p.mag };
}

const coast = shoreChains(city.shores, W, H);
const band = shoreChains(city.banks, W, H);
const deck = buildDeckCut(tiles, W, H, city.courses);
const bev = deriveBevels(tiles, W, H);
const shipped = (x, y) => {
  if (x < 0 || y < 0 || x >= W || y >= H) return false;
  const i = y * W + x;
  return coast.has(i) || band.has(i) || deck.has(i) || bev[i] !== BEV_NONE;
};

console.log('\n  landuse-staircase, reproduced from mapAudit\'s definitions\n');
console.log(`  ${'layer set'.padEnd(26)} ${'n'.padStart(4)} ${'tiles'.padStart(8)} ${'SCORE'.padStart(10)} ${'DRAWN'.padStart(10)}   ${'TILE PLANE'}`);
console.log(`  ${''.padEnd(26)} ${''.padStart(4)} ${''.padStart(8)} ${''.padStart(10)} ${''.padStart(10)}   ${'n'.padStart(4)} ${'mag'.padStart(7)}`);
const base = row('SHIPPED (control)', census(shipped));
const ok = base.n === 31 && base.t === 2703 && base.d === 2427;
console.log(`\n  CONTROL ${ok ? 'MATCHES' : '*** DOES NOT MATCH ***'} pnpm mapaudit's own row: 31 2703 2703.0 2427.0`);
if (!ok) process.exitCode = 1;

let wood = null;
try {
  const m = await import('../../shared/dist/index.js');
  if (typeof m.buildWoodCut === 'function') wood = m.buildWoodCut(tiles, W, H);
} catch { /* pre-fix tree: no wood cut exists */ }
if (wood === null) {
  console.log('\n  buildWoodCut: NOT PRESENT in shared — this is the pre-fix tree.\n');
} else {
  const withWood = (x, y) => {
    if (x < 0 || y < 0 || x >= W || y >= H) return false;
    return shipped(x, y) || wood.has(y * W + x);
  };
  console.log('');
  const after = row('+ wood chain', census(withWood));
  console.log(`\n  wood chain covers ${wood.size} tiles`);
  const key = (f) => `${f.x},${f.y},${f.tiles}`;
  const bMap = new Map(census(shipped).map((f) => [key(f), f]));
  const aMap = new Map(census(withWood).map((f) => [key(f), f]));
  console.log("\n  per wood, biggest first. `crop` is the detector's own; `drawn` is what a reviewer sent to look at it sees.\n");
  console.log(`  ${'crop'.padEnd(12)} ${'tiles'.padStart(6)} ${'mag'.padStart(5)} ${'drawn'.padStart(6)} ${'->'.padStart(3)} ${'drawn'.padStart(6)}   faces on NO smoothing layer`);
  for (const [k, f] of [...bMap].sort((p2, q2) => q2[1].mag - p2[1].mag)) {
    const g = aMap.get(k);
    const gd = g === undefined ? 0 : g.drawn;
    const gf = g === undefined ? 'below the half-gate, not reported' : `${g.faces - g.dissolved} of ${g.faces}`;
    console.log(`  ${`${f.x},${f.y}`.padEnd(12)} ${String(f.tiles).padStart(6)} ${String(f.mag).padStart(5)} ${String(f.drawn).padStart(6)} ${'->'.padStart(3)} ${String(gd).padStart(6)}   ${f.faces - f.dissolved} of ${f.faces} -> ${gf}`);
  }
  console.log(`  SCORE ${base.t.toFixed(1)} -> ${after.t.toFixed(1)}    DRAWN ${base.d.toFixed(1)} -> ${after.d.toFixed(1)}`);
  const held = base.planeN === after.planeN && base.planeMag === after.planeMag;
  console.log(`  TILE PLANE ${base.planeN}/${base.planeMag} -> ${after.planeN}/${after.planeMag}  ${held ? 'HELD — no ground moved; SCORE falls only because 17 woods drop below the detector\'s own LANDUSE_UNCOVERED half-gate and stop being reported' : '*** MOVED — this is a repair, not a repaint ***'}`);
  if (!held) process.exitCode = 1;
  console.log('');
}
