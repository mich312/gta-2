import type { GameState, PlayerState } from '../sim/state.js';
import { clonePlayer } from '../sim/state.js';

export interface FullSnapshot {
  tick: number;
  /** Sorted by id ascending, always. */
  players: PlayerState[];
}

export type PlayerPatch = { id: number } & Partial<Omit<PlayerState, 'id'>>;

export interface SnapshotDelta {
  added: PlayerState[];
  updated: PlayerPatch[];
  removed: number[];
}

/** Explicit field list so diffing stays deterministic and reviewable. */
const PLAYER_FIELDS = [
  'name',
  'pos',
  'vel',
  'aimAngle',
  'mode',
  'health',
  'vehicleId',
  'weapons',
  'activeWeapon',
  'cosmeticId',
  'wantedLevel',
  'respawnAtTick',
  'lastInputSeq',
] as const;

export function takeSnapshot(state: GameState): FullSnapshot {
  return {
    tick: state.tick,
    players: state.players.ids.map((id) => clonePlayer(state.players.byId[id] as PlayerState)),
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

/** Delta between two snapshots. Both inputs must be id-sorted (they always are). */
export function diffSnapshots(base: FullSnapshot, cur: FullSnapshot): SnapshotDelta {
  const added: PlayerState[] = [];
  const updated: PlayerPatch[] = [];
  const removed: number[] = [];
  let i = 0;
  let j = 0;
  while (i < base.players.length || j < cur.players.length) {
    const b = base.players[i];
    const c = cur.players[j];
    if (b && (!c || b.id < c.id)) {
      removed.push(b.id);
      i++;
    } else if (c && (!b || c.id < b.id)) {
      added.push(clonePlayer(c));
      j++;
    } else if (b && c) {
      const patch: Record<string, unknown> = { id: c.id };
      let changed = false;
      for (const f of PLAYER_FIELDS) {
        if (!valueEq(b[f], c[f])) {
          patch[f] = cloneVal(c[f]);
          changed = true;
        }
      }
      if (changed) updated.push(patch as PlayerPatch);
      i++;
      j++;
    }
  }
  return { added, updated, removed };
}

/** Apply a delta to the snapshot it was computed against. */
export function applyDelta(
  base: FullSnapshot,
  delta: SnapshotDelta,
  tick: number,
): FullSnapshot {
  const byId = new Map<number, PlayerState>();
  for (const p of base.players) byId.set(p.id, clonePlayer(p));
  for (const id of delta.removed) byId.delete(id);
  for (const patch of delta.updated) {
    const p = byId.get(patch.id);
    if (!p) continue;
    for (const [k, v] of Object.entries(patch)) {
      if (k === 'id') continue;
      (p as unknown as Record<string, unknown>)[k] = cloneVal(v);
    }
  }
  for (const p of delta.added) byId.set(p.id, clonePlayer(p));
  const players = [...byId.values()].sort((a, b) => a.id - b.id);
  return { tick, players };
}
