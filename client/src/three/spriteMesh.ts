import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import sprites from 'shared/data/sprites.json';
import palette from 'shared/data/palette.json';

/**
 * The 2D sprite definitions, extruded into 3D meshes.
 *
 * `shared/data/sprites.json` was never really a description of pixels. Every
 * shape in it carries a `z` — a surface height — and the sprite generator
 * rasterises the shapes and then *relights every pixel from that height
 * field*, which is what makes the flat art read as solid. In other words the
 * file has always been a stack of extrusions that happened to be flattened on
 * the way out. This reads the same file and does not flatten it.
 *
 * What that buys, and why it beats hand-modelling:
 *
 * - **One source of art.** A new vehicle is still a JSON edit, and it arrives
 *   in both renderers at once. Two art pipelines for one game is how the 2D
 *   and 3D versions of a car drift apart until nobody can say which is right.
 * - **The variants come free.** `variants.body` already emits ten colourways
 *   per vehicle; in 3D that is ten paint jobs for no extra authoring.
 * - **The proportions are already tuned.** Somebody sat and made a 53×29 car
 *   read as a car. Re-deriving that by eye in a modelling pass throws that
 *   work away.
 *
 * Art units are `meta.scale` art-pixels per world pixel, and heights are in
 * the same units, so everything divides by the same number. Sprites face +x,
 * matching the convention the 2D renderer bakes rotations against.
 */

interface Shape {
  rect?: [number, number, number, number];
  disc?: [number, number, number];
  ellipse?: [number, number, number, number];
  poly?: Array<[number, number]>;
  line?: [number, number, number, number, number];
  color: string;
  z?: number;
  mirrorY?: boolean;
  alpha?: number;
}

interface SpriteDef {
  w: number;
  h: number;
  pivot?: [number, number];
  shapes: Shape[];
  variants?: Record<string, string[]>;
  /** How many walk-cycle frames the sheet emits for this body. */
  frames?: number;
  /**
   * Per-shape offsets, one per frame, keyed by the shape's index.
   *
   * This is the walk cycle: a leg is a shape, and swinging it is moving that
   * shape a couple of art pixels forward and back. The sprite generator has
   * always read this (`buildSprite`, `sprites.ts`) and the 2D renderer has
   * always drawn `_f0.._f3` off distance walked — this reader ignored both,
   * so every pedestrian, officer and player in 3D slid across the city frozen
   * in frame 0. That is what "the people do not move" was.
   */
  anim?: Record<string, Array<[number, number]>>;
}

// The JSON's inferred type is a literal shape per sprite, which does not
// unify with the tuple types above — the data is right, the inference is just
// wider than the schema. Widened once here rather than at every use.
const DEFS = (sprites as unknown as { sprites: Record<string, SpriteDef> }).sprites;
const SCALE = (sprites as unknown as { meta: { scale: number } }).meta.scale;
const PAL = palette as unknown as Record<string, string>;

/** Default surface height when a shape does not say — matches the generator. */
const DEFAULT_Z = 4;

function hexOf(name: string): number {
  const raw = PAL[name] ?? name;
  return parseInt(String(raw).replace('#', ''), 16) || 0x888888;
}

/** Paint every vertex of a geometry one colour. */
function paint(g: THREE.BufferGeometry, color: number): THREE.BufferGeometry {
  const attr = g.attributes['position'] as THREE.BufferAttribute;
  const n = attr.count;
  const c = new THREE.Color(color);
  const colors = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    colors[i * 3] = c.r;
    colors[i * 3 + 1] = c.g;
    colors[i * 3 + 2] = c.b;
  }
  g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return g;
}

/**
 * One shape, extruded from the ground to its own height.
 *
 * Every shape starts at z=0 rather than stacking on whatever is beneath it,
 * which is exactly what the height field means: `z` is the height of that
 * surface above the ground, not a thickness. A car's cabin at z=12 sitting
 * over a body at z=8 therefore overlaps it, and that is correct — the solid
 * they describe together is the union, and the union is what you see.
 */
function shapeGeometry(s: Shape, ox = 0, oy = 0): THREE.BufferGeometry | null {
  const depth = Math.max(0.5, s.z ?? DEFAULT_Z);

  if (s.rect) {
    const [x, y, w, h] = s.rect;
    const g = new THREE.BoxGeometry(w, h, depth);
    g.translate(x + w / 2 + ox, y + h / 2 + oy, depth / 2);
    return g;
  }

  if (s.disc) {
    const [cx, cy, r] = s.disc;
    // 12 sides: enough to read round at this camera, few enough that a
    // pedestrian's head is not more triangles than the car beside them.
    const g = new THREE.CylinderGeometry(r, r, depth, 12);
    g.rotateX(Math.PI / 2);
    g.translate(cx + ox, cy + oy, depth / 2);
    return g;
  }

  if (s.ellipse) {
    const [cx, cy, rx, ry] = s.ellipse;
    const g = new THREE.CylinderGeometry(1, 1, depth, 14);
    g.rotateX(Math.PI / 2);
    g.scale(rx, ry, 1);
    g.translate(cx + ox, cy + oy, depth / 2);
    return g;
  }

  if (s.line) {
    const [x0, y0, x1, y1, t] = s.line;
    const dx = x1 - x0;
    const dy = y1 - y0;
    const len = Math.hypot(dx, dy) || 1;
    const g = new THREE.BoxGeometry(len, t, depth);
    g.rotateZ(Math.atan2(dy, dx));
    g.translate((x0 + x1) / 2 + ox, (y0 + y1) / 2 + oy, depth / 2);
    return g;
  }

  if (s.poly && s.poly.length >= 3) {
    const shape = new THREE.Shape();
    const first = s.poly[0] as [number, number];
    shape.moveTo(first[0] + ox, first[1] + oy);
    for (let i = 1; i < s.poly.length; i++) {
      const p = s.poly[i] as [number, number];
      shape.lineTo(p[0] + ox, p[1] + oy);
    }
    shape.closePath();
    return new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false });
  }

  return null;
}

