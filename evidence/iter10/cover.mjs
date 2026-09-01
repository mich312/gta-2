// How much carriageway is drawn by the RIBBON painter, and how much by the
// per-tile painter — and where the two meet at the end of a street.
//
// `TileRenderer.indexCourses` (client/src/render/tiles.ts:461) sweeps every
// baked course into `courseCover` at radius width/2 + 0.55. A road tile inside
// it is drawn as a smooth ribbon with kerb casing, edge line and centre dash.
// A road tile OUTSIDE it gets the per-tile painter: flat asphalt, no kerb, no
// markings, rasterised staircase edges. layout.ts:1205 already names this —
// "the quarter of the city's roads the ribbon painter cannot reach".
//
// The shape that matters for `road-deadend` is a TONGUE: a run of uncovered
// carriageway hanging off the END of a covered ribbon, so the street is drawn
// finishing in a kerbed turning head and then bare tarmac carries on past it.
//
// CONTROLS
//   1. an authored avenue must read ~0% uncovered (else the sweep is wrong);
//   2. the sweep radius must matter — 0.55 vs a deliberately tiny radius must
//      give different answers (else the measure is not reading the courses);
//   3. the four road-deadend caps are named, so their covered/uncovered state
//      is reported rather than assumed.
//
//   node evidence/iter10/cover.mjs
import { S, loadBake, NEW } from './lib.mjs';
const { T_ROAD, T_BRIDGE, T_RAMP } = S;

const city = loadBake(NEW);
const W = city.widthTiles;
const H = city.heightTiles;
const tiles = city.tiles;
const isRoad = (t) => t === T_ROAD || t === T_BRIDGE || t === T_RAMP;

function buildCover(extra) {
  const cover = new Uint8Array(W * H);
  for (const c of city.courses) {
    if (c.kind === 'path') continue;
    const half = c.width / 2 + extra;
    for (let k = 0; k + 1 < c.points.length; k++) {
      const [ax, ay] = c.points[k];
      const [bx, by] = c.points[k + 1];
      const x0 = Math.max(0, Math.floor(Math.min(ax, bx) - half - 1));
      const x1 = Math.min(W - 1, Math.ceil(Math.max(ax, bx) + half + 1));
      const y0 = Math.max(0, Math.floor(Math.min(ay, by) - half - 1));
      const y1 = Math.min(H - 1, Math.ceil(Math.max(ay, by) + half + 1));
      const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
      for (let ty = y0; ty <= y1; ty++)
        for (let tx = x0; tx <= x1; tx++) {
          if (cover[ty * W + tx]) continue;
          let t = l2 === 0 ? 0 : ((tx + 0.5 - ax) * dx + (ty + 0.5 - ay) * dy) / l2;
          t = t < 0 ? 0 : t > 1 ? 1 : t;
          if (Math.hypot(ax + dx * t - tx - 0.5, ay + dy * t - ty - 0.5) <= half) cover[ty * W + tx] = 1;
        }
    }
  }
  return cover;
}

const cover = buildCover(0.55);
let road = 0, covered = 0;
for (let i = 0; i < W * H; i++) if (isRoad(tiles[i])) { road++; if (cover[i]) covered++; }
console.log('=== city-wide carriageway cover ===');
console.log(`  carriageway tiles          ${road}`);
console.log(`  drawn by the RIBBON        ${covered}  (${((covered / road) * 100).toFixed(1)}%)`);
console.log(`  drawn per-tile, NO ribbon  ${road - covered}  (${(((road - covered) / road) * 100).toFixed(1)}%)`);

/* CONTROL 2 — the radius has to matter */
const tiny = buildCover(-1.4);
let cTiny = 0;
for (let i = 0; i < W * H; i++) if (isRoad(tiles[i]) && tiny[i]) cTiny++;
console.log(`  CONTROL 2 — same sweep at radius width/2-1.4: ${cTiny} covered ` +
  `(${cTiny === covered ? 'IDENTICAL — the measure is not reading the courses' : 'differs, so the sweep is live'})`);

