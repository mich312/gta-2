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
  T_BANK,
  T_TREES,
  T_SAND,
  T_RUNWAY,
  T_RAMP,
  T_FLOOR,
  TILE_SIZE,
  RIGHT_SIGN,
} from 'shared';
import palette from 'shared/data/palette.json';
import {
  CHUNK_BUILDS_PER_FRAME,
  CHUNK_CACHE_LIMIT,
  ROOF_CACHE_LIMIT,
  CHUNK_TILES,
  RENDER_SCALE,
  SHADOW_DEPTH,
  SUN_X,
  SUN_Y,
  WALL_DEPTH,
} from './config.js';
import { hash2 } from './noise.js';
import type { SpriteSheet } from './sprites.js';
import { viewport } from './viewport.js';
import { ExtrudeLayer } from './extrude.js';

/** The proving ground's colour: deliberately unlike any shop's. */
const DEPOT_ACCENT = '#5aa84e';

const CHUNK_WORLD = CHUNK_TILES * TILE_SIZE;
const CHUNK_DEVICE = CHUNK_WORLD * RENDER_SCALE;
/** Device pixels per tile. */
const TD = TILE_SIZE * RENDER_SCALE;

/** A road is a road, not a junction, once its cross-run is this long. */
const RUN_ROAD = 8;
/** Carriageway width at which a street counts as a main road. */
/**
 * Carriageway width, in tiles, at which a street is a main road.
 *
 * Exported because the 3D renderer needs the same threshold: it was marking
 * every arm of every junction, which is the default this constant exists to
 * replace.
 */
export const ARTERIAL_WIDTH = 4;

/**
 * Where the centre line falls inside one carriageway tile, as a fraction of
 * the tile from its low edge — or null when the centre is not in this tile.
 *
 * The old rule was "the far edge of tile `floor(width / 2) - 1`", which is the
 * middle only when the road is an even number of tiles across. Every secondary
 * road in this city is three tiles wide, so the line landed on the boundary
 * between the first tile and the second, and the street had a lane and a half
 * on one side of it and half a lane on the other.
 *
 * The sim never agreed: `laneOptions` has always put the two lanes at the true
 * centre of the drivable span, plus and minus a quarter of its width. This is
 * the paint catching up, and it is a pure function so the arithmetic can be
 * checked without a canvas.
 */
export function laneCentreInTile(width: number, index: number): number | null {
  if (width < 2) return null;
  const at = width / 2 - index;
  return at > 0 && at <= 1 ? at : null;
}

interface Chunk {
  canvas: HTMLCanvasElement;
  /** Frame counter of last use, for eviction. */
  touched: number;
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
  /**
   * When true, walls and roofs are left out of the cached chunk because
   * `ExtrudeLayer` draws them per frame with real parallax (SHIP.md U2).
   * Ground, shadows and shop fronts stay baked either way.
   */
  extruded = false;
  /** Buildings the extrude pass drew last frame, surfaced for the overlay. */
  lastBuildingsDrawn = 0;

  private readonly extrude = new ExtrudeLayer((i) => this.roofCanvasFor(i));
  private readonly roofCache = new Map<number, HTMLCanvasElement>();
  private map: CityMap | null = null;
  private chunks = new Map<number, Chunk>();
  private frameCounter = 0;
  /** Building index per tile (1-based; 0 = not a building). */
  private buildingOf: Int32Array = new Int32Array(0);
  /** Shop index per tile of its building footprint (1-based; 0 = none). */
  private shopOf: Int32Array = new Int32Array(0);
  /** Contiguous road-run length and index within it, per axis. */
  private runH: Uint8Array = new Uint8Array(0);
  private runV: Uint8Array = new Uint8Array(0);
  private idxH: Uint8Array = new Uint8Array(0);
  private idxV: Uint8Array = new Uint8Array(0);

  constructor(private readonly sprites: SpriteSheet) {}

