import { describe, expect, it } from 'vitest';
import sheetMeta from '../public/sprites.meta.json';
import spriteDefs from 'shared/data/sprites.json';
import { deadPose, PED_VARIANTS, PLAYER_VARIANTS } from '../src/render/renderer.js';

/**
 * The BUILT sheet, not the definitions.
 *
 * `sprites.json` describes sprites; `sprites.meta.json` is what the client
 * actually fetches, with every variant and frame expanded into a concrete
 * name. Asking the definitions would pass while the sheet was stale, and a
 * stale sheet is exactly the failure this is here to catch — a missing sprite
 * does not throw, it falls back to a coloured rectangle, so it survives a
 * screenshot and has to be reported by somebody playing.
 */
const frames = (sheetMeta as { frames: Record<string, unknown> }).frames;

function expectFrames(base: string, variants: number): void {
  for (let v = 0; v < variants; v++) {
    const name = `${base}_v${v}`;
    expect(frames[name], name).toBeDefined();
  }
}

/** Every suffix `deadPose` can produce, over a wide spread of ids. */
const POSES = [...new Set(Array.from({ length: 500 }, (_, i) => deadPose(i * 7919 + i)))];

describe('bodies on the ground', () => {
  it('every pose a pedestrian can be found in is in the sheet', () => {
    expectFrames('pedDowned', PED_VARIANTS);
    for (const pose of POSES) expectFrames(`pedDead${pose}`, PED_VARIANTS);
  });

  it('...and every pose a player can', () => {
    for (const pose of POSES) expectFrames(`playerDead${pose}`, PLAYER_VARIANTS);
  });

  it('an officer has a body of their own', () => {
    expect(frames['copDead']).toBeDefined();
  });

  it('a body lies down, rather than being a standing sprite squashed', () => {
    // What this replaced scaled the standing frame 1.5x along the fall axis.
    // The tell that it is a real drawing now: the prone definitions are their
    // own shapes, and they are not the standing ones.
    const defs = (spriteDefs as { sprites: Record<string, { shapes: unknown[] }> }).sprites;
    const standing = JSON.stringify(defs['ped']?.shapes);
    for (const name of ['pedDeadA', 'pedDeadB', 'pedDowned']) {
      expect(defs[name], name).toBeDefined();
      expect(JSON.stringify(defs[name]?.shapes), name).not.toBe(standing);
    }
  });

  it('the pose is stable per entity, and both drawings get used', () => {
    // Stable, or a corpse flickers between poses every frame; and spread, or
    // the second drawing was wasted effort.
    expect(deadPose(41)).toBe(deadPose(41));
    expect(POSES.length).toBeGreaterThan(1);
  });

  it('a casualty is a different drawing from a corpse', () => {
    // The whole point of the downed pose. Somebody on the bleed-out clock has
    // an ambulance coming and is worth something to whoever reaches them; a
    // body is not. That difference used to be carried by an alpha value,
    // which is to say by nothing you would notice from across a street.
    const defs = (spriteDefs as { sprites: Record<string, { shapes: unknown[] }> }).sprites;
    expect(JSON.stringify(defs['pedDowned']?.shapes)).not.toBe(
      JSON.stringify(defs['pedDeadA']?.shapes),
    );
  });
});
