import { beforeAll, describe, expect, it } from 'vitest';
import playerTuning from '../data/player.json';
import vehiclesJson from '../data/vehicles.json';
import trafficJson from '../data/traffic.json';
import pedsJson from '../data/peds.json';
import policeJson from '../data/police.json';
import propsJson from '../data/props.json';
import weaponsJson from '../data/weapons.json';
import { getVehicleTuning, initTuning } from '../src/tuning.js';
import { PLAYER_RADIUS, TICK_RATE } from '../src/constants.js';
import { HALF_PI } from '../src/math/trig.js';
import { createGameState, createVehicle, type GameState } from '../src/sim/state.js';
import { insertEntity } from '../src/sim/entities.js';
import { step } from '../src/sim/step.js';
import { NULL_INPUT, type InputIntent } from '../src/sim/input.js';
import {
  circleHitsBox,
  pushOutOfBox,
  pushOutOfVehicles,
  vehicleBoxAt,
} from '../src/sim/bodies.js';
import { driveVehicle, vehiclesOverlap } from '../src/sim/vehicle.js';
import { MAX_REWIND_TICKS, rewoundWorld } from '../src/sim/rewind.js';
import { T_BUILDING, T_FIELD, TILE_SIZE, type CityMap } from '../src/world/types.js';

beforeAll(() => {
  initTuning({
    player: playerTuning,
    vehicles: vehiclesJson,
    traffic: trafficJson,
    peds: pedsJson,
    police: policeJson,
    props: propsJson,
    weapons: weaponsJson,
  });
});

/** Open field, big enough that nothing in here ever meets a wall. */
function arena(): CityMap {
  const W = 80;
  const H = 40;
  return {
    seed: 0,
    widthTiles: W,
    heightTiles: H,
    widthPx: W * TILE_SIZE,
    heightPx: H * TILE_SIZE,
    tiles: new Uint8Array(W * H).fill(T_FIELD),
    district: new Uint8Array(W * H),
    blocks: [],
    buildings: [],
    shops: [],
    vehicleSpawns: [],
    playerSpawns: [{ x: 20 * TILE_SIZE, y: 20 * TILE_SIZE }],
  };
}

function key(seq: number, keys: Partial<InputIntent>): InputIntent {
  return { ...NULL_INPUT, seq, tick: seq, ...keys };
}



/** Read lazily: tuning is loaded in beforeAll, module scope is too early. */
const car = () => getVehicleTuning('car');

describe('a car is one shape, and it is the shape of a car', () => {
  it('the box is 12 long and 5.5 wide, not a 9 px square', () => {
    // The numbers this whole file is about. `halfExtent` (9) is the square
    // used against the TILE grid, where a square is the only thing that makes
    // sense; every body-to-body test uses the real half-extents.
    expect(car().halfLength).toBeGreaterThan(car().halfExtent);
    expect(car().halfWidth).toBeLessThan(car().halfExtent);
  });

  it('the nose reaches further than the flank, and the flank is not the nose', () => {
    const body = vehicleBoxAt('car', 100, 100, 0); // pointing +x
    const r = PLAYER_RADIUS;
    // Standing off the NOSE at 17 px: 12 + 6 = 18, so this is contact. The
    // old square reached 9 + 6 = 15 and said nothing was there — a bonnet
    // buried three pixels of itself in you before it registered.
    expect(circleHitsBox(117, 100, r, body)).toBe(true);
    expect(circleHitsBox(119, 100, r, body)).toBe(false);
    // Standing off the FLANK at 13 px: 5.5 + 6 = 11.5, so this is clear air.
    // The old square reached 15 and ran you over from two pixels outside its
    // own door mirror.
    expect(circleHitsBox(100, 113, r, body)).toBe(false);
    expect(circleHitsBox(100, 111, r, body)).toBe(true);
  });

  it('turns with the car — the same spot is a hit head-on and a miss broadside', () => {
    const spot = { x: 116, y: 100 };
    expect(circleHitsBox(spot.x, spot.y, PLAYER_RADIUS, vehicleBoxAt('car', 100, 100, 0))).toBe(
      true,
    );
    // Same car, same place, turned a quarter turn: now it is 16 px off the
    // flank of a body 5.5 wide, and nothing is touching anything. An
    // axis-aligned square cannot tell these two apart, which is why a car
    // sitting diagonally across a junction hit things it was nowhere near.
    expect(
      circleHitsBox(spot.x, spot.y, PLAYER_RADIUS, vehicleBoxAt('car', 100, 100, HALF_PI)),
    ).toBe(false);
  });
});