/* ---- uncovered components, and which are TONGUES -------------------- */
const seen = new Uint8Array(W * H);
const comps = [];
for (let s = 0; s < W * H; s++) {
  if (seen[s] || !isRoad(tiles[s]) || cover[s]) continue;
  const bag = [s];
  seen[s] = 1;
  let touchesCovered = 0;
  let x0 = W, y0 = H, x1 = -1, y1 = -1;
  for (let q = 0; q < bag.length; q++) {
    const i = bag[q], x = i % W, y = (i - x) / W;
    if (x < x0) x0 = x; if (x > x1) x1 = x;
    if (y < y0) y0 = y; if (y > y1) y1 = y;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      const j = ny * W + nx;
      if (!isRoad(tiles[j])) continue;
      if (cover[j]) { touchesCovered++; continue; }
      if (seen[j]) continue;
      seen[j] = 1; bag.push(j);
    }
  }
  comps.push({ n: bag.length, touchesCovered, x0, y0, x1, y1, cells: bag });
}
comps.sort((a, b) => b.n - a.n);
const tongues = comps.filter((c) => c.touchesCovered > 0);
const islands = comps.filter((c) => c.touchesCovered === 0);
console.log('\n=== uncovered carriageway, as connected runs ===');
console.log(`  runs of bare carriageway            ${comps.length}`);
console.log(`  TONGUES  (touch a ribbon, so a kerbed road visibly turns into bare tarmac)  ${tongues.length}, ${tongues.reduce((s, c) => s + c.n, 0)} tiles`);
console.log(`  ISLANDS  (no ribbon anywhere on them)                                       ${islands.length}, ${islands.reduce((s, c) => s + c.n, 0)} tiles`);
console.log('\n  ten largest runs:');
for (const c of comps.slice(0, 10))
  console.log(`    ${String(c.n).padStart(5)} tiles  [${c.x0},${c.y0}-${c.x1},${c.y1}]  ${c.touchesCovered > 0 ? 'TONGUE' : 'island'}`);

/* ---- CONTROL 1 + the four deadend caps ------------------------------ */
console.log('\n=== CONTROL 1 — the four authored ring/avenue courses must be ~fully covered ===');
for (const c of city.courses.filter((x) => x.kind === 'ring').slice(0, 4)) {
  let n = 0, cv = 0;
  const half = c.width / 2 + 0.55;
  for (let k = 0; k + 1 < c.points.length; k++) {
    const [ax, ay] = c.points[k];
    for (let o = -1; o <= 1; o++) {
      const tx = Math.floor(ax + o), ty = Math.floor(ay);
      if (tx < 0 || ty < 0 || tx >= W || ty >= H) continue;
      if (isRoad(tiles[ty * W + tx])) { n++; if (cover[ty * W + tx]) cv++; }
    }
  }
  console.log(`  ring course: ${cv}/${n} sampled tiles covered (${((cv / n) * 100).toFixed(1)}%)`);
}

console.log('\n=== the four road-deadend caps ===');
for (const [x, y, name] of [[415, 672, 'esplanade, Sunridge/Marsh End line'], [321, 327, 'Ravenhill spine'], [478, 600, 'New Suburbs crescent'], [342, 312, 'Ravenhill spine']]) {
  const i = y * W + x;
  const comp = comps.find((c) => c.cells.includes(i));
  console.log(`  ${String(x).padStart(3)},${String(y).padStart(3)} ${name.padEnd(34)} cap tile ${cover[i] ? 'UNDER a ribbon (drawn kerbed)' : 'BARE — no ribbon'}` +
    (comp ? `  in a ${comp.touchesCovered > 0 ? 'TONGUE' : 'island'} of ${comp.n} tiles [${comp.x0},${comp.y0}-${comp.x1},${comp.y1}]` : ''));
}
