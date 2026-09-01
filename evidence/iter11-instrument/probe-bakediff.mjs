// What actually changed between two bakes, tile by tile.
//
// `landuse-staircase` reads 2681 tiles on `cda745a` and 2708 on `bb0aaae`,
// while the 20-signature instrument reads both at TOTAL 48 / SCORE 2653.8 /
// DRAWN 2522.5 and iteration 10 confirmed "not one road tile moved anywhere".
// Both can be true. This says which tiles moved.
//
//   node evidence/iter11-instrument/probe-bakediff.mjs /tmp/a.ts /tmp/b.ts
import { readFileSync } from 'node:fs';
import { decodeBakedCity } from '../../shared/dist/index.js';

const NAMES = [
  'field',
  'road',
  'sidewalk',
  'building',
  'park',
  'lot',
  'water',
  'bridge',
  'ramp',
  'floor',
  'bank',
  'trees',
  'sand',
  'runway',
];

const load = (p) => {
  const s = readFileSync(p, 'utf8');
  const a = s.indexOf('"');
  const b = s.lastIndexOf('"');
  return decodeBakedCity(JSON.parse(JSON.parse(s.slice(a, b + 1))));
};

const [pa, pb] = process.argv.slice(2);
const A = load(pa);
const B = load(pb);
if (A.tiles.length !== B.tiles.length) throw new Error('different map sizes');
const moved = new Map();
let n = 0;
let x0 = 1e9;
let y0 = 1e9;
let x1 = -1;
let y1 = -1;
for (let i = 0; i < A.tiles.length; i++) {
  if (A.tiles[i] === B.tiles[i]) continue;
  n++;
  const k = `${NAMES[A.tiles[i]]} -> ${NAMES[B.tiles[i]]}`;
  moved.set(k, (moved.get(k) ?? 0) + 1);
  const x = i % A.widthTiles;
  const y = (i - x) / A.widthTiles;
  if (x < x0) x0 = x;
  if (x > x1) x1 = x;
  if (y < y0) y0 = y;
  if (y > y1) y1 = y;
}
console.log(`${pa}\n${pb}\n${n} tiles differ, bbox ${x0},${y0}..${x1},${y1}`);
for (const [k, v] of [...moved].sort((p, q) => q[1] - p[1])) {
  console.log(`  ${String(v).padStart(6)}  ${k}`);
}
console.log(`courses ${A.courses.length} -> ${B.courses.length}, blocks ${A.blocks.length} -> ${B.blocks.length}`);
