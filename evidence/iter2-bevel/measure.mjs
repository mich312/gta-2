/**
 * Iteration-2 measurements for the `built-staircase` finding.
 *   node evidence/iter2-bevel/measure.mjs
 *
 * Every number here is recomputed from the shipped generator, not copied out
 * of a report. Sections:
 *   1. deck width vs the carriageway it carries (is the deck-width case real?)
 *   2. tread length vs edge angle, over all 24 `built-staircase` sites
 *   3. the shore-staircase gate: the `len*tan(theta)` excess on the coast
 *   4. the 45-degree control: does the bevel still flatten a 45-degree edge?
 */
import * as S from '../../shared/dist/index.js';
import { loadWorldgenParams } from '../../server/dist/tuning.js';
import { readFileSync } from 'node:fs';

const map = S.generateCity(1, loadWorldgenParams());
const plan = JSON.parse(readFileSync(new URL('../../shared/data/city-plan.json', import.meta.url), 'utf8'));
const W = map.widthTiles, H = map.heightTiles, t = map.tiles;
const at = (x, y) => (x < 0 || y < 0 || x >= W || y >= H ? S.T_WATER : t[y * W + x]);

/* ------------------------------------------------------------------ */
/* 1. Is the bridge deck wider than the road it carries?               */
/* ------------------------------------------------------------------ */

/** Perpendicular half-extent of a tile band around a polyline, in tiles. */
function bandProfile(points, width, isMember) {
  // For every member tile, the signed perpendicular distance from the
  // centreline. A faithful centre-in rasterisation of a `width`-wide band
  // puts every centre within width/2, so tile SQUARES reach width/2 + 0.5.
  let maxAbs = 0, n = 0;
  const hist = new Map();
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (!isMember(x, y)) continue;
      let best = Infinity, sgn = 1;
      for (let k = 0; k + 1 < points.length; k++) {
        const [ax, ay] = points[k], [bx, by] = points[k + 1];
        const vx = bx - ax, vy = by - ay, L = vx * vx + vy * vy;
        let s = L > 0 ? ((x + 0.5 - ax) * vx + (y + 0.5 - ay) * vy) / L : 0;
        s = Math.max(0, Math.min(1, s));
        const dx = x + 0.5 - (ax + s * vx), dy = y + 0.5 - (ay + s * vy);
        const d = Math.sqrt(dx * dx + dy * dy);
        if (d < best) { best = d; sgn = Math.sign(vx * dy - vy * dx) || 1; }
      }
      if (best > width) continue; // not this course's tile
      n++;
      if (best > maxAbs) maxAbs = best;
      const b = (Math.round(best * 2) / 2) * sgn;
      hist.set(b, (hist.get(b) ?? 0) + 1);
    }
  }
  return { n, maxAbs, hist };
}

console.log('=== 1. deck width vs the course width it carries ===');
const bridges = plan.roads.filter((r) => /Bridge|Causeway/.test(r.name ?? ''));
for (const r of bridges) {
  const deck = bandProfile(r.points, r.width / 2 + 1.5, (x, y) => at(x, y) === S.T_BRIDGE);
  // Same measurement for the ROAD tiles of the same course, on land.
  const road = bandProfile(r.points, r.width / 2 + 1.5, (x, y) => at(x, y) === S.T_ROAD);
  const th = (Math.atan2(r.points[1][1] - r.points[0][1], r.points[1][0] - r.points[0][0]) * 180) / Math.PI;
  const off = Math.min(((th % 90) + 90) % 90, 90 - (((th % 90) + 90) % 90));
  console.log(
    `${(r.name ?? '?').padEnd(20)} width=${r.width} angle=${off.toFixed(1)}deg  ` +
      `deck ${deck.n} tiles max|d|=${deck.maxAbs.toFixed(2)}  ` +
      `road-of-same-course ${road.n} tiles max|d|=${road.maxAbs.toFixed(2)}`,
  );
}

