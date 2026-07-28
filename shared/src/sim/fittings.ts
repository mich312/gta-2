import { PLAYER_RADIUS, TICK_RATE } from '../constants.js';
import { q8, q256 } from '../math/vec.js';
import { dCos, dSin, wrapAngle } from '../math/trig.js';
import { getTuning, getVehicleTuning, getWeaponTuning } from '../tuning.js';
import type { GameState, VehicleState } from './state.js';
import { createProjectile } from './state.js';
import { insertEntity } from './entities.js';
import type { InputIntent } from './input.js';
import type { SimEvent } from './events.js';
import type { CityMap } from '../world/types.js';
import { applyDamage, damageCop, rayCircleDistance, rayWallDistance } from './weapons.js';
import { damagePed } from './peds.js';
import { damageVehicle, vehicleHitRadius } from './vehicleDamage.js';

/**
 * What the garage bolts to a car: a bomb, an oil slick, mines, or a pair of
 * forward-firing machine guns.
 *
 * This is the answer to the problem any game with infinite stealable vehicles
 * eventually has — that no car is worth more than the next one. A fitted car
 * is an investment, and losing it to a wall costs you the fitting too. The
 * prices carry the originals' ratios (1 : 2 : 5 : 10) rather than their
 * figures, because a pistol here costs 250 rather than several thousand.
 *
 * Determinism: fixed slot after `stepWeapons` and before `stepProjectiles`,
 * so anything dropped this tick is stepped by the projectile pass on the
 * NEXT one — a mine cannot detonate on the tick it leaves the car. Iterates
 * players in sorted-id order. Draws no random numbers.
 */
export function stepFittings(
  state: GameState,
  inputs: Record<number, InputIntent | undefined>,
  map: CityMap,
  events: SimEvent[],
): void {
  const t = getTuning().fittings;

  for (const id of state.players.ids) {
    const p = state.players.byId[id];
    if (!p) continue;
    if (p.fittingCooldown > 0) p.fittingCooldown--;
    const input = inputs[id];
    if (!input || !input.fitting) continue;
    if (p.mode !== 'driving' || p.vehicleId === null) continue;
    if (p.fittingCooldown > 0) continue;
    const v = state.vehicles.byId[p.vehicleId];
    if (!v || v.condition !== 'ok' || v.fitting === '' || v.fittingAmmo <= 0) continue;

    switch (v.fitting) {
      case 'bomb': {
        // Armed, not detonated: you set it and you get out. Reuses the
        // burning path, so the blast, the chain reaction and the wreck are
        // the ones every other exploding car already goes through.
        v.condition = 'burning';
        v.fuseAtTick = state.tick + Math.round(t.bombFuseSec * TICK_RATE);
        v.fittingAmmo = 0;
        v.fitting = '';
        events.push({ type: 'vehicleBurning', tick: state.tick, vehicleId: v.id, x: Math.round(v.pos.x), y: Math.round(v.pos.y) });
        p.fittingCooldown = t.dropCooldownTicks;
        break;
      }
      case 'slick':
      case 'mine': {
        // Dropped behind, clear of your own back bumper.
        const back = wrapAngle(v.heading + Math.PI);
        const clear = vehicleHitRadius(v) + t.dropClearance;
        insertEntity(
          state.projectiles,
          createProjectile(
            state.nextEntityId++,
            v.fitting === 'mine' ? 'mine' : 'slick',
            { x: q8(v.pos.x + dCos(back) * clear), y: q8(v.pos.y + dSin(back) * clear) },
            { x: 0, y: 0 },
            p.id,
            state.tick + Math.round(t.dropLifeSec * TICK_RATE),
          ),
        );
        v.fittingAmmo--;
        if (v.fittingAmmo <= 0) v.fitting = '';
        p.fittingCooldown = t.dropCooldownTicks;
        break;
      }
      case 'guns': {
        fireCarGuns(state, map, v, p.id, events);
        v.fittingAmmo--;
        if (v.fittingAmmo <= 0) v.fitting = '';
        p.fittingCooldown = t.gunCooldownTicks;
        break;
      }
    }
  }
}

/**
 * Two streams of fire down the car's nose — or down the turret, if it has one.
 *
 * Bolted guns are deliberately NOT aimed at the mouse: the way to aim them is
 * to point the car, which is what makes them a different weapon from leaning
 * out of the window with a pistol. A TURRET is the exception, and the reason
 * the exception exists is that a turret is the one part of a vehicle that
 * does not turn with the body. `turretOffset` in vehicles.json is what says
 * which is which, so the renderer and the gun cannot disagree about it.
 */
