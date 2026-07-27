import {
  type CityMap,
  type Vec2,
  DISTRICT_TYPES,
  T_BUILDING,
  T_FIELD,
  T_LOT,
  T_PARK,
  T_ROAD,
  T_SIDEWALK,
  T_WATER,
  T_BRIDGE,
  TILE_SIZE,
} from 'shared';
import palette from 'shared/data/palette.json';
import {
  CHUNK_BUILDS_PER_FRAME,
  CHUNK_CACHE_LIMIT,
  CHUNK_TILES,
  DEVICE_H,
  DEVICE_W,
  RENDER_SCALE,
  SHADOW_DEPTH,
  SUN_X,
  SUN_Y,
  WALL_DEPTH,
} from './config.js';
import type { SpriteSheet } from './sprites.js';

const CHUNK_WORLD = CHUNK_TILES * TILE_SIZE;
const CHUNK_DEVICE = CHUNK_WORLD * RENDER_SCALE;
/** Device pixels per tile. */
const TD = TILE_SIZE * RENDER_SCALE;

/** A road is a road, not a junction, once its cross-run is this long. */
const RUN_ROAD = 8;

interface Chunk {
  canvas: HTMLCanvasElement;
  /** Frame counter of last use, for eviction. */
  touched: number;
}

/** Stable, cheap 2D hash — the source of every "random" detail below. */
function hash2(x: number, y: number, salt = 0): number {
  let h = Math.imul(x, 0x27d4eb2d) ^ Math.imul(y, 0x165667b1) ^ Math.imul(salt, 0x9e3779b9);
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d);
  h ^= h >>> 12;
  h = Math.imul(h, 0x297a2d39);
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

function shade(hex: string, amount: number, towards = '#0b111c'): string {
  const a = parseInt(hex.slice(1), 16);
  const b = parseInt(towards.slice(1), 16);
  const mixc = (sa: number, sb: number): number => Math.round(sa + (sb - sa) * amount);
  const r = mixc((a >> 16) & 255, (b >> 16) & 255);
  const g = mixc((a >> 8) & 255, (b >> 8) & 255);
  const bl = mixc(a & 255, b & 255);
  return `rgb(${r},${g},${bl})`;
}

/**
 * The static city, rendered once per chunk into an offscreen canvas and blitted
 * thereafter.
 *
 * The old renderer repainted ~500 flat `fillRect`s every frame, which capped
 * both the frame rate and the amount of detail the ground could ever carry.
 * Caching inverts that: a chunk is painted once and reused for as long as it
 * stays on screen, so lane markings, kerbs, paving, roof clutter, extruded
 * building walls and cast shadows are all effectively free at runtime.
 */
export class TileLayer {
  private map: CityMap | null = null;
  private chunks = new Map<number, Chunk>();
  private frameCounter = 0;
  /** Building index per tile (1-based; 0 = not a building). */
  private buildingOf: Int32Array = new Int32Array(0);
  /** Contiguous road-run length and index within it, per axis. */
  private runH: Uint8Array = new Uint8Array(0);
  private runV: Uint8Array = new Uint8Array(0);
  private idxH: Uint8Array = new Uint8Array(0);
  private idxV: Uint8Array = new Uint8Array(0);

  constructor(private readonly sprites: SpriteSheet) {}

  setMap(map: CityMap): void {
    this.map = map;
    this.chunks.clear();
    this.indexBuildings(map);
    this.indexRoadRuns(map);
  }

  /** Drop every cached chunk — used when the sprite sheet finishes loading. */
  invalidate(): void {
    this.chunks.clear();
  }

