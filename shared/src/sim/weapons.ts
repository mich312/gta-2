import { PLAYER_RADIUS, TICK_RATE } from '../constants.js';
import { q8 } from '../math/vec.js';
import { dCos, dSin } from '../math/trig.js';
import { nextFloat01 } from '../rng/prng.js';
import { getTuning, getVehicleTuning, getWeaponTuning } from '../tuning.js';
import type { CopState, GameState, PedState, PlayerState, PropState } from './state.js';
import { addHeat } from './state.js';
import { removeEntity } from './entities.js';
import { damagePed } from './peds.js';
import type { InputIntent } from './input.js';
import type { SimEvent } from './events.js';
import { TILE_SIZE, type CityMap } from '../world/types.js';
import { isShotBlockingTile } from '../world/collide.js';

export const RESPAWN_DELAY_TICKS = TICK_RATE * 3;
const RUNOVER_MIN_SPEED = 130;
const RUNOVER_IMMUNITY_TICKS = 12;

/** Distance along a ray until it enters a solid tile (DDA; exact ops). */
export function rayWallDistance(
  map: CityMap,
  x: number,
  y: number,
  dirX: number,
  dirY: number,
  maxDist: number,
): number {
  let tx = Math.floor(x / TILE_SIZE);
  let ty = Math.floor(y / TILE_SIZE);
  const stepX = dirX > 0 ? 1 : -1;
  const stepY = dirY > 0 ? 1 : -1;
  const tDeltaX = dirX !== 0 ? Math.abs(TILE_SIZE / dirX) : Infinity;
  const tDeltaY = dirY !== 0 ? Math.abs(TILE_SIZE / dirY) : Infinity;
  let tMaxX =
    dirX !== 0
      ? Math.abs(((dirX > 0 ? (tx + 1) * TILE_SIZE : tx * TILE_SIZE) - x) / dirX)
      : Infinity;
  let tMaxY =
    dirY !== 0
      ? Math.abs(((dirY > 0 ? (ty + 1) * TILE_SIZE : ty * TILE_SIZE) - y) / dirY)
      : Infinity;
  if (isShotBlockingTile(map, tx, ty)) return 0;
  for (;;) {
    if (tMaxX < tMaxY) {
      if (tMaxX > maxDist) return maxDist;
      tx += stepX;
      if (isShotBlockingTile(map, tx, ty)) return tMaxX;
      tMaxX += tDeltaX;
    } else {
      if (tMaxY > maxDist) return maxDist;
      ty += stepY;
      if (isShotBlockingTile(map, tx, ty)) return tMaxY;
      tMaxY += tDeltaY;
    }
  }
}

/** Ray-circle intersection distance, or Infinity. Exact ops only. */
function rayCircleDistance(
  ox: number,
  oy: number,
  dx: number,
  dy: number,
  cx: number,
  cy: number,
  r: number,
): number {
  const fx = cx - ox;
  const fy = cy - oy;
  const t = fx * dx + fy * dy;
  if (t < 0) return Infinity;
  const perp2 = fx * fx + fy * fy - t * t;
  const r2 = r * r;
  if (perp2 > r2) return Infinity;
  return t - Math.sqrt(r2 - perp2);
}