describe('a broad phase may over-include, never under-include', () => {
  // Both of these pin the same mistake, which is easy to make twice and was:
  // rejecting a pair on `halfLength` when a box reaches sqrt(hl² + hw²) from
  // its centre. Everything in between is a contact thrown away before
  // anything looks at it — a collision that silently does not happen, which
  // is the exact complaint this whole change answers.

  it('two cars meeting corner to corner still collide', () => {
    // Clear at the start of the tick, corner-to-corner at the end of it —
    // which is the only way a contact is ever made, and the case the reject
    // has to survive. `a` steps ~4 px east (120 px/s at 30 Hz), closing to
    // (23, 10.5) apart: inside both separating axes (2*halfLength = 24,
    // 2*halfWidth = 11) and so genuinely overlapping, while the centres are
    // 25.28 px apart — further than halfLength + halfLength.
    //
    // Mid-field, not at the origin: a car centred on x = 0 has its near side
    // outside the map, which is solid, so it is a WALL hit that stops it and
    // the test proves nothing. The first draft of this test did exactly that
    // and passed against the bug it was written to catch.
    const ax = 200;
    const ay = 200;
    const a = createVehicle(1, 'car', { x: ax, y: ay }, 0);
    const b = createVehicle(2, 'car', { x: ax + 27, y: ay + 10.5 }, 0);
    expect(vehiclesOverlap(a, b)).toBe(false); // not yet
    expect(Math.hypot(23, 10.5)).toBeGreaterThan(car().halfLength * 2);
    // By the end of the step, once `a` has closed ~4 px:
    expect(vehiclesOverlap(createVehicle(3, 'car', { x: ax + 4, y: ay }, 0), b)).toBe(true);

    const world = { vehicles: { ids: [2], byId: { 2: b } } };
    a.speed = 120;
    driveVehicle(a, 0, 0, arena(), world);
    // Struck it: knocked back onto its heels, and left short of where the
    // free move would have put it.
    expect(a.speed).toBeLessThan(0);
    expect(a.pos.x).toBeLessThan(ax + 3);
    // And the car it hit was shoved, which only the contact path does.
    expect(b.speed).toBeGreaterThan(0);
  });

  it('somebody standing against a corner of a car is touching it', () => {
    // 5.66 px from the corner at (12, 5.5), so inside a 6 px body radius —
    // and 18.6 px from the centre, past halfLength + radius. Mid-field, so no
    // wall can be what moves them.
    const cx = 200;
    const cy = 200;
    const at = { x: cx + 16, y: cy + 9.5 };
    const body = vehicleBoxAt('car', cx, cy, 0);
    expect(circleHitsBox(at.x, at.y, PLAYER_RADIUS, body)).toBe(true);
    expect(Math.hypot(16, 9.5)).toBeGreaterThan(car().halfLength + PLAYER_RADIUS);

    const pos = { ...at };
    const vel = { x: 0, y: 0 };
    const world = {
      vehicles: { ids: [1], byId: { 1: createVehicle(1, 'car', { x: cx, y: cy }, 0) } },
    };
    pushOutOfVehicles(pos, vel, PLAYER_RADIUS, world, arena());
    expect(pos.x === at.x && pos.y === at.y).toBe(false); // it saw them
    expect(circleHitsBox(pos.x, pos.y, PLAYER_RADIUS, body)).toBe(false);
  });
});

