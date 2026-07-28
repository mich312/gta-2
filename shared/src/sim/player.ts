import { POWER_STUNNED } from './state.js';
import { DT, PLAYER_RADIUS } from '../constants.js';
import { approach, q8, q256 } from '../math/vec.js';
import { dCos, dSin } from '../math/trig.js';
import { getTuning } from '../tuning.js';
import type { GameState, PlayerState } from './state.js';
import type { InputIntent } from './input.js';
import type { CityMap } from '../world/types.js';
import { moveWithCollision } from '../world/collide.js';
import { pushOutOfVehicles, type VehicleWorld } from './bodies.js';

const INV_SQRT2 = 1 / Math.sqrt(2);

/**
 * Advance ONE player by one fixed tick. This exact function runs on the
 * server inside step() and on the client inside the predictor — sharing it
 * is what makes prediction bit-exact. Collides against static tiles and,
 * given a `world`, against vehicle bodies.
 */
export function stepPlayerMovement(
  p: PlayerState,
  input: InputIntent | undefined,
  map: CityMap,
  tick = 0,
  /**
   * What can be walked into. The client predicts this too, from the same
   * delayed view it collides its car against, so walking up to a parked car
   * stops in the same place on both hosts. Null means tiles only.
   */
  world: VehicleWorld | null = null,
): void {
  // Stunned: the aim still tracks, because a frozen camera reads as a
  // dropped connection rather than as being hit. Only the legs stop.
  const frozen = (p.powerFlags & POWER_STUNNED) !== 0 && tick < p.stunnedUntilTick;
  if (input) {
    p.lastInputSeq = input.seq;
    // Quantised HERE, not merely trusted to arrive quantised. sanitizeIntent
    // already q256s anything off the wire, but the client's own predictor
    // feeds raw atan2 output straight in, and the binary codec encodes this
    // field on the q256 grid — so the sim owns the invariant rather than
    // depending on every caller to have honoured it.
    p.aimAngle = q256(input.aimAngle);
  }
  if (p.mode === 'dead') return;

  const { walkSpeed, accel } = getTuning().player;
  const maxDelta = accel * DT;

  // Movement on foot is SCREEN-relative: up goes up, left goes left, and the
  // mouse only decides which way you are pointing, and therefore shooting.
  //
  // This was briefly aim-relative — `up` ran towards the pointer and the side
  // keys sidestepped across it — on the theory that the facing should be the
  // frame the controls are expressed in. In the hand it was worse: the
  // direction a key sends you then changes every time the mouse moves, so no
  // key has a fixed meaning and walking a straight line while looking around
  // is impossible. Aim-relative is right for a twin-stick pad and wrong for
  // WASD.
  //
  // Screen y points down, so `up` is negative y.
  let dx = 0;
  let dy = 0;
  // Stunned: fall through with no input rather than returning early, so the
  // usual deceleration brings them to a stop. Returning here left whoever
  // was running when they were hit sliding across the road at full speed.
  if (input && !frozen) {
    dx = (input.right ? 1 : 0) - (input.left ? 1 : 0);
    dy = (input.down ? 1 : 0) - (input.up ? 1 : 0);
    // Two keys at once must not be faster than one.
    if (dx !== 0 && dy !== 0) {
      dx *= INV_SQRT2;
      dy *= INV_SQRT2;
    }
  }

  p.vel.x = approach(p.vel.x, dx * walkSpeed, maxDelta);
  p.vel.y = approach(p.vel.y, dy * walkSpeed, maxDelta);

  moveWithCollision(map, p.pos, p.vel, PLAYER_RADIUS, p.vel.x * DT, p.vel.y * DT);
  // Cars are solid to people too. After the tiles, so a push out of a car
  // can be refused when it would put somebody inside a wall.
  pushOutOfVehicles(p.pos, p.vel, PLAYER_RADIUS, world, map, p.vehicleId);
  p.pos.x = q8(p.pos.x);
  p.pos.y = q8(p.pos.y);
  p.vel.x = q8(p.vel.x);
  p.vel.y = q8(p.vel.y);
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
    stepPlayerMovement(p, inputs[id], map, state.tick, state);
  }
}
