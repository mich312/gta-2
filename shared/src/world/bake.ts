import { deriveSeed, seedRng } from '../rng/prng.js';
import { findDoorway, placeShopsFixed } from './amenities.js';
import { fillBlock } from './buildings.js';
import { fbm } from './fields.js';
import { buildLayout } from './layout.js';
import type { CityPlan, PlanLandmark } from './plan.js';
import {
  T_BANK,
  T_BRIDGE,
  T_BUILDING,
  T_FIELD,
  T_LOT,
  T_PARK,
  T_ROAD,
  T_RUNWAY,
  T_SAND,
  T_SIDEWALK,
  T_TREES,
  T_WATER,
  TILE_SIZE,
  type BlockRect,
  type Building,
  type DistrictType,
  type Landmark,
  type LandmarkKind,
  type Shop,
} from './types.js';

/**
 * The bake: the authored plan turned into the finished ground of the one city
 * — tiles, blocks, buildings, landmarks and shopfronts.
 *
 * This runs OFFLINE, once, from `pnpm citybake`, and its output is committed
 * as `city.data.ts` beside this file. The game never runs it. That is the
 * point of the whole change: what ships is a map somebody looked at and
 * accepted, not a program that will produce a different map tomorrow.
 */

/**
 * The one seed the bake draws on, for the things below the level anybody
 * would draw by hand: which of a block's building plots is a courtyard, where
 * the woodland thins. A constant, not a parameter — the city has no seed.
 */
const BAKE_SEED = 0x0a11ce;
const WILD_SEED = 0x7009d5;

export interface BakedCity {
  name: string;
  widthTiles: number;
  heightTiles: number;
  tiles: Uint8Array;
  district: Uint8Array;
  blocks: BlockRect[];
  buildings: Building[];
  landmarks: Landmark[];
  shops: Shop[];
}

/**
 * How each kind of landmark is built: the ground it stands on, and the solid
 * footprints stamped on top, as fractions or offsets of its authored rect.
 *
 * `apron` is what the rest of the landmark's city block becomes — a stadium
 * gets grass around it, a power station gets yard, a tower gets a plaza. It
 * is what stops a hand-placed landmark leaving a hole in the street wall.
 */
interface Recipe {
  ground: number;
  apron: number;
  parts: (w: number, h: number) => Array<[number, number, number, number]>;
}

const RECIPES: Record<LandmarkKind, Recipe> = {
  stadium: { ground: T_PARK, apron: T_PARK, parts: (w, h) => [[0, 0, w, h]] },
  power: {
    ground: T_LOT,
    apron: T_LOT,
    parts: (w, h) => [
      [0, 0, w, h - 3],
      [w - 4, h - 2, 3, 2],
    ],
  },
  tower: { ground: T_SIDEWALK, apron: T_SIDEWALK, parts: (w, h) => [[1, 1, w - 2, h - 2]] },
  hospital: { ground: T_LOT, apron: T_LOT, parts: (w, h) => [[0, 0, w, h]] },
  police: { ground: T_LOT, apron: T_LOT, parts: (w, h) => [[0, 0, w, h]] },
  // The country kinds: stamped on open ground, no block and no apron.
  farm: {
    ground: T_LOT,
    apron: T_LOT,
    parts: (w, h) => [
      [0, 0, 3, 3],
      [w - 4, h - 3, 4, 3],
    ],
  },
  campground: { ground: T_PARK, apron: T_PARK, parts: () => [[1, 1, 2, 2]] },
  lighthouse: { ground: T_FIELD, apron: T_FIELD, parts: (w, h) => [[0, 0, w, h]] },
  quarry: { ground: T_LOT, apron: T_LOT, parts: () => [[0, 0, 3, 3]] },
  // A long clear run and a hangar at one end: nothing else goes on it.
  airstrip: { ground: T_RUNWAY, apron: T_RUNWAY, parts: () => [[0, 0, 3, 3]] },
};

function paintable(t: number): boolean {
  return t !== T_WATER && t !== T_BANK && t !== T_SAND && t !== T_ROAD && t !== T_BRIDGE;
}

/**
 * The street network proper.
 *
 * Deliberately NOT "ground a car can stand on": a farmyard and a runway are
 * both drivable, and counting them would have the bake decide the farm was
 * already connected because the farm exists. What a driveway looks for is a
 * road.
 */
function onNetwork(t: number): boolean {
  return t === T_ROAD || t === T_BRIDGE;
}

/** Ground a track can be cut through: not a wall, not the sea. */
function cuttable(t: number): boolean {
  return (
    t === T_FIELD ||
    t === T_TREES ||
    t === T_PARK ||
    t === T_SIDEWALK ||
    t === T_SAND ||
    t === T_LOT ||
    t === T_RUNWAY
  );
}

