import type { Vec2 } from '../math/vec.js';
import { vec, cloneVec, q256 } from '../math/vec.js';
import type { EntityTable } from './entities.js';
import { createTable, cloneTable } from './entities.js';
import { seedRng } from '../rng/prng.js';
import { getVehicleTuning } from '../tuning.js';
import { newRespect } from './respect.js';

export type PlayerMode = 'foot' | 'driving' | 'dead';

export interface WeaponSlot {
  weaponId: string;
  ammo: number;
}

export interface CopState {
  id: number;
  /**
   * Which force this officer belongs to (see police.json `kinds`). Set at
   * spawn from the wanted tier and never changed: escalation fields new
   * units, it does not upgrade the ones already chasing you.
   */
  kind: string;
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
  /** Cruiser this officer is driving, or null if on foot. */
  vehicleId: number | null;
  /** Consecutive ticks a cruiser has been unable to move. */
  stuckTicks: number;
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

export type PickupKind =
  | 'health'
  | 'armour'
  | 'ammo'
  | 'frenzy'
  | 'bribe'
  | 'jailcard'
  | 'damage'
  | 'invis'
  | 'reload'
  | 'multi';

/**
 * Behaviour-altering power-ups, as bits rather than a field each.
 *
 * Five separate `somethingUntilTick: number` fields would be five slots in
 * every player diff for a state that is empty almost all the time. One
 * bitfield plus one clock is two, and it stays two however many power-ups
 * get added later.
 *
 * The timed powers are mutually exclusive on purpose: taking one replaces
 * whatever you were running. That is what lets a single clock be correct
 * rather than approximately correct. JAIL_CARD is untimed — it sits in the
 * same field and is spent by the next arrest, whenever that comes.
 */
export const POWER_DOUBLE_DAMAGE = 1;
export const POWER_INVISIBLE = 2;
export const POWER_FAST_RELOAD = 4;
export const POWER_JAIL_CARD = 8;
/** Everything the clock governs. */
export const POWER_TIMED = POWER_DOUBLE_DAMAGE | POWER_INVISIBLE | POWER_FAST_RELOAD;

export interface PickupState {
  id: number;
  kind: PickupKind;
  pos: Vec2;
  /** False while on cooldown; the sprite is hidden and it cannot be taken. */
  active: boolean;
  /** Tick it returns on, or null while active. */
  respawnAtTick: number | null;
}

/**
 * Something in flight: a rocket, a grenade, a molotov. Short-lived and few,
 * which is what makes a whole entity table affordable for them.
 */
export interface ProjectileState {
  id: number;
  /** Weapon id that threw it — its tuning owns the blast. */
  kind: string;
  pos: Vec2;
  vel: Vec2;
  /** Who owns the deaths. */
  ownerId: number;
  /** Tick it goes off on regardless of what it has hit. */
  fuseAtTick: number;
}

export type PedMode =
  | 'walk'
  | 'flee'
  /** Squaring up to the PLAYER, on their own turf. See peds.ts. */
  | 'hostile'
  /** Squaring up to a RIVAL GANG, on contested ground. See gangwar.ts. */
  | 'fighting'
  | 'downed';

export interface PedState {
  id: number;
  /**
   * Which gang this pedestrian belongs to, or 0 for a civilian. Set at spawn
   * from the turf they appear on and never changed, so it costs one byte at
   * creation and nothing thereafter.
   */
  gangId: number;
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
  /**
   * Who set it alight, or null when nobody did — a shunt in ambient traffic
   * lights cars too, and that is an accident, not a crime. Written once, at
   * ignition, and read on the far side of the fuse so the blast is credited
   * to the arsonist rather than to whoever was at the wheel. Carries down a
   * chain reaction, so burning a car park is one person's fire throughout.
   *
   * It rides the wire, which it would not have to if `takeSnapshot` projected
   * fields — it clones whole entities, so anything on a table is in the
   * snapshot whether the codec encodes it or not, and a field the codec
   * silently dropped would fail the round-trip test. The cost is near zero in
   * practice: it changes exactly once in a vehicle's life, so the delta path
   * never carries it twice.
   */
  igniterId: number | null;
  /**
   * Whose car this is, or 0 for anybody's. Set at spawn from the turf it
   * appears on and never changed — one small field, written once, that pays
   * for a livery, a place to find one, and a reason not to take it.
   */
  gangId: number;
  /**
   * What the garage bolted on: '' , 'bomb', 'slick', 'mine' or 'guns'.
   * Two fields on a table that is already on the wire, changing only when
   * you buy or use something — see FEATURES.md G2.
   */
  fitting: string;
  fittingAmmo: number;
}

/**
 * What an ambient driver remembers between ticks, keyed by vehicle id.
 *
 * Deliberately NOT part of VehicleState: no client ever simulates ambient
 * traffic, so this is the one kind of sim state that has no business on the
 * wire, in the snapshot diff, or in the desync hash. It still lives in
 * GameState — it is an input to step(), so replays and lockstep need it.
 */
export interface TrafficDriver {
  /** Cardinal direction this driver means to follow (see sim/traffic.ts). */
  dir: number;
  /**
   * Wedged-tick counter. Counts UP while the car cannot move, then runs down
   * from a negative value while it reverses out. Bounded either way, which is
   * what stops a blocked car from reversing away across the city.
   */
  stuck: number;
  /**
   * Ticks of panic left, 0 when calm. Set by gunfire and explosions nearby
   * (see stepTrafficPanic); while it runs the driver floors it away from the
   * scare and stops making leisurely route decisions.
   */
  panic: number;
  /**
   * What this driver is doing with its day. 'cruise' is ambient circulation —
   * the random walk that makes streets read as inhabited. 'goto' follows a
   * planned route to a destination, then reverts to cruise on arrival. The
   * genre's other two car missions already live elsewhere: pursuit is the
   * police system, and flight is `panic` above.
   */
  mission: 'cruise' | 'goto';
  /**
   * The goto route: corner points, flat [x0,y0, x1,y1, ...] px, last pair =
   * destination (see roadgrid.planRoute). Null whenever mission is 'cruise'.
   */
  route: number[] | null;
  /** Offset of the corner currently being driven at. Always even. */
  routeIdx: number;
  /**
   * Ticks this driver has been at the wheel. Past `traffic.tripTicks` they
   * look for a kerb, park, and get out as a pedestrian — the other half of
   * somebody getting in. Off the wire like the rest of this record.
   */
  trip: number;
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
  /** Ditto for the horn: a held key is one press, not thirty a second. */
  hornHeld: boolean;
  /** Ticks until the active weapon may fire again. */
  fireCooldown: number;
  /** Ticks of run-over immunity so a car doesn't grind 30 hits/s. */
  carHitCooldown: number;
  /** Police heat; wantedLevel = floor(heat/100) clamped to 5. */
  heat: number;
  /** Kills still needed to complete a frenzy, or 0 when not running. */
  frenzyTarget: number;
  frenzyKills: number;
  /** Tick the frenzy expires on, or null. */
  frenzyEndsAtTick: number | null;
  /** Vertical position and velocity — nonzero only mid-stunt. */
  z: number;
  vz: number;
  /** Longest airborne distance of the current jump, px. */
  airDist: number;
  /** Ticks until the car's fitting may be used again. */
  fittingCooldown: number;
  /**
   * Where you stand with each gang, indexed by gang id - 1. Sim state,
   * because gang AI reads it every tick — see sim/respect.ts.
   */
  respect: number[];
  /** Active power-ups; see the POWER_* bits. */
  powerFlags: number;
  /** Tick the timed powers lapse on. Meaningless when no timed bit is set. */
  powerUntilTick: number;
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
  projectiles: EntityTable<ProjectileState>;
  /** Ambient-AI bookkeeping, per vehicle id. Never leaves the server. */
  trafficDrivers: Record<number, TrafficDriver>;
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
    projectiles: createTable(),
    trafficDrivers: {},
  };
}