/* Deck cross-section: count deck tiles on a line perpendicular to the run. */
console.log('\nSouth Sound Bridge perpendicular cross-sections (deck tiles crossed):');
{
  const r = bridges.find((b) => b.name === 'South Sound Bridge');
  const [ax, ay] = r.points[0], [bx, by] = r.points[1];
  const L = Math.hypot(bx - ax, by - ay);
  const ux = (bx - ax) / L, uy = (by - ay) / L;
  const px = -uy, py = ux;
  for (let s = 10; s <= L - 10; s += 8) {
    const cx = ax + ux * s, cy = ay + uy * s;
    let count = 0, first = null, last = null;
    for (let q = -6; q <= 6; q += 0.05) {
      const x = Math.floor(cx + px * q), y = Math.floor(cy + py * q);
      const key = y * W + x;
      if (at(x, y) !== S.T_BRIDGE) continue;
      if (first === null) first = q;
      last = q;
      void key;
    }
    // Count distinct tiles crossed.
    const seen = new Set();
    for (let q = -6; q <= 6; q += 0.02) {
      const x = Math.floor(cx + px * q), y = Math.floor(cy + py * q);
      if (at(x, y) === S.T_BRIDGE) seen.add(y * W + x);
    }
    count = seen.size;
    console.log(
      `  s=${String(s).padStart(3)}  deck tiles across = ${count}  ` +
        `perp extent = ${first === null ? '-' : (last - first).toFixed(2)} tiles`,
    );
  }
}

/* ------------------------------------------------------------------ */
/* 2. Tread length vs edge angle over the 24 sites                     */
/* ------------------------------------------------------------------ */

/* The audit's own component/profile/tread machinery, re-implemented so the
 * per-site angle can be read off next to the tread. */
function components(mask) {
  const seen = new Uint8Array(W * H);
  const out = [];
  for (let i = 0; i < W * H; i++) {
    if (mask[i] !== 1 || seen[i]) continue;
    const bag = [i]; seen[i] = 1;
    for (let q = 0; q < bag.length; q++) {
      const j = bag[q], x = j % W, y = (j - x) / W;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const k = ny * W + nx;
        if (mask[k] === 1 && !seen[k]) { seen[k] = 1; bag.push(k); }
      }
    }
    out.push(bag);
  }
  return out;
}

