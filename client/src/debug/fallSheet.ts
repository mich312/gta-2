import {
  createGameState,
  createPlayer,
  createVehicle,
  generateCity,
  initTuning,
  insertEntity,
  NULL_INPUT,
  parseWorldgenParams,
  step,
  type CityMap,
  type GameState,
  type PlayerState,
} from 'shared';
import playerJson from 'shared/data/player.json';
import vehiclesJson from 'shared/data/vehicles.json';
import weaponsJson from 'shared/data/weapons.json';
import policeJson from 'shared/data/police.json';
import worldgenJson from 'shared/data/worldgen.json';
import { SpriteSheet } from '../render/sprites.js';
import { Effects } from '../render/effects.js';
import { drawPlayer } from '../render/renderer.js';
import { RENDER_SCALE } from '../render/config.js';

/**
 * Bailing out of a helicopter, frame by frame, through the real `drawPlayer`.
 *
 * The fall was invisible before this sheet existed. `stepStunts` gives a player
 * who steps out at cruise height a real quarter-second of gravity and charges
 * them for the landing, but the renderer pinned every on-foot sprite to the
 * ground — so what you saw was a man standing still and then bleeding for no
 * reason. A mechanic the player cannot see is not a mechanic.
 *
 * So this is deliberately not a mock-up. The heights down the sheet come out
 * of the REAL sim: a real chopper is spawned on a real map, flown up with the
 * ordinary keys, and stepped out of, exactly as `flight.test.ts` does it. The
 * sheet only photographs what the renderer makes of each tick. If the lift or
 * the shadow regresses, the arc across this page goes flat.
 *
 * Open `/fall-sheet.html` against the dev server.
 */

const CELL_W = 30;
/** Tall enough for the whole arc: cruise height, plus a sprite and a caption. */
const CELL_H = 92;
const ZOOM = 3;
/** Every Nth tick, so a nine-tick fall reads as an arc rather than a blur. */
const SAMPLE = 1;
/** Where the tarmac is, in the cell. */
const GROUND_Y = CELL_H - 14;
const CHOPPER_ID = 9001;

interface Frame {
  z: number;
  health: number;
}

/** A player at the controls of a chopper at cruise height, via `step`. */
function aloft(map: CityMap): GameState {
  let state = createGameState(7);
  state = step(state, {}, [{ type: 'spawnPlayer', playerId: 1, name: 'pilot' }], map);
  const me = state.players.byId[1] as PlayerState;
  // A high id, well clear of the traffic the first `step` already spawned:
  // `insertEntity` throws on a collision rather than overwriting.
  const v = createVehicle(CHOPPER_ID, 'chopper', { x: me.pos.x, y: me.pos.y }, 0);
  insertEntity(state.vehicles, v);
  state = step(state, { 1: { ...NULL_INPUT, seq: 1, tick: 1, action: true } }, [], map);
  for (let i = 0; i < 150; i++) {
    state = step(state, { 1: { ...NULL_INPUT, seq: i + 2, tick: i, up: true } }, [], map);
  }
  return state;
}

/** Step out at altitude, and record the whole way down. */
function fall(): Frame[] {
  const map = generateCity(1, parseWorldgenParams(worldgenJson));
  let s = aloft(map);
  (s.players.byId[1] as PlayerState).health = 100;
  // The door is edge-triggered — a held key is one press — so getting out
  // needs the key released and pressed again.
  s = step(s, { 1: { ...NULL_INPUT, seq: 900, tick: 900 } }, [], map);
  s = step(s, { 1: { ...NULL_INPUT, seq: 901, tick: 901, action: true } }, [], map);
  const out: Frame[] = [];
  for (let i = 0; i < 300; i++) {
    const p = s.players.byId[1] as PlayerState;
    out.push({ z: p.z, health: p.health });
    if (p.z === 0 && i > 0) break;
    s = step(s, {}, [], map);
  }
  return out;
}

async function main(): Promise<void> {
  initTuning({
    player: playerJson,
    vehicles: vehiclesJson,
    weapons: weaponsJson,
    police: policeJson,
  });
  const sprites = new SpriteSheet();
  await sprites.load();

  const all = fall();
  // Every Nth tick, but never without the last: the landing is the frame the
  // whole sheet is about.
  const frames = all.filter((_, i) => i % SAMPLE === 0 || i === all.length - 1);

  const canvas = document.getElementById('sheet') as HTMLCanvasElement;
  const w = frames.length * CELL_W;
  canvas.width = w * RENDER_SCALE;
  canvas.height = CELL_H * RENDER_SCALE;
  canvas.style.width = `${w * RENDER_SCALE * ZOOM}px`;
  canvas.style.height = `${CELL_H * RENDER_SCALE * ZOOM}px`;
  const ctx = canvas.getContext('2d') as CanvasRenderingContext2D;
  ctx.imageSmoothingEnabled = false;
  ctx.fillStyle = '#3a4048';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  // A ground line, so the lift is measured against something rather than
  // asserted. Everything above it is airborne.
  ctx.fillStyle = '#2b3036';
  ctx.fillRect(0, GROUND_Y * RENDER_SCALE, canvas.width, (CELL_H - GROUND_Y) * RENDER_SCALE);

  const effects = new Effects();
  ctx.font = `${5 * RENDER_SCALE}px monospace`;
  ctx.textBaseline = 'top';

  frames.forEach((f, i) => {
    const me = createPlayer(1, 'you', { x: 0, y: 0 });
    me.weapons = [{ weaponId: 'pistol', ammo: 60 }];
    me.activeWeapon = 0;
    me.z = f.z;
    me.health = f.health;
    const cx = (i * CELL_W + CELL_W / 2) * RENDER_SCALE;
    // Facing up the page, so the sprite reads the same in every cell and the
    // only thing changing across the sheet is the height.
    drawPlayer(
      ctx,
      sprites,
      me,
      cx,
      GROUND_Y * RENDER_SCALE,
      -Math.PI / 2,
      0,
      true,
      0,
      0,
      0,
      0,
      effects,
    );

    ctx.fillStyle = f.z > 0 ? '#9aa6b4' : '#e0866c';
    ctx.fillText(`z${Math.round(f.z)}`, (i * CELL_W + 3) * RENDER_SCALE, 3 * RENDER_SCALE);
    ctx.fillStyle = f.health < 100 ? '#e0866c' : '#6c7683';
    ctx.fillText(`hp${Math.round(f.health)}`, (i * CELL_W + 3) * RENDER_SCALE, 11 * RENDER_SCALE);
  });
}

void main();
