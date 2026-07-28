import { createPlayer, initTuning, takeSnapshot, createGameState, type PlayerState } from 'shared';
import playerJson from 'shared/data/player.json';
import vehiclesJson from 'shared/data/vehicles.json';
import weaponsJson from 'shared/data/weapons.json';
import policeJson from 'shared/data/police.json';
import { Hud } from '../render/hud.js';
import { hudTransform } from '../render/canvas.js';
import { RENDER_SCALE } from '../render/config.js';
import { setViewport, fixedViewport } from '../render/viewport.js';

/**
 * The wanted readout, at every state it can be in.
 *
 * Wave P's whole player-facing half is this corner of the screen: whether
 * you are getting away with it. An escape the player cannot perceive is not
 * a mechanic, so the stars dim the moment nobody has eyes on you, a clock
 * counts down to the point the heat starts coming off, and it turns green
 * when it does.
 *
 * Photographing that in a live session means staging a three-star chase
 * through scripted key presses, which is unreliable for reasons that have
 * nothing to do with the feature (see `ci/play.mjs`). So this does what
 * `damage-sheet.html` already does for the damage panel: draw the REAL `Hud`
 * with real `PlayerState`, and let the states be chosen rather than
 * provoked. The drawing is the thing under test; the chase that produces it
 * is covered by `shared/test/police.test.ts` and `pnpm chase`.
 *
 * Open `/hud-sheet.html` against the dev server.
 */

interface Row {
  label: string;
  note: string;
  /** Mutations onto a fresh player. */
  set: (p: PlayerState) => void;
}

const cool = policeJson.wantedCooldownTicks;

const ROWS: Row[] = [
  {
    label: 'in view',
    note: 'they can see you: bright, no clock',
    set: (p) => {
      p.heat = 310;
      p.wantedLevel = 3;
      p.unseenTicks = 0;
    },
  },
  {
    label: 'out of sight, 3s',
    note: 'dimmed, and counting down',
    set: (p) => {
      p.heat = 310;
      p.wantedLevel = 3;
      p.unseenTicks = 1;
    },
  },
  {
    label: 'out of sight, 1s',
    note: 'nearly there',
    set: (p) => {
      p.heat = 310;
      p.wantedLevel = 3;
      p.unseenTicks = cool - 30;
    },
  },
  {
    label: 'clear',
    note: 'green: the heat is coming off',
    set: (p) => {
      p.heat = 310;
      p.wantedLevel = 3;
      p.unseenTicks = cool + 60;
    },
  },
  {
    label: 'five stars, clear',
    note: 'the same, at the top of the ladder',
    set: (p) => {
      p.heat = 510;
      p.wantedLevel = 5;
      p.unseenTicks = cool + 200;
    },
  },
  {
    label: 'not wanted',
    note: 'nothing at all — the common case',
    set: (p) => {
      p.heat = 0;
      p.wantedLevel = 0;
      p.unseenTicks = 0;
    },
  },
];

/**
 * The band of the frame the wanted readout lives in, and nothing else.
 *
 * The HUD draws over a whole 480x270 screen — health bottom-left, cash top-
 * left, respect across the middle — and stacking six of those makes a sheet
 * you cannot read. So each row is rendered at FULL viewport size offscreen
 * and only the top strip is copied in. That is the honest crop: it is the
 * real HUD, at real scale, with the parts this sheet is not about left out
 * of frame rather than moved.
 */
const VIEW_W = 240;
const VIEW_H = 140;
/** Top strip actually copied: stars at y=10, the clock line at y=19. */
const BAND_H = 26;
const CELL_H = BAND_H + 18;
const ZOOM = 3;

function main(): void {
  initTuning({
    player: playerJson,
    vehicles: vehiclesJson,
    weapons: weaponsJson,
    police: policeJson,
  });
  setViewport(fixedViewport(VIEW_W, VIEW_H));

  const canvas = document.getElementById('sheet') as HTMLCanvasElement;
  canvas.width = VIEW_W * RENDER_SCALE;
  canvas.height = ROWS.length * CELL_H * RENDER_SCALE;
  canvas.style.width = `${VIEW_W * RENDER_SCALE * ZOOM}px`;
  canvas.style.height = `${ROWS.length * CELL_H * RENDER_SCALE * ZOOM}px`;
  const ctx = canvas.getContext('2d') as CanvasRenderingContext2D;
  ctx.imageSmoothingEnabled = false;

  // One full-size frame, reused: draw the HUD into it, copy the band out.
  const frame = document.createElement('canvas');
  frame.width = VIEW_W * RENDER_SCALE;
  frame.height = VIEW_H * RENDER_SCALE;
  const fctx = frame.getContext('2d') as CanvasRenderingContext2D;
  fctx.imageSmoothingEnabled = false;

  const snapshot = takeSnapshot(createGameState(1));

  ROWS.forEach((row, i) => {
    const hud = new Hud();
    const me = createPlayer(1, 'you', { x: 0, y: 0 });
    me.weapons = [{ weaponId: 'pistol', ammo: 120 }];
    me.activeWeapon = 0;
    row.set(me);

    fctx.setTransform(1, 0, 0, 1, 0, 0);
    fctx.fillStyle = i % 2 === 0 ? '#22262c' : '#1c2025';
    fctx.fillRect(0, 0, frame.width, frame.height);
    hudTransform(fctx);
    hud.draw(fctx, me, snapshot, { x: 0, y: 0 }, 0);

    const top = i * CELL_H * RENDER_SCALE;
    ctx.drawImage(
      frame,
      0,
      0,
      frame.width,
      BAND_H * RENDER_SCALE,
      0,
      top,
      frame.width,
      BAND_H * RENDER_SCALE,
    );

    // The caption sits under the readout it explains.
    ctx.font = `${6 * RENDER_SCALE}px monospace`;
    ctx.textBaseline = 'top';
    ctx.fillStyle = '#9aa6b4';
    ctx.fillText(row.label, 4 * RENDER_SCALE, top + (BAND_H + 2) * RENDER_SCALE);
    ctx.fillStyle = '#6c7683';
    ctx.fillText(row.note, 4 * RENDER_SCALE, top + (BAND_H + 10) * RENDER_SCALE);
  });
}

main();
