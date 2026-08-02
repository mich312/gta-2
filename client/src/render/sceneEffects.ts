import { PLAYER_RADIUS, PART_BONNET, TICK_RATE, getTuning, vehicleWear } from 'shared';
import type { Effects } from './effects.js';
import type { Scene } from './renderer.js';

/**
 * The effects a frame spawns just by looking at the world.
 *
 * Most of what the particle system draws arrives on an event — a shot, a punch,
 * an explosion — and `main.ts` has always spawned those. The rest is *derived*
 * from state that no event describes: a car is sliding, so it is laying rubber;
 * a car is under way, so it is trailing exhaust; a body is fresh, so it is
 * still bleeding. Nothing tells you those happened. You work them out from the
 * scene, every frame.
 *
 * That derivation used to live inside the 2D renderer's own drawing functions,
 * as a side effect of drawing a car or a corpse. Which meant the 3D renderer
 * had no skid marks, no exhaust and no blood pools — not because it failed to
 * draw them, but because in 3D they were never created. Effects that both
 * renderers must have cannot be a side effect of one of them drawing.
 *
 * So it lives here, is called once a frame from `main.ts` before either
 * renderer runs, and both get the identical set.
 */

/** Below this there is not enough weight on the tyres to mark the road. */
const SKID_MIN_SPEED = 170;
/** Rad/s of yaw that counts as a slide. Peak steering authority is 2.8. */
const SKID_MIN_YAW_RATE = 1.9;
/**
 * Deceleration that counts as standing on the brakes, px/s². A car brakes at
 * 520 and coasts down at 180 (`vehicles.json`), so this catches the pedal and
 * ignores lifting off.
 */
const SKID_MIN_DECEL = 180;
/** ...and the speed it has to be doing for the marks to show. */
const SKID_MIN_BRAKE_SPEED = 54;
/**
 * Rubber is laid at a wall-clock cadence, not per frame — a 240 Hz display
 * must not lay four times the rubber of a 60 Hz one.
 */
const SKID_INTERVAL_MS = 45;

const skidState = new Map<
  number,
  { heading: number; speed: number; ms: number; nextAtMs: number; seq: number }
>();

/**
 * Which frame we are on, so a gap in a vehicle's history can be told from a
 * long frame.
 *
 * These are not the same thing and conflating them cost every skid mark in the
 * game on a slow machine. What the history check is for is a vehicle that left
 * the screen and came back — its last sample is old and the heading change
 * since then is meaningless. That was detected by asking whether the sample was
 * more than 250 ms ago, which is also true of *every* vehicle on any machine
 * rendering below four frames a second, so `layRubber` bailed every frame for
 * everyone and no rubber was ever laid.
 *
 * Counting frames asks the question directly: was this vehicle sampled on the
 * frame before this one? A long frame is then just a long frame.
 */
let frameSeq = 0;

/** Seconds a fresh body keeps bleeding out onto the ground. */
const BLEED_SEC = 4.5;
/** How many marks that produces, spread over those seconds. */
const BLEED_MARKS = 5;
/**
 * Marks already laid by each body, so the pool creeps rather than appearing.
 *
 * Entries are dropped once a body has finished bleeding, but a body that leaves
 * the view mid-bleed never gets that far — so the map is also cleared outright
 * if it ever grows past what a screenful of casualties could need.
 */
const bledMarks = new Map<string, number>();
const MAX_BLEEDING = 64;

/**
 * Tyre marks: two arcs under the rear wheels through a slide, four straight
 * ones under a hard stop.
 *
 * Braking is the half you see most, because every car in the city brakes.
 */
