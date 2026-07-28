import type {
  CopState,
  GameState,
  PedState,
  PlayerState,
  PickupState,
  ProjectileState,
  PropState,
  VehicleState,
} from '../sim/state.js';
import {
  cloneCop,
  clonePed,
  clonePickup,
  clonePlayer,
  cloneProp,
  cloneProjectile,
  cloneVehicle,
} from '../sim/state.js';

export interface FullSnapshot {
  tick: number;
  /** Sorted by id ascending, always. */
  players: PlayerState[];
  vehicles: VehicleState[];
  cops: CopState[];
  peds: PedState[];
  props: PropState[];
  pickups: PickupState[];
  projectiles: ProjectileState[];
}

export type Patch<T> = { id: number } & Partial<Omit<T, 'id'>>;

export interface TableDelta<T> {
  added: T[];
  updated: Array<Patch<T>>;
  removed: number[];
}

export interface SnapshotDelta {
  players: TableDelta<PlayerState>;
  vehicles: TableDelta<VehicleState>;
  cops: TableDelta<CopState>;
  peds: TableDelta<PedState>;
  props: TableDelta<PropState>;
  pickups: TableDelta<PickupState>;
  projectiles: TableDelta<ProjectileState>;
}

/** Explicit field lists so diffing stays deterministic and reviewable. */
const PLAYER_FIELDS = [
  'name',
  'pos',
  'vel',
  'aimAngle',
  'mode',
  'health',
  'armour',
  'vehicleId',
  'weapons',
  'activeWeapon',
  'cosmeticId',
  'wantedLevel',
  'respawnAtTick',
  // lastInputSeq is deliberately NOT diffed: remote clients never use it and
  // it changes every tick; own reconciliation rides on the message's ackSeq.
  'actionHeld',
  'fireCooldown',
  'carHitCooldown',
  'heat',
  'frenzyTarget',
  'frenzyKills',
  'frenzyEndsAtTick',
  'z',
  'vz',
  // Hashed, therefore it MUST be diffed. Leaving it out made the client's
  // copy go stale the moment anyone jumped, and every subsequent snapshot
  // hash disagreed — 25 desyncs per bot, with a sim that replays perfectly.
  'airDist',
  'fittingCooldown',
  'respect',
  'powerFlags',
  'powerUntilTick',
] as const;

const VEHICLE_FIELDS = [
  'kind',
  'pos',
  'heading',
  'speed',
  'driverId',
  'health',
  'condition',
  'fuseAtTick',
  // Hashed, therefore they MUST be diffed — the airDist note above is what
  // happens when a hashed field is left out of this list.
  'zones',
  'broken',
  'fitting',
  'fittingAmmo',
] as const;
const COP_FIELDS = [
  'kind',
  'pos',
  'vel',
  'targetId',
  'health',
  'fireCooldown',
  'idleTicks',
  'carHitCooldown',
  'vehicleId',
  'stuckTicks',
] as const;
const PED_FIELDS = [
  'gangId',
  'pos',
  'dirX',
  'dirY',
  'mode',
  'health',
  'timer',
  'targetId',
] as const;
const PROP_FIELDS = ['kind', 'pos', 'orient', 'intact', 'hp', 'respawnAtTick'] as const;
const PICKUP_FIELDS = ['kind', 'pos', 'active', 'respawnAtTick', 'weaponId', 'ammo'] as const;
// vel rides along so the client can extrapolate between snapshots; a rocket
// moves 14 px per tick and would otherwise stutter across the screen.
const PROJECTILE_FIELDS = ['kind', 'pos', 'vel', 'ownerId', 'fuseAtTick'] as const;

export function takeSnapshot(state: GameState): FullSnapshot {
  return {
    tick: state.tick,
    players: state.players.ids.map((id) => clonePlayer(state.players.byId[id] as PlayerState)),
    vehicles: state.vehicles.ids.map((id) =>
      cloneVehicle(state.vehicles.byId[id] as VehicleState),
    ),
    cops: state.cops.ids.map((id) => cloneCop(state.cops.byId[id] as CopState)),
    peds: state.peds.ids.map((id) => clonePed(state.peds.byId[id] as PedState)),
    props: state.props.ids.map((id) => cloneProp(state.props.byId[id] as PropState)),
    pickups: state.pickups.ids.map((id) => clonePickup(state.pickups.byId[id] as PickupState)),
    projectiles: state.projectiles.ids.map((id) =>
      cloneProjectile(state.projectiles.byId[id] as ProjectileState),
    ),
  };
}

