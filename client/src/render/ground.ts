import {
  type CityMap,
  type Vec2,
  DISTRICT_TYPES,
  INTERNAL_HEIGHT,
  INTERNAL_WIDTH,
  T_BUILDING,
  T_FIELD,
  T_LOT,
  T_PARK,
  T_ROAD,
  T_SAND,
  T_SIDEWALK,
  T_WATER,
  TILE_SIZE,
  districtAt,
  tileAt,
} from 'shared';
import palette from 'shared/data/palette.json';
import { CHUNK_CACHE_MAX, CHUNK_TILES } from './style.js';
import { VisualStream, hash01, hashPick, mix, shade } from './visualRng.js';

/**
 * Chunked ground renderer. The tile layer is baked into offscreen canvases
 * (CHUNK_TILES² tiles each) with all the per-tile detailing — asphalt
 * speckle, lane paint, curbs, slab seams, cracks, grass dither — so the
 * per-frame cost is ~30 drawImage calls regardless of how ornate the ground
 * art gets. Chunks are cached LRU and keyed by chunk index; every mark is a
 * pure function of (map seed, tile coords), so revisiting a street always
 * looks identical.
 */

const CHUNK_PX = CHUNK_TILES * TILE_SIZE;

interface Chunk {
  canvas: HTMLCanvasElement;
  lastUsed: number;
}

export class GroundRenderer {
  private readonly chunks = new Map<number, Chunk>();
  private readonly chunksX: number;
  private frame = 0;

  constructor(private readonly map: CityMap) {
    this.chunksX = Math.ceil(map.widthTiles / CHUNK_TILES);
  }

  draw(ctx: CanvasRenderingContext2D, cam: Vec2): void {
    this.frame++;
    const c0x = Math.max(0, Math.floor(cam.x / CHUNK_PX));
    const c0y = Math.max(0, Math.floor(cam.y / CHUNK_PX));
    const c1x = Math.floor((cam.x + INTERNAL_WIDTH) / CHUNK_PX);
    const c1y = Math.floor((cam.y + INTERNAL_HEIGHT) / CHUNK_PX);
    const maxCx = Math.ceil(this.map.widthTiles / CHUNK_TILES) - 1;
    const maxCy = Math.ceil(this.map.heightTiles / CHUNK_TILES) - 1;

    for (let cy = c0y; cy <= Math.min(c1y, maxCy); cy++) {
      for (let cx = c0x; cx <= Math.min(c1x, maxCx); cx++) {
        const chunk = this.chunk(cx, cy);
        ctx.drawImage(chunk.canvas, cx * CHUNK_PX - cam.x, cy * CHUNK_PX - cam.y);
      }
    }
    this.evict();
  }

  /**
   * Animated glints over visible water, drawn per frame above the baked
   * chunks. Cheap: a hash decides which tiles glint; time drives the alpha.
   */
  drawShimmer(ctx: CanvasRenderingContext2D, cam: Vec2, nowMs: number): void {
    const t0x = Math.max(0, Math.floor(cam.x / TILE_SIZE));
    const t0y = Math.max(0, Math.floor(cam.y / TILE_SIZE));
    const t1x = Math.min(this.map.widthTiles - 1, Math.floor((cam.x + INTERNAL_WIDTH) / TILE_SIZE));
    const t1y = Math.min(this.map.heightTiles - 1, Math.floor((cam.y + INTERNAL_HEIGHT) / TILE_SIZE));
    for (let ty = t0y; ty <= t1y; ty++) {
      for (let tx = t0x; tx <= t1x; tx++) {
        if (tileAt(this.map, tx, ty) !== T_WATER) continue;
        const h = hash01(this.map.seed ^ 0x91b, tx, ty);
        if (h > 0.10) continue;
        const phase = h * 62.8;
        const a = 0.05 + 0.09 * (0.5 + 0.5 * Math.sin(nowMs / 640 + phase));
        ctx.fillStyle = `rgba(200, 226, 232, ${a.toFixed(3)})`;
        const ox = Math.floor(h * 1290) % (TILE_SIZE - 4);
        const oy = Math.floor(h * 7130) % (TILE_SIZE - 1);
        ctx.fillRect(tx * TILE_SIZE - cam.x + ox, ty * TILE_SIZE - cam.y + oy, 4, 1);
      }
    }
  }