  /**
   * Blit the visible chunks. `originX/originY` are the device-pixel position of
   * world origin, already snapped, so every chunk lands on the same grid and no
   * seams open up between them.
   */
  draw(ctx: CanvasRenderingContext2D, cam: Vec2, originX: number, originY: number): void {
    const map = this.map;
    if (!map) return;
    this.frameCounter++;

    const cx0 = Math.floor(cam.x / CHUNK_WORLD);
    const cy0 = Math.floor(cam.y / CHUNK_WORLD);
    const cx1 = Math.floor((cam.x + DEVICE_W / RENDER_SCALE) / CHUNK_WORLD);
    const cy1 = Math.floor((cam.y + DEVICE_H / RENDER_SCALE) / CHUNK_WORLD);

    let budget = CHUNK_BUILDS_PER_FRAME;
    for (let cy = cy0; cy <= cy1; cy++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        const key = cy * 100000 + cx;
        let chunk = this.chunks.get(key);
        if (!chunk && budget > 0) {
          budget--;
          chunk = { canvas: this.buildChunk(cx, cy), touched: this.frameCounter };
          this.chunks.set(key, chunk);
        }
        const dx = originX + cx * CHUNK_DEVICE;
        const dy = originY + cy * CHUNK_DEVICE;
        if (!chunk) {
          // Not built yet: a flat wash beats a hole while the budget catches up.
          ctx.fillStyle = palette.field;
          ctx.fillRect(dx, dy, CHUNK_DEVICE, CHUNK_DEVICE);
          continue;
        }
        chunk.touched = this.frameCounter;
        ctx.drawImage(chunk.canvas, dx, dy);
      }
    }

    // Spend whatever budget is left on the ring just outside the viewport, so
    // driving into fresh ground finds it already painted. Standing still — or
    // any frame where nothing visible needs building — quietly pays down the
    // cost of the next few seconds of movement.
    if (budget > 0) this.prefetch(cx0 - 1, cy0 - 1, cx1 + 1, cy1 + 1, budget);

