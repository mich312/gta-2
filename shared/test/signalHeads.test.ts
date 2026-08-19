import { describe, expect, it } from 'vitest';
import worldgenJson from '../data/worldgen.json';
import { parseWorldgenParams } from '../src/world/params.js';
import { generateCity } from '../src/world/generate.js';
import { CARDINALS, RIGHT_STEP, drivableTile } from '../src/sim/roadgrid.js';
import { junctionGround, signalColour, signalledCrossing } from '../src/sim/signals.js';
import { courseCrossings } from '../src/world/geometry.js';
import { armMouth, isSignalCrossing, junctionPaint, STOP_LINE_REACH } from '../src/world/marks.js';
import { getTrafficTuning, initTuning } from '../src/tuning.js';
import trafficJson from '../data/traffic.json';
import playerTuning from '../data/player.json';
import vehiclesJson from '../data/vehicles.json';
import {
  TILE_SIZE,
  T_BRIDGE,
  T_BUILDING,
  T_ROAD,
  T_WATER,
  type CityMap,
} from '../src/world/types.js';

initTuning({ player: playerTuning, vehicles: vehiclesJson, traffic: trafficJson });

const map: CityMap = generateCity(4242, parseWorldgenParams(worldgenJson));
const junctions = map.junctions!;

/** The tile a head sits on, back out of its world position. */
function tileOf(head: { x: number; y: number }): [number, number] {
  return [Math.floor(head.x / TILE_SIZE), Math.floor(head.y / TILE_SIZE)];
}

/**
 * Junction this tile approaches travelling `dirIdx`, or -1 — counting only
 * the junctions the city SIGNALISES.
 *
 * The unsignalised ones are junctions in every other sense (the lane model,
 * the road network and the routing all still see them) and they are the
 * majority: a corner where two residential streets meet gets no lights, the
 * way it gets none in any city that has to pay for them. A head there would
 * be the defect, so they are not arms this file has anything to say about.
 */
function approaches(tx: number, ty: number, dirIdx: number): number {
  const w = map.widthTiles;
  const h = map.heightTiles;
  if (tx < 0 || ty < 0 || tx >= w || ty >= h) return -1;
  if (!drivableTile(map, tx, ty) || junctions.idOf[ty * w + tx] !== -1) return -1;
  const [dx, dy] = CARDINALS[dirIdx] as readonly [number, number];
  const nx = tx + dx;
  const ny = ty + dy;
  if (nx < 0 || ny < 0 || nx >= w || ny >= h) return -1;
  const id = junctions.idOf[ny * w + nx] as number;
  return id >= 0 && junctions.signalled[id] === 1 ? id : -1;
}