  private chunk(cx: number, cy: number): Chunk {
    const key = cy * this.chunksX + cx;
    const hit = this.chunks.get(key);
    if (hit) {
      hit.lastUsed = this.frame;
      return hit;
    }
    const canvas = document.createElement('canvas');
    canvas.width = CHUNK_PX;
    canvas.height = CHUNK_PX;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('no 2d context for ground chunk');
    ctx.imageSmoothingEnabled = false;
    bakeChunk(ctx, this.map, cx, cy);
    const chunk: Chunk = { canvas, lastUsed: this.frame };
    this.chunks.set(key, chunk);
    return chunk;
  }

  private evict(): void {
    if (this.chunks.size <= CHUNK_CACHE_MAX) return;
    let oldestKey = -1;
    let oldest = Infinity;
    for (const [k, c] of this.chunks) {
      if (c.lastUsed < oldest) {
        oldest = c.lastUsed;
        oldestKey = k;
      }
    }
    if (oldestKey !== -1) this.chunks.delete(oldestKey);
  }
}

function bakeChunk(ctx: CanvasRenderingContext2D, map: CityMap, cx: number, cy: number): void {
  const t0x = cx * CHUNK_TILES;
  const t0y = cy * CHUNK_TILES;
  for (let dy = 0; dy < CHUNK_TILES; dy++) {
    for (let dx = 0; dx < CHUNK_TILES; dx++) {
      const tx = t0x + dx;
      const ty = t0y + dy;
      if (tx >= map.widthTiles || ty >= map.heightTiles) continue;
      paintTile(ctx, map, tx, ty, dx * TILE_SIZE, dy * TILE_SIZE);
    }
  }
}

function paintTile(
  ctx: CanvasRenderingContext2D,
  map: CityMap,
  tx: number,
  ty: number,
  sx: number,
  sy: number,
): void {
  const tile = tileAt(map, tx, ty);
  switch (tile) {
    case T_ROAD:
      paintRoad(ctx, map, tx, ty, sx, sy);
      break;
    case T_SIDEWALK:
      paintSidewalk(ctx, map, tx, ty, sx, sy);
      break;
    case T_PARK:
      paintGrass(ctx, map, tx, ty, sx, sy, palette.park, 0.22);
      break;
    case T_FIELD:
      paintGrass(ctx, map, tx, ty, sx, sy, palette.field, 0.05);
      break;
    case T_LOT:
      paintLot(ctx, map, tx, ty, sx, sy);
      break;
    case T_WATER:
      paintWater(ctx, map, tx, ty, sx, sy);
      break;
    case T_SAND:
      paintSand(ctx, map, tx, ty, sx, sy);
      break;
    case T_BUILDING: {
      // Foundation floor; the extrusion pass draws the visible structure.
      const d = DISTRICT_TYPES[map.district[ty * map.widthTiles + tx] as number] as string;
      const base = (palette.building as Record<string, string>)[d] ?? palette.building.downtown;
      ctx.fillStyle = shade(base, -0.62);
      ctx.fillRect(sx, sy, TILE_SIZE, TILE_SIZE);
      break;
    }
    default:
      ctx.fillStyle = '#ff00ff';
      ctx.fillRect(sx, sy, TILE_SIZE, TILE_SIZE);
  }
}

// ------------------------------------------------------------------- roads

/** Width of the contiguous road span through (tx,ty) along one axis. */
function roadSpan(
  map: CityMap,
  tx: number,
  ty: number,
  stepX: number,
  stepY: number,
): { before: number; width: number } {
  let before = 0;
  while (before < 8 && tileAt(map, tx - stepX * (before + 1), ty - stepY * (before + 1)) === T_ROAD) {
    before++;
  }
  let after = 0;
  while (after < 8 && tileAt(map, tx + stepX * (after + 1), ty + stepY * (after + 1)) === T_ROAD) {
    after++;
  }
  return { before, width: before + after + 1 };
}

/** True when (tx,ty) sits inside an intersection box (long spans both ways). */
function isIntersectionAt(map: CityMap, tx: number, ty: number): boolean {
  if (tileAt(map, tx, ty) !== T_ROAD) return false;
  return roadSpan(map, tx, ty, 1, 0).width > 6 && roadSpan(map, tx, ty, 0, 1).width > 6;
}

