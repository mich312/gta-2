import { initTuning } from 'shared';
import vehiclesJson from 'shared/data/vehicles.json';
import playerJson from 'shared/data/player.json';
import weaponsJson from 'shared/data/weapons.json';
import { SpriteSheet } from '../render/sprites.js';
import { Effects } from '../render/effects.js';
import { drawBody, drawCharacter, PED_VARIANTS, PLAYER_VARIANTS } from '../render/renderer.js';
import { RENDER_SCALE } from '../render/config.js';

/**
 * A contact sheet of everybody who is on the floor.
 *
 * Same idea as `damage-sheet.html`: draw the thing through the REAL renderer
 * rather than trusting the sprite generator's own preview, because the two
 * can disagree — the generator knows what it drew, and this knows what the
 * game asks for. It is the quickest way to check the bodies after touching
 * any of it, and it is why the page exists rather than a PNG: the PNG is a
 * snapshot, the page is the tool.
 *
 * Open `/body-sheet.html` against the dev server.
 */

interface Row {
  label: string;
  /** Sprite base name; `_v<n>` is appended where the sprite carries variants. */
  name: string;
  /** How many colour variants exist. 0 = the sprite has none. */
  variants: number;
  alive: boolean;
  ageSec: number;
}

const ROWS: Row[] = [
  { label: 'standing, for scale', name: 'ped', variants: PED_VARIANTS, alive: false, ageSec: 0 },
  { label: 'dead, face down', name: 'pedDeadA', variants: PED_VARIANTS, alive: false, ageSec: 6 },
  { label: 'dead, on the back', name: 'pedDeadB', variants: PED_VARIANTS, alive: false, ageSec: 6 },
  { label: 'downed, still breathing', name: 'pedDowned', variants: PED_VARIANTS, alive: true, ageSec: 6 },
  { label: 'officer', name: 'copDead', variants: 0, alive: false, ageSec: 6 },
  { label: 'on their feet: patrol', name: 'cop', variants: 0, alive: false, ageSec: 0 },
  { label: 'SWAT', name: 'copSwat', variants: 0, alive: false, ageSec: 0 },
  { label: 'federal', name: 'copFed', variants: 0, alive: false, ageSec: 0 },
  { label: 'army', name: 'copArmy', variants: 0, alive: false, ageSec: 0 },
  // Four, not six. The sheet took the pedestrian's variant count for every
  // row and drew two fallback rectangles where playerDeadA_v4 and _v5 would
  // have been — which is the contact sheet doing its job, on itself.
  { label: 'player', name: 'playerDeadA', variants: PLAYER_VARIANTS, alive: false, ageSec: 6 },
];

/** Rows drawn upright rather than on the floor. */
const STANDING = new Set(['ped', 'cop', 'copSwat', 'copFed', 'copArmy']);

/** Angles across a row: a body lies whichever way it fell. */
const ANGLES = [0, Math.PI / 6, Math.PI / 3, Math.PI / 2, (2 * Math.PI) / 3, Math.PI, -Math.PI / 2];

const CELL = 44;
const LABEL_W = 200;
/** Drawn at game scale, then blown up: these are 29px sprites. */
const ZOOM = 2;

async function main(): Promise<void> {
  initTuning({ player: playerJson, vehicles: vehiclesJson, weapons: weaponsJson });
  const sprites = new SpriteSheet();
  await sprites.load();

  const canvas = document.getElementById('sheet') as HTMLCanvasElement;
  const w = LABEL_W + ANGLES.length * CELL;
  const h = ROWS.length * CELL + 16;
  canvas.width = w * RENDER_SCALE;
  canvas.height = h * RENDER_SCALE;
  canvas.style.width = `${w * RENDER_SCALE * ZOOM}px`;
  canvas.style.height = `${h * RENDER_SCALE * ZOOM}px`;
  const ctx = canvas.getContext('2d') as CanvasRenderingContext2D;
  ctx.imageSmoothingEnabled = false;

  // Tarmac, so the blood and the drained colours read as they do in play.
  ctx.fillStyle = '#2b2f36';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const effects = new Effects();
  ctx.font = `${8 * RENDER_SCALE}px monospace`;
  ctx.textBaseline = 'middle';

  ROWS.forEach((row, r) => {
    const cy = (8 + r * CELL + CELL / 2) * RENDER_SCALE;
    ctx.fillStyle = '#c8d0d8';
    ctx.fillText(row.label, 6 * RENDER_SCALE, cy);
    ANGLES.forEach((angle, i) => {
      const cx = (LABEL_W + i * CELL + CELL / 2) * RENDER_SCALE;
      const name = row.variants > 0 ? `${row.name}_v${i % row.variants}` : row.name;
      // The standing rows go through drawCharacter, which is what the game
      // uses for anybody still upright.
      if (STANDING.has(row.name)) {
        drawCharacter(ctx, sprites, `${name}_f0`, cx, cy, angle, '#7a7f6d');
        return;
      }
      drawBody(ctx, sprites, name, cx, cy, angle, '#7a7f6d', 0, 0, {
        alive: row.alive,
        ageSec: row.ageSec,
        nowMs: 0,
        key: `sheet${r}:${i}`,
        seed: r * 31 + i,
        effects,
      });
    });
  });

  // The decals the bodies emitted while being drawn, so the blood is on the
  // ground under them rather than missing from the picture entirely.
  effects.drawDecals(ctx, 0, 0);
}

void main();