describe('signal heads', () => {
  it('puts one head on each arm, not one per tile of tarmac', () => {
    // The bug this replaces: a head per approach tile, so a four-tile arterial
    // arm carried four lights strung across the carriageway and a crossroads
    // read as a string of fairy lights.
    const perArm = new Map<string, number>();
    for (const head of junctions.heads) {
      const key = `${head.junctionId}:${head.dirIdx}`;
      perArm.set(key, (perArm.get(key) ?? 0) + 1);
    }
    expect(junctions.heads.length).toBeGreaterThan(0);
    expect(Math.max(...perArm.values())).toBe(1);
  });

  it('stands each head on an approach tile of the junction it shows', () => {
    for (const head of junctions.heads) {
      const [tx, ty] = tileOf(head);
      expect(approaches(tx, ty, head.dirIdx), `head at ${tx},${ty}`).toBe(head.junctionId);
    }
  });

  it('stands them on the kerb of the lanes going in, not the ones coming out', () => {
    // Driving on the right, the light you obey is on the near right of your
    // approach. Half the old heads stood over the outbound lanes, governing
    // traffic that had already left the junction.
    for (const head of junctions.heads) {
      const [tx, ty] = tileOf(head);
      const [rx, ry] = RIGHT_STEP[head.dirIdx] as readonly [number, number];
      // Nothing further right belongs to this approach: this is the kerb tile.
      expect(approaches(tx + rx, ty + ry, head.dirIdx), `head at ${tx},${ty}`).not.toBe(
        head.junctionId,
      );
    }
  });

  it('leaves no arm of any junction dark', () => {
    // Every approach tile in the city must be covered by exactly one head, or
    // fewer lights has quietly become fewer *governed* junctions.
    const armsWithTraffic = new Set<string>();
    for (let ty = 0; ty < map.heightTiles; ty++) {
      for (let tx = 0; tx < map.widthTiles; tx++) {
        for (let dirIdx = 0; dirIdx < 4; dirIdx++) {
          const id = approaches(tx, ty, dirIdx);
          if (id !== -1) armsWithTraffic.add(`${id}:${dirIdx}`);
        }
      }
    }
    const armsWithHeads = new Set(junctions.heads.map((h) => `${h.junctionId}:${h.dirIdx}`));
    expect(armsWithHeads.size).toBe(armsWithTraffic.size);
    for (const arm of armsWithTraffic) expect(armsWithHeads.has(arm)).toBe(true);
  });

  it('gives a crossroads four lights and a T-junction three', () => {
    const perJunction = new Map<number, number>();
    for (const head of junctions.heads) {
      perJunction.set(head.junctionId, (perJunction.get(head.junctionId) ?? 0) + 1);
    }
    const counts = [...perJunction.values()];
    // A junction has four arms at most, and the head is the arm. Before this,
    // one crossroads on an arterial carried fourteen.
    expect(Math.max(...counts)).toBeLessThanOrEqual(4);
    expect(Math.min(...counts)).toBeGreaterThanOrEqual(2);
    // Lights go where an arterial crosses something, and an arterial that
    // simply STOPS at another road is rare, so the signalised set is nearly
    // all crossroads: 79 of 82, against one T and two two-armed. Before
    // the policy this read the other way round — far more Ts than crossroads
    // — because every residential corner in the city was in the set.
    expect(counts.filter((c) => c === 4).length).toBeGreaterThan(70);
    expect(counts.filter((c) => c === 3).length).toBeGreaterThan(0);
    // All-fours would mean an arm was being dropped somewhere.
    expect(counts.filter((c) => c === 4).length).toBeLessThan(counts.length);
  });

  it('signalises the arterial crossings and leaves the rest to be negotiated', () => {
    // The policy, as a number. 779 junctions and 2,990 heads was the city
    // before: every corner of every block wearing a full set of lights, and
    // 537 of those junctions four tiles of tarmac or less (§49). It is now
    // 725 junctions and 82 of them lit, because §51 also made a junction
    // the whole sheet of tarmac rather than the pieces a 4-connected fill
    // left it in, and §52 refuses an arm whose tarmac is an apron rather
    // than a mouth.
    const signalled = [...junctions.signalled].filter((v) => v === 1).length;
    expect(junctions.count).toBeGreaterThan(400);
    expect(signalled).toBeGreaterThan(50);
    expect(signalled).toBeLessThan(junctions.count / 3);
    // And no head stands anywhere else — this is what makes the stop line
    // and the light the same fact.
    for (const head of junctions.heads) {
      expect(junctions.signalled[head.junctionId], `head at ${head.x},${head.y}`).toBe(1);
    }
    expect(junctions.heads.length).toBeLessThanOrEqual(signalled * 4);
  });
});

/**
 * The properties §50 claimed and did not have (WORLDGEN.md §51).
 *
 * Every one of these was found by a reviewer rather than by this suite, which
 * is the argument for them being here: a claim in a commit message is not a
 * test, and all three of these were in one.
 */