function paintRoad(
  ctx: CanvasRenderingContext2D,
  map: CityMap,
  tx: number,
  ty: number,
  sx: number,
  sy: number,
): void {
  const seed = map.seed;
  // Asphalt with a hair of per-tile tonal drift.
  const drift = (hash01(seed ^ 0xa5f, tx, ty) - 0.5) * 0.07;
  ctx.fillStyle = shade(palette.road, drift);
  ctx.fillRect(sx, sy, TILE_SIZE, TILE_SIZE);

  // Speckle: worn aggregate.
  const s = new VisualStream(seed ^ 0x0ad, tx, ty);
  for (let i = 0; i < 5; i++) {
    const x = s.int(TILE_SIZE);
    const y = s.int(TILE_SIZE);
    ctx.fillStyle = s.chance(0.5) ? 'rgba(255,255,255,0.035)' : 'rgba(0,0,0,0.08)';
    ctx.fillRect(sx + x, sy + y, 1, 1);
  }

  // Span along each axis; the corridor axis reads long (capped at 17), the
  // crossing axis reads the road's true width. Both long ⇒ an intersection.
  const h = roadSpan(map, tx, ty, 1, 0);
  const v = roadSpan(map, tx, ty, 0, 1);
  const isIntersection = h.width > 6 && v.width > 6;

  if (!isIntersection) {
    ctx.fillStyle = 'rgba(214, 190, 96, 0.55)';
    if (h.width >= v.width && v.width >= 2 && v.width <= 6) {
      // Horizontal corridor: the lane boundary is the top edge of the tile
      // with exactly width/2 road rows above it (even widths only).
      if (v.width % 2 === 0 && v.before === v.width / 2) {
        ctx.fillRect(sx + 3, sy, 7, 1);
      }
      if (tileAt(map, tx, ty - 1) === T_SIDEWALK) {
        ctx.fillStyle = 'rgba(0,0,0,0.18)';
        ctx.fillRect(sx, sy, TILE_SIZE, 1);
      }
      if (tileAt(map, tx, ty + 1) === T_SIDEWALK) {
        ctx.fillStyle = 'rgba(0,0,0,0.18)';
        ctx.fillRect(sx, sy + TILE_SIZE - 1, TILE_SIZE, 1);
      }
    } else if (v.width > h.width && h.width >= 2 && h.width <= 6) {
      if (h.width % 2 === 0 && h.before === h.width / 2) {
        ctx.fillRect(sx, sy + 3, 1, 7);
      }
      if (tileAt(map, tx - 1, ty) === T_SIDEWALK) {
        ctx.fillStyle = 'rgba(0,0,0,0.18)';
        ctx.fillRect(sx, sy, 1, TILE_SIZE);
      }
      if (tileAt(map, tx + 1, ty) === T_SIDEWALK) {
        ctx.fillStyle = 'rgba(0,0,0,0.18)';
        ctx.fillRect(sx + TILE_SIZE - 1, sy, 1, TILE_SIZE);
      }
    }
  }

  // Zebra crossings where a corridor meets an intersection box.
  if (!isIntersection) {
    ctx.fillStyle = 'rgba(222, 226, 230, 0.38)';
    if (h.width >= v.width && v.width >= 2 && v.width <= 6) {
      if (isIntersectionAt(map, tx + 1, ty)) {
        for (let yy = 1; yy < TILE_SIZE - 1; yy += 4) ctx.fillRect(sx + TILE_SIZE - 7, sy + yy, 5, 2);
      }
      if (isIntersectionAt(map, tx - 1, ty)) {
        for (let yy = 1; yy < TILE_SIZE - 1; yy += 4) ctx.fillRect(sx + 2, sy + yy, 5, 2);
      }
    } else if (v.width > h.width && h.width >= 2 && h.width <= 6) {
      if (isIntersectionAt(map, tx, ty + 1)) {
        for (let xx = 1; xx < TILE_SIZE - 1; xx += 4) ctx.fillRect(sx + xx, sy + TILE_SIZE - 7, 2, 5);
      }
      if (isIntersectionAt(map, tx, ty - 1)) {
        for (let xx = 1; xx < TILE_SIZE - 1; xx += 4) ctx.fillRect(sx + xx, sy + 2, 2, 5);
      }
    }
  }

  // Occasional manhole cover.
  if (hash01(seed ^ 0x33c, tx, ty) < 0.02) {
    const mx = sx + 8;
    const my = sy + 8;
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.beginPath();
    ctx.arc(mx, my, 3.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = 'rgba(140,146,156,0.5)';
    ctx.beginPath();
    ctx.arc(mx, my, 2.5, 0, Math.PI * 2);
    ctx.fill();
  }
}

// --------------------------------------------------------------- sidewalks

function paintSidewalk(
  ctx: CanvasRenderingContext2D,
  map: CityMap,
  tx: number,
  ty: number,
  sx: number,
  sy: number,
): void {
  const seed = map.seed;
  // Pavement leans toward its district's hue — downtown cool, industrial
  // grimy, residential warm — so crossing a district line is felt underfoot.
  const tint = (palette.sidewalkTint as Record<string, string>)[districtAt(map, tx, ty)];
  const base = tint ? mix(palette.sidewalk, tint, 0.35) : palette.sidewalk;
  const drift = (hash01(seed ^ 0x51d, tx, ty) - 0.5) * 0.09;
  ctx.fillStyle = shade(base, drift);
  ctx.fillRect(sx, sy, TILE_SIZE, TILE_SIZE);

  // Slab seams on the tile grid.
  ctx.fillStyle = 'rgba(0,0,0,0.12)';
  ctx.fillRect(sx, sy, TILE_SIZE, 1);
  ctx.fillRect(sx, sy, 1, TILE_SIZE);

  // Hairline cracks.
  const s = new VisualStream(seed ^ 0xc4a, tx, ty);
  if (s.chance(0.16)) {
    ctx.strokeStyle = 'rgba(0,0,0,0.16)';
    ctx.beginPath();
    let x = sx + s.int(TILE_SIZE);
    let y = sy + s.int(6);
    ctx.moveTo(x, y);
    for (let i = 0; i < 3; i++) {
      x += s.range(-4, 4);
      y += s.range(2, 5);
      ctx.lineTo(Math.round(x) + 0.5, Math.round(y) + 0.5);
    }
    ctx.stroke();
  }

  // Kerb: light lip + dark face where the pavement meets road.
  const kerbLight = shade(palette.sidewalk, 0.22);
  if (tileAt(map, tx, ty + 1) === T_ROAD) {
    ctx.fillStyle = kerbLight;
    ctx.fillRect(sx, sy + TILE_SIZE - 2, TILE_SIZE, 1);
    ctx.fillStyle = 'rgba(0,0,0,0.3)';
    ctx.fillRect(sx, sy + TILE_SIZE - 1, TILE_SIZE, 1);
  }
  if (tileAt(map, tx, ty - 1) === T_ROAD) {
    ctx.fillStyle = kerbLight;
    ctx.fillRect(sx, sy + 1, TILE_SIZE, 1);
    ctx.fillStyle = 'rgba(0,0,0,0.3)';
    ctx.fillRect(sx, sy, TILE_SIZE, 1);
  }
  if (tileAt(map, tx + 1, ty) === T_ROAD) {
    ctx.fillStyle = kerbLight;
    ctx.fillRect(sx + TILE_SIZE - 2, sy, 1, TILE_SIZE);
    ctx.fillStyle = 'rgba(0,0,0,0.3)';
    ctx.fillRect(sx + TILE_SIZE - 1, sy, 1, TILE_SIZE);
  }
  if (tileAt(map, tx - 1, ty) === T_ROAD) {
    ctx.fillStyle = kerbLight;
    ctx.fillRect(sx + 1, sy, 1, TILE_SIZE);
    ctx.fillStyle = 'rgba(0,0,0,0.3)';
    ctx.fillRect(sx, sy, 1, TILE_SIZE);
  }
}

// ------------------------------------------------------------ grass + lots

function paintGrass(
  ctx: CanvasRenderingContext2D,
  map: CityMap,
  tx: number,
  ty: number,
  sx: number,
  sy: number,
  base: string,
  flourish: number,
): void {
  const seed = map.seed;
  const drift = (hash01(seed ^ 0x9ee, tx, ty) - 0.5) * 0.10;
  ctx.fillStyle = shade(base, drift);
  ctx.fillRect(sx, sy, TILE_SIZE, TILE_SIZE);

  // 4×4 sub-cell dither between two greens breaks up tile edges entirely.
  const alt = shade(base, 0.08);
  for (let gy = 0; gy < 4; gy++) {
    for (let gx = 0; gx < 4; gx++) {
      if (hash01(seed ^ 0x777, tx * 4 + gx, ty * 4 + gy) < 0.30) {
        ctx.fillStyle = alt;
        ctx.fillRect(sx + gx * 4, sy + gy * 4, 4, 4);
      }
    }
  }

  const s = new VisualStream(seed ^ 0x3f1, tx, ty);
  // Tufts.
  for (let i = 0; i < 3; i++) {
    if (s.chance(0.5)) {
      ctx.fillStyle = shade(base, s.chance(0.5) ? -0.22 : 0.2);
      ctx.fillRect(sx + s.int(TILE_SIZE - 1), sy + s.int(TILE_SIZE - 1), 1, 2);
    }
  }
  // Flowers in parks (small clusters), stones in fields.
  if (s.chance(flourish)) {
    if (flourish > 0.06) {
      const FLOWERS = ['#d8c25a', '#c86a8a', '#d8d8e0', '#c07a4a'] as const;
      const color = FLOWERS[s.int(FLOWERS.length)] as string;
      const fx = sx + 1 + s.int(TILE_SIZE - 5);
      const fy = sy + 1 + s.int(TILE_SIZE - 4);
      ctx.fillStyle = color;
      ctx.fillRect(fx, fy, 2, 1);
      if (s.chance(0.6)) ctx.fillRect(fx + 2 + s.int(2), fy + 1 + s.int(2), 2, 1);
      if (s.chance(0.4)) ctx.fillRect(fx + s.int(3), fy - 1 - s.int(2), 1, 1);
    } else {
      ctx.fillStyle = '#6e7276';
      ctx.fillRect(sx + s.int(TILE_SIZE - 2), sy + s.int(TILE_SIZE - 2), 2, 1);
    }
  }
}

function paintLot(
  ctx: CanvasRenderingContext2D,
  map: CityMap,
  tx: number,
  ty: number,
  sx: number,
  sy: number,
): void {
  const seed = map.seed;
  const drift = (hash01(seed ^ 0x10c, tx, ty) - 0.5) * 0.08;
  ctx.fillStyle = shade(palette.lot, drift);
  ctx.fillRect(sx, sy, TILE_SIZE, TILE_SIZE);

  const s = new VisualStream(seed ^ 0x77b, tx, ty);
  // Expansion joints every other tile.
  if (tx % 2 === 0) {
    ctx.fillStyle = 'rgba(0,0,0,0.10)';
    ctx.fillRect(sx, sy, 1, TILE_SIZE);
  }
  if (ty % 2 === 0) {
    ctx.fillStyle = 'rgba(0,0,0,0.10)';
    ctx.fillRect(sx, sy, TILE_SIZE, 1);
  }
  // Oil stains.
  if (s.chance(0.05)) {
    ctx.fillStyle = 'rgba(10, 10, 14, 0.25)';
    ctx.beginPath();
    ctx.ellipse(sx + s.range(4, 12), sy + s.range(4, 12), s.range(2, 5), s.range(1.5, 3), 0, 0, Math.PI * 2);
    ctx.fill();
  }
  // Scattered grit.
  for (let i = 0; i < 4; i++) {
    ctx.fillStyle = s.chance(0.5) ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.08)';
    ctx.fillRect(sx + s.int(TILE_SIZE), sy + s.int(TILE_SIZE), 1, 1);
  }
}