export function createPickup(id: number, kind: PickupKind, pos: Vec2): PickupState {
  return { id, kind, pos: cloneVec(pos), active: true, respawnAtTick: null };
}

export function clonePickup(p: PickupState): PickupState {
  return { ...p, pos: cloneVec(p.pos) };
}

export function createProjectile(
  id: number,
  kind: string,
  pos: Vec2,
  vel: Vec2,
  ownerId: number,
  fuseAtTick: number,
): ProjectileState {
  return { id, kind, pos: cloneVec(pos), vel: cloneVec(vel), ownerId, fuseAtTick };
}

export function cloneProjectile(p: ProjectileState): ProjectileState {
  return { ...p, pos: cloneVec(p.pos), vel: cloneVec(p.vel) };
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

export function createPed(id: number, pos: Vec2, health: number, gangId = 0): PedState {
  return { id, gangId, pos: cloneVec(pos), dirX: 1, dirY: 0, mode: 'walk', health, timer: 0 };
}

export function clonePed(p: PedState): PedState {
  return { ...p, pos: cloneVec(p.pos) };
}

export function createCop(id: number, pos: Vec2, health: number, kind = 'patrol'): CopState {
  return {
    id,
    kind,
    pos: cloneVec(pos),
    vel: vec(),
    targetId: null,
    health,
    fireCooldown: 0,
    idleTicks: 0,
    carHitCooldown: 0,
    vehicleId: null,
    stuckTicks: 0,
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
  gangId = 0,
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
    igniterId: null,
    gangId,
    // A tank is not special-cased anywhere: it is a chassis that comes out of
    // the yard with the guns the garage already sells, and effectively
    // limitless belts. If that ever needs its own code path, the fittings
    // system (FEATURES.md G2) was not built generally enough.
    fitting: kind === 'tank' ? 'guns' : '',
    fittingAmmo: kind === 'tank' ? 9999 : 0,
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
    hornHeld: false,
    fireCooldown: 0,
    carHitCooldown: 0,
    heat: 0,
    frenzyTarget: 0,
    frenzyKills: 0,
    frenzyEndsAtTick: null,
    z: 0,
    vz: 0,
    airDist: 0,
    fittingCooldown: 0,
    respect: newRespect(),
    powerFlags: 0,
    powerUntilTick: 0,
  };
}

export function clonePlayer(p: PlayerState): PlayerState {
  return {
    ...p,
    pos: cloneVec(p.pos),
    vel: cloneVec(p.vel),
    weapons: p.weapons.map((w) => ({ ...w })),
    respect: p.respect.slice(),
  };
}

/**
 * Six levels, not five: the top two exist so the ladder has somewhere to put
 * the federal and army tiers (police.json `tiers`).
 */
export function wantedLevelOf(p: PlayerState): number {
  return Math.min(6, Math.floor(p.heat / 100));
}

export function addHeat(p: PlayerState, amount: number): void {
  p.heat = Math.min(699, p.heat + amount);
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
    projectiles: cloneTable(s.projectiles, cloneProjectile),
    trafficDrivers: cloneTrafficDrivers(s.trafficDrivers),
  };
}

function cloneTrafficDrivers(
  src: Record<number, TrafficDriver>,
): Record<number, TrafficDriver> {
  const out: Record<number, TrafficDriver> = {};
  // Integer-like keys iterate in ascending numeric order, so this is stable.
  for (const key of Object.keys(src)) {
    const id = Number(key);
    const d = src[id];
    if (d) {
      out[id] = {
        dir: d.dir,
        stuck: d.stuck,
        panic: d.panic,
        mission: d.mission,
        route: d.route ? d.route.slice() : null,
        routeIdx: d.routeIdx,
        trip: d.trip,
      };
    }
  }
  return out;
}
