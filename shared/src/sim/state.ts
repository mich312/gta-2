import type { Vec2 } from '../math/vec.js';
import { vec, cloneVec, q256 } from '../math/vec.js';
import type { EntityTable } from './entities.js';
import { createTable, cloneTable } from './entities.js';
import { seedRng } from '../rng/prng.js';
import { getVehicleTuning } from '../tuning.js';

export type PlayerMode = 'foot' | 'driving' | 'dead';

export interface WeaponSlot {
  weaponId: string;
  ammo: number;
}

export interface CopState {
  id: number;
  pos: Vec2;
  vel: Vec2;
  targetId: number | null;
  health: number;
  fireCooldown: number;
  /** Ticks spent with no wanted target; despawns past the tuned limit. */
  idleTicks: number;
  /** Ticks of run-over immunity, exactly as players have — a car sitting on
   *  top of a cop must not land 30 hits a second. */
  carHitCooldown: number;
}

export interface PropState {
  id: number;
  kind: string;
  pos: Vec2;
  /** 0 horizontal, 1 vertical (fences). */
  orient: number;
  intact: boolean;
  hp: number;
  /** Tick this prop is repaired on, or null while intact. */
  respawnAtTick: number | null;
}

export type PickupKind = 'health' | 'armour' | 'ammo';

export interface PickupState {
  id: number;
  kind: PickupKind;
  pos: Vec2;
  /** False while on cooldown; the sprite is hidden and it cannot be taken. */
  active: boolean;
  /** Tick it returns on, or null while active. */
  respawnAtTick: number | null;
}

export type PedMode = 'walk' | 'flee';

export interface PedState {
  id: number;
  pos: Vec2;
  /** Unit heading the ped walks along. */
  dirX: number;
  dirY: number;
  mode: PedMode;
  health: number;
  /** Ticks until the next wander turn (walk) or until calming down (flee). */
  timer: number;
}

export type VehicleCondition = 'ok' | 'burning' | 'wreck';

export interface VehicleState {
  id: number;
  kind: string;
  pos: Vec2;
  heading: number;
  /** Signed forward speed (px/s); negative while reversing. */
  speed: number;
  driverId: number | null;
  health: number;
  condition: VehicleCondition;
  /** Tick it detonates on (burning) or despawns on (wreck); null when ok. */
  fuseAtTick: number | null;
}

export interface PlayerState {
  id: number;
  name: string;
  pos: Vec2;
  vel: Vec2;
  aimAngle: number;
  mode: PlayerMode;
  health: number;
  /** Soaks damage before health does. Bought or picked up; never regenerates. */
  armour: number;
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
  /** Ticks until the active weapon may fire again. */
  fireCooldown: number;
  /** Ticks of run-over immunity so a car doesn't grind 30 hits/s. */
  carHitCooldown: number;
  /** Police heat; wantedLevel = floor(heat/100) clamped to 5. */
  heat: number;
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
  cops: EntityTable<CopState>;
  peds: EntityTable<PedState>;
  props: EntityTable<PropState>;
  pickups: EntityTable<PickupState>;
}

export function createGameState(seed: number): GameState {
  return {
    tick: 0,
    seed,
    rng: seedRng(seed),
    nextEntityId: 1,
    players: createTable(),
    vehicles: createTable(),
    cops: createTable(),
    peds: createTable(),
    props: createTable(),
    pickups: createTable(),
  };
}

export function createPickup(id: number, kind: PickupKind, pos: Vec2): PickupState {
  return { id, kind, pos: cloneVec(pos), active: true, respawnAtTick: null };
}

export function clonePickup(p: PickupState): PickupState {
  return { ...p, pos: cloneVec(p.pos) };
}

export function createProp(
  id: number,
  kind: string,
  pos: Vec2,
  orient: number,
  hp: number,
): PropState {
  return { id, kind, pos: cloneVec(pos), orient, intact: true, hp, respawnAtTick: null };
}

export function cloneProp(p: PropState): PropState {
  return { ...p, pos: cloneVec(p.pos) };
}

export function createPed(id: number, pos: Vec2, health: number): PedState {
  return { id, pos: cloneVec(pos), dirX: 1, dirY: 0, mode: 'walk', health, timer: 0 };
}

export function clonePed(p: PedState): PedState {
  return { ...p, pos: cloneVec(p.pos) };
}

export function createCop(id: number, pos: Vec2, health: number): CopState {
  return {
    id,
    pos: cloneVec(pos),
    vel: vec(),
    targetId: null,
    health,
    fireCooldown: 0,
    idleTicks: 0,
    carHitCooldown: 0,
  };
}

export function cloneCop(c: CopState): CopState {
  return { ...c, pos: cloneVec(c.pos), vel: cloneVec(c.vel) };
}

export function createVehicle(
  id: number,
  kind: string,
  pos: Vec2,
  heading: number,
): VehicleState {
  // Quantised at birth. Steering already q256s the heading every tick, but a
  // parked car that never turns would otherwise keep the raw HALF_PI it was
  // spawned with — and the binary codec encodes headings on the q256 grid.
  return {
    id,
    kind,
    pos: cloneVec(pos),
    heading: q256(heading),
    speed: 0,
    driverId: null,
    health: getVehicleTuning(kind).health,
    condition: 'ok',
    fuseAtTick: null,
  };
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
    armour: 0,
    vehicleId: null,
    weapons: [],
    activeWeapon: -1,
    cosmeticId: 0,
    wantedLevel: 0,
    respawnAtTick: null,
    lastInputSeq: 0,
    actionHeld: false,
    fireCooldown: 0,
    carHitCooldown: 0,
    heat: 0,
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

export function wantedLevelOf(p: PlayerState): number {
  return Math.min(5, Math.floor(p.heat / 100));
}

export function addHeat(p: PlayerState, amount: number): void {
  p.heat = Math.min(599, p.heat + amount);
}

export function cloneState(s: GameState): GameState {
  return {
    ...s,
    players: cloneTable(s.players, clonePlayer),
    vehicles: cloneTable(s.vehicles, cloneVehicle),
    cops: cloneTable(s.cops, cloneCop),
    peds: cloneTable(s.peds, clonePed),
    props: cloneTable(s.props, cloneProp),
    pickups: cloneTable(s.pickups, clonePickup),
  };
}
