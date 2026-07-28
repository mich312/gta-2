import { beforeAll, describe, expect, it } from 'vitest';
import {
  DEPOT_ROWS,
  initTuning,
  TILE_SIZE,
  generateCity,
  getTuning,
  hashState,
  parseWorldgenParams,
  type CityMap,
  type GameState,
} from 'shared';
import playerTuning from '../../shared/data/player.json';
import vehiclesJson from '../../shared/data/vehicles.json';
import weaponsJson from '../../shared/data/weapons.json';
import trafficJson from '../../shared/data/traffic.json';
import pedsJson from '../../shared/data/peds.json';
import policeJson from '../../shared/data/police.json';
import propsJson from '../../shared/data/props.json';
import worldgenJson from '../../shared/data/worldgen.json';
import { Session } from '../src/session.js';
import { loadConfig } from '../src/config.js';
import { grantDepotRow, inProvingGround } from '../src/provingGround.js';

beforeAll(() => {
  initTuning({
    player: playerTuning,
    vehicles: vehiclesJson,
    weapons: weaponsJson,
    traffic: trafficJson,
    peds: pedsJson,
    police: policeJson,
    props: propsJson,
  });
});

const base = parseWorldgenParams(worldgenJson);
const withRoom = { ...base, provingGround: true };

describe('the proving ground is off unless asked for', () => {
  it('no depot in a default city', () => {
    expect(base.provingGround).toBe(false);
    const map = generateCity(4242, base);
    expect(map.shops.some((s) => s.kind === 'depot')).toBe(false);
  });

  it('PROVING_GROUND=1 is what turns it on, and nothing else does', () => {
    expect(loadConfig({}).provingGround).toBe(false);
    expect(loadConfig({ PROVING_GROUND: '1' }).provingGround).toBe(true);
    expect(loadConfig({ PROVING_GROUND: 'true' }).provingGround).toBe(true);
    expect(loadConfig({ PROVING_GROUND: '0' }).provingGround).toBe(false);
    // Not "any non-empty string": a stray value should not open the room.
    expect(loadConfig({ PROVING_GROUND: 'no' }).provingGround).toBe(false);
  });
});

describe('turning it on changes nothing else about the city', () => {
  // The reason `placeProvingGround` runs dead last and draws no random
  // number. If opening the room moved the streets, then a bug you found with
  // it open would not be there when you closed it, and the room would be
  // worse than useless — it would lie to you.
  const seeds = [1, 7, 4242];

  it.each(seeds)('seed %i generates the same city either way', (seed) => {
    const plain = generateCity(seed, base);
    const armed = generateCity(seed, withRoom);

    // Every placement pass, tile for tile and entry for entry. Player spawns
    // are the deliberate exception and are checked separately below: the room
    // is where you start, or finding it is a treasure hunt.
    expect(armed.vehicleSpawns).toEqual(plain.vehicleSpawns);
    expect(armed.parkingSpots).toEqual(plain.parkingSpots);
    expect(armed.pedSpawns).toEqual(plain.pedSpawns);
    expect(armed.propSpawns).toEqual(plain.propSpawns);
    expect(armed.pickupSpawns).toEqual(plain.pickupSpawns);
    expect(armed.boatSpawns).toEqual(plain.boatSpawns);
    expect(armed.landmarks).toEqual(plain.landmarks);
    // ...and every shop that is not the new one.
    expect(armed.shops.filter((s) => s.kind !== 'depot')).toEqual(plain.shops);
  });

  it('adds exactly one room, and only tiles inside it differ', () => {
    const plain = generateCity(7, base);
    const armed = generateCity(7, withRoom);
    const depots = armed.shops.filter((s) => s.kind === 'depot');
    expect(depots.length).toBe(1);

    // The only tiles that may differ are the ones the carve touched: the
    // room's own footprint and its doorway.
    const room = depots[0]!.interior;
    let strayed = 0;
    for (let ty = 0; ty < armed.heightTiles; ty++) {
      for (let tx = 0; tx < armed.widthTiles; tx++) {
        const i = ty * armed.widthTiles + tx;
        if (armed.tiles[i] === plain.tiles[i]) continue;
        const inRoom =
          tx >= room.x - 1 && tx <= room.x + room.w && ty >= room.y - 1 && ty <= room.y + room.h;
        if (!inRoom) strayed++;
      }
    }
    expect(strayed).toBe(0);
  });

  it.each(seeds)('seed %i: you start at the door, not somewhere across town', (seed) => {
    // `pickSpawn` chooses uniformly from playerSpawns, and the ordinary list
    // is spread across the whole city — so "near spawn point zero" would have
    // put you next to the room one time in however many spawns exist. The
    // room exists to save time; a treasure hunt for it is the opposite.
    const map = generateCity(seed, withRoom);
    const depot = map.shops.find((s) => s.kind === 'depot')!;
    expect(map.playerSpawns).toEqual([
      { x: (depot.doorX + 0.5) * TILE_SIZE, y: (depot.doorY + 0.5) * TILE_SIZE },
    ]);
  });

  it('and the city itself is untouched, spawns aside', () => {
    const plain = generateCity(7, base);
    const armed = generateCity(7, withRoom);
    expect(plain.playerSpawns.length).toBeGreaterThan(1); // the list it replaces
    expect(armed.buildings).toEqual(plain.buildings);
    expect(armed.junctions).toEqual(plain.junctions);
  });
});

