import { DT, PLAYER_RADIUS } from '../constants.js';
import { approach } from '../math/vec.js';
import { getTuning } from '../tuning.js';
import type { GameState, PlayerState } from './state.js';
import type { InputIntent } from './input.js';
import type { CityMap } from '../world/types.js';
import { moveWithCollision } from '../world/collide.js';

const INV_SQRT2 = 1 / Math.sqrt(2);

/**
 * Advance ONE player by one fixed tick. This exact function runs on the
 * server inside step() and on the client inside the predictor — sharing it
 * is what makes prediction bit-exact. Collides against static tiles only.
 */
export function stepPlayerMovement(
  p: PlayerState,
  input: InputIntent | undefined,
  map: CityMap,
): void {
  if (input) {
    p.lastInputSeq = input.seq;
    p.aimAngle = input.aimAngle;
  }
  if (p.mode === 'dead') return;

  const { walkSpeed, accel } = getTuning().player;
  const maxDelta = accel * DT;

  let dx = 0;
  let dy = 0;
  if (input) {
    dx = (input.right ? 1 : 0) - (input.left ? 1 : 0);
    dy = (input.down ? 1 : 0) - (input.up ? 1 : 0);
    if (dx !== 0 && dy !== 0) {
      dx *= INV_SQRT2;
      dy *= INV_SQRT2;
    }
  }

  p.vel.x = approach(p.vel.x, dx * walkSpeed, maxDelta);
  p.vel.y = approach(p.vel.y, dy * walkSpeed, maxDelta);

  moveWithCollision(map, p.pos, p.vel, PLAYER_RADIUS, p.vel.x * DT, p.vel.y * DT);
}

/** All players, in sorted-id order. */
export function stepPlayers(
  state: GameState,
  inputs: Record<number, InputIntent | undefined>,
  map: CityMap,
): void {
  for (const id of state.players.ids) {
    const p = state.players.byId[id];
    if (!p) continue;
    stepPlayerMovement(p, inputs[id], map);
  }
}