const CHAINS = S.shoreChains(map.shores ?? [], W, H);
const BANDS = S.shoreChains(map.banks ?? [], W, H);
const TN = ['field','road','sidewalk','building','park','lot','water','bridge','ramp','floor','quay','trees','sand','runway'];
const KINDS = [[S.T_BRIDGE, 'bridge deck'], [S.T_BANK, 'quay'], [S.T_LOT, 'yard'], [S.T_RUNWAY, 'runway']];
const sites = [];
for (const [kind, label] of KINDS) {
  const mask = new Uint8Array(W * H);
  for (let i = 0; i < t.length; i++) mask[i] = t[i] === kind ? 1 : 0;
  for (const bag of components(mask)) {
    if (bag.length < 60) continue;
    let x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1;
    for (const i of bag) { const x = i % W, y = (i - x) / W; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    const inBag = new Set(bag);
    for (const byColumn of [true, false]) {
      const n = byColumn ? x1 - x0 + 1 : y1 - y0 + 1;
      const m = byColumn ? y1 - y0 + 1 : x1 - x0 + 1;
      if (n < 14) continue;
      for (const side of [0, 1]) {
        const prof = new Int32Array(n).fill(-1);
        for (let p = 0; p < n; p++) {
          for (let q = 0; q < m; q++) {
            const qq = side === 0 ? q : m - 1 - q;
            const x = byColumn ? x0 + p : x0 + qq;
            const y = byColumn ? y0 + qq : y0 + p;
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
            const a = treads[j], b = treads[j + 1];
            if (b.at !== a.at + a.len) break;
            if (a.len < 2 || a.len > 10 || b.len < 2 || b.len > 10) break;
            const step = b.v - a.v;
            if (Math.abs(step) !== 1) break;
            if (dir === 0) dir = step; else if (step !== dir) break;
            j++;
          }
          const first = treads[i], last = treads[j];
          const span = last.at + last.len - first.at;
          const count = j - i + 1;
          if (count >= 4 && span >= 14) {
            // What lies just outside the outline along this chain, and how
            // much of it the coast curve dissolves — the same reconstruction
            // the detector does, so the two agree tile for tile.
            const outward = new Map();
            let faces = 0, dissolvedC = 0;
            for (let q = first.at; q < first.at + span; q++) {
              const v = prof[q];
              if (v < 0) continue;
              const st = side === 0 ? -1 : 1;
              const x = byColumn ? x0 + q : v;
              const y = byColumn ? v : y0 + q;
              const ox = byColumn ? x : x + st;
              const oy = byColumn ? y + st : y;
              const ot = at(ox, oy);
              outward.set(ot, (outward.get(ot) ?? 0) + 1);
              if (ot !== S.T_WATER) continue;
              faces++;
              if (CHAINS.has(y * W + x) || CHAINS.has(oy * W + ox) ||
                  BANDS.has(y * W + x) || BANDS.has(oy * W + ox)) dissolvedC++;
            }
            const meanTread = span / count;
            const midP = first.at + span / 2;
            const mx = byColumn ? x0 + midP : (first.v + last.v) / 2;
            const my = byColumn ? (first.v + last.v) / 2 : y0 + midP;
            // The edge's own angle, from the profile: rise/run over the chain.
            const rise = Math.abs(last.v - first.v) + 1;
            const angle = (Math.atan2(rise, span) * 180) / Math.PI;
            sites.push({ label, mx, my, span, count, meanTread, angle, rank: span * meanTread, kind, faces, dissolvedC, outward });
          }
          i = j + 1;
        }
      }
    }
  }
}
sites.sort((a, b) => b.rank - a.rank);
const kept = [];
for (const f of sites) {
  const cx = Math.max(0, Math.min(W - 1, Math.round(f.mx) - Math.floor(f.span * 0.7)));
  const cy = Math.max(0, Math.min(H - 1, Math.round(f.my) - Math.floor(f.span * 0.7)));
  if (kept.some((k) => Math.abs(k.cx - cx) <= 12 && Math.abs(k.cy - cy) <= 12)) continue;
  kept.push({ ...f, cx, cy });
}

console.log('\n=== 2. tread length vs edge angle, all built-staircase sites ===');
console.log('kind          at         span count meanTread  angle  1/tan(angle)  ratio');
for (const f of kept) {
  const pred = 1 / Math.tan((f.angle * Math.PI) / 180);
  console.log(
    `${f.label.padEnd(12)} ${(Math.round(f.mx) + ',' + Math.round(f.my)).padEnd(10)} ` +
      `${String(f.span).padStart(4)} ${String(f.count).padStart(5)} ${f.meanTread.toFixed(1).padStart(9)} ` +
      `${f.angle.toFixed(1).padStart(6)} ${pred.toFixed(1).padStart(13)} ${(f.meanTread / pred).toFixed(2).padStart(6)}`,
  );
}
console.log(`sites: ${kept.length}`);

console.log('\n=== 2b. what each reported chain actually borders, and whether it is drawn ===');
console.log('kind          at         span  outward neighbours along the chain            water faces  dissolved');
for (const f of kept) {
  const nb = [...f.outward.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${TN[k] ?? k}:${n}`).join(' ');
  console.log(
    `${f.label.padEnd(12)} ${(Math.round(f.mx) + ',' + Math.round(f.my)).padEnd(10)} ${String(f.span).padStart(4)}  ${nb.padEnd(44)} ` +
      `${String(f.faces).padStart(11)}  ${f.faces ? ((100 * f.dissolvedC) / f.faces).toFixed(0) + '%' : '-'}`,
  );
}

/* ------------------------------------------------------------------ */
/* 3. The shore gate: what is the worst len*tan(theta) on the coast?   */
/* ------------------------------------------------------------------ */

function segIndex(rings) {
  const segs = [];
  for (const r of rings) {
    const p = r.points;
    for (let i = 0; i < p.length; i++) segs.push([p[i][0], p[i][1], p[(i + 1) % p.length][0], p[(i + 1) % p.length][1]]);
  }
  return segs;
}
function curveOffAxis(segs, x, y, reach) {
  let best = reach * reach, bs = null;
  for (const s of segs) {
    const vx = s[2] - s[0], vy = s[3] - s[1], L = vx * vx + vy * vy;
    let u = L > 0 ? ((x - s[0]) * vx + (y - s[1]) * vy) / L : 0;
    u = Math.max(0, Math.min(1, u));
    const dx = s[0] + vx * u - x, dy = s[1] + vy * u - y, d2 = dx * dx + dy * dy;
    if (d2 < best) { best = d2; bs = s; }
  }
  if (!bs) return -1;
  const ang = (Math.atan2(bs[3] - bs[1], bs[2] - bs[0]) * 180) / Math.PI;
  const m = ((ang % 90) + 90) % 90;
  return Math.min(m, 90 - m);
}
console.log('\n=== 3. shore gate: worst len*tan(theta) on the natural coast ===');
{
  const shores = segIndex(map.shores ?? []);
  const banks = segIndex(map.banks ?? []);
  const cuts = [
    { name: 'waterline', segs: shores, inside: (v) => v === S.T_WATER, outside: (v) => v === S.T_SAND || v === S.T_FIELD || v === S.T_PARK },
    { name: 'shore band', segs: banks, inside: (v) => v === S.T_SAND, outside: (v) => v === S.T_FIELD || v === S.T_PARK || v === S.T_TREES },
  ];
  for (const cut of cuts) {
    let worst = 0, worstAt = '', hist = new Map();
    for (const vertical of [false, true]) {
      const outer = vertical ? W : H, inner = vertical ? H : W;
      const tileAt = (u, v) => (vertical ? at(v, u) : at(u, v));
      for (let v = 0; v + 1 < inner; v++) {
        let u = 0;
        while (u < outer) {
          const t0 = tileAt(u, v), t1 = tileAt(u, v + 1);
          const fwd = cut.inside(t0) && cut.outside(t1), bwd = cut.outside(t0) && cut.inside(t1);
          if (!fwd && !bwd) { u++; continue; }
          let e = u;
          while (e < outer) {
            const a0 = tileAt(e, v), a1 = tileAt(e, v + 1);
            const f = cut.inside(a0) && cut.outside(a1), b = cut.outside(a0) && cut.inside(a1);
            if (fwd ? !f : !b) break;
            e++;
          }
          const len = e - u;
          if (len >= 6) {
            const mu = (u + e) / 2;
            const mx = vertical ? v + 0.5 : mu, my = vertical ? mu : v + 0.5;
            const off = curveOffAxis(cut.segs, mx, my, 6);
            const excess = off < 0 ? 0 : len * Math.tan((off * Math.PI) / 180);
            const b = Math.floor(excess * 2) / 2;
            hist.set(b, (hist.get(b) ?? 0) + 1);
            if (excess > worst) { worst = excess; worstAt = `${Math.round(mx)},${Math.round(my)} len=${len} off=${off.toFixed(1)}deg`; }
          }
          u = e > u ? e : u + 1;
        }
      }
    }
    const bins = [...hist.entries()].sort((a, b) => a[0] - b[0]);
    console.log(`  ${cut.name}: worst excess ${worst.toFixed(2)} at ${worstAt}`);
    console.log(`    excess histogram (>=6-tile treads): ${bins.map(([k, n]) => `${k.toFixed(1)}:${n}`).join(' ')}`);
  }
}

/* ------------------------------------------------------------------ */
/* 4. The 45-degree control: does the bevel still flatten a 45 edge?   */
/* ------------------------------------------------------------------ */

console.log('\n=== 4. the 45-degree control (WORLDGEN.md 31) ===');
{
  // A synthetic 45-degree deck against water, through deriveBevels.
  const n = 32;
  const tt = new Uint8Array(n * n).fill(S.T_WATER);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (x + y >= n) tt[y * n + x] = S.T_BRIDGE;
  const bv = S.deriveBevels(tt, n, n);
  let cut = 0, steps = 0;
  for (let y = 1; y < n - 1; y++) for (let x = 1; x < n - 1; x++) if (bv[y * n + x] !== 0) cut++;
  // Every inner corner of a 45 staircase should be bevelled.
  for (let y = 1; y < n - 1; y++) for (let x = 1; x < n - 1; x++) {
    if (tt[y * n + x] !== S.T_WATER) continue;
    // an inner corner: bridge to the E and to the S (for this diagonal)
    if (tt[y * n + x + 1] === S.T_BRIDGE && tt[(y + 1) * n + x] === S.T_BRIDGE && tt[(y + 1) * n + x + 1] === S.T_BRIDGE) {
      steps++;
      if (bv[y * n + x] === 0) console.log(`    UNBEVELLED inner corner at ${x},${y}`);
    }
  }
  console.log(`  synthetic 45deg water/bridge edge: ${steps} inner corners, ${cut} bevels set — ${steps > 0 && cut >= steps ? 'FLATTENED' : 'NOT FLATTENED'}`);

  // And in the shipped city: the bevel count along each named crossing.
  console.log('  shipped crossings, bevels on the water side of the deck:');
  for (const r of bridges) {
    const [ax, ay] = r.points[0], [bx, by] = r.points[1];
    const th = (Math.atan2(by - ay, bx - ax) * 180) / Math.PI;
    const m = ((th % 90) + 90) % 90;
    const off = Math.min(m, 90 - m);
    let bevels = 0, steps2 = 0;
    const xlo = Math.min(ax, bx) - 8, xhi = Math.max(ax, bx) + 8;
    const ylo = Math.min(ay, by) - 8, yhi = Math.max(ay, by) + 8;
    for (let y = Math.max(1, ylo | 0); y <= Math.min(H - 2, yhi | 0); y++) {
      for (let x = Math.max(1, xlo | 0); x <= Math.min(W - 2, xhi | 0); x++) {
        const i = y * W + x;
        if (t[i] !== S.T_WATER) continue;
        const nb = [at(x + 1, y), at(x - 1, y), at(x, y + 1), at(x, y - 1)];
        if (nb.filter((v) => v === S.T_BRIDGE).length >= 2) steps2++;
        if (map.bevel[i] !== 0 && nb.includes(S.T_BRIDGE)) bevels++;
      }
    }
    console.log(`    ${(r.name ?? '?').padEnd(20)} angle ${off.toFixed(1).padStart(5)}deg  water tiles with 2+ deck neighbours: ${String(steps2).padStart(3)}  bevelled water tiles touching deck: ${String(bevels).padStart(3)}`);
  }
}

/* ------------------------------------------------------------------ */
/* 5. Is the staircase MASKED in game? Shore-chain coverage per site   */
/* ------------------------------------------------------------------ */

/*
 * Both shipped renderers repaint a tile the coast course runs through against
 * the CURVE (2D `paintShoreTile` -> `paintShoreMaterial`, which has an
 * explicit `T_BANK` case; 3D `shoreCut` prisms). A quay tile the chain covers
 * therefore never draws its own square edge. A BRIDGE tile is excluded by
 * name in both ("a deck is not ground at all" / "the coast runs UNDER it"),
 * and no curve describes the deck's own outer edge at all.
 */
console.log('\n=== 5. shore-chain coverage of each staircase edge ===');
{
  const chains = S.shoreChains(map.shores ?? [], W, H);
  const bandChains = S.shoreChains(map.banks ?? [], W, H);
  console.log('kind          at         span  edge tiles  on a coast chain   masked by the curve layer');
  for (const f of kept) {
    // The component's own boundary tiles inside the finding's box.
    const half = Math.max(8, Math.round(f.span * 0.7));
    let n = 0, covered = 0;
    for (let y = Math.max(0, Math.round(f.my) - half); y <= Math.min(H - 1, Math.round(f.my) + half); y++) {
      for (let x = Math.max(0, Math.round(f.mx) - half); x <= Math.min(W - 1, Math.round(f.mx) + half); x++) {
        if (at(x, y) !== f.kind) continue;
        const edge = [at(x + 1, y), at(x - 1, y), at(x, y + 1), at(x, y - 1)].some((v) => v === S.T_WATER);
        if (!edge) continue;
        n++;
        if (chains.has(y * W + x) || bandChains.has(y * W + x)) covered++;
      }
    }
    console.log(
      `${f.label.padEnd(12)} ${(Math.round(f.mx) + ',' + Math.round(f.my)).padEnd(10)} ${String(f.span).padStart(4)} ` +
        `${String(n).padStart(11)} ${String(covered).padStart(17)}   ${n === 0 ? '-' : ((100 * covered) / n).toFixed(0) + '%'}`,
    );
  }
}

/* ------------------------------------------------------------------ */
/* 6. How far does a deck tile reach past the stroked ribbon?          */
/* ------------------------------------------------------------------ */

console.log('\n=== 6. deck-tile overhang past the course ribbon (tiles) ===');
for (const r of bridges) {
  const [ax, ay] = r.points[0], [bx, by] = r.points[1];
  const vx = bx - ax, vy = by - ay, L = Math.hypot(vx, vy);
  const ux = vx / L, uy = vy / L;
  let maxCentre = 0, maxCorner = 0, n = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (at(x, y) !== S.T_BRIDGE) continue;
      const perp = Math.abs((x + 0.5 - ax) * -uy + (y + 0.5 - ay) * ux);
      const along = (x + 0.5 - ax) * ux + (y + 0.5 - ay) * uy;
      // The last few tiles at each end are the ABUTMENT, where a crossing
      // street's own deck joins this one: those tiles belong to a junction,
      // not to the crossing's width. Kelvin's south abutment (rows 413-414,
      // x=447..455) is the whole of its 3.5-tile reading.
      if (along < 6 || along > L - 6 || perp > r.width) continue;
      // Kelvin carries four parallel decks a few tiles apart, so a plain
      // distance band picks up its neighbours' tiles and reports an overhang
      // that is really another bridge. Keep only tiles this crossing is the
      // nearest crossing to.
      let mine = true;
      for (const o of bridges) {
        if (o === r) continue;
        const [ox0, oy0] = o.points[0], [ox1, oy1] = o.points[1];
        const ovx = ox1 - ox0, ovy = oy1 - oy0, oL2 = ovx * ovx + ovy * ovy;
        let s2 = oL2 > 0 ? ((x + 0.5 - ox0) * ovx + (y + 0.5 - oy0) * ovy) / oL2 : 0;
        s2 = Math.max(0, Math.min(1, s2));
        const ddx = x + 0.5 - (ox0 + s2 * ovx), ddy = y + 0.5 - (oy0 + s2 * ovy);
        if (Math.sqrt(ddx * ddx + ddy * ddy) < perp) { mine = false; break; }
      }
      if (!mine) continue;
      n++;
      if (perp > maxCentre) maxCentre = perp;
      // Furthest corner of the unit square from the centreline.
      const corner = perp + (Math.abs(uy) + Math.abs(ux)) / 2;
      if (corner > maxCorner) maxCorner = corner;
    }
  }
  if (n === 0) continue;
  const ribbon = r.width / 2;            // carriageway stroke half-width
  const casing = r.width / 2 + 4 / 16 / 2; // + the kerb casing (4 world px total)
  console.log(
    `${(r.name ?? '?').padEnd(20)} ${String(n).padStart(4)} deck tiles  ` +
      `max centre offset ${maxCentre.toFixed(2)} (ribbon edge ${ribbon.toFixed(2)})  ` +
      `max tile-corner reach ${maxCorner.toFixed(2)}  ` +
      `=> overhang past ribbon ${(maxCorner - ribbon).toFixed(2)} tiles, past casing ${(maxCorner - casing).toFixed(2)}`,
  );
}

/* ------------------------------------------------------------------ */
/* 5b. The masking rule at EDGE level, as the client actually applies  */
/* ------------------------------------------------------------------ */

/*
 * The client dissolves a square tile edge when EITHER of the two tiles that
 * share it is on a coast chain: the cut tile is repainted as two halves split
 * by the chord, so the step face stops being drawn. `paintShoreMaterial` has
 * a `T_BANK` case, so a quay half paints as quay.
 *
 * A deck is excluded twice over and by name: `paintShoreTile` paints a bridge
 * tile's WET half with `paintBridge` ("the coast runs UNDER it"), and
 * `paintBandTile` refuses `own === T_BRIDGE` ("a deck is not ground at all").
 * A water tile next to a deck takes its dry material from the nearest dry
 * neighbour, skipping T_BRIDGE — so it can never be painted as deck either.
 */
console.log('\n=== 5b. staircase step faces dissolved by the coast curve ===');
{
  const chains = S.shoreChains(map.shores ?? [], W, H);
  const bandChains = S.shoreChains(map.banks ?? [], W, H);
  const onChain = (x, y) => chains.has(y * W + x) || bandChains.has(y * W + x);
  console.log('kind          at         span   step faces  dissolved   left drawn');
  let deckLeft = 0, quayLeft = 0, deckAll = 0, quayAll = 0;
  for (const f of kept) {
    const half = Math.max(8, Math.round(f.span * 0.7));
    let faces = 0, gone = 0;
    for (let y = Math.max(1, Math.round(f.my) - half); y <= Math.min(H - 2, Math.round(f.my) + half); y++) {
      for (let x = Math.max(1, Math.round(f.mx) - half); x <= Math.min(W - 2, Math.round(f.mx) + half); x++) {
        if (at(x, y) !== f.kind) continue;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          if (at(x + dx, y + dy) !== S.T_WATER) continue;
          faces++;
          // A deck edge is never dissolved: both painters refuse it by name.
          if (f.kind !== S.T_BRIDGE && (onChain(x, y) || onChain(x + dx, y + dy))) gone++;
        }
      }
    }
    if (f.kind === S.T_BRIDGE) { deckAll += faces; deckLeft += faces - gone; }
    else { quayAll += faces; quayLeft += faces - gone; }
    console.log(
      `${f.label.padEnd(12)} ${(Math.round(f.mx) + ',' + Math.round(f.my)).padEnd(10)} ${String(f.span).padStart(4)} ` +
        `${String(faces).padStart(12)} ${(faces ? ((100 * gone) / faces).toFixed(0) + '%' : '-').padStart(10)} ${String(faces - gone).padStart(12)}`,
    );
  }
  console.log(`  quays/yards: ${quayAll} step faces, ${quayLeft} still drawn square (${((100 * quayLeft) / quayAll).toFixed(0)}%)`);
  console.log(`  bridge decks: ${deckAll} step faces, ${deckLeft} still drawn square (100%)`);
}
