/**
 * Sweep measurements, recomputed from the shipped bake (no hard-coded counts).
 *   node evidence/sweep/measure.mjs
 * Measured on 7bbee6f.
 */
import * as S from '../../shared/dist/index.js';
import { loadWorldgenParams } from '../../server/dist/tuning.js';
import { readFileSync } from 'node:fs';

const map = S.generateCity(1, loadWorldgenParams());
const plan = JSON.parse(readFileSync(new URL('../../shared/data/city-plan.json', import.meta.url), 'utf8'));
const W = map.widthTiles, H = map.heightTiles, t = map.tiles;
const isRoad = (i) => t[i] === S.T_ROAD || t[i] === S.T_BRIDGE;

/* --- 1. course coverage of the carriageway, per district ---------------- */
const cov = new Uint8Array(W * H);
for (const c of map.courses) {
  const r = c.width / 2 + 0.9, p = c.points;
  for (let k = 0; k < p.length - 1; k++) {
    const [ax, ay] = p[k], [bx, by] = p[k + 1];
    for (let y = Math.max(0, Math.floor(Math.min(ay, by) - r)); y <= Math.min(H - 1, Math.ceil(Math.max(ay, by) + r)); y++)
      for (let x = Math.max(0, Math.floor(Math.min(ax, bx) - r)); x <= Math.min(W - 1, Math.ceil(Math.max(ax, bx) + r)); x++) {
        const px = x + 0.5, py = y + 0.5, vx = bx - ax, vy = by - ay, L = vx * vx + vy * vy;
        let s = L > 0 ? ((px - ax) * vx + (py - ay) * vy) / L : 0; s = Math.max(0, Math.min(1, s));
        const dx = px - (ax + s * vx), dy = py - (ay + s * vy);
        if (dx * dx + dy * dy <= r * r) cov[y * W + x] = 1;
      }
  }
}
let tot = 0, cvd = 0;
for (let i = 0; i < W * H; i++) if (isRoad(i)) { tot++; if (cov[i]) cvd++; }
console.log(`carriageway ${tot} tiles, course-covered ${cvd} (${(100 * cvd / tot).toFixed(1)}%)`);

const inPoly = (px, py, poly) => { let c = false; for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) { const [xi, yi] = poly[i], [xj, yj] = poly[j]; if (((yi > py) !== (yj > py)) && (px < (xj - xi) * (py - yi) / (yj - yi) + xi)) c = !c; } return c; };
const mid = new Map();
for (const c of map.courses) { const m = c.points[Math.floor(c.points.length / 2)]; for (const d of plan.districts) if (inPoly(m[0], m[1], d.area)) { mid.set(d.name, (mid.get(d.name) ?? 0) + 1); break; } }
console.log('\ndistrict           road  covered  courses');
for (const d of plan.districts) {
  let n = 0, k = 0;
  const xs = d.area.map(p => p[0]), ys = d.area.map(p => p[1]);
  for (let y = Math.max(0, Math.min(...ys)); y <= Math.min(H - 1, Math.max(...ys)); y++)
    for (let x = Math.max(0, Math.min(...xs)); x <= Math.min(W - 1, Math.max(...xs)); x++) {
      const i = y * W + x; if (!isRoad(i) || !inPoly(x + 0.5, y + 0.5, d.area)) continue; n++; if (cov[i]) k++;
    }
  console.log(d.name.padEnd(17), String(n).padStart(6), (n ? (100 * k / n).toFixed(1) + '%' : '-').padStart(7), String(mid.get(d.name) ?? 0).padStart(8));
}

/* --- 2. tread length along the South Sound Bridge deck's north edge ----- */
console.log('\nSouth Sound Bridge, first deck tile per row (tread = the x step):');
for (let y = 470; y <= 484; y++) { let x = 0; for (; x < W; x++) if (t[y * W + x] === S.T_BRIDGE) break; if (x < W) console.log(`  y=${y}  x=${x}`); }
let bev = 0; for (let y = 466; y < 488; y++) for (let x = 155; x < 206; x++) if (map.bevel[y * W + x]) bev++;
console.log(`  bevelled tiles in that box: ${bev}`);

/* --- 3. Gannet Rock: the corridor through the wood --------------------- */
console.log('\nGannet Rock, x=100..118 across the wood (F=field, T=trees, R=runway):');
for (let y = 606; y <= 648; y += 6) {
  let s = `  y=${y} `;
  for (let x = 100; x <= 118; x++) { const v = t[y * W + x]; s += v === S.T_TREES ? 'T' : v === S.T_FIELD ? 'F' : v === S.T_RUNWAY ? 'R' : '?'; }
  console.log(s);
}

/* --- 4. the headland south of The Spine -------------------------------- */
let land = 0, road = 0, bldg = 0;
for (let y = 313; y < 364; y++) for (let x = 440; x < 560; x++) {
  const v = t[y * W + x]; if (v === S.T_WATER || v === S.T_BANK) continue; land++;
  if (v === S.T_ROAD || v === S.T_BRIDGE) road++; if (v === S.T_BUILDING) bldg++;
}
console.log(`\nheadland 440-560 x 313-364: land ${land}, carriageway ${road} (${(100 * road / land).toFixed(1)}%), building tiles ${bldg}`);

/* --- 5. the mid-strait islet ------------------------------------------ */
const isl = map.courses.filter(c => c.points.every(p => p[0] > 460 && p[0] < 480 && p[1] > 355 && p[1] < 380));
for (const c of isl) console.log(`\nislet course: kind=${c.kind} width=${c.width} ${c.points[0]} -> ${c.points[c.points.length - 1]}`);
console.log('islet buildings:', map.buildings.filter(b => b.x >= 452 && b.x < 478 && b.y >= 360 && b.y < 378).map(b => `${b.x},${b.y} ${b.w}x${b.h}`).join(' | ') || 'none');
