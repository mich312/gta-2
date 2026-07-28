import { beforeAll, describe, expect, it } from 'vitest';
import playerTuning from '../data/player.json';
import vehiclesJson from '../data/vehicles.json';
import weaponsJson from '../data/weapons.json';
import policeJson from '../data/police.json';
import pedsJson from '../data/peds.json';
import propsJson from '../data/props.json';
import pickupsJson from '../data/pickups.json';
import worldgenJson from '../data/worldgen.json';
import { getWeaponTuning, initTuning } from '../src/tuning.js';
import { parseWorldgenParams } from '../src/world/params.js';
import { generateCity } from '../src/world/generate.js';
import {
  POWER_STUNNED,
  createCop,
  createGameState,
  createPed,
  type GameState,
} from '../src/sim/state.js';
import { insertEntity } from '../src/sim/entities.js';
import { step } from '../src/sim/step.js';
import { NULL_INPUT } from '../src/sim/input.js';
import type { SimEvent } from '../src/sim/events.js';
import { hashState } from '../src/net/hash.js';
import { clearSpot } from './helpers.js';

const map = generateCity(6006, parseWorldgenParams(worldgenJson));

beforeAll(() => {
  initTuning({
    player: playerTuning,
    vehicles: vehiclesJson,
    weapons: weaponsJson,
    police: policeJson,
    peds: pedsJson,
    props: propsJson,
    pickups: pickupsJson,
  });
});

/** A player armed with `weaponId`, with room in front of them. */
function armed(weaponId: string, seed = 909): { state: GameState; aim: number } {
  let state = createGameState(seed);
  state = step(
    state,
    {},
    [{ type: 'spawnPlayer', playerId: 1, name: 'shooter', loadout: [{ weaponId, ammo: 200 }] }],
    map,
  );
  const p = state.players.byId[1]!;
  return { state, aim: clearSpot(map, p.pos, 60).angle };
}

function fire(state: GameState, aim: number, seq: number, events: SimEvent[] = []): GameState {
  return step(state, { 1: { ...NULL_INPUT, seq, tick: state.tick, fire: true, aimAngle: aim } }, [], map, events);
}

describe('weapon noise (M2)', () => {
  it('every weapon says how far it carries as a sound', () => {
    for (const id of Object.keys(weaponsJson)) {
      const w = getWeaponTuning(id);
      expect(w, id).toBeDefined();
      expect(w!.noiseRadius, id).toBeGreaterThan(0);
    }
  });

  it('a silenced pistol is quiet, and a shotgun is not', () => {
    // The whole reason noise exists: the same damage at a fraction of the
    // attention is a real reason to carry one into a turf you would rather
    // not stir up.
    const silenced = getWeaponTuning('silenced')!;
    const pistol = getWeaponTuning('pistol')!;
    const shotgun = getWeaponTuning('shotgun')!;
    expect(silenced.noiseRadius).toBeLessThan(pistol.noiseRadius / 3);
    expect(shotgun.noiseRadius).toBeGreaterThan(pistol.noiseRadius);
    // ...and it is not simply a better pistol.
    expect(silenced.damage).toBeLessThanOrEqual(pistol.damage);
    expect(silenced.range).toBeLessThan(pistol.range);
  });

  it('being heard by an officer costs heat; being quiet does not', () => {
    const cost = (weaponId: string): number => {
      const { state, aim } = armed(weaponId);
      const p = state.players.byId[1]!;
      // An officer standing right there, in earshot of anything loud.
      insertEntity(state.cops, createCop(700, { x: p.pos.x + 60, y: p.pos.y + 60 }, 50));
      const before = state.players.byId[1]!.heat;
      const after = fire(state, aim, 1);
      return after.players.byId[1]!.heat - before;
    };
    const loud = cost('shotgun');
    const quiet = cost('silenced');
    expect(loud).toBeGreaterThan(0);
    expect(quiet).toBe(0);
  });

  it('...but a killing in an empty alley is still a crime', () => {
    // Gating ALL heat on a witness was the first attempt and it is wrong: it
    // made the police system optional. Noise is additive, not a gate.
    let { state, aim } = armed('silenced');
    const shooter = state.players.byId[1]!;
    const spot = clearSpot(map, shooter.pos, 40);
    const ped = createPed(800, { x: spot.x, y: spot.y }, 30);
    insertEntity(state.peds, ped);
    const at = Math.atan2(spot.y - shooter.pos.y, spot.x - shooter.pos.x);
    aim = at;
    const before = state.players.byId[1]!.heat;
    // Held in place: a ped that has been shot flees, and a fleeing ped walks
    // out of the firing line before the next round arrives.
    for (let i = 0; i < 60 && state.peds.byId[800]?.health! > 0; i++) {
      const victim = state.peds.byId[800];
      if (victim) victim.pos = { x: spot.x, y: spot.y };
      state = fire(state, aim, i + 1);
    }
    // A body stays where it fell now, so death is a mode rather than an
    // absence: shot dead, down or gone all count.
    const victim = state.peds.byId[800];
    expect(victim === undefined || victim.health <= 0).toBe(true);
    expect(state.players.byId[1]!.heat).toBeGreaterThan(before);
  });

  it('the crowd scatters from a loud shot and ignores a quiet one', () => {
    const fled = (weaponId: string): boolean => {
      const { state, aim } = armed(weaponId, 5150);
      const p = state.players.byId[1]!;
      // Bystanders BESIDE the shooter, off the firing line, at 90px: well
      // outside a silencer's 34px and well inside a shotgun's 260. Off the
      // line on purpose — a ped that is shot flees from being shot, which
      // would prove nothing about how far the bang carried.
      const side = aim + Math.PI / 2;
      for (let i = 0; i < 4; i++) {
        const d = 60 + i * 10;
        insertEntity(
          state.peds,
          createPed(900 + i, { x: p.pos.x + Math.cos(side) * d, y: p.pos.y + Math.sin(side) * d }, 30),
        );
      }
      const after = fire(state, aim, 1);
      for (let i = 0; i < 4; i++) {
        if (after.peds.byId[900 + i]?.mode === 'flee') return true;
      }
      return false;
    };
    expect(fled('shotgun')).toBe(true);
    expect(fled('silenced')).toBe(false);
  });
});

