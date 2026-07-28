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
 * Two things make the result read as light rather than as stencilling, and both
 * are here rather than in the compositing:
 *
 *  - **Nothing is a point source.** A shadow is cast several times from points
 *    spread across the lamp's own face, each at a fraction of full strength.
 *    Where every sample agrees you get the umbra; along the edges, where only
 *    some do, you get a penumbra that widens with distance from the occluder
 *    exactly as it does in the world. It replaces a fixed blur, which softened
 *    a shadow's root as much as its tip and cost more.
 *  - **Shadows end.** A shadow's length is set by how tall the occluder is
 *    against how high the light hangs: `d * h / (H - h)`. A pedestrian under a
 *    street lamp throws a stub; the same pedestrian in a headlight — a light
 *    lower than they are tall — throws one down the whole street. That ratio is
 *    most of why headlights look like headlights.
 */

/** Numbers per silhouette segment: x0, y0, x1, y1, and the length multiplier. */
export const SEG_STRIDE = 5;

/**
 * Something that stands in the light and is not part of the city: a person, a
 * car. `r > 0` is a disc; otherwise it is a box `halfLong` by `halfWide` about
 * `heading`.
 */
export interface Occluder {
  x: number;
  y: number;
  /** Disc radius, world px. Zero for a box. */
  r: number;
  halfLong: number;
  halfWide: number;
  heading: number;
  /** How tall it stands, world px — what sets how far its shadow reaches. */
  height: number;
}

/**
 * How far a shadow runs past its occluder, as a multiple of the distance from
 * the light: `H / (H - h)`. Infinite once the occluder is as tall as the light
 * is high, which is the headlight case and the building case alike.
 */
export function lengthFactor(lightHeight: number, occluderHeight: number): number {
  if (occluderHeight >= lightHeight) return Infinity;
  return lightHeight / (lightHeight - occluderHeight);
}

/**
 * Add one silhouette segment, wound consistently about the light.
 *
 * Every shadow volume built from these has to wind the same way, so that a
 * single non-zero fill unions them: wound inconsistently, two overlapping
 * quads cancel and a bright seam opens up down the middle of a wall's shadow.
 */
function pushSegment(
  out: number[],
  lx: number,
  ly: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
  k: number,
): void {
  const cross = (ax - lx) * (by - ly) - (ay - ly) * (bx - lx);
  if (cross >= 0) out.push(ax, ay, bx, by, k);
  else out.push(bx, by, ax, ay, k);
}

/**
 * The silhouette edges of the buildings within `radius` of a light.
 *
 * The occluders are tiles, not sprites: the city is a grid and buildings own
 * whole cells, so the silhouette of a block is a handful of axis-aligned
 * segments and finding them is a scan over the tiles the light can reach.
 *
 * An edge is in the silhouette when it faces the light and the cell across it
 * is not itself solid — the interior seams of a block would otherwise emit
 * segments that are already in shadow, quadrupling the fill count for no
 * visible difference. Buildings are taller than any light in the city, so
 * their shadows never end.
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
      if (lx < x0 && !solid(tx - 1, ty)) out.push(x0, y0, x0, y1, Infinity);
      else if (lx > x1 && !solid(tx + 1, ty)) out.push(x1, y1, x1, y0, Infinity);
      if (ly < y0 && !solid(tx, ty - 1)) out.push(x0, y0, x1, y0, Infinity);
      else if (ly > y1 && !solid(tx, ty + 1)) out.push(x1, y1, x0, y1, Infinity);
    }
  }
  return out.length / SEG_STRIDE;
}

/**
 * Silhouettes of the people and cars within `radius`, appended to `out`.
 *
 * A disc contributes the chord between its two tangent points; a box the one
 * or two faces the light can see. Both are exact rather than sampled, which
 * matters at this scale — a pedestrian is twelve pixels across and an
 * approximation of them is visibly the wrong shape at the far end of a
 * headlight beam.
 *
 * Returns the new total segment count, so a caller can collect buildings and
 * bodies into one array and punch them in a single pass.
 */
