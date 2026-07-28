import type { FullSnapshot } from './snapshot.js';
import type { GameState } from '../sim/state.js';
import { takeSnapshot } from './snapshot.js';

/**
 * FNV-1a state hashing. Floats are hashed by their exact IEEE-754 bits, so
 * two states hash equal iff they are bit-identical — the desync tripwire
 * used by snapshots (server sends hash, client compares) and by replays.
 */

const buf = new ArrayBuffer(8);
const view = new DataView(buf);

const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

function fnv(h: number, byte: number): number {
  return Math.imul(h ^ byte, FNV_PRIME) >>> 0;
}

export function hashNumber(h: number, v: number): number {
  // -0 and +0 must hash equal: JSON writes both as "0", so a client
  // reconstructing from the wire can never see the sign bit.
  view.setFloat64(0, v === 0 ? 0 : v);
  for (let i = 0; i < 8; i++) h = fnv(h, view.getUint8(i));
  return h;
}

export function hashBool(h: number, b: boolean): number {
  return fnv(h, b ? 1 : 0);
}

export function hashString(h: number, s: string): number {
  h = fnv(h, s.length & 0xff);
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h = fnv(h, c & 0xff);
    h = fnv(h, (c >>> 8) & 0xff);
  }
  return h;
}

export function hashSnapshot(snap: FullSnapshot): number {
  let h = FNV_OFFSET >>> 0;
  h = hashNumber(h, snap.tick);
  for (const p of snap.players) {
    h = hashNumber(h, p.id);
    h = hashString(h, p.name);
    h = hashNumber(h, p.pos.x);
    h = hashNumber(h, p.pos.y);
    h = hashNumber(h, p.vel.x);
    h = hashNumber(h, p.vel.y);
    h = hashNumber(h, p.aimAngle);
    h = hashString(h, p.mode);
    h = hashNumber(h, p.health);
    h = hashNumber(h, p.armour);
    h = hashNumber(h, p.vehicleId ?? -1);
    h = hashNumber(h, p.weapons.length);
    for (const w of p.weapons) {
      h = hashString(h, w.weaponId);
      h = hashNumber(h, w.ammo);
    }
    h = hashNumber(h, p.activeWeapon);
    h = hashNumber(h, p.cosmeticId);
    h = hashNumber(h, p.wantedLevel);
    h = hashNumber(h, p.respawnAtTick ?? -1);
    h = hashBool(h, p.actionHeld);
    h = hashNumber(h, p.fireCooldown);
    h = hashNumber(h, p.carHitCooldown);
    h = hashNumber(h, p.heat);
    h = hashNumber(h, p.frenzyTarget);
    h = hashNumber(h, p.frenzyKills);
    h = hashNumber(h, p.frenzyEndsAtTick ?? -1);
    h = hashNumber(h, p.z);
    h = hashNumber(h, p.vz);
    h = hashNumber(h, p.airDist);
    h = hashNumber(h, p.fittingCooldown);
    for (const r of p.respect) h = hashNumber(h, r);
    h = hashNumber(h, p.powerFlags);
    h = hashNumber(h, p.powerUntilTick);
  }
  for (const v of snap.vehicles) {
    h = hashNumber(h, v.id);
    h = hashString(h, v.kind);
    h = hashNumber(h, v.pos.x);
    h = hashNumber(h, v.pos.y);
    h = hashNumber(h, v.heading);
    h = hashNumber(h, v.speed);
    h = hashNumber(h, v.driverId ?? -1);
    h = hashNumber(h, v.health);
    h = hashString(h, v.condition);
    h = hashNumber(h, v.fuseAtTick ?? -1);
    h = hashNumber(h, v.igniterId ?? -1);
    h = hashString(h, v.fitting);
    h = hashNumber(h, v.fittingAmmo);
  }
  for (const c of snap.cops) {
    h = hashNumber(h, c.id);
    h = hashString(h, c.kind);
    h = hashNumber(h, c.pos.x);
    h = hashNumber(h, c.pos.y);
    h = hashNumber(h, c.vel.x);
    h = hashNumber(h, c.vel.y);
    h = hashNumber(h, c.targetId ?? -1);
    h = hashNumber(h, c.health);
    h = hashNumber(h, c.fireCooldown);
    h = hashNumber(h, c.idleTicks);
    h = hashNumber(h, c.carHitCooldown);
    h = hashNumber(h, c.vehicleId ?? -1);
    h = hashNumber(h, c.stuckTicks);
  }
  for (const ped of snap.peds) {
    h = hashNumber(h, ped.id);
    h = hashNumber(h, ped.gangId);
    h = hashNumber(h, ped.pos.x);
    h = hashNumber(h, ped.pos.y);
    h = hashNumber(h, ped.dirX);
    h = hashNumber(h, ped.dirY);
    h = hashString(h, ped.mode);
    h = hashNumber(h, ped.health);
    h = hashNumber(h, ped.timer);
  }
  for (const prop of snap.props) {
    h = hashNumber(h, prop.id);
    h = hashString(h, prop.kind);
    h = hashNumber(h, prop.pos.x);
    h = hashNumber(h, prop.pos.y);
    h = hashNumber(h, prop.orient);
    h = hashBool(h, prop.intact);
    h = hashNumber(h, prop.hp);
    h = hashNumber(h, prop.respawnAtTick ?? -1);
  }
  for (const pu of snap.pickups) {
    h = hashNumber(h, pu.id);
    h = hashString(h, pu.kind);
    h = hashNumber(h, pu.pos.x);
    h = hashNumber(h, pu.pos.y);
    h = hashBool(h, pu.active);
    h = hashNumber(h, pu.respawnAtTick ?? -1);
  }

  for (const pr of snap.projectiles) {
    h = hashNumber(h, pr.id);
    h = hashString(h, pr.kind);
    h = hashNumber(h, pr.pos.x);
    h = hashNumber(h, pr.pos.y);
    h = hashNumber(h, pr.vel.x);
    h = hashNumber(h, pr.vel.y);
    h = hashNumber(h, pr.ownerId);
    h = hashNumber(h, pr.fuseAtTick);
  }
  return h >>> 0;
}

/** Full-state hash for replay verification (includes rng + id counter). */
export function hashState(state: GameState): number {
  let h = hashSnapshot(takeSnapshot(state));
  h = hashNumber(h, state.rng);
  h = hashNumber(h, state.nextEntityId);
  h = hashNumber(h, state.seed);
  return h >>> 0;
}