describe('the electro gun (M2)', () => {
  it('stuns: no moving, no shooting, and it wears off on schedule', () => {
    let { state, aim } = armed('electro');
    const shooter = state.players.byId[1]!;
    const spot = clearSpot(map, shooter.pos, 40);
    state = step(state, {}, [{ type: 'spawnPlayer', playerId: 2, name: 'target' }], map);
    state.players.byId[2]!.pos = { x: spot.x, y: spot.y };
    state.players.byId[2]!.weapons = [{ weaponId: 'pistol', ammo: 30 }];
    aim = Math.atan2(spot.y - shooter.pos.y, spot.x - shooter.pos.x);
    state = fire(state, aim, 1);

    const hit = state.players.byId[2]!;
    expect(hit.powerFlags & POWER_STUNNED).toBe(POWER_STUNNED);
    const until = hit.stunnedUntilTick;
    expect(until - state.tick).toBeGreaterThan(0);

    // They try to run and shoot; neither works.
    const startX = hit.pos.x;
    const events: SimEvent[] = [];
    let cur = state;
    while (cur.tick < until) {
      cur = step(
        cur,
        { 2: { ...NULL_INPUT, seq: cur.tick, tick: cur.tick, right: true, fire: true, aimAngle: 0 } },
        [],
        map,
        events,
      );
    }
    expect(Math.abs(cur.players.byId[2]!.pos.x - startX)).toBeLessThan(3);
    expect(events.some((e) => e.type === 'shot' && e.playerId === 2)).toBe(false);

    // And it lifts on its own.
    cur = step(cur, { 2: { ...NULL_INPUT, seq: 999, tick: cur.tick } }, [], map);
    expect(cur.players.byId[2]!.powerFlags & POWER_STUNNED).toBe(0);
    expect(cur.players.byId[2]!.stunnedUntilTick).toBe(0);
  });

  it('a second hit does not extend a stun into a lock', () => {
    // Being unable to act is the least fun state in any game: this is a tool
    // for escaping or closing, never for winning.
    let { state, aim } = armed('electro');
    const shooter = state.players.byId[1]!;
    const spot = clearSpot(map, shooter.pos, 40);
    state = step(state, {}, [{ type: 'spawnPlayer', playerId: 2, name: 'target' }], map);
    state.players.byId[2]!.pos = { x: spot.x, y: spot.y };
    aim = Math.atan2(spot.y - shooter.pos.y, spot.x - shooter.pos.x);
    state = fire(state, aim, 1);
    const firstUntil = state.players.byId[2]!.stunnedUntilTick;
    // Fire again immediately; the clock must not run past what one hit buys.
    state = fire(state, aim, 2);
    expect(state.players.byId[2]!.stunnedUntilTick).toBeLessThanOrEqual(
      state.tick + getWeaponTuning('electro')!.stunTicks,
    );
    expect(state.players.byId[2]!.stunnedUntilTick).toBeGreaterThanOrEqual(firstUntil - 1);
  });

  it('an ordinary weapon stuns nobody', () => {
    let { state, aim } = armed('pistol');
    const shooter = state.players.byId[1]!;
    const spot = clearSpot(map, shooter.pos, 40);
    state = step(state, {}, [{ type: 'spawnPlayer', playerId: 2, name: 'target' }], map);
    state.players.byId[2]!.pos = { x: spot.x, y: spot.y };
    aim = Math.atan2(spot.y - shooter.pos.y, spot.x - shooter.pos.x);
    state = fire(state, aim, 1);
    expect(state.players.byId[2]!.powerFlags & POWER_STUNNED).toBe(0);
  });

  it('noise and stun are deterministic', () => {
    const run = (): number => {
      const { state, aim } = armed('electro', 31);
      let s = state;
      for (let i = 0; i < 40; i++) s = fire(s, aim, i + 1);
      return hashState(s);
    };
    expect(run()).toBe(run());
  });
});