function fireOnce(
  state: GameState,
  map: CityMap,
  shooter: PlayerState,
  angle: number,
  range: number,
  damage: number,
  weaponId: string,
  events: SimEvent[],
): void {
  const dirX = dCos(angle);
  const dirY = dSin(angle);
  const wallDist = rayWallDistance(map, shooter.pos.x, shooter.pos.y, dirX, dirY, range);

  let hitPlayer: PlayerState | null = null;
  let hitCop: CopState | null = null;
  let hitPed: PedState | null = null;
  let hitProp: PropState | null = null;
  let hitDist = wallDist;
  for (const id of state.players.ids) {
    if (id === shooter.id) continue;
    const target = state.players.byId[id];
    if (!target || target.mode === 'dead') continue;
    const d = rayCircleDistance(
      shooter.pos.x,
      shooter.pos.y,
      dirX,
      dirY,
      target.pos.x,
      target.pos.y,
      PLAYER_RADIUS,
    );
    if (d < hitDist) {
      hitDist = d;
      hitPlayer = target;
    }
  }
  for (const id of state.cops.ids) {
    const cop = state.cops.byId[id];
    if (!cop) continue;
    const d = rayCircleDistance(
      shooter.pos.x,
      shooter.pos.y,
      dirX,
      dirY,
      cop.pos.x,
      cop.pos.y,
      PLAYER_RADIUS,
    );
    if (d < hitDist) {
      hitDist = d;
      hitCop = cop;
      hitPlayer = null;
    }
  }
  for (const id of state.peds.ids) {
    const ped = state.peds.byId[id];
    if (!ped) continue;
    const d = rayCircleDistance(
      shooter.pos.x,
      shooter.pos.y,
      dirX,
      dirY,
      ped.pos.x,
      ped.pos.y,
      PLAYER_RADIUS,
    );
    if (d < hitDist) {
      hitDist = d;
      hitPed = ped;
      hitCop = null;
      hitPlayer = null;
    }
  }
  const propKinds = getTuning().props.kinds;
  for (const id of state.props.ids) {
    const prop = state.props.byId[id];
    if (!prop || !prop.intact) continue;
    const radius = propKinds[prop.kind]?.radius ?? 4;
    const d = rayCircleDistance(
      shooter.pos.x,
      shooter.pos.y,
      dirX,
      dirY,
      prop.pos.x,
      prop.pos.y,
      radius,
    );
    if (d < hitDist) {
      hitDist = d;
      hitProp = prop;
      hitPed = null;
      hitCop = null;
      hitPlayer = null;
    }
  }

  events.push({
    type: 'shot',
    tick: state.tick,
    playerId: shooter.id,
    // Rounded: tracer endpoints are display-only, ints keep events small.
    x0: Math.round(shooter.pos.x),
    y0: Math.round(shooter.pos.y),
    x1: Math.round(shooter.pos.x + dirX * hitDist),
    y1: Math.round(shooter.pos.y + dirY * hitDist),
  });

  if (hitPlayer) {
    applyDamage(state, hitPlayer, damage, shooter.id, weaponId, events);
  } else if (hitCop) {
    damageCop(state, hitCop, damage, shooter.id, events);
  } else if (hitPed) {
    damagePed(state, hitPed, damage, shooter.id, events);
  } else if (hitProp) {
    damageProp(state, hitProp, damage, events);
  }
}

/** Props take damage and flip to broken — a discrete transition, no physics. */
export function damageProp(
  state: GameState,
  prop: PropState,
  damage: number,
  events: SimEvent[],
): void {
  if (!prop.intact) return;
  prop.hp -= damage;
  if (prop.hp > 0) return;
  prop.hp = 0;
  prop.intact = false;
  events.push({
    type: 'propDown',
    tick: state.tick,
    kind: prop.kind,
    x: Math.round(prop.pos.x),
    y: Math.round(prop.pos.y),
  });
}

/** Player shots may hit cops. Killing one is a serious crime. */
export function damageCop(
  state: GameState,
  cop: CopState,
  damage: number,
  attackerId: number,
  events: SimEvent[],
): void {
  cop.health -= damage;
  const attacker = state.players.byId[attackerId];
  if (attacker) addHeat(attacker, damage * getTuning().police.heatPerDamage);
  if (cop.health > 0) return;
  removeEntity(state.cops, cop.id);
  if (attacker) addHeat(attacker, getTuning().police.heatPerCopKill);
  events.push({ type: 'copDown', tick: state.tick, killerId: attackerId });
}

export function applyDamage(
  state: GameState,
  victim: PlayerState,
  damage: number,
  attackerId: number,
  weaponId: string,
  events: SimEvent[],
): void {
  if (victim.mode === 'dead') return;
  victim.health -= damage;
  // Violence against players is a crime (cop shooters pass attackerId -1).
  const attacker = attackerId !== victim.id ? state.players.byId[attackerId] : undefined;
  if (attacker) {
    const police = getTuning().police;
    addHeat(attacker, damage * police.heatPerDamage);
    if (victim.health <= 0) addHeat(attacker, police.heatPerKill);
  }
  if (victim.health > 0) return;
  victim.health = 0;
  // Death: drop out of any car, freeze, schedule-visible respawn tick.
  if (victim.vehicleId !== null) {
    const v = state.vehicles.byId[victim.vehicleId];
    if (v && v.driverId === victim.id) v.driverId = null;
    victim.vehicleId = null;
  }
  victim.mode = 'dead';
  victim.vel.x = 0;
  victim.vel.y = 0;
  victim.respawnAtTick = state.tick + RESPAWN_DELAY_TICKS;
  victim.weapons = [];
  victim.activeWeapon = -1;
  events.push({ type: 'death', tick: state.tick, playerId: victim.id });
  if (attackerId !== victim.id) {
    events.push({
      type: 'kill',
      tick: state.tick,
      killerId: attackerId,
      victimId: victim.id,
      weaponId,
    });
  }
}

