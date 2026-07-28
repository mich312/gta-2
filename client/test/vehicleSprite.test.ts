import { describe, expect, it } from 'vitest';
import spriteSheet from 'shared/data/sprites.json';
import vehiclesJson from 'shared/data/vehicles.json';
import { vehicleSpriteName } from '../src/render/renderer.js';

const sprites = (spriteSheet as { sprites: Record<string, unknown> }).sprites;
const kinds = Object.keys(vehiclesJson as Record<string, unknown>);

describe('vehicle sprites', () => {
  it('every vehicle kind has a sprite of its own', () => {
    // The bug this pins: a boat drawn as a car. It only affected the person
    // driving it — everybody else saw the right sprite — so it survived a
    // screenshot and had to be reported by somebody playing.
    for (const kind of kinds) {
      const name = vehicleSpriteName(kind, 1);
      const base = name.startsWith('car_v') ? 'car' : name;
      expect(sprites[base], `${kind} -> ${name}`).toBeDefined();
    }
  });

  it('a boat is drawn as a boat, whoever is driving it', () => {
    expect(vehicleSpriteName('boat', 7)).toBe('boat');
    expect(vehicleSpriteName('bus', 7)).toBe('bus');
    expect(vehicleSpriteName('copcar', 7)).toBe('copcar');
    expect(vehicleSpriteName('ambulance', 7)).toBe('ambulance');
  });

  it('only the generic car varies by id, and stays inside the variant set', () => {
    const seen = new Set<string>();
    for (let id = 0; id < 60; id++) seen.add(vehicleSpriteName('car', id));
    expect(seen.size).toBeGreaterThan(1);
    for (const name of seen) expect(name).toMatch(/^car_v[0-9]$/);
    // Everything else is the same sprite whatever its id.
    expect(new Set([1, 2, 3, 99].map((id) => vehicleSpriteName('taxi', id))).size).toBe(1);
  });
});