describe('cars are solid to people', () => {
  it('walking into a parked car stops at its flank instead of passing through', () => {
    const map = arena();
    let state = createGameState(1);
    state = step(state, {}, [{ type: 'spawnPlayer', playerId: 1, name: 'walker' }], map);
    const p = state.players.byId[1]!;
    // A car across the player's path, 40 px to the east, lying north-south so
    // its FLANK is what gets walked into.
    const carX = p.pos.x + 40;
    state = step(
      state,
      {},
      [{ type: 'spawnVehicle', vehicleId: 2, kind: 'car', x: carX, y: p.pos.y, heading: HALF_PI }],
      map,
    );
    for (let i = 0; i < TICK_RATE * 3; i++) {
      state = step(state, { 1: key(i + 1, { right: true }) }, [], map);
    }
    const me = state.players.byId[1]!;
    // Stopped at the body, not inside it and not through it. Before this
    // existed a player walked clean through a parked car and out the far side
    // — three seconds at walk speed is well past it.
    const gap = carX - me.pos.x;
    expect(gap).toBeGreaterThan(car().halfWidth);
    expect(gap).toBeLessThan(car().halfWidth + PLAYER_RADIUS + 2);
  });

  it('a car that parks on top of you pushes you out rather than trapping you', () => {
    // The reason this is a push-out and not a blocked move. Somebody standing
    // exactly where a car ends up has no legal position at all under a hard
    // block, and every escape attempt gets undone.
    const map = arena();
    let state = createGameState(1);
    state = step(state, {}, [{ type: 'spawnPlayer', playerId: 1, name: 'squashed' }], map);
    const p = state.players.byId[1]!;
    state = step(
      state,
      {},
      [{ type: 'spawnVehicle', vehicleId: 2, kind: 'car', x: p.pos.x, y: p.pos.y, heading: 0 }],
      map,
    );
    // The car lands dead on top of them — nothing about that spot is legal.
    expect(circleHitsBox(p.pos.x, p.pos.y, PLAYER_RADIUS, vehicleBoxAt('car', p.pos.x, p.pos.y, 0)))
      .toBe(true);
    // Standing still, hands off the keys: the escape is the world's doing.
    for (let i = 0; i < 10; i++) state = step(state, { 1: key(i + 1, {}) }, [], map);
    const me = state.players.byId[1]!;
    expect(
      circleHitsBox(me.pos.x, me.pos.y, PLAYER_RADIUS, vehicleBoxAt('car', p.pos.x, p.pos.y, 0)),
    ).toBe(false);
    // Out by the near face — across the width, which is the short way.
    expect(Math.abs(me.pos.y - p.pos.y)).toBeGreaterThan(car().halfWidth);
    expect(Math.abs(me.pos.x - p.pos.x)).toBeLessThan(1);
  });

  it('a push that would put somebody inside a wall is refused', () => {
    // Better pinned against a car than extruded through a building.
    const map = arena();
    for (let ty = 0; ty < map.heightTiles; ty++) {
      map.tiles[ty * map.widthTiles + 21] = T_BUILDING;
    }
    const wallX = 21 * TILE_SIZE;
    const pos = { x: wallX - 3, y: 100 }; // already inside the wall's reach
    const vel = { x: 0, y: 0 };
    const world = { vehicles: { ids: [1], byId: { 1: createVehicle(1, 'car', { x: wallX - 10, y: 100 }, 0) } } };
    pushOutOfVehicles(pos, vel, PLAYER_RADIUS, world, map);
    // Pushing east is into the building, so nothing moved.
    expect(pos.x).toBe(wallX - 3);
  });

  it('slides along a flank rather than stopping dead against it', () => {
    // Only the component driving INTO the body is spent.
    const box = vehicleBoxAt('car', 100, 100, 0); // long axis is +x
    const pos = { x: 100, y: 100 + car().halfWidth + PLAYER_RADIUS - 1 };
    const vel = { x: 40, y: -20 }; // along the flank, and into it
    const world = { vehicles: { ids: [1], byId: { 1: createVehicle(1, 'car', { x: 100, y: 100 }, 0) } } };
    pushOutOfVehicles(pos, vel, PLAYER_RADIUS, world, arena());
    expect(vel.x).toBe(40); // untouched: along the body
    expect(vel.y).toBeCloseTo(0, 6); // spent: into the body
    expect(circleHitsBox(pos.x, pos.y, PLAYER_RADIUS, box)).toBe(false);
  });

  it('the crowd walks round cars too', () => {
    const map = arena();
    let state = createGameState(7);
    const spot = { x: 20 * TILE_SIZE, y: 20 * TILE_SIZE };
    state = step(
      state,
      {},
      [
        // A player, because the crowd is culled where nobody is watching.
        { type: 'spawnPlayer', playerId: 1, name: 'witness' },
        { type: 'spawnVehicle', vehicleId: 2, kind: 'car', x: spot.x, y: spot.y, heading: 0 },
        { type: 'spawnPed', pedId: 3, x: spot.x, y: spot.y },
      ],
      map,
    );
    // Ped cadence is one step in three, so give it a couple of rounds.
    for (let i = 0; i < 12; i++) state = step(state, {}, [], map);
    const ped = state.peds.byId[3]!;
    expect(circleHitsBox(ped.pos.x, ped.pos.y, 5, vehicleBoxAt('car', spot.x, spot.y, 0))).toBe(
      false,
    );
  });
});

