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
}

export interface WeaponTuning {
  damage: number;
  cooldownTicks: number;
  range: number;
  spread: number;
  pellets: number;
}

export interface Tuning {
  player: PlayerTuning;
  vehicles: Record<string, VehicleTuning>;
  weapons: Record<string, WeaponTuning>;
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

export function initTuning(raw: { player: unknown; vehicles?: unknown; weapons?: unknown }): void {
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
  current = { player: parsePlayerTuning(raw.player), vehicles, weapons };
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