// ------------------------------------------------------------- water + sand

/** Manhattan distance (≤ max) to the nearest non-water tile, for depth tone. */
function shoreDistance(map: CityMap, tx: number, ty: number, max: number): number {
  for (let d = 1; d <= max; d++) {
    for (let i = -d; i <= d; i++) {
      if (
        tileAt(map, tx + i, ty - (d - Math.abs(i))) !== T_WATER ||
        tileAt(map, tx + i, ty + (d - Math.abs(i))) !== T_WATER
      ) {
        return d;
      }
    }
  }
  return max + 1;
}

function paintWater(
  ctx: CanvasRenderingContext2D,
  map: CityMap,
  tx: number,
  ty: number,
  sx: number,
  sy: number,
): void {
  const seed = map.seed;
  // Deeper water reads darker; the shallows keep a green cast.
  const depth = shoreDistance(map, tx, ty, 4);
  const drift = (hash01(seed ^ 0x0cea, tx, ty) - 0.5) * 0.06;
  const base = depth <= 1 ? mix(palette.water, '#3d6b5a', 0.25) : shade(palette.water, -0.05 * (depth - 1));
  ctx.fillStyle = shade(base, drift);
  ctx.fillRect(sx, sy, TILE_SIZE, TILE_SIZE);

  // Wave flecks: short horizontal light strokes, denser in the shallows.
  const s = new VisualStream(seed ^ 0x5ee, tx, ty);
  const flecks = depth <= 1 ? 3 : 2;
  for (let i = 0; i < flecks; i++) {
    if (s.chance(0.55)) {
      ctx.fillStyle = `rgba(180, 210, 220, ${depth <= 1 ? 0.12 : 0.07})`;
      ctx.fillRect(sx + s.int(TILE_SIZE - 4), sy + s.int(TILE_SIZE - 1), 3 + s.int(3), 1);
    }
  }

  // Foam line where water meets the beach.
  ctx.fillStyle = 'rgba(214, 228, 226, 0.30)';
  if (tileAt(map, tx + 1, ty) === T_SAND) ctx.fillRect(sx + TILE_SIZE - 2, sy, 2, TILE_SIZE);
  if (tileAt(map, tx - 1, ty) === T_SAND) ctx.fillRect(sx, sy, 2, TILE_SIZE);
  if (tileAt(map, tx, ty + 1) === T_SAND) ctx.fillRect(sx, sy + TILE_SIZE - 2, TILE_SIZE, 2);
  if (tileAt(map, tx, ty - 1) === T_SAND) ctx.fillRect(sx, sy, TILE_SIZE, 2);
}

