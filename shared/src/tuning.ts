/**
 * Tunable numbers live in JSON files under shared/data/, not in code.
 * shared/ cannot touch the filesystem (zero Node imports), so each host loads
 * the JSON its own way (server: fs at boot; client: welcome message; tests:
 * direct import) and calls initTuning() once before the first step().
 */

export interface PlayerTuning {
  walkSpeed: number;
  accel: number;
}

export interface VehicleTuning {
  accel: number;
  brake: number;
  reverseAccel: number;
  maxSpeed: number;
  maxReverseSpeed: number;
  friction: number;
  turnRate: number;
  /** Fraction of maxSpeed at which steering reaches full authority. */
  minSteerSpeedFrac: number;
  /** Speed multiplier applied on hitting a wall or another car. */
  crashDamp: number;
  enterRadius: number;
  /** Collision box half-extent (cars are boxes for tile collision). */
  halfExtent: number;
  health: number;
  /** Seconds a vehicle burns before it detonates. */
  burnSeconds: number;
  /** Seconds a burnt-out wreck sits in the road before it is cleared. */
  wreckSeconds: number;
  explosionRadius: number;
  explosionDamage: number;
  /** What this vehicle travels through. Boats float; everything else drives. */
  medium: 'land' | 'water';
  /** Damage per px/s of closing speed in a collision. */
  collisionDamagePerSpeed: number;
}

export interface WeaponTuning {
  damage: number;
  cooldownTicks: number;
  range: number;
  spread: number;
  pellets: number;
  /** Swung, not shot: no ammo, no tracer, very short reach. */
  melee: boolean;
  /** Never consumes ammo. Fists always work; that is the point of them. */
  infiniteAmmo: boolean;
  /**
   * Present on weapons that throw or launch something with a flight time
   * rather than resolving instantly along a ray. Absent = hitscan.
   */
  projectile: ProjectileTuning | null;
  /**
   * How far the shot carries as a NOISE, in px, independent of how far it
   * carries as a bullet. This is what makes a silenced pistol a mechanic
   * rather than a reskin: the cops and the crowd key off it, so the same
   * damage at a fraction of the noise is a real reason to carry one into a
   * turf you would rather not stir up. It also retroactively differentiates
   * every weapon that was already here — a shotgun wakes a street the
   * flamethrower does not.
   */
  noiseRadius: number;
  /**
   * Ticks the target is stunned for, or 0. A stunned body cannot move or
   * fire. Kept short on purpose: helplessness is the least fun state in any
   * game, so this is a tool for escaping or closing, not for winning.
   */
  stunTicks: number;
}

export interface ProjectileTuning {
  /** Muzzle speed, px/s. */
  speed: number;
  /** Ticks before it goes off on its own. A grenade's cook time. */
  fuseTicks: number;
  blastRadius: number;
  blastDamage: number;
  /** Rockets burst on contact; grenades bounce and wait out the fuse. */
  detonateOnImpact: boolean;
  /** Per-tick speed retention for thrown weapons. 1 = no drag. */
  drag: number;
}

export interface PoliceTuning {
  copsPerStar: number;
  maxCopsPerPlayer: number;
  maxCopsTotal: number;
  spawnCooldownTicks: number;
  copHealth: number;
  moveSpeed: number;
  sightRange: number;
  fireRange: number;
  weapon: string;
  spawnMinDist: number;
  spawnMaxDist: number;
  heatPerDamage: number;
  heatPerKill: number;
  heatPerTheft: number;
  /** Per loud shot within earshot of an officer. What a silencer saves you. */
  heatPerNoise: number;
  /** Setting an empty car alight. Property, so it sits between theft and murder. */
  heatPerVehicleKill: number;
  /** Setting a car alight with somebody in it. The deaths are charged separately. */
  heatPerOccupiedVehicleKill: number;
  heatPerCopKill: number;
  heatDecayPerSec: number;
  despawnTicks: number;
  /** Wanted level from which cops arrive in cars. */
  carsFromStar: number;
  /** Wanted level from which roadblocks are thrown across your path. */
  roadblocksFromStar: number;
  copCarSpeed: number;
  maxCopCars: number;
  roadblockCooldownTicks: number;
  roadblockAheadDist: number;
  /** Officers leave the cruiser and finish on foot inside this range. */
  dismountDist: number;
  /** Price of a respray, which clears heat outright. */
  sprayCost: number;
  /** Reach of an arrest. An officer this close can put hands on you. */
  bustRadius: number;
  /** Move faster than this and you get shot instead of nicked. */
  bustSpeedMax: number;
  /**
   * Which force turns out at each wanted level, indexed by star - 1.
   * Escalation changes the KIND of opposition, not merely the count: the
   * distinction the 1999 game made and the 1997 one did not.
   */
  tiers: string[];
  kinds: Record<string, { health: number; weapon: string; moveSpeed: number }>;
}

