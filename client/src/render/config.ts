import { INTERNAL_HEIGHT, INTERNAL_WIDTH } from 'shared';

/**
 * Device pixels per world pixel.
 *
 * The world view stays exactly as wide as it always was — `INTERNAL_WIDTH` ×
 * `INTERNAL_HEIGHT` world pixels — but everything is drawn into a backing store
 * twice that size, so a 12 world-pixel character is a 24 pixel sprite. That is
 * where the detail budget comes from, and it costs nothing in visibility.
 *
 * It also buys smoothness: the camera can sit on a half-world-pixel grid
 * instead of jumping a whole world pixel (which the window scale then
 * multiplies into a very visible 2–4 CSS-pixel jolt) every frame.
 */
export const RENDER_SCALE = 2;

/** World-space size of the viewport, in world pixels. */
export const VIEW_W = INTERNAL_WIDTH;
export const VIEW_H = INTERNAL_HEIGHT;

/** Backing-store size, in device pixels. */
export const DEVICE_W = VIEW_W * RENDER_SCALE;
export const DEVICE_H = VIEW_H * RENDER_SCALE;

/** Tile-cache chunk size, in tiles. Small enough that a rebuild is cheap. */
export const CHUNK_TILES = 8;
/**
 * How many chunk canvases stay resident before the oldest are dropped. The
 * viewport needs about 20; the prefetch ring around it takes that to ~42, so
 * this leaves comfortable headroom rather than thrashing at the boundary.
 * At 256×256 device pixels each, the ceiling is roughly 21 MB.
 */
export const CHUNK_CACHE_LIMIT = 80;
/** Chunk builds allowed per frame; the rest wait so a fast car cannot stall. */
export const CHUNK_BUILDS_PER_FRAME = 3;

/**
 * Direction the sun throws building walls and drop shadows, in world pixels.
 * Consistent across sprites (which bake their own shading from the same
 * direction) and the tile layer, so the scene reads as one lit space.
 */
export const SUN_X = 0.55;
export const SUN_Y = 0.83;
/** How far a building wall is extruded towards the sun-away direction. */
export const WALL_DEPTH = 5;
/** How far past the wall the building's shadow falls. */
export const SHADOW_DEPTH = 7;

/**
 * The grade multiplied over the finished scene, before the light pass, at
 * midday and at midnight.
 *
 * Kept light at both ends on purpose: the grade exists to give the lamps and
 * headlights somewhere to land, not to hide the art the tile layer just spent
 * its budget drawing. Night is darker and much cooler; day is close to
 * neutral with a warm cast.
 *
 * Interpolated smoothly by `nightAmount` rather than switched between four
 * discrete phases — a step between keyframes reads as a seam across the whole
 * screen, and dawn and dusk are the interesting part.
 */
export const GRADE_DAY = { r: 252, g: 246, b: 232, tint: 0.02, vignette: 0.18 };
export const GRADE_NIGHT = { r: 150, g: 162, b: 200, tint: 0.16, vignette: 0.42 };

/**
 * The old fixed dusk, kept as the value the grade collapses to when the clock
 * is unavailable — an evidence page, a test harness, anything that renders a
 * frame without a tick.
 */
export const AMBIENT = 'rgba(206, 212, 232, 1)';
/** Cool tint applied on top, as a translucent overlay. */
export const AMBIENT_TINT = 'rgba(24, 34, 58, 0.07)';
/** Vignette strength at the corners, 0..1. */
export const VIGNETTE = 0.3;
