import { WORLD_WIDTH, WORLD_HEIGHT } from '../constants.js';
import { nextRange } from '../rng/prng.js';
import type { GameState } from './state.js';
import { cloneState, createPlayer } from './state.js';
import { insertEntity, removeEntity, getEntity } from './entities.js';
import type { InputIntent } from './input.js';
import type { SimCommand } from './commands.js';
import { stepPlayers } from './player.js';

const SPAWN_MARGIN = 40;

/**
 * Advance the simulation by exactly one fixed tick.
 * Pure with respect to its arguments: the input state is never mutated.
 * Same state + same inputs + same commands => bit-identical result,
 * on any engine. This is the whole contract of the netcode.
 */
export function step(
  state: GameState,
  inputs: Record<number, InputIntent | undefined>,
  commands: readonly SimCommand[],
): GameState {
  const next = cloneState(state);
  next.tick = state.tick + 1;
  for (const cmd of commands) {
    applyCommand(next, cmd);
  }
  stepPlayers(next, inputs);
  return next;
}

function applyCommand(state: GameState, cmd: SimCommand): void {
  switch (cmd.type) {
    case 'spawnPlayer': {
      if (getEntity(state.players, cmd.playerId)) return;
      let x: number;
      let y: number;
      [x, state.rng] = nextRange(state.rng, SPAWN_MARGIN, WORLD_WIDTH - SPAWN_MARGIN);
      [y, state.rng] = nextRange(state.rng, SPAWN_MARGIN, WORLD_HEIGHT - SPAWN_MARGIN);
      insertEntity(state.players, createPlayer(cmd.playerId, cmd.name, { x, y }));
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