/**
 * Cut a two-tile track from a door to the nearest road, if there is not one
 * within a couple of tiles already. Breadth-first over cuttable ground, so
 * the track is the shortest one that exists rather than a guess at a
 * direction.
 */
/**
 * Breadth-first scratch for `driveway`, allocated once for the whole bake
 * rather than per landmark — two and a half megabytes a time, two dozen
 * times, plus a full fill each. `era` is what makes reuse safe without
 * clearing: a cell belongs to this call only if its era matches.
 */
let drivewayFrom: Int32Array | null = null;
let drivewayEra: Int32Array | null = null;
let drivewayCall = 0;

function driveway(tiles: Uint8Array, W: number, H: number, dx: number, dy: number): void {
  const near = (x: number, y: number): boolean => {
    for (let oy = -2; oy <= 2; oy++) {
      for (let ox = -2; ox <= 2; ox++) {
        const nx = x + ox;
        const ny = y + oy;
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        if (onNetwork(tiles[ny * W + nx] as number)) return true;
      }
    }
    return false;
  };
  if (dx < 0 || dy < 0 || dx >= W || dy >= H || near(dx, dy)) return;

  if (drivewayFrom === null || drivewayFrom.length < W * H) {
    drivewayFrom = new Int32Array(W * H);
    drivewayEra = new Int32Array(W * H);
  }
  const from = drivewayFrom;
  const era = drivewayEra as Int32Array;
  const call = ++drivewayCall;
  const start = dy * W + dx;
  from[start] = start;
  era[start] = call;
  const queue = [start];
  let head = 0;
  let hit = -1;
  while (head < queue.length && hit < 0) {
    const i = queue[head++] as number;
    const x = i % W;
    const y = (i - x) / W;
    for (const [ox, oy] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ] as const) {
      const nx = x + ox;
      const ny = y + oy;
      if (nx < 1 || ny < 1 || nx >= W - 1 || ny >= H - 1) continue;
      const j = ny * W + nx;
      if (era[j] === call) continue;
      const t = tiles[j] as number;
      if (onNetwork(t)) {
        from[j] = i;
        era[j] = call;
        hit = j;
        break;
      }
      if (!cuttable(t)) continue;
      from[j] = i;
      era[j] = call;
      queue.push(j);
    }
  }
  if (hit < 0) return;
  for (let i = hit; i !== start; i = from[i] as number) {
    if (!onNetwork(tiles[i] as number)) tiles[i] = T_ROAD;
    // Two tiles wide, so it is a track and not a footpath.
    if (cuttable(tiles[i + 1] as number)) tiles[i + 1] = T_ROAD;
  }
}

