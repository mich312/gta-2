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
import { computeCamera, render, type Scene } from './render/renderer.js';
import { SpriteSheet } from './render/sprites.js';
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
void sprites.load();
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
        else hud.onEvent(msg.event, nameOf);
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

let last = performance.now();
let acc = 0;

function frame(now: number): void {
  const frameMs = now - last;
  acc += frameMs;
  last = now;

  const local = predictor.predicted;
  const cam = computeCamera(map, local);

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
      }
    : null;
  render(screen, map, scene, cam, sprites);
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
    tick: sync.latest?.tick ?? -1,
    cops: sync.latest?.cops.length ?? 0,
  };

  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
