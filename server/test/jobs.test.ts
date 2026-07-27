import { beforeAll, describe, expect, it } from 'vitest';
import playerTuning from '../../shared/data/player.json';
import vehiclesJson from '../../shared/data/vehicles.json';
import weaponsJson from '../../shared/data/weapons.json';
import policeJson from '../../shared/data/police.json';
import pedsJson from '../../shared/data/peds.json';
import propsJson from '../../shared/data/props.json';
import pickupsJson from '../../shared/data/pickups.json';
import gangsJson from '../../shared/data/gangs.json';
import worldgenJson from '../../shared/data/worldgen.json';
import {
  type GameState,
  type SimEvent,
  TICK_RATE,
  createGameState,
  generateCity,
  getTuning,
  initTuning,
  parseWorldgenParams,
  step,
} from 'shared';
import { DEFAULT_JOBS, Jobs } from '../src/economy/jobs.js';

const worldgen = parseWorldgenParams(worldgenJson);
const map = generateCity(777, worldgen);

beforeAll(() => {
  initTuning({
    player: playerTuning,
    vehicles: vehiclesJson,
    weapons: weaponsJson,
    police: policeJson,
    peds: pedsJson,
    props: propsJson,
    pickups: pickupsJson,
    gangs: gangsJson,
  });
});

/** Bleed-out length in ticks. Read lazily: module scope runs before beforeAll. */
const bleed = (): number => Math.round(getTuning().peds.bleedOutSec * TICK_RATE);

/** A player at the wheel of `kind`, parked at `at`. */
function driving(kind: string, at: { x: number; y: number }): GameState {
  let state = createGameState(777);
  state = step(state, {}, [{ type: 'spawnPlayer', playerId: 1, name: 'driver' }], map);
  state = step(
    state,
    {},
    [{ type: 'spawnVehicle', vehicleId: 30, kind, x: at.x, y: at.y, heading: 0 }],
    map,
  );
  const p = state.players.byId[1]!;
  p.pos = { x: at.x, y: at.y };
  p.mode = 'driving';
  p.vehicleId = 30;
  state.vehicles.byId[30]!.driverId = 1;
  state.vehicles.byId[30]!.speed = 0;
  return state;
}

describe('service jobs (G3)', () => {
  it('an ambulance collects a casualty and is paid for delivering them', () => {
    const door = map.hospitals[0]!;
    // Casualty a little way from the hospital.
    const at = { x: door.x + 300, y: door.y };
    const state = driving('ambulance', at);
    const s = step(state, {}, [{ type: 'spawnPed', pedId: 60, x: at.x + 10, y: at.y }], map);
    const ped = s.peds.byId[60]!;
    ped.mode = 'downed';
    ped.timer = bleed();

    const jobs = new Jobs();
    const pickup = jobs.step([], s, map, bleed());
    expect(jobs.carryingWhat(1)).toBe('casualty');
    expect(pickup.commands).toContainEqual({ type: 'despawnPed', pedId: 60 });

    // Drive to the door and stop.
    const v = s.vehicles.byId[30]!;
    v.pos = { x: door.x, y: door.y };
    s.players.byId[1]!.pos = { x: door.x, y: door.y };
    const drop = jobs.step([], s, map, bleed());
    expect(drop.pay.get(1) ?? 0).toBeGreaterThan(DEFAULT_JOBS.ambulanceBase);
    expect(drop.commands.some((c) => c.type === 'spawnPed' && c.pedId === 60)).toBe(true);
    expect(jobs.carryingWhat(1)).toBeNull();
  });

  it('a fresher casualty is worth more than one who has been lying there', () => {
    const pay = (timerLeft: number): number => {
      const door = map.hospitals[0]!;
      const at = { x: door.x + 300, y: door.y };
      const state = driving('ambulance', at);
      const s = step(state, {}, [{ type: 'spawnPed', pedId: 61, x: at.x + 10, y: at.y }], map);
      s.peds.byId[61]!.mode = 'downed';
      s.peds.byId[61]!.timer = timerLeft;
      const jobs = new Jobs();
      jobs.step([], s, map, bleed());
      s.vehicles.byId[30]!.pos = { x: door.x, y: door.y };
      return jobs.step([], s, map, bleed()).pay.get(1) ?? 0;
    };
    expect(pay(bleed())).toBeGreaterThan(pay(Math.round(bleed() * 0.1)));
  });

  it('an ordinary car is not an ambulance', () => {
    const door = map.hospitals[0]!;
    const at = { x: door.x + 300, y: door.y };
    const state = driving('car', at);
    const s = step(state, {}, [{ type: 'spawnPed', pedId: 62, x: at.x + 10, y: at.y }], map);
    s.peds.byId[62]!.mode = 'downed';
    s.peds.byId[62]!.timer = bleed();
    const jobs = new Jobs();
    jobs.step([], s, map, bleed());
    expect(jobs.carryingWhat(1)).toBeNull();
  });

  it('a taxi fare pays for distance, and circling the pickup earns nothing', () => {
    const at = { x: map.widthPx / 2, y: map.heightPx / 2 };
    const state = driving('taxi', at);
    const s = step(state, {}, [{ type: 'spawnPed', pedId: 63, x: at.x + 10, y: at.y }], map);
    const jobs = new Jobs();
    jobs.step([], s, map, bleed());
    expect(jobs.carryingWhat(1)).toBe('fare');

    // Back where we started: no journey, no fare.
    const circled = jobs.step([], s, map, bleed());
    expect(circled.pay.get(1) ?? 0).toBe(0);
    expect(jobs.carryingWhat(1)).toBe('fare');

    // Actually go somewhere.
    s.vehicles.byId[30]!.pos = { x: at.x + 800, y: at.y };
    const paid = jobs.step([], s, map, bleed());
    expect(paid.pay.get(1) ?? 0).toBeGreaterThan(0);
    expect(jobs.carryingWhat(1)).toBeNull();
  });

  it('getting out loses whoever was in the back', () => {
    const at = { x: map.widthPx / 2, y: map.heightPx / 2 };
    const state = driving('taxi', at);
    const s = step(state, {}, [{ type: 'spawnPed', pedId: 65, x: at.x + 10, y: at.y }], map);
    const jobs = new Jobs();
    jobs.step([], s, map, bleed());
    expect(jobs.carryingWhat(1)).toBe('fare');
    s.players.byId[1]!.mode = 'foot';
    s.players.byId[1]!.vehicleId = null;
    const out = jobs.step([], s, map, bleed());
    expect(jobs.carryingWhat(1)).toBeNull();
    expect(out.notices.length).toBeGreaterThan(0);
  });

  it('a bounty is paid for a kill made from a cruiser, and only from one', () => {
    const at = { x: map.widthPx / 2, y: map.heightPx / 2 };
    const kill: SimEvent = { type: 'kill', tick: 1, killerId: 1, victimId: 9, weaponId: 'pistol' };

    const cruiser = driving('copcar', at);
    expect(new Jobs().step([kill], cruiser, map, bleed()).pay.get(1)).toBe(
      DEFAULT_JOBS.vigilanteBounty,
    );

    const civilian = driving('car', at);
    expect(new Jobs().step([kill], civilian, map, bleed()).pay.get(1) ?? 0).toBe(0);
  });

  it('worldgen registers hospital doors as clinics you can buy treatment at', () => {
    const clinics = map.shops.filter((s) => s.kind === 'clinic');
    expect(clinics.length).toBe(map.hospitals.length);
    expect(clinics.length).toBeGreaterThan(0);
  });
});
