import { nextIntRange } from '../rng/prng.js';
import { q256 } from '../math/vec.js';
import type { GameState } from './state.js';
import {
  addHeat,
  cloneState,
  createPickup,
  createPlayer,
  createProp,
  createVehicle,
} from './state.js';
import { insertEntity, removeEntity, getEntity } from './entities.js';
import type { InputIntent } from './input.js';
import type { SimCommand } from './commands.js';
import { stepPlayerMovement } from './player.js';
import { stepVehicleCoasting, stepVehicleDriving, tryEnterVehicle, tryExitVehicle } from './vehicle.js';
import { stepProps, stepVehicleImpacts, stepWeapons } from './weapons.js';
import { stepVehicleDamage } from './vehicleDamage.js';
import { stepPolice } from './police.js';
import { stepPeds } from './peds.js';
import {
  stepBoarding,
  stepTraffic,
  stepTrafficPanic,
  stepTrafficPopulation,
  tryCarjack,
} from './traffic.js';
import { stepPickups } from './pickups.js';
import { stepProjectiles } from './projectiles.js';
import { stepFittings } from './fittings.js';
import { stepRespectDecay } from './respect.js';
import { creditFrenzyKill, stepFrenzy, stepStunts } from './frenzy.js';
import { createPed } from './state.js';
import { getTuning } from '../tuning.js';
import type { SimEvent } from './events.js';
import type { CityMap } from '../world/types.js';
import { boxInSolid } from '../world/collide.js';
import { gangAt } from '../world/turf.js';
import { PLAYER_RADIUS } from '../constants.js';

/**
 * Advance the simulation by exactly one fixed tick.
 * Pure with respect to its arguments: the input state is never mutated.
 * Same state + same inputs + same commands + same map => bit-identical
 * result, on any engine. This is the whole contract of the netcode.
 *
 * Fixed sub-order (all iteration in sorted-id order):
 *   commands → action edges (enter/exit) → player/vehicle movement →
 *   driverless vehicles coast → weapons → projectiles → vehicle impacts →
 *   police → peds → driver panic → vehicle damage/explosions → prop repair →
 *   pickups → stunts → frenzy.
 */
export function step(
  state: GameState,
  inputs: Record<number, InputIntent | undefined>,
  commands: readonly SimCommand[],
  map: CityMap,
  outEvents?: SimEvent[],
): GameState {
  const events: SimEvent[] = outEvents ?? [];
  const next = cloneState(state);
  next.tick = state.tick + 1;
  for (const cmd of commands) {
    applyCommand(next, cmd, map);
  }

  // Action edges. Contested car entry resolves by player id — deterministic.
  for (const id of next.players.ids) {
    const p = next.players.byId[id];
    if (!p) continue;
    const input = inputs[id];
    if (!input) continue;
    const pressed = input.action && !p.actionHeld;
    p.actionHeld = input.action;
    if (!pressed || p.mode === 'dead') continue;
    if (p.mode === 'foot') {
      // Jacking an occupied car takes precedence over opening an empty one,
      // and unlike lifting a parked car it is always a crime.
      const jacked = tryCarjack(next, map, p.id);
      if (jacked) addHeat(p, getTuning().traffic.jackHeat);
      else tryEnterVehicle(next, p, map);
    } else if (p.mode === 'driving') tryExitVehicle(next, p, map);
  }

  // Movement.
  for (const id of next.players.ids) {
    const p = next.players.byId[id];
    if (!p) continue;
    const input = inputs[id];
    if (p.mode === 'driving' && p.vehicleId !== null) {
      const v = next.vehicles.byId[p.vehicleId];
      if (v) {
        stepVehicleDriving(v, input, map, next, next, events, p.z > 0);
        p.pos.x = v.pos.x;
        p.pos.y = v.pos.y;
        if (input) {
          p.lastInputSeq = input.seq;
          p.aimAngle = q256(input.aimAngle); // same invariant as on foot
        }
      }
    } else {
      stepPlayerMovement(p, input, map);
    }
  }

  // Ambient traffic drives itself, then genuinely driverless vehicles coast.
  stepTraffic(next, map, events);
  for (const id of next.vehicles.ids) {
    const v = next.vehicles.byId[id];
    if (!v || v.driverId !== null) continue;
    stepVehicleCoasting(v, map, next, next, events);
  }
  stepBoarding(next, map);
  stepTrafficPopulation(next, map);

  stepWeapons(next, inputs, map, events);
  // Bolted-on weapons fire and drop before the projectile pass, so anything
  // laid this tick is stepped on the NEXT one: a mine cannot go off under
  // the car that dropped it.
  stepFittings(next, inputs, map, events);
  // Spawned by firing, resolved before the things they hit have moved.
  stepProjectiles(next, map, events);
  stepVehicleImpacts(next, events);
  stepVehicleDamage(next, events);
  stepPolice(next, map, events);
  stepPeds(next, map, events);
  // Drivers hear the same shots the crowd does. After every system that can
  // fire a gun or blow something up, so the whole tick's noise is in one
  // place; the flight response itself runs when traffic next steps.
  stepTrafficPanic(next, map, events);
  stepProps(next, events);
  stepPickups(next, events);
  stepRespectDecay(next);
  stepStunts(next, map, events);
  stepFrenzy(next, events);
  // Credit this tick's kills toward any running frenzy, after every system
  // that can produce one has run.
  for (const ev of events) {
    if (ev.type === 'kill' && ev.tick === next.tick) creditFrenzyKill(next, ev.killerId, events);
  }

  return next;
}

