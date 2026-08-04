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
  'hornHeld',
  'fireCooldown',
  'carHitCooldown',
  'heat',
  // Hashed like `heat` itself, so it has to be diffed — the airDist note
  // above is what happens when a hashed field is left off this list.
  'unseenTicks',
  'wantedSinceTick',
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
  'stunnedUntilTick',
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
  'igniterId',
  'spreadUsed',
  'gangId',
  // Hashed, therefore they MUST be diffed — the airDist note above is what
  // happens when a hashed field is left out of this list.
  'zones',
  'broken',
  'z',
  // The altitude's two companions. Leaving them out is a silent failure of
  // exactly the kind the note above describes: a field absent from this list
  // still ships in a FULL snapshot, so it looks correct on the frame a player
  // joins and never changes again — the client saw a helicopter climbing to
  // cruise height with its take-off latch stuck at whatever it was when the
  // last full snapshot went out, and the HUD read "landing" all the way up.
  'climb',
  'liftHeld',
  // Written once at spawn and never again, so this costs nothing after the
  // first snapshot that carries the vehicle — but it has to be IN one.
  'paint',
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
  'lastSeenX',
  'lastSeenY',
  'searchTicks',
  'searchDir',
  'burstLeft',
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
  // Hashed, therefore it MUST be diffed — the third time this list has been
  // caught short the same way (see `airDist` and `climb`/`liftHeld` above).
  // A mission assigns an escortee by writing this field and nothing else, so
  // the delta was empty, the client's ped kept `escortOf: null` for the whole
  // mission, and every hashed snapshot after the assignment disagreed. Both
  // renderers draw the escort marker off exactly this field, so the person
  // you were sent to protect had nothing over their head either.
  'escortOf',
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

/**
 * Copy-on-write: an entity the delta does not name is carried into the new
 * snapshot BY REFERENCE, not cloned.
 *
 * The old version cloned every entity of every table on every application —
 * seven tables, thirty times a second, three to five nested allocations per
 * entity, on the thread that draws — and then kept ~180 ticks of those full
 * copies alive across the two history buffers, which is exactly the
 * long-lived garbage a generational collector answers with major pauses.
 * A delta names the few entities that moved; only those are cloned.
 *
 * The contract this buys is that snapshots are STRUCTURALLY SHARED and
 * therefore read-only: a consumer that wants to write on an entity it got
 * out of a snapshot must clone it first (they all did anyway — see
 * `snapshot.test.ts`, which now pins the sharing itself). The tables stay
 * id-sorted by construction: base is sorted, `delta.added` is sorted (built
 * by an id-merge in `diffTable`), and the merge below preserves both.
 */
function applyTable<T extends { id: number }>(
  base: T[],
  delta: TableDelta<T>,
  cloneOne: (t: T) => T,
): T[] {
  const { added, updated, removed } = delta;
  if (added.length === 0 && updated.length === 0 && removed.length === 0) return base;
  const removedIds = removed.length > 0 ? new Set(removed) : null;
  let patchById: Map<number, Patch<T>> | null = null;
  if (updated.length > 0) {
    patchById = new Map();
    for (const p of updated) patchById.set(p.id, p);
  }
  const out: T[] = [];
  let j = 0;
  for (const e of base) {
    while (j < added.length && (added[j] as T).id < e.id) out.push(cloneOne(added[j++] as T));
    if (removedIds?.has(e.id)) continue;
    const patch = patchById?.get(e.id);
    if (patch) {
      // Changed: clone, then lay the patch over the clone. The patch's own
      // values are cloned too — the delta object lives on in the message
      // history, and the snapshot must not share structure with it.
      const copy = cloneOne(e);
      for (const k in patch) {
        if (k === 'id') continue;
        (copy as unknown as Record<string, unknown>)[k] = cloneVal(
          (patch as Record<string, unknown>)[k],
        );
      }
      out.push(copy);
    } else {
      out.push(e);
    }
  }
  while (j < added.length) out.push(cloneOne(added[j++] as T));
  return out;
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