function fireCarGuns(
  state: GameState,
  map: CityMap,
  v: VehicleState,
  ownerId: number,
  events: SimEvent[],
): void {
  const weapon = getWeaponTuning('carGun');
  if (!weapon) return;
  const angle = q256(turretAngle(state, v));
  const dirX = dCos(angle);
  const dirY = dSin(angle);
  const muzzle = vehicleHitRadius(v) + 2;
  const ox = v.pos.x + dirX * muzzle;
  const oy = v.pos.y + dirY * muzzle;
  let hitDist = rayWallDistance(map, ox, oy, dirX, dirY, weapon.range);

  let hitPlayerId: number | null = null;
  let hitCopId: number | null = null;
  let hitPedId: number | null = null;
  let hitVehicleId: number | null = null;
  const consider = (d: number, set: () => void): void => {
    if (d < hitDist) {
      hitDist = d;
      hitPlayerId = null;
      hitCopId = null;
      hitPedId = null;
      hitVehicleId = null;
      set();
    }
  };
  for (const pid of state.players.ids) {
    const target = state.players.byId[pid];
    if (!target || target.mode === 'dead' || pid === ownerId) continue;
    consider(
      rayCircleDistance(ox, oy, dirX, dirY, target.pos.x, target.pos.y, PLAYER_RADIUS),
      () => (hitPlayerId = pid),
    );
  }
  for (const cid of state.cops.ids) {
    const cop = state.cops.byId[cid];
    if (!cop) continue;
    consider(
      rayCircleDistance(ox, oy, dirX, dirY, cop.pos.x, cop.pos.y, PLAYER_RADIUS),
      () => (hitCopId = cid),
    );
  }
  for (const pedId of state.peds.ids) {
    const ped = state.peds.byId[pedId];
    if (!ped) continue;
    consider(
      rayCircleDistance(ox, oy, dirX, dirY, ped.pos.x, ped.pos.y, PLAYER_RADIUS),
      () => (hitPedId = pedId),
    );
  }
  for (const vid of state.vehicles.ids) {
    if (vid === v.id) continue; // never your own bonnet
    const other = state.vehicles.byId[vid];
    if (!other || other.condition !== 'ok') continue;
    consider(
      rayCircleDistance(ox, oy, dirX, dirY, other.pos.x, other.pos.y, vehicleHitRadius(other)),
      () => (hitVehicleId = vid),
    );
  }

  events.push({
    type: 'shot',
    tick: state.tick,
    playerId: ownerId,
    x0: Math.round(ox),
    y0: Math.round(oy),
    x1: Math.round(ox + dirX * hitDist),
    y1: Math.round(oy + dirY * hitDist),
    noise: weapon.noiseRadius,
  });

  if (hitPlayerId !== null) {
    const target = state.players.byId[hitPlayerId];
    if (target) applyDamage(state, target, weapon.damage, ownerId, 'carGun', events);
  } else if (hitCopId !== null) {
    const cop = state.cops.byId[hitCopId];
    if (cop) damageCop(state, cop, weapon.damage, ownerId, events);
  } else if (hitPedId !== null) {
    const ped = state.peds.byId[hitPedId];
    if (ped) damagePed(state, ped, weapon.damage, ownerId, events);
  } else if (hitVehicleId !== null) {
    const other = state.vehicles.byId[hitVehicleId];
    if (other) damageVehicle(state, other, weapon.damage, events, ownerId);
  }
}

/**
 * Where a vehicle's gun points.
 *
 * For a turreted vehicle with somebody at the wheel, that is the driver's own
 * aim — which is already on the wire for every player, so an independently
 * traversing turret costs exactly nothing in state or bandwidth. With nobody
 * driving, or on anything without a turret, it rests along the hull.
 */
export function turretAngle(state: GameState, v: VehicleState): number {
  if (getVehicleTuning(v.kind).turretOffset === null) return v.heading;
  const driver = v.driverId === null ? undefined : state.players.byId[v.driverId];
  return driver ? driver.aimAngle : v.heading;
}

/**
 * An oil slick takes the wheel off whoever drives over it: a hard heading
 * kick and a speed loss, no damage. Called from the projectile pass, which
 * is where everything else that sits in the road and waits already lives.
 */
export function slickVehicle(v: VehicleState, side: number): void {
  const t = getTuning().fittings;
  v.heading = q256(wrapAngle(v.heading + t.slickSpin * side));
  v.speed = q8(v.speed * t.slickSpeedLoss);
}

