import type { Vec2 } from '../math/vec.js';
import { vec, cloneVec } from '../math/vec.js';
import type { EntityTable } from './entities.js';
import { createTable, cloneTable } from './entities.js';
import { seedRng } from '../rng/prng.js';

export type PlayerMode = 'foot' | 'driving' | 'dead';

export interface WeaponSlot {
  weaponId: string;
  ammo: number;
}

export interface VehicleState {
  id: number;
  kind: string;
  pos: Vec2;
  heading: number;
  /** Signed forward speed (px/s); negative while reversing. */
  speed: number;
  driverId: number | null;
}

export interface PlayerState {
  id: number;
  name: string;
  pos: Vec2;
  vel: Vec2;
  aimAngle: number;
  mode: PlayerMode;
  health: number;
  vehicleId: number | null;
  /** Injected at spawn / via sim commands — never client-set. */
  weapons: WeaponSlot[];
  activeWeapon: number;
  cosmeticId: number;
  wantedLevel: number;
  respawnAtTick: number | null;
  /** Last input seq folded into this player; echoed as ackSeq in snapshots. */
  lastInputSeq: number;
  /** Edge detection for the action button (enter/exit/buy). */
  actionHeld: boolean;
}

/**
 * The deterministic simulation state. Ticks at 30 Hz, predicted on the
 * client, must be bit-identical everywhere. Deliberately NOT here: cash,
 * account inventory, unlocks, sockets — those live server-side only.
 * Vehicle/pedestrian/prop tables are added in their phases.
 */
export interface GameState {
  tick: number;
  seed: number;
  /** PRNG state; advances only inside step(). */
  rng: number;
  nextEntityId: number;
  players: EntityTable<PlayerState>;
  vehicles: EntityTable<VehicleState>;
}

export function createGameState(seed: number): GameState {
  return {
    tick: 0,
    seed,
    rng: seedRng(seed),
    nextEntityId: 1,
    players: createTable(),
    vehicles: createTable(),
  };
}

export function createVehicle(
  id: number,
  kind: string,
  pos: Vec2,
  heading: number,
): VehicleState {
  return { id, kind, pos: cloneVec(pos), heading, speed: 0, driverId: null };
}

export function cloneVehicle(v: VehicleState): VehicleState {
  return { ...v, pos: cloneVec(v.pos) };
}

export function createPlayer(id: number, name: string, pos: Vec2): PlayerState {
  return {
    id,
    name,
    pos: cloneVec(pos),
    vel: vec(),
    aimAngle: 0,
    mode: 'foot',
    health: 100,
    vehicleId: null,
    weapons: [],
    activeWeapon: -1,
    cosmeticId: 0,
    wantedLevel: 0,
    respawnAtTick: null,
    lastInputSeq: 0,
    actionHeld: false,
  };
}

export function clonePlayer(p: PlayerState): PlayerState {
  return {
    ...p,
    pos: cloneVec(p.pos),
    vel: cloneVec(p.vel),
    weapons: p.weapons.map((w) => ({ ...w })),
  };
}

export function cloneState(s: GameState): GameState {
  return {
    ...s,
    players: cloneTable(s.players, clonePlayer),
    vehicles: cloneTable(s.vehicles, cloneVehicle),
  };
}
