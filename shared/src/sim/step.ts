import { nextIntRange } from '../rng/prng.js';
import type { GameState } from './state.js';
import { cloneState, createPickup, createPlayer, createProp, createVehicle } from './state.js';
import { insertEntity, removeEntity, getEntity } from './entities.js';
import type { InputIntent } from './input.js';
import type { SimCommand } from './commands.js';
import { stepPlayerMovement } from './player.js';
import { stepVehicleCoasting, stepVehicleDriving, tryEnterVehicle, tryExitVehicle } from './vehicle.js';
import { stepProps, stepVehicleImpacts, stepWeapons } from './weapons.js';
import { stepPolice } from './police.js';
import { stepPeds } from './peds.js';
import { stepPickups } from './pickups.js';
import { createPed } from './state.js';
import { getTuning } from '../tuning.js';
import type { SimEvent } from './events.js';
import type { CityMap } from '../world/types.js';
import { boxInSolid } from '../world/collide.js';
import { PLAYER_RADIUS } from '../constants.js';

/**
 * Advance the simulation by exactly one fixed tick.
 * Pure with respect to its arguments: the input state is never mutated.
 * Same state + same inputs + same commands + same map => bit-identical
 * result, on any engine. This is the whole contract of the netcode.
 *
 * Fixed sub-order (all iteration in sorted-id order):
 *   commands → action edges (enter/exit) → player/vehicle movement →
 *   driverless vehicles coast → weapons → vehicle impacts → police → peds
 *   → prop repair → pickups.
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
    if (p.mode === 'foot') tryEnterVehicle(next, p, map);
    else if (p.mode === 'driving') tryExitVehicle(next, p, map);
  }

  // Movement.
  for (const id of next.players.ids) {
    const p = next.players.byId[id];
    if (!p) continue;
    const input = inputs[id];
    if (p.mode === 'driving' && p.vehicleId !== null) {
      const v = next.vehicles.byId[p.vehicleId];
      if (v) {
        stepVehicleDriving(v, input, map, next);
        p.pos.x = v.pos.x;
        p.pos.y = v.pos.y;
        if (input) {
          p.lastInputSeq = input.seq;
          p.aimAngle = input.aimAngle;
        }
      }
    } else {
      stepPlayerMovement(p, input, map);
    }
  }

  // Driverless vehicles coast to rest.
  for (const id of next.vehicles.ids) {
    const v = next.vehicles.byId[id];
    if (!v || v.driverId !== null) continue;
    stepVehicleCoasting(v, map, next);
  }

  stepWeapons(next, inputs, map, events);
  stepVehicleImpacts(next, events);
  stepPolice(next, map, events);
  stepPeds(next, map, events);
  stepProps(next, events);
  stepPickups(next, events);

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
      const spawn = pickSpawn(state, map);
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
      insertEntity(state.peds, createPed(cmd.pedId, { x: cmd.x, y: cmd.y }, getTuning().peds.health));
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
  }
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
