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
 * How much of a light's OWN colour still reaches the far side of a wall.
 *
 * Small, because most of what fills a shadow is not the lamp. Real streets
 * have no true black in them, but the light in a shadow has not come from the
 * sodium lamp round the corner — it has come off the sky, and it is blue. What
 * used to sit here was a sixth of the lamp left standing, which made every
 * shadow a dimmer copy of the light casting it: the one thing that most
 * reliably reads as computer graphics rather than as night.
 */
export const SHADOW_BOUNCE = 0.06;

/**
 * How much cool sky fills the shadow instead.
 *
 * Composited underneath the light with `destination-over`, so it lands where
 * the shadow took the light away and nowhere else — the lit side of the street
 * stays the colour of the lamp. It is also what keeps an alley fightable,
 * which the bounce above no longer does on its own.
 */
export const SKY_BOUNCE = 0.3;

/**
 * The radius of a lamp's luminous face, in world pixels, per kind — how big a
 * penumbra it throws. A bare bulb in a headlight is nearly a point; a shop
 * window is a metre of glass and its shadows have almost no edge at all.
 */
export const SOURCE_RADIUS: Record<string, number> = {
  lamp: 2.6,
  head: 1.2,
  red: 1.8,
  blue: 1.8,
  muzzle: 1,
  shop: 4.5,
  window: 3.5,
  fire: 3,
};

/**
 * How high each kind of light hangs, in world pixels, against occluders that
 * are 7 (a car) to 9 (a person) tall.
 *
 * This is the whole of why a headlight looks like a headlight: it sits at 4,
 * below the roof of the thing in front of it, so what it throws is a shadow
 * with no end. A street lamp at 30 throws a stub of one.
 */
export const LIGHT_HEIGHT: Record<string, number> = {
  lamp: 30,
  head: 4,
  red: 12,
  blue: 12,
  muzzle: 8,
  shop: 18,
  window: 14,
  fire: 7,
};

/**
 * How many points across a lamp's own face a shadow is cast from.
 *
 * Nothing in a city is a point source, and a point source is the only thing
 * that casts a hard edge. Sampling the face gives a penumbra that widens with
 * distance from the occluder — sharp where a bollard meets the ground, soft
 * where the same bollard's shadow ends — which a uniform blur cannot do at any
 * radius, and it is cheaper than one: five polygon fills against a full-sprite
 * canvas filter.
 *
 * Baked lights can afford more samples than lights recomputed every frame.
 */
export const SHADOW_SAMPLES_STATIC = 6;
export const SHADOW_SAMPLES_DYNAMIC = 3;

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

/**
 * World pixels a building's roof is displaced per storey, at the screen edge
 * (SHIP.md U2). The lean is scaled by how far the building sits from the
 * camera centre, so this is the maximum, not a constant offset.
 *
 * `WALL_DEPTH` above is the flat, cached, sun-direction sweep this replaces.
 * That one is 5 px for every building regardless of height; this one is per
 * storey, which is the whole difference between "things are solid" and
 * "things are tall".
 */
export const PARALLAX_PX_PER_STOREY = 3.0;

/**
 * Baked building roofs kept resident for the parallax pass. A screenful is a
 * few dozen; this holds several screenfuls either side of the camera so
 * driving back down a street you just left does not re-bake it.
 */
export const ROOF_CACHE_LIMIT = 400;
