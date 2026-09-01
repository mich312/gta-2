// Exactly why each of the five fires: the course's real points, the ray
// `tarmacBeyond` marches, and how far the tarmac actually goes if you follow the
// STREET instead of the ray.
//
// `street-serves-nothing` gates on two things, and both are asked of the COURSE
// record rather than of the ground:
//   met()          — no OTHER COURSE centreline within 2 tiles of the endpoint
//   tarmacBeyond() — no carriageway more than `capReach` tiles along the
//                    STRAIGHT extension of the last segment
// This prints both, next to the direction the tarmac actually continues in, so
// the difference between "the street stops" and "the ray left the street" is on
// the page rather than in an argument.
//
//   pnpm build && node evidence/iter12-streets/why-it-fires.mjs
import { S, loadBake, NEW } from '../iter10/lib.mjs';
const { T_ROAD, T_BRIDGE, T_RAMP } = S;
const city = loadBake(NEW);
const W = city.widthTiles, H = city.heightTiles, tiles = city.tiles;
const isRoad = (t) => t === T_ROAD || t === T_BRIDGE || t === T_RAMP;
const at = (x, y) => (x < 0 || y < 0 || x >= W || y >= H ? -1 : tiles[y * W + x]);
const roads = city.courses.map((c, i) => ({ ...c, i })).filter((c) => c.kind !== 'path');

function tarmacBeyond(x, y, dx, dy, half, limit) {
  const px = -dy, py = dx;
  const steps = Math.max(1, Math.round(half * 2));
  for (let s = 1; s <= limit + 1; s++) {
    let any = false;
    for (let k = 0; k <= steps && !any; k++) {
      const off = -half + (k * half * 2) / steps;
      if (isRoad(at(Math.floor(x + dx * s + px * off), Math.floor(y + dy * s + py * off)))) any = true;
    }
    if (!any) return s - 1;
  }
  return Infinity;
}

/**
 * The same march, but free to turn up to 60 degrees a step: at each step take the
 * straightest heading that still stands on carriageway. This is what "does the
 * street continue" means when the street is not straight.
 *
 * IT REPORTS NET DISPLACEMENT, NOT STEPS, AND MAY NOT REVISIT A TILE. The first
 * version returned steps and did neither, and with 60-degree turns and unit steps
 * it can circle inside a one-tile radius forever — "40 of 40" from a march that
 * never left the end cap. That is exactly the shape of instrument this exercise
 * has been caught by eleven times, so: no revisiting, and the number returned is
 * how far from the endpoint it actually GOT.
 */
function tarmacFollowing(x, y, dx, dy, half, limit) {
  let cx = x, cy = y, cdx = dx, cdy = dy;
  const seen = new Set();
  const onRoad = (ax, ay, bdx, bdy) => {
    const qx = -bdy, qy = bdx;
    const steps = Math.max(1, Math.round(half * 2));
    for (let k = 0; k <= steps; k++) {
      const off = -half + (k * half * 2) / steps;
      if (isRoad(at(Math.floor(ax + qx * off), Math.floor(ay + qy * off)))) return true;
    }
    return false;
  };
  let far = 0;
  for (let s = 1; s <= limit; s++) {
    let moved = false;
    for (const ang of [0, Math.PI / 6, -Math.PI / 6, Math.PI / 3, -Math.PI / 3]) {
      const ndx = cdx * Math.cos(ang) - cdy * Math.sin(ang);
      const ndy = cdx * Math.sin(ang) + cdy * Math.cos(ang);
      const nx = cx + ndx, ny = cy + ndy;
      const key = `${Math.floor(nx)},${Math.floor(ny)}`;
      if (seen.has(key) || !onRoad(nx, ny, ndx, ndy)) continue;
      seen.add(key);
      cx = nx; cy = ny; cdx = ndx; cdy = ndy; moved = true;
      far = Math.max(far, Math.hypot(cx - x, cy - y));
      break;
    }
    if (!moved) break;
  }
  return +far.toFixed(1);
}

for (const i of [129, 163, 272, 298, 332, 362]) {
  const c = roads.find((r) => r.i === i);
  const p0 = c.points[0], p1 = c.points[1];
  const q1 = c.points[c.points.length - 1], q0 = c.points[c.points.length - 2];
  const n0 = Math.hypot(p0[0] - p1[0], p0[1] - p1[1]) || 1;
  const n1 = Math.hypot(q1[0] - q0[0], q1[1] - q0[1]) || 1;
  const d0 = [(p0[0] - p1[0]) / n0, (p0[1] - p1[1]) / n0];
  const d1 = [(q1[0] - q0[0]) / n1, (q1[1] - q0[1]) / n1];
  const half = c.width / 2;
  console.log(`#${i} width ${c.width} ${c.kind}, ${c.points.length} points`);
  console.log(`   points: ${c.points.map(([x, y]) => `${x.toFixed(2)},${y.toFixed(2)}`).join('  ')}`);
  console.log(`   END A ${p0[0].toFixed(2)},${p0[1].toFixed(2)} ray ${d0[0].toFixed(2)},${d0[1].toFixed(2)}`);
  console.log(`         straight ray reaches ${tarmacBeyond(p0[0], p0[1], d0[0], d0[1], half, 3)} tiles (gate: <=3 fires)`);
  console.log(`         FOLLOWING the tarmac gets ${tarmacFollowing(p0[0], p0[1], d0[0], d0[1], half, 120)} tiles AWAY from the endpoint`);
  console.log(`   END B ${q1[0].toFixed(2)},${q1[1].toFixed(2)} ray ${d1[0].toFixed(2)},${d1[1].toFixed(2)}`);
  console.log(`         straight ray reaches ${tarmacBeyond(q1[0], q1[1], d1[0], d1[1], half, 3)} tiles (gate: <=3 fires)`);
  console.log(`         FOLLOWING the tarmac gets ${tarmacFollowing(q1[0], q1[1], d1[0], d1[1], half, 120)} tiles AWAY from the endpoint`);
  console.log('');
}