export function bakeCity(plan: CityPlan): BakedCity {
  const layout = buildLayout(plan);
  const W = layout.widthTiles;
  const H = layout.heightTiles;

  // A landmark that overlaps the sea or a street is an authoring slip that
  // would otherwise bake silently: the stamp overwrites whatever is there, so
  // a hospital drawn two tiles too wide swallows the road beside it and
  // strands every street beyond. The plan has to be right; say which line is
  // wrong, and where.
  for (const l of plan.landmarks) {
    const [lx, ly, lw, lh] = l.rect;
    for (let ty = ly; ty < ly + lh; ty++) {
      for (let tx = lx; tx < lx + lw; tx++) {
        const t = layout.tiles[ty * W + tx] as number;
        if (layout.water[ty * W + tx] === 1) {
          throw new Error(`city plan: landmark ${l.name} at ${lx},${ly} stands in the water`);
        }
        if (t === T_ROAD || t === T_BRIDGE) {
          throw new Error(
            `city plan: landmark ${l.name} at ${lx},${ly} (${lw}x${lh}) is built over the road at ${tx},${ty}`,
          );
        }
      }
    }
  }
  const tiles = layout.tiles;
  const buildings: Building[] = [];
  const landmarks: Landmark[] = [];

  const ground = (x: number, y: number, w: number, h: number, tile: number): void => {
    for (let ty = Math.max(0, y); ty < Math.min(H, y + h); ty++) {
      for (let tx = Math.max(0, x); tx < Math.min(W, x + w); tx++) {
        const i = ty * W + tx;
        if (paintable(tiles[i] as number)) tiles[i] = tile;
      }
    }
  };
  const solid = (x: number, y: number, w: number, h: number, district: DistrictType): void => {
    for (let ty = Math.max(0, y); ty < Math.min(H, y + h); ty++) {
      for (let tx = Math.max(0, x); tx < Math.min(W, x + w); tx++) tiles[ty * W + tx] = T_BUILDING;
    }
    buildings.push({ x, y, w, h, district });
  };

  const stamp = (l: PlanLandmark): void => {
    const [x, y, w, h] = l.rect;
    const recipe = RECIPES[l.kind];
    const district = (['downtown', 'residential', 'industrial', 'commercial', 'park'] as const)[
      layout.district[y * W + x] as number
    ] as DistrictType;
    ground(x, y, w, h, recipe.ground);
    for (const [dx, dy, pw, ph] of recipe.parts(w, h)) {
      if (pw < 1 || ph < 1) continue;
      solid(x + dx, y + dy, pw, ph, district);
    }
    const door = findDoorway(
      { widthTiles: W, heightTiles: H, tiles } as never,
      { x, y, w, h, district },
    );
    landmarks.push({
      kind: l.kind,
      name: l.name,
      x,
      y,
      w,
      h,
      doorX: door ? (door.x + 0.5) * TILE_SIZE : (x + w / 2) * TILE_SIZE,
      doorY: door ? (door.y + 0.5) * TILE_SIZE : (y + h + 0.5) * TILE_SIZE,
    });
  };

  // Country landmarks go down BEFORE anything is built, because the meadow
  // fill only ever rewrites bare ground: stamped first, the farmyard and the
  // runway are simply not bare ground when the woodland arrives.
  const claimed = new Set(layout.blocks.filter((b) => b.landmark >= 0).map((b) => b.landmark));
  for (const [li, l] of plan.landmarks.entries()) if (!claimed.has(li)) stamp(l);

  // Every block is built, including the ones a landmark stands in.
  //
  // Claimed blocks used to be kerbed, surfaced and then left alone, which is
  // fine for a police station in a twelve-tile block and ruinous for a tower
  // standing in a hundred-tile park: the first drawn island came out with
  // eight thousand tiles of bare ground where its biggest park should have
  // been, because one landmark had claimed the block. The block is filled
  // like any other, and the landmark is cleared out of it afterwards.
  const wildAt = (tx: number, ty: number): boolean => fbm(WILD_SEED, tx / 22, ty / 22) >= 0.52;
  for (const b of layout.blocks) {
    const rng = seedRng(deriveSeed(BAKE_SEED, `block.${b.x}.${b.y}`));
    fillBlock(tiles, W, H, buildings, b, rng, wildAt);
  }

  // Then the landmark takes its plot back: anything built inside its footprint
  // or its apron is demolished, the ground surfaced, and a kerb laid round it
  // so the doorway pass has a pavement to find.
  const APRON = 4;
  for (const [li, l] of plan.landmarks.entries()) {
    if (!claimed.has(li)) continue;
    const [lx, ly, lw, lh] = l.rect;
    const x0 = lx - APRON;
    const y0 = ly - APRON;
    const x1 = lx + lw + APRON;
    const y1 = ly + lh + APRON;
    for (let bi = buildings.length - 1; bi >= 0; bi--) {
      const bd = buildings[bi] as Building;
      if (bd.x >= x1 || bd.x + bd.w <= x0 || bd.y >= y1 || bd.y + bd.h <= y0) continue;
      for (let ty = bd.y; ty < bd.y + bd.h; ty++) {
        for (let tx = bd.x; tx < bd.x + bd.w; tx++) {
          if (tx < 0 || ty < 0 || tx >= W || ty >= H) continue;
          if (tiles[ty * W + tx] === T_BUILDING) tiles[ty * W + tx] = T_FIELD;
        }
      }
      buildings.splice(bi, 1);
    }
    ground(x0, y0, x1 - x0, y1 - y0, RECIPES[l.kind].apron);
    for (let ty = ly - 1; ty <= ly + lh; ty++) {
      for (let tx = lx - 1; tx <= lx + lw; tx++) {
        const onRing = tx === lx - 1 || ty === ly - 1 || tx === lx + lw || ty === ly + lh;
        if (!onRing || tx < 0 || ty < 0 || tx >= W || ty >= H) continue;
        if (paintable(tiles[ty * W + tx] as number)) tiles[ty * W + tx] = T_SIDEWALK;
      }
    }
    stamp(l);
  }

  // Every landmark has a way in.
  //
  // A hand-placed farm two fields from the nearest lane is the one authoring
  // mistake that is easy to make and impossible to see on the picture, so the
  // bake fixes it rather than reporting it: shortest path from the door to
  // the road network over ground a track could be cut through, laid two tiles
  // wide. Nothing is cut through a building or across water, so a landmark
  // walled in by both simply keeps no drive and the checker says so.
  for (const l of landmarks) driveway(tiles, W, H, Math.floor(l.doorX / TILE_SIZE), Math.floor(l.doorY / TILE_SIZE));

  // Woodland keeps its distance from the places you are meant to drive to.
  for (const l of plan.landmarks) {
    const [x, y, w, h] = l.rect;
    for (let ty = Math.max(0, y - 3); ty < Math.min(H, y + h + 3); ty++) {
      for (let tx = Math.max(0, x - 3); tx < Math.min(W, x + w + 3); tx++) {
        if (tiles[ty * W + tx] === T_TREES) tiles[ty * W + tx] = T_FIELD;
      }
    }
  }

  const blocks: BlockRect[] = layout.blocks.map((b) => ({
    x: b.x,
    y: b.y,
    w: b.w,
    h: b.h,
    district: b.district,
    density: b.density,
    ...(b.rural ? { rural: true } : {}),
  }));

  const baked: BakedCity = {
    name: plan.name,
    widthTiles: W,
    heightTiles: H,
    tiles,
    district: layout.district,
    blocks,
    buildings,
    landmarks,
    shops: [],
  };
  baked.shops = placeShopsFixed(baked, plan.shopQuota, plan.shopSpacingTiles);
  return baked;
}

