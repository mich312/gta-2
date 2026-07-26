import { nextIntRange } from '../rng/prng.js';
import type { GameState } from './state.js';
import { cloneState, createPlayer } from './state.js';
import { insertEntity, removeEntity, getEntity } from './entities.js';
import type { InputIntent } from './input.js';
import type { SimCommand } from './commands.js';
import { stepPlayers } from './player.js';
import type { CityMap } from '../world/types.js';

/**
 * Advance the simulation by exactly one fixed tick.
 * Pure with respect to its arguments: the input state is never mutated.
 * Same state + same inputs + same commands + same map => bit-identical
 * result, on any engine. This is the whole contract of the netcode.
 * (map is derived from the seed, so it is the same on both sides.)
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
  stepPlayers(next, inputs, map);
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
      removeEntity(state.players, cmd.playerId);
      break;
    }
  }
}
