import { describe, expect, it } from 'vitest';
import spriteSheet from 'shared/data/sprites.json';
import vehiclesJson from 'shared/data/vehicles.json';
import weaponsJson from 'shared/data/weapons.json';
import playerJson from 'shared/data/player.json';
import { getTuning, initTuning } from 'shared';
import { vehicleSpriteName } from '../src/render/renderer.js';

const sprites = (spriteSheet as { sprites: Record<string, unknown> }).sprites;
// Asked of the PARSER, not of the raw file: vehicles.json carries settings
// blocks as well as kinds (`fire`), and a test that enumerated the file's
// keys started demanding a sprite for one. The parser's view cannot drift
// from the sim's, which is the whole point of taking it from here.
initTuning({ player: playerJson, vehicles: vehiclesJson, weapons: weaponsJson });
const kinds = Object.keys(getTuning().vehicles);

describe('vehicle sprites', () => {
  it('every vehicle kind has a sprite of its own', () => {
    // The bug this pins: a boat drawn as a car. It only affected the person
    // driving it — everybody else saw the right sprite — so it survived a
    // screenshot and had to be reported by somebody playing.
    for (const kind of kinds) {
      const name = vehicleSpriteName(kind, 1, 1);
      // Two families come in colours now — the civilian car and the gang car
      // — so strip any variant suffix rather than special-casing one prefix.
      const base = name.replace(/_v\d+$/, '');
      expect(sprites[base], `${kind} -> ${name}`).toBeDefined();
    }
  });

  it('anything with a turret has a turret sprite, and vice versa', () => {
    // The two halves of a turret live in different files — the offset in
    // vehicles.json says the renderer will ask for `<kind>_turret`, and
    // sprites.json is what has to answer. Either one alone is a tank with an
    // invisible gun, or a barrel drawn on the wrong pivot.
    const turreted = kinds.filter((k) => getTuning().vehicles[k]?.turretOffset !== null);
    expect(turreted.length).toBeGreaterThan(0);
    for (const kind of turreted) expect(sprites[`${kind}_turret`], kind).toBeDefined();
    for (const name of Object.keys(sprites)) {
      if (!name.endsWith('_turret')) continue;
      const kind = name.slice(0, -'_turret'.length);
      expect(getTuning().vehicles[kind]?.turretOffset, name).not.toBe(null);
    }
  });

  it('a boat is drawn as a boat, whoever is driving it', () => {
    expect(vehicleSpriteName('boat', 7)).toBe('boat');
    expect(vehicleSpriteName('bus', 7)).toBe('bus');
    expect(vehicleSpriteName('copcar', 7)).toBe('copcar');
    expect(vehicleSpriteName('ambulance', 7)).toBe('ambulance');
  });

  it('a gang car wears its gang colours, not a colour off the rank', () => {
    // The point of a gang owning cars: you can tell whose street you are on
    // by what is parked on it. Two cars of the same gang must match however
    // their ids differ, and two gangs must not.
    expect(vehicleSpriteName('gangcar', 3, 2)).toBe(vehicleSpriteName('gangcar', 77, 2));
    expect(vehicleSpriteName('gangcar', 3, 1)).not.toBe(vehicleSpriteName('gangcar', 3, 2));
    // ...and an out-of-range gang still resolves to a sprite that exists.
    for (const gang of [0, 1, 2, 3, 4, 9]) {
      const name = vehicleSpriteName('gangcar', 5, gang);
      expect(sprites[name.replace(/_v\d+$/, '')], name).toBeDefined();
      expect(Number(name.slice(-1))).toBeLessThan(4);
    }
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
