import { beforeAll, describe, expect, it } from 'vitest';
import playerTuning from '../data/player.json';
import vehiclesJson from '../data/vehicles.json';
import worldgenJson from '../data/worldgen.json';
import { initTuning } from '../src/tuning.js';
import { parseWorldgenParams } from '../src/world/params.js';
import { generateCity } from '../src/world/generate.js';
import { drivableAt, drivableTile } from '../src/sim/roadgrid.js';
import { edgeAt, laneAim, laneAt, laneOffset, lanePoint } from '../src/sim/lanes.js';
import { T_BRIDGE, T_ROAD, TILE_SIZE, type CityMap } from '../src/world/types.js';

/**
 * The lane model (WORLDGEN.md §42).
 *
 * Invariants rather than numbers wherever a number would only pin today's
 * city: a lane has to be ON the road, a street has to know which way it runs,
 * and two hosts have to agree. The three thresholds that ARE numbers are
 * coverage figures, and they are floors well under what the shipped city
 * measures, so they catch a collapse rather than a wobble.
 */

const params = parseWorldgenParams(worldgenJson);
let map: CityMap;

beforeAll(() => {
  initTuning({ player: playerTuning, vehicles: vehiclesJson });
  map = generateCity(1, params);
});

/** Every point on every lane line, at four-pixel steps. */
function* alongLanes(m: CityMap): Generator<{ e: number; x: number; y: number; k: number }> {
  const L = m.lanes!;
  for (let e = 0; e + 1 < L.off.length; e++) {
    const lo = L.off[e] as number;
    const hi = L.off[e + 1] as number;
    for (let k = lo; k + 1 < hi; k++) {
      const ax = L.x[k] as number;
      const ay = L.y[k] as number;
      const vx = (L.x[k + 1] as number) - ax;
      const vy = (L.y[k + 1] as number) - ay;
      const len = Math.sqrt(vx * vx + vy * vy);
      const steps = Math.max(1, Math.ceil(len / 4));
      for (let s = 0; s <= steps; s++) {
        yield { e, x: ax + (vx * s) / steps, y: ay + (vy * s) / steps, k: s * 2 <= steps ? k : k + 1 };
      }
    }
  }
}

