/**
 * A dead officer on the tarmac stops a bolted car gun's rounds.
 *
 * `fireOnce` (weapons.ts:161) skips downed officers — "shoot through a body,
 * not into it" — and the ped loop below it says the same. `fireCarGuns`
 * (fittings.ts:158-165) has no such filter: it considers every cop in the
 * table, sets `hitCopId` on the corpse, and then `damageCop` returns
 * immediately because `copIsDown`. The round is absorbed by the body and
 * whatever stood behind it is untouched.
 *
 * Control: the identical shot with the corpse removed must land.
 * Cross-check: the same geometry with a hand weapon (fireOnce) must land
 * THROUGH the corpse — that is the behaviour this one is out of step with.
 */
import {
  createGameState, generateCity, NULL_INPUT, step,
  createCop, insertEntity, rayWallDistance,
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
  throw new Error('no clear line from the spawn — pick another seed');
}

/** Player in a car with guns fitted; a live officer down the barrel. */
function stage(withCorpse, useHandgun) {
  let state = createGameState(5);
  state = step(state, {}, [{ type: 'spawnPlayer', playerId: 1, name: 'g' }], map);
  const me = state.players.byId[1];
  const aim = openAim(me.pos);
  const at = (d) => ({ x: me.pos.x + Math.cos(aim) * d, y: me.pos.y + Math.sin(aim) * d });

  state = step(state, {}, [
    { type: 'spawnVehicle', vehicleId: 90001, kind: 'car', x: me.pos.x, y: me.pos.y, heading: aim },
    { type: 'grantWeapon', playerId: 1, weaponId: 'smg', ammo: 200 },
  ], map);
  // Get in, then have the garage bolt the guns on.
  state = step(state, { 1: { ...NULL_INPUT, seq: 1, tick: 1, action: true, aimAngle: aim } }, [], map);
  state = step(state, {}, [{ type: 'fitVehicle', playerId: 1, fitting: 'guns', ammo: 200 }], map);

  // The mark: a live officer 120 px down the barrel.
  const mark = createCop(50001, at(120), 999999, 'patrol');
  mark.targetId = null;
  insertEntity(state.cops, mark);
  if (withCorpse) {
    // ...and a body between them, 60 px out. health<=0 IS the corpse state.
    const body = createCop(50002, at(60), 50, 'patrol');
    body.health = 0;
    insertEntity(state.cops, body);
  }
  return { state, aim };
}

function run(withCorpse, useHandgun) {
  let { state, aim } = stage(withCorpse, useHandgun);
  const before = state.cops.byId[50001].health;
  const events = [];
  // One volley: `fitting` for the car guns, `fire` for the hand weapon.
  const input = {
    ...NULL_INPUT, seq: 9, tick: 9, aimAngle: aim,
    fitting: !useHandgun, fire: useHandgun,
  };
  state = step(state, { 1: input }, [], map, events);
  const after = state.cops.byId[50001].health;
  const shot = events.find((e) => e.type === 'shot');
  return { dealt: before - after, reach: shot ? Math.round(Math.hypot(shot.x1 - shot.x0, shot.y1 - shot.y0)) : -1 };
}

for (const [label, corpse, hand] of [
  ['car guns, clear line   (CONTROL)', false, false],
  ['car guns, corpse at 60px        ', true, false],
  ['smg     , clear line   (CONTROL)', false, true],
  ['smg     , corpse at 60px        ', true, true],
]) {
  const r = run(corpse, hand);
  console.log(`${label}  damage to the live officer 120px away = ${r.dealt}   tracer reached ${r.reach}px`);
}

/**
 * Part 2 — the same missing filter in the projectile pass.
 * `nearestHitAlong` (projectiles.ts:186-190) also considers every cop, so a
 * rocket bursts against a body instead of flying through it.
 */
function rocket(withCorpse) {
  let { state, aim } = stage(withCorpse, true);
  // Out of the car and on foot with a launcher, so this is the plain
  // projectile path and nothing else.
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
console.log(`rocket  , clear line   (CONTROL)  damage to the live officer 120px away = ${rocket(false)}`);
console.log(`rocket  , corpse at 60px          damage to the live officer 120px away = ${rocket(true)}`);
