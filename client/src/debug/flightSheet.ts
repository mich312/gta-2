import {
  createGameState,
  createPlayer,
  createVehicle,
  canTakeOff,
  generateCity,
  initTuning,
  insertEntity,
  parseWorldgenParams,
  takeSnapshot,
  T_RUNWAY,
  TILE_SIZE,
  type CityMap,
  type PlayerState,
  type VehicleState,
} from 'shared';
import playerJson from 'shared/data/player.json';
import vehiclesJson from 'shared/data/vehicles.json';
import weaponsJson from 'shared/data/weapons.json';
import policeJson from 'shared/data/police.json';
import worldgenJson from 'shared/data/worldgen.json';
import { Hud } from '../render/hud.js';
import { hudTransform } from '../render/canvas.js';
import { RENDER_SCALE } from '../render/config.js';
import { setViewport, fixedViewport } from '../render/viewport.js';

/**
 * The flight control, at every state it can be in.
 *
 * Altitude used to be the throttle: hold forward and a helicopter climbed,
 * let go and it sank. Two controls in one, and neither did its job — you
 * could not fly level at speed, you could not descend without cutting the
 * engine, and there was no moment at which the pilot decided to leave the
 * ground. Take-off and landing are one key now, and a key nobody is told
 * about is a key nobody presses, so this is the readout that tells them.
 *
 * The interesting state is the REFUSAL. A plane parked in a side street will
 * not take off however hard the key is pressed, and a prompt that says "take
 * off" there teaches the player the control is broken; it says what the
 * aeroplane is waiting for instead, which is also the shortest description of
 * what a runway is for.
 *
 * Same shape as `hudSheet`: the real `Hud`, drawn over real state, with the
 * states chosen rather than provoked. `canTakeOff` is asked of the sim, so
 * what this photographs is what the key would actually do.
 *
 * Open `/flight-sheet.html` against the dev server.
 */

interface Row {
  label: string;
  note: string;
  kind: string;
  /** Mutations onto a fresh, parked aircraft. */
  set: (v: VehicleState) => void;
}

const ROWS: Row[] = [
  {
    label: 'helicopter, on the ground',
    note: 'a rotor needs no run-up: the key is live',
    kind: 'chopper',
    set: () => {},
  },
  {
    label: 'helicopter, the instant it latches',
    note: 'asked for, not yet off the ground',
    kind: 'chopper',
    set: (v) => {
      v.climb = true;
    },
  },
  {
    label: 'helicopter, at cruise',
    note: 'up. the same key puts it down again',
    kind: 'chopper',
    set: (v) => {
      v.climb = true;
      v.z = 48;
    },
  },
  {
    label: 'helicopter, coming down',
    note: 'latch dropped, throttle untouched',
    kind: 'chopper',
    set: (v) => {
      v.climb = false;
      v.z = 30;
    },
  },
  {
    label: 'plane, parked in a street',
    note: 'the refusal, and what it is waiting for',
    kind: 'plane',
    set: () => {},
  },
  {
    label: 'plane, rolling on a runway',
    note: 'past takeoffSpeed, on the strip: live',
    kind: 'plane',
    set: (v) => {
      v.speed = 200;
    },
  },
];

// The design frame, not a crop of it: the prompt is centred, so photographing
// it in a narrower viewport than the game ever uses would misreport the layout.
const VIEW_W = 480;
const VIEW_H = 200;
/**
 * The bottom strip actually copied. The prompt sits in the band above the
 * respect panel, at the foot of the screen, so unlike the wanted sheet this
 * crops from the bottom — the same honest crop, at the other end of the frame.
 */
const BAND_H = 56;
const CELL_H = BAND_H + 18;
const ZOOM = 2;

/** A runway tile on the generated map, for the one row that needs to be on one. */
function runwaySpot(map: CityMap): { x: number; y: number } | null {
  for (let ty = 0; ty < map.heightTiles; ty++) {
    for (let tx = 0; tx < map.widthTiles; tx++) {
      if (map.tiles[ty * map.widthTiles + tx] === T_RUNWAY) {
        return { x: (tx + 0.5) * TILE_SIZE, y: (ty + 0.5) * TILE_SIZE };
      }
    }
  }
  return null;
}

function main(): void {
  initTuning({
    player: playerJson,
    vehicles: vehiclesJson,
    weapons: weaponsJson,
    police: policeJson,
  });
  setViewport(fixedViewport(VIEW_W, VIEW_H));

  const map = generateCity(1, parseWorldgenParams(worldgenJson));
  const strip = runwaySpot(map);
  const street = map.vehicleSpawns[0] ?? { x: 160, y: 160 };

  const canvas = document.getElementById('sheet') as HTMLCanvasElement;
  canvas.width = VIEW_W * RENDER_SCALE;
  canvas.height = ROWS.length * CELL_H * RENDER_SCALE;
  canvas.style.width = `${VIEW_W * RENDER_SCALE * ZOOM}px`;
  canvas.style.height = `${ROWS.length * CELL_H * RENDER_SCALE * ZOOM}px`;
  const ctx = canvas.getContext('2d') as CanvasRenderingContext2D;
  ctx.imageSmoothingEnabled = false;

  const frame = document.createElement('canvas');
  frame.width = VIEW_W * RENDER_SCALE;
  frame.height = VIEW_H * RENDER_SCALE;
  const fctx = frame.getContext('2d') as CanvasRenderingContext2D;
  fctx.imageSmoothingEnabled = false;

  const snapshot = takeSnapshot(createGameState(1));

  ROWS.forEach((row, i) => {
    // On the runway for the rolling plane, on an ordinary kerb for everything
    // else — because that is exactly the difference the prompt reports.
    const at = row.kind === 'plane' && row.label.includes('runway') && strip ? strip : street;
    const state = createGameState(1);
    const v = createVehicle(1, row.kind, { x: at.x, y: at.y }, 0);
    row.set(v);
    insertEntity(state.vehicles, v);

    const hud = new Hud();
    const me: PlayerState = createPlayer(1, 'pilot', { x: at.x, y: at.y });
    me.mode = 'driving';
    me.vehicleId = v.id;
    me.weapons = [{ weaponId: 'pistol', ammo: 120 }];
    me.activeWeapon = 0;
    hud.aircraft = {
      airborne: v.z > 0,
      climbing: v.climb,
      ready: canTakeOff(v, map),
    };

    fctx.setTransform(1, 0, 0, 1, 0, 0);
    fctx.fillStyle = i % 2 === 0 ? '#22262c' : '#1c2025';
    fctx.fillRect(0, 0, frame.width, frame.height);
    hudTransform(fctx);
    hud.draw(fctx, me, snapshot, { x: 0, y: 0 }, Math.abs(v.speed));

    const top = i * CELL_H * RENDER_SCALE;
    ctx.drawImage(
      frame,
      0,
      frame.height - BAND_H * RENDER_SCALE,
      frame.width,
      BAND_H * RENDER_SCALE,
      0,
      top,
      frame.width,
      BAND_H * RENDER_SCALE,
    );

    ctx.font = `${6 * RENDER_SCALE}px monospace`;
    ctx.textBaseline = 'top';
    ctx.fillStyle = '#9aa6b4';
    ctx.fillText(row.label, 4 * RENDER_SCALE, top + (BAND_H + 2) * RENDER_SCALE);
    ctx.fillStyle = '#6c7683';
    ctx.fillText(row.note, 4 * RENDER_SCALE, top + (BAND_H + 10) * RENDER_SCALE);
  });
}

main();