function applyCommand(state: GameState, cmd: SimCommand, map: CityMap): void {
  switch (cmd.type) {
    case 'spawnPlayer': {
      if (getEntity(state.players, cmd.playerId)) return;
      const spawn = pickSpawn(state, map);
      const player = createPlayer(cmd.playerId, cmd.name, spawn);
      if (cmd.loadout) {
        player.weapons = cmd.loadout.map((w) => ({ ...w }));
        player.activeWeapon = player.weapons.length > 0 ? 0 : -1;
      }
      insertEntity(state.players, player);
      if (cmd.playerId >= state.nextEntityId) {
        state.nextEntityId = cmd.playerId + 1;
      }
      break;
    }
    case 'respawnPlayer': {
      const p = getEntity(state.players, cmd.playerId);
      if (!p || p.mode !== 'dead') return;
      // You wake up at the nearest hospital, not at a random kerb three
      // districts away. That is what makes dying a setback in a place you
      // recognise rather than a teleport to nowhere. Arrest sends you to a
      // station instead — same journey home, different front door, and one
      // you can learn the locations of.
      const spawn =
        (cmd.atStation ? nearestOf(map.policeStations, map, p.pos) : null) ??
        nearestOf(map.hospitals, map, p.pos) ??
        pickSpawn(state, map);
      p.pos = { x: spawn.x, y: spawn.y };
      p.vel = { x: 0, y: 0 };
      p.mode = 'foot';
      p.health = 100;
      p.respawnAtTick = null;
      p.fireCooldown = 0;
      p.carHitCooldown = 0;
      p.weapons = cmd.loadout.map((w) => ({ ...w }));
      p.activeWeapon = p.weapons.length > 0 ? 0 : -1;
      break;
    }
    case 'grantWeapon': {
      const p = getEntity(state.players, cmd.playerId);
      if (!p || p.mode === 'dead') return;
      const existing = p.weapons.find((w) => w.weaponId === cmd.weaponId);
      if (existing) {
        existing.ammo += cmd.ammo;
      } else {
        p.weapons.push({ weaponId: cmd.weaponId, ammo: cmd.ammo });
        if (p.activeWeapon < 0) p.activeWeapon = 0;
      }
      break;
    }
    case 'setCosmetic': {
      const p = getEntity(state.players, cmd.playerId);
      if (p) p.cosmeticId = cmd.cosmeticId;
      break;
    }
    case 'clearHeat': {
      // A respray. Heat, wanted level and the interest of every cop already
      // on the street all go at once, which is what makes it an escape and
      // not merely a discount.
      const p = getEntity(state.players, cmd.playerId);
      if (!p) return;
      p.heat = 0;
      p.wantedLevel = 0;
      for (const cid of state.cops.ids) {
        const cop = state.cops.byId[cid];
        if (cop && cop.targetId === cmd.playerId) cop.targetId = null;
      }
      break;
    }
    case 'despawnPlayer': {
      const p = getEntity(state.players, cmd.playerId);
      if (p && p.vehicleId !== null) {
        const v = state.vehicles.byId[p.vehicleId];
        if (v && v.driverId === cmd.playerId) v.driverId = null;
      }
      removeEntity(state.players, cmd.playerId);
      break;
    }
    case 'spawnPed': {
      if (getEntity(state.peds, cmd.pedId)) return;
      // Allegiance is a pure function of where you appear and who you are:
      // one pedestrian in four, on somebody's turf, is one of theirs. That
      // keeps the command unchanged and the assignment identical on every
      // host without spending a random number on it.
      const turf = gangAt(map, cmd.x, cmd.y);
      const member = turf !== 0 && cmd.pedId % getTuning().gangs.memberEvery === 0;
      insertEntity(
        state.peds,
        createPed(cmd.pedId, { x: cmd.x, y: cmd.y }, getTuning().peds.health, member ? turf : 0),
      );
      if (cmd.pedId >= state.nextEntityId) state.nextEntityId = cmd.pedId + 1;
      break;
    }
    case 'spawnProp': {
      if (getEntity(state.props, cmd.propId)) return;
      const hp = getTuning().props.kinds[cmd.kind]?.hp ?? 10;
      insertEntity(
        state.props,
        createProp(cmd.propId, cmd.kind, { x: cmd.x, y: cmd.y }, cmd.orient, hp),
      );
      if (cmd.propId >= state.nextEntityId) state.nextEntityId = cmd.propId + 1;
      break;
    }
    case 'spawnPickup': {
      if (getEntity(state.pickups, cmd.pickupId)) return;
      insertEntity(state.pickups, createPickup(cmd.pickupId, cmd.kind, { x: cmd.x, y: cmd.y }));
      if (cmd.pickupId >= state.nextEntityId) state.nextEntityId = cmd.pickupId + 1;
      break;
    }
    case 'spawnVehicle': {
      if (getEntity(state.vehicles, cmd.vehicleId)) return;
      insertEntity(
        state.vehicles,
        createVehicle(cmd.vehicleId, cmd.kind, { x: cmd.x, y: cmd.y }, cmd.heading),
      );
      if (cmd.vehicleId >= state.nextEntityId) {
        state.nextEntityId = cmd.vehicleId + 1;
      }
      break;
    }
    case 'despawnPed': {
      removeEntity(state.peds, cmd.pedId);
      break;
    }
    case 'healPlayer': {
      const p = getEntity(state.players, cmd.playerId);
      if (!p || p.mode === 'dead') return;
      const t = getTuning().pickups;
      if (cmd.health > 0) p.health = Math.min(t.maxHealth, p.health + cmd.health);
      if (cmd.armour > 0) p.armour = Math.min(t.maxArmour, p.armour + cmd.armour);
      break;
    }
    case 'fitVehicle': {
      const p = getEntity(state.players, cmd.playerId);
      if (!p || p.vehicleId === null) return;
      const v = state.vehicles.byId[p.vehicleId];
      if (!v) return;
      // Buying the same fitting again tops it up; a different one replaces
      // it. One bracket under the bonnet, and the garage does not refund.
      v.fittingAmmo = v.fitting === cmd.fitting ? v.fittingAmmo + cmd.ammo : cmd.ammo;
      v.fitting = cmd.fitting;
      break;
    }
    case 'crushVehicle': {
      const v = getEntity(state.vehicles, cmd.vehicleId);
      if (!v) return;
      // Whoever was inside is standing on the forecourt, not compacted with
      // it — the crusher pays for the car, not for the driver.
      if (v.driverId !== null) {
        const driver = state.players.byId[v.driverId];
        if (driver && driver.vehicleId === v.id) {
          driver.vehicleId = null;
          if (driver.mode === 'driving') driver.mode = 'foot';
        }
      }
      delete state.trafficDrivers[v.id];
      removeEntity(state.vehicles, cmd.vehicleId);
      break;
    }
  }
}

