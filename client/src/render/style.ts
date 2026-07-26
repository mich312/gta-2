/**
 * Every visual tunable in one place. Rendering-only — nothing here may leak
 * into the simulation. Numbers are in internal-resolution pixels unless
 * stated otherwise.
 */

/** Rotation steps pre-baked per sprite. 48 ≈ 7.5° buckets — crisp yet smooth. */
export const ATLAS_ROTATION_STEPS = 48;

/** Ground chunk edge in tiles; 8×16px = 128px canvases. */
export const CHUNK_TILES = 8;
/** Baked ground chunks kept in the LRU before eviction. */
export const CHUNK_CACHE_MAX = 160;

/** One full day/night cycle, in server ticks (8 minutes at 30 Hz). */
export const DAY_TICKS = 30 * 60 * 8;
/** Peak darkness of the night ambient (0 = noon, 1 = pitch black). */
export const NIGHT_MAX_DARKNESS = 0.62;
/** Ambient darkness colour of the night lightmap. */
export const NIGHT_RGB = '8, 12, 34';

/** Perspective lean applied to building roofs, per storey. */
export const EXTRUDE_PARALLAX = 0.016;

/** Sun offset for cast shadows at full daylight. */
export const SUN_SHADOW_X = 3;
export const SUN_SHADOW_Y = 4;

/** Hard cap on live particles; the pool never allocates past this. */
export const PARTICLE_POOL_SIZE = 768;
/** Hard cap on live decals (skids, blood, scorch) in the ring buffer. */
export const DECAL_RING_SIZE = 640;

/** Camera smoothing half-life, in ms — position converges on the target. */
export const CAMERA_SMOOTH_HALF_LIFE_MS = 90;
/** How far ahead of the local velocity the camera leads, in seconds. */
export const CAMERA_LOOKAHEAD_S = 0.28;
/** Max look-ahead lead, px. */
export const CAMERA_LOOKAHEAD_MAX = 42;
/** Max screen-shake displacement, px. */
export const CAMERA_SHAKE_MAX = 5;

/** Minimap panel edge, px (square). */
export const MINIMAP_SIZE = 68;

/** Curated body colours for cars; picked per vehicle id, never per frame. */
export const CAR_COLORS = [
  '#b03a3a',
  '#3f6fb5',
  '#c9c9cf',
  '#3d3d44',
  '#c98d2f',
  '#4d8a56',
  '#7a4a8a',
  '#996a4a',
  '#d6ad25',
  '#2e6e6e',
  '#8a8f99',
  '#5b3a2e',
  '#a0455f',
  '#39495f',
] as const;

/** Remote player shirt colours (stable by player id). */
export const REMOTE_SHIRTS = [
  '#e05555',
  '#55b0e0',
  '#57c98a',
  '#d3a24a',
  '#b06ad6',
  '#5fd6c9',
  '#d66a9c',
] as const;

/** Cosmetic overrides (shop `cosmeticId` → shirt/pants). */
export const COSMETIC_OUTFITS: Record<number, { shirt: string; pants: string }> = {
  1: { shirt: '#c23b3b', pants: '#31465f' },
  2: { shirt: '#2fa8a0', pants: '#2b3540' },
  3: { shirt: '#26262e', pants: '#26262e' },
  4: { shirt: '#e8a01c', pants: '#3a4048' },
};

/** Pedestrian wardrobe (stable by ped id). */
export const PED_OUTFITS = [
  { shirt: '#6f7462', pants: '#4c4f44' },
  { shirt: '#8a6a56', pants: '#3f3a33' },
  { shirt: '#5b6b83', pants: '#33383f' },
  { shirt: '#7d5a71', pants: '#3a3340' },
  { shirt: '#647d5e', pants: '#41463b' },
  { shirt: '#9c9788', pants: '#54514a' },
  { shirt: '#a3574a', pants: '#3c3a42' },
  { shirt: '#4f7d78', pants: '#2f3a3d' },
  { shirt: '#b09a4e', pants: '#4a4438' },
  { shirt: '#7a8aa6', pants: '#3e4450' },
  { shirt: '#8f7f96', pants: '#443c4b' },
  { shirt: '#5d6d46', pants: '#3b4032' },
  { shirt: '#a88a72', pants: '#4d4237' },
  { shirt: '#607086', pants: '#2e3542' },
] as const;

/** Occasional pedestrian headwear (stable by ped id; '' = bare head). */
export const PED_HATS = ['#7a3f3f', '#3f5a7a', '#5c584a', '#2e2e34', '#8a7c52'] as const;

export type GfxQuality = 'high' | 'low';

/** `?gfx=low` disables lighting/particles/weather for weak machines. */
export function detectQuality(): GfxQuality {
  const q = new URLSearchParams(location.search).get('gfx');
  return q === 'low' ? 'low' : 'high';
}

/** `?tod=day|night|dusk` pins the clock — screenshots, debugging, taste. */
export function detectTimeOverride(): number | null {
  switch (new URLSearchParams(location.search).get('tod')) {
    case 'day':
      return 1;
    case 'night':
      return 0;
    case 'dusk':
      return 0.35;
    default:
      return null;
  }
}

/** Honour the OS-level reduced-motion preference for screen shake. */
export function prefersReducedMotion(): boolean {
  return (
    typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}