/* ------------------------------------------------------------------ */
/* The wire form of the finished city.                                 */
/* ------------------------------------------------------------------ */

/**
 * Run-length encoding of a tile plane, base64'd.
 *
 * A city is a hundred and fifty thousand tiles and most of them are the same
 * as the one before — streets run, blocks are solid, the sea is the sea. Runs
 * take it to a few tens of kilobytes, which is small enough to sit in the
 * client bundle and be read by both hosts without a fetch.
 */
function encodePlane(plane: Uint8Array): string {
  const out: number[] = [];
  let i = 0;
  while (i < plane.length) {
    const v = plane[i] as number;
    let n = 1;
    while (i + n < plane.length && plane[i + n] === v && n < 255) n++;
    out.push(v, n);
    i += n;
  }
  return toBase64(out);
}

function decodePlane(text: string, length: number): Uint8Array {
  const bin = fromBase64(text);
  const plane = new Uint8Array(length);
  let at = 0;
  for (let i = 0; i + 1 < bin.length; i += 2) {
    const v = bin[i] as number;
    const n = bin[i + 1] as number;
    plane.fill(v, at, at + n);
    at += n;
  }
  if (at !== length) throw new Error(`city: encoded plane is ${at} tiles, expected ${length}`);
  return plane;
}

/**
 * Base64, written out rather than borrowed.
 *
 * `btoa`/`atob` are in both hosts and `Buffer` is in one of them, but shared/
 * is compiled with no DOM and no Node types on purpose — it is the package
 * both other packages import, and the day it depends on one host's globals is
 * the day the other one stops building. Sixteen lines is a cheaper price than
 * that.
 */
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function toBase64(bytes: readonly number[]): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i] as number;
    const b = i + 1 < bytes.length ? (bytes[i + 1] as number) : 0;
    const c = i + 2 < bytes.length ? (bytes[i + 2] as number) : 0;
    const n = (a << 16) | (b << 8) | c;
    out += B64[(n >>> 18) & 63] as string;
    out += B64[(n >>> 12) & 63] as string;
    out += i + 1 < bytes.length ? (B64[(n >>> 6) & 63] as string) : '=';
    out += i + 2 < bytes.length ? (B64[n & 63] as string) : '=';
  }
  return out;
}

function fromBase64(text: string): Uint8Array {
  const clean = text.replace(/=+$/, '');
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let at = 0;
  let acc = 0;
  let bits = 0;
  for (const ch of clean) {
    const v = B64.indexOf(ch);
    if (v < 0) throw new Error('city: bad base64 in the baked map');
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[at++] = (acc >>> bits) & 0xff;
    }
  }
  return out.subarray(0, at);
}

export function encodeBakedCity(city: BakedCity): string {
  return JSON.stringify(
    {
      name: city.name,
      widthTiles: city.widthTiles,
      heightTiles: city.heightTiles,
      tiles: encodePlane(city.tiles),
      district: encodePlane(city.district),
      blocks: city.blocks,
      buildings: city.buildings,
      landmarks: city.landmarks,
      shops: city.shops,
    },
    null,
    0,
  );
}

export function decodeBakedCity(raw: unknown): BakedCity {
  const r = raw as Record<string, unknown>;
  const widthTiles = r['widthTiles'] as number;
  const heightTiles = r['heightTiles'] as number;
  const n = widthTiles * heightTiles;
  return {
    name: r['name'] as string,
    widthTiles,
    heightTiles,
    tiles: decodePlane(r['tiles'] as string, n),
    district: decodePlane(r['district'] as string, n),
    blocks: r['blocks'] as BlockRect[],
    buildings: r['buildings'] as Building[],
    landmarks: r['landmarks'] as Landmark[],
    shops: r['shops'] as Shop[],
  };
}
