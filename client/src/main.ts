import {
  type Catalog,
  type CityMap,
  type GameEvent,
  type ShopKind,
  type Vec2,
  Predictor,
  SnapshotSync,
  TICK_MS,
  TILE_SIZE,
  generateCity,
  initTuning,
} from 'shared';
import { hudTransform, setupCanvas } from './render/canvas.js';
import { computeCamera, render, type Scene } from './render/renderer.js';
import { SpriteSheet } from './render/sprites.js';
import { TileLayer } from './render/tiles.js';
import { Effects } from './render/effects.js';
import { LightPass } from './render/lighting.js';
import { PoseSmoother } from './render/smoothing.js';
import { Connection } from './net/connection.js';
import { Interpolator } from './net/interpolation.js';
import { InputSource } from './input/keyboard.js';
import { NetStats } from './debug/stats.js';
import { DebugOverlay } from './debug/overlay.js';
import { Hud } from './render/hud.js';

function serverUrl(): string {
  const override = new URLSearchParams(location.search).get('server');
  return override ?? `ws://${location.hostname}:8080`;
}

function playerName(): string {
  let name = sessionStorage.getItem('playerName');
  if (!name) {
    name = `guest-${Math.random().toString(36).slice(2, 7)}`;
    sessionStorage.setItem('playerName', name);
  }
  return name;
}

const canvas = document.getElementById('game') as HTMLCanvasElement;
const screen = setupCanvas(canvas);
const overlay = new DebugOverlay();
const input = new InputSource(screen, () => overlay.toggle());
const stats = new NetStats();
const sync = new SnapshotSync();
const predictor = new Predictor();
const interp = new Interpolator();
const sprites = new SpriteSheet();
const tiles = new TileLayer(sprites);
const effects = new Effects();
const lights = new LightPass();
const playerPose = new PoseSmoother();
const vehiclePose = new PoseSmoother();
const hud = new Hud();

// The tile cache bakes sprites (trees, bushes, yard clutter) into its chunks,
// so anything built before the sheet arrives has to be thrown away.
void sprites.load().then(() => tiles.invalidate());

function nameOf(id: number): string {
  if (id === -1) return 'the streets';
  return sync.latest?.players.find((p) => p.id === id)?.name ?? `#${id}`;
}

let playerId = -1;
let seq = 1;
let localTick = 0;
let map: CityMap | null = null;
let catalog: Catalog | null = null;

/** Shop whose doorway the (predicted) local player is standing in. */
function currentShopKind(): ShopKind | null {
  const me = predictor.predicted;
  if (!me || !map || me.mode !== 'foot') return null;
  for (const s of map.shops) {
    const cx = (s.doorX + 0.5) * TILE_SIZE;
    const cy = (s.doorY + 0.5) * TILE_SIZE;
    if (Math.abs(me.pos.x - cx) < TILE_SIZE * 1.25 && Math.abs(me.pos.y - cy) < TILE_SIZE * 1.25) {
      return s.kind;
    }
  }
  return null;
}

/** Current predicted poses, in the form the smoothers want. */
function playerPoseNow(): { x: number; y: number; angle: number } | null {
  const me = predictor.predicted;
  return me ? { x: me.pos.x, y: me.pos.y, angle: me.aimAngle } : null;
}

function vehiclePoseNow(): { x: number; y: number; angle: number } | null {
  const v = predictor.predictedVehicle;
  return v ? { x: v.pos.x, y: v.pos.y, angle: v.heading } : null;
}

function onStateUpdated(ackSeq: number | null): void {
  if (!sync.latest || !map) return;
  interp.push(sync.latest);
  const me = sync.latest.players.find((p) => p.id === playerId);
  if (me) {
    const myVehicle =
      me.vehicleId !== null
        ? (sync.latest.vehicles.find((v) => v.id === me.vehicleId) ?? null)
        : null;
    predictor.reconcile(me, myVehicle, ackSeq ?? me.lastInputSeq, map);
    // Corrections move the smoothing target, not its origin, so they arrive as
    // a glide over the remainder of the tick rather than a visible snap.
    playerPose.correct(playerPoseNow());
    vehiclePose.correct(vehiclePoseNow());
  }
}

/** Turn the sim's discrete events into muzzle flashes, sparks and stains. */
function onGameEvent(event: GameEvent): void {
  if (event.type === 'shot') {
    const angle = Math.atan2(event.y1 - event.y0, event.x1 - event.x0);
    effects.muzzleFlash(event.x0, event.y0, angle);
    effects.impact(event.x1, event.y1, angle);
  } else if (event.type === 'propDown') {
    effects.debris(event.x, event.y);
  } else if (event.type === 'kill') {
    const victim = sync.latest?.players.find((p) => p.id === event.victimId);
    if (victim) effects.blood(victim.pos.x, victim.pos.y, Math.random() * Math.PI * 2);
  }
}

