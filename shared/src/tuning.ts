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
}

export interface PedTuning {
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
  kinds: Record<'health' | 'armour' | 'ammo' | 'frenzy', PickupKindTuning>;
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
  lookAhead: number;
  turnProbe: number;
  brakeDistancePerSpeed: number;
  laneHalfWidth: number;
  decisionCadenceTicks: number;
  turnChance: number;
  spawnMinDist: number;
  spawnMaxDist: number;
  despawnDist: number;
  spawnCadenceTicks: number;
  /** Heat for dragging a driver out of their car. */
  jackHeat: number;
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
  };
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
  };
}

function parsePedTuning(raw: unknown): PedTuning {
  const r = (raw ?? {}) as Record<string, unknown>;
  const n = (k: string): number => num(r[k], `peds.${k}`);
  return {
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
    kinds[k] = { hp: num(kv['hp'], `props.${k}.hp`), radius: num(kv['radius'], `props.${k}.radius`) };
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

function parsePickupsTuning(raw: unknown): PickupsTuning {
  const r = (raw ?? {}) as Record<string, unknown>;
  const kindsRaw = (r['kinds'] ?? {}) as Record<string, unknown>;
  const kinds = {} as PickupsTuning['kinds'];
  for (const k of ['health', 'armour', 'ammo', 'frenzy'] as const) {
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
  },
  spacing: 34,
  frenzySeconds: 45,
  frenzyReward: 1200,
};

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
    lookAhead: n('lookAhead'),
    turnProbe: n('turnProbe'),
    brakeDistancePerSpeed: n('brakeDistancePerSpeed'),
    laneHalfWidth: n('laneHalfWidth'),
    decisionCadenceTicks: n('decisionCadenceTicks'),
    turnChance: n('turnChance'),
    spawnMinDist: n('spawnMinDist'),
    spawnMaxDist: n('spawnMaxDist'),
    despawnDist: n('despawnDist'),
    spawnCadenceTicks: n('spawnCadenceTicks'),
    jackHeat: n('jackHeat'),
  };
}

const DEFAULT_TRAFFIC: TrafficTuning = {
  count: 14,
  cruiseSpeed: 104,
  lookAhead: 44,
  turnProbe: 80,
  brakeDistancePerSpeed: 0.35,
  laneHalfWidth: 14,
  decisionCadenceTicks: 21,
  turnChance: 0.25,
  spawnMinDist: 420,
  spawnMaxDist: 760,
  despawnDist: 1100,
  spawnCadenceTicks: 12,
  jackHeat: 45,
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
};

export function initTuning(raw: {
  player: unknown;
  vehicles?: unknown;
  weapons?: unknown;
  police?: unknown;
  peds?: unknown;
  props?: unknown;
  pickups?: unknown;
  traffic?: unknown;
}): void {
  const vehiclesRaw = (raw.vehicles ?? {}) as Record<string, unknown>;
  const vehicles: Record<string, VehicleTuning> = {};
  for (const [kind, v] of Object.entries(vehiclesRaw)) {
    vehicles[kind] = parseVehicleTuning(kind, v);
  }
  const weaponsRaw = (raw.weapons ?? {}) as Record<string, unknown>;
  const weapons: Record<string, WeaponTuning> = {};
  for (const [id, w] of Object.entries(weaponsRaw)) {
    weapons[id] = parseWeaponTuning(id, w);
  }
  current = {
    player: parsePlayerTuning(raw.player),
    vehicles,
    weapons,
    police: raw.police !== undefined ? parsePoliceTuning(raw.police) : DEFAULT_POLICE,
    peds: raw.peds !== undefined ? parsePedTuning(raw.peds) : DEFAULT_PEDS,
    props: raw.props !== undefined ? parsePropsTuning(raw.props) : DEFAULT_PROPS,
    pickups: raw.pickups !== undefined ? parsePickupsTuning(raw.pickups) : DEFAULT_PICKUPS,
    traffic: raw.traffic !== undefined ? parseTrafficTuning(raw.traffic) : DEFAULT_TRAFFIC,
  };
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