  setMap(map: CityMap): void {
    this.map = map;
    this.extrude.setMap(map);
    this.roofCache.clear();
    this.chunks.clear();
    this.indexBuildings(map);
    this.indexShops(map);
    this.indexRoadRuns(map);
  }

  /** Drop every cached chunk — used when the sprite sheet finishes loading. */
  invalidate(): void {
    this.chunks.clear();
    this.roofCache.clear();
  }

  /**
   * One building's roof, baked to its own canvas.
   *
   * The parallax pass moves roofs per frame, so they cannot live in the
   * chunk — but repainting the speckle, parapets and clutter per frame would
   * put the per-tile cost straight back that drawing per building just took
   * out. Baking each roof once and blitting it displaced keeps both: the art
   * is the identical `paintRoof` the cached path uses, and the per-frame cost
   * is one `drawImage` per building.
   *
   * Returns null while the map is missing or the index is stale, in which
   * case the caller falls back to a flat fill.
   */
  private roofCanvasFor(index: number): HTMLCanvasElement | null {
    const cached = this.roofCache.get(index);
    if (cached) return cached;
    const map = this.map;
    const b = map?.buildings[index];
    if (!map || !b) return null;

    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, b.w * TD);
    canvas.height = Math.max(1, b.h * TD);
    const ctx = canvas.getContext('2d') as CanvasRenderingContext2D;
    ctx.imageSmoothingEnabled = false;
    for (let ty = b.y; ty < b.y + b.h; ty++) {
      for (let tx = b.x; tx < b.x + b.w; tx++) {
        // A footprint is a rect but its tiles are not all building — a shop
        // interior is punched out of one. Painting a roof over the hole would
        // put a lid on a room that is open to the sky.
        if (this.tileAt(tx, ty) !== T_BUILDING) continue;
        this.paintRoof(ctx, tx, ty, (tx - b.x) * TD, (ty - b.y) * TD);
      }
    }
    this.roofCache.set(index, canvas);
    if (this.roofCache.size > ROOF_CACHE_LIMIT) {
      const oldest = this.roofCache.keys().next().value;
      if (oldest !== undefined) this.roofCache.delete(oldest);
    }
    return canvas;
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
    const cx1 = Math.floor((cam.x + viewport.w) / CHUNK_WORLD);
    const cy1 = Math.floor((cam.y + viewport.h) / CHUNK_WORLD);

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

