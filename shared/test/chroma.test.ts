import { describe, expect, it } from 'vitest';
import palette from '../data/palette.json';

/**
 * Colour is the loudest channel a top-down game has, and it belongs to
 * gameplay.
 *
 * In a frame where the player must pick out their car, the police, a pickup
 * and a pedestrian at a glance, saturation is how they do it — but only if the
 * world underneath is not competing. A saturated building or a vivid pavement
 * costs nothing to author and quietly spends the one channel that was carrying
 * information.
 *
 * The palette already honours this: the saturated entries are sirens, blood,
 * fire, shop signs, clothing, vehicles and the UI — every one of them a thing
 * that moves or a thing that warns. Nothing this asserts needed fixing. It is a
 * ratchet, not a repair: it exists so the next person to add a terrain colour
 * has to think about it.
 *
 * The threshold is HSV saturation, not HLS. HLS calls `#e9edf2` 0.93
 * saturated, which is nonsense for a near-white — it is the chroma that
 * matters, and HSV measures it.
 */

/** Every entry that paints a surface nobody can drive, shoot or pick up. */
const STATIC_SURFACES = [
  // Terrain
  'field',
  'park',
  'trees',
  'sand',
  'water',
  'gravel',
  'grassDark',
  'grassLight',
  'sandDark',
  // Carriageway
  'road',
  'roadDark',
  'roadLight',
  'roadPatch',
  'roadSeam',
  'roadLane',
  'roadCrossing',
  'roadMark',
  'roadStop',
  'manhole',
  'runway',
  'runwayLine',
  // Pavement and kerb
  'sidewalk',
  'kerb',
  'kerbShade',
  'slab',
  'slabLight',
  // Buildings
  'wallShade',
  'roofUnit',
  'roofVent',
  'roofHatch',
  'roofEdgeLight',
  'roofEdge',
  'bank',
  'bankEdge',
  'bankShade',
  'bankLight',
  'lot',
  'lotStripe',
  'shopFloor',
  'shopFloorAlt',
];

/**
 * The ceiling for anything static.
 *
 * Set just above where the palette already sits rather than at a round number,
 * so it catches a new entry that is clearly out of family without demanding a
 * re-author of one that is merely at the edge of it.
 */
const MAX_STATIC_CHROMA = 0.55;

function chroma(hex: string): number {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  return max === 0 ? 0 : (max - min) / max;
}

const PAL = palette as unknown as Record<string, unknown>;

describe('the world stays out of the way of the gameplay', () => {
  it('keeps every static surface under the chroma budget', () => {
    const loud: string[] = [];
    for (const key of STATIC_SURFACES) {
      const value = PAL[key];
      if (typeof value !== 'string') continue; // not every name is in every palette
      const s = chroma(value);
      if (s > MAX_STATIC_CHROMA) loud.push(`${key} ${value} S=${s.toFixed(2)}`);
    }
    expect(loud).toEqual([]);
  });

  it('keeps building and pavement families under it too', () => {
    const loud: string[] = [];
    const families: Array<[string, Record<string, string | string[]>]> = [
      ['buildingVariants', (PAL.buildingVariants ?? {}) as Record<string, string[]>],
      ['sidewalkTint', (PAL.sidewalkTint ?? {}) as Record<string, string>],
    ];
    for (const [name, family] of families) {
      for (const [district, value] of Object.entries(family)) {
        for (const hex of Array.isArray(value) ? value : [value]) {
          const s = chroma(hex);
          if (s > MAX_STATIC_CHROMA) {
            loud.push(`${name}.${district} ${hex} S=${s.toFixed(2)}`);
          }
        }
      }
    }
    expect(loud).toEqual([]);
  });

  it('still lets the things that matter shout', () => {
    // The other half of the contract. A budget that everything respects is a
    // budget nobody is spending, and these are what it is being saved for.
    for (const key of ['sirenRed', 'sirenBlue', 'taillight', 'fireGlow', 'blood', 'uiAccent']) {
      const value = PAL[key];
      expect(typeof value).toBe('string');
      expect(chroma(value as string)).toBeGreaterThan(MAX_STATIC_CHROMA);
    }
  });
});