/** Closest door in a list to a point, or null if the map generated none. */
function nearestOf(
  doors: ReadonlyArray<{ x: number; y: number }>,
  map: CityMap,
  from: { x: number; y: number },
): { x: number; y: number } | null {
  let best: { x: number; y: number } | null = null;
  let bestD = Infinity;
  for (const h of doors) {
    const dx = h.x - from.x;
    const dy = h.y - from.y;
    const d = dx * dx + dy * dy;
    if (d < bestD && !boxInSolid(map, h, PLAYER_RADIUS)) {
      bestD = d;
      best = h;
    }
  }
  return best;
}

/** Random spread-apart spawn point; falls back to any non-solid spot. */
function pickSpawn(state: GameState, map: CityMap): { x: number; y: number } {
  if (map.playerSpawns.length === 0) {
    return { x: map.widthPx / 2, y: map.heightPx / 2 };
  }
  let idx: number;
  [idx, state.rng] = nextIntRange(state.rng, 0, map.playerSpawns.length);
  for (let attempt = 0; attempt < map.playerSpawns.length; attempt++) {
    const candidate = map.playerSpawns[(idx + attempt) % map.playerSpawns.length];
    if (candidate && !boxInSolid(map, candidate, PLAYER_RADIUS)) return candidate;
  }
  return map.playerSpawns[idx] as { x: number; y: number };
}