/** Mirror a shape about the sprite's horizontal centreline. */
function mirrored(s: Shape, h: number): Shape {
  const flipY = (y: number): number => h - y;
  if (s.rect) {
    const [x, y, w, hh] = s.rect;
    return { ...s, rect: [x, flipY(y + hh), w, hh], mirrorY: false };
  }
  if (s.disc) {
    const [cx, cy, r] = s.disc;
    return { ...s, disc: [cx, flipY(cy), r], mirrorY: false };
  }
  if (s.ellipse) {
    const [cx, cy, rx, ry] = s.ellipse;
    return { ...s, ellipse: [cx, flipY(cy), rx, ry], mirrorY: false };
  }
  if (s.line) {
    const [x0, y0, x1, y1, t] = s.line;
    return { ...s, line: [x0, flipY(y0), x1, flipY(y1), t], mirrorY: false };
  }
  if (s.poly) {
    return {
      ...s,
      poly: s.poly.map(([x, y]) => [x, flipY(y)] as [number, number]).reverse(),
      mirrorY: false,
    };
  }
  return { ...s, mirrorY: false };
}

export interface SpriteMeshOptions {
  /** Index into the sprite's `variants` lists — the paint job. */
  variant?: number;
  /**
   * Height multiplier. The authored heights were tuned to look right under a
   * relighting pass on flat art, not under a camera that can actually see
   * them, so a little exaggeration reads better in 3D. 1 is faithful.
   */
  zScale?: number;
  /**
   * Walk-cycle frame. Wrapped against the sprite's own `frames`, so asking a
   * body with no walk cycle for frame 3 gets frame 0 rather than nothing.
   */
  frame?: number;
}

const cache = new Map<string, THREE.BufferGeometry>();

/**
 * Build (or fetch) the mesh for a named sprite.
 *
 * Returns null for a name the sprite sheet does not have, so a caller can
 * fall back rather than crash on a vehicle kind that has art coming.
 */
export function spriteGeometry(
  name: string,
  opts: SpriteMeshOptions = {},
): THREE.BufferGeometry | null {
  const def = DEFS[name];
  if (!def) return null;

  const variant = opts.variant ?? 0;
  const zScale = opts.zScale ?? 1;
  const frame = Math.abs(Math.trunc(opts.frame ?? 0)) % Math.max(1, def.frames ?? 1);
  const key = `${name}|${variant}|${zScale}|${frame}`;
  const hit = cache.get(key);
  if (hit) return hit;

  // Resolve `$key` colour substitutions against the sprite's variant lists,
  // which is where a car's ten paint jobs come from.
  const resolve = (color: string): number => {
    if (!color.startsWith('$')) return hexOf(color);
    const list = def.variants?.[color.slice(1)];
    if (!list || list.length === 0) return hexOf(color.slice(1));
    return hexOf(list[variant % list.length] as string);
  };

  const parts: THREE.BufferGeometry[] = [];
  def.shapes.forEach((s, si) => {
    // The frame's offset for this shape, in art px. The mirrored copy takes
    // the same offset with y negated — the arm on the far side swings the
    // other way — which is exactly what `buildSprite` does when it rasterises
    // the sheet, so the 3D body and the 2D body are the same pose.
    const [ox, oy] = def.anim?.[String(si)]?.[frame] ?? [0, 0];
    const copies: Array<[Shape, number, number]> = s.mirrorY
      ? [
          [{ ...s, mirrorY: false }, ox, oy],
          [mirrored(s, def.h), ox, -oy],
        ]
      : [[s, ox, oy]];
    for (const [c, cx, cy] of copies) {
      const g = shapeGeometry(c, cx, cy);
      // `ExtrudeGeometry` comes back non-indexed while the box and cylinder
      // primitives are indexed, and `mergeGeometries` requires all or none.
      // Flattening every part is the cheap way to make them compatible, and
      // it has to happen BEFORE painting because it changes the vertex count.
      if (g) parts.push(paint(g.index ? g.toNonIndexed() : g, resolve(c.color)));
    }
  });
  if (parts.length === 0) return null;

  const merged = mergeGeometries(parts, false);
  for (const p of parts) p.dispose();
  if (!merged) return null;

  // Art space -> world space: centre on the pivot the 2D renderer rotates
  // about, and divide by the art scale so a 53px car is 26.5 world px long.
  const [px, py] = def.pivot ?? [def.w / 2, def.h / 2];
  merged.translate(-px, -py, 0);
  merged.scale(1 / SCALE, 1 / SCALE, zScale / SCALE);
  merged.computeVertexNormals();

  cache.set(key, merged);
  return merged;
}

/** How many walk-cycle frames a sprite has. 1 for anything that stands still. */
export function frameCount(name: string): number {
  return Math.max(1, DEFS[name]?.frames ?? 1);
}

/** True if the sheet has art for this name. */
export function hasSprite(name: string): boolean {
  return DEFS[name] !== undefined;
}
