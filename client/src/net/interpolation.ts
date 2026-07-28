import type {
  CopState,
  FullSnapshot,
  PedState,
  PickupState,
  ProjectileState,
  PlayerState,
  PropState,
  VehicleState,
} from 'shared';
import { TICK_MS, TICK_RATE, clamp } from 'shared';

/** ~100 ms interpolation delay, in ticks (3 ticks @ 30 Hz). */
export const INTERP_DELAY_TICKS = 3;
const BUFFER_TICKS = TICK_RATE * 2;

export interface RenderPlayer {
  player: PlayerState;
  x: number;
  y: number;
  aimAngle: number;
}

export interface RenderVehicle {
  vehicle: VehicleState;
  x: number;
  y: number;
  heading: number;
}

export interface RenderCop {
  cop: CopState;
  x: number;
  y: number;
}

export interface RenderPed {
  ped: PedState;
  x: number;
  y: number;
}

export interface RenderWorld {
  players: RenderPlayer[];
  vehicles: RenderVehicle[];
  cops: RenderCop[];
  peds: RenderPed[];
  /** Props don't move — passed through from the newest snapshot. */
  props: PropState[];
  /** Nor do pickups; only their active flag changes. */
  pickups: PickupState[];
  projectiles: RenderProjectile[];
}

/** A rocket in flight, interpolated like anything else that moves. */
export interface RenderProjectile {
  projectile: ProjectileState;
  x: number;
  y: number;
}

/**
 * Remote entities render on a delayed, interpolated timeline: we hold a
 * short history of snapshots and sample ~100 ms in the past, lerping between
 * the two bracketing ticks. Never snap, never extrapolate.
 */
export class Interpolator {
  private snapshots: FullSnapshot[] = [];
  private renderTick = 0; // fractional server tick we're rendering
  private synced = false;

  push(snap: FullSnapshot): void {
    const last = this.snapshots[this.snapshots.length - 1];
    if (last && snap.tick <= last.tick) return;
    this.snapshots.push(snap);
    while (this.snapshots.length > BUFFER_TICKS) this.snapshots.shift();
    if (!this.synced) {
      this.renderTick = snap.tick - INTERP_DELAY_TICKS;
      this.synced = true;
    }
  }

  /**
   * Advance the render clock by a real-time frame delta.
   *
   * The clock is dilated rather than servoed on arrival: drifting towards the
   * head of the buffer slows it slightly, falling behind speeds it up. Doing
   * this per frame instead of per snapshot keeps the correction independent of
   * the display rate, and dilation instead of a hard clamp means a late
   * snapshot shows up as remote entities easing off rather than freezing on the
   * spot and then jumping when the packet lands.
   */
  advance(frameMs: number): void {
    if (!this.synced) return;
    const latest = this.snapshots[this.snapshots.length - 1];
    if (!latest) return;

    const behind = latest.tick - this.renderTick;
    const rate = clamp(1 + (behind - INTERP_DELAY_TICKS) * 0.08, 0.8, 1.2);
    this.renderTick += (frameMs / TICK_MS) * rate;

    // Never extrapolate past the newest snapshot, and never fall so far behind
    // that the buffer no longer brackets us.
    this.renderTick = Math.min(this.renderTick, latest.tick);
    this.renderTick = Math.max(this.renderTick, latest.tick - BUFFER_TICKS);
  }

  /**
   * Every vehicle, positioned exactly where this frame draws it.
   *
   * The predictor collides the local car against these rather than against
   * the newest snapshot. Both are "the server's opinion", but they are three
   * ticks apart: remote cars are DRAWN on the delayed timeline above, so
   * predicting against the raw snapshot put every moving car's collider
   * ~100 ms ahead of its sprite — a car length at road speed. You crashed
   * into empty tarmac and drove through the car you could see. Colliding on
   * the timeline you render means you hit what you are looking at.
   */
  vehiclesAsDrawn(): VehicleState[] {
    const world = this.sample(-1, null);
    return world.vehicles.map((rv) => ({
      ...rv.vehicle,
      pos: { x: rv.x, y: rv.y },
      heading: rv.heading,
      zones: rv.vehicle.zones.slice(),
    }));
  }