export interface PedTuning {
  /**
   * One in this many "kills" leaves somebody down but alive instead. It is
   * what makes the ambulance a job rather than a delivery minigame — and in
   * a shared city, one player's hit-and-run is another player's fare.
   */
  downOneIn: number;
  /** How long they last on the pavement before it stops being a rescue. */
  bleedOutSec: number;
  walkSpeed: number;
  fleeSpeed: number;
  health: number;
  turnMinTicks: number;
  turnMaxTicks: number;
  fleeRadius: number;
  fleeTicks: number;
  heatPerPedKill: number;
}

export interface PropKindTuning {
  hp: number;
  radius: number;
  /**
   * Present only on props that go off when they break. Absent on ordinary
   * street furniture, which is what keeps "does this explode?" a property of
   * the data rather than a list of kinds hardcoded in the sim.
   */
  blast?: { radius: number; damage: number };
}

export interface PropsTuning {
  kinds: Record<string, PropKindTuning>;
  /** Vehicles at or above this speed smash props they touch. */
  breakSpeed: number;
  /** Speed multiplier applied to the car per prop smashed. */
  crashSpeedLoss: number;
  /** Seconds a smashed prop stays broken before it is repaired. */
  respawnDelaySec: number;
  /** No prop is repaired within this many px of a living player. */
  respawnMinDistFromPlayer: number;
}

export interface PickupKindTuning {
  value: number;
  respawnSec: number;
}

export interface PickupsTuning {
  /** Collection radius, px. */
  radius: number;
  maxHealth: number;
  maxArmour: number;
  kinds: Record<string, PickupKindTuning>;
  /** Roughly one pickup per N eligible open tiles, at worldgen time. */
  spacing: number;
  /** How long a kill frenzy runs. */
  frenzySeconds: number;
  /** Payout for completing one. */
  frenzyReward: number;
}

export interface TrafficTuning {
  /** Target ambient cars near players, not across the whole map. */
  count: number;
  cruiseSpeed: number;
  /** Speed a driver slows to for a corner. */
  turnSpeed: number;
  /** How far down the lane a driver aims. This sets the turn radius. */
  lookAhead: number;
  /** Standing gap kept behind whatever is in front, px. */
  brakeDistance: number;
  /** Extra gap per px/s of speed. */
  brakeDistancePerSpeed: number;
  /** Wheel per radian of heading error, before clamping to full lock. */
  steerGain: number;
  /**
   * Intelligent Driver Model parameters — see `sim/traffic.ts`. Together these
   * replace the old "is anything in the way? then brake" rule with a
   * continuous acceleration, which is what makes a queue a queue rather than a
   * row of cars taking turns to stamp on the pedals.
   */
  /** s0: gap a driver keeps from the car in front at a standstill, px. */
  minGap: number;
  /** T: gap a driver keeps in TIME when moving, seconds. */
  timeHeadway: number;
  /** a: acceleration a driver is comfortable with, px/s^2. */
  comfortAccel: number;
  /** b: deceleration a driver is comfortable with, px/s^2. Not a panic stop. */
  comfortBrake: number;
  /** How far ahead a driver looks for whatever it is following, px. */
  scanHorizon: number;
  /** Wedged sim ticks a driver tolerates before backing out (30 = 1 s). */
  blockedTimeoutTicks: number;
  /** How long that reverse lasts, in sim ticks. Bounded on purpose. */
  reverseTicks: number;
  decisionCadenceTicks: number;
  turnChance: number;
  /**
   * Traffic-signal timing. Declared here rather than imported from
   * sim/signals.ts because this file deliberately imports nothing at all —
   * TypeScript is structural, so the two shapes satisfy each other.
   */
  /** How close a pedestrian has to be to a parked car to get into it. */
  boardRadius: number;
  /** Odds per tick that SOMEBODY in the city gets in, at most one. */
  boardChance: number;
  /** Ticks an ambient driver stays at the wheel before parking and walking off. */
  tripTicks: number;
  /** Ticks blocked by a PERSON before a driver sounds the horn about it. */
  hornAfterTicks: number;
  signals: {
    greenTicks: number;
    amberTicks: number;
    junctionOffsetTicks: number;
    lookaheadPx: number;
  };
  /** What a panicked driver accelerates to on the straight, px/s. */
  panicSpeed: number;
  /** How long a scare lasts, in sim ticks. */
  panicTicks: number;
  /** How close a gunshot or explosion has to be to scare a driver, px. */
  panicRadius: number;
  spawnMinDist: number;
  spawnMaxDist: number;
  despawnDist: number;
  spawnCadenceTicks: number;
  /** Heat for dragging a driver out of their car. */
  jackHeat: number;
  /**
   * What ambient traffic is made of. Weighted, and drawn deterministically
   * from the sim rng — a city of one car in six colours is the most visible
   * thing separating this from what it is in the genre of.
   */
  mix: Array<{ kind: string; weight: number }>;
}

