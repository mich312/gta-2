// The list pinned by shared/test/city.test.ts, "keeps the ring limited-access":
// every mouth two tiles or more across whose next tile IS the ring's
// carriageway, outside a nine-tile dilation of the authored junctions.
// Transcribed from the test so the pin can be updated from a measurement
// rather than from a truncated vitest diff, and run on both bakes so a
// vanished entry can be named.
//   node evidence/iter11/probe-ringjoins.mjs <city.data.ts>
import { readFileSync } from 'node:fs';
import {
  decodeBakedCity,
  segmentDistance,
  T_BRIDGE,
  T_RAMP,
  T_ROAD,
} from '../../shared/dist/index.js';

const s = readFileSync(process.argv[2], 'utf8');
const map = decodeBakedCity(JSON.parse(JSON.parse(s.slice(s.indexOf('"'), s.lastIndexOf('"') + 1))));
const W = map.widthTiles;
const H = map.heightTiles;
const courses = map.courses ?? [];

const swept = (kind) => {
  const m = new Uint8Array(W * H);
  for (const c of courses) {
    if (c.kind !== kind) continue;
    const half = c.width / 2;
    for (let k = 0; k + 1 < c.points.length; k++) {
      const [ax, ay] = c.points[k];
      const [bx, by] = c.points[k + 1];
      const x0 = Math.max(0, Math.floor(Math.min(ax, bx) - half - 1));
      const x1 = Math.min(W - 1, Math.ceil(Math.max(ax, bx) + half + 1));
      const y0 = Math.max(0, Math.floor(Math.min(ay, by) - half - 1));
      const y1 = Math.min(H - 1, Math.ceil(Math.max(ay, by) + half + 1));
      for (let ty = y0; ty <= y1; ty++) {
        for (let tx = x0; tx <= x1; tx++) {
          if (segmentDistance(tx + 0.5, ty + 0.5, ax, ay, bx, by) <= half) m[ty * W + tx] = 1;
        }
      }
    }
  }
  return m;
};

const onRing = swept('ring');
const onAvenue = swept('avenue');
const carriageway = (i) => {
  const t = map.tiles[i];
  return t === T_ROAD || t === T_BRIDGE || t === T_RAMP;
};
const ringRoad = new Uint8Array(W * H);
for (let i = 0; i < W * H; i++) if (onRing[i] === 1 && carriageway(i)) ringRoad[i] = 1;

const JUNCTION_REACH = 9;
const junction = new Uint8Array(W * H);
const bag = [];
const depth = new Int32Array(W * H).fill(-1);
for (let i = 0; i < W * H; i++) {
  if (onRing[i] === 1 && onAvenue[i] === 1) {
    junction[i] = 1;
    depth[i] = 0;
    bag.push(i);
  }
}
for (let q = 0; q < bag.length; q++) {
  const i = bag[q];
  if (depth[i] >= JUNCTION_REACH) continue;
  const x = i % W;
  const y = (i - x) / W;
  for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    const nx = x + dx;
    const ny = y + dy;
    if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
    const j = ny * W + nx;
    if (junction[j] === 1) continue;
    junction[j] = 1;
    depth[j] = depth[i] + 1;
    bag.push(j);
  }
}

const joined = [];
let held = 0;
for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
  const px = dy;
  const py = -dx;
  const meets = new Uint8Array(W * H);
  const short = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (ringRoad[i] === 1 || !carriageway(i)) continue;
      const fx = x + dx;
      const fy = y + dy;
      if (fx < 0 || fy < 0 || fx >= W || fy >= H) continue;
      const f = fy * W + fx;
      if (junction[i] !== 1 && ringRoad[f] === 1) meets[i] = 1;
      if (carriageway(f)) continue;
      for (let d = 1; d <= 4; d++) {
        const nx = x + dx * d;
        const ny = y + dy * d;
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) break;
        const j = ny * W + nx;
        if (!carriageway(j)) continue;
        if (ringRoad[j] === 1 && d > 1) short[i] = 1;
        break;
      }
    }
  }
  for (const [flag, sink] of [[meets, joined], [short, null]]) {
    const used = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        if (flag[y * W + x] !== 1 || used[y * W + x] === 1) continue;
        let a0 = 0;
        let a1 = 0;
        while (
          x + px * (a0 - 1) >= 0 &&
          y + py * (a0 - 1) >= 0 &&
          flag[(y + py * (a0 - 1)) * W + (x + px * (a0 - 1))] === 1
        ) a0--;
        while (
          x + px * (a1 + 1) < W &&
          y + py * (a1 + 1) < H &&
          flag[(y + py * (a1 + 1)) * W + (x + px * (a1 + 1))] === 1
        ) a1++;
        for (let k = a0; k <= a1; k++) used[(y + py * k) * W + (x + px * k)] = 1;
        if (a1 - a0 + 1 < 2) continue;
        const cx = Math.round(x + px * ((a0 + a1) / 2));
        const cy = Math.round(y + py * ((a0 + a1) / 2));
        if (sink) sink.push(`${cx},${cy}`);
        else held++;
      }
    }
  }
}
console.log(`${process.argv[2].split('/').pop()}`);
console.log(`  joins outside an authored junction: [${joined.sort().map((j) => `'${j}'`).join(', ')}]`);
console.log(`  mouths held short of the ring: ${held}`);
