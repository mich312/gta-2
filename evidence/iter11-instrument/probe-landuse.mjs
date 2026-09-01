// Size the land-use boundary before choosing `landuse-staircase`'s gates and
// magnitude, and check the same measure against the COASTLINE — the control
// that refuted the final review's first probe.
//
//   node evidence/iter11-instrument/probe-landuse.mjs
import { readFileSync } from 'node:fs';
import {
  decodeBakedCity,
  shoreChains,
  buildDeckCut,
  deriveBevels,
  BEV_NONE,
  T_WATER,
  T_TREES,
  T_SAND,
  T_FIELD,
  T_PARK,
} from '../../shared/dist/index.js';

const s = readFileSync('shared/src/world/city.data.ts', 'utf8');
const a = s.indexOf('"');
const b = s.lastIndexOf('"');
const city = decodeBakedCity(JSON.parse(JSON.parse(s.slice(a, b + 1))));
const W = city.widthTiles;
const H = city.heightTiles;
const t = city.tiles;
const at = (x, y) => (x < 0 || y < 0 || x >= W || y >= H ? T_WATER : t[y * W + x]);

const coast = shoreChains(city.shores, W, H);
const band = shoreChains(city.banks, W, H);
const deck = buildDeckCut(t, W, H, city.courses);
const bev = deriveBevels(t, W, H);
const onCurve = (x, y) => {
  const i = y * W + x;
  return coast.has(i) || band.has(i) || deck.has(i);
};
const beveled = (x, y) => bev[y * W + x] !== BEV_NONE;

function census(inside, outside, label) {
  const dirs = [
    [0, -1],
    [0, 1],
    [-1, 0],
    [1, 0],
  ];
  let faces = 0;
  let curved = 0;
  let bevelled = 0;
  let both = 0;
  const runs = [];
  // horizontal runs (N and S faces) walk x; vertical runs (W and E) walk y
  for (const [dx, dy] of dirs) {
    const alongX = dx === 0;
    const outer = alongX ? H : W;
    const inner = alongX ? W : H;
    for (let u = 0; u < outer; u++) {
      let run = 0;
      for (let v = 0; v < inner; v++) {
        const x = alongX ? v : u;
        const y = alongX ? u : v;
        const on = inside(at(x, y)) && outside(at(x + dx, y + dy));
        if (on) {
          run++;
          faces++;
          const c = onCurve(x, y) || onCurve(x + dx, y + dy);
          const bv = beveled(x, y) || beveled(x + dx, y + dy);
          if (c) curved++;
          if (bv) bevelled++;
          if (c || bv) both++;
        } else {
          if (run > 0) runs.push(run);
          run = 0;
        }
      }
      if (run > 0) runs.push(run);
    }
  }
  const sumL = runs.filter((r) => r >= 2).reduce((s, r) => s + r, 0);
  const sumL1 = runs.filter((r) => r >= 2).reduce((s, r) => s + r - 1, 0);
  const sum3 = runs.filter((r) => r >= 3).reduce((s, r) => s + r, 0);
  console.log(
    `${label.padEnd(30)} faces ${String(faces).padStart(6)}  on a curve ${String(curved).padStart(6)}` +
      `  bevelled ${String(bevelled).padStart(6)}  either ${String(both).padStart(6)}` +
      `  runs ${String(runs.length).padStart(5)}  sum(L>=2) ${String(sumL).padStart(6)}` +
      `  sum(L-1) ${String(sumL1).padStart(6)}  sum(L>=3) ${String(sum3).padStart(6)}`,
  );
}

const wood = (v) => v === T_TREES;
const open = (v) => v === T_FIELD || v === T_PARK || v === T_SAND;
const land = (v) => v !== T_WATER;

console.log('');
census(wood, open, 'woodland vs open ground');
census(land, (v) => v === T_WATER, 'CONTROL: coastline');
census((v) => v === T_SAND, (v) => v === T_FIELD || v === T_PARK, 'CONTROL: shore band inner edge');
console.log('');
