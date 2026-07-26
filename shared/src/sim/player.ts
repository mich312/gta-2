import { DT, PLAYER_RADIUS, WORLD_WIDTH, WORLD_HEIGHT } from '../constants.js';
import { approach, clamp } from '../math/vec.js';
import { getTuning } from '../tuning.js';
import type { GameState } from './state.js';
import type { InputIntent } from './input.js';

const INV_SQRT2 = 1 / Math.sqrt(2);

/**
 * On-foot movement. Mutates the (already cloned) state passed in by step().
 * Iterates players in sorted-id order; uses only the fixed DT.
 */
export function stepPlayers(
  state: GameState,
  inputs: Record<number, InputIntent | undefined>,
): void {
  const { walkSpeed, accel } = getTuning().player;
  const maxDelta = accel * DT;

  for (const id of state.players.ids) {
    const p = state.players.byId[id];
    if (!p) continue;
    const input = inputs[id];
    if (input) {
      p.lastInputSeq = input.seq;
      p.aimAngle = input.aimAngle;
    }
    if (p.mode === 'dead') continue;

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

    p.pos.x = p.pos.x + p.vel.x * DT;
    p.pos.y = p.pos.y + p.vel.y * DT;

    const minX = PLAYER_RADIUS;
    const maxX = WORLD_WIDTH - PLAYER_RADIUS;
    const minY = PLAYER_RADIUS;
    const maxY = WORLD_HEIGHT - PLAYER_RADIUS;
    if (p.pos.x <= minX || p.pos.x >= maxX) {
      p.pos.x = clamp(p.pos.x, minX, maxX);
      p.vel.x = 0;
    }
    if (p.pos.y <= minY || p.pos.y >= maxY) {
      p.pos.y = clamp(p.pos.y, minY, maxY);
      p.vel.y = 0;
    }
  }
}
