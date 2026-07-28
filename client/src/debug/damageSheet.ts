import {
  PART_BONNET,
  PART_BUMPER_F,
  PART_BUMPER_R,
  PART_DOOR_L,
  PART_HEADLIGHT_L,
  PART_HEADLIGHT_R,
  PART_RADIATOR,
  PART_TAILLIGHT_L,
  PART_WINDSCREEN,
  PARTS_ALL,
  getVehicleTuning,
  initTuning,
} from 'shared';
import vehiclesJson from 'shared/data/vehicles.json';
import playerJson from 'shared/data/player.json';
import { SpriteSheet } from '../render/sprites.js';
import { Effects } from '../render/effects.js';
import { LightPass } from '../render/lighting.js';
import { drawVehicle } from '../render/renderer.js';
import { RENDER_SCALE } from '../render/config.js';
import { BASE_VIEW_H, BASE_VIEW_W } from '../render/viewport.js';

/** The sheet is a fixed contact print, not a game frame. */
const VIEW_W = BASE_VIEW_W;
const VIEW_H = BASE_VIEW_H;
const DEVICE_W = VIEW_W * RENDER_SCALE;
const DEVICE_H = VIEW_H * RENDER_SCALE;

/**
 * A contact sheet of the damage ladder: one car, drawn at every rung.
 *
 * Between showroom and on fire the model used to have two visible states —
 * some dents, and darker paint — and the first dent needed four full-speed
 * crashes before it appeared. This draws what it looks like now, through the
 * real `drawVehicle` and the real light pass, so it is the quickest way to
 * check the rendering after touching any of it. Same idea as the sprite
 * contact sheet `pnpm sprites -- --preview` produces.
 *
 * Open `/damage-sheet.html` against the dev server.
 */

interface Rung {
  label: string;
  /** Zone damage, as a fraction of the car's health: front/right/rear/left. */
  zones: [number, number, number, number];
  broken: number;
  condition?: string;
}

const RUNGS: Rung[] = [
  { label: 'showroom', zones: [0, 0, 0, 0], broken: 0 },
  { label: 'one knock 3%', zones: [0.035, 0, 0, 0], broken: 0 },
  { label: 'bumper off 4%', zones: [0.05, 0, 0, 0], broken: PART_BUMPER_F },
  {
    label: 'LEFT lamp out 7%',
    zones: [0.08, 0, 0, 0],
    broken: PART_BUMPER_F | PART_HEADLIGHT_L,
  },
  {
    label: 'both lamps 11%',
    zones: [0.12, 0, 0, 0],
    broken: PART_BUMPER_F | PART_HEADLIGHT_L | PART_HEADLIGHT_R,
  },
  {
    label: 'bonnet+smoke 18%',
    zones: [0.19, 0, 0, 0],
    broken: PART_BUMPER_F | PART_HEADLIGHT_L | PART_HEADLIGHT_R | PART_BONNET,
  },
  {
    label: 'glass gone 24%',
    zones: [0.25, 0, 0, 0],
    broken:
      PART_BUMPER_F | PART_HEADLIGHT_L | PART_HEADLIGHT_R | PART_BONNET | PART_WINDSCREEN,
  },
  {
    label: 'radiator 32%',
    zones: [0.34, 0, 0, 0],
    broken:
      PART_BUMPER_F |
      PART_HEADLIGHT_L |
      PART_HEADLIGHT_R |
      PART_BONNET |
      PART_WINDSCREEN |
      PART_RADIATOR,
  },
  {
    label: 'rear-ended',
    zones: [0, 0, 0.25, 0],
    broken: PART_BUMPER_R | PART_TAILLIGHT_L,
  },
  { label: 'side-swiped', zones: [0, 0, 0, 0.25], broken: PART_DOOR_L },
  {
    label: 'burnt-out wreck',
    zones: [1, 1, 1, 1],
    broken: PARTS_ALL,
    condition: 'wreck',
  },
];

const COLS = 4;
const ROWS = 3;

async function main(): Promise<void> {
  initTuning({ player: playerJson, vehicles: vehiclesJson });
  const maxHealth = getVehicleTuning('car').health;

  const sprites = new SpriteSheet();
  await sprites.load();
  const effects = new Effects();
  const lights = new LightPass();

  const canvas = document.getElementById('sheet') as HTMLCanvasElement;
  canvas.width = DEVICE_W;
  canvas.height = DEVICE_H;
  // Nearest-neighbour upscale: a car is 26 world pixels long, and the whole
  // point of the sheet is that you can see a 1-pixel dent.
  canvas.style.width = `${DEVICE_W * 4}px`;
  const ctx = canvas.getContext('2d') as CanvasRenderingContext2D;
  ctx.imageSmoothingEnabled = false;

  const cellW = VIEW_W / COLS;
  const cellH = VIEW_H / ROWS;
  const at = (i: number): { x: number; y: number } => ({
    x: ((i % COLS) + 0.5) * cellW,
    y: (Math.floor(i / COLS) + 0.5) * cellH - 5,
  });

  const dx = (n: number): number => n * RENDER_SCALE;
  const dy = (n: number): number => n * RENDER_SCALE;

  const paint = (target: CanvasRenderingContext2D, nowMs: number): void => {
    RUNGS.forEach((rung, i) => {
      const p = at(i);
      // Every car is id 3, so the dent hashes are identical down the row: what
      // changes from cell to cell is the damage, not the seed.
      drawVehicle(
        target,
        sprites,
        lights,
        effects,
        3,
        'car',
        p.x,
        p.y,
        0,
        0,
        true,
        rung.condition ?? 'ok',
        Math.min(1, rung.zones.reduce((a, b) => a + b, 0)),
        rung.zones.map((z) => Math.round(z * maxHealth)),
        rung.broken,
        maxHealth,
        dx,
        dy,
        nowMs,
      );
    });
  };

  // Warm the particle system on a throwaway surface so the smoking cells have
  // a plume rather than a single puff. Drawing into a scratch context keeps
  // the sprites from stacking up on the real one.
  const scratch = document.createElement('canvas');
  scratch.width = DEVICE_W;
  scratch.height = DEVICE_H;
  const sctx = scratch.getContext('2d') as CanvasRenderingContext2D;
  for (let i = 0; i < 90; i++) {
    paint(sctx, i * 34);
    effects.update(1 / 30);
    lights.reset();
  }

  ctx.fillStyle = '#1a1f26';
  ctx.fillRect(0, 0, DEVICE_W, DEVICE_H);
  paint(ctx, 0);
  effects.drawParticles(ctx, 0, 0, lights);
  lights.render(ctx);

  // Labels last, so the grade does not tint them.
  ctx.font = `${6 * RENDER_SCALE}px monospace`;
  ctx.textAlign = 'center';
  RUNGS.forEach((rung, i) => {
    const p = at(i);
    ctx.fillStyle = '#e2e8f0';
    ctx.fillText(rung.label, dx(p.x), dy(p.y + cellH / 2 - 6));
  });
  ctx.textAlign = 'left';

  (window as unknown as Record<string, unknown>)['__sheetReady'] = true;
}

void main();
