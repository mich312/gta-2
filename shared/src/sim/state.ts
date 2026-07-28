import type { Vec2 } from '../math/vec.js';
import { vec, cloneVec, q256 } from '../math/vec.js';
import type { EntityTable } from './entities.js';
import { createTable, cloneTable } from './entities.js';
import { seedRng } from '../rng/prng.js';
import { getVehicleTuning } from '../tuning.js';
import { newRespect } from './respect.js';
import type { VehicleTrail } from './rewind.js';

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
  /**
   * Where the target was last actually SEEN.
   *
   * The fields that make an officer capable of losing you. Before them every
   * pursuer read `target.pos` on every tick whether or not there was a
   * building in the way, so nobody in the force could be given the slip and
   * the wanted level could never come down — see GTA.md P1. An officer out
   * of contact steers at this point instead, searches around it, and gives
   * up when `searchTicks` runs out.
   *
   * `searchTicks` is 0 while in contact, so an officer who has you in view
   * costs nothing extra on the wire: a field that does not change is not
   * sent, and the whole of a normal chase is the unchanged case.
   */
  lastSeenX: number;
  lastSeenY: number;
  searchTicks: number;
  /**
   * Which way this officer is casting about, as a cardinal index (0-3), or
   * -1 while they are still walking to the last-seen point. Held between
   * ticks so a search reads as sweeping a street rather than as jitter.
   */
  searchDir: number;
  /**
   * Rounds left in the current burst. 0 means the next shot starts one.
   *
   * A flat cooldown made an officer's peak damage and sustained damage the
   * same number, which is how ten federal agents came to delete a
   * full-health player in under half a second. See police.json `burstCount`.
   */
  burstLeft: number;
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
  | 'multi'
  | 'cash'
  /**
   * A gun lying where its owner fell. Unlike every other kind this one is not
   * worldgen furniture: it is created when somebody armed dies, it does not
   * come back when taken, and it rots off the street on a timer.
   */
  | 'weapon';

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
/**
 * Stunned by an electro round: cannot move, cannot fire, waits it out.
 *
 * It lives in the power-up bitfield rather than in a field of its own —
 * invariant 10 from FEATURES.md, batch the clocks — and it is deliberately
 * NOT one of POWER_TIMED, because taking a power-up must not cure a stun and
 * being stunned must not cancel your double damage. It has its own short
 * clock in `stunnedUntilTick`.
 */
export const POWER_STUNNED = 16;
/** Everything the clock governs. */
export const POWER_TIMED = POWER_DOUBLE_DAMAGE | POWER_INVISIBLE | POWER_FAST_RELOAD;

/**
 * Ceiling on `PlayerState.unseenTicks`.
 *
 * The counter answers "have they been out of sight long enough" and "how fast
 * is the heat coming off now" (police.ts). The second saturates once the
 * ramped decay rate hits `heatDecayMax` — about 42 s at the shipped numbers —
 * and the heat is long gone by then, so counting past a minute measures
 * nothing anybody reads. It is a wire cost, not a sim cost: every increment
 * is a player-table delta.
 */
export const UNSEEN_CAP = 30 * 60;

