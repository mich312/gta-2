import { getTuning } from '../tuning.js';
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

  // Home points, evenly spaced around a ring centred on the city.
  const homes: Array<{ x: number; y: number; gang: number }> = [];
  const cx = map.widthTiles / 2;
  const cy = map.heightTiles / 2;
  const radius = Math.min(map.widthTiles, map.heightTiles) * 0.32;
  for (let i = 0; i < count; i++) {
    const angle = (i / count) * Math.PI * 2;
    homes.push({
      x: cx + Math.cos(angle) * radius,
      y: cy + Math.sin(angle) * radius,
      // Gang ids are 1..N by construction, matching gangs.json.
      gang: i + 1,
    });
  }

  const cells = new Uint8Array(cw * ch);
  for (let y = 0; y < ch; y++) {
    for (let x = 0; x < cw; x++) {
      const tx = x * cell + cell / 2;
      const ty = y * cell + cell / 2;
      let best = homes[0] as { x: number; y: number; gang: number };
      let bestD = Infinity;
      for (const h of homes) {
        const dx = h.x - tx;
        const dy = h.y - ty;
        const d = dx * dx + dy * dy;
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

/** Which gang holds the ground at a world position. 0 if nobody does. */
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
