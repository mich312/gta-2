import { beforeAll, describe, expect, it } from 'vitest';
import playerTuning from '../../shared/data/player.json';
import vehiclesJson from '../../shared/data/vehicles.json';
import weaponsJson from '../../shared/data/weapons.json';
import policeJson from '../../shared/data/police.json';
import pedsJson from '../../shared/data/peds.json';
import propsJson from '../../shared/data/props.json';
import pickupsJson from '../../shared/data/pickups.json';
import worldgenJson from '../../shared/data/worldgen.json';
import economyJson from '../../shared/data/economy.json';
import {
  type GameState,
  createGameState,
  areaScale,
  generateCity,
  initTuning,
  parseWorldgenParams,
  step,
} from 'shared';
import { boxInSolid } from '../../shared/src/world/collide.js';
import { Secrets, parseSecretParams } from '../src/economy/secrets.js';

const worldgen = parseWorldgenParams(worldgenJson);
const map = generateCity(777, worldgen);
const params = parseSecretParams((economyJson as Record<string, unknown>)['secrets']);

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

function withPlayers(n: number): GameState {
  let state = createGameState(777);
  for (let i = 1; i <= n; i++) {
    state = step(state, {}, [{ type: 'spawnPlayer', playerId: i, name: `p${i}` }], map);
  }
  return state;
}

describe('hidden packages (L2)', () => {
  it('a hundred of them, and every one is somewhere a person can stand', () => {
    // A package you cannot reach is worse than no package at all — this is
    // the assertion that was expected to fail during development, and the
    // reason placement prefers enclosed tiles rather than solid ones.
    // `packageCount` is per nominal city; the count scales with the map's
    // area like every other ambient budget.
    expect(map.packages.length).toBe(Math.round(worldgenJson.packageCount * areaScale(map)));
    for (const at of map.packages) {
      expect(boxInSolid(map, at, 5), `${at.x},${at.y}`).toBe(false);
    }
  });

  it('they are hidden, not scattered: no two share a spot, and they spread out', () => {
    const seen = new Set<string>();
    for (const at of map.packages) seen.add(`${at.x},${at.y}`);
    expect(seen.size).toBe(map.packages.length);
    // Spread across the city rather than piled in one alley.
    const xs = map.packages.map((p) => p.x);
    const ys = map.packages.map((p) => p.y);
    expect(Math.max(...xs) - Math.min(...xs)).toBeGreaterThan(map.widthPx * 0.5);
    expect(Math.max(...ys) - Math.min(...ys)).toBeGreaterThan(map.heightPx * 0.5);
  });

  it('is a pure function of the seed', () => {
    const a = generateCity(4242, worldgen).packages;
    const b = generateCity(4242, worldgen).packages;
    expect(a).toEqual(b);
    expect(generateCity(4243, worldgen).packages).not.toEqual(a);
  });

  it('two players find the same package independently, and both are paid', () => {
    // THE test for this design. The world is shared; the finding is personal.
    // A one-time find in a city with thirty people in it is dead by the
    // second hour, and this is the line that stops that.
    const secrets = new Secrets(params);
    const state = withPlayers(2);
    const at = map.packages[0]!;
    state.players.byId[1]!.pos = { x: at.x, y: at.y };
    state.players.byId[2]!.pos = { x: at.x, y: at.y };

    const first = secrets.step(state, map);
    expect(first.length).toBe(2);
    expect(first.map((f) => f.playerId).sort()).toEqual([1, 2]);
    expect(secrets.found(1)).toBe(1);
    expect(secrets.found(2)).toBe(1);
  });

  it('...and the same player is paid exactly once for the same one', () => {
    const secrets = new Secrets(params);
    const state = withPlayers(1);
    const at = map.packages[3]!;
    state.players.byId[1]!.pos = { x: at.x, y: at.y };
    expect(secrets.step(state, map).length).toBe(1);
    for (let i = 0; i < 10; i++) expect(secrets.step(state, map).length).toBe(0);
    expect(secrets.found(1)).toBe(1);
  });

  it('standing nowhere near one finds nothing', () => {
    const secrets = new Secrets(params);
    const state = withPlayers(1);
    // Found rather than assumed: (8,8) looked empty and had a package on it.
    let spot: { x: number; y: number } | null = null;
    for (let x = 40; x < map.widthPx && !spot; x += 97) {
      for (let y = 40; y < map.heightPx && !spot; y += 89) {
        const clear = map.packages.every((q) => Math.hypot(q.x - x, q.y - y) > params.reach * 4);
        if (clear) spot = { x, y };
      }
    }
    expect(spot).not.toBeNull();
    state.players.byId[1]!.pos = { x: spot!.x, y: spot!.y };
    expect(secrets.step(state, map).length).toBe(0);
  });

  it('crossing a threshold pays, and the ones between do not', () => {
    const secrets = new Secrets(params);
    const state = withPlayers(1);
    const paid: number[] = [];
    for (let i = 0; i < 12; i++) {
      const at = map.packages[i]!;
      state.players.byId[1]!.pos = { x: at.x, y: at.y };
      for (const find of secrets.step(state, map)) {
        if (find.reward > 0) paid.push(find.found);
      }
    }
    // Exactly the first threshold, at exactly the right count.
    expect(paid).toEqual([params.rewards[0]!.at]);
  });

  it('a find survives a restart', () => {
    const secrets = new Secrets(params);
    const state = withPlayers(1);
    // A package with no neighbour within twice the find reach — FOUND, not
    // index 5 of whatever the current bake happens to scatter: after the
    // wave-2 rebake, package 5 gained a neighbour inside the reach, and the
    // restarted player standing on it "found" the neighbour — which reads
    // as a double payment and is really the staging having assumed the
    // packages' spacing. The claim is about persistence, so stage where
    // spacing cannot answer instead of it.
    const lone = map.packages.findIndex((a, i) =>
      map.packages.every((b, j) => j === i || Math.hypot(a.x - b.x, a.y - b.y) > params.reach * 2),
    );
    expect(lone, 'no isolated package on this map').toBeGreaterThanOrEqual(0);
    const at = map.packages[lone]!;
    state.players.byId[1]!.pos = { x: at.x, y: at.y };
    secrets.step(state, map);
    const saved = secrets.indicesOf(1);
    expect(saved).toEqual([lone]);

    const later = new Secrets(params);
    later.seed(1, saved);
    expect(later.found(1)).toBe(1);
    // ...and it is not paid for a second time.
    expect(later.step(state, map).length).toBe(0);
  });
});