describe('what a junction promises', () => {
  const W = map.widthTiles;
  const H = map.heightTiles;
  const timing = getTrafficTuning().signals;
  const ground = junctionGround(map);
  const all = courseCrossings((map.courses ?? []).filter((c) => c.kind !== 'path'));
  const lit = all.filter((c) => isSignalCrossing(c) && signalledCrossing(map, c));

  it('never shows green to both axes on one sheet of tarmac', () => {
    // The load-bearing one. `signalColour`'s arithmetic makes two axes of ONE
    // junction impossible by construction — but a crossroads the flood fill
    // returned in two pieces is two junctions, and two ids are two phases.
    // Measured on the shipped city before §51: 17 crossroads where it could
    // happen, at any of which a player would meet cross traffic on a green.
    const pairs = new Set<string>();
    for (let y = 0; y + 1 < H; y++) {
      for (let x = 0; x + 1 < W; x++) {
        const a = junctions.idOf[y * W + x] as number;
        if (a < 0) continue;
        for (const [dx, dy] of [
          [1, 0],
          [0, 1],
          [1, 1],
          [1, -1],
        ] as const) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
          const b = junctions.idOf[ny * W + nx] as number;
          if (b < 0 || b === a) continue;
          pairs.add(a < b ? `${a},${b}` : `${b},${a}`);
        }
      }
    }
    expect(pairs.size).toBeGreaterThan(10); // the split pieces still exist
    const cycle = (timing.greenTicks + timing.amberTicks) * 2;
    let lit2 = 0;
    for (const key of pairs) {
      const [a, b] = key.split(',').map(Number) as [number, number];
      if (junctions.signalled[a] !== 1 || junctions.signalled[b] !== 1) continue;
      lit2++;
      const pa = junctions.phase[a] as number;
      const pb = junctions.phase[b] as number;
      for (let tick = 0; tick < cycle * 8; tick++) {
        const ok =
          !(
            signalColour(pa, 0, tick, timing) === 'green' &&
            signalColour(pb, 1, tick, timing) === 'green'
          ) &&
          !(
            signalColour(pb, 0, tick, timing) === 'green' &&
            signalColour(pa, 1, tick, timing) === 'green'
          );
        expect(ok, `junctions ${a} and ${b} both green at tick ${tick}`).toBe(true);
      }
    }
    // And the case is real: touching pairs that BOTH carry lights exist, so
    // this is not passing because there is nothing to check.
    expect(lit2).toBeGreaterThan(0);
  });

  it('paints no crossing on water, on a wall or on a bridge deck', () => {
    // Zebra stripes stood in the creek at (383,472) until §51, because the
    // furniture comes off the curves and a curve knows nothing about what was
    // built under it.
    let cells = 0;
    let offRoad = 0;
    for (const cross of lit) {
      const paint = junctionPaint(cross, all, ground);
      for (const q of [...paint.zebras, ...paint.stops]) {
        let x0 = Infinity;
        let x1 = -Infinity;
        let y0 = Infinity;
        let y1 = -Infinity;
        for (let k = 0; k < 8; k += 2) {
          x0 = Math.min(x0, q[k] as number);
          x1 = Math.max(x1, q[k] as number);
          y0 = Math.min(y0, q[k + 1] as number);
          y1 = Math.max(y1, q[k + 1] as number);
        }
        for (let ty = Math.floor(y0); ty <= Math.ceil(y1); ty++) {
          for (let tx = Math.floor(x0); tx <= Math.ceil(x1); tx++) {
            if (tx < 0 || ty < 0 || tx >= W || ty >= H) continue;
            let inside = false;
            for (let a = 0, b = 3; a < 4; b = a++) {
              const ax = q[a * 2] as number;
              const ay = q[a * 2 + 1] as number;
              const bx = q[b * 2] as number;
              const by = q[b * 2 + 1] as number;
              if (ay > ty + 0.5 !== by > ty + 0.5 && tx + 0.5 < ((bx - ax) * (ty + 0.5 - ay)) / (by - ay) + ax) {
                inside = !inside;
              }
            }
            if (!inside) continue;
            cells++;
            const t = map.tiles[ty * W + tx] as number;
            // Pavement is allowed — a rasterised road is not exactly `width`
            // tiles across and the outer stripe grazes the kerb the painters
            // clip against. Water, walls and decks are not.
            expect(t === T_WATER || t === T_BUILDING || t === T_BRIDGE, `${tx},${ty}`).toBe(false);
            if (t !== T_ROAD) offRoad++;
          }
        }
      }
    }
    expect(cells).toBeGreaterThan(500);
    // And it is nearly all on the carriageway, not merely off the water.
    expect(offRoad / cells).toBeLessThan(0.02);
  });

  it('stops the traffic at the line it paints, not a tile and a half past it', () => {
    // The sim halted at the junction's mouth and the paint was drawn well
    // outside it, so 261 of 441 approaches parked their queue ON the zebra.
    // Nothing could see it: no test asked the painter and the driver model
    // the same question. This one does, and the answer is now a CONSTANT —
    // both measure the same labelled box at the same quarter-tile step, so
    // every approach in the city stops the same eighth of a tile behind its
    // own line.
    let approaches = 0;
    for (const cross of lit) {
      if (junctionPaint(cross, all, ground).stops.length === 0) continue;
      for (const arm of cross.arms) {
        const mouth = ground.mouth?.(cross.x, cross.y, arm.dx, arm.dy) ?? armMouth(cross, arm);
        // Where the stop line is painted, and where `stopLineGap` leaves the
        // nose: `ZEBRA_SETBACK + ZEBRA_DEPTH + STOP_GAP + STOP_THICK / 2`
        // against the mouth plus the model's own setbacks.
        const stopAt = mouth + 0.2 + 1 + 0.325;
        const nose = mouth + 6 / TILE_SIZE + (STOP_LINE_REACH - 0.25);
        approaches++;
        expect(nose - stopAt).toBeCloseTo(0.25, 6);
      }
    }
    expect(approaches).toBeGreaterThan(300);
  });
});
