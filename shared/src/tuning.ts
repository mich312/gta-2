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
  /** Where this vehicle travels: roads collide with water, boats with land. */
  medium: 'road' | 'water';
}

export interface WeaponTuning {
  damage: number;
  cooldownTicks: number;
  range: number;
  spread: number;
  pellets: number;
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

export interface TrafficTuning {
  /** Ambient traffic cars a session spawns (capped by available lane spots). */
  count: number;
  /** Cruise speed, px/s. Kept below prop-break / run-over / ped-scare thresholds. */
  cruiseSpeed: number;
  /** Speed while turning toward a new cardinal direction, px/s. */
  turnSpeed: number;
  /** Probe distance for "does my road continue", px. */
  lookAhead: number;
  /** Longer probe used to validate a turn onto a crossing road, px. */
  turnProbe: number;
  /** Base braking distance for obstacles ahead, px. */
  brakeDistance: number;
  /** Extra braking distance per px/s of speed. */
  brakeDistancePerSpeed: number;
  /** Half-width of the "obstacle ahead" corridor, px. */
  laneHalfWidth: number;
  /** Steering gain pulling a car onto its lane centre (rad per px offset). */
  laneKeepGain: number;
  /** Ticks stuck behind an obstacle before turning away. */
  blockedTimeoutTicks: number;
  /** Ticks between optional turn decisions per car. */
  decisionCadenceTicks: number;
  /** Chance to turn at an intersection per decision opportunity. */
  turnChance: number;
  /** Ambient cruising boats a session spawns (waterfront maps only). */
  boatCount: number;
  /** Moored, stealable boats along the shore. */
  mooredBoatCount: number;
  /** Ambient boat cruise speed, px/s. */
  boatCruiseSpeed: number;
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
}

export interface Tuning {
  player: PlayerTuning;
  vehicles: Record<string, VehicleTuning>;
  weapons: Record<string, WeaponTuning>;
  police: PoliceTuning;
  peds: PedTuning;
  props: PropsTuning;
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
    medium: r['medium'] === 'water' ? 'water' : 'road',
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
    if (k === 'breakSpeed' || k === 'crashSpeedLoss') continue;
    const kv = (v ?? {}) as Record<string, unknown>;
    kinds[k] = { hp: num(kv['hp'], `props.${k}.hp`), radius: num(kv['radius'], `props.${k}.radius`) };
  }
  return {
    kinds,
    breakSpeed: num(r['breakSpeed'], 'props.breakSpeed'),
    crashSpeedLoss: num(r['crashSpeedLoss'], 'props.crashSpeedLoss'),
  };
}

function parseTrafficTuning(raw: unknown): TrafficTuning {
  const r = (raw ?? {}) as Record<string, unknown>;
  const n = (k: string): number => num(r[k], `traffic.${k}`);
  return {
    count: n('count'),
    cruiseSpeed: n('cruiseSpeed'),
    turnSpeed: n('turnSpeed'),
    lookAhead: n('lookAhead'),
    turnProbe: n('turnProbe'),
    brakeDistance: n('brakeDistance'),
    brakeDistancePerSpeed: n('brakeDistancePerSpeed'),
    laneHalfWidth: n('laneHalfWidth'),
    laneKeepGain: n('laneKeepGain'),
    blockedTimeoutTicks: n('blockedTimeoutTicks'),
    decisionCadenceTicks: n('decisionCadenceTicks'),
    turnChance: n('turnChance'),
    boatCount: r['boatCount'] === undefined ? DEFAULT_TRAFFIC.boatCount : n('boatCount'),
    mooredBoatCount:
      r['mooredBoatCount'] === undefined ? DEFAULT_TRAFFIC.mooredBoatCount : n('mooredBoatCount'),
    boatCruiseSpeed:
      r['boatCruiseSpeed'] === undefined ? DEFAULT_TRAFFIC.boatCruiseSpeed : n('boatCruiseSpeed'),
  };
}

const DEFAULT_TRAFFIC: TrafficTuning = {
  count: 30,
  cruiseSpeed: 104,
  turnSpeed: 56,
  lookAhead: 44,
  turnProbe: 80,
  brakeDistance: 30,
  brakeDistancePerSpeed: 0.35,
  laneHalfWidth: 14,
  laneKeepGain: 0.03,
  blockedTimeoutTicks: 75,
  decisionCadenceTicks: 21,
  turnChance: 0.25,
  boatCount: 8,
  mooredBoatCount: 8,
  boatCruiseSpeed: 72,
};

const DEFAULT_PROPS: PropsTuning = {
  kinds: {
    lamp: { hp: 15, radius: 4 },
    bin: { hp: 10, radius: 5 },
    fence: { hp: 25, radius: 8 },
  },
  breakSpeed: 110,
  crashSpeedLoss: 0.92,
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
  maxCopsPerPlayer: 8,
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
};

export function initTuning(raw: {
  player: unknown;
  vehicles?: unknown;
  weapons?: unknown;
  police?: unknown;
  peds?: unknown;
  props?: unknown;
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

export function getWeaponTuning(id: string): WeaponTuning | null {
  return getTuning().weapons[id] ?? null;
}
