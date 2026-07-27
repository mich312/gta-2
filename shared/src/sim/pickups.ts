import { TICK_RATE } from '../constants.js';
import { q8 } from '../math/vec.js';
import { getTuning } from '../tuning.js';
import type { GameState, PickupState, PlayerState } from './state.js';
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
      pu.respawnAtTick = state.tick + Math.round(t.kinds[pu.kind].respawnSec * TICK_RATE);
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

/** Apply a pickup's effect. False if the player has no room for it. */
function consume(pu: PickupState, p: PlayerState, tick: number): boolean {
  const t = getTuning().pickups;
  const value = t.kinds[pu.kind].value;
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