export interface FittingsTuning {
  /** Seconds between arming a car bomb and the bang. */
  bombFuseSec: number;
  dropCooldownTicks: number;
  gunCooldownTicks: number;
  /** How far behind the back bumper a mine or slick lands, px. */
  dropClearance: number;
  /** How long a dropped mine or slick sits in the road. */
  dropLifeSec: number;
  mineBlastRadius: number;
  mineBlastDamage: number;
  /** Radians of heading kick a slick delivers. */
  slickSpin: number;
  /** Speed retained after hitting one. */
  slickSpeedLoss: number;
  slickRadius: number;
  mineRadius: number;
}

export interface GangDef {
  id: number;
  name: string;
  color: string;
  /** Gangs whose losses are this one's gains. Symmetric by construction. */
  rivals: number[];
}

export interface GangsTuning {
  /** Turf cell size, in tiles. Big enough that a block belongs to somebody. */
  cellTiles: number;
  /** One pedestrian in this many, on a gang's turf, is one of theirs. */
  memberEvery: number;
  /** How close a rival has to be before a gang member squares up. */
  engageRadius: number;
  /** A fight nobody wins in this long breaks off. */
  fightTimeoutTicks: number;
  /**
   * Ceiling on fights running at once, city-wide. Without it the gangs kill
   * each other off in minutes and the streets go quiet.
   */
  maxConcurrentFights: number;
  /** Fights only start on ground the shooter's gang does not hold. */
  contestedOnly: boolean;
  gangs: GangDef[];
}

export interface RespectTuning {
  /** Respect lost with a gang for killing one of their people. */
  killPenalty: number;
  /** Fraction of that which their rivals gain. Zero-sum, but not symmetric. */
  rivalShare: number;
  /** Respect earned for a job done for a gang. */
  missionFavour: number;
  hostileAt: number;
  friendlyAt: number;
  floor: number;
  ceiling: number;
  /** How often respect drifts one point back toward neutral. */
  decayEveryTicks: number;
  gangSightRange: number;
  gangFireRange: number;
  gangWeapon: string;
  gangFireCooldownTicks: number;
  gangChaseSpeed: number;
}

export interface Tuning {
  player: PlayerTuning;
  vehicles: Record<string, VehicleTuning>;
  weapons: Record<string, WeaponTuning>;
  police: PoliceTuning;
  peds: PedTuning;
  props: PropsTuning;
  pickups: PickupsTuning;
  traffic: TrafficTuning;
  fittings: FittingsTuning;
  gangs: GangsTuning;
  respect: RespectTuning;
}

let current: Tuning | null = null;

function num(v: unknown, name: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) {
    throw new Error(`tuning: ${name} must be a positive finite number`);
  }
  return v;
}

function parsePlayerTuning(raw: unknown): PlayerTuning {
  const r = (raw ?? {}) as Record<string, unknown>;
  return {
    walkSpeed: num(r['walkSpeed'], 'player.walkSpeed'),
    accel: num(r['accel'], 'player.accel'),
  };
}

function parseVehicleTuning(kind: string, raw: unknown): VehicleTuning {
  const r = (raw ?? {}) as Record<string, unknown>;
  const n = (k: string): number => num(r[k], `vehicles.${kind}.${k}`);
  return {
    accel: n('accel'),
    brake: n('brake'),
    reverseAccel: n('reverseAccel'),
    maxSpeed: n('maxSpeed'),
    maxReverseSpeed: n('maxReverseSpeed'),
    friction: n('friction'),
    turnRate: n('turnRate'),
    minSteerSpeedFrac: n('minSteerSpeedFrac'),
    crashDamp: n('crashDamp'),
    enterRadius: n('enterRadius'),
    halfExtent: n('halfExtent'),
    health: n('health'),
    burnSeconds: n('burnSeconds'),
    wreckSeconds: n('wreckSeconds'),
    explosionRadius: n('explosionRadius'),
    explosionDamage: n('explosionDamage'),
    medium: r['medium'] === 'water' ? 'water' : 'land',
    collisionDamagePerSpeed: n('collisionDamagePerSpeed'),
  };
}

function parseWeaponTuning(id: string, raw: unknown): WeaponTuning {
  const r = (raw ?? {}) as Record<string, unknown>;
  const n = (k: string): number => num(r[k], `weapons.${id}.${k}`);
  return {
    damage: n('damage'),
    cooldownTicks: n('cooldownTicks'),
    range: n('range'),
    spread: n('spread'),
    pellets: n('pellets'),
    melee: r['melee'] === true,
    infiniteAmmo: r['infiniteAmmo'] === true,
    projectile: parseProjectile(id, r['projectile']),
    // Defaulted rather than required: every weapon that existed before this
    // must still parse, and "as loud as a pistol" is the right guess for one.
    noiseRadius:
      typeof r['noiseRadius'] === 'number' && r['noiseRadius'] >= 0 ? r['noiseRadius'] : 170,
    stunTicks: typeof r['stunTicks'] === 'number' && r['stunTicks'] > 0 ? r['stunTicks'] : 0,
  };
}

