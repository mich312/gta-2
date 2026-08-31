// Does a LIVE pedestrian (a solid body, standing up) stop a rocket / car gun?
// If corpse-collision were deliberate "contact fuse on physical objects",
// a live person must stop it too.
import {
  createGameState, generateCity, NULL_INPUT, step,
  createCop, createPed, insertEntity, rayWallDistance,
} from '../../shared/dist/index.js';
import { loadSharedTuning, loadWorldgenParams } from '../../server/dist/tuning.js';

loadSharedTuning('normal');
const map = generateCity(6006, loadWorldgenParams());

function openAim(from) {
  const angles = [0, Math.PI, Math.PI / 2, -Math.PI / 2];
  for (let i = 0; i < 32; i++) angles.push((i * Math.PI) / 16);
  for (const a of angles) {
    if (rayWallDistance(map, from.x, from.y, Math.cos(a), Math.sin(a), 200) >= 180) return a;
  }
  throw new Error('no clear line');
}

// blocker: 'none' | 'livePed' | 'deadCop' | 'liveCop'
function stage(blocker) {
  let state = createGameState(5);
  state = step(state, {}, [{ type: 'spawnPlayer', playerId: 1, name: 'g' }], map);
  const me = state.players.byId[1];
  const aim = openAim(me.pos);
  const at = (d) => ({ x: me.pos.x + Math.cos(aim) * d, y: me.pos.y + Math.sin(aim) * d });
  state = step(state, {}, [
    { type: 'spawnVehicle', vehicleId: 90001, kind: 'car', x: me.pos.x, y: me.pos.y, heading: aim },
    { type: 'grantWeapon', playerId: 1, weaponId: 'smg', ammo: 200 },
  ], map);
  state = step(state, { 1: { ...NULL_INPUT, seq: 1, tick: 1, action: true, aimAngle: aim } }, [], map);
  state = step(state, {}, [{ type: 'fitVehicle', playerId: 1, fitting: 'guns', ammo: 200 }], map);
  const mark = createCop(50001, at(120), 999999, 'patrol');
  mark.targetId = null;
  insertEntity(state.cops, mark);
  if (blocker === 'livePed') {
    const p = createPed(60001, at(60), 100);
    p.mode = 'walk';
    insertEntity(state.peds, p);
  } else if (blocker === 'deadCop') {
    const b = createCop(50002, at(60), 50, 'patrol');
    b.health = 0;
    insertEntity(state.cops, b);
  } else if (blocker === 'liveCop') {
    const b = createCop(50002, at(60), 500, 'patrol');
    b.targetId = null;
    insertEntity(state.cops, b);
  }
  return { state, aim };
}

function cargun(blocker) {
  let { state, aim } = stage(blocker);
  const before = state.cops.byId[50001].health;
  const events = [];
  state = step(state, { 1: { ...NULL_INPUT, seq: 9, tick: 9, aimAngle: aim, fitting: true } }, [], map, events);
  const shot = events.find((e) => e.type === 'shot');
  return { dealt: before - state.cops.byId[50001].health,
           reach: shot ? Math.round(Math.hypot(shot.x1 - shot.x0, shot.y1 - shot.y0)) : -1 };
}

function rocket(blocker) {
  let { state, aim } = stage(blocker);
  state = step(state, { 1: { ...NULL_INPUT, seq: 20, tick: 20, action: true, aimAngle: aim } }, [], map);
  state = step(state, {}, [{ type: 'grantWeapon', playerId: 1, weaponId: 'rocket', ammo: 5 }], map);
  const me = state.players.byId[1];
  me.activeWeapon = me.weapons.findIndex((w) => w.weaponId === 'rocket');
  const before = state.cops.byId[50001].health;
  for (let i = 0; i < 20; i++) {
    state = step(state, { 1: { ...NULL_INPUT, seq: 30 + i, tick: 30 + i, aimAngle: aim, fire: i === 0 } }, [], map);
  }
  return before - state.cops.byId[50001].health;
}

for (const b of ['none', 'livePed', 'deadCop', 'liveCop']) {
  const g = cargun(b);
  console.log(`blocker=${b.padEnd(8)} cargun dmg=${String(g.dealt).padStart(5)} reach=${String(g.reach).padStart(4)}   rocket dmg=${rocket(b)}`);
}
