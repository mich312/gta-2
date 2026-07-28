import { TICK_RATE } from '../constants.js';
import { q8 } from '../math/vec.js';
import { getTuning } from '../tuning.js';
import type { GameState, PickupState, PlayerState } from './state.js';
import {
  POWER_DOUBLE_DAMAGE,
  POWER_FAST_RELOAD,
  POWER_INVISIBLE,
  POWER_JAIL_CARD,
  POWER_TIMED,
} from './state.js';
import type { SimEvent } from './events.js';
import { FISTS_ID } from './weapons.js';

/**
 * World pickups: health, armour, ammo. Fixed positions from worldgen, so the
 * only fields that ever move on the wire are `active` and `respawnAtTick` —
 * the whole table costs almost nothing per tick.
 *
 * Before this existed the only way to heal in the entire game was to die,
 * which quietly distorted every other system: fleeing a chase was pointless
 * and respawning was the cheapest medkit on the map.
 */
export function stepPickups(state: GameState, events: SimEvent[]): void {
  const t = getTuning().pickups;
  const r2 = t.radius * t.radius;

  // Timed powers lapse before anything can be collected this tick, so a
  // crate taken on the expiry tick starts a clean window rather than
  // inheriting one that was already over.
  for (const pid of state.players.ids) {
    const p = state.players.byId[pid];
    if (!p || (p.powerFlags & POWER_TIMED) === 0) continue;
    if (state.tick >= p.powerUntilTick) p.powerFlags &= ~POWER_TIMED;
  }

  for (const id of state.pickups.ids) {
    const pu = state.pickups.byId[id];
    if (!pu) continue;

    if (!pu.active) {
      if (pu.respawnAtTick !== null && state.tick >= pu.respawnAtTick) {
        pu.active = true;
        pu.respawnAtTick = null;
        events.push({ type: 'pickupUp', tick: state.tick, kind: pu.kind, id: pu.id });
      }
      continue;
    }

    // Sorted-id order throughout: with two players on the same crate, the
    // lower id always wins, on every host.
    for (const pid of state.players.ids) {
      const p = state.players.byId[pid];
      if (!p || p.mode !== 'foot') continue;
      const dx = p.pos.x - pu.pos.x;
      const dy = p.pos.y - pu.pos.y;
      if (dx * dx + dy * dy > r2) continue;
      if (!consume(pu, p, state.tick)) continue;
      pu.active = false;
      pu.respawnAtTick =
        state.tick + Math.round((t.kinds[pu.kind]?.respawnSec ?? 30) * TICK_RATE);
      events.push({
        type: 'pickupTaken',
        tick: state.tick,
        kind: pu.kind,
        playerId: pid,
        x: Math.round(pu.pos.x),
        y: Math.round(pu.pos.y),
      });
      break;
    }
  }
}

/**
 * Light a timed power, replacing whatever was running. Exclusivity is what
 * lets one clock be exactly right instead of roughly right — see the POWER_*
 * comment in state.ts.
 */
function lightTimed(p: PlayerState, bit: number, seconds: number, tick: number): void {
  p.powerFlags = (p.powerFlags & ~POWER_TIMED) | bit;
  p.powerUntilTick = tick + Math.round(seconds * TICK_RATE);
}

/** Apply a pickup's effect. False if the player has no room for it. */
function consume(pu: PickupState, p: PlayerState, tick: number): boolean {
  const t = getTuning().pickups;
  const value = t.kinds[pu.kind]?.value ?? 0;
  switch (pu.kind) {
    case 'health': {
      if (p.health >= t.maxHealth) return false;
      p.health = q8(Math.min(t.maxHealth, p.health + value));
      return true;
    }
    case 'armour': {
      if (p.armour >= t.maxArmour) return false;
      p.armour = q8(Math.min(t.maxArmour, p.armour + value));
      return true;
    }
    case 'frenzy': {
      // One at a time: a second crate mid-frenzy would just reset the clock.
      if (p.frenzyTarget > 0) return false;
      p.frenzyTarget = Math.round(value);
      p.frenzyKills = 0;
      p.frenzyEndsAtTick = tick + Math.round(t.frenzySeconds * TICK_RATE);
      return true;
    }
    case 'bribe': {
      // The located exit from heat: no waiting it out, you go and get it.
      if (p.heat <= 0) return false;
      p.heat = 0;
      p.wantedLevel = 0;
      return true;
    }
    case 'multi': {
      // Nothing happens HERE, on purpose. The multiplier is server state —
      // nothing in step() reads a multiplier (FEATURES.md invariant 8) — so
      // this crate's whole effect is the pickupTaken event it emits, which
      // the Economy handles through the same chokepoint a finished frenzy
      // goes through. Taking it always succeeds; the cap is applied there.
      return true;
    }
    case 'jailcard': {
      if ((p.powerFlags & POWER_JAIL_CARD) !== 0) return false;
      p.powerFlags |= POWER_JAIL_CARD;
      return true;
    }
    case 'damage': {
      lightTimed(p, POWER_DOUBLE_DAMAGE, value, tick);
      return true;
    }
    case 'invis': {
      lightTimed(p, POWER_INVISIBLE, value, tick);
      return true;
    }
    case 'reload': {
      lightTimed(p, POWER_FAST_RELOAD, value, tick);
      return true;
    }
    case 'ammo': {
      // Tops up every gun the player is carrying. Fists are skipped — they
      // have no magazine to fill.
      const guns = p.weapons.filter((w) => w.weaponId !== FISTS_ID);
      if (guns.length === 0) return false;
      for (const w of guns) w.ammo += value;
      return true;
    }
  }
}
