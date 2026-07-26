import { nextIntRange } from '../rng/prng.js';
import type { GameState } from './state.js';
import { cloneState, createPlayer, createVehicle } from './state.js';
import { insertEntity, removeEntity, getEntity } from './entities.js';
import type { InputIntent } from './input.js';
import type { SimCommand } from './commands.js';
import { stepPlayerMovement } from './player.js';
import { stepVehicleCoasting, stepVehicleDriving, tryEnterVehicle, tryExitVehicle } from './vehicle.js';
import type { CityMap } from '../world/types.js';

/**
 * Advance the simulation by exactly one fixed tick.
 * Pure with respect to its arguments: the input state is never mutated.
 * Same state + same inputs + same commands + same map => bit-identical
 * result, on any engine. This is the whole contract of the netcode.
 *
 * Fixed sub-order (all iteration in sorted-id order):
 *   commands → action edges (enter/exit) → player/vehicle movement →
 *   driverless vehicles coast.
 */
export function step(
  state: GameState,
  inputs: Record<number, InputIntent | undefined>,
  commands: readonly SimCommand[],
  map: CityMap,
): GameState {
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

  return next;
}

function applyCommand(state: GameState, cmd: SimCommand, map: CityMap): void {
  switch (cmd.type) {
    case 'spawnPlayer': {
      if (getEntity(state.players, cmd.playerId)) return;
      let idx = 0;
      if (map.playerSpawns.length > 0) {
        [idx, state.rng] = nextIntRange(state.rng, 0, map.playerSpawns.length);
      }
      const spawn = map.playerSpawns[idx] ?? { x: map.widthPx / 2, y: map.heightPx / 2 };
      insertEntity(state.players, createPlayer(cmd.playerId, cmd.name, spawn));
      if (cmd.playerId >= state.nextEntityId) {
        state.nextEntityId = cmd.playerId + 1;
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