function layRubber(
  effects: Effects,
  id: number,
  wx: number,
  wy: number,
  heading: number,
  speed: number,
  nowMs: number,
  /** In the air: keep the history, lay nothing. There is no road up there. */
  airborne: boolean,
): void {
  const prev = skidState.get(id);
  // The decision below needs prev's values, so they are read out BEFORE the
  // record is updated in place — a fresh record per vehicle per frame was
  // steady garbage for state that never changes shape.
  const prevHeading = prev?.heading ?? 0;
  const prevSpeed = prev?.speed ?? 0;
  const prevMs = prev?.ms ?? 0;
  const prevNextAtMs = prev?.nextAtMs ?? 0;
  const prevSeq = prev?.seq ?? 0;
  if (prev) {
    prev.heading = heading;
    prev.speed = speed;
    prev.ms = nowMs;
    prev.seq = frameSeq;
  } else {
    skidState.set(id, { heading, speed, ms: nowMs, nextAtMs: 0, seq: frameSeq });
  }
  if (!prev || airborne) return;

  const dtMs = nowMs - prevMs;
  // Continuous history only: this vehicle has to have been sampled on the
  // previous frame for the heading change since then to mean anything.
  if (dtMs <= 0 || prevSeq !== frameSeq - 1) return;
  // Shortest signed angle between the two headings, so wrapping past ±π
  // doesn't read as a violent slide.
  let delta = heading - prevHeading;
  while (delta > Math.PI) delta -= Math.PI * 2;
  while (delta < -Math.PI) delta += Math.PI * 2;
  const yawRate = Math.abs(delta) / (dtMs / 1000);
  const sliding = Math.abs(speed) >= SKID_MIN_SPEED && yawRate >= SKID_MIN_YAW_RATE;

  // Braking, as opposed to crashing: a wall reverses the speed outright, and a
  // rebound is not a brake mark.
  const decel = (Math.abs(prevSpeed) - Math.abs(speed)) / (dtMs / 1000);
  const braking =
    Math.abs(speed) >= SKID_MIN_BRAKE_SPEED && speed * prevSpeed > 0 && decel >= SKID_MIN_DECEL;

  if (!sliding && !braking) return;
  if (nowMs < prevNextAtMs) return;

  const cos = Math.cos(heading);
  const sin = Math.sin(heading);
  const track = 5;
  // A slide marks the rear wheels; all four lock up under braking.
  const axles = braking ? [8, -8] : [8];
  for (const back of axles) {
    for (const s of [-1, 1]) {
      effects.skid(wx - cos * back - sin * track * s, wy - sin * back + cos * track * s, heading);
    }
  }
  // Rubber laid: push the next-allowed time out. The record was already
  // updated in place above; only the throttle field moves here.
  if (prev) prev.nextAtMs = nowMs + SKID_INTERVAL_MS;
}

/**
 * Blood, running out for the first few seconds down the body's own axis.
 *
 * Ordinary decals, so they outlast the body: the street still shows where
 * somebody was long after they have been cleared away.
 */
function bleedFrom(
  effects: Effects,
  key: string,
  wx: number,
  wy: number,
  angle: number,
  ageSec: number,
): void {
  const want = Math.min(BLEED_MARKS, Math.floor((ageSec / BLEED_SEC) * BLEED_MARKS) + 1);
  const laid = bledMarks.get(key) ?? 0;
  if (ageSec <= BLEED_SEC + 1 && want > laid) {
    effects.bleed(wx, wy, angle, 3 + PLAYER_RADIUS * 0.8);
    if (bledMarks.size >= MAX_BLEEDING) bledMarks.clear();
    bledMarks.set(key, want);
  } else if (ageSec > BLEED_SEC + 2 && laid > 0) {
    bledMarks.delete(key); // done; do not keep the entry for ever
  }
}

/** One vehicle's worth of trail, smoke and rubber. */
interface VehicleFx {
  id: number;
  kind: string;
  x: number;
  y: number;
  heading: number;
  speed: number;
  z: number;
  condition: string;
  broken: number;
  wear: number;
  occupied: boolean;
}

/** Reused by the remote-vehicle loop in `spawnSceneEffects`; never stored. */
const VEHICLE_SCRATCH: VehicleFx = {
  id: 0,
  kind: '',
  x: 0,
  y: 0,
  heading: 0,
  speed: 0,
  z: 0,
  condition: 'ok',
  broken: 0,
  wear: 0,
  occupied: false,
};