function paintSand(
  ctx: CanvasRenderingContext2D,
  map: CityMap,
  tx: number,
  ty: number,
  sx: number,
  sy: number,
): void {
  const seed = map.seed;
  const drift = (hash01(seed ^ 0x5a4d, tx, ty) - 0.5) * 0.10;
  const nearWater =
    tileAt(map, tx + 1, ty) === T_WATER ||
    tileAt(map, tx - 1, ty) === T_WATER ||
    tileAt(map, tx, ty + 1) === T_WATER ||
    tileAt(map, tx, ty - 1) === T_WATER;
  // The strip by the water is wet and darker.
  const base = nearWater ? shade(palette.sand, -0.16) : palette.sand;
  ctx.fillStyle = shade(base, drift);
  ctx.fillRect(sx, sy, TILE_SIZE, TILE_SIZE);

  const s = new VisualStream(seed ^ 0x5a4e, tx, ty);
  // Grain speckle.
  for (let i = 0; i < 5; i++) {
    ctx.fillStyle = s.chance(0.5) ? 'rgba(255,255,255,0.06)' : 'rgba(70,58,38,0.10)';
    ctx.fillRect(sx + s.int(TILE_SIZE), sy + s.int(TILE_SIZE), 1, 1);
  }
  // The odd shell or pebble.
  if (s.chance(0.06)) {
    ctx.fillStyle = s.chance(0.5) ? '#d8cfc0' : '#8a8378';
    ctx.fillRect(sx + s.int(TILE_SIZE - 2), sy + s.int(TILE_SIZE - 2), 2, 1);
  }
  // Reeds sprout on the waterline.
  if (nearWater && s.chance(0.3)) {
    for (let i = 0; i < 2 + s.int(2); i++) {
      ctx.fillStyle = s.chance(0.5) ? '#3d5a3a' : '#4c6a44';
      ctx.fillRect(sx + s.int(TILE_SIZE - 1), sy + s.int(TILE_SIZE - 3), 1, 3);
    }
  }
}