function parseProjectile(id: string, raw: unknown): ProjectileTuning | null {
  if (raw === undefined || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const n = (k: string): number => num(r[k], `weapons.${id}.projectile.${k}`);
  const drag = r['drag'];
  return {
    speed: n('speed'),
    fuseTicks: n('fuseTicks'),
    blastRadius: n('blastRadius'),
    blastDamage: n('blastDamage'),
    detonateOnImpact: r['detonateOnImpact'] === true,
    drag: typeof drag === 'number' ? drag : 1,
  };
}

function parseTiers(raw: unknown): string[] {
  if (!Array.isArray(raw) || raw.length === 0) throw new Error('police: tiers must be a non-empty array');
  return raw.map((v, i) => {
    if (typeof v !== 'string' || v.length === 0) throw new Error(`police: tiers[${i}]`);
    return v;
  });
}

function parseCopKinds(raw: unknown): Record<string, { health: number; weapon: string; moveSpeed: number }> {
  if (typeof raw !== 'object' || raw === null) throw new Error('police: kinds must be an object');
  const out: Record<string, { health: number; weapon: string; moveSpeed: number }> = {};
  for (const [id, v] of Object.entries(raw as Record<string, unknown>)) {
    const r = (v ?? {}) as Record<string, unknown>;
    const weapon = r['weapon'];
    if (typeof weapon !== 'string') throw new Error(`police: kinds.${id}.weapon`);
    out[id] = {
      health: num(r['health'], `police.kinds.${id}.health`),
      weapon,
      moveSpeed: num(r['moveSpeed'], `police.kinds.${id}.moveSpeed`),
    };
  }
  return out;
}

function parsePoliceTuning(raw: unknown): PoliceTuning {
  const r = (raw ?? {}) as Record<string, unknown>;
  const n = (k: string): number => num(r[k], `police.${k}`);
  const weapon = r['weapon'];
  if (typeof weapon !== 'string') throw new Error('police.weapon must be a string');
  return {
    copsPerStar: n('copsPerStar'),
    maxCopsPerPlayer: n('maxCopsPerPlayer'),
    maxCopsTotal: n('maxCopsTotal'),
    spawnCooldownTicks: n('spawnCooldownTicks'),
    copHealth: n('copHealth'),
    moveSpeed: n('moveSpeed'),
    sightRange: n('sightRange'),
    fireRange: n('fireRange'),
    weapon,
    spawnMinDist: n('spawnMinDist'),
    spawnMaxDist: n('spawnMaxDist'),
    heatPerDamage: n('heatPerDamage'),
    heatPerKill: n('heatPerKill'),
    heatPerTheft: n('heatPerTheft'),
    heatPerNoise: n('heatPerNoise'),
    heatPerVehicleKill: n('heatPerVehicleKill'),
    heatPerOccupiedVehicleKill: n('heatPerOccupiedVehicleKill'),
    heatPerCopKill: n('heatPerCopKill'),
    heatDecayPerSec: n('heatDecayPerSec'),
    despawnTicks: n('despawnTicks'),
    carsFromStar: n('carsFromStar'),
    roadblocksFromStar: n('roadblocksFromStar'),
    copCarSpeed: n('copCarSpeed'),
    maxCopCars: n('maxCopCars'),
    roadblockCooldownTicks: n('roadblockCooldownTicks'),
    roadblockAheadDist: n('roadblockAheadDist'),
    dismountDist: n('dismountDist'),
    sprayCost: n('sprayCost'),
    bustRadius: n('bustRadius'),
    bustSpeedMax: n('bustSpeedMax'),
    tiers: parseTiers(r['tiers']),
    kinds: parseCopKinds(r['kinds']),
  };
}

function parsePedTuning(raw: unknown): PedTuning {
  const r = (raw ?? {}) as Record<string, unknown>;
  const n = (k: string): number => num(r[k], `peds.${k}`);
  return {
    downOneIn: num(r['downOneIn'], 'peds.downOneIn'),
    bleedOutSec: num(r['bleedOutSec'], 'peds.bleedOutSec'),
    walkSpeed: n('walkSpeed'),
    fleeSpeed: n('fleeSpeed'),
    health: n('health'),
    turnMinTicks: n('turnMinTicks'),
    turnMaxTicks: n('turnMaxTicks'),
    fleeRadius: n('fleeRadius'),
    fleeTicks: n('fleeTicks'),
    heatPerPedKill: n('heatPerPedKill'),
  };
}

/** Top-level props.json keys that are settings, not prop kinds. */
const PROP_SCALARS = new Set([
  'breakSpeed',
  'crashSpeedLoss',
  'respawnDelaySec',
  'respawnMinDistFromPlayer',
]);

function parsePropsTuning(raw: unknown): PropsTuning {
  const r = (raw ?? {}) as Record<string, unknown>;
  // Accept both the flat props.json file shape and the already-parsed
  // {kinds: {...}} shape (welcome messages and replay headers re-parse).
  const kindsSrc =
    typeof r['kinds'] === 'object' && r['kinds'] !== null
      ? (r['kinds'] as Record<string, unknown>)
      : r;
  const kinds: Record<string, PropKindTuning> = {};
  for (const [k, v] of Object.entries(kindsSrc)) {
    if (PROP_SCALARS.has(k)) continue;
    const kv = (v ?? {}) as Record<string, unknown>;
    const kind: PropKindTuning = {
      hp: num(kv['hp'], `props.${k}.hp`),
      radius: num(kv['radius'], `props.${k}.radius`),
    };
    const blast = kv['blast'];
    if (blast !== undefined) {
      const b = (blast ?? {}) as Record<string, unknown>;
      kind.blast = {
        radius: num(b['radius'], `props.${k}.blast.radius`),
        damage: num(b['damage'], `props.${k}.blast.damage`),
      };
    }
    kinds[k] = kind;
  }
  return {
    kinds,
    breakSpeed: num(r['breakSpeed'], 'props.breakSpeed'),
    crashSpeedLoss: num(r['crashSpeedLoss'], 'props.crashSpeedLoss'),
    respawnDelaySec: num(r['respawnDelaySec'], 'props.respawnDelaySec'),
    respawnMinDistFromPlayer: num(
      r['respawnMinDistFromPlayer'],
      'props.respawnMinDistFromPlayer',
    ),
  };
}

function parseFittingsTuning(raw: unknown): FittingsTuning {
  const r = (raw ?? {}) as Record<string, unknown>;
  const n = (k: string): number => num(r[k], `fittings.${k}`);
  return {
    bombFuseSec: n('bombFuseSec'),
    dropCooldownTicks: n('dropCooldownTicks'),
    gunCooldownTicks: n('gunCooldownTicks'),
    dropClearance: n('dropClearance'),
    dropLifeSec: n('dropLifeSec'),
    mineBlastRadius: n('mineBlastRadius'),
    mineBlastDamage: n('mineBlastDamage'),
    slickSpin: n('slickSpin'),
    slickSpeedLoss: n('slickSpeedLoss'),
    slickRadius: n('slickRadius'),
    mineRadius: n('mineRadius'),
  };
}

const DEFAULT_FITTINGS: FittingsTuning = {
  bombFuseSec: 3.5,
  dropCooldownTicks: 12,
  gunCooldownTicks: 5,
  dropClearance: 8,
  dropLifeSec: 90,
  mineBlastRadius: 78,
  mineBlastDamage: 95,
  slickSpin: 0.9,
  slickSpeedLoss: 0.55,
  slickRadius: 22,
  mineRadius: 14,
};

function parseGangsTuning(raw: unknown): GangsTuning {
  const r = (raw ?? {}) as Record<string, unknown>;
  const list = r['gangs'];
  if (!Array.isArray(list) || list.length === 0) throw new Error('gangs: gangs must be non-empty');
  return {
    cellTiles: num(r['cellTiles'], 'gangs.cellTiles'),
    memberEvery: num(r['memberEvery'], 'gangs.memberEvery'),
    engageRadius: num(r['engageRadius'], 'gangs.engageRadius'),
    fightTimeoutTicks: num(r['fightTimeoutTicks'], 'gangs.fightTimeoutTicks'),
    // A cap of zero is a coherent setting — it turns gang war off — so it
    // cannot go through `num`, which refuses zero.
    maxConcurrentFights:
      typeof r['maxConcurrentFights'] === 'number' && r['maxConcurrentFights'] >= 0
        ? r['maxConcurrentFights']
        : 8,
    contestedOnly: r['contestedOnly'] !== false,
    gangs: list.map((g, i) => {
      const gr = (g ?? {}) as Record<string, unknown>;
      const id = gr['id'];
      const name = gr['name'];
      const color = gr['color'];
      const rivals = gr['rivals'];
      if (typeof id !== 'number' || id <= 0) throw new Error(`gangs[${i}].id must be > 0`);
      if (typeof name !== 'string' || typeof color !== 'string') {
        throw new Error(`gangs[${i}] needs a name and a colour`);
      }
      if (!Array.isArray(rivals)) throw new Error(`gangs[${i}].rivals`);
      return { id, name, color, rivals: rivals.map((v) => Number(v)) };
    }),
  };
}

const DEFAULT_GANGS: GangsTuning = {
  cellTiles: 12,
  memberEvery: 4,
  engageRadius: 110,
  fightTimeoutTicks: 300,
  maxConcurrentFights: 8,
  contestedOnly: true,
  gangs: [
    { id: 1, name: 'Kessler Row', color: '#c8543c', rivals: [2, 3] },
    { id: 2, name: 'Sunnyside', color: '#4aa86a', rivals: [1, 4] },
    { id: 3, name: 'The Quay', color: '#4a7ac8', rivals: [1, 4] },
    { id: 4, name: 'Halloran', color: '#a86ac8', rivals: [2, 3] },
  ],
};

function parseRespectTuning(raw: unknown): RespectTuning {
  const r = (raw ?? {}) as Record<string, unknown>;
  const n = (k: string): number => {
    const v = r[k];
    if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`respect.${k}`);
    return v;
  };
  const weapon = r['gangWeapon'];
  if (typeof weapon !== 'string') throw new Error('respect.gangWeapon');
  return {
    killPenalty: n('killPenalty'),
    rivalShare: n('rivalShare'),
    missionFavour: n('missionFavour'),
    hostileAt: n('hostileAt'),
    friendlyAt: n('friendlyAt'),
    floor: n('floor'),
    ceiling: n('ceiling'),
    decayEveryTicks: n('decayEveryTicks'),
    gangSightRange: n('gangSightRange'),
    gangFireRange: n('gangFireRange'),
    gangWeapon: weapon,
    gangFireCooldownTicks: n('gangFireCooldownTicks'),
    gangChaseSpeed: n('gangChaseSpeed'),
  };
}

