import { getTuning } from '../tuning.js';
import { dCos, dSin } from '../math/trig.js';
import { TILE_SIZE, type CityMap } from './types.js';
import type { WorldgenParams } from './params.js';

/**
 * Who owns which part of the city.
 *
 * A Voronoi partition rather than a per-cell roll: territory has to be
 * *contiguous* to read as territory. Confetti — this block theirs, the next
 * block somebody else's — is indistinguishable from noise, and the whole
 * point of turf is that you can learn where you are and are not welcome.
 *
 * Home points are spread evenly around a ring, so the partition is a pure
 * function of the map's dimensions: the same seed always draws the same
 * territory, and no rng is consumed — adding this shifted nobody else's
 * worldgen.
 *
 * The shape of the partition lives in worldgen.json rather than gangs.json
 * because worldgen must not depend on runtime tuning being initialised;
 * several tests generate a city at module scope, before any initTuning().
 */
export function assignTurf(map: CityMap, params: WorldgenParams): void {
  const count = Math.max(0, Math.round(params.turf.gangCount));
  if (count === 0) {
    map.turfCells = new Uint8Array(0);
    map.turfCellsWide = 0;
    map.turfHomes = [];
    return;
  }

  const cell = Math.max(1, Math.round(params.turf.cellTiles));
  const cw = Math.ceil(map.widthTiles / cell);
  const ch = Math.ceil(map.heightTiles / cell);

  // Home points around the city — but NOT on a perfect ring. Evenly spaced
  // at equal radius produced four identical wedges meeting at a point in the
  // middle: geometrically correct, and unmistakably a pie chart. Staggering
  // the angle and the distance gives each gang a differently-shaped patch,
  // which is what territory actually looks like.
  const homes: Array<{ x: number; y: number; gang: number }> = [];
  const cx = map.widthTiles / 2;
  const cy = map.heightTiles / 2;
  const span = Math.min(map.widthTiles, map.heightTiles);
  for (let i = 0; i < count; i++) {
    // Fixed irregular offsets: a pure function of the index, so the map is
    // still identical for the same seed on every host. `dCos`/`dSin` for the
    // same reason — `Math.cos` is not pinned by ECMA-262, so "every host" was
    // only true of hosts that happen to share an engine.
    const angle =
      (i / count) * Math.PI * 2 + (ANGLE_STAGGER[i % ANGLE_STAGGER.length] as number);
    const radius = span * (RADIUS_STAGGER[i % RADIUS_STAGGER.length] as number);
    homes.push({
      x: cx + dCos(angle) * radius,
      y: cy + dSin(angle) * radius,
      // Gang ids are 1..N by construction, matching gangs.json.
      gang: i + 1,
    });
  }

  const cells = new Uint8Array(cw * ch);
  for (let y = 0; y < ch; y++) {
    for (let x = 0; x < cw; x++) {
      const tx = x * cell + cell / 2;
      const ty = y * cell + cell / 2;
      // A little deterministic wobble on the comparison, so borders follow a
      // ragged line rather than a ruler. Small enough that territory stays
      // contiguous — the test asserts neighbouring cells agree >85% of the
      // time, which a straight-line partition passes trivially and confetti
      // does not.
      const jitter = 1 + WOBBLE * (hash2(x, y) - 0.5);
      let best = homes[0] as { x: number; y: number; gang: number };
      let bestD = Infinity;
      for (const h of homes) {
        const dx = h.x - tx;
        const dy = h.y - ty;
        const d = (dx * dx + dy * dy) * jitter;
        if (d < bestD) {
          bestD = d;
          best = h;
        }
      }
      cells[y * cw + x] = best.gang;
    }
  }
  map.turfCells = cells;
  map.turfCellsWide = cw;
  map.turfCellTiles = cell;
  map.turfHomes = homes.map((h) => ({
    x: h.x * TILE_SIZE,
    y: h.y * TILE_SIZE,
    gang: h.gang,
  }));
}

/** Irregularity, all fixed constants so the partition stays a pure function. */
const ANGLE_STAGGER = [0.0, 0.55, -0.3, 0.85, 0.2, -0.6, 0.4, -0.15];
const RADIUS_STAGGER = [0.34, 0.22, 0.4, 0.27, 0.36, 0.25, 0.31, 0.38];
/** How far a cell's distance test may be nudged, as a fraction. */
const WOBBLE = 0.12;

/** Deterministic 0..1 from a cell coordinate. No rng, no state. */
function hash2(x: number, y: number): number {
  let h = Math.imul(x, 374761393) ^ Math.imul(y, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Which gang holds the ground at a world position. 0 if nobody does. */
/**
 * Hand every seventh parked car on a gang's ground to that gang.
 *
 * Runs as part of turf assignment rather than parking placement, because
 * parking is placed before the turf exists — doing it there marked every car
 * as nobody's. One field, written once at generation, that pays for a livery,
 * a place to find one, and a reason not to take it.
 */
export function markGangCars(map: CityMap, params: WorldgenParams): void {
  for (const spot of map.parkingSpots) {
    // Every seventh KERB, not every seventh entry in this list: hashed off
    // the tile the car stands on, so which cars fly gang colours is a fact
    // about the street rather than about the order the list came out in.
    const tx = Math.floor(spot.x / TILE_SIZE);
    const ty = Math.floor(spot.y / TILE_SIZE);
    if ((Math.imul(tx, 73856093) ^ Math.imul(ty, 19349663)) % 7 !== 0) continue;
    const gang = gangAt(map, spot.x, spot.y);
    if (gang === 0) continue;
    spot.gangId = gang;
    spot.kind = 'gangcar';
  }
}

export function gangAt(map: CityMap, x: number, y: number): number {
  if (map.turfCellsWide === 0) return 0;
  const cell = map.turfCellTiles;
  const cxi = Math.floor(x / TILE_SIZE / cell);
  const cyi = Math.floor(y / TILE_SIZE / cell);
  if (cxi < 0 || cyi < 0 || cxi >= map.turfCellsWide) return 0;
  const idx = cyi * map.turfCellsWide + cxi;
  return idx >= 0 && idx < map.turfCells.length ? (map.turfCells[idx] as number) : 0;
}

/** The gangs that count this one's losses as their gains. */
export function rivalsOf(gangId: number): number[] {
  return getTuning().gangs.gangs.find((g) => g.id === gangId)?.rivals ?? [];
}

export function gangName(gangId: number): string {
  return getTuning().gangs.gangs.find((g) => g.id === gangId)?.name ?? 'nobody';
}