// -------------------------------------------------------------------- trees

export interface TreeInstance {
  /** Canopy centre, world px. */
  x: number;
  y: number;
  /** Canopy radius, px. */
  r: number;
  /** Bushes are squat (less parallax lean, no highlight crown). */
  kind: 'tree' | 'bush';
}

/** Deterministic park/field trees; anchored to even tile pairs for spacing. */
export function treeAt(map: CityMap, tx: number, ty: number): TreeInstance | null {
  if (tx % 2 !== 0 || ty % 2 !== 0) return bushAt(map, tx, ty);
  const tile = tileAt(map, tx, ty);
  if (tile === T_SIDEWALK) return streetTreeAt(map, tx, ty);
  const p = tile === T_PARK ? 0.16 : tile === T_FIELD ? 0.03 : 0;
  if (p === 0) return null;
  if (hash01(map.seed ^ 0x7ee, tx, ty) >= p) return null;
  const s = new VisualStream(map.seed ^ 0x7ef, tx, ty);
  return {
    x: (tx + 0.5) * TILE_SIZE + s.range(-3, 3),
    y: (ty + 0.5) * TILE_SIZE + s.range(-3, 3),
    r: s.range(5.5, 9),
    kind: 'tree',
  };
}

/** Low bushes fill the gaps between park trees (odd tile pairs). */
function bushAt(map: CityMap, tx: number, ty: number): TreeInstance | null {
  if (tx % 2 !== 1 || ty % 2 !== 1) return null;
  if (tileAt(map, tx, ty) !== T_PARK) return null;
  if (hash01(map.seed ^ 0xb05, tx, ty) >= 0.14) return null;
  const s = new VisualStream(map.seed ^ 0xb06, tx, ty);
  return {
    x: (tx + 0.5) * TILE_SIZE + s.range(-4, 4),
    y: (ty + 0.5) * TILE_SIZE + s.range(-4, 4),
    r: s.range(3, 4.5),
    kind: 'bush',
  };
}

