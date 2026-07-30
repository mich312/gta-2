import { describe, expect, it } from 'vitest';
import sprites from 'shared/data/sprites.json';
import { frameCount, spriteGeometry } from '../src/three/spriteMesh.js';

/**
 * The walk cycle, extruded.
 *
 * `sprites.json` has always carried `frames: 4` and an `anim` block — per-shape
 * offsets that swing a leg forward and back — and the sprite generator has
 * always rasterised the sheet from it. The 3D reader took `def.shapes` and
 * nothing else, so it could only ever build frame 0: every pedestrian, officer
 * and player in the 3D city slid along frozen mid-stride, which is what "the
 * people do not move" turned out to be. The simulation was moving them
 * correctly the whole time.
 */

const DEFS = (sprites as unknown as { sprites: Record<string, { frames?: number; anim?: unknown }> })
  .sprites;

/** The x of every vertex, rounded — enough to see a shape shift. */
function xs(name: string, frame: number): number[] {
  const g = spriteGeometry(name, { frame });
  expect(g, `${name} has art`).not.toBeNull();
  const attr = g!.attributes['position'] as { count: number; getX(i: number): number };
  const out: number[] = [];
  for (let i = 0; i < attr.count; i++) out.push(Math.round(attr.getX(i) * 1000));
  return out.sort((a, b) => a - b);
}

describe('walk frames in 3D', () => {
  it('knows how many frames a body has', () => {
    expect(frameCount('ped')).toBe(DEFS['ped']!.frames);
    expect(frameCount('ped')).toBeGreaterThan(1);
    // Something that never takes a step gets exactly one.
    expect(frameCount('car')).toBe(1);
    expect(frameCount('nothing-of-the-sort')).toBe(1);
  });

  it('moves the legs between frames', () => {
    for (const name of ['ped', 'cop', 'player']) {
      expect(DEFS[name]?.anim, `${name} has a walk cycle to read`).toBeDefined();
      const a = xs(name, 0);
      const b = xs(name, 1);
      expect(a.length, `${name} keeps the same shapes`).toBe(b.length);
      expect(a, `${name} frame 1 is a different pose from frame 0`).not.toEqual(b);
    }
  });

  it('wraps a frame past the end rather than losing the body', () => {
    const n = frameCount('ped');
    expect(xs('ped', n)).toEqual(xs('ped', 0));
    expect(xs('ped', n + 1)).toEqual(xs('ped', 1));
  });

  it('leaves a body with no walk cycle alone', () => {
    // Asking a car for frame 3 gets a car, not nothing.
    expect(xs('car', 3)).toEqual(xs('car', 0));
  });
});
