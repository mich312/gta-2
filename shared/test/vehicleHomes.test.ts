import { describe, expect, it } from 'vitest';
import vehiclesJson from '../data/vehicles.json';
import playerTuning from '../data/player.json';
import weaponsJson from '../data/weapons.json';
import trafficJson from '../data/traffic.json';
import worldgenJson from '../data/worldgen.json';
import { getTrafficTuning, getVehicleTuning, initTuning } from '../src/tuning.js';
import { parseWorldgenParams } from '../src/world/params.js';
import { generateCity } from '../src/world/generate.js';
import { isSolidTile } from '../src/world/collide.js';
import { TILE_SIZE, type CityMap } from '../src/world/types.js';

initTuning({
  player: playerTuning,
  vehicles: vehiclesJson,
  weapons: weaponsJson,
  traffic: trafficJson,
});

const params = parseWorldgenParams(worldgenJson);
const SEEDS = [1, 7, 42, 808, 2026];
const maps: CityMap[] = SEEDS.map((s) => generateCity(s, params));

/**
 * Kinds that turn up because of who is driving them rather than where they
 * are parked: the police dispatch their own, gangs mark their own, and a boat
 * lives at a mooring by a pass of its own.
 */
const DRIVEN_TO_YOU = new Set(['copcar', 'copbike', 'gangcar', 'boat']);

/** How common a kind is in ambient traffic, as a fraction of the whole mix. */
function mixShare(kind: string): number {
  const mix = getTrafficTuning().mix;
  const total = mix.reduce((a, m) => a + m.weight, 0);
  return total > 0 ? (mix.find((m) => m.kind === kind)?.weight ?? 0) / total : 0;
}

describe('every vehicle can be found somewhere (R3)', () => {
  it('...and that is a rule over the whole roster, not a spot check', () => {
    // The requirement, written down. A kind qualifies if it is COMMON in
    // traffic, or has a home you can drive to. What it may not be is a
    // weighted roll at one in a hundred on a spawn that despawns at 1100 px,
    // which is what a digger was: findable in the sense that a lottery ticket
    // is winnable.
    const kinds = Object.keys(getTrafficTuning() ? vehiclesJson : {}).filter(
      (k) => k !== 'fire' && !DRIVEN_TO_YOU.has(k),
    );
    expect(kinds.length).toBeGreaterThan(15);

    for (const map of maps) {
      const homed = new Set(map.vehicleHomes.map((h) => h.kind));
      const parked = new Set(map.parkingSpots.map((h) => h.kind));
      for (const kind of kinds) {
        const common = mixShare(kind) >= 0.05;
        const findable = common || homed.has(kind) || parked.has(kind);
        expect(findable, `${kind} (mix ${(mixShare(kind) * 100).toFixed(1)}%)`).toBe(true);
      }
    }
  });

  it('a home is somewhere a vehicle can actually stand', () => {
    // A home inside a wall is worse than no home: the car spawns, the sim
    // pushes it out, and the player is sent to an empty forecourt.
    for (const map of maps) {
      expect(map.vehicleHomes.length).toBeGreaterThan(4);
      for (const h of map.vehicleHomes) {
        const tx = Math.floor(h.x / TILE_SIZE);
        const ty = Math.floor(h.y / TILE_SIZE);
        expect(isSolidTile(map, tx, ty), `${h.kind} at ${tx},${ty}`).toBe(false);
      }
    }
  });

  it('homes are their own list, safe from the two things that eat parking', () => {
    // The session samples parking by a stride and keeps roughly one spot in
    // six; `markGangCars` rewrites the kind of every seventh. Both are fine
    // for scenery and fatal for a destination — which is why the tank needed
    // a special case in the session before this existed.
    for (const map of maps) {
      expect(map.vehicleHomes.some((h) => h.kind === 'tank')).toBe(true);
      expect(map.vehicleHomes.every((h) => h.kind !== 'gangcar')).toBe(true);
      expect(map.vehicleHomes.every((h) => (h.gangId ?? 0) === 0)).toBe(true);
    }
  });

  it('a landmark you can name tells you what is parked outside it', () => {
    // The half that makes the map legible rather than merely complete: an
    // ambulance at a hospital, not an ambulance at an arbitrary kerb.
    for (const map of maps) {
      for (const l of map.landmarks) {
        if (l.kind !== 'hospital') continue;
        const near = map.vehicleHomes.filter(
          (h) => h.kind === 'ambulance' && Math.hypot(h.x - l.doorX, h.y - l.doorY) < 8 * TILE_SIZE,
        );
        expect(near.length, 'ambulance at a hospital').toBeGreaterThan(0);
        break;
      }
    }
  });

  it('the same seed puts the same vehicles in the same places', () => {
    // Worldgen is a pure function of (seed, params) on both hosts; a home
    // placed with an rng draw would move the whole city under it.
    const a = generateCity(4242, params).vehicleHomes;
    const b = generateCity(4242, params).vehicleHomes;
    expect(a.map((h) => `${h.kind}@${h.x},${h.y}`)).toEqual(
      b.map((h) => `${h.kind}@${h.x},${h.y}`),
    );
  });

  it('a home never lands on top of another', () => {
    // Two vehicles on one spot interpenetrate and shuffle apart at walking
    // pace, which is the failure mode `motorise` already had to learn about.
    for (const map of maps) {
      for (let i = 0; i < map.vehicleHomes.length; i++) {
        for (let j = i + 1; j < map.vehicleHomes.length; j++) {
          const a = map.vehicleHomes[i]!;
          const b = map.vehicleHomes[j]!;
          const need = getVehicleTuning(a.kind).halfLength + getVehicleTuning(b.kind).halfLength;
          expect(Math.hypot(a.x - b.x, a.y - b.y), `${a.kind}/${b.kind}`).toBeGreaterThan(need);
        }
      }
    }
  });
});