/** Street trees against building walls in the leafier districts. */
function streetTreeAt(map: CityMap, tx: number, ty: number): TreeInstance | null {
  if (tx % 4 !== 0 || ty % 4 !== 0) return null;
  const d = districtAt(map, tx, ty);
  if (d !== 'residential' && d !== 'commercial' && d !== 'downtown') return null;
  const byWall =
    tileAt(map, tx - 1, ty) === T_BUILDING ||
    tileAt(map, tx + 1, ty) === T_BUILDING ||
    tileAt(map, tx, ty - 1) === T_BUILDING ||
    tileAt(map, tx, ty + 1) === T_BUILDING;
  if (!byWall) return null;
  const p = d === 'residential' ? 0.34 : 0.18;
  if (hash01(map.seed ^ 0x57e, tx, ty) >= p) return null;
  const s = new VisualStream(map.seed ^ 0x57f, tx, ty);
  return {
    x: (tx + 0.5) * TILE_SIZE + s.range(-2, 2),
    y: (ty + 0.5) * TILE_SIZE + s.range(-2, 2),
    r: s.range(4.5, 6.5),
    kind: 'tree',
  };
}

/** All trees whose canopy could touch the view (margin pads for lean). */
export function treesInView(map: CityMap, cam: Vec2, margin = 24): TreeInstance[] {
  const out: TreeInstance[] = [];
  const t0x = Math.max(0, Math.floor((cam.x - margin) / TILE_SIZE));
  const t0y = Math.max(0, Math.floor((cam.y - margin) / TILE_SIZE));
  const t1x = Math.min(map.widthTiles - 1, Math.floor((cam.x + INTERNAL_WIDTH + margin) / TILE_SIZE));
  const t1y = Math.min(map.heightTiles - 1, Math.floor((cam.y + INTERNAL_HEIGHT + margin) / TILE_SIZE));
  for (let ty = t0y; ty <= t1y; ty++) {
    for (let tx = t0x; tx <= t1x; tx++) {
      const tree = treeAt(map, tx, ty);
      if (tree) out.push(tree);
    }
  }
  return out;
}

/** Tree colour variation, stable per instance. */
export function treeTone(map: CityMap, tree: TreeInstance): number {
  return hashPick(map.seed ^ 0x7f0, Math.round(tree.x), Math.round(tree.y), 4);
}