export function entityEdges(
  occluders: readonly Occluder[],
  lx: number,
  ly: number,
  radius: number,
  lightHeight: number,
  out: number[],
): number {
  for (const o of occluders) {
    const dx = o.x - lx;
    const dy = o.y - ly;
    const reach = radius + Math.max(o.r, Math.hypot(o.halfLong, o.halfWide));
    if (dx * dx + dy * dy > reach * reach) continue;
    const k = lengthFactor(lightHeight, o.height);

    if (o.r > 0) {
      const dist = Math.hypot(dx, dy);
      // Standing inside the light itself: there is no silhouette to take, and
      // the tangent construction has no answer.
      if (dist <= o.r) continue;
      const base = Math.atan2(-dy, -dx); // from the occluder back to the light
      const half = Math.acos(Math.min(1, o.r / dist));
      pushSegment(
        out,
        lx,
        ly,
        o.x + Math.cos(base + half) * o.r,
        o.y + Math.sin(base + half) * o.r,
        o.x + Math.cos(base - half) * o.r,
        o.y + Math.sin(base - half) * o.r,
        k,
      );
      continue;
    }

    const cos = Math.cos(o.heading);
    const sin = Math.sin(o.heading);
    const cx = [1, 1, -1, -1];
    const cy = [-1, 1, 1, -1];
    // Corners in order around the box, so consecutive pairs are its edges.
    const px: number[] = [];
    const py: number[] = [];
    for (let i = 0; i < 4; i++) {
      const lo = (cx[i] as number) * o.halfLong;
      const wi = (cy[i] as number) * o.halfWide;
      px.push(o.x + cos * lo - sin * wi);
      py.push(o.y + sin * lo + cos * wi);
    }
    for (let i = 0; i < 4; i++) {
      const j = (i + 1) & 3;
      const ex = (px[j] as number) - (px[i] as number);
      const ey = (py[j] as number) - (py[i] as number);
      // The light sees this face when it lies on the outward side of it. The
      // corners run one way round the box, so the sign is fixed: get it
      // backwards and a car shadows everything except what is behind it.
      const side = ex * (ly - (py[i] as number)) - ey * (lx - (px[i] as number));
      if (side >= 0) continue;
      pushSegment(
        out,
        lx,
        ly,
        px[i] as number,
        py[i] as number,
        px[j] as number,
        py[j] as number,
        k,
      );
    }
  }
  return out.length / SEG_STRIDE;
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
 * is being assembled in: `(cx, cy)` is where the light's centre sits in that
 * canvas and `scale` is device pixels per world pixel. `(ox, oy)` offsets the
 * rays' origin without moving the silhouette — that is one sample of the
 * lamp's own face, and stacking several of them at partial strength is what
 * produces a penumbra.
 *
 * The caller sets the composite mode — `destination-out` to cut a light — so
 * the same volumes could be drawn as ground shadow if that is ever wanted.
 */
export function punchShadows(
  ctx: CanvasRenderingContext2D,
  segs: number[],
  count: number,
  lx: number,
  ly: number,
  ox: number,
  oy: number,
  cx: number,
  cy: number,
  scale: number,
  radius: number,
): void {
  if (count === 0) return;
  const reach = radius * scale * EXTRUDE;
  // Where this sample's rays start, in sprite pixels.
  const px = cx + ox * scale;
  const py = cy + oy * scale;
  ctx.beginPath();
  for (let i = 0; i < count; i++) {
    const o = i * SEG_STRIDE;
    const ax = ((segs[o] as number) - lx - ox) * scale;
    const ay = ((segs[o + 1] as number) - ly - oy) * scale;
    const bx = ((segs[o + 2] as number) - lx - ox) * scale;
    const by = ((segs[o + 3] as number) - ly - oy) * scale;
    const k = segs[o + 4] as number;
    const mx = (ax + bx) / 2;
    const my = (ay + by) / 2;
    const la = Math.hypot(ax, ay) || 1e-6;
    const lb = Math.hypot(bx, by) || 1e-6;
    const lm = Math.hypot(mx, my) || 1e-6;
    // Each ray runs to where the occluder's own height stops it, or to the
    // edge of the light, whichever comes first.
    const fa = Math.min(reach, la * k);
    const fb = Math.min(reach, lb * k);
    const fm = Math.min(reach, lm * k);
    ctx.moveTo(px + ax, py + ay);
    ctx.lineTo(px + bx, py + by);
    ctx.lineTo(px + (bx * fb) / lb, py + (by * fb) / lb);
    // The midpoint ray splits the far edge in two, so each chord spans half
    // the angle and stays outside the arc it is standing in for.
    ctx.lineTo(px + (mx * fm) / lm, py + (my * fm) / lm);
    ctx.lineTo(px + (ax * fa) / la, py + (ay * fa) / la);
    ctx.closePath();
  }
  ctx.fill();
}

/**
 * Where on the lamp's face to take sample `i` of `n`, as an offset from its
 * centre in world pixels.
 *
 * A ring rather than a disc: the samples that matter for a penumbra are the
 * ones furthest apart, and the centre of the face contributes an edge that
 * every other sample already covers. Rotated by a fixed irrational turn so
 * that neighbouring lights do not produce the same four-lobed artefact.
 */
export function sampleOffset(i: number, n: number, radius: number): [number, number] {
  if (n <= 1 || radius <= 0) return [0, 0];
  const a = (i / n) * Math.PI * 2 + i * 2.399963;
  return [Math.cos(a) * radius, Math.sin(a) * radius];
}

/**
 * Per-sample opacity that lands the fully-shadowed region on exactly `keep` of
 * the light.
 *
 * `destination-out` is multiplicative, so N punches at alpha `a` leave
 * `(1 - a)^N`. Setting that equal to `keep` and solving is the difference
 * between a believable umbra and one that is 37% too bright because somebody
 * assumed the alphas added up.
 */
export function sampleAlpha(keep: number, samples: number): number {
  if (samples <= 1) return 1 - keep;
  return 1 - Math.pow(Math.max(1e-4, keep), 1 / samples);
}
