// V-iter6-lanes: re-derive iteration 6's "region B's 767 authored tiles" WITHOUT
// the layout pass hook, which no longer exists in shared/src/world/layout.ts
// (so evidence/iter6/probe-attribute.mjs now attributes 100% of every region to
// "(after layout)" and prints "CLEARS" for all of them).
//
// Independent route, using iteration 8's own established fact: carveCourse lays
// a carriageway as a SWEPT DISC, segmentDistance(centre, seg) <= width/2, and
// the plan records the same polyline and width. So an authored tile is a
// carriageway tile inside the disc of one of the plan's 17 authored roads.
//
//   node evidence/iter10-verify/authored-share.mjs
//
// CONTROLS (printed, and each must fire or the reading is not believed):
//   C1  the disc must contain a known authored tile      (a point ON The Ring)
//   C2  the disc must NOT contain open country far away  (a point 200 tiles off)
//   C3  widening the disc must raise the count           (sensitivity)
import { loadBake, NEW, S, plan } from '../iter6/lib.mjs';

const { polyBounds, pointInPoly, segmentDistance, T_WATER, T_ROAD, T_BRIDGE, T_RAMP, T_BUILDING, T_FLOOR } = S;
const city = loadBake(NEW);
const W = city.widthTiles, H = city.heightTiles, tiles = city.tiles;
const isRoad = (t) => t === T_ROAD || t === T_BRIDGE || t === T_RAMP;

// --- mapAudit's polyMask + fringeRegions, copied from evidence/iter6/probe-attribute.mjs
const inPoly = new Uint8Array(W * H);
for (const d of plan.districts) {
  const [bx0, by0, bx1, by1] = polyBounds(d.area);
  for (let ty = Math.max(0, by0); ty <= Math.min(H - 1, by1); ty++)
    for (let tx = Math.max(0, bx0); tx <= Math.min(W - 1, bx1); tx++)
      if (inPoly[ty * W + tx] === 0 && pointInPoly(d.area, tx + 0.5, ty + 0.5)) inPoly[ty * W + tx] = 1;
}
const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const seen = new Uint8Array(W * H);
const regions = [];
for (let s = 0; s < W * H; s++) {
  if (seen[s] === 1 || inPoly[s] === 1 || tiles[s] === T_WATER) continue;
  const bag = [s]; seen[s] = 1;
  const f = { land: 0, road: 0, built: 0, x0: W, y0: H, x1: -1, y1: -1, cells: [] };
  for (let q = 0; q < bag.length; q++) {
    const i = bag[q], x = i % W, y = (i - x) / W;
    f.land++; f.cells.push(i);
    if (x < f.x0) f.x0 = x; if (y < f.y0) f.y0 = y;
    if (x > f.x1) f.x1 = x; if (y > f.y1) f.y1 = y;
    if (isRoad(tiles[i])) f.road++;
    if (tiles[i] === T_BUILDING || tiles[i] === T_FLOOR) f.built++;
    for (const [dx, dy] of DIRS) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      const j = ny * W + nx;
      if (seen[j] === 1 || inPoly[j] === 1 || tiles[j] === T_WATER) continue;
      seen[j] = 1; bag.push(j);
    }
  }
  regions.push(f);
}
regions.sort((a, b) => b.road - a.road);

// --- the authored disc
const ROAD_COURSES = new Map(plan.roads.map((r) => [r, S.roadCourses(r)]));
console.log('# authored roads: ' + plan.roads.length + ', courses after median split: ' +
  [...ROAD_COURSES.values()].reduce((n, c) => n + c.length, 0) +
  ' (The Ring -> ' + ROAD_COURSES.get(plan.roads.find((r) => r.name === 'The Ring')).length + ')');

