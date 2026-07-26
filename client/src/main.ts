import {
  type Catalog,
  type CityMap,
  type ShopKind,
  Predictor,
  SnapshotSync,
  TICK_MS,
  TILE_SIZE,
  generateCity,
  initTuning,
} from 'shared';
import { setupCanvas } from './render/canvas.js';
import { RenderPipeline, type Scene } from './render/renderer.js';
import { SmoothCamera } from './render/camera.js';
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
const pipeline = new RenderPipeline();
const camera = new SmoothCamera();
const hud = new Hud();

function nameOf(id: number): string {
  if (id === -1) return 'the streets';
  return sync.latest?.players.find((p) => p.id === id)?.name ?? `#${id}`;
}

let playerId = -1;
let seq = 1;
let localTick = 0;
let map: CityMap | null = null;
let catalog: Catalog | null = null;
/** Health/mode from the previous frame, for hit + respawn feedback. */
let feltHealth: number | null = null;
let lastMode: string | null = null;

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
  }
}

/** Distance-scaled camera kick from a world-space event. */
function traumaFrom(x: number, y: number, base: number): void {
  const me = predictor.predicted;
  if (!me) return;
  const d = Math.hypot(x - me.pos.x, y - me.pos.y);
  if (d > 260) return;
  camera.addTrauma(base * (1 - d / 260));
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
        pipeline.bindMap(map);
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
      case 'event': {
        const ev = msg.event;
        if (ev.type === 'notice') {
          hud.notice(ev.text);
          break;
        }
        hud.onEvent(ev, nameOf);
        pipeline.onGameEvent(ev, performance.now());
        if (ev.type === 'shot') traumaFrom(ev.x0, ev.y0, ev.playerId === playerId ? 0.14 : 0.05);
        if (ev.type === 'propDown') traumaFrom(ev.x, ev.y, 0.2);
        if (ev.type === 'kill' || ev.type === 'death') {
          const victimId = ev.type === 'kill' ? ev.victimId : ev.playerId;
          const victim = sync.latest?.players.find((p) => p.id === victimId);
          if (victim) {
            pipeline.onKillAt(victim.pos.x, victim.pos.y, performance.now());
            traumaFrom(victim.pos.x, victim.pos.y, victimId === playerId ? 0.45 : 0.1);
          }
        }
        break;
      }
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

let last = performance.now();
let acc = 0;

function frame(now: number): void {
  const frameMs = Math.min(100, now - last);
  acc += now - last;
  last = now;

  const local = predictor.predicted;

  // Hit + respawn camera feedback from the predicted local player.
  if (local) {
    if (feltHealth !== null && local.health < feltHealth - 0.01) camera.addTrauma(0.3);
    feltHealth = local.health;
    if (lastMode === 'dead' && local.mode !== 'dead') camera.snapTo(local.pos.x, local.pos.y);
    lastMode = local.mode;
  }
  camera.update(map, local, frameMs);
  const cam = camera.pos;

  // Sample + send + locally predict inputs on the fixed tick grid.
  while (acc >= TICK_MS) {
    acc -= TICK_MS;
    localTick++;
    if (map) {
      const playerScreen = local ? { x: local.pos.x - cam.x, y: local.pos.y - cam.y } : null;
      const intent = input.sample(seq++, localTick, playerScreen);
      conn.sendInput(sync.ackTick, [intent]);
      predictor.applyLocalInput(intent, map);
    }
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

  const driving = predictor.predicted?.mode === 'driving';
  const scene: Scene | null = sync.latest
    ? {
        local: predictor.predicted,
        localVehicle: driving ? predictor.predictedVehicle : null,
        remotes: interp.sample(playerId, driving ? (predictor.predicted?.vehicleId ?? null) : null),
        tick: sync.latest.tick,
      }
    : null;
  pipeline.render(screen, map, scene, camera, now, frameMs);
  if (shopKind && catalog) {
    hud.drawShop(screen.ctx, shopKind, hud.shopRows(catalog, shopKind));
  }
  hud.draw(screen.ctx, predictor.predicted ?? null, sync.latest, frameMs);
  pipeline.boundMinimap?.draw(screen.ctx, predictor.predicted ?? null, sync.latest, cam);

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
    tick: sync.latest?.tick ?? -1,
    cops: sync.latest?.cops.length ?? 0,
    props: sync.latest?.props.length ?? 0,
    lights: pipeline.lighting.points.length,
    daylight: pipeline.daylight,
    vehicles: sync.latest?.vehicles.map((v) => ({ x: v.pos.x, y: v.pos.y, d: v.driverId })) ?? [],
  };

  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
