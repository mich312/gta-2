import { getTuning } from '../tuning.js';
import { T_BRIDGE, T_WATER, TILE_SIZE, type CityMap } from './types.js';
import type { WorldgenParams } from './params.js';

/**
 * Who owns which part of the city.
 *
 * A Voronoi partition rather than a per-cell roll: territory has to be
 * *contiguous* to read as territory. Confetti — this block theirs, the next
 * block somebody else's — is indistinguishable from noise, and the whole
 * point of turf is that you can learn where you are and are not welcome.
 *
 * It grows the partition over the GROUND, from authored anchors, and this is
 * the second attempt. The first spread seven home points on a staggered ring
 * and partitioned the whole 768x768 square by straight-line distance, which
 * meant territory had never seen the map: the city is half water, so one
 * gang's manor came out 88% open sea and 8,202 tiles of land against another's
 * 77,517 — nine and a half times the ground — while every gang straddled two
 * to four boroughs and every borough was split between two to four gangs. The
 * one property a player can read off the map, that this is the Old Quarter and
 * those are the docks, carried no information about whose turf they stood on
 * (`REVIEW-MAPDESIGN.md` §2.5).
 *
 * So: one authored anchor per gang, and the partition is grown from them by
 * distance *through land* rather than across it. Three things follow that the
 * ring could not give. A manor cannot spill across a strait it has no bridge
 * to. Water belongs to nobody — gang 0 — because a stretch of sea is not
 * territory and the radar should not tint it. And ground no anchor can walk to
 * (Gannet Rock's plateau, the barrier islets) is nobody's as well, which is
 * the truth about it.
 *
 * Still no rng: the anchors are authored, the borders' ragged edge comes off a
 * hash of the cell, and the same map always partitions the same way.
 *
 * The shape of the partition lives in worldgen.json rather than gangs.json
 * because worldgen must not depend on runtime tuning being initialised;
 * several tests generate a city at module scope, before any initTuning(). The
 * gangs' names, colours and rivalries stay in gangs.json.
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

  // Which cells are ground. A cell is a piece of the city when a third of it
  // is dry; anything less is sea with a rock in it, and tinting it on the
  // radar would put a gang's colour out over the water.
  //
  // A cell with a bridge deck through it is ground whatever its water, and
  // that exception is load-bearing rather than tidy-minded. A four-lane deck
  // fills exactly a third of a twelve-tile cell, so at the plain threshold
  // some crossings joined the two banks and some did not, and Port Vasco —
  // an island with two bridges — came out with no border against anybody at
  // all. A gang with no border has no rival it can ever meet, which quietly
  // switches off everything §H1 built. Decks are also the right place for a
  // border to fall: contested ground on a bridge is the fight the map should
  // be picking.
  const landCells = new Uint8Array(cw * ch);
  const need = Math.max(1, Math.floor((cell * cell) / 3));
  for (let y = 0; y < ch; y++) {
    for (let x = 0; x < cw; x++) {
      let dry = 0;
      let deck = false;
      for (let ty = y * cell; ty < Math.min(map.heightTiles, (y + 1) * cell); ty++) {
        for (let tx = x * cell; tx < Math.min(map.widthTiles, (x + 1) * cell); tx++) {
          const t = map.tiles[ty * map.widthTiles + tx] as number;
          if (t !== T_WATER) dry++;
          if (t === T_BRIDGE) deck = true;
        }
      }
      if (deck || dry >= need) landCells[y * cw + x] = 1;
    }
  }

  // The anchors. Authored where the plan has been looked at; on the old ring
  // where it has not, so a generated plan or a fixture still gets territory.
  const wanted: Array<{ x: number; y: number; gang: number }> =
    params.turf.homes.length === count
      ? params.turf.homes.map((h) => ({ x: h.x, y: h.y, gang: h.gang }))
      : Array.from({ length: count }, (_, i) => {
          const angle =
            (i / count) * Math.PI * 2 + (ANGLE_STAGGER[i % ANGLE_STAGGER.length] as number);
          const radius =
            Math.min(map.widthTiles, map.heightTiles) *
            (RADIUS_STAGGER[i % RADIUS_STAGGER.length] as number);
          return {
            x: map.widthTiles / 2 + Math.cos(angle) * radius,
            y: map.heightTiles / 2 + Math.sin(angle) * radius,
            gang: i + 1,
          };
        });

  // An anchor has to sit on ground, or its gang holds nothing and the failure
  // reads as a missing colour rather than as a mistake. One that does not —
  // an authored point a re-cut coastline has drowned, a ring point out at sea
  // on a map nobody drew these for — takes the nearest free land cell.
  const cells = new Uint8Array(cw * ch);
  const homes: Array<{ x: number; y: number; gang: number }> = [];
  const claimed = new Set<number>();
  const queue: number[] = [];
  const dist = new Float64Array(cw * ch).fill(Infinity);
  for (const w of wanted) {
    const hx = Math.min(cw - 1, Math.max(0, Math.floor(w.x / cell)));
    const hy = Math.min(ch - 1, Math.max(0, Math.floor(w.y / cell)));
    let seat = -1;
    for (let r = 0; r < Math.max(cw, ch) && seat < 0; r++) {
      for (let dy = -r; dy <= r && seat < 0; dy++) {
        for (let dx = -r; dx <= r && seat < 0; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          const nx = hx + dx;
          const ny = hy + dy;
          if (nx < 0 || ny < 0 || nx >= cw || ny >= ch) continue;
          const i = ny * cw + nx;
          if (landCells[i] === 1 && !claimed.has(i)) seat = i;
        }
      }
    }
    if (seat < 0) continue;
    claimed.add(seat);
    cells[seat] = w.gang;
    dist[seat] = 0;
    queue.push(seat);
    homes.push({ x: (seat % cw) * cell + cell / 2, y: Math.floor(seat / cw) * cell + cell / 2, gang: w.gang });
  }

  // Grow every manor at once, outward from its anchor, over ground. Distance
  // is through the city and not across it — the two halves of a step cost 2,
  // plus a deterministic 0 or 1 off the cell's hash so a border follows a
  // ragged line rather than a ruler (which is what WOBBLE used to be for).
  // Dijkstra rather than a plain flood because of that extra tile of cost.
  for (let head = 0; head < queue.length; head++) {
    // Cheapest-first, by scanning the frontier: the costs here are 2 or 3, so
    // the queue is very nearly sorted already and a heap is not worth its own
    // bugs on a grid of four thousand cells.
    let pick = head;
    for (let k = head + 1; k < queue.length; k++) {
      if ((dist[queue[k] as number] as number) < (dist[queue[pick] as number] as number)) pick = k;
    }
    const tmp = queue[head] as number;
    queue[head] = queue[pick] as number;
    queue[pick] = tmp;

    const i = queue[head] as number;
    const x = i % cw;
    const y = (i - x) / cw;
    const step = 2 + (hash2(x, y) < 0.5 ? 0 : 1);
    for (const [dx, dy] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ] as const) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= cw || ny >= ch) continue;
      const j = ny * cw + nx;
      if (landCells[j] === 0) continue;
      const d = (dist[i] as number) + step;
      if (d >= (dist[j] as number)) continue;
      dist[j] = d;
      cells[j] = cells[i] as number;
      queue.push(j);
    }
  }

  // One pass along the shore. A manor grown over cells that are a third dry
  // stops a cell short of the water, which left three payphones out of 319 on
  // a coastal tip belonging to nobody — and `missions.ts` answers a phone on
  // nobody's corner with "nobody works this corner", which is the right answer
  // to the wrong question when the corner is the end of a street in North
  // Point. A cell with any dry ground in it, touching a manor, is that manor's
  // shoreline. One round only, deliberately: repeated, it would crawl along a
  // sandbar and claim an island nobody can drive to.
  const fringe = cells.slice();
  for (let y = 0; y < ch; y++) {
    for (let x = 0; x < cw; x++) {
      const i = y * cw + x;
      if (cells[i] !== 0 || landCells[i] === 1) continue;
      let dry = false;
      for (let ty = y * cell; ty < Math.min(map.heightTiles, (y + 1) * cell) && !dry; ty++) {
        for (let tx = x * cell; tx < Math.min(map.widthTiles, (x + 1) * cell) && !dry; tx++) {
          if (map.tiles[ty * map.widthTiles + tx] !== T_WATER) dry = true;
        }
      }
      if (!dry) continue;
      // Lowest gang id among the neighbours, so a corner between two manors
      // is settled the same way on every host.
      let owner = 0;
      for (const [dx, dy] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ] as const) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= cw || ny >= ch) continue;
        const g = cells[ny * cw + nx] as number;
        if (g !== 0 && (owner === 0 || g < owner)) owner = g;
      }
      fringe[i] = owner;
    }
  }

  map.turfCells = fringe;
  map.turfCellsWide = cw;
  map.turfCellTiles = cell;
  map.turfHomes = homes.map((h) => ({
    x: h.x * TILE_SIZE,
    y: h.y * TILE_SIZE,
    gang: h.gang,
  }));
}

/**
 * The fallback ring's irregularity, for a map whose shape nobody has drawn
 * anchors for. All fixed constants, so the partition stays a pure function.
 */
const ANGLE_STAGGER = [0.0, 0.55, -0.3, 0.85, 0.2, -0.6, 0.4, -0.15];
const RADIUS_STAGGER = [0.34, 0.22, 0.4, 0.27, 0.36, 0.25, 0.31, 0.38];

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