/** Cooldowns, weapon switching, firing. Runs after movement each tick. */
export function stepWeapons(
  state: GameState,
  inputs: Record<number, InputIntent | undefined>,
  map: CityMap,
  events: SimEvent[],
): void {
  for (const id of state.players.ids) {
    const p = state.players.byId[id];
    if (!p) continue;
    if (p.fireCooldown > 0) p.fireCooldown--;
    if (p.carHitCooldown > 0) p.carHitCooldown--;
    const input = inputs[id];
    if (!input || p.mode === 'dead') continue;

    if (input.slot >= 0 && input.slot < p.weapons.length) {
      p.activeWeapon = input.slot;
    }
    if (!input.fire || p.fireCooldown > 0 || p.mode !== 'foot') continue;
    const slot = p.weapons[p.activeWeapon];
    if (!slot || slot.ammo <= 0) continue;
    const weapon = getWeaponTuning(slot.weaponId);
    if (!weapon) continue;

    slot.ammo--;
    p.fireCooldown = weapon.cooldownTicks;
    for (let pellet = 0; pellet < weapon.pellets; pellet++) {
      let roll: number;
      [roll, state.rng] = nextFloat01(state.rng);
      const angle = p.aimAngle + (roll - 0.5) * 2 * weapon.spread;
      fireOnce(state, map, p, angle, weapon.range, weapon.damage, slot.weaponId, events);
    }
  }
}

/** Run-over damage: fast cars hurt anyone on foot they overlap. */
export function stepVehicleImpacts(state: GameState, events: SimEvent[]): void {
  for (const vid of state.vehicles.ids) {
    const v = state.vehicles.byId[vid];
    if (!v || Math.abs(v.speed) < RUNOVER_MIN_SPEED) continue;
    const half = getVehicleTuning(v.kind).halfExtent + PLAYER_RADIUS;
    for (const pid of state.players.ids) {
      const p = state.players.byId[pid];
      if (!p || p.mode !== 'foot' || p.carHitCooldown > 0) continue;
      if (Math.abs(p.pos.x - v.pos.x) < half && Math.abs(p.pos.y - v.pos.y) < half) {
        p.carHitCooldown = RUNOVER_IMMUNITY_TICKS;
        const damage = Math.abs(v.speed) * 0.12;
        applyDamage(state, p, damage, v.driverId ?? -1, 'vehicle', events);
      }
    }
    for (const pedId of [...state.peds.ids]) {
      const ped = state.peds.byId[pedId];
      if (!ped) continue;
      if (Math.abs(ped.pos.x - v.pos.x) < half && Math.abs(ped.pos.y - v.pos.y) < half) {
        damagePed(state, ped, Math.abs(v.speed) * 0.2, v.driverId ?? -1, events);
      }
    }
    // Street furniture: smashed at speed, discrete transition + a nudge of
    // lost momentum. No rigid bodies anywhere near the network.
    const propsT = getTuning().props;
    if (Math.abs(v.speed) >= propsT.breakSpeed) {
      for (const propId of state.props.ids) {
        const prop = state.props.byId[propId];
        if (!prop || !prop.intact) continue;
        const r = (propsT.kinds[prop.kind]?.radius ?? 4) + half;
        if (Math.abs(prop.pos.x - v.pos.x) < r && Math.abs(prop.pos.y - v.pos.y) < r) {
          damageProp(state, prop, 1000, events);
          v.speed = q8(v.speed * propsT.crashSpeedLoss);
        }
      }
    }
  }
}