function vehicleEffects(
  effects: Effects,
  o: {
    id: number;
    kind: string;
    x: number;
    y: number;
    heading: number;
    speed: number;
    z: number;
    condition: string;
    broken: number;
    wear: number;
    occupied: boolean;
  },
  nowMs: number,
): void {
  layRubber(effects, o.id, o.x, o.y, o.heading, o.speed, nowMs, o.z > 0);

  // A bonnet that is gone, or damage deep enough to hole the block, smokes.
  const holed = o.wear > 0.72;
  if (o.condition === 'ok' && (holed || (o.broken & PART_BONNET) !== 0)) {
    const period = holed ? 1.4 : 2.6;
    if ((nowMs * 0.06 + o.id) % period < 1) {
      effects.engineSmoke(o.x + Math.cos(o.heading) * 8, o.y + Math.sin(o.heading) * 8, holed);
    }
  }

  if (o.condition === 'burning') effects.fire(o.x, o.y);

  // Exhaust while under way; sampled off wall-clock so it does not thicken on
  // a fast display. Not from the air: the puff goes on the ground plane, so an
  // aircraft's would trail along the street below it.
  if (o.occupied && o.z <= 0 && Math.abs(o.speed) > 40 && (nowMs * 0.06 + o.id) % 3 < 1) {
    effects.exhaust(o.x, o.y, o.heading);
  }
}

/**
 * Spawn everything this frame's world implies. Call once per frame, from
 * `main.ts`, whichever renderer is about to draw.
 */
export function spawnSceneEffects(effects: Effects, scene: Scene): void {
  const nowMs = scene.nowMs;
  frameSeq++;

  for (const rv of scene.remotes.vehicles) {
    const v = rv.vehicle;
    // One scratch descriptor, reused: `vehicleEffects` reads it and never
    // stores it, and a fresh object per vehicle per frame was steady garbage.
    VEHICLE_SCRATCH.id = v.id;
    VEHICLE_SCRATCH.kind = v.kind;
    VEHICLE_SCRATCH.x = rv.x;
    VEHICLE_SCRATCH.y = rv.y;
    VEHICLE_SCRATCH.heading = rv.heading;
    VEHICLE_SCRATCH.speed = v.speed;
    VEHICLE_SCRATCH.z = v.z ?? 0;
    VEHICLE_SCRATCH.condition = v.condition;
    VEHICLE_SCRATCH.broken = v.broken ?? 0;
    VEHICLE_SCRATCH.wear = vehicleWear(v);
    VEHICLE_SCRATCH.occupied = v.driverId !== null;
    vehicleEffects(effects, VEHICLE_SCRATCH, nowMs);
  }

  // The car the local player is driving comes from PREDICTION, like the 2D
  // renderer draws it — so its rubber is laid where they are, not where the
  // last snapshot put them.
  const lv = scene.localVehicle;
  if (lv && scene.local?.vehicleId != null) {
    vehicleEffects(
      effects,
      {
        id: scene.local.vehicleId,
        kind: lv.kind,
        x: lv.pos.x,
        y: lv.pos.y,
        heading: lv.heading,
        speed: lv.speed,
        z: lv.z,
        condition: lv.condition,
        broken: lv.broken,
        wear: lv.wear,
        occupied: true,
      },
      nowMs,
    );
  }

  // Bodies. `timer` counts DOWN from whichever clock they are on, so what is
  // left of it says how long they have been lying there; a downed officer's
  // `idleTicks` counts UP from the same moment.
  for (const pd of scene.remotes.peds) {
    const dying = pd.ped.mode === 'downed';
    if (!dying && pd.ped.mode !== 'dead') continue;
    const full = (dying ? getTuning().peds.bleedOutSec : getTuning().peds.corpseSec) * TICK_RATE;
    bleedFrom(
      effects,
      `d${pd.ped.id}`,
      pd.x,
      pd.y,
      Math.atan2(pd.ped.dirY, pd.ped.dirX),
      Math.max(0, full - pd.ped.timer) / TICK_RATE,
    );
  }
  for (const c of scene.remotes.cops) {
    if (c.cop.health > 0) continue;
    bleedFrom(
      effects,
      `c${c.cop.id}`,
      c.x,
      c.y,
      Math.atan2(c.cop.vel.y, c.cop.vel.x),
      c.cop.idleTicks / TICK_RATE,
    );
  }
}
