import { PLAYER_RADIUS, TICK_RATE } from '../constants.js';
import { q8 } from '../math/vec.js';
import { PI, dCos, dSin, wrapAngle } from '../math/trig.js';
import { nextFloat01 } from '../rng/prng.js';
import { getTuning, getVehicleTuning, getWeaponTuning } from '../tuning.js';
import type {
  CopState,
  GameState,
  PedState,
  PlayerState,
  PropState,
  VehicleState,
} from './state.js';
import { addHeat, createProjectile, POWER_DOUBLE_DAMAGE, POWER_FAST_RELOAD, POWER_JAIL_CARD } from './state.js';
import { insertEntity } from './entities.js';
import { damagePed, dropWeapon } from './peds.js';
import { damageVehicle, vehicleHitRadius } from './vehicleDamage.js';
import type { InputIntent } from './input.js';
import type { SimEvent } from './events.js';
import { TILE_SIZE, type CityMap } from '../world/types.js';
import { isSolidTile } from '../world/collide.js';

export const RESPAWN_DELAY_TICKS = TICK_RATE * 3;
/** The one weapon everybody always has. */
export const FISTS_ID = 'fists';
export const FISTS_SLOT: { weaponId: string; ammo: number } = { weaponId: FISTS_ID, ammo: 0 };
/**
 * Speed at which a car starts hurting whoever it drives into.
 *
 * This was 130 px/s, which is ABOVE the speed ambient traffic cruises at
 * (`traffic.cruiseSpeed`, 104) — so every NPC car in the city drove straight
 * through pedestrians and players without touching them, and the only vehicle
 * in the game that could run anybody over was one a player was flooring. A
 * car rolling off a kerb is enough; the damage scales with speed from there.
 */
const RUNOVER_MIN_SPEED = 24;
const RUNOVER_IMMUNITY_TICKS = 12;
/** Damage per px/s of the car's speed. */
const RUNOVER_DAMAGE_PER_SPEED = 0.22;
/** Ditto for pedestrians, who are rather less robust. */
const RUNOVER_PED_DAMAGE_PER_SPEED = 0.33;
/** How much of the car's speed is transferred to whoever it hits, as px/s. */
const RUNOVER_KNOCKBACK = 0.7;
/** How far past the car's own body a drive-by round starts, px. */
const DRIVEBY_MUZZLE_CLEARANCE = 4;
/** Extra spread per px/s of the car's speed, and its ceiling (radians). */
const DRIVEBY_SPREAD_PER_SPEED = 0.00067;
const DRIVEBY_MAX_EXTRA_SPREAD = 0.1;
/** How far past the thrower a launched projectile starts, px. */
const PROJECTILE_MUZZLE_CLEARANCE = 6;

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
  if (isSolidTile(map, tx, ty)) return 0;
  for (;;) {
    if (tMaxX < tMaxY) {
      if (tMaxX > maxDist) return maxDist;
      tx += stepX;
      if (isSolidTile(map, tx, ty)) return tMaxX;
      tMaxX += tDeltaX;
    } else {
      if (tMaxY > maxDist) return maxDist;
      ty += stepY;
      if (isSolidTile(map, tx, ty)) return tMaxY;
      tMaxY += tDeltaY;
    }
  }
}

