/**
 * Device pixels per world pixel.
 *
 * Everything is drawn into a backing store twice the size of the world view,
 * so a 12 world-pixel character is a 24 pixel sprite. That is where the detail
 * budget comes from, and it costs nothing in visibility.
 *
 * It also buys smoothness: the camera can sit on a half-world-pixel grid
 * instead of jumping a whole world pixel (which the window scale then
 * multiplies into a very visible 2–4 CSS-pixel jolt) every frame.
 *
 * How much world is on screen is no longer fixed here — see `viewport.ts`,
 * which sizes the frame to the window.
 */
export const RENDER_SCALE = 2;

/** Tile-cache chunk size, in tiles. Small enough that a rebuild is cheap. */
export const CHUNK_TILES = 8;
/**
 * How many chunk canvases stay resident before the oldest are dropped.
 *
 * The frame is no longer a fixed size, so this is sized for the widest one
 * the viewport will hand out: 640×380 world pixels is 6×4 chunks on screen and
 * 8×6 once the prefetch ring is counted. Headroom on top of that, rather than
 * thrashing at the boundary. At 256×256 device pixels each, the ceiling is
 * roughly 31 MB.
 */
export const CHUNK_CACHE_LIMIT = 120;
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
 *
 * Night is a shade darker than it was, but only a shade: the lights now cast,
 * so the same grade with the same lamps leaves considerably less of the street
 * lit than it used to, and taking the ambient down to match would have made
 * the shadows unplayable rather than atmospheric.
 */
export const GRADE_DAY = { r: 252, g: 246, b: 232, tint: 0.02, vignette: 0.18 };
export const GRADE_NIGHT = { r: 144, g: 156, b: 196, tint: 0.17, vignette: 0.44 };

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

// ---------------------------------------------------------------------------
// Lighting
// ---------------------------------------------------------------------------

/**
 * How much of a light still reaches the far side of a wall.
 *
 * Never zero. Real streets have no true black in them — light bounces off the
 * facing wall, off the road, off the sky — and a shadow punched to nothing
 * reads as a hole cut in the frame rather than as a shadow. It is also the
 * difference between an alley you can fight in and one you cannot see in.
 */
export const SHADOW_BOUNCE = 0.17;

/**
 * Blur, in device pixels, applied to the shadow edges of lights whose geometry
 * is baked once.
 *
 * A point source casts a knife-edged shadow and nothing in a city is a point
 * source. Only the cached lights pay for it — the blur is the single most
 * expensive thing in the pass — which works out because the static lights
 * (lamps, shop windows, signals) are also the ones you look at long enough to
 * notice the edge on.
 */
export const SHADOW_SOFT_PX = 3;

/**
 * Lights allowed to cast a freshly-computed shadow per frame.
 *
 * Static lights are cached and effectively free, so this bounds the moving
 * ones — headlights, sirens, fires, muzzle flashes. They are sorted by how
 * much of the screen they cover, so the beam of the car you are driving always
 * wins and the twelfth siren three blocks away is the one that goes flat.
 */
export const MAX_SHADOW_LIGHTS = 10;

/**
 * Static lights baked per frame.
 *
 * Small, and separate from the budget above, because a bake is the one thing
 * in the pass that costs real time — the soft-shadow blur is a slow path in
 * every browser rasteriser measured, and driving down a lit street brings a
 * whole row of new lamps into view at once. Two a frame keeps that under
 * control and is still four times faster than a car passes lamp posts; the
 * few that miss out are drawn flat for a frame or two at the edge of the
 * screen, which is not somewhere anyone is looking at shadow edges.
 */
export const MAX_LIGHT_BAKES = 2;

/** Baked light sprites kept resident. At ~64 KB each this is a few MB. */
export const LIGHT_CACHE_LIMIT = 96;

/**
 * Bloom: the light buffer, downscaled by this and added back over the frame.
 *
 * The downscale *is* the blur — the browser's bilinear filter does it for
 * free on the way back up — so the whole effect costs two small blits and one
 * full-screen composite. It is what makes a lamp read as a bright thing seen
 * through air rather than as a decal of a lamp.
 */
export const BLOOM_DOWNSCALE = 6;
export const BLOOM_ALPHA = 0.36;
