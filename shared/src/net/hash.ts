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
  view.setFloat64(0, v);
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
    h = hashNumber(h, p.lastInputSeq);
    h = hashBool(h, p.actionHeld);
  }
  for (const v of snap.vehicles) {
    h = hashNumber(h, v.id);
    h = hashString(h, v.kind);
    h = hashNumber(h, v.pos.x);
    h = hashNumber(h, v.pos.y);
    h = hashNumber(h, v.heading);
    h = hashNumber(h, v.speed);
    h = hashNumber(h, v.driverId ?? -1);
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
