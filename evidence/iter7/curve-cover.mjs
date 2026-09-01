// Does the curve layer cover the LANDWARD staircase too?
//
// `builtStaircase` only counts a step face when the tile just outside the
// outline is open water, so for the nine findings whose far side is dry it
// counts zero faces and reports "drawn as it lies" WITHOUT ever asking the
// curve layer.  This asks it: for every profile position of every one of the
// 24 edges, is the outline tile or its outward neighbour on the coast chain,
// on the band chain, or on neither.
//
//   node evidence/iter7/curve-cover.mjs
import { loadBake, NEW, S } from './lib.mjs';

const { shoreChains, T_BANK, T_BRIDGE, T_LOT, T_RUNWAY, T_WATER } = S;
const NAME = Object.fromEntries(
  Object.entries(S)
    .filter(([k]) => k.startsWith('T_'))
    .map(([k, v]) => [v, k.slice(2)]),
);

const city = loadBake(process.argv[2] ?? NEW);
const W = city.widthTiles;
const H = city.heightTiles;
const tiles = city.tiles;
const at = (x, y) => (x < 0 || y < 0 || x >= W || y >= H ? T_WATER : tiles[y * W + x]);

const coast = shoreChains(city.shores, W, H);
const band = shoreChains(city.banks, W, H);

function components(mask) {
  const seen = new Uint8Array(W * H);
  const out = [];
  const st = new Int32Array(W * H);
  for (let i = 0; i < W * H; i++) {
    if (mask[i] !== 1 || seen[i]) continue;
    let n = 0;
    st[n++] = i;
    seen[i] = 1;
    const bag = [];
    while (n > 0) {
      const j = st[--n];
      bag.push(j);
      const x = j % W;
      const y = (j / W) | 0;
      for (const [nx, ny] of [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]]) {
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const k = ny * W + nx;
        if (mask[k] === 1 && !seen[k]) { seen[k] = 1; st[n++] = k; }
      }
    }
    out.push(bag);
  }
  return out;
}
function bbox(bag) {
  let x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1;
  for (const i of bag) {
    const x = i % W, y = (i / W) | 0;
    if (x < x0) x0 = x; if (x > x1) x1 = x;
    if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  return { x0, y0, x1, y1 };
}

const minSpan = 16;
const found = [];
for (const [kind, label] of [[T_BRIDGE, 'bridge deck'], [T_BANK, 'quay'], [T_LOT, 'yard'], [T_RUNWAY, 'runway']]) {
  const mask = new Uint8Array(W * H);
  for (let i = 0; i < tiles.length; i++) mask[i] = tiles[i] === kind ? 1 : 0;
  for (const bag of components(mask)) {
    if (bag.length < 60) continue;
    const b = bbox(bag);
    const inBag = new Set(bag);
    for (const byColumn of [true, false]) {
      const n = byColumn ? b.x1 - b.x0 + 1 : b.y1 - b.y0 + 1;
      const m = byColumn ? b.y1 - b.y0 + 1 : b.x1 - b.x0 + 1;
      if (n < minSpan) continue;
      for (const side of [0, 1]) {
        const prof = new Int32Array(n).fill(-1);
        for (let p = 0; p < n; p++) {
          for (let q = 0; q < m; q++) {
            const qq = side === 0 ? q : m - 1 - q;
            const x = byColumn ? b.x0 + p : b.x0 + qq;
            const y = byColumn ? b.y0 + qq : b.y0 + p;
            if (inBag.has(y * W + x)) { prof[p] = byColumn ? y : x; break; }
          }
        }
        const treads = [];
        let p = 0;
        while (p < n) {
          if (prof[p] < 0) { p++; continue; }
          let e = p;
          while (e < n && prof[e] === prof[p]) e++;
          treads.push({ at: p, len: e - p, v: prof[p] });
          p = e;
        }
        let i = 0;
        while (i < treads.length) {
          let j = i, dir = 0;
          while (j + 1 < treads.length) {
            const t0 = treads[j], t1 = treads[j + 1];
            if (t1.at !== t0.at + t0.len) break;
            if (t0.len < 2 || t0.len > 10 || t1.len < 2 || t1.len > 10) break;
            const step = t1.v - t0.v;
            if (Math.abs(step) !== 1) break;
            if (dir === 0) dir = step; else if (step !== dir) break;
            j++;
          }
          const first = treads[i], last = treads[j];
          const span = last.at + last.len - first.at, count = j - i + 1;
          if (count >= 4 && span >= minSpan) {
            // EVERY profile position, whatever the far side is made of.
            let pos = 0, onCoast = 0, onBand = 0, onNeither = 0;
            const far = {};
            for (let q = first.at; q < first.at + span; q++) {
              const v = prof[q];
              if (v < 0) continue;
              const st = side === 0 ? -1 : 1;
              const x = byColumn ? b.x0 + q : v;
              const y = byColumn ? v : b.y0 + q;
              const ox = byColumn ? x : x + st;
              const oy = byColumn ? y + st : y;
              pos++;
              const ft = at(ox, oy);
              far[NAME[ft] ?? ft] = (far[NAME[ft] ?? ft] || 0) + 1;
              const c = coast.has(y * W + x) || coast.has(oy * W + ox);
              const bd = band.has(y * W + x) || band.has(oy * W + ox);
              if (c) onCoast++; else if (bd) onBand++; else onNeither++;
            }
            const meanTread = span / count;
            const midP = first.at + span / 2;
            const mx = byColumn ? b.x0 + midP : (first.v + last.v) / 2;
            const my = byColumn ? (first.v + last.v) / 2 : b.y0 + midP;
            found.push({ label, mx, my, span, count, meanTread, rank: span * meanTread,
              mag: span - count, pos, onCoast, onBand, onNeither, far });
          }
          i = j + 1;
        }
      }
    }
  }
}
found.sort((p, q) => q.rank - p.rank);
const kept = [];
for (const f of found) {
  if (kept.some((k) => Math.abs(k.mx - f.mx) <= 12 && Math.abs(k.my - f.my) <= 12)) continue;
  kept.push(f);
}
console.log('Every profile position of all 24 edges, against BOTH curve layers.');
console.log('"bare" = on no chain at all, so nothing repaints it: the drawn staircase.\n');
let i = 0;
for (const f of kept) {
  i++;
  const far = Object.entries(f.far).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}:${v}`).join(' ');
  console.log(
    `${String(i).padStart(2)} ${f.label.padEnd(12)} ${String(Math.round(f.mx)).padStart(3)},${String(Math.round(f.my)).padEnd(3)}` +
    ` m=${String(f.mag).padStart(3)} tread=${f.meanTread.toFixed(1)}` +
    ` | positions=${String(f.pos).padStart(3)} coast=${String(f.onCoast).padStart(3)}` +
    ` band=${String(f.onBand).padStart(3)} bare=${String(f.onNeither).padStart(3)}` +
    ` | far: ${far}`);
}
const s = (k) => kept.reduce((a, f) => a + f[k], 0);
console.log(`\nTOTALS m=${s('mag')} positions=${s('pos')} coast=${s('onCoast')} band=${s('onBand')} bare=${s('onNeither')}`);
