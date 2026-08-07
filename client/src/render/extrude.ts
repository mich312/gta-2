import {
  type CityMap,
  T_BUILDING,
  TILE_SIZE,
  buildingCorners,
  buildingMass,
  buildingStoreys,
} from 'shared';
import type { Vec2 } from 'shared';
import { PARALLAX_PX_PER_STOREY, RENDER_SCALE, SUN_X, SUN_Y } from './config.js';
import palette from 'shared/data/palette.json';
import { hash2 } from './noise.js';
import { viewport } from './viewport.js';
import { extrusionOf, parallaxOffset, rotatedExtrusionOf } from './extrudeGeom.js';

/**
 * True parallax extrusion (SHIP.md U2, `GRAPHICS.md` "what's next" #1).
 *
 * The cached chunk sweeps every building tile in one fixed direction, which
 * is free per frame and loses the parallax: every building leans the same
 * way, wherever you stand. The real effect is that a building's roof is
 * displaced *away from the screen centre* in proportion to its height, so you
 * see the north face of buildings north of you and the south face of
 * buildings south of you — the city opens out around the camera.
 *
 * That is camera-dependent, so it cannot be baked. What makes it affordable
 * anyway is drawing per *building* rather than per tile: the cached path
 * sweeps every one of a tower's forty tiles, where this draws at most two
 * wall faces and a roof for the whole mass. A screenful is a few dozen
 * buildings, not a few hundred tiles.
 *
 * Roof colour matches `TileLayer.roofColor`'s formula exactly — same hash,
 * same palette variants — so switching the flag changes the geometry and not
 * the paint.
 */

export class ExtrudeLayer {
  /** Buildings drawn on the last frame, for the debug overlay. */
  lastCount = 0;

  private map: CityMap | null = null;

  /**
   * Which buildings may be drawn as ONE turned mass: those that face a street
   * AND whose footprint is solid wall.
   *
   * The same rule `TileLayer.massesNear` and the 3D city's walk apply, and
   * for the same reason — a shop is a room punched out of a footprint and
   * open to the sky, so a mass over the whole rect puts a lid on it. Having
   * it in only two of the three renderers is what made `?extrude=1` lid
   * thirty-two shops the other two drew open (§22.4).
   *
   * Computed once per map rather than per frame: this runs inside the draw
   * loop's building sweep.
   */
  private massed: Uint8Array = new Uint8Array(0);

  /** Whether each building's footprint is solid wall, turned or not. */
  private solid: Uint8Array = new Uint8Array(0);

  /**
   * Supplies each building's baked roof. Owned by `TileLayer`, which has the
   * tile-level painters; null falls back to a flat fill.
   */
  constructor(private readonly roofCanvas: (index: number) => HTMLCanvasElement | null) {}

  setMap(map: CityMap): void {
    this.map = map;
    const W = map.widthTiles;
    this.massed = new Uint8Array(map.buildings.length);
    this.solid = new Uint8Array(map.buildings.length);
    for (let i = 0; i < map.buildings.length; i++) {
      const b = map.buildings[i];
      if (!b) continue;
      let solid = true;
      for (let ty = b.y; ty < b.y + b.h && solid; ty++) {
        for (let tx = b.x; tx < b.x + b.w; tx++) {
          if (tx < 0 || ty < 0 || tx >= W || ty >= map.heightTiles) continue;
          if (map.tiles[ty * W + tx] !== T_BUILDING) {
            solid = false;
            break;
          }
        }
      }
      if (!solid) continue;
      this.solid[i] = 1;
      if ((b.angle ?? 0) !== 0) this.massed[i] = 1;
    }
  }

