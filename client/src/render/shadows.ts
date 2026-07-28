import { type CityMap, T_BUILDING, TILE_SIZE } from 'shared';

/**
 * Shadow casting for the light pass.
 *
 * The lights used to be radial gradients blitted over the scene, which meant a
 * street lamp lit the inside of the block behind it and a headlight beam went
 * straight through a tower. This is the fix, and it is the cheap half of what
 * a 2D ray tracer does: rather than marching a ray per pixel, take the silhouette
 * edges of everything solid near the light and extrude them away from it. The
 * union of those quads is exactly the set of points no ray reaches, computed in
 * geometry rather than in samples — same answer, a few dozen fills instead of a
 * few hundred thousand traces.
 *
 * The occluders are tiles, not sprites: the city is a grid and buildings own
 * whole cells, so the silhouette of a block is a handful of axis-aligned
 * segments and finding them is a scan over the tiles the light can reach.
 * People, cars and street furniture deliberately cast nothing — a top-down
 * camera looking at a 12-pixel character does not want that character painting
 * a hole across the road, and the cost of the ones that matter is what buys
 * the shadows on the ones that do.
 */

/**
 * The silhouette edges of the buildings within `radius` of a light, as a flat
 * run of `x0, y0, x1, y1` in world pixels.
 *
 * An edge is in the silhouette when it faces the light and the cell across it
 * is not itself solid — the interior seams of a block would otherwise emit
 * segments that are already in shadow, quadrupling the fill count for no
 * visible difference.
 *
 * Endpoints are emitted in a consistent rotational order about the light, so
 * every shadow volume built from them winds the same way and a single
 * non-zero fill unions them. Wound inconsistently, two overlapping quads
 * cancel and a bright seam opens up down the middle of a wall's shadow.
 *
 * Writes into a caller-owned array so a frame's worth of lights costs no
 * allocation. Returns the number of segments.
 */
export function occluderEdges(
  map: CityMap,
  lx: number,
  ly: number,
  radius: number,
  out: number[],
): number {
  out.length = 0;
  const W = map.widthTiles;
  const H = map.heightTiles;
  const tx0 = Math.max(0, Math.floor((lx - radius) / TILE_SIZE));
  const ty0 = Math.max(0, Math.floor((ly - radius) / TILE_SIZE));
  const tx1 = Math.min(W - 1, Math.floor((lx + radius) / TILE_SIZE));
  const ty1 = Math.min(H - 1, Math.floor((ly + radius) / TILE_SIZE));

  const solid = (tx: number, ty: number): boolean =>
    tx >= 0 && ty >= 0 && tx < W && ty < H && map.tiles[ty * W + tx] === T_BUILDING;

  for (let ty = ty0; ty <= ty1; ty++) {
    for (let tx = tx0; tx <= tx1; tx++) {
      if (!solid(tx, ty)) continue;
      const x0 = tx * TILE_SIZE;
      const y0 = ty * TILE_SIZE;
      const x1 = x0 + TILE_SIZE;
      const y1 = y0 + TILE_SIZE;
      if (lx < x0 && !solid(tx - 1, ty)) out.push(x0, y0, x0, y1);
      else if (lx > x1 && !solid(tx + 1, ty)) out.push(x1, y1, x1, y0);
      if (ly < y0 && !solid(tx, ty - 1)) out.push(x0, y0, x1, y0);
      else if (ly > y1 && !solid(tx, ty + 1)) out.push(x1, y1, x0, y1);
    }
  }
  return out.length >> 2;
}

/**
 * How far past the light's own reach a shadow volume is extruded, as a
 * multiple of the radius.
 *
 * Not a detail: the far edge of the quad is a chord, and a chord across a wide
 * angle cuts back inside the arc it is meant to cover, which shows up as a
 * bright wedge sitting on top of a wall. Eight radii plus the midpoint fan
 * below keeps the error under a pixel for any span a tile edge can subtend,
 * including the degenerate case of a lamp standing against the wall.
 */
const EXTRUDE = 8;

/**
 * Punch the shadow of every segment out of whatever is already on `ctx`.
 *
 * Coordinates arrive in world pixels and land in the scratch canvas the light
 * is being assembled in: `(cx, cy)` is where the light itself sits in that
 * canvas and `scale` is device pixels per world pixel. The caller sets the
 * composite mode — `destination-out` for the umbra — so this can be used both
 * to cut a light and, with `source-over`, to draw the same volumes as ground
 * shadow if that is ever wanted.
 */
export function punchShadows(
  ctx: CanvasRenderingContext2D,
  segs: number[],
  count: number,
  lx: number,
  ly: number,
  cx: number,
  cy: number,
  scale: number,
  radius: number,
): void {
  if (count === 0) return;
  const reach = radius * scale * EXTRUDE;
  ctx.beginPath();
  for (let i = 0; i < count; i++) {
    const o = i << 2;
    const ax = ((segs[o] as number) - lx) * scale;
    const ay = ((segs[o + 1] as number) - ly) * scale;
    const bx = ((segs[o + 2] as number) - lx) * scale;
    const by = ((segs[o + 3] as number) - ly) * scale;
    const mx = (ax + bx) / 2;
    const my = (ay + by) / 2;
    const la = Math.hypot(ax, ay) || 1e-6;
    const lb = Math.hypot(bx, by) || 1e-6;
    const lm = Math.hypot(mx, my) || 1e-6;
    ctx.moveTo(cx + ax, cy + ay);
    ctx.lineTo(cx + bx, cy + by);
    ctx.lineTo(cx + (bx * reach) / lb, cy + (by * reach) / lb);
    // The midpoint ray splits the far edge in two, so each chord spans half
    // the angle and stays outside the arc it is standing in for.
    ctx.lineTo(cx + (mx * reach) / lm, cy + (my * reach) / lm);
    ctx.lineTo(cx + (ax * reach) / la, cy + (ay * reach) / la);
    ctx.closePath();
  }
  ctx.fill();
}