export interface PickupState {
  id: number;
  kind: PickupKind;
  pos: Vec2;
  /** False while on cooldown; the sprite is hidden and it cannot be taken. */
  active: boolean;
  /**
   * Tick it returns on, or null while active — except on a dropped `weapon`,
   * where it is the tick the gun rots off the street. A dropped gun never
   * comes back, so the field would otherwise be dead weight on the one kind
   * of pickup that needs a clock most.
   */
  respawnAtTick: number | null;
  /** Which gun, on a `weapon` pickup. Empty on every other kind. */
  weaponId: string;
  /** Rounds it comes with, on a `weapon` pickup. Zero on every other kind. */
  ammo: number;
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
  /** Tagging along behind a player, because a mission said so. See peds.ts. */
  | 'following'
  /** Bleeding out, and an ambulance may or may not arrive. See ambulance.ts. */
  | 'downed'
  /** A body on the pavement, for `corpseSec`. */
  | 'dead';

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
  /**
   * Ticks until the next wander turn (walk), until calming down (flee), until
   * the next shot (hostile), until they bleed out (downed) or until the body
   * is cleared away (dead). One counter, five meanings — 200 pedestrians pay
   * for every field, and no two of those modes ever need it at once.
   */
  timer: number;
  /**
   * Who this pedestrian is following, or null. Set by a mission command and
   * cleared when the job ends; one nullable id on one ped at a time, which is
   * the cheapest way to have somebody to protect.
   */
  escortOf: number | null;
  /**
   * Who this one is shooting at, or null. Only ever a player id: a grudge is
   * something you hold against somebody who shot you, and the only shooters
   * a pedestrian can tell apart are players.
   */
  targetId: number | null;
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
   * How many neighbours this car has already set alight. Bounded by
   * `fire.spreadBudget`, which is what stops one molotov taking the city.
   */
  spreadUsed: number;
  /**
   * Whose car this is, or 0 for anybody's. Set at spawn from the turf it
   * appears on and never changed — one small field, written once, that pays
   * for a livery, a place to find one, and a reason not to take it.
   */
  gangId: number;
  /**
   * Damage accumulated per body zone: [front, right, rear, left], 0-255 each.
   *
   * `health` says how close the car is to burning; this says WHERE it has been
   * hit, which is what everything legible about damage derives from — which
   * lamp shattered, which door is hanging off, which corner is dented, which
   * way it pulls. Four bytes, per-field diffed, so an untouched car pays
   * nothing for it.
   */
  zones: number[];
  /** One bit per broken component; see the PART_* flags in vehicleDamage.ts. */
  broken: number;
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
   * planned route to a destination, then reverts to cruise on arrival.
   * 'tend' is parked with the engine running: the driver has arrived at
   * something and is busy with it, and whatever set the errand will release
   * them. The genre's other two car missions already live elsewhere: pursuit
   * is the police system, and flight is `panic` above.
   */
  mission: 'cruise' | 'goto' | 'tend';
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

/**
 * An ambulance that has been sent to somebody, keyed by the vehicle carrying
 * it. Sim state that never leaves the server, for exactly the reason
 * `trafficDrivers` does not: no client simulates the ambulance service, so
 * this has no business in the snapshot diff or the desync hash. What a client
 * sees is a van driving up, stopping, and a casualty getting to their feet.
 */
export interface AmbulanceCall {
  /** The casualty being answered. */
  pedId: number;
  /** Ticks of treatment left. Counts down only once they are on scene. */
  treat: number;
  /** Closest the van has got to the scene so far, px. */
  best: number;
  /** Ticks since that improved. A wedged van has to be given up on. */
  stall: number;
  /**
   * Zero on a live call. Positive on a spent one: the attempt failed and the
   * record is kept, counting down, purely so neither this van nor this
   * casualty is picked again while the van drives itself out of whatever it
   * was wedged in.
   */
  cooldown: number;
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
  /**
   * Consecutive ticks with no officer on their feet holding line of sight.
   *
   * The cool-down clock. Heat decays once this passes `wantedCooldownTicks`
   * and not before, which is a different rule from the one it replaced — the
   * old test was "does anybody see you RIGHT NOW", and since the spawner
   * answers a wanted level by placing fresh officers 260 px away, the answer
   * was almost always yes. See GTA.md P1b.
   *
   * A counter that resets rather than a tick stamp, deliberately: it is 0 and
   * *stays* 0 for the whole of a chase, so the commonest case costs nothing
   * on the wire — a field that does not change is not sent. It counts only
   * while you are getting away, which is exactly when the HUD wants it, and
   * it stops at `UNSEEN_CAP` so a quiet player is not paying a byte a tick
   * for ever.
   */
  unseenTicks: number;
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
  /** Tick a stun lifts on. Its own clock: see POWER_STUNNED. */
  stunnedUntilTick: number;
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
  /**
   * Tick each vehicle last took collision damage, per vehicle id.
   *
   * Sim state that never leaves the server, for the same reason as
   * `trafficDrivers`: no client ever runs the damage path, so it has no
   * business in the snapshot diff or the desync hash. It exists so that two
   * vehicles wedged against each other are hurt once per contact rather than
   * once per tick — without it, quadrupling the collision coefficient turns
   * leaning on a parked car into an execution.
   */
  vehicleHitTick: Record<number, number>;
  /** Ambulances currently answering a casualty, per vehicle id. Server-only. */
  ambulanceCalls: Record<number, AmbulanceCall>;
  /**
   * Where every vehicle was on each of the last few ticks, newest first.
   *
   * Server-only sim state, for the same reason as `trafficDrivers` and
   * `vehicleHitTick`: no client runs it, so it has no business in the
   * snapshot diff or the desync hash. It exists so a client's collisions can
   * be judged against the world that client could actually SEE — see
   * `rewind.ts`.
   */
  vehicleTrail: VehicleTrail;
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
    vehicleHitTick: {},
    ambulanceCalls: {},
    vehicleTrail: [],
  };
}

