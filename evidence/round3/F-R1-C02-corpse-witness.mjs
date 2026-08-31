/**
 * R1-C02: `noticedBy` skipped both filters the rest of the sight code applies
 * — a downed officer still witnessed crimes, and an invisible player was
 * still seen.
 *
 *   node evidence/round3/F-R1-C02-corpse-witness.mjs
 *
 * A player fires 60 rounds of the SILENCED pistol (noiseRadius 34) with an
 * officer standing 80 px away, i.e. far outside the noise radius, so the only
 * thing that can generate heat is the SIGHT branch of `noticedBy`. The shot
 * goes the other way, so what is measured is being seen, not being shot at.
 *
 * This is `evidence/round1/C-repro-corpse-witness.mjs` with its staging
 * repaired. That script posts the officer at a hard-coded +80 px in x, which
 * was open ground at round 1 and is inside a wall after the round-2/3
 * worldgen work — so it now prints `false` on every row, including its own
 * live-and-visible control, and shows nothing either way. Here the officer is
 * placed 80 px along a direction with a clear line (the same rule
 * `shared/test/helpers.ts` uses), and the control lights up again.
 *
 * Before the fix all four officer rows read `true` / heat 18.0: the corpse and
 * the invisible fugitive were witnesses identically to a live officer watching
 * a visible one. After it only the live-and-visible control does.
 */
import {
  createGameState, generateCity, NULL_INPUT, step, createCop, insertEntity, noticedBy,
  POWER_INVISIBLE, rayWallDistance,
} from '../../shared/dist/index.js';
import { loadSharedTuning, loadWorldgenParams } from '../../server/dist/tuning.js';

loadSharedTuning('normal');
const map = generateCity(6006, loadWorldgenParams());

/** A direction from `from` with at least `need` px of clear line. */
function clearAim(from, need) {
  const angles = [0, Math.PI, Math.PI / 2, -Math.PI / 2];
  for (let i = 0; i < 16; i++) angles.push((i * Math.PI) / 8);
  for (const a of angles) {
    if (rayWallDistance(map, from.x, from.y, Math.cos(a), Math.sin(a), need + 20) >= need) return a;
  }
  throw new Error('no clear direction from that point');
}

function run(label, { cop, dead = false, invisible = false }) {
  let state = createGameState(7);
  state = step(state, {}, [
    { type: 'spawnPlayer', playerId: 1, name: 'p' },
    { type: 'grantWeapon', playerId: 1, weaponId: 'silenced', ammo: 500 },
  ], map);
  const p = state.players.byId[1];
  p.heat = 0;
  const aim = clearAim(p.pos, 100);
  if (invisible) { p.powerFlags |= POWER_INVISIBLE; p.powerUntilTick = 1e6; }
  if (cop) {
    const c = createCop(state.nextEntityId++, {
      x: p.pos.x + Math.cos(aim) * 80, y: p.pos.y + Math.sin(aim) * 80, heading: 0,
    }, 50, 'patrol');
    if (dead) c.health = 0;
    insertEntity(state.cops, c);
  }
  const verdict = noticedBy(state, map, state.players.byId[1], 34);
  for (let i = 0; i < 60; i++) {
    const me = state.players.byId[1];
    if (invisible) { me.powerFlags |= POWER_INVISIBLE; me.powerUntilTick = 1e6; }
    state = step(state, { 1: { ...NULL_INPUT, seq: i + 1, tick: i, fire: true, aimAngle: aim + Math.PI } }, [], map);
  }
  const me = state.players.byId[1];
  console.log(
    `${label.padEnd(34)} noticedBy(noise 34) = ${String(verdict).padEnd(5)}` +
    `  heat after 60 silenced shots = ${me.heat.toFixed(1)}  unseenTicks = ${me.unseenTicks}`,
  );
}

run('no officer at all (control)', { cop: false });
run('one LIVE officer, 80 px away', { cop: true });
run('one DEAD officer (a corpse)', { cop: true, dead: true });
run('LIVE officer, player INVISIBLE', { cop: true, invisible: true });
run('DEAD officer, player INVISIBLE', { cop: true, dead: true, invisible: true });
