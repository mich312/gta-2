import { TWO_PI } from '../math/trig.js';
import type { Pose, VehicleWorld } from './bodies.js';
import type { InputIntent } from './input.js';
import type { GameState } from './state.js';

/**
 * Lag compensation: resolving a client's collisions against the world the
 * client could actually see.
 *
 * The problem this exists for is the last one left standing after
 * `Interpolator.vehiclesAsDrawn` — and it is the same problem seen from the
 * other end. Remote cars are DRAWN ~100 ms in the past so they interpolate
 * smoothly, and the client collides against exactly those positions, because
 * a collider that disagrees with the sprite is a collider you cannot aim.
 * The server has no such delay. So the two hosts resolve the same contact
 * against a car that sits, on their two clocks, `INTERP_DELAY_TICKS` plus
 * half a round trip apart: at road speed, most of a car length.
 *
 * That gap is not a rounding error, it is the whole bug. Tailgating, the
 * client stops against a bumper that on the server is still a body-length
 * down the road, so the server pushes you forward and the client re-predicts
 * the same contact next tick — a rubber-band that runs for as long as you
 * follow anybody. Head-on it fires the other way: the server registers a
 * crash a couple of ticks before the client, and you are yanked backwards
 * into an impact you had not had yet.
 *
 * Neither host is wrong; they are looking at different moments. The fix is
 * the one every shooter uses for the same reason: the client says which
 * moment it was looking at, the server keeps enough history to go back and
 * look at the same one, and the contact is judged there. Detection rewinds;
 * the RESPONSE — the shove, the damage, the wreck — still lands on the live
 * car, which is what keeps this lag compensation rather than time travel.
 *
 * What it costs is the standard price, and it is worth naming: the car that
 * gets shunted was, on its own screen, slightly past the point of impact. At
 * a tenth of a second and city speeds that reads as a late nudge. The
 * alternative — what the game does today — is that the driver who aimed the
 * shunt misses, and the server corrects them for it.
 *
 * The whole mechanism is server-side. Clients neither keep nor need a trail:
 * theirs IS the delayed view.
 */

/**
 * How far back a client may ask the server to look, in ticks.
 *
 * Sized for the honest worst case — `INTERP_DELAY_TICKS` (3) of render delay
 * plus the input buffer's own `MAX_INPUT_LAG_TICKS` (8) — and not one tick
 * further, because every tick of it is a tick in which somebody can be hit by
 * a car that has, on their screen, already gone past. A client asking for
 * more is clamped, not trusted: `viewTick` arrives over the wire and is
 * therefore an assertion by a stranger.
 */
export const MAX_REWIND_TICKS = 11;

/** One tick's worth of where every vehicle was. */
interface TrailFrame {
  tick: number;
  poses: Record<number, Pose>;
}

/**
 * Past vehicle poses, newest first. Server-side sim state, like
 * `trafficDrivers` and `vehicleHitTick`: no client runs it, so it belongs in
 * neither the snapshot diff nor the desync hash.
 *
 * Frames are written once and never touched again, so `cloneState` copies the
 * array of references and nothing deeper.
 */
export type VehicleTrail = TrailFrame[];

/**
 * Remember where every vehicle finished this tick.
 *
 * Called at the very end of `step`, so a frame holds exactly what the
 * snapshot for that tick holds — which is what makes replaying the client's
 * own interpolation against it meaningful.
 */
export function recordVehicleTrail(state: GameState): void {
  const poses: Record<number, Pose> = {};
  for (const id of state.vehicles.ids) {
    const v = state.vehicles.byId[id];
    if (v) poses[id] = { x: v.pos.x, y: v.pos.y, heading: v.heading };
  }
  state.vehicleTrail = [{ tick: state.tick, poses }, ...state.vehicleTrail];
  // One spare frame beyond the clamp so the pair bracketing the oldest
  // allowed view tick is always present.
  if (state.vehicleTrail.length > MAX_REWIND_TICKS + 2) {
    state.vehicleTrail = state.vehicleTrail.slice(0, MAX_REWIND_TICKS + 2);
  }
}

/** Shortest-arc interpolation, matching the client's own `lerpAngle`. */
function lerpAngle(a: number, b: number, t: number): number {
  let d = b - a;
  while (d > Math.PI) d -= TWO_PI;
  while (d < -Math.PI) d += TWO_PI;
  return a + d * t;
}

function frameAt(trail: VehicleTrail, tick: number): TrailFrame | null {
  for (const f of trail) {
    if (f.tick === tick) return f;
  }
  return null;
}

/**
 * The world as this input's author saw it.
 *
 * `viewTick` is in fractional ticks because the client's render clock is: it
 * sits between two snapshots and lerps, so pinning it to a whole tick would
 * hand back half a tick of the very error this is here to remove. The two
 * bracketing frames are blended by exactly the formula the client's
 * interpolator uses, so in the common case — no packet loss, both hosts
 * holding the same pair of ticks — the two views agree to the pixel.
 *
 * Returns `state` itself when there is nothing to rewind to: a client that
 * sends no view (a bot, a test, the first seconds of a session before the
 * trail fills) collides against the present, exactly as before.
 */
export function rewoundWorld(state: GameState, input: InputIntent | undefined): VehicleWorld {
  if (!input || input.viewTick <= 0) return state;
  // The newest frame is the previous tick's: this tick has not finished yet.
  const newest = state.tick - 1;
  const oldest = newest - MAX_REWIND_TICKS;
  let view = input.viewTick;
  if (view > newest) view = newest;
  if (view < oldest) view = oldest;

  const lo = Math.floor(view);
  const a = frameAt(state.vehicleTrail, lo);
  if (!a) return state; // trail hasn't reached back this far yet
  const t = view - lo;
  const b = t > 0 ? frameAt(state.vehicleTrail, lo + 1) : null;

  const poses: Record<number, Pose> = {};
  for (const id of state.vehicles.ids) {
    const pa = a.poses[id];
    if (!pa) continue; // didn't exist then; judge it where it is now
    const pb = b?.poses[id];
    poses[id] = pb
      ? {
          x: pa.x + (pb.x - pa.x) * t,
          y: pa.y + (pb.y - pa.y) * t,
          heading: lerpAngle(pa.heading, pb.heading, t),
        }
      : pa;
  }
  return { vehicles: state.vehicles, poses };
}