const conn = new Connection({
  url: serverUrl(),
  name: playerName(),
  stats,
  getResumeToken: () => sessionStorage.getItem('resumeToken'),
  onMessage: (msg) => {
    switch (msg.type) {
      case 'welcome':
        playerId = msg.playerId;
        localTick = msg.tick;
        sessionStorage.setItem('resumeToken', msg.resumeToken);
        // Tunables + worldgen come from the server (single source of truth);
        // the whole city regenerates locally from the seed.
        initTuning(msg.tuning);
        map = generateCity(msg.seed, msg.worldgen);
        tiles.setMap(map);
        catalog = msg.catalog;
        sync.applyServerMessage(msg);
        stats.onSnapshot();
        onStateUpdated(null);
        break;
      case 'snapshot':
        sync.applyServerMessage(msg);
        stats.onSnapshot();
        onStateUpdated(msg.ackSeq);
        break;
      case 'full':
        sync.applyServerMessage(msg);
        stats.onSnapshot();
        onStateUpdated(null);
        break;
      case 'pong':
        stats.onPong(msg.t);
        break;
      case 'event':
        if (msg.event.type === 'notice') hud.notice(msg.event.text);
        else {
          hud.onEvent(msg.event, nameOf);
          onGameEvent(msg.event);
        }
        break;
      case 'wallet':
        hud.cash = msg.cash;
        break;
      case 'account':
        hud.accountName = msg.ok ? msg.username : hud.accountName;
        hud.notice(msg.message);
        break;
      case 'error':
        console.log(msg);
        break;
    }
  },
});
conn.connect();

setInterval(() => conn.ping(performance.now()), 1000);

/**
 * Frame budget guards. `MAX_CATCHUP_TICKS` stops a stalled tab — or a blocking
 * `window.prompt` — from dumping a hundred queued ticks into one frame; the old
 * loop had no bound, so coming back to the tab locked it up. `MAX_FRAME_MS`
 * throws away the one absurd delta a stall produces instead of simulating
 * through it.
 */
const MAX_CATCHUP_TICKS = 5;
const MAX_FRAME_MS = 250;

let last = performance.now();
let acc = 0;
let cam: Vec2 = { x: 0, y: 0 };

function frame(now: number): void {
  const rawMs = now - last;
  last = now;
  const frameMs = rawMs > MAX_FRAME_MS || rawMs < 0 ? TICK_MS : rawMs;
  stats.onFrame(rawMs);
  acc = Math.min(acc + frameMs, TICK_MS * MAX_CATCHUP_TICKS);

  // Sample + send + locally predict inputs on the fixed tick grid.
  while (acc >= TICK_MS && map) {
    acc -= TICK_MS;
    localTick++;
    const shown = playerPose.sample(1);
    const playerScreen = shown ? { x: shown.x - cam.x, y: shown.y - cam.y } : null;
    const intent = input.sample(seq++, localTick, playerScreen);
    conn.sendInput(sync.ackTick, [intent]);
    predictor.applyLocalInput(intent, map);
    playerPose.advance(playerPoseNow());
    vehiclePose.advance(vehiclePoseNow());
  }

  interp.advance(frameMs);
  stats.update();

  // Shop + account interactions (requests only; server validates).
  const shopKind = currentShopKind();
  const buyRow = input.consumeBuyRow();
  if (shopKind && catalog && buyRow !== null) {
    const row = hud.shopRows(catalog, shopKind)[buyRow];
    if (row) conn.send({ type: 'buy', itemId: row[0] });
  }
  const accountAction = input.consumeAccountAction();
  if (accountAction) {
    const username = window.prompt(`${accountAction}: username`) ?? '';
    const password = username ? (window.prompt(`${accountAction}: password`) ?? '') : '';
    if (username && password) conn.send({ type: accountAction, username, password });
  }

  // Everything below renders at display rate, on the sub-tick timeline.
  const alpha = acc / TICK_MS;
  const smoothPlayer = playerPose.sample(alpha);
  const smoothVehicle = vehiclePose.sample(alpha);
  const driving = predictor.predicted?.mode === 'driving';
  cam = computeCamera(map, (driving ? smoothVehicle : smoothPlayer) ?? smoothPlayer);

  const scene: Scene | null = sync.latest
    ? {
        local: predictor.predicted,
        localPos: smoothPlayer,
        localVehicle:
          driving && smoothVehicle
            ? {
                pos: smoothVehicle,
                heading: smoothVehicle.angle,
                speed: predictor.predictedVehicle?.speed ?? 0,
              }
            : null,
        remotes: interp.sample(playerId, driving ? (predictor.predicted?.vehicleId ?? null) : null),
        dt: frameMs / 1000,
        nowMs: now,
      }
    : null;
  render(screen, map, scene, cam, sprites, tiles, effects, lights);

  // HUD and overlay draw in world-pixel units, whatever the backing store is.
  hudTransform(screen.ctx);
  if (shopKind && catalog) {
    hud.drawShop(screen.ctx, shopKind, hud.shopRows(catalog, shopKind));
  }
  hud.draw(screen.ctx, predictor.predicted ?? null, sync.latest, cam);

  const authoritative = sync.latest?.players.find((p) => p.id === playerId) ?? null;
  overlay.draw(screen.ctx, {
    stats,
    snapshot: sync.latest,
    cam,
    localPlayerId: playerId,
    predictedPos: predictor.predicted?.pos ?? null,
    authoritativePos: authoritative?.pos ?? null,
    desyncs: sync.desyncs,
    fullResyncs: sync.fullResyncs,
  });

  // E2E/debug affordance: lets automated tests read the local player's
  // state without scraping pixels. Not used by the game itself.
  (window as unknown as Record<string, unknown>)['__debug'] = {
    me: predictor.predicted,
    // Where the avatar is actually drawn this frame, as opposed to the
    // tick-quantised prediction above. The gap between the two is the
    // sub-tick smoothing doing its job.
    renderPos: smoothPlayer,
    cam: { x: cam.x, y: cam.y },
    tick: sync.latest?.tick ?? -1,
    cops: sync.latest?.cops.length ?? 0,
    vehicles: sync.latest?.vehicles.length ?? 0,
    peds: sync.latest?.peds.length ?? 0,
    props: sync.latest?.props.length ?? 0,
    fps: stats.fps,
    frameMs: stats.frameMs,
    frameMsPeak: stats.frameMsPeak,
  };

  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