function valueEq(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) {
    return false;
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!valueEq(a[i], b[i])) return false;
    }
    return true;
  }
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (const k of ka) {
    if (!valueEq((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])) {
      return false;
    }
  }
  return true;
}

function cloneVal<T>(v: T): T {
  if (typeof v !== 'object' || v === null) return v;
  if (Array.isArray(v)) return v.map(cloneVal) as unknown as T;
  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    out[k] = cloneVal(val);
  }
  return out as T;
}

function diffTable<T extends { id: number }>(
  base: T[],
  cur: T[],
  fields: readonly (keyof T & string)[],
  cloneOne: (t: T) => T,
): TableDelta<T> {
  const added: T[] = [];
  const updated: Array<Patch<T>> = [];
  const removed: number[] = [];
  let i = 0;
  let j = 0;
  while (i < base.length || j < cur.length) {
    const b = base[i];
    const c = cur[j];
    if (b && (!c || b.id < c.id)) {
      removed.push(b.id);
      i++;
    } else if (c && (!b || c.id < b.id)) {
      added.push(cloneOne(c));
      j++;
    } else if (b && c) {
      const patch: Record<string, unknown> = { id: c.id };
      let changed = false;
      for (const f of fields) {
        if (!valueEq(b[f], c[f])) {
          patch[f] = cloneVal(c[f]);
          changed = true;
        }
      }
      if (changed) updated.push(patch as Patch<T>);
      i++;
      j++;
    }
  }
  return { added, updated, removed };
}

function applyTable<T extends { id: number }>(
  base: T[],
  delta: TableDelta<T>,
  cloneOne: (t: T) => T,
): T[] {
  const byId = new Map<number, T>();
  for (const e of base) byId.set(e.id, cloneOne(e));
  for (const id of delta.removed) byId.delete(id);
  for (const patch of delta.updated) {
    const e = byId.get(patch.id);
    if (!e) continue;
    for (const [k, v] of Object.entries(patch)) {
      if (k === 'id') continue;
      (e as unknown as Record<string, unknown>)[k] = cloneVal(v);
    }
  }
  for (const e of delta.added) byId.set(e.id, cloneOne(e));
  return [...byId.values()].sort((a, b) => a.id - b.id);
}

/** Delta between two snapshots. Both inputs must be id-sorted (they always are). */
export function diffSnapshots(base: FullSnapshot, cur: FullSnapshot): SnapshotDelta {
  return {
    players: diffTable(base.players, cur.players, PLAYER_FIELDS, clonePlayer),
    vehicles: diffTable(base.vehicles, cur.vehicles, VEHICLE_FIELDS, cloneVehicle),
    cops: diffTable(base.cops, cur.cops, COP_FIELDS, cloneCop),
    peds: diffTable(base.peds, cur.peds, PED_FIELDS, clonePed),
    props: diffTable(base.props, cur.props, PROP_FIELDS, cloneProp),
    pickups: diffTable(base.pickups, cur.pickups, PICKUP_FIELDS, clonePickup),
    projectiles: diffTable(base.projectiles, cur.projectiles, PROJECTILE_FIELDS, cloneProjectile),
  };
}

/** Apply a delta to the snapshot it was computed against. */
export function applyDelta(
  base: FullSnapshot,
  delta: SnapshotDelta,
  tick: number,
): FullSnapshot {
  return {
    tick,
    players: applyTable(base.players, delta.players, clonePlayer),
    vehicles: applyTable(base.vehicles, delta.vehicles, cloneVehicle),
    cops: applyTable(base.cops, delta.cops, cloneCop),
    peds: applyTable(base.peds, delta.peds, clonePed),
    props: applyTable(base.props, delta.props, cloneProp),
    pickups: applyTable(base.pickups, delta.pickups, clonePickup),
    projectiles: applyTable(base.projectiles, delta.projectiles, cloneProjectile),
  };
}