    // Buildings last: they stand on the ground the chunks just laid down, and
    // under everything the renderer draws after this.
    if (this.extruded) {
      this.extrude.draw(ctx, cam, originX, originY);
      this.lastBuildingsDrawn = this.extrude.lastCount;
    }
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
   * Which shop each interior tile belongs to, so a floor tile knows whose
   * shop it is standing in without searching the whole shop list per tile.
   */
  private indexShops(map: CityMap): void {
    this.shopOf = new Int32Array(map.widthTiles * map.heightTiles);
    map.shops.forEach((shop, i) => {
      const r = shop.interior;
      for (let ty = r.y - 1; ty <= r.y + r.h; ty++) {
        for (let tx = r.x - 1; tx <= r.x + r.w; tx++) {
          if (tx < 0 || ty < 0 || tx >= map.widthTiles || ty >= map.heightTiles) continue;
          this.shopOf[ty * map.widthTiles + tx] = i + 1;
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

  /**
   * A chunk with ONLY the ground painted, for the 3D renderer to stand on.
   *
   * The 3D city is built from instanced boxes carrying one flat colour per
   * surface type — fourteen of them for the whole world — while this class has
   * always painted the same ground out of forty-odd palette entries with
   * grain, resurfacing patches, manholes, kerb shading, paving joints, lane
   * marks and a per-district pavement tint. Ground is around ninety per cent
   * of a top-down frame, so that difference is most of why the 3D city reads
   * as a model of a city rather than a city.
   *
   * Rather than re-implement any of it in a shader, the 3D ground layer takes
   * these canvases as textures. It is a divergence being removed, not an art
   * pipeline being forked.
   *
   * Ground only: no walls, no roofs, and none of the baked drop shadows
   * `buildChunk` adds — 3D has its own geometry and its own shadow map, and
   * baking a second set under them would double every one.
   *
   * **Water is left transparent; buildings are not.** Both are real volumes in
   * 3D, but only one of them is a hole. A building stands well above this
   * plane and hides its own footprint, so the footprint can be filled with
   * anything and painting it costs nothing. Water sits *below* the plane, so
   * painting it would lay a flat lid over a surface that is supposed to have a
   * depth and a shoreline.
   *
   * That distinction is worth the extra flag it returns: a chunk with no water
   * in it needs no alpha at all, and most chunks have none. `holes` says which
   * ones do, so the ground layer can draw the rest opaque and keep early-z.
   */
  groundChunk(cx: number, cy: number): { canvas: HTMLCanvasElement; holes: boolean } {
    const canvas = document.createElement('canvas');
    canvas.width = CHUNK_DEVICE;
    canvas.height = CHUNK_DEVICE;
    const ctx = canvas.getContext('2d') as CanvasRenderingContext2D;
    ctx.imageSmoothingEnabled = false;

    const tx0 = cx * CHUNK_TILES;
    const ty0 = cy * CHUNK_TILES;
    let holes = false;
    for (let ty = ty0; ty < ty0 + CHUNK_TILES; ty++) {
      for (let tx = tx0; tx < tx0 + CHUNK_TILES; tx++) {
        const tile = this.tileAt(tx, ty);
        const x = (tx - tx0) * TD;
        const y = (ty - ty0) * TD;
        if (tile === T_WATER) {
          holes = true;
          continue;
        }
        if (tile === T_BUILDING) {
          // Under a building and never seen. Filled rather than left clear so
          // the chunk can stay opaque.
          ctx.fillStyle = palette.wallShade ?? palette.road;
          ctx.fillRect(x, y, TD, TD);
          continue;
        }
        this.paintGround(ctx, tx, ty, x, y, tile);
      }
    }
    return { canvas, holes };
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
    //
    //    Skipped entirely under `extruded`: the parallax pass draws the same
    //    masses per frame, and baking a second set underneath them would show
    //    through wherever the two disagree — which is everywhere, by design.
    if (!this.extruded) {
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
      case T_BANK:
        this.paintBank(ctx, tx, ty, x, y);
        break;
      case T_TREES:
        // Canopy: the park grass painter with the forest palette does the
        // job — solid dark green with organic speckle, denser than lawn.
        this.paintGrass(ctx, tx, ty, x, y, palette.trees, palette.treesLight, true);
        break;
      case T_SAND:
        this.paintGrass(ctx, tx, ty, x, y, palette.sand, palette.sandDark, false);
        break;
      case T_RUNWAY:
        this.paintRunway(ctx, tx, ty, x, y);
        break;
      case T_BRIDGE:
        this.paintBridge(ctx, tx, ty, x, y);
        break;
      case T_RAMP:
        this.paintRamp(ctx, tx, ty, x, y);
        break;
      case T_FLOOR:
        this.paintShopFloor(ctx, tx, ty, x, y);
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

  /**
   * Quay/embankment: flat waterfront stone with a lighter coping course
   * along the water's edge, so the drop into the river reads at a glance.
   */
  private paintBank(
    ctx: CanvasRenderingContext2D,
    tx: number,
    ty: number,
    x: number,
    y: number,
  ): void {
    ctx.fillStyle = palette.bank;
    ctx.fillRect(x, y, TD, TD);
    ctx.fillStyle = palette.bankEdge;
    const lip = Math.max(1, (TD / 8) | 0);
    const wet = (nx: number, ny: number): boolean => {
      const t = this.tileAt(nx, ny);
      return t === T_WATER || t === T_BRIDGE;
    };
    if (wet(tx, ty - 1)) ctx.fillRect(x, y, TD, lip);
    if (wet(tx, ty + 1)) ctx.fillRect(x, y + TD - lip, TD, lip);
    if (wet(tx - 1, ty)) ctx.fillRect(x, y, lip, TD);
    if (wet(tx + 1, ty)) ctx.fillRect(x + TD - lip, y, lip, TD);
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

  /** Stunt ramp: chevrons on concrete, so it reads as "hit this fast". */
  private paintRamp(
    ctx: CanvasRenderingContext2D,
    tx: number,
    ty: number,
    x: number,
    y: number,
  ): void {
    this.paintLot(ctx, tx, ty, x, y);
    ctx.fillStyle = palette.uiAccent;
    const band = Math.max(1, (TD / 8) | 0);
    for (let i = 0; i < 3; i++) {
      ctx.fillRect(x + 2, y + 2 + i * band * 2, TD - 4, band);
    }
  }

  /**
   * The inside of a shop.
   *
   * Buying used to happen through a closed wall: the shop was a coloured
   * awning on the pavement and a menu that opened when you stood near it. The
   * generator now hollows the building out, so there is a room to walk into —
   * and because the roof simply is not drawn over floor tiles, it reads as a
   * cutaway from above without a second render pass.
   *
   * Fittings are derived per tile from the room rect and where its door is:
   * threshold on the doorway, counter along the back wall, shelves down the
   * sides, and a marked-out bay instead for a respray you drive into.
   */
  private paintShopFloor(
    ctx: CanvasRenderingContext2D,
    tx: number,
    ty: number,
    x: number,
    y: number,
  ): void {
    const map = this.map as CityMap;
    const shop = map.shops[(this.shopOf[ty * map.widthTiles + tx] as number) - 1];
    const s = RENDER_SCALE;

    // Chequered floor with a grout line along the north and west edges.
    const base = ((tx + ty) & 1) === 0 ? palette.shopFloor : palette.shopFloorAlt;
    ctx.fillStyle = base;
    ctx.fillRect(x, y, TD, TD);
    this.speckle(ctx, tx, ty, x, y, shade(base, 0.12), 5, 1, 77);
    ctx.fillStyle = shade(base, 0.3);
    ctx.fillRect(x, y, TD, s);
    ctx.fillRect(x, y, s, TD);
    if (!shop) return;

    // The proving ground is not a shop and should not look like one: a
    // green you will not mistake for a gun shop from across a junction.
    const accent =
      shop.kind === 'gun'
        ? palette.shopGun
        : shop.kind === 'clothing'
          ? palette.shopClothing
          : shop.kind === 'depot'
            ? DEPOT_ACCENT
            : palette.shopSpray;
    const r = shop.interior;
    const inRoom = tx >= r.x && tx < r.x + r.w && ty >= r.y && ty < r.y + r.h;
    if (!inRoom) {
      // The doorway itself: a threshold strip in the shop's colour.
      ctx.fillStyle = shade(accent, 0.35);
      ctx.fillRect(x + 2 * s, y + 2 * s, TD - 4 * s, TD - 4 * s);
      ctx.fillStyle = accent;
      ctx.fillRect(x + 4 * s, y + 4 * s, TD - 8 * s, TD - 8 * s);
      return;
    }

    // A respray is a garage: keep the floor clear so a car can be driven in,
    // and mark the bay out instead of furnishing it.
    if (shop.kind === 'spray' || shop.kind === 'depot') {
      ctx.fillStyle = shade(accent, 0.55);
      const stripe = Math.max(1, s);
      if (ty === r.y) ctx.fillRect(x, y + 3 * s, TD, stripe);
      if (ty === r.y + r.h - 1) ctx.fillRect(x, y + TD - 4 * s, TD, stripe);
      if (tx === r.x) ctx.fillRect(x + 3 * s, y, stripe, TD);
      if (tx === r.x + r.w - 1) ctx.fillRect(x + TD - 4 * s, y, stripe, TD);
      if (hash2(tx, ty, 78) > 0.55) {
        ctx.fillStyle = 'rgba(12, 14, 18, 0.35)';
        ctx.beginPath();
        ctx.arc(x + TD / 2, y + TD / 2, 4 * s, 0, Math.PI * 2);
        ctx.fill();
      }
      return;
    }

    // Which wall the door is in tells us where the back of the shop is.
    const doorTop = shop.entryY < r.y;
    const doorBottom = shop.entryY >= r.y + r.h;
    const doorLeft = shop.entryX < r.x;
    const vertical = doorTop || doorBottom;
    const depth = vertical ? r.h : r.w;
    const backRow = doorTop ? r.y + r.h - 1 : r.y;
    const backCol = doorLeft ? r.x + r.w - 1 : r.x;
    const atBack = vertical ? ty === backRow : tx === backCol;

    // A counter needs a shop deep enough to stand behind it.
    if (depth >= 2 && atBack) {
      ctx.fillStyle = palette.shopCounter;
      ctx.fillRect(x, y, TD, TD);
      ctx.fillStyle = palette.shopCounterTop;
      // Lip on the customer side.
      if (vertical) {
        ctx.fillRect(x, doorTop ? y : y + TD - 3 * s, TD, 3 * s);
      } else {
        ctx.fillRect(doorLeft ? x : x + TD - 3 * s, y, 3 * s, TD);
      }
      ctx.fillStyle = accent;
      ctx.fillRect(x + 3 * s, y + 3 * s, TD - 6 * s, 2 * s);
      return;
    }

    // Shelves against the side walls, stocked in the shop's colour.
    const sideWall = vertical
      ? tx === r.x || tx === r.x + r.w - 1
      : ty === r.y || ty === r.y + r.h - 1;
    if (sideWall && depth >= 3 && hash2(tx, ty, 79) > 0.35) {
      ctx.fillStyle = palette.shopShelf;
      const west = vertical ? tx === r.x : ty === r.y;
      if (vertical) ctx.fillRect(west ? x : x + TD - 5 * s, y + 2 * s, 5 * s, TD - 4 * s);
      else ctx.fillRect(x + 2 * s, west ? y : y + TD - 5 * s, TD - 4 * s, 5 * s);
      ctx.fillStyle = accent;
      for (let i = 0; i < 3; i++) {
        if (vertical) {
          ctx.fillRect(west ? x + s : x + TD - 4 * s, y + (3 + i * 4) * s, 2 * s, 2 * s);
        } else {
          ctx.fillRect(x + (3 + i * 4) * s, west ? y + s : y + TD - 4 * s, 2 * s, 2 * s);
        }
      }
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

    // Centre line: dashes along the direction of travel, down the true middle
    // of the carriageway. See `laneCentreInTile`.
    const centreInTile = laneCentreInTile(width, index);
    if (centreInTile !== null) {
      ctx.fillStyle = palette.roadLane;
      // Rounded to a whole device pixel, so an odd width does not put the line
      // on a half pixel and let the filter smear it across two.
      const at = Math.round(centreInTile * TD - t / 2);
      const dashes = 2;
      const dashLen = TD / (dashes * 2);
      for (let d = 0; d < dashes; d++) {
        const off = d * dashLen * 2 + dashLen / 2;
        if (vertical) ctx.fillRect(x + at, y + off, t, dashLen);
        else ctx.fillRect(x + off, y + at, dashLen, t);
      }
    }
    // Edge lines, held one pixel off the kerb.
    if (index === 0 || index === width - 1) {
      ctx.fillStyle = palette.roadMark;
      const near = index === 0;
      if (vertical) ctx.fillRect(near ? x + t : x + TD - 2 * t, y, t, TD);
      else ctx.fillRect(x, near ? y + t : y + TD - 2 * t, TD, t);
    }

    // Stop line + zebra on the last tile before a junction — but only where a
    // MAIN road meets it.
    //
    // Marking every arm of every junction was the default, and at this city's
    // block density it covered the place: 2589 of 16951 road tiles carried a
    // crossing, so on a short block the striping ran from one junction
    // straight into the next and the streets read as painted rather than
    // paved. Real cities put crossings on main roads. `width` is the
    // carriageway width, so four tiles or more is an arterial.
    const ahead = vertical ? this.junctionAt(tx, ty + 1) || this.junctionAt(tx, ty - 1) : this.junctionAt(tx + 1, ty) || this.junctionAt(tx - 1, ty);
    if (!ahead || width < ARTERIAL_WIDTH) return;
    const forward = vertical ? this.junctionAt(tx, ty + 1) : this.junctionAt(tx + 1, ty);

    // A stop line holds the traffic going INTO the junction, so it covers that
    // half of the carriageway and stops at the centre line. Painted across the
    // full width — which is what it used to do — it told drivers coming the
    // other way to stop at a junction they were leaving.
    //
    // `index` counts from the low edge of the run, so the approaching half is
    // the one this direction's traffic keeps to: driving on the right, that is
    // the low side heading south or west and the high side heading north or
    // east. Only the direction with the junction in front of it is marked.
    const dirIdx = vertical ? (forward ? 1 : 3) : forward ? 0 : 2;
    const onHighSide = (RIGHT_SIGN[dirIdx] as number) > 0;
    const approaching = onHighSide ? index >= width / 2 : index < width / 2;
    if (approaching) {
      ctx.fillStyle = palette.roadStop;
      if (vertical) ctx.fillRect(x, forward ? y + TD - 3 * t : y + t, TD, 2 * t);
      else ctx.fillRect(forward ? x + TD - 3 * t : x + t, y, 2 * t, TD);
    }

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

  /**
   * Runway: darker than a lot, with a dashed centreline down its long axis.
   *
   * The markings are what say "you can take off from here" without a HUD
   * prompt, and they are cheap: the ground is baked into chunk canvases once,
   * so paint on it is free forever after.
   */
  private paintRunway(
    ctx: CanvasRenderingContext2D,
    tx: number,
    ty: number,
    x: number,
    y: number,
  ): void {
    ctx.fillStyle = palette.runway;
    ctx.fillRect(x, y, TD, TD);
    // Speckle, so a long strip of it does not read as a printed rectangle.
    const n = hash2(tx, ty, 0x51f7);
    if (n > 0.72) {
      ctx.fillStyle = palette.runwayLight;
      ctx.fillRect(x + (n * 9 % 9) * RENDER_SCALE, y + (n * 13 % 11) * RENDER_SCALE, 2 * RENDER_SCALE, 2 * RENDER_SCALE);
    }
    // The centreline runs east-west, matching how the strip is stamped. Every
    // other tile, so it dashes.
    const map = this.map;
    if (!map) return;
    const above = ty > 0 ? map.tiles[(ty - 1) * map.widthTiles + tx] : -1;
    const below = ty + 1 < map.heightTiles ? map.tiles[(ty + 1) * map.widthTiles + tx] : -1;
    const mid = above === T_RUNWAY && below === T_RUNWAY;
    if (mid && tx % 2 === 0) {
      ctx.fillStyle = palette.runwayLine;
      ctx.fillRect(x, y + TD / 2 - RENDER_SCALE, TD, 2 * RENDER_SCALE);
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
    // No barrels here any more. They used to be painted into the cached tile
    // layer as scenery, with nothing behind them; they are real props now
    // (K2), streamed like every other prop and drawn by the renderer, and
    // painting a second set here would put an undamageable twin beside every
    // one you can shoot.
    if (hash2(tx, ty, 24) > 0.95 && this.sprites.has('crate')) {
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
      const accent =
        shop.kind === 'depot'
          ? DEPOT_ACCENT
          : shop.kind === 'gun'
            ? palette.shopGun
            : palette.shopClothing;
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