const DEFAULT_RESPECT: RespectTuning = {
  killPenalty: 8,
  rivalShare: 0.5,
  missionFavour: 20,
  hostileAt: -20,
  friendlyAt: 25,
  floor: -60,
  ceiling: 60,
  decayEveryTicks: 600,
  gangSightRange: 220,
  gangFireRange: 190,
  gangWeapon: 'gangPistol',
  gangFireCooldownTicks: 26,
  gangChaseSpeed: 96,
};

function parsePickupsTuning(raw: unknown): PickupsTuning {
  const r = (raw ?? {}) as Record<string, unknown>;
  const kindsRaw = (r['kinds'] ?? {}) as Record<string, unknown>;
  const kinds = {} as PickupsTuning['kinds'];
  for (const k of ['health', 'armour', 'ammo', 'frenzy', 'bribe', 'jailcard', 'damage', 'invis', 'reload'] as const) {
    const kv = (kindsRaw[k] ?? {}) as Record<string, unknown>;
    kinds[k] = {
      value: num(kv['value'], `pickups.${k}.value`),
      respawnSec: num(kv['respawnSec'], `pickups.${k}.respawnSec`),
    };
  }
  return {
    radius: num(r['radius'], 'pickups.radius'),
    maxHealth: num(r['maxHealth'], 'pickups.maxHealth'),
    maxArmour: num(r['maxArmour'], 'pickups.maxArmour'),
    kinds,
    spacing: num(r['spacing'], 'pickups.spacing'),
    frenzySeconds: num(r['frenzySeconds'], 'pickups.frenzySeconds'),
    frenzyReward: num(r['frenzyReward'], 'pickups.frenzyReward'),
  };
}