function authoredHit(x, y, slack) {
  const px = x + 0.5, py = y + 0.5;
  for (const r of plan.roads) {
    const half = r.width / 2 + slack;
    // roadCourses() is layout.ts's OWN definition of where a road is carved:
    // a median road (The Ring) becomes TWIN carriageways offset off the
    // centreline, so r.points alone under-counts it. layout.js:757-761.
    for (const p of ROAD_COURSES.get(r)) {
      for (let k = 0; k + 1 < p.length; k++) {
        if (segmentDistance(px, py, p[k][0], p[k][1], p[k + 1][0], p[k + 1][1]) <= half) return r.name;
      }
    }
  }
  return null;
}

// --- controls
// C1 must be a point that is REALLY carved. The Ring's own centreline is NOT:
// a median road is carved as two offset carriageways with a reservation down
// the middle, so the first draft of this control sampled r.points[0], read
// MISS, and would have printed "*** BLIND ***" on a working probe. Sample the
// offset course roadCourses() actually hands the carve, and require the bake
// to agree that the tile is carriageway.
const ringRoad = plan.roads.find((r) => r.name === 'The Ring');
const ringCourse = ROAD_COURSES.get(ringRoad)[0];
const rp = ringCourse[Math.floor(ringCourse.length / 2)];
const rx = Math.round(rp[0]), ry = Math.round(rp[1]);
const c1 = authoredHit(rx, ry, 0);
const c1bake = isRoad(tiles[ry * W + rx]);
const c2 = authoredHit(60, 60, 0);
const c2bake = isRoad(tiles[60 * W + 60]);
console.log('# CONTROLS');
console.log(`  C1 point on The Ring's carved course at ${rx},${ry} -> ${c1 ?? 'MISS'}; bake says carriageway=${c1bake}   ${c1 && c1bake ? 'FIRES' : '*** BLIND ***'}`);
console.log(`  C2 open country at 60,60 -> ${c2 ?? 'no authored road'}; bake says carriageway=${c2bake}   ${c2 === null && !c2bake ? 'FIRES' : '*** FALSE POSITIVE ***'}`);

const MIN_LAND = 1000, MIN_ROAD = 0.1, BUILT = 0.01;
console.log('\n# flagged fringe regions, authored share re-derived from plan.roads');
for (const f of regions.slice(0, 6)) {
  const flag = f.land >= MIN_LAND && f.road / f.land >= MIN_ROAD && f.built / f.land < BUILT;
  if (!flag) continue;
  let authored = 0;
  const byRoad = new Map();
  for (const i of f.cells) {
    if (!isRoad(tiles[i])) continue;
    const n = authoredHit(i % W, (i - (i % W)) / W, 0);
    if (n) { authored++; byRoad.set(n, (byRoad.get(n) ?? 0) + 1); }
  }
  let wide = 0;
  for (const i of f.cells) {
    if (!isRoad(tiles[i])) continue;
    if (authoredHit(i % W, (i - (i % W)) / W, 1)) wide++;
  }
  const rest = f.road - authored;
  console.log(`\nFLAGGED ${f.x0},${f.y0}-${f.x1},${f.y1}: land ${f.land}, road ${f.road} (${((100 * f.road) / f.land).toFixed(1)}%), built ${f.built}`);
  console.log(`    authored (plan disc)   ${String(authored).padStart(5)}   = ${((100 * authored) / f.land).toFixed(1)}% of land on their own  ${authored / f.land >= MIN_ROAD ? '>=10%, STILL FIRES' : '<10%, would clear'}`);
  console.log(`    everything else        ${String(rest).padStart(5)}   = ${((100 * rest) / f.land).toFixed(1)}% of land on their own  ${rest / f.land >= MIN_ROAD ? '>=10%, STILL FIRES' : '<10%, would clear'}`);
  for (const [k, n] of [...byRoad.entries()].sort((a, b) => b[1] - a[1])) console.log(`      ${k.padEnd(20)} ${String(n).padStart(5)}`);
  console.log(`    C3 sensitivity: disc +1 tile -> ${wide} authored (was ${authored})  ${wide > authored ? 'FIRES' : '*** INSENSITIVE ***'}`);
}