/** Ray-circle intersection distance, or Infinity. Exact ops only. */
export function rayCircleDistance(
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
  /** Muzzle, which is not always the shooter: a drive-by leaves the car body. */
  ox: number,
  oy: number,
  angle: number,
  range: number,
  damage: number,
  weaponId: string,
  /** Vehicle the shot comes out of, and therefore cannot hit. */
  skipVehicleId: number | null,
  events: SimEvent[],
): void {
  const dirX = dCos(angle);
  const dirY = dSin(angle);
  const wallDist = rayWallDistance(map, ox, oy, dirX, dirY, range);

  let hitPlayer: PlayerState | null = null;
  let hitCop: CopState | null = null;
  let hitPed: PedState | null = null;
  let hitProp: PropState | null = null;
  let hitVehicle: VehicleState | null = null;
  let hitDist = wallDist;
  for (const id of state.players.ids) {
    if (id === shooter.id) continue;
    const target = state.players.byId[id];
    if (!target || target.mode === 'dead') continue;
    const d = rayCircleDistance(
      ox,
      oy,
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
    if (!cop || copIsDown(cop)) continue; // shoot through a body, not into it
    const d = rayCircleDistance(
      ox,
      oy,
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
    // A body on the pavement is scenery, and scenery you can shoot through:
    // leaving corpses in the ray made every street its own sandbag wall.
    if (!ped || ped.mode === 'dead') continue;
    const d = rayCircleDistance(
      ox,
      oy,
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
      ox,
      oy,
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

  // Vehicles are shootable — without this nothing in the game could destroy
  // a car, which is the toy the whole genre is built around.
  for (const id of state.vehicles.ids) {
    if (id === skipVehicleId) continue;
    const veh = state.vehicles.byId[id];
    if (!veh || veh.condition !== 'ok') continue;
    const d = rayCircleDistance(
      ox,
      oy,
      dirX,
      dirY,
      veh.pos.x,
      veh.pos.y,
      vehicleHitRadius(veh),
    );
    if (d < hitDist) {
      hitDist = d;
      hitVehicle = veh;
      hitProp = null;
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
    x0: Math.round(ox),
    y0: Math.round(oy),
    x1: Math.round(ox + dirX * hitDist),
    y1: Math.round(oy + dirY * hitDist),
  });

  if (hitPlayer) {
    applyDamage(state, hitPlayer, damage, shooter.id, weaponId, events);
  } else if (hitCop) {
    damageCop(state, hitCop, damage, shooter.id, events);
  } else if (hitPed) {
    damagePed(state, hitPed, damage, shooter.id, events);
  } else if (hitProp) {
    damageProp(state, hitProp, damage, events);
  } else if (hitVehicle) {
    damageVehicle(state, hitVehicle, damage, events);
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
  prop.respawnAtTick = state.tick + Math.round(getTuning().props.respawnDelaySec * TICK_RATE);
  events.push({
    type: 'propDown',
    tick: state.tick,
    kind: prop.kind,
    x: Math.round(prop.pos.x),
    y: Math.round(prop.pos.y),
  });
}

/** An officer who is a body rather than a pursuer. See damageCop. */
export function copIsDown(cop: CopState): boolean {
  return cop.health <= 0;
}

/** Player shots may hit cops. Killing one is a serious crime. */
export function damageCop(
  state: GameState,
  cop: CopState,
  damage: number,
  attackerId: number,
  events: SimEvent[],
): void {
  if (copIsDown(cop)) return; // already a body
  cop.health -= damage;
  const attacker = state.players.byId[attackerId];
  if (attacker) addHeat(attacker, damage * getTuning().police.heatPerDamage);
  if (cop.health > 0) return;
  // The officer stays in the world as a body on the tarmac, cleared by
  // stepPolice when the corpse clock runs out. `health <= 0` is the whole of
  // the state that needs — health is already diffed and already hashed, so a
  // body costs nothing extra on the wire.
  cop.health = 0;
  cop.targetId = null;
  cop.idleTicks = 0;
  cop.vel.x = 0;
  cop.vel.y = 0;
  if (cop.vehicleId !== null) {
    const cruiser = state.vehicles.byId[cop.vehicleId];
    if (cruiser) cruiser.driverId = null; // the cruiser is just a car now
    cop.vehicleId = null;
  }
  // And the gun goes where the officer went. Cops are the one NPC that has
  // always shot back; this is what makes shooting back worth doing.
  const t = getTuning().police;
  dropWeapon(state, cop.pos, t.kinds[cop.kind]?.weapon ?? t.weapon, Math.round(getTuning().peds.dropAmmo));
  if (attacker) addHeat(attacker, t.heatPerCopKill);
  events.push({
    type: 'copDown',
    tick: state.tick,
    killerId: attackerId,
    x: Math.round(cop.pos.x),
    y: Math.round(cop.pos.y),
  });
}

/**
 * Arrest. Physically it does what dying does — you go down, you lose the
 * guns, the same respawn timer runs — because reusing the death pipeline is
 * what keeps one code path for "player is out of play".
 *
 * What differs is everything around it: the wanted level is wiped here and
 * now (an arrest ends the chase, it does not merely pause it), the session
 * sends you to a police station instead of a hospital, and the economy takes
 * half your multiplier. Dying costs you a trip; being nicked costs you the
 * run. That asymmetry is the entire point of having two failure modes.
 */
export function bustPlayer(
  state: GameState,
  victim: PlayerState,
  copId: number,
  events: SimEvent[],
): void {
  if (victim.mode === 'dead') return;
  victim.health = 0;
  victim.mode = 'dead';
  victim.vel.x = 0;
  victim.vel.y = 0;
  victim.respawnAtTick = state.tick + RESPAWN_DELAY_TICKS;
  victim.armour = 0;
  victim.weapons = victim.weapons.filter((w) => w.weaponId === FISTS_ID);
  victim.activeWeapon = victim.weapons.length > 0 ? 0 : -1;
  // Booked, processed, released: the heat is gone, not decayed.
  clearWanted(state, victim);
  events.push({ type: 'busted', tick: state.tick, playerId: victim.id, copId });
  events.push({ type: 'death', tick: state.tick, playerId: victim.id });
}

/**
 * Wipe one player's wanted level and let go of every officer chasing them.
 *
 * Per-player by construction: heat, the wanted level derived from it, and the
 * pursuit are all keyed on this id and nobody else's. Used by an arrest, by a
 * respray, and by dying.
 */
export function clearWanted(state: GameState, p: PlayerState): void {
  p.heat = 0;
  p.wantedLevel = 0;
  for (const cid of state.cops.ids) {
    const cop = state.cops.byId[cid];
    if (cop && cop.targetId === p.id) cop.targetId = null;
  }
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
  // Armour soaks first and is spent doing it; the remainder reaches health.
  if (victim.armour > 0) {
    const soaked = Math.min(victim.armour, damage);
    victim.armour = q8(victim.armour - soaked);
    damage -= soaked;
  }
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
  victim.armour = 0;
  // Guns are lost, hands are not. An unarmed player must still have a verb.
  victim.weapons = victim.weapons.filter((w) => w.weaponId === FISTS_ID);
  victim.activeWeapon = victim.weapons.length > 0 ? 0 : -1;
  // The chase dies with you. Heat is a fact about ONE player — it always was,
  // it is a field on PlayerState — but nothing cleared it when that player
  // died, so you woke up at the hospital still six-starred, with the force
  // that had just killed you re-acquiring on the spawn tick. Dying costs you
  // the trip and the guns; it does not also cost you the rest of the session.
  clearWanted(state, victim);
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
    if (!input.fire || p.fireCooldown > 0) continue;
    const driving = p.mode === 'driving';
    if (!driving && p.mode !== 'foot') continue;
    const slot = p.weapons[p.activeWeapon];
    if (!slot) continue;
    const weapon = getWeaponTuning(slot.weaponId);
    if (!weapon) continue;
    // A punch needs both hands and a pavement.
    if (driving && weapon.melee) continue;
    if (slot.ammo <= 0 && !weapon.infiniteAmmo) continue;

    // Where the muzzle is. On foot it is the shooter; leaning out of a car it
    // has to clear the car's own body, or every drive-by would put its first
    // round into the door it came through.
    let ox = p.pos.x;
    let oy = p.pos.y;
    let spread = weapon.spread;
    const car = driving && p.vehicleId !== null ? state.vehicles.byId[p.vehicleId] : undefined;
    if (car) {
      const clear = getVehicleTuning(car.kind).halfExtent + DRIVEBY_MUZZLE_CLEARANCE;
      ox = p.pos.x + dCos(p.aimAngle) * clear;
      oy = p.pos.y + dSin(p.aimAngle) * clear;
      // Firing one-handed across a moving car costs accuracy.
      spread += Math.min(
        DRIVEBY_MAX_EXTRA_SPREAD,
        Math.abs(car.speed) * DRIVEBY_SPREAD_PER_SPEED,
      );
    }

    if (!weapon.infiniteAmmo) slot.ammo--;
    p.fireCooldown =
      (p.powerFlags & POWER_FAST_RELOAD) !== 0
        ? Math.max(1, Math.round(weapon.cooldownTicks / 2))
        : weapon.cooldownTicks;
    const damage =
      (p.powerFlags & POWER_DOUBLE_DAMAGE) !== 0 ? weapon.damage * 2 : weapon.damage;

    // Launchers and thrown weapons put an object in the world instead of
    // resolving along a ray. No rng draw here: a rocket has no spread worth
    // the stream shift, and the aim already came off the wire quantised.
    if (weapon.projectile) {
      const pt = weapon.projectile;
      const muzzle = PLAYER_RADIUS + PROJECTILE_MUZZLE_CLEARANCE;
      insertEntity(
        state.projectiles,
        createProjectile(
          state.nextEntityId++,
          slot.weaponId,
          { x: ox + dCos(p.aimAngle) * muzzle, y: oy + dSin(p.aimAngle) * muzzle },
          { x: dCos(p.aimAngle) * pt.speed, y: dSin(p.aimAngle) * pt.speed },
          p.id,
          state.tick + pt.fuseTicks,
        ),
      );
      continue;
    }

    for (let pellet = 0; pellet < weapon.pellets; pellet++) {
      let roll: number;
      [roll, state.rng] = nextFloat01(state.rng);
      const angle = p.aimAngle + (roll - 0.5) * 2 * spread;
      fireOnce(
        state,
        map,
        p,
        ox,
        oy,
        angle,
        weapon.range,
        damage,
        slot.weaponId,
        car ? car.id : null,
        events,
      );
    }
  }
}

/**
 * Street furniture comes back. Without this the city is consume-only: every
 * session monotonically strips itself of lamps, bins and fences and never
 * recovers. Repairs are held back until nobody is close enough to watch a
 * lamp post reassemble itself.
 */
export function stepProps(state: GameState, events: SimEvent[]): void {
  const t = getTuning().props;
  const minDist2 = t.respawnMinDistFromPlayer * t.respawnMinDistFromPlayer;
  for (const id of state.props.ids) {
    const prop = state.props.byId[id];
    if (!prop || prop.intact || prop.respawnAtTick === null) continue;
    if (state.tick < prop.respawnAtTick) continue;
    let watched = false;
    for (const pid of state.players.ids) {
      const p = state.players.byId[pid];
      if (!p || p.mode === 'dead') continue;
      const dx = p.pos.x - prop.pos.x;
      const dy = p.pos.y - prop.pos.y;
      if (dx * dx + dy * dy < minDist2) {
        watched = true;
        break;
      }
    }
    if (watched) continue;
    prop.intact = true;
    prop.hp = t.kinds[prop.kind]?.hp ?? 10;
    prop.respawnAtTick = null;
    events.push({
      type: 'propUp',
      tick: state.tick,
      kind: prop.kind,
      x: Math.round(prop.pos.x),
      y: Math.round(prop.pos.y),
    });
  }
}

/**
 * A car struck somebody. Reported so the client can throw blood and make a
 * noise: a non-fatal hit used to have no outward sign at all beyond the
 * victim's own HUD flashing red.
 */
function pushRunOver(
  events: SimEvent[],
  tick: number,
  x: number,
  y: number,
  v: VehicleState,
): void {
  events.push({
    type: 'runOver',
    tick,
    x: Math.round(x),
    y: Math.round(y),
    angle: v.speed >= 0 ? v.heading : wrapAngle(v.heading + PI),
    speed: Math.round(Math.abs(v.speed)),
  });
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
        // Thrown along the car's line, not merely damaged. Walk acceleration
        // eats the extra velocity over the next few ticks, which is what reads
        // as being knocked off your feet rather than teleported.
        const shove = Math.abs(v.speed) * RUNOVER_KNOCKBACK * (v.speed >= 0 ? 1 : -1);
        p.vel.x = q8(p.vel.x + dCos(v.heading) * shove);
        p.vel.y = q8(p.vel.y + dSin(v.heading) * shove);
        pushRunOver(events, state.tick, p.pos.x, p.pos.y, v);
        applyDamage(
          state,
          p,
          Math.abs(v.speed) * RUNOVER_DAMAGE_PER_SPEED,
          v.driverId ?? -1,
          'vehicle',
          events,
        );
      }
    }
    // Fixed order: players, then cops, then peds. Never reorder — the damage
    // each takes feeds heat, which feeds cop spawning, which draws rng.
    for (const copId of [...state.cops.ids]) {
      const cop = state.cops.byId[copId];
      if (!cop || cop.carHitCooldown > 0 || copIsDown(cop)) continue;
      if (Math.abs(cop.pos.x - v.pos.x) < half && Math.abs(cop.pos.y - v.pos.y) < half) {
        cop.carHitCooldown = RUNOVER_IMMUNITY_TICKS;
        pushRunOver(events, state.tick, cop.pos.x, cop.pos.y, v);
        damageCop(state, cop, Math.abs(v.speed) * RUNOVER_DAMAGE_PER_SPEED, v.driverId ?? -1, events);
      }
    }
    for (const pedId of [...state.peds.ids]) {
      const ped = state.peds.byId[pedId];
      // Driving over a body is not a fresh run-over: without this a corpse in
      // the road threw blood and made a noise thirty times a second.
      if (!ped || ped.mode === 'dead') continue;
      if (Math.abs(ped.pos.x - v.pos.x) < half && Math.abs(ped.pos.y - v.pos.y) < half) {
        pushRunOver(events, state.tick, ped.pos.x, ped.pos.y, v);
        damagePed(state, ped, Math.abs(v.speed) * RUNOVER_PED_DAMAGE_PER_SPEED, v.driverId ?? -1, events);
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
