// Round 5, verification of R5-A01. Run from the repo root after `pnpm build`:
//   node evidence/round5/V-R5-A01-respray-at-police-station.mjs
//
// Independent end-to-end check that the landmark-hosted spray garages are not
// merely a data overlap but a working respray: it drives a car through the
// carved wall opening with the real collision solver, and buys a respray with
// the real Economy, from the ROAD tile outside three police stations.
import { readFileSync } from 'node:fs';
import {
  TILE_SIZE, createGameState, generateCity, initTuning, moveWithCollision,
  parseCatalog, parseWorldgenParams, step,
} from '../../shared/dist/index.js';
import { MemoryStore } from '../../server/dist/economy/store.js';
import { parseEconomyParams } from '../../server/dist/economy/awards.js';
import { Economy } from '../../server/dist/economy/economy.js';

const J = (p) => JSON.parse(readFileSync(new URL('../../shared/data/' + p, import.meta.url), 'utf8'));
initTuning({ player: J('player.json'), vehicles: J('vehicles.json'), weapons: J('weapons.json') });
const catalog = parseCatalog(J('shop.json'));
const params = parseEconomyParams(J('economy.json'));
const map = generateCity(777, parseWorldgenParams(J('worldgen.json')));

// 1. The doors that are both a police-station door and a spray-shop door.
const stations = map.policeStations.map((s) => `${Math.floor(s.x / TILE_SIZE)},${Math.floor(s.y / TILE_SIZE)}`);
const sprays = map.shops.filter((s) => s.kind === 'spray').map((s) => `${s.doorX},${s.doorY}`);
console.log('police-station doors that are also respray doors:', stations.filter((d) => sprays.includes(d)));
const clinics = map.shops.filter((s) => s.kind === 'clinic').map((s) => `${s.doorX},${s.doorY}`);
console.log('clinic doors that are also respray doors:      ', clinics.filter((d) => sprays.includes(d)));

// 2. Drive a car (half 9) and a van (half 11) from the street through the
//    two-tile opening into the station's floor. tile 9 is T_FLOOR.
const drives = [
  ['Kelvin Road Station', 474.0, 438.5, 474.0, 444.5],
  ['Sunridge Station', 313.0, 461.5, 313.0, 466.5],
  ['Marsh Post', 540.0, 547.5, 540.0, 552.5],
  ['The Spire', 412.0, 297.5, 412.0, 302.5],
];
for (const [name, sx, sy, tx, ty] of drives) {
  for (const half of [9, 11]) {
    const pos = { x: sx * TILE_SIZE, y: sy * TILE_SIZE };
    const vel = { x: 0, y: 0 };
    for (let i = 0; i < 400; i++) {
      const ddy = Math.max(-4, Math.min(4, ty * TILE_SIZE - pos.y));
      if (Math.abs(ty * TILE_SIZE - pos.y) < 1) break;
      moveWithCollision(map, pos, vel, half, 0, ddy, 'land');
    }
    const tile = map.tiles[Math.floor(pos.y / TILE_SIZE) * map.widthTiles + Math.floor(pos.x / TILE_SIZE)];
    console.log(`drive ${name.padEnd(20)} half=${half} ends at ${(pos.x / TILE_SIZE).toFixed(2)},${(pos.y / TILE_SIZE).toFixed(2)} tile=${tile} (9 = T_FLOOR, inside)`);
  }
}

// 3. Buy the respray, from the road tile outside and from inside the room.
const buys = [
  ['on the road outside Kelvin Rd Stn', 473.5, 438.5],
  ['on the road outside Sunridge Stn', 312.5, 461.5],
  ['on the road outside Marsh Post', 539.5, 547.5],
  ['parked inside Kelvin Rd Stn', 474.0, 444.5],
];
for (const [name, tx, ty] of buys) {
  const economy = new Economy(new MemoryStore(), catalog, params);
  let state = createGameState(777);
  state = step(state, {}, [{ type: 'spawnPlayer', playerId: 1, name: 'crook' }], map);
  economy.bindGuest(1);
  const p = state.players.byId[1];
  p.pos = { x: tx * TILE_SIZE, y: ty * TILE_SIZE };
  p.heat = 450;
  p.wantedLevel = 4;
  p.mode = 'driving';
  p.vehicleId = 99;
  const res = economy.buy(1, 'respray', state, map);
  const after = res.command ? step(state, {}, [res.command], map) : null;
  console.log(
    `buy  ${name.padEnd(33)} ok=${res.ok} "${res.message}" ` +
      `heat 450->${after ? after.players.byId[1].heat : '-'} wanted 4->${after ? after.players.byId[1].wantedLevel : '-'}`,
  );
}
