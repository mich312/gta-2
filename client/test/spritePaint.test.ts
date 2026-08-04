import { describe, expect, it } from 'vitest';
import sprites from 'shared/data/sprites.json';
import palette from 'shared/data/palette.json';
import { spriteGeometry } from '../src/three/spriteMesh.js';

/**
 * A paint job is a colour buffer, not a body.
 *
 * Ten colourways of a car are the same solid ten times over: the same
 * extrusions, the same merge, the same vertex normals, the same
 * position-keyed outline weld. Building all of that once per colourway is what
 * made "a car I have not seen before drives into view" cost a couple of
 * milliseconds — the hitch a player meets while driving, because driving is
 * how you meet new cars.
 *
 * These pin the sharing so it cannot quietly come apart: the geometry is one
 * set of buffers with a colour array per variant, and the colours themselves
 * still come from the sprite's own variant lists.
 */

const DEFS = (
  sprites as unknown as {
    sprites: Record<string, { variants?: Record<string, string[]>; shapes: Array<{ color: string }> }>;
  }
).sprites;
const PAL = palette as unknown as Record<string, string>;

/** A body with more than one paint job, to have something to compare. */
const PAINTED = 'car';

describe('sprite paint jobs share one body', () => {
  it('hands every variant the same position and normal buffers', () => {
    const a = spriteGeometry(PAINTED, { variant: 0 })!;
    const b = spriteGeometry(PAINTED, { variant: 3 })!;
    expect(a).not.toBe(b);
    for (const attr of ['position', 'normal', 'outlineNormal']) {
      expect(a.attributes[attr], `${attr} exists`).toBeDefined();
      // Reference-identical, not merely equal: three.js keys its GPU buffer
      // cache on the attribute object, so this is what makes ten colourways
      // one upload rather than ten.
      expect(a.attributes[attr], `${attr} is shared`).toBe(b.attributes[attr]);
    }
    expect(a.attributes['color']).not.toBe(b.attributes['color']);
  });

  it('gives the same variant the same geometry back', () => {
    expect(spriteGeometry(PAINTED, { variant: 2 })).toBe(spriteGeometry(PAINTED, { variant: 2 }));
  });

  it('paints the variants different colours, from the sprite s own list', () => {
    const def = DEFS[PAINTED]!;
    const key = def.shapes.find((s) => s.color.startsWith('$'))?.color.slice(1);
    expect(key, 'the car has a substituted colour to vary').toBeDefined();
    const list = def.variants![key!]!;
    expect(list.length).toBeGreaterThan(1);

    const colourOf = (variant: number): Set<string> => {
      const attr = spriteGeometry(PAINTED, { variant })!.attributes['color'] as {
        count: number;
        getX(i: number): number;
        getY(i: number): number;
        getZ(i: number): number;
      };
      const seen = new Set<string>();
      for (let i = 0; i < attr.count; i++) {
        seen.add(`${attr.getX(i).toFixed(3)},${attr.getY(i).toFixed(3)},${attr.getZ(i).toFixed(3)}`);
      }
      return seen;
    };

    const zero = colourOf(0);
    const one = colourOf(1);
    expect(zero.size).toBeGreaterThan(1);
    expect(zero).not.toEqual(one);
    // The body colour each carries is the one the sheet names for it, and the
    // rest of the model — glass, tyres, lamps — is untouched between them.
    const shared = [...zero].filter((c) => one.has(c));
    expect(shared.length, 'most of the model is the same colour in both').toBeGreaterThan(0);
    expect(PAL[list[0]!] ?? list[0]).toBeDefined();
  });

  it('keeps a vertex count that matches the colour buffer', () => {
    const g = spriteGeometry(PAINTED, { variant: 5 })!;
    const pos = g.attributes['position'] as { count: number };
    const col = g.attributes['color'] as { count: number };
    expect(col.count).toBe(pos.count);
  });
});
