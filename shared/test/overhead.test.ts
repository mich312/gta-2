import { describe, expect, it } from 'vitest';
import playerTuning from '../data/player.json';
import vehiclesJson from '../data/vehicles.json';
import weaponsJson from '../data/weapons.json';
import pedsJson from '../data/peds.json';
import propsJson from '../data/props.json';
import trafficJson from '../data/traffic.json';
import worldgenJson from '../data/worldgen.json';
import { getTuning, getVehicleTuning, initTuning } from '../src/tuning.js';
import { parseWorldgenParams } from '../src/world/params.js';
import { generateCity } from '../src/world/generate.js';
import {
  createGameState,
  createPed,
  createPlayer,
  createProp,
  createVehicle,
  type GameState,
  type VehicleState,
} from '../src/sim/state.js';
import { insertEntity } from '../src/sim/entities.js';
import { stepVehicleImpacts } from '../src/sim/weapons.js';
import { stepPeds } from '../src/sim/peds.js';
import { blast } from '../src/sim/vehicleDamage.js';
import type { SimEvent } from '../src/sim/events.js';
import { openSquare } from './helpers.js';
import type { CityMap } from '../src/world/types.js';

initTuning({
  player: playerTuning,
  vehicles: vehiclesJson,
  weapons: weaponsJson,
  peds: pedsJson,
  props: propsJson,
  traffic: trafficJson,
});

const map: CityMap = generateCity(21, parseWorldgenParams(worldgenJson));
const spot = openSquare(map, 14);

/**
 * What is overhead is not in the road.
 *
 * Every one of these was live: a helicopter at cruise height had a body on the
 * ground plane, so it mowed down the crowd it flew over, scattered the
 * pavement, smashed the bollards, set off the barrels — and was then destroyed
 * by the barrels it had set off, from eight storeys up. "Planes can run over
 * pedestrians. And why does it suddenly explode?" is one bug with several
 * faces, and the faces are here so they cannot come back one at a time.
 */
function chopperOver(z: number): { state: GameState; heli: VehicleState } {
  const state = createGameState(5);
  const heli = createVehicle(1, 'chopper', { x: spot.x, y: spot.y }, 0);
  heli.z = z;
  heli.climb = z > 0;
  heli.speed = 180; // well over RUNOVER_MIN_SPEED
  heli.driverId = 1;
  insertEntity(state.vehicles, heli);
  return { state, heli };
}

describe('an aircraft in the air is over the city, not in it', () => {
  it('does not run over the crowd it flies above', () => {
    const cruise = getVehicleTuning('chopper').cruiseZ;
    for (const [z, expectHurt] of [
      [cruise, false],
      [0, true],
    ] as Array<[number, boolean]>) {
      const { state } = chopperOver(z);
      // Directly under the hull, which is the only place this could ever fire.
      const ped = createPed(2, { x: spot.x, y: spot.y }, getTuning().peds.health, 0);
      insertEntity(state.peds, ped);
      const events: SimEvent[] = [];
      stepVehicleImpacts(state, events);
      const hit = events.some((e) => e.type === 'runOver');
      expect(hit, `z=${z}`).toBe(expectHurt);
      expect(state.peds.byId[2]!.health < getTuning().peds.health, `z=${z}`).toBe(expectHurt);
    }
  });

  it('does not run over people on foot either', () => {
    const { state } = chopperOver(getVehicleTuning('chopper').cruiseZ);
    const walker = createPlayer(9, 'walker', { x: spot.x, y: spot.y });
    insertEntity(state.players, walker);
    stepVehicleImpacts(state, []);
    expect(state.players.byId[9]!.health).toBe(100);
  });

  it('does not smash the street furniture underneath it', () => {
    // The half that made it explode: a barrel is street furniture with a
    // blast, so an aircraft that could break props could detonate one.
    const { state } = chopperOver(getVehicleTuning('chopper').cruiseZ);
    insertEntity(state.props, createProp(3, 'barrel', { x: spot.x, y: spot.y }, 0, 8));
    stepVehicleImpacts(state, []);
    expect(state.props.byId[3]!.intact).toBe(true);
  });

  it('takes a graze, not a hit, from an explosion in the road below it', () => {
    // The other half of the mystery detonation. A blast used to be an
    // infinitely tall column: a barrel's 52 px reached a helicopter cruising
    // at 48 at FULL strength, and a couple of them took one out of the sky.
    // The falloff is spherical now, so the same barrel is a scratch at the
    // very edge of its reach rather than a direct hit.
    const { state, heli } = chopperOver(getVehicleTuning('chopper').cruiseZ);
    const full = heli.health;
    blast(state, spot.x, spot.y, 52, 60, -1, []);
    const aloftLost = full - state.vehicles.byId[1]!.health;

    // The same blast under the same helicopter on the ground takes the lot —
    // so this measures the vertical axis rather than a disabled explosion.
    const grounded = chopperOver(0);
    blast(grounded.state, spot.x, spot.y, 52, 60, -1, []);
    const groundLost = full - grounded.state.vehicles.byId[1]!.health;

    expect(groundLost).toBe(60);
    expect(aloftLost).toBeLessThan(groundLost * 0.15);
  });

  it('does not part the crowd it passes over', () => {
    // The scatter rule means "something is about to drive into me". Measured
    // against the shadow, a helicopter crossing the city emptied every
    // pavement under its path — the whole population running from a dot.
    const cruise = getVehicleTuning('chopper').cruiseZ;
    for (const [z, expectScared] of [
      [cruise, false],
      [0, true],
    ] as Array<[number, boolean]>) {
      const { state } = chopperOver(z);
      // Beside it, not under it: inside the scare radius, clear of the body.
      const ped = createPed(2, { x: spot.x + 30, y: spot.y }, getTuning().peds.health, 0);
      ped.mode = 'walk';
      insertEntity(state.peds, ped);
      stepPeds(state, map, []);
      expect(state.peds.byId[2]!.mode === 'flee', `z=${z}`).toBe(expectScared);
    }
  });
});