  /** Interpolated remote entities; the local player + their car are excluded. */
  sample(excludePlayerId: number, excludeVehicleId: number | null): RenderWorld {
    const empty: RenderWorld = {
      players: [],
      vehicles: [],
      cops: [],
      peds: [],
      props: [],
      pickups: [],
      projectiles: [],
    };
    if (this.snapshots.length === 0) return empty;
    let a = this.snapshots[0] as FullSnapshot;
    let b = a;
    for (const s of this.snapshots) {
      if (s.tick <= this.renderTick) a = s;
      if (s.tick >= this.renderTick) {
        b = s;
        break;
      }
      b = s;
    }
    const span = b.tick - a.tick;
    const t = span > 0 ? Math.min(1, Math.max(0, (this.renderTick - a.tick) / span)) : 1;

    const players: RenderPlayer[] = [];
    const pById = new Map(a.players.map((p) => [p.id, p]));
    for (const pb of b.players) {
      if (pb.id === excludePlayerId || pb.mode === 'driving') continue;
      const pa = pById.get(pb.id);
      players.push({
        player: pb,
        x: pa ? pa.pos.x + (pb.pos.x - pa.pos.x) * t : pb.pos.x,
        y: pa ? pa.pos.y + (pb.pos.y - pa.pos.y) * t : pb.pos.y,
        aimAngle: pa ? lerpAngle(pa.aimAngle, pb.aimAngle, t) : pb.aimAngle,
      });
    }

    const vehicles: RenderVehicle[] = [];
    const vById = new Map(a.vehicles.map((v) => [v.id, v]));
    for (const vb of b.vehicles) {
      if (vb.id === excludeVehicleId) continue;
      const va = vById.get(vb.id);
      vehicles.push({
        vehicle: vb,
        x: va ? va.pos.x + (vb.pos.x - va.pos.x) * t : vb.pos.x,
        y: va ? va.pos.y + (vb.pos.y - va.pos.y) * t : vb.pos.y,
        heading: va ? lerpAngle(va.heading, vb.heading, t) : vb.heading,
      });
    }
    const cops: RenderCop[] = [];
    const cById = new Map(a.cops.map((c) => [c.id, c]));
    for (const cb of b.cops) {
      const ca = cById.get(cb.id);
      cops.push({
        cop: cb,
        x: ca ? ca.pos.x + (cb.pos.x - ca.pos.x) * t : cb.pos.x,
        y: ca ? ca.pos.y + (cb.pos.y - ca.pos.y) * t : cb.pos.y,
      });
    }
    const peds: RenderPed[] = [];
    const pedById = new Map(a.peds.map((p) => [p.id, p]));
    for (const pb of b.peds) {
      const pa = pedById.get(pb.id);
      peds.push({
        ped: pb,
        x: pa ? pa.pos.x + (pb.pos.x - pa.pos.x) * t : pb.pos.x,
        y: pa ? pa.pos.y + (pb.pos.y - pa.pos.y) * t : pb.pos.y,
      });
    }
    const projectiles: RenderProjectile[] = [];
    const prById = new Map(a.projectiles.map((p) => [p.id, p]));
    for (const pb of b.projectiles) {
      const pa = prById.get(pb.id);
      projectiles.push({
        projectile: pb,
        x: pa ? pa.pos.x + (pb.pos.x - pa.pos.x) * t : pb.pos.x,
        y: pa ? pa.pos.y + (pb.pos.y - pa.pos.y) * t : pb.pos.y,
      });
    }
    return {
      players,
      vehicles,
      cops,
      peds,
      props: b.props,
      pickups: b.pickups,
      projectiles,
    };
  }
}

function lerpAngle(a: number, b: number, t: number): number {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}