    if (this.chunks.size > CHUNK_CACHE_LIMIT) this.evict();
  }

  private prefetch(cx0: number, cy0: number, cx1: number, cy1: number, budget: number): void {
    let left = budget;
    for (let cy = cy0; cy <= cy1; cy++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        // Interior is the viewport, already handled above.
        if (cx > cx0 && cx < cx1 && cy > cy0 && cy < cy1) continue;
        const key = cy * 100000 + cx;
        if (this.chunks.has(key)) continue;
        this.chunks.set(key, { canvas: this.buildChunk(cx, cy), touched: this.frameCounter });
        if (--left <= 0) return;
      }
    }
  }

  private evict(): void {
    const entries = [...this.chunks.entries()].sort((a, b) => a[1].touched - b[1].touched);
    for (let i = 0; i < entries.length - CHUNK_CACHE_LIMIT; i++) {
      this.chunks.delete((entries[i] as [number, Chunk])[0]);
    }
  }

  // ── indices built once per map ─────────────────────────────────────────────

  /**
   * Which building each tile belongs to, so a block of roof tiles can share one
   * colour and one silhouette instead of reading as a grid of identical squares.
   */
  private indexBuildings(map: CityMap): void {
    this.buildingOf = new Int32Array(map.widthTiles * map.heightTiles);
    map.buildings.forEach((b, i) => {
      for (let ty = b.y; ty < b.y + b.h; ty++) {
        for (let tx = b.x; tx < b.x + b.w; tx++) {
          if (tx < 0 || ty < 0 || tx >= map.widthTiles || ty >= map.heightTiles) continue;
          this.buildingOf[ty * map.widthTiles + tx] = i + 1;
        }
      }
    });
  }

  /**
   * Length of the contiguous road run through every road tile, per axis, plus
   * the tile's index within it. Lane markings, kerb lines and junctions all
   * fall out of these two numbers: on a horizontal road the *vertical* run is
   * just the carriageway width, so its midpoint is the centre line.
   */
  private indexRoadRuns(map: CityMap): void {
    const n = map.widthTiles * map.heightTiles;
    this.runH = new Uint8Array(n);
    this.runV = new Uint8Array(n);
    this.idxH = new Uint8Array(n);
    this.idxV = new Uint8Array(n);

    for (let ty = 0; ty < map.heightTiles; ty++) {
      let start = -1;
      for (let tx = 0; tx <= map.widthTiles; tx++) {
        const road = tx < map.widthTiles && map.tiles[ty * map.widthTiles + tx] === T_ROAD;
        if (road && start < 0) start = tx;
        if (!road && start >= 0) {
          const len = Math.min(255, tx - start);
          for (let k = start; k < tx; k++) {
            this.runH[ty * map.widthTiles + k] = len;
            this.idxH[ty * map.widthTiles + k] = Math.min(255, k - start);
          }
          start = -1;
        }
      }
    }
    for (let tx = 0; tx < map.widthTiles; tx++) {
      let start = -1;
      for (let ty = 0; ty <= map.heightTiles; ty++) {
        const road = ty < map.heightTiles && map.tiles[ty * map.widthTiles + tx] === T_ROAD;
        if (road && start < 0) start = ty;
        if (!road && start >= 0) {
          const len = Math.min(255, ty - start);
          for (let k = start; k < ty; k++) {
            this.runV[k * map.widthTiles + tx] = len;
            this.idxV[k * map.widthTiles + tx] = Math.min(255, k - start);
          }
          start = -1;
        }
      }
    }
  }

  // ── chunk painting ─────────────────────────────────────────────────────────

  private tileAt(tx: number, ty: number): number {
    const map = this.map as CityMap;
    if (tx < 0 || ty < 0 || tx >= map.widthTiles || ty >= map.heightTiles) return T_BUILDING;
    return map.tiles[ty * map.widthTiles + tx] as number;
  }

  private districtOf(tx: number, ty: number): string {
    const map = this.map as CityMap;
    if (tx < 0 || ty < 0 || tx >= map.widthTiles || ty >= map.heightTiles) return 'downtown';
    return DISTRICT_TYPES[map.district[ty * map.widthTiles + tx] as number] as string;
  }

  private roofColor(tx: number, ty: number): string {
    const map = this.map as CityMap;
    const district = this.districtOf(tx, ty);
    const variants =
      (palette.buildingVariants as Record<string, string[]>)[district] ??
      palette.buildingVariants.downtown;
    const id = this.buildingOf[ty * map.widthTiles + tx] as number;
    // Fall back to the tile's own coordinates for stray building tiles that no
    // rect claimed, so neighbours still differ rather than all going grey.
    const pick = id > 0 ? hash2(id, id * 7 + 3) : hash2(tx, ty, 91);
    return variants[Math.floor(pick * variants.length) % variants.length] as string;
  }

  private buildChunk(cx: number, cy: number): HTMLCanvasElement {
    const canvas = document.createElement('canvas');
    canvas.width = CHUNK_DEVICE;
    canvas.height = CHUNK_DEVICE;
    const ctx = canvas.getContext('2d') as CanvasRenderingContext2D;
    ctx.imageSmoothingEnabled = false;

    const tx0 = cx * CHUNK_TILES;
    const ty0 = cy * CHUNK_TILES;
    /** Tile coords -> device pixels inside this chunk. */
    const ox = (tx: number): number => (tx - tx0) * TD;
    const oy = (ty: number): number => (ty - ty0) * TD;

    // 1. Ground.
    for (let ty = ty0; ty < ty0 + CHUNK_TILES; ty++) {
      for (let tx = tx0; tx < tx0 + CHUNK_TILES; tx++) {
        const tile = this.tileAt(tx, ty);
        if (tile === T_BUILDING) continue;
        this.paintGround(ctx, tx, ty, ox(tx), oy(ty), tile);
      }
    }

    // 2. Building shadows, built as one opaque mask so overlapping tiles do not
    //    double-darken, then laid down translucent in a single blit.
    this.paintBuildingShadows(ctx, tx0, ty0);

    // 3. Extruded walls, then 4. roofs on top of them. Both run over a one-tile
    //    border so buildings straddling a chunk edge extrude seamlessly.
    for (let ty = ty0 - 1; ty <= ty0 + CHUNK_TILES; ty++) {
      for (let tx = tx0 - 1; tx <= tx0 + CHUNK_TILES; tx++) {
        if (this.tileAt(tx, ty) !== T_BUILDING) continue;
        this.paintWall(ctx, tx, ty, ox(tx), oy(ty));
      }
    }
    for (let ty = ty0 - 1; ty <= ty0 + CHUNK_TILES; ty++) {
      for (let tx = tx0 - 1; tx <= tx0 + CHUNK_TILES; tx++) {
        if (this.tileAt(tx, ty) !== T_BUILDING) continue;
        this.paintRoof(ctx, tx, ty, ox(tx), oy(ty));
      }
    }

    // 5. Shop fronts, which sit on the sidewalk rather than the road.
    this.paintShops(ctx, tx0, ty0);
    return canvas;
  }

  // ── ground surfaces ────────────────────────────────────────────────────────

  private paintGround(
    ctx: CanvasRenderingContext2D,
    tx: number,
    ty: number,
    x: number,
    y: number,
    tile: number,
  ): void {
    switch (tile) {
      case T_ROAD:
        this.paintRoad(ctx, tx, ty, x, y);
        break;
      case T_SIDEWALK:
        this.paintSidewalk(ctx, tx, ty, x, y);
        break;
      case T_PARK:
        this.paintGrass(ctx, tx, ty, x, y, palette.grassDark, palette.grassLight, true);
        break;
      case T_FIELD:
        this.paintGrass(ctx, tx, ty, x, y, palette.field, palette.grassDark, false);
        break;
      case T_LOT:
        this.paintLot(ctx, tx, ty, x, y);
        break;
      case T_WATER:
        this.paintWater(ctx, tx, ty, x, y);
        break;
      case T_BRIDGE:
        this.paintBridge(ctx, tx, ty, x, y);
        break;
      default:
        ctx.fillStyle = palette.field;
        ctx.fillRect(x, y, TD, TD);
    }
  }

  /**
   * River. Banded rather than flat so the surface reads as moving water at a
   * glance, with a lighter lip where it meets the bank.
   */
  private paintWater(
    ctx: CanvasRenderingContext2D,
    tx: number,
    ty: number,
    x: number,
    y: number,
  ): void {
    ctx.fillStyle = palette.water;
    ctx.fillRect(x, y, TD, TD);
    const h = hash2(tx, ty, 91);
    ctx.fillStyle = shade(palette.water, 0.16, '#8fbcd6');
    for (let i = 0; i < 3; i++) {
      const band = (h >> (i * 5)) & 31;
      const by = y + ((band / 32) * TD) | 0;
      const bw = (TD * (0.35 + ((band & 7) / 20))) | 0;
      const bx = x + (((h >> (i * 3 + 2)) & 15) / 16) * (TD - bw);
      ctx.fillRect(bx | 0, by, bw, Math.max(1, (TD / 12) | 0));
    }
    // Shore lip against any non-water neighbour.
    ctx.fillStyle = shade(palette.water, 0.3, '#bfe0ef');
    if (this.tileAt(tx, ty - 1) !== T_WATER && this.tileAt(tx, ty - 1) !== T_BRIDGE) {
      ctx.fillRect(x, y, TD, Math.max(1, (TD / 14) | 0));
    }
    if (this.tileAt(tx - 1, ty) !== T_WATER && this.tileAt(tx - 1, ty) !== T_BRIDGE) {
      ctx.fillRect(x, y, Math.max(1, (TD / 14) | 0), TD);
    }
  }

  /** Bridge deck: road surface with a rail down each side. */
  private paintBridge(
    ctx: CanvasRenderingContext2D,
    tx: number,
    ty: number,
    x: number,
    y: number,
  ): void {
    this.paintRoad(ctx, tx, ty, x, y);
    ctx.fillStyle = palette.kerb;
    const rail = Math.max(1, (TD / 10) | 0);
    // Rails run along the deck, i.e. across whichever axis leaves the bridge.
    const alongX = this.tileAt(tx - 1, ty) === T_BRIDGE || this.tileAt(tx + 1, ty) === T_BRIDGE;
    if (alongX) {
      ctx.fillRect(x, y, TD, rail);
      ctx.fillRect(x, y + TD - rail, TD, rail);
    } else {
      ctx.fillRect(x, y, rail, TD);
      ctx.fillRect(x + TD - rail, y, rail, TD);
    }
  }

  /** Speckle a surface with a handful of deterministic grains. */
  private speckle(
    ctx: CanvasRenderingContext2D,
    tx: number,
    ty: number,
    x: number,
    y: number,
    color: string,
    count: number,
    size: number,
    salt: number,
  ): void {
    ctx.fillStyle = color;
    for (let i = 0; i < count; i++) {
      const px = Math.floor(hash2(tx * 31 + i, ty * 17 + i, salt) * (TD - size));
      const py = Math.floor(hash2(tx * 13 + i, ty * 29 + i, salt + 1) * (TD - size));
      ctx.fillRect(x + px, y + py, size, size);
    }
  }

  private paintRoad(
    ctx: CanvasRenderingContext2D,
    tx: number,
    ty: number,
    x: number,
    y: number,
  ): void {
    const map = this.map as CityMap;
    const i = ty * map.widthTiles + tx;
    ctx.fillStyle = palette.road;
    ctx.fillRect(x, y, TD, TD);

    // Asphalt grain plus the occasional resurfacing patch.
    this.speckle(ctx, tx, ty, x, y, palette.roadDark, 5, 2, 3);
    this.speckle(ctx, tx, ty, x, y, palette.roadLight, 3, 1, 9);
    if (hash2(tx, ty, 41) > 0.9) {
      ctx.fillStyle = palette.roadPatch;
      const w = 6 + Math.floor(hash2(tx, ty, 42) * 12);
      const h = 5 + Math.floor(hash2(tx, ty, 43) * 10);
      ctx.fillRect(x + 4, y + 5, w, h);
    }
    if (hash2(tx, ty, 55) > 0.955) {
      ctx.fillStyle = palette.manhole;
      ctx.beginPath();
      ctx.arc(x + TD / 2, y + TD / 2, 4 * RENDER_SCALE, 0, Math.PI * 2);
      ctx.fill();
    }

    const hLen = this.runH[i] as number;
    const vLen = this.runV[i] as number;
    const horizontal = hLen >= RUN_ROAD;
    const vertical = vLen >= RUN_ROAD;
    if (horizontal && vertical) return; // junction: bare asphalt

    if (horizontal) this.paintLaneMarks(ctx, tx, ty, x, y, vLen, this.idxV[i] as number, false);
    else if (vertical) this.paintLaneMarks(ctx, tx, ty, x, y, hLen, this.idxH[i] as number, true);
  }

  /**
   * Lane furniture for one carriageway tile: dashed centre line at the midpoint
   * of the run, solid edge lines at its outsides, and a stop line + zebra where
   * the road runs into a junction.
   */
  private paintLaneMarks(
    ctx: CanvasRenderingContext2D,
    tx: number,
    ty: number,
    x: number,
    y: number,
    width: number,
    index: number,
    vertical: boolean,
  ): void {
    const t = RENDER_SCALE; // 1 world px
    const mid = width / 2 - 1;

    // Centre line: dashes along the direction of travel.
    if (width >= 2 && index === Math.floor(mid)) {
      ctx.fillStyle = palette.roadLane;
      const dashes = 2;
      const dashLen = TD / (dashes * 2);
      for (let d = 0; d < dashes; d++) {
        const off = d * dashLen * 2 + dashLen / 2;
        if (vertical) ctx.fillRect(x + TD - t, y + off, t, dashLen);
        else ctx.fillRect(x + off, y + TD - t, dashLen, t);
      }
    }
    // Edge lines, held one pixel off the kerb.
    if (index === 0 || index === width - 1) {
      ctx.fillStyle = palette.roadMark;
      const near = index === 0;
      if (vertical) ctx.fillRect(near ? x + t : x + TD - 2 * t, y, t, TD);
      else ctx.fillRect(x, near ? y + t : y + TD - 2 * t, TD, t);
    }

    // Stop line + zebra on the last tile before a junction.
    const ahead = vertical ? this.junctionAt(tx, ty + 1) || this.junctionAt(tx, ty - 1) : this.junctionAt(tx + 1, ty) || this.junctionAt(tx - 1, ty);
    if (!ahead) return;
    const forward = vertical ? this.junctionAt(tx, ty + 1) : this.junctionAt(tx + 1, ty);
    ctx.fillStyle = palette.roadStop;
    if (vertical) ctx.fillRect(x, forward ? y + TD - 3 * t : y + t, TD, 2 * t);
    else ctx.fillRect(forward ? x + TD - 3 * t : x + t, y, 2 * t, TD);

    // Zebra: stripes spaced to fill exactly one tile, whatever TILE_SIZE is.
    ctx.fillStyle = palette.roadCrossing;
    const stripes = 3;
    const pitch = TD / stripes;
    const bar = Math.max(2, Math.round(pitch * 0.45));
    for (let s = 0; s < stripes; s++) {
      const off = Math.round(s * pitch + (pitch - bar) / 2);
      if (vertical) ctx.fillRect(x + off, forward ? y + TD - 9 * t : y + 4 * t, bar, 5 * t);
      else ctx.fillRect(forward ? x + TD - 9 * t : x + 4 * t, y + off, 5 * t, bar);
    }
  }

  private junctionAt(tx: number, ty: number): boolean {
    const map = this.map as CityMap;
    if (tx < 0 || ty < 0 || tx >= map.widthTiles || ty >= map.heightTiles) return false;
    const i = ty * map.widthTiles + tx;
    if (map.tiles[i] !== T_ROAD) return false;
    return (this.runH[i] as number) >= RUN_ROAD && (this.runV[i] as number) >= RUN_ROAD;
  }

  private paintSidewalk(
    ctx: CanvasRenderingContext2D,
    tx: number,
    ty: number,
    x: number,
    y: number,
  ): void {
    const district = this.districtOf(tx, ty);
    const tint =
      (palette.sidewalkTint as Record<string, string>)[district] ?? palette.sidewalk;
    ctx.fillStyle = tint;
    ctx.fillRect(x, y, TD, TD);

    // Paving slabs: two joints each way, with the joint colour reading as a
    // recess rather than a drawn line.
    ctx.fillStyle = shade(tint, 0.3);
    const half = TD / 2;
    ctx.fillRect(x, y + half - 1, TD, 1);
    ctx.fillRect(x + half - 1, y, 1, TD);
    ctx.fillStyle = shade(tint, 0.25, '#ffffff');
    ctx.fillRect(x, y + half, TD, 1);
    ctx.fillRect(x + half, y, 1, TD);
    this.speckle(ctx, tx, ty, x, y, shade(tint, 0.14), 4, 1, 7);

    // Kerb on every edge that meets the road.
    const t = RENDER_SCALE;
    const edges: Array<[number, number, number, number, number, number]> = [
      [0, -1, x, y, TD, 2 * t],
      [0, 1, x, y + TD - 2 * t, TD, 2 * t],
      [-1, 0, x, y, 2 * t, TD],
      [1, 0, x + TD - 2 * t, y, 2 * t, TD],
    ];
    for (const [dx, dy, rx, ry, rw, rh] of edges) {
      if (this.tileAt(tx + dx, ty + dy) !== T_ROAD) continue;
      ctx.fillStyle = palette.kerb;
      ctx.fillRect(rx, ry, rw, rh);
      ctx.fillStyle = palette.kerbShade;
      if (dy !== 0) ctx.fillRect(rx, dy < 0 ? ry : ry + rh - t, rw, t);
      else ctx.fillRect(dx < 0 ? rx : rx + rw - t, ry, t, rh);
    }
  }

  private paintGrass(
    ctx: CanvasRenderingContext2D,
    tx: number,
    ty: number,
    x: number,
    y: number,
    base: string,
    light: string,
    lush: boolean,
  ): void {
    ctx.fillStyle = base;
    ctx.fillRect(x, y, TD, TD);
    this.speckle(ctx, tx, ty, x, y, light, lush ? 14 : 7, 2, 11);
    this.speckle(ctx, tx, ty, x, y, shade(base, 0.25), lush ? 8 : 4, 2, 13);
    if (!lush) return;

    // Park planting. Bushes are low enough to walk past without reading wrong;
    // trees are kept sparse for the same reason.
    const roll = hash2(tx, ty, 71);
    if (roll > 0.92 && this.sprites.has('tree')) {
      this.sprites.draw(ctx, 'tree', x + TD / 2, y + TD / 2, 0);
    } else if (roll > 0.87 && this.sprites.has('bush')) {
      this.sprites.draw(
        ctx,
        'bush',
        x + TD * (0.3 + hash2(tx, ty, 72) * 0.4),
        y + TD * (0.3 + hash2(tx, ty, 73) * 0.4),
        0,
      );
    }
  }

  private paintLot(
    ctx: CanvasRenderingContext2D,
    tx: number,
    ty: number,
    x: number,
    y: number,
  ): void {
    ctx.fillStyle = palette.lot;
    ctx.fillRect(x, y, TD, TD);
    this.speckle(ctx, tx, ty, x, y, palette.gravel, 8, 2, 17);
    this.speckle(ctx, tx, ty, x, y, shade(palette.lot, 0.18, '#ffffff'), 4, 1, 19);
    // Parking bays, marked out in alternating columns.
    if (tx % 3 === 0) {
      ctx.fillStyle = palette.lotStripe;
      ctx.fillRect(x + 2 * RENDER_SCALE, y + 2 * RENDER_SCALE, RENDER_SCALE, TD - 4 * RENDER_SCALE);
    }
    if (hash2(tx, ty, 23) > 0.94 && this.sprites.has('barrel')) {
      this.sprites.draw(ctx, 'barrel', x + TD * 0.6, y + TD * 0.5, 0);
    } else if (hash2(tx, ty, 24) > 0.95 && this.sprites.has('crate')) {
      this.sprites.draw(ctx, 'crate', x + TD * 0.4, y + TD * 0.6, 0);
    }
  }

  // ── buildings ──────────────────────────────────────────────────────────────

  /**
   * Cast shadows for every building overlapping this chunk. Painted opaque into
   * a scratch canvas first, with the buildings themselves punched back out, so
   * neighbouring tiles cannot stack alpha into a dark seam.
   */
  private paintBuildingShadows(
    ctx: CanvasRenderingContext2D,
    tx0: number,
    ty0: number,
  ): void {
    const scratch = document.createElement('canvas');
    scratch.width = CHUNK_DEVICE;
    scratch.height = CHUNK_DEVICE;
    const sctx = scratch.getContext('2d') as CanvasRenderingContext2D;
    const dx = SHADOW_DEPTH * SUN_X * RENDER_SCALE;
    const dy = SHADOW_DEPTH * SUN_Y * RENDER_SCALE;

    sctx.fillStyle = palette.shadow;
    let any = false;
    for (let ty = ty0 - 2; ty <= ty0 + CHUNK_TILES + 1; ty++) {
      for (let tx = tx0 - 2; tx <= tx0 + CHUNK_TILES + 1; tx++) {
        if (this.tileAt(tx, ty) !== T_BUILDING) continue;
        any = true;
        sctx.fillRect((tx - tx0) * TD + dx, (ty - ty0) * TD + dy, TD, TD);
      }
    }
    if (!any) return;

    sctx.globalCompositeOperation = 'destination-out';
    for (let ty = ty0 - 2; ty <= ty0 + CHUNK_TILES + 1; ty++) {
      for (let tx = tx0 - 2; tx <= tx0 + CHUNK_TILES + 1; tx++) {
        if (this.tileAt(tx, ty) !== T_BUILDING) continue;
        sctx.fillRect((tx - tx0) * TD, (ty - ty0) * TD, TD, TD);
      }
    }

    ctx.save();
    ctx.globalAlpha = 0.34;
    ctx.drawImage(scratch, 0, 0);
    ctx.restore();
  }

  /**
   * The side of the building, swept from the roof tile towards the sun-away
   * direction. Drawn opaque for every building tile; interior walls are then
   * covered by neighbouring roofs, leaving only the exposed faces visible.
   */
  private paintWall(
    ctx: CanvasRenderingContext2D,
    tx: number,
    ty: number,
    x: number,
    y: number,
  ): void {
    const dx = WALL_DEPTH * SUN_X * RENDER_SCALE;
    const dy = WALL_DEPTH * SUN_Y * RENDER_SCALE;
    const roof = this.roofColor(tx, ty);

    ctx.fillStyle = shade(roof, 0.55, palette.wallShade);
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + TD, y);
    ctx.lineTo(x + TD + dx, y + dy);
    ctx.lineTo(x + TD + dx, y + dy + TD);
    ctx.lineTo(x + dx, y + dy + TD);
    ctx.lineTo(x, y + TD);
    ctx.closePath();
    ctx.fill();
  }

  private paintRoof(
    ctx: CanvasRenderingContext2D,
    tx: number,
    ty: number,
    x: number,
    y: number,
  ): void {
    const roof = this.roofColor(tx, ty);
    ctx.fillStyle = roof;
    ctx.fillRect(x, y, TD, TD);
    this.speckle(ctx, tx, ty, x, y, shade(roof, 0.12), 6, 2, 31);
    this.speckle(ctx, tx, ty, x, y, shade(roof, 0.1, '#ffffff'), 4, 1, 33);

    // Parapet: bright along the sun-facing edges, dark along the others. This
    // is what makes a block of roof tiles read as one solid mass.
    const t = 2 * RENDER_SCALE;
    const openN = this.tileAt(tx, ty - 1) !== T_BUILDING;
    const openW = this.tileAt(tx - 1, ty) !== T_BUILDING;
    const openS = this.tileAt(tx, ty + 1) !== T_BUILDING;
    const openE = this.tileAt(tx + 1, ty) !== T_BUILDING;
    ctx.fillStyle = shade(roof, 0.4, palette.roofEdgeLight);
    if (openN) ctx.fillRect(x, y, TD, t);
    if (openW) ctx.fillRect(x, y, t, TD);
    ctx.fillStyle = shade(roof, 0.3);
    if (openS) ctx.fillRect(x, y + TD - t, TD, t);
    if (openE) ctx.fillRect(x + TD - t, y, t, TD);

    // Rooftop clutter, only where there is room for it.
    if (openN || openS || openE || openW) return;
    const roll = hash2(tx, ty, 61);
    const s = RENDER_SCALE;
    if (roll > 0.86) {
      ctx.fillStyle = palette.roofUnit;
      ctx.fillRect(x + 4 * s, y + 4 * s, 8 * s, 6 * s);
      ctx.fillStyle = shade(palette.roofUnit, 0.35);
      ctx.fillRect(x + 4 * s, y + 9 * s, 8 * s, s);
    } else if (roll > 0.74) {
      ctx.fillStyle = palette.roofVent;
      ctx.fillRect(x + 6 * s, y + 6 * s, 4 * s, 4 * s);
    } else if (roll > 0.68) {
      ctx.fillStyle = palette.roofHatch;
      ctx.fillRect(x + 5 * s, y + 5 * s, 6 * s, 5 * s);
    }
  }

  /**
   * Shop fronts: awning over the doorway plus a lit sign board on the building
   * above it. Static, so it belongs in the chunk rather than the frame loop —
   * the old renderer walked every shop in the city on every frame.
   */
  private paintShops(ctx: CanvasRenderingContext2D, tx0: number, ty0: number): void {
    const map = this.map as CityMap;
    for (const shop of map.shops) {
      if (
        shop.doorX < tx0 - 2 ||
        shop.doorY < ty0 - 2 ||
        shop.doorX > tx0 + CHUNK_TILES + 1 ||
        shop.doorY > ty0 + CHUNK_TILES + 1
      ) {
        continue;
      }
      const x = (shop.doorX - tx0) * TD;
      const y = (shop.doorY - ty0) * TD;
      const accent = shop.kind === 'gun' ? palette.shopGun : palette.shopClothing;
      const s = RENDER_SCALE;

      ctx.fillStyle = shade(accent, 0.45);
      ctx.fillRect(x + 2 * s, y + 2 * s, TD - 4 * s, TD - 4 * s);
      ctx.fillStyle = accent;
      ctx.fillRect(x + 2 * s, y + 2 * s, TD - 4 * s, 3 * s);
      ctx.fillStyle = shade(accent, 0.25, '#ffffff');
      ctx.fillRect(x + 3 * s, y + 3 * s, TD - 6 * s, s);

      // Doormat stripes, so the interaction zone is legible at a glance.
      ctx.fillStyle = shade(accent, 0.6, '#ffffff');
      for (let i = 0; i < 3; i++) {
        ctx.fillRect(x + (5 + i * 3) * s, y + 8 * s, 2 * s, 5 * s);
      }
    }
  }
}
