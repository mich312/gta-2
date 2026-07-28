import { getVehicleTuning, initTuning } from 'shared';
import vehiclesJson from 'shared/data/vehicles.json';
import playerJson from 'shared/data/player.json';
import weaponsJson from 'shared/data/weapons.json';
import { SpriteSheet } from '../render/sprites.js';
import { Effects } from '../render/effects.js';
import { LightPass } from '../render/lighting.js';
import { drawVehicle } from '../render/renderer.js';
import { RENDER_SCALE } from '../render/config.js';

/**
 * Every vehicle in the game, at game scale, through the real `drawVehicle`.
 *
 * The point is the SILHOUETTES side by side. Colour variation existed long
 * before shape variation did, so a contact sheet of one car in ten colours
 * looked like variety and a street full of them did not — this is the sheet
 * that shows whether the six new civilian bodies actually read as different
 * cars, and whether a motorcycle reads as a motorcycle from above.
 *
 * Open `/vehicle-sheet.html` against the dev server.
 */

const COLS = 4;
const CELL_W = 100;
const CELL_H = 40;
const ZOOM = 2;

async function main(): Promise<void> {
  initTuning({ player: playerJson, vehicles: vehiclesJson, weapons: weaponsJson });
  const sprites = new SpriteSheet();
  await sprites.load();

  // Everything the parser knows about, in file order — so a kind added to
  // vehicles.json and forgotten in the art shows up here as a blank.
  const kinds = Object.keys(getVehicleTuning('car') ? vehiclesJson : {}).filter(
    (k) => k !== 'fire',
  );

  const canvas = document.getElementById('sheet') as HTMLCanvasElement;
  const rows = Math.ceil(kinds.length / COLS);
  const w = COLS * CELL_W;
  const h = rows * CELL_H + 8;
  canvas.width = w * RENDER_SCALE;
  canvas.height = h * RENDER_SCALE;
  canvas.style.width = `${w * RENDER_SCALE * ZOOM}px`;
  canvas.style.height = `${h * RENDER_SCALE * ZOOM}px`;
  const ctx = canvas.getContext('2d') as CanvasRenderingContext2D;
  ctx.imageSmoothingEnabled = false;
  ctx.fillStyle = '#2b2f36';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const effects = new Effects();
  const lights = new LightPass();
  ctx.font = `${7 * RENDER_SCALE}px monospace`;
  ctx.textBaseline = 'middle';

  kinds.forEach((kind, i) => {
    const col = i % COLS;
    const row = Math.floor(i / COLS);
    const cx = (col * CELL_W + 52) * RENDER_SCALE;
    const cy = (8 + row * CELL_H + CELL_H / 2) * RENDER_SCALE;
    ctx.fillStyle = '#c8d0d8';
    ctx.fillText(kind, (col * CELL_W + 4) * RENDER_SCALE, cy);
    const t = getVehicleTuning(kind);
    drawVehicle(
      ctx,
      sprites,
      lights,
      effects,
      i * 7 + 1,
      kind,
      0,
      0,
      0,
      0,
      true,
      'ok',
      0,
      [0, 0, 0, 0],
      0,
      t.health,
      () => cx,
      () => cy,
      0,
      0,
      0,
      0,
      // A two-wheeler carries whoever is on it; anything with a roof ignores
      // this, so passing a rider unconditionally is the honest test.
      'player_v0_f0',
    );
  });
}

void main();