describe('lanes on the graph', () => {
  it('names a street for nearly every tile of carriageway', () => {
    const L = map.lanes!;
    let drivable = 0;
    let named = 0;
    for (let i = 0; i < map.tiles.length; i++) {
      const t = map.tiles[i] as number;
      if (t !== T_ROAD && t !== T_BRIDGE) continue;
      drivable++;
      if ((L.edgeOf[i] as number) >= 0) named++;
    }
    // The unnamed remainder is junction tiles, which have no street on
    // purpose, plus carriageway further from any street's own path than the
    // spread reaches — a dead-end spur, a long lane with no intersection on
    // it. Naming those after the nearest street is what the bound in
    // `spreadEdges` exists to refuse.
    expect(named / drivable).toBeGreaterThan(0.75);
  });

  it('never names a street for ground that is not road', () => {
    const L = map.lanes!;
    for (let i = 0; i < map.tiles.length; i++) {
      if ((L.edgeOf[i] as number) < 0) continue;
      const t = map.tiles[i] as number;
      expect(t === T_ROAD || t === T_BRIDGE).toBe(true);
    }
  });

  it('every street runs down its own tarmac', () => {
    let on = 0;
    let n = 0;
    for (const p of alongLanes(map)) {
      n++;
      if (drivableAt(map, p.x, p.y)) on++;
    }
    expect(n).toBeGreaterThan(100_000);
    expect(on / n).toBeGreaterThan(0.99);
  });

  it('the kerb lane is on the tarmac, in both directions', () => {
    const L = map.lanes!;
    let on = 0;
    let n = 0;
    for (const p of alongLanes(map)) {
      for (const dir of [1, -1]) {
        const kk = p.k;
        const roomR = (dir > 0 ? L.halfR[kk] : L.halfL[kk]) as number;
        const roomL = (dir > 0 ? L.halfL[kk] : L.halfR[kk]) as number;
        const off = laneOffset(L.edgeLanes[p.e] as number, roomR, roomL, 0);
        // Perpendicular to the line, on the right of travel.
        const lo = L.off[p.e] as number;
        const hi = L.off[p.e + 1] as number;
        const a = kk > lo ? kk - 1 : kk;
        const b = kk + 1 < hi ? kk + 1 : kk;
        const vx = (L.x[b] as number) - (L.x[a] as number);
        const vy = (L.y[b] as number) - (L.y[a] as number);
        const len = Math.sqrt(vx * vx + vy * vy) || 1;
        n++;
        if (drivableAt(map, p.x - (vy / len) * dir * off, p.y + (vx / len) * dir * off)) on++;
      }
    }
    expect(on / n).toBeGreaterThan(0.99);
  });

  it('measures room only where there is room: never past a kerb', () => {
    const L = map.lanes!;
    // The measured half-widths are what the lane offsets are a fraction of,
    // so a half-width that reaches off the road is a lane on the pavement.
    for (let e = 0; e + 1 < L.off.length; e += 37) {
      const lo = L.off[e] as number;
      const hi = L.off[e + 1] as number;
      for (let k = lo; k + 1 < hi; k++) {
        // The same tangent `reachAcross` measured along: the point before and
        // the point after, held at the ends.
        const a = k > lo ? k - 1 : k;
        const b = k + 1 < hi ? k + 1 : k;
        const vx = (L.x[b] as number) - (L.x[a] as number);
        const vy = (L.y[b] as number) - (L.y[a] as number);
        const len = Math.sqrt(vx * vx + vy * vy) || 1;
        for (const [room, sign] of [
          [L.halfR[k] as number, 1],
          [L.halfL[k] as number, -1],
        ] as const) {
          if (room === 0) continue;
          const qx = (L.x[k] as number) - (vy / len) * sign * room;
          const qy = (L.y[k] as number) + (vx / len) * sign * room;
          expect(drivableTile(map, Math.floor(qx / TILE_SIZE), Math.floor(qy / TILE_SIZE))).toBe(true);
        }
      }
    }
  });

  it('resolves which way along a street a car is going, and flips with it', () => {
    const L = map.lanes!;
    let checked = 0;
    for (const p of alongLanes(map)) {
      if (checked >= 400) break;
      const lo = L.off[p.e] as number;
      const hi = L.off[p.e + 1] as number;
      // The LOCAL tangent at the sample point, not the first segment's: on
      // an L-shaped street line (which the 4.6 contour connectors produce,
      // wrapping a corner in one edge) the first segment runs east while
      // the midpoint's own run heads south, and a query perpendicular to
      // the local tangent has no stable sign to flip — the probe was
      // asking a question no car on that street would ask. A driver's
      // travel direction is along the street where they ARE.
      const kk = Math.min(Math.max(p.k, lo), hi - 2);
      const vx = (L.x[kk + 1] as number) - (L.x[kk] as number);
      const vy = (L.y[kk + 1] as number) - (L.y[kk] as number);
      const len = Math.sqrt(vx * vx + vy * vy);
      if (len === 0 || hi - lo < 3) continue;
      const with_ = laneAt(L, p.x, p.y, vx / len, vy / len);
      const against = laneAt(L, p.x, p.y, -vx / len, -vy / len);
      if (!with_ || !against || with_.edge !== p.e || against.edge !== p.e) continue;
      checked++;
      // Going one way and going back are opposite answers on the same street,
      // and "across" flips sign with them because it is measured from travel.
      expect(with_.dir).toBe(-against.dir);
      expect(with_.across).toBeCloseTo(-against.across, 6);
      expect(with_.at).toBeCloseTo(against.at, 6);
    }
    expect(checked).toBeGreaterThan(100);
  });

  it('puts the two directions on opposite sides of the line', () => {
    const L = map.lanes!;
    let checked = 0;
    for (const p of alongLanes(map)) {
      if (checked >= 300) break;
      const lo = L.off[p.e] as number;
      const vx = (L.x[lo + 1] as number) - (L.x[lo] as number);
      const vy = (L.y[lo + 1] as number) - (L.y[lo] as number);
      const len = Math.sqrt(vx * vx + vy * vy);
      if (len === 0) continue;
      const a = laneAt(L, p.x, p.y, vx / len, vy / len);
      const b = laneAt(L, p.x, p.y, -vx / len, -vy / len);
      if (!a || !b || a.edge !== p.e || b.edge !== p.e) continue;
      const pa = lanePoint(L, a, 0, 0);
      const pb = lanePoint(L, b, 0, 0);
      if (pa.x === pb.x && pa.y === pb.y) continue; // a single-track street
      checked++;
      // Right of travel is the opposite side of the line for the opposite
      // direction: this city drives on the right, and that is the whole point.
      const cross =
        ((pa.x - p.x) * -vy + (pa.y - p.y) * vx) * (((pb.x - p.x) * -vy + (pb.y - p.y) * vx));
      expect(cross).toBeLessThanOrEqual(0);
    }
    expect(checked).toBeGreaterThan(100);
  });

  it('aims down the lane, and hands over to the next street at the junction', () => {
    const L = map.lanes!;
    const net = map.roadNet!;
    let crossed = 0;
    let on = 0;
    let n = 0;
    for (const p of alongLanes(map)) {
      const lp = laneAt(L, p.x, p.y, 1, 0);
      if (!lp || lp.edge !== p.e) continue;
      const span = L.s[(L.off[p.e + 1] as number) - 1] as number;
      const aim = laneAim(L, net, lp, 40, 0, 1, 0);
      n++;
      if (drivableAt(map, aim.x, aim.y)) on++;
      if (lp.at + 40 * lp.dir > span || lp.at + 40 * lp.dir < 0) {
        crossed++;
        // Handed over rather than run on: the aim is never further from the
        // car than the reach it asked for plus a lane's width.
        expect(Math.hypot(aim.x - p.x, aim.y - p.y)).toBeLessThan(40 + 6 * TILE_SIZE);
      }
    }
    expect(crossed).toBeGreaterThan(1000);
    expect(on / n).toBeGreaterThan(0.97);
  });

  it('is pure: the same city built twice has the same lanes', () => {
    const a = generateCity(7, params).lanes!;
    const b = generateCity(7, params).lanes!;
    expect(Buffer.from(a.edgeOf.buffer.slice(0))).toEqual(Buffer.from(b.edgeOf.buffer.slice(0)));
    expect([...a.x]).toEqual([...b.x]);
    expect([...a.y]).toEqual([...b.y]);
    expect([...a.halfR]).toEqual([...b.halfR]);
    expect([...a.halfL]).toEqual([...b.halfL]);
  });

  it('never names a street a car is not standing on', () => {
    const L = map.lanes!;
    // The invariant that matters, and it is geometric rather than topological:
    // whatever street a tile is named after, its LINE has to be within reach,
    // because a car standing there will steer at it. Unbounded, the spread
    // named one tile after a street whose line was 147 tiles away.
    let checked = 0;
    let worst = 0;
    for (let i = 0; i < map.tiles.length; i += 7) {
      const e = L.edgeOf[i] as number;
      if (e < 0) continue;
      const tx = i % map.widthTiles;
      const x = (tx + 0.5) * TILE_SIZE;
      const y = ((i - tx) / map.widthTiles + 0.5) * TILE_SIZE;
      let best = Infinity;
      for (let k = L.off[e] as number; k + 1 < (L.off[e + 1] as number); k++) {
        const ax = L.x[k] as number;
        const ay = L.y[k] as number;
        const vx = (L.x[k + 1] as number) - ax;
        const vy = (L.y[k + 1] as number) - ay;
        const l2 = vx * vx + vy * vy;
        let t = l2 === 0 ? 0 : ((x - ax) * vx + (y - ay) * vy) / l2;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const dx = ax + vx * t - x;
        const dy = ay + vy * t - y;
        best = Math.min(best, Math.sqrt(dx * dx + dy * dy));
      }
      checked++;
      worst = Math.max(worst, best);
    }
    expect(checked).toBeGreaterThan(1000);
    // The spread reaches three tiles, and the line itself can sit a tile and
    // a half off the path it was built from.
    expect(worst).toBeLessThan(5 * TILE_SIZE);
  });

  it('leaves junctions to the junction machinery', () => {
    const L = map.lanes!;
    const idOf = map.junctions.idOf;
    for (let i = 0; i < map.tiles.length; i++) {
      if ((idOf[i] as number) >= 0) expect(L.edgeOf[i] as number).toBe(-1);
    }
    // ...and `edgeAt` says so at a point, which is what the driver asks.
    let inJunction = 0;
    for (let i = 0; i < map.tiles.length && inJunction < 200; i++) {
      if ((idOf[i] as number) < 0) continue;
      inJunction++;
      const tx = i % map.widthTiles;
      const ty = (i - tx) / map.widthTiles;
      expect(edgeAt(L, (tx + 0.5) * TILE_SIZE, (ty + 0.5) * TILE_SIZE)).toBe(-1);
    }
    expect(inJunction).toBeGreaterThan(100);
  });
});