describe('the push-out itself', () => {
  it('leaves by the nearest face from inside, and by the contact normal from outside', () => {
    const box = vehicleBoxAt('car', 0, 0, 0);
    // Just inside the flank: out across the width, the short way.
    const near = pushOutOfBox(0, 2, PLAYER_RADIUS, box)!;
    expect(near.x).toBe(0);
    expect(near.y).toBeGreaterThan(0);
    // Off a corner: diagonally away from that corner, both components live.
    const corner = pushOutOfBox(car().halfLength + 3, car().halfWidth + 3, PLAYER_RADIUS, box)!;
    expect(corner.x).toBeGreaterThan(0);
    expect(corner.y).toBeGreaterThan(0);
    // And it separates them exactly — no more, no less.
    expect(
      circleHitsBox(
        car().halfLength + 3 + corner.x,
        car().halfWidth + 3 + corner.y,
        PLAYER_RADIUS,
        box,
      ),
    ).toBe(false);
  });

  it('is null when there is nothing to resolve', () => {
    expect(pushOutOfBox(100, 100, PLAYER_RADIUS, vehicleBoxAt('car', 0, 0, 0))).toBeNull();
  });
});

/** A state with `n` ticks of trail, one car crossing at a known speed. */
function trailState(speedPerTick: number, n: number): GameState {
  const state = createGameState(1);
  const car = createVehicle(9, 'car', { x: 0, y: 0 }, 0);
  insertEntity(state.vehicles, car);
  for (let t = 1; t <= n; t++) {
    state.tick = t;
    car.pos.x = t * speedPerTick;
    // Hand-rolled rather than run through step(): the point is the trail's
    // arithmetic, and a real drive would fold in friction and tile contact.
    state.vehicleTrail = [
      { tick: t, poses: { 9: { x: car.pos.x, y: 0, heading: 0 } } },
      ...state.vehicleTrail,
    ];
  }
  state.tick = n + 1;
  return state;
}