export function createPickup(
  id: number,
  kind: PickupKind,
  pos: Vec2,
  weaponId = '',
  ammo = 0,
): PickupState {
  return { id, kind, pos: cloneVec(pos), active: true, respawnAtTick: null, weaponId, ammo };
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
  return {
    id,
    gangId,
    pos: cloneVec(pos),
    dirX: 1,
    dirY: 0,
    mode: 'walk',
    health,
    timer: 0,
    escortOf: null,
    targetId: null,
  };
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
    lastSeenX: 0,
    lastSeenY: 0,
    searchTicks: 0,
    searchDir: -1,
    burstLeft: 0,
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
    spreadUsed: 0,
    gangId,
    zones: [0, 0, 0, 0],
    broken: 0,
    // A tank is not special-cased anywhere: it is a chassis that comes out of
    // the yard with the guns the garage already sells, and effectively
    // limitless belts. If that ever needs its own code path, the fittings
    // system (FEATURES.md G2) was not built generally enough.
    fitting: kind === 'tank' ? 'guns' : '',
    fittingAmmo: kind === 'tank' ? 9999 : 0,
  };
}

export function cloneVehicle(v: VehicleState): VehicleState {
  // `zones` must be copied, not aliased: the spread would hand every clone of
  // the state the same array, and cloneState is what makes step() pure.
  return { ...v, pos: cloneVec(v.pos), zones: v.zones.slice() };
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
    // Clear, but not "clean for ten minutes": the ramp measures time since
    // the last offence or sighting, and starting it saturated would have a
    // brand-new player shedding heat at the maximum rate on their first tick.
    unseenTicks: 0,
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
    stunnedUntilTick: 0,
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
  // A fresh offence restarts the cool-down clock, exactly as being seen does.
  //
  // The clock measures "how long since the police last had anything on you",
  // and a crime committed thirty seconds into a clean run is something on
  // you whether or not anybody was looking. Without this the ramp keeps
  // accelerating straight through a spree — heat came off faster than a
  // pistol could put it on, and it was possible to shoot people all afternoon
  // without ever reaching one star.
  //
  // Cheap, because this is already the one chokepoint every crime goes
  // through: theft, arson, noise, damage, kills and cop kills all land here.
  p.unseenTicks = 0;
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
    vehicleHitTick: { ...s.vehicleHitTick },
    ambulanceCalls: cloneAmbulanceCalls(s.ambulanceCalls),
    // Frames are written once and never mutated, so the array of references
    // is the whole clone.
    vehicleTrail: s.vehicleTrail.slice(),
  };
}

function cloneAmbulanceCalls(
  src: Record<number, AmbulanceCall>,
): Record<number, AmbulanceCall> {
  const out: Record<number, AmbulanceCall> = {};
  // Integer-like keys iterate in ascending numeric order, so this is stable.
  for (const key of Object.keys(src)) {
    const id = Number(key);
    const call = src[id];
    if (call) {
      out[id] = {
        pedId: call.pedId,
        treat: call.treat,
        best: call.best,
        stall: call.stall,
        cooldown: call.cooldown,
      };
    }
  }
  return out;
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
