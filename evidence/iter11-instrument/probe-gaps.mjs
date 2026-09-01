// Probe: the authored-course gaps, computed independently of `cityCheck.ts`,
// so the new `course-unbuilt` signature can be checked against the bake's own
// six warnings rather than against itself.
//
//   node evidence/iter11-instrument/probe-gaps.mjs
import { readFileSync } from 'node:fs';
import {
  CITY_DATA,
  decodeBakedCity,
  parseCityPlan,
  roadCourses,
  T_ROAD,
  T_BRIDGE,
  T_RAMP,
  T_WATER,
} from '../../shared/dist/index.js';

const city = decodeBakedCity(JSON.parse(CITY_DATA));
const plan = parseCityPlan(JSON.parse(readFileSync('shared/data/city-plan.json', 'utf8')));
const W = city.widthTiles;
const H = city.heightTiles;
const tiles = city.tiles;
const at = (x, y) => (x < 0 || y < 0 || x >= W || y >= H ? T_WATER : tiles[y * W + x]);

// How far the nearest carriageway is from any tile, in 4-connected steps.
// This is the measurement behind `course-unbuilt`'s `road.bridges` gate: the
// six warned spans are far from any tarmac, and Vasco Avenue's 6-tile gap —
// the only thing the gate excludes on this bake — has the avenue running on
// beside it. Asserted nowhere; measured here.
const dist = new Int32Array(W * H).fill(-1);
{
  const q = [];
  for (let i = 0; i < tiles.length; i++) {
    const t = tiles[i];
    if (t === T_ROAD || t === T_BRIDGE || t === T_RAMP) {
      dist[i] = 0;
      q.push(i);
    }
  }
  for (let k = 0; k < q.length; k++) {
    const i = q[k];
    const x = i % W;
    const y = (i - x) / W;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      const j = ny * W + nx;
      if (dist[j] >= 0) continue;
      dist[j] = dist[i] + 1;
      q.push(j);
    }
  }
}
const nearestRoad = (x, y) => {
  const cx = Math.min(W - 1, Math.max(0, Math.round(x)));
  const cy = Math.min(H - 1, Math.max(0, Math.round(y)));
  return dist[cy * W + cx];
};

let total = 0;
for (const road of plan.roads) {
  const half = road.width / 2;
  for (const course of roadCourses(road)) {
    const built = (x, y, nx, ny) => {
      for (let s = -half; s <= half; s += 0.5) {
        const t = at(Math.round(x + nx * s), Math.round(y + ny * s));
        if (t === T_ROAD || t === T_BRIDGE) return true;
      }
      return false;
    };
    let gap = null;
    const gaps = [];
    let sampled = 0;
    for (let k = 0; k + 1 < course.length; k++) {
      const [ax, ay] = course[k];
      const [bx, by] = course[k + 1];
      const len = Math.hypot(bx - ax, by - ay);
      if (len === 0) continue;
      const nx = -(by - ay) / len;
      const ny = (bx - ax) / len;
      const steps = Math.max(1, Math.ceil(len * 2));
      for (let s = 0; s <= steps; s++) {
        const t = s / steps;
        const x = ax + (bx - ax) * t;
        const y = ay + (by - ay) * t;
        sampled++;
        if (built(x, y, nx, ny)) {
          gap = null;
          continue;
        }
        if (gap === null) {
          gap = { x0: Math.round(x), y0: Math.round(y), x1: 0, y1: 0, len: 0, deep: 0 };
          gaps.push(gap);
        }
        gap.x1 = Math.round(x);
        gap.y1 = Math.round(y);
        gap.len += len / steps;
        const d = nearestRoad(x, y);
        if (d > gap.deep) gap.deep = d;
      }
    }
    for (const g of gaps) {
      if (g.len <= road.width) continue;
      total += Math.round(g.len);
      console.log(
        `${road.name.padEnd(16)} ${g.len.toFixed(0).padStart(4)} tiles  ${g.x0},${g.y0} -> ${g.x1},${g.y1}` +
          `  bridges=${road.bridges} width=${road.width}` +
          `  furthest point from any carriageway: ${g.deep} tiles`,
      );
    }
  }
}
console.log(`total ${total} tiles of authored course with no carriageway`);