const DEFAULT_PICKUPS: PickupsTuning = {
  radius: 11,
  maxHealth: 100,
  maxArmour: 100,
  kinds: {
    health: { value: 40, respawnSec: 30 },
    armour: { value: 50, respawnSec: 50 },
    ammo: { value: 45, respawnSec: 25 },
    frenzy: { value: 12, respawnSec: 120 },
    bribe: { value: 1, respawnSec: 90 },
    jailcard: { value: 1, respawnSec: 120 },
    damage: { value: 20, respawnSec: 100 },
    invis: { value: 15, respawnSec: 110 },
    reload: { value: 25, respawnSec: 80 },
  },
  spacing: 34,
  frenzySeconds: 45,
  frenzyReward: 1200,
};

function parseMix(raw: unknown): Array<{ kind: string; weight: number }> {
  if (!Array.isArray(raw) || raw.length === 0) return [{ kind: 'car', weight: 1 }];
  return raw.map((v, i) => {
    const r = (v ?? {}) as Record<string, unknown>;
    const kind = r['kind'];
    if (typeof kind !== 'string') throw new Error(`traffic: mix[${i}].kind`);
    return { kind, weight: num(r['weight'], `traffic.mix[${i}].weight`) };
  });
}

function parseSignals(raw: unknown): TrafficTuning['signals'] {
  const r = (raw ?? {}) as Record<string, unknown>;
  const n = (k: string): number => num(r[k], `traffic.signals.${k}`);
  const timing = {
    greenTicks: n('greenTicks'),
    amberTicks: n('amberTicks'),
    junctionOffsetTicks: n('junctionOffsetTicks'),
    lookaheadPx: n('lookaheadPx'),
  };
  // `num` already refuses zero and negatives — the same guard that caught a
  // `damage: 0` weapon once. Both counts are genuinely positive: a zero green
  // is a junction nothing ever gets through, and a zero amber is a light that
  // turns red under a committed car.
  return timing;
}