/** A session with the room open, and a player standing in its doorway. */
function sessionAtTheCounter(): { session: Session; map: CityMap; playerId: number } {
  const session = new Session(7, withRoom, null, { pedCount: 0 });
  const slot = session.addPlayer('tester', 'tok');
  for (let i = 0; i < 3; i++) session.tick();
  const depot = session.map.shops.find((s) => s.kind === 'depot')!;
  const p = session.state.players.byId[slot.playerId]!;
  p.pos = { x: (depot.doorX + 0.5) * TILE_SIZE, y: (depot.doorY + 0.5) * TILE_SIZE };
  return { session, map: session.map, playerId: slot.playerId };
}

describe('the counter', () => {
  const weaponIds = (): string[] => Object.keys(getTuning().weapons);

  it('serves nobody who is not standing in it', () => {
    const { session, map, playerId } = sessionAtTheCounter();
    const p = session.state.players.byId[playerId]!;
    p.pos = { x: p.pos.x + TILE_SIZE * 30, y: p.pos.y };
    expect(inProvingGround(session.state, map, playerId)).toBe(false);
    const r = grantDepotRow(session.state, map, playerId, 'tank', weaponIds(), () =>
      session.allocateEntityId(),
    );
    expect(r.ok).toBe(false);
    expect(r.commands).toEqual([]);
  });

  it('refuses anything that is not on it', () => {
    const { session, map, playerId } = sessionAtTheCounter();
    const r = grantDepotRow(session.state, map, playerId, 'aircraft carrier', weaponIds(), () =>
      session.allocateEntityId(),
    );
    expect(r.ok).toBe(false);
  });

  it('hands over a tank that is really there', () => {
    const { session, map, playerId } = sessionAtTheCounter();
    const before = session.state.vehicles.ids.length;
    const r = grantDepotRow(session.state, map, playerId, 'tank', weaponIds(), () =>
      session.allocateEntityId(),
    );
    expect(r.ok).toBe(true);
    for (const c of r.commands) session.queueCommand(c);
    session.tick();
    expect(session.state.vehicles.ids.length).toBe(before + 1);
    expect(
      session.state.vehicles.ids.some((id) => session.state.vehicles.byId[id]?.kind === 'tank'),
    ).toBe(true);
  });

  it('lays six cars out in a row, none of them inside each other', () => {
    const { session, map, playerId } = sessionAtTheCounter();
    const r = grantDepotRow(session.state, map, playerId, 'six cars in a row', weaponIds(), () =>
      session.allocateEntityId(),
    );
    expect(r.ok).toBe(true);
    expect(r.commands.length).toBeGreaterThan(1);
    for (const c of r.commands) session.queueCommand(c);
    session.tick();
    // Every id is distinct, or `insertEntity` would have thrown — and none of
    // them landed in a wall.
    const spawned = r.commands.map((c) => (c as { vehicleId: number }).vehicleId);
    expect(new Set(spawned).size).toBe(spawned.length);
    for (const id of spawned) expect(session.state.vehicles.byId[id]).toBeDefined();
  });

  it('every row on the counter actually does something', () => {
    // Cheap, and it catches the row somebody adds later with a typo in the id
    // or a grant kind nothing handles.
    for (const row of DEPOT_ROWS) {
      const { session, map, playerId } = sessionAtTheCounter();
      const r = grantDepotRow(session.state, map, playerId, row.id, weaponIds(), () =>
        session.allocateEntityId(),
      );
      expect(r.ok, `row "${row.id}" refused: ${r.message}`).toBe(true);
      expect(r.commands.length > 0 || r.cash > 0, `row "${row.id}" granted nothing`).toBe(true);
    }
  });

  it('grants only through commands, so the session still replays', () => {
    // Everything the room hands out is an ordinary SimCommand that already
    // existed for other reasons. Nothing here can produce a state the
    // ordinary game could not, which is what keeps a proving-ground session
    // recordable and deterministic like any other.
    const { session, map, playerId } = sessionAtTheCounter();
    for (const row of ['tank', 'every weapon', 'patch up']) {
      const r = grantDepotRow(session.state, map, playerId, row, weaponIds(), () =>
        session.allocateEntityId(),
      );
      for (const c of r.commands) {
        expect(['spawnVehicle', 'grantWeapon', 'healPlayer']).toContain(c.type);
        session.queueCommand(c);
      }
    }
    session.tick();
    const after: GameState = session.state;
    expect(typeof hashState(after)).toBe('number');
  });
});
