/**
 * Lens C, finding 2: `noticedBy` (police.ts:172-188) applies neither of the
 * two filters `copSees`/`anyCopSees` apply — a downed officer still witnesses
 * crimes, and an invisible player is still seen.
 *
 *   node evidence/round1/C-repro-corpse-witness.mjs
 *
 * A player fires 60 rounds of the SILENCED pistol (noiseRadius 34) at an
 * officer standing 80 px away, i.e. far outside the noise radius, so the only
 * thing that can generate heat is the sight branch of `noticedBy`.
 */
import {
  createGameState, generateCity, NULL_INPUT, step, createCop, insertEntity, noticedBy,
  POWER_INVISIBLE,
} from '../../shared/dist/index.js';
import { loadSharedTuning, loadWorldgenParams } from '../../server/dist/tuning.js';

loadSharedTuning('normal');
const map = generateCity(6006, loadWorldgenParams());

function run(label, { cop, dead = false, invisible = false }) {
  let state = createGameState(7);
  state = step(state, {}, [
    { type: 'spawnPlayer', playerId: 1, name: 'p' },
    { type: 'grantWeapon', playerId: 1, weaponId: 'silenced', ammo: 500 },
  ], map);
  const p = state.players.byId[1];
  p.heat = 0;
  if (invisible) { p.powerFlags |= POWER_INVISIBLE; p.powerUntilTick = 1e6; }
  if (cop) {
    const c = createCop(state.nextEntityId++, { x: p.pos.x + 80, y: p.pos.y, heading: 0 }, 50, 'patrol');
    if (dead) c.health = 0;
    insertEntity(state.cops, c);
  }
  const verdict = noticedBy(state, map, state.players.byId[1], 34);
  for (let i = 0; i < 60; i++) {
    const me = state.players.byId[1];
    if (invisible) { me.powerFlags |= POWER_INVISIBLE; me.powerUntilTick = 1e6; }
    state = step(state, { 1: { ...NULL_INPUT, seq: i + 1, tick: i, fire: true, aimAngle: Math.PI } }, [], map);
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