function parseTrafficTuning(raw: unknown): TrafficTuning {
  const r = (raw ?? {}) as Record<string, unknown>;
  const n = (k: string): number => num(r[k], `traffic.${k}`);
  // count may legitimately be zero: a server (or a test) can ask for a city
  // with no ambient traffic at all, the same way PED_COUNT=0 is allowed.
  const count = r['count'];
  if (typeof count !== 'number' || !Number.isFinite(count) || count < 0) {
    throw new Error('tuning: traffic.count must be a non-negative finite number');
  }
  return {
    count,
    cruiseSpeed: n('cruiseSpeed'),
    turnSpeed: n('turnSpeed'),
    lookAhead: n('lookAhead'),
    brakeDistance: n('brakeDistance'),
    brakeDistancePerSpeed: n('brakeDistancePerSpeed'),
    steerGain: n('steerGain'),
    minGap: n('minGap'),
    timeHeadway: n('timeHeadway'),
    comfortAccel: n('comfortAccel'),
    comfortBrake: n('comfortBrake'),
    scanHorizon: n('scanHorizon'),
    blockedTimeoutTicks: n('blockedTimeoutTicks'),
    reverseTicks: n('reverseTicks'),
    decisionCadenceTicks: n('decisionCadenceTicks'),
    turnChance: n('turnChance'),
    boardRadius: n('boardRadius'),
    boardChance: n('boardChance'),
    tripTicks: n('tripTicks'),
    hornAfterTicks: n('hornAfterTicks'),
    signals: parseSignals(r['signals']),
    panicSpeed: n('panicSpeed'),
    panicTicks: n('panicTicks'),
    panicRadius: n('panicRadius'),
    spawnMinDist: n('spawnMinDist'),
    spawnMaxDist: n('spawnMaxDist'),
    despawnDist: n('despawnDist'),
    spawnCadenceTicks: n('spawnCadenceTicks'),
    jackHeat: n('jackHeat'),
    mix: parseMix(r['mix']),
  };
}

/** Movement fallback, matching `shared/data/player.json`. */
const DEFAULT_PLAYER: PlayerTuning = { walkSpeed: 78, accel: 540 };

const DEFAULT_TRAFFIC: TrafficTuning = {
  count: 14,
  cruiseSpeed: 104,
  turnSpeed: 30,
  lookAhead: 12,
  brakeDistance: 8,
  brakeDistancePerSpeed: 0.22,
  steerGain: 4.5,
  minGap: 6,
  timeHeadway: 1.1,
  comfortAccel: 90,
  comfortBrake: 130,
  scanHorizon: 120,
  blockedTimeoutTicks: 90,
  reverseTicks: 30,
  decisionCadenceTicks: 21,
  turnChance: 0.25,
  boardRadius: 40,
  boardChance: 0.05,
  tripTicks: 1800,
  hornAfterTicks: 24,
  signals: { greenTicks: 90, amberTicks: 24, junctionOffsetTicks: 37, lookaheadPx: 60 },
  panicSpeed: 150,
  panicTicks: 210,
  panicRadius: 150,
  spawnMinDist: 420,
  spawnMaxDist: 760,
  despawnDist: 1100,
  spawnCadenceTicks: 12,
  jackHeat: 45,
  mix: [{ kind: 'car', weight: 1 }],
};

const DEFAULT_PROPS: PropsTuning = {
  kinds: {
    lamp: { hp: 15, radius: 4 },
    bin: { hp: 10, radius: 5 },
    fence: { hp: 25, radius: 8 },
  },
  breakSpeed: 110,
  crashSpeedLoss: 0.92,
  respawnDelaySec: 45,
  respawnMinDistFromPlayer: 260,
};

const DEFAULT_PEDS: PedTuning = {
  downOneIn: 3,
  bleedOutSec: 45,
  walkSpeed: 48,
  fleeSpeed: 116,
  health: 30,
  turnMinTicks: 40,
  turnMaxTicks: 140,
  fleeRadius: 170,
  fleeTicks: 105,
  heatPerPedKill: 80,
};

const DEFAULT_POLICE: PoliceTuning = {
  copsPerStar: 2,
  // >= copsPerStar * 5, so the fifth star fields more cops than the fourth
  // rather than clamping to the same number. Higher tiers change *kind* of
  // response, not just count, once police vehicles land (roadmap C3).
  maxCopsPerPlayer: 10,
  maxCopsTotal: 24,
  spawnCooldownTicks: 18,
  copHealth: 50,
  moveSpeed: 122,
  sightRange: 260,
  fireRange: 190,
  weapon: 'copPistol',
  spawnMinDist: 260,
  spawnMaxDist: 640,
  heatPerDamage: 0.8,
  heatPerKill: 60,
  heatPerTheft: 15,
  heatPerNoise: 3,
  heatPerVehicleKill: 40,
  heatPerOccupiedVehicleKill: 70,
  heatPerCopKill: 120,
  heatDecayPerSec: 5,
  despawnTicks: 150,
  carsFromStar: 3,
  roadblocksFromStar: 4,
  copCarSpeed: 300,
  maxCopCars: 6,
  roadblockCooldownTicks: 240,
  roadblockAheadDist: 420,
  dismountDist: 150,
  sprayCost: 400,
  bustRadius: 22,
  bustSpeedMax: 40,
  tiers: ['patrol', 'patrol', 'patrol', 'swat', 'fed', 'army'],
  kinds: {
    patrol: { health: 50, weapon: 'copPistol', moveSpeed: 73 },
    swat: { health: 90, weapon: 'copShotgun', moveSpeed: 79 },
    fed: { health: 120, weapon: 'copSmg', moveSpeed: 88 },
    army: { health: 220, weapon: 'copRifle', moveSpeed: 77 },
  },
};

