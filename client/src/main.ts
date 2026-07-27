import {
  type Catalog,
  type CityMap,
  type GameEvent,
  type ShopKind,
  type Vec2,
  Predictor,
  SnapshotSync,
  INTERNAL_HEIGHT,
  INTERNAL_WIDTH,
  TICK_MS,
  TILE_SIZE,
  generateCity,
  initTuning,
} from 'shared';
import { hudTransform, setupCanvas } from './render/canvas.js';
import { cameraLead, computeCamera, render, type Scene } from './render/renderer.js';
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
import { Minimap } from './render/minimap.js';
import { Audio } from './audio/audio.js';

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
const minimap = new Minimap();
const audio = new Audio();

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

/** Landmark the local player is currently inside or beside, if any. */
function currentLandmark(): string | null {
  const me = predictor.predicted;
  if (!me || !map) return null;
  for (const l of map.landmarks) {
    const x0 = l.x * TILE_SIZE - 24;
    const y0 = l.y * TILE_SIZE - 24;
    if (
      me.pos.x >= x0 &&
      me.pos.y >= y0 &&
      me.pos.x <= (l.x + l.w) * TILE_SIZE + 24 &&
      me.pos.y <= (l.y + l.h) * TILE_SIZE + 24
    ) {
      return l.name;
    }
  }
  return null;
}

/** Shop whose doorway the (predicted) local player is standing in. */
function currentShopKind(): ShopKind | null {
  const me = predictor.predicted;
  if (!me || !map) return null;
  if (me.mode !== 'foot' && me.mode !== 'driving') return null;
  for (const s of map.shops) {
    // A respray is a drive-through: you buy it from the seat, and the
    // catchment is wider because you arrive at speed.
    const driving = me.mode === 'driving';
    if (driving !== (s.kind === 'spray')) continue;
    const reach = TILE_SIZE * (s.kind === 'spray' ? 2.5 : 1.25);
    const cx = (s.doorX + 0.5) * TILE_SIZE;
    const cy = (s.doorY + 0.5) * TILE_SIZE;
    if (Math.abs(me.pos.x - cx) < reach && Math.abs(me.pos.y - cy) < reach) {
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

/**
 * Distance and stereo pan of a world point relative to the camera, for
 * positional audio. The camera is the listener, not the player: what you can
 * see is what you should be able to hear.
 */
function listen(x: number, y: number): { dist: number; pan: number } {
  const cx = cam.x + VIEW_CENTER_X;
  const cy = cam.y + VIEW_CENTER_Y;
  const dx = x - cx;
  const dy = y - cy;
  return { dist: Math.hypot(dx, dy), pan: Math.max(-1, Math.min(1, dx / VIEW_CENTER_X)) };
}

/** Turn the sim's discrete events into muzzle flashes, sparks, stains and noise. */
function onGameEvent(event: GameEvent): void {
  if (event.type === 'shot') {
    const angle = Math.atan2(event.y1 - event.y0, event.x1 - event.x0);
    effects.muzzleFlash(event.x0, event.y0, angle);
    effects.impact(event.x1, event.y1, angle);
    // The event carries no weapon id, so the shooter's active weapon names
    // the sound; a cop shot (negative id) is always the cop pistol.
    const shooter =
      event.playerId >= 0 ? sync.latest?.players.find((p) => p.id === event.playerId) : null;
    const weapon =
      event.playerId < 0
        ? 'copPistol'
        : (shooter?.weapons[shooter.activeWeapon]?.weaponId ?? 'pistol');
    const at = listen(event.x0, event.y0);
    audio.play(weapon, at.dist, at.pan);
    const hit = listen(event.x1, event.y1);
    audio.play('impact', hit.dist, hit.pan);
  } else if (event.type === 'propDown') {
    effects.debris(event.x, event.y);
    const at = listen(event.x, event.y);
    audio.play('propDown', at.dist, at.pan);
  } else if (event.type === 'explosion') {
    effects.explosion(event.x, event.y, event.radius);
    const at = listen(event.x, event.y);
    audio.play('explosion', at.dist, at.pan);
  } else if (event.type === 'pickupTaken') {
    const at = listen(event.x, event.y);
    audio.play('pickup', at.dist, at.pan);
  } else if (event.type === 'kill') {
    const victim = sync.latest?.players.find((p) => p.id === event.victimId);
    if (victim) {
      effects.blood(victim.pos.x, victim.pos.y, Math.random() * Math.PI * 2);
      const at = listen(victim.pos.x, victim.pos.y);
      audio.play('death', at.dist, at.pan);
    }
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
        minimap.setMap(map);
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
/** Half the viewport, in world px — the listener offset for positional audio. */
const VIEW_CENTER_X = INTERNAL_WIDTH / 2;
const VIEW_CENTER_Y = INTERNAL_HEIGHT / 2;
/** Smoothed camera lead. Eased so a hard corner glides instead of snapping. */
let lead: Vec2 = { x: 0, y: 0 };

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
  // AudioContext cannot start before a user gesture, so it is created on the
  // first key or click and never before.
  if (input.hasGestured) audio.resume();
  if (input.consumeMute()) hud.notice(audio.toggleMute() ? 'sound off' : 'sound on');

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

  // Camera lead, eased towards its target at a rate independent of frame
  // rate, so the view glides into a corner rather than snapping to it.
  const target = cameraLead(
    driving && smoothVehicle ? smoothVehicle.angle : null,
    predictor.predictedVehicle?.speed ?? 0,
    predictor.predicted?.vel.x ?? 0,
    predictor.predicted?.vel.y ?? 0,
  );
  const ease = 1 - Math.pow(0.0025, frameMs / 1000);
  lead = { x: lead.x + (target.x - lead.x) * ease, y: lead.y + (target.y - lead.y) * ease };
  cam = computeCamera(map, (driving ? smoothVehicle : smoothPlayer) ?? smoothPlayer, lead);

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
                condition: predictor.predictedVehicle?.condition ?? 'ok',
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
  hud.place = currentLandmark();
  hud.draw(
    screen.ctx,
    predictor.predicted ?? null,
    sync.latest,
    cam,
    predictor.predictedVehicle?.speed ?? 0,
  );
  minimap.draw(
    screen.ctx,
    predictor.predicted ?? null,
    (driving ? smoothVehicle : smoothPlayer) ?? null,
    sync.latest,
  );

  // Continuous audio: engine note tracks the predicted vehicle, sirens play
  // while police are actually on screen.
  audio.setEngine(driving ? (predictor.predictedVehicle?.speed ?? 0) : 0);
  audio.setSiren((sync.latest?.cops.length ?? 0) > 0, now);

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
    // Ambient traffic: how many streamed vehicles have an AI at the wheel,
    // and how many of those are actually under way.
    aiCars: sync.latest?.vehicles.filter((v) => (v.driverId ?? 0) < -1).length ?? 0,
    aiMoving:
      sync.latest?.vehicles.filter((v) => (v.driverId ?? 0) < -1 && Math.abs(v.speed) > 20)
        .length ?? 0,
    peds: sync.latest?.peds.length ?? 0,
    props: sync.latest?.props.length ?? 0,
    fps: stats.fps,
    frameMs: stats.frameMs,
    frameMsPeak: stats.frameMsPeak,
  };

  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