describe('lag compensation: the server judges what the client could see', () => {
  it('rewinds a moving car to the tick the client was looking at', () => {
    const state = trailState(10, 20);
    const world = rewoundWorld(state, { ...NULL_INPUT, viewTick: 15 });
    expect(world.poses?.[9]?.x).toBe(150);
    // Without a view tick nothing is rewound, which is what a bot or a test
    // or a client's first second gets.
    expect(rewoundWorld(state, { ...NULL_INPUT, viewTick: 0 }).poses).toBeUndefined();
  });

  it('honours the fraction of a tick, because the client renders between them', () => {
    // The client's render clock sits BETWEEN two snapshots and lerps. Pinning
    // the rewind to a whole tick would hand back half a tick of exactly the
    // error the mechanism exists to remove — 3 px at road speed.
    const state = trailState(10, 20);
    expect(rewoundWorld(state, { ...NULL_INPUT, viewTick: 15.25 }).poses?.[9]?.x).toBe(152.5);
    expect(rewoundWorld(state, { ...NULL_INPUT, viewTick: 15.5 }).poses?.[9]?.x).toBe(155);
  });

  it('clamps a client that asks to look further back than the server will go', () => {
    // `viewTick` is an assertion by a stranger. Somebody claiming to have
    // been looking at the world a minute ago gets the oldest tick the server
    // is willing to serve, not a minute of immunity.
    const state = trailState(10, 30);
    const far = rewoundWorld(state, { ...NULL_INPUT, viewTick: 1 });
    const oldest = state.tick - 1 - MAX_REWIND_TICKS;
    expect(far.poses?.[9]?.x).toBe(oldest * 10);
    // ...and one from the future gets the present, not extrapolation.
    const ahead = rewoundWorld(state, { ...NULL_INPUT, viewTick: 9999 });
    expect(ahead.poses?.[9]?.x).toBe((state.tick - 1) * 10);
  });

  it('a car that did not exist then is judged where it is now', () => {
    const state = trailState(10, 20);
    const newcomer = createVehicle(11, 'car', { x: 500, y: 0 }, 0);
    insertEntity(state.vehicles, newcomer);
    const world = rewoundWorld(state, { ...NULL_INPUT, viewTick: 15 });
    expect(world.poses?.[11]).toBeUndefined();
  });

  it('detection rewinds; the response lands on the live car', () => {
    // The whole distinction. A driver hits the car where they saw it — but
    // what gets shoved and damaged is the car as it is NOW, not a copy of it
    // three ticks ago. Anything else would be time travel rather than lag
    // compensation.
    const map = arena();
    let state = createGameState(3);
    state = step(state, {}, [{ type: 'spawnPlayer', playerId: 1, name: 'driver' }], map);
    const p = state.players.byId[1]!;
    state = step(
      state,
      {},
      [
        { type: 'spawnVehicle', vehicleId: 2, kind: 'car', x: p.pos.x, y: p.pos.y, heading: 0 },
        // Parked square in the road ahead. Parked, so its trail is constant
        // and the rewind cannot change the ANSWER — only the bookkeeping.
        { type: 'spawnVehicle', vehicleId: 3, kind: 'car', x: p.pos.x + 90, y: p.pos.y, heading: 0 },
      ],
      map,
    );
    state = step(state, { 1: key(1, { action: true }) }, [], map);
    for (let i = 0; i < TICK_RATE * 2; i++) {
      const view = Math.max(0, state.tick - 4);
      state = step(state, { 1: key(i + 2, { up: true, viewTick: view }) }, [], map);
    }
    const struck = state.vehicles.byId[3]!;
    // It moved and it took damage: the live car, not a historical copy.
    expect(struck.pos.x).toBeGreaterThan(p.pos.x + 90);
    expect(struck.health).toBeLessThan(getVehicleTuning('car').health);
  });

  it('the trail is bounded, and never grows with the session', () => {
    const map = arena();
    let state = createGameState(5);
    state = step(state, {}, [{ type: 'spawnVehicle', vehicleId: 2, kind: 'car', x: 300, y: 300, heading: 0 }], map);
    for (let i = 0; i < 200; i++) state = step(state, {}, [], map);
    expect(state.vehicleTrail.length).toBeLessThanOrEqual(MAX_REWIND_TICKS + 2);
    expect(state.vehicleTrail[0]!.tick).toBe(state.tick);
  });
});