export interface InitTuningOptions {
  /**
   * Fall back to the built-in defaults for any section that will not parse,
   * and report which, instead of throwing.
   *
   * The server loads these files off its own disk and should refuse to start
   * on a malformed one. The CLIENT is handed them over the wire by a server it
   * does not control, and there a single unparseable number used to throw
   * inside the welcome handler — killing the whole frame loop and leaving the
   * game sitting on "connecting…" with the reason only in the console.
   */
  lenient?: boolean;
}

/** Sections that fell back to defaults, if any. Empty when all was well. */
export function initTuning(
  raw: {
    player: unknown;
    vehicles?: unknown;
    weapons?: unknown;
    police?: unknown;
    peds?: unknown;
    props?: unknown;
    pickups?: unknown;
    traffic?: unknown;
    fittings?: unknown;
    gangs?: unknown;
    respect?: unknown;
  },
  opts: InitTuningOptions = {},
): string[] {
  const fellBack: string[] = [];
  const section = <T>(name: string, parse: () => T, fallback: T): T => {
    try {
      return parse();
    } catch (err) {
      if (!opts.lenient) throw err;
      fellBack.push(name);
      return fallback;
    }
  };

  const vehiclesRaw = (raw.vehicles ?? {}) as Record<string, unknown>;
  const vehicles: Record<string, VehicleTuning> = {};
  for (const [kind, v] of Object.entries(vehiclesRaw)) {
    const parsed = section(`vehicles.${kind}`, () => parseVehicleTuning(kind, v), null);
    if (parsed) vehicles[kind] = parsed;
  }
  const weaponsRaw = (raw.weapons ?? {}) as Record<string, unknown>;
  const weapons: Record<string, WeaponTuning> = {};
  for (const [id, w] of Object.entries(weaponsRaw)) {
    const parsed = section(`weapons.${id}`, () => parseWeaponTuning(id, w), null);
    if (parsed) weapons[id] = parsed;
  }
  current = {
    player: section('player', () => parsePlayerTuning(raw.player), DEFAULT_PLAYER),
    vehicles,
    weapons,
    police: section(
      'police',
      () => (raw.police !== undefined ? parsePoliceTuning(raw.police) : DEFAULT_POLICE),
      DEFAULT_POLICE,
    ),
    peds: section(
      'peds',
      () => (raw.peds !== undefined ? parsePedTuning(raw.peds) : DEFAULT_PEDS),
      DEFAULT_PEDS,
    ),
    props: section(
      'props',
      () => (raw.props !== undefined ? parsePropsTuning(raw.props) : DEFAULT_PROPS),
      DEFAULT_PROPS,
    ),
    pickups: section(
      'pickups',
      () => (raw.pickups !== undefined ? parsePickupsTuning(raw.pickups) : DEFAULT_PICKUPS),
      DEFAULT_PICKUPS,
    ),
    traffic: section(
      'traffic',
      () => (raw.traffic !== undefined ? parseTrafficTuning(raw.traffic) : DEFAULT_TRAFFIC),
      DEFAULT_TRAFFIC,
    ),
    fittings: section(
      'fittings',
      () => (raw.fittings !== undefined ? parseFittingsTuning(raw.fittings) : DEFAULT_FITTINGS),
      DEFAULT_FITTINGS,
    ),
    gangs: section(
      'gangs',
      () => (raw.gangs !== undefined ? parseGangsTuning(raw.gangs) : DEFAULT_GANGS),
      DEFAULT_GANGS,
    ),
    respect: section(
      'respect',
      () => (raw.respect !== undefined ? parseRespectTuning(raw.respect) : DEFAULT_RESPECT),
      DEFAULT_RESPECT,
    ),
  };
  return fellBack;
}

export function getTuning(): Tuning {
  if (!current) {
    throw new Error('tuning not initialized — call initTuning() at boot');
  }
  return current;
}

export function getVehicleTuning(kind: string): VehicleTuning {
  const t = getTuning().vehicles[kind];
  if (!t) throw new Error(`no tuning for vehicle kind '${kind}'`);
  return t;
}

export function getTrafficTuning(): TrafficTuning {
  return getTuning().traffic;
}

export function getWeaponTuning(id: string): WeaponTuning | null {
  return getTuning().weapons[id] ?? null;
}