  /**
   * Draw every visible building as a extruded mass.
   *
   * `originX/originY` are the same snapped device-pixel world origin the tile
   * layer uses, so the bases land exactly on the cached ground beneath them.
   */
  draw(ctx: CanvasRenderingContext2D, cam: Vec2, originX: number, originY: number): void {
    const map = this.map;
    if (!map) return;

    // The camera's world-space centre: the point everything leans away from.
    const cx = cam.x + viewport.w / 2;
    const cy = cam.y + viewport.h / 2;
    // Half-extents, in world px, used to normalise the lean to [-1, 1] at the
    // screen edge. Without this the effect would depend on window size.
    const hx = viewport.w / 2;
    const hy = viewport.h / 2;

    // Cull to the viewport plus a generous margin: a tall building whose base
    // is off-screen can still have its roof on-screen.
    const margin = TILE_SIZE * 8;
    const x0 = cam.x - margin;
    const y0 = cam.y - margin;
    const x1 = cam.x + viewport.w + margin;
    const y1 = cam.y + viewport.h + margin;

    let count = 0;
    // Painter's order: far buildings first, so a near tower's wall covers the
    // one behind it rather than being covered by it. "Far" is distance from
    // the camera centre, which is the axis the lean happens along.
    const visible: Array<{ i: number; d: number }> = [];
    for (let i = 0; i < map.buildings.length; i++) {
      const b = map.buildings[i];
      if (!b) continue;
      const bx = b.x * TILE_SIZE;
      const by = b.y * TILE_SIZE;
      const bw = b.w * TILE_SIZE;
      const bh = b.h * TILE_SIZE;
      if (bx + bw < x0 || bx > x1 || by + bh < y0 || by > y1) continue;
      const mx = bx + bw / 2 - cx;
      const my = by + bh / 2 - cy;
      visible.push({ i, d: mx * mx + my * my });
    }
    visible.sort((a, b) => b.d - a.d);

    for (const { i } of visible) {
      const b = map.buildings[i];
      if (!b) continue;
      count++;

      const storeys = buildingStoreys(b);
      const lift = storeys * PARALLAX_PX_PER_STOREY;

      const bx = b.x * TILE_SIZE;
      const by = b.y * TILE_SIZE;
      const bw = b.w * TILE_SIZE;
      const bh = b.h * TILE_SIZE;

      const off = parallaxOffset(bx + bw / 2, by + bh / 2, cx, cy, hx, hy, lift);

      const roof = this.roofColor(i, b.district);
      const sunSide = shade(roof, 0.42, palette.wallShade);
      const darkSide = shade(roof, 0.62, palette.wallShade);

      // Device-pixel base rect, rounded once so walls and roof share edges.
      const px0 = originX + Math.round(bx * RENDER_SCALE);
      const py0 = originY + Math.round(by * RENDER_SCALE);
      const px1 = originX + Math.round((bx + bw) * RENDER_SCALE);
      const py1 = originY + Math.round((by + bh) * RENDER_SCALE);

      // A building that faces a street leans as the mass it is drawn as
      // (§20), not as its bookkeeping rect: the wall the lean uncovers is on
      // the turned edge, and the roof that lands on top of it is turned too.
      const turned = this.massed[i] === 1;
      const corners = turned
        ? buildingCorners(b).map(
            ([cxT, cyT]) =>
              [
                originX + Math.round(cxT * TILE_SIZE * RENDER_SCALE),
                originY + Math.round(cyT * TILE_SIZE * RENDER_SCALE),
              ] as [number, number],
          )
        : null;

      const ex = extrusionOf(
        { x: px0, y: py0, w: px1 - px0, h: py1 - py0 },
        off.x * RENDER_SCALE,
        off.y * RENDER_SCALE,
      );
      const rex = corners
        ? rotatedExtrusionOf(corners, off.x * RENDER_SCALE, off.y * RENDER_SCALE)
        : null;

      // The mass at ground level. The cached chunk paints no ground under a
      // building — the baked roof used to cover it — so without this the
      // displaced roof uncovers a hole where the footprint was.
      ctx.fillStyle = darkSide;
      if (corners) {
        ctx.beginPath();
        ctx.moveTo((corners[0] as [number, number])[0], (corners[0] as [number, number])[1]);
        for (let p = 1; p < corners.length; p++) {
          ctx.lineTo((corners[p] as [number, number])[0], (corners[p] as [number, number])[1]);
        }
        ctx.closePath();
        ctx.fill();
      } else if (this.solid[i] === 1) {
        ctx.fillRect(ex.base.x, ex.base.y, ex.base.w, ex.base.h);
      } else {
        // A footprint with a room punched out of it is filled tile by tile,
        // over its WALLS only. Filling the whole rect put a lid on every shop
        // in the parallax renderer — the chunk beneath has painted the open
        // floor, its counter and its shelves, and this covered them.
        const W = map.widthTiles;
        for (let ty = b.y; ty < b.y + b.h; ty++) {
          for (let tx = b.x; tx < b.x + b.w; tx++) {
            if (tx < 0 || ty < 0 || tx >= W || ty >= map.heightTiles) continue;
            if (map.tiles[ty * W + tx] !== T_BUILDING) continue;
            const qx = originX + Math.round(tx * TILE_SIZE * RENDER_SCALE);
            const qy = originY + Math.round(ty * TILE_SIZE * RENDER_SCALE);
            const qw = originX + Math.round((tx + 1) * TILE_SIZE * RENDER_SCALE) - qx;
            const qh = originY + Math.round((ty + 1) * TILE_SIZE * RENDER_SCALE) - qy;
            ctx.fillRect(qx, qy, qw, qh);
          }
        }
      }

      for (const f of (rex ?? ex).faces) {
        // A face lit by the sun only if its outward normal points into it.
        const lit = f.nx * SUN_X + f.ny * SUN_Y > 0;
        ctx.fillStyle = lit ? sunSide : darkSide;
        ctx.beginPath();
        ctx.moveTo(f.pts[0] as number, f.pts[1] as number);
        for (let p = 2; p < f.pts.length; p += 2) {
          ctx.lineTo(f.pts[p] as number, f.pts[p + 1] as number);
        }
        ctx.closePath();
        ctx.fill();
      }

      const baked = this.roofCanvas(i);
      if (corners) {
        // The roof lands on the leaned mass, turned with it.
        const mass = buildingMass(b);
        ctx.save();
        ctx.translate(
          originX + mass.cx * TILE_SIZE * RENDER_SCALE + ex.dx,
          originY + mass.cy * TILE_SIZE * RENDER_SCALE + ex.dy,
        );
        ctx.rotate(mass.rad);
        const mw = mass.w * TILE_SIZE * RENDER_SCALE;
        const mh = mass.h * TILE_SIZE * RENDER_SCALE;
        if (baked) ctx.drawImage(baked, -mw / 2, -mh / 2, mw, mh);
        else {
          ctx.fillStyle = roof;
          ctx.fillRect(-mw / 2, -mh / 2, mw, mh);
        }
        ctx.restore();
      } else if (baked) {
        ctx.drawImage(baked, ex.roof.x, ex.roof.y);
      } else {
        ctx.fillStyle = roof;
        ctx.fillRect(ex.roof.x, ex.roof.y, ex.roof.w, ex.roof.h);
      }
    }
    this.lastCount = count;
  }

  /** Same formula as TileLayer.roofColor, keyed by building index. */
  private roofColor(index: number, district: string): string {
    const variants =
      (palette.buildingVariants as Record<string, string[]>)[district] ??
      palette.buildingVariants.downtown;
    const id = index + 1;
    const pick = hash2(id, id * 7 + 3);
    return variants[Math.floor(pick * variants.length) % variants.length] as string;
  }
}

/** Local copy of TileLayer's shade(), which is module-private there. */
function shade(hex: string, amount: number, towards = '#0b111c'): string {
  const a = parseInt(hex.slice(1), 16);
  const b = parseInt(towards.slice(1), 16);
  const mix = (sh: number): number => {
    const ca = (a >> sh) & 255;
    const cb = (b >> sh) & 255;
    return Math.round(ca + (cb - ca) * amount);
  };
  const r = mix(16);
  const g = mix(8);
  const bl = mix(0);
  return `#${((r << 16) | (g << 8) | bl).toString(16).padStart(6, '0')}`;
}
