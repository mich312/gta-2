import {
  type CityMap,
  Predictor,
  SnapshotSync,
  TICK_MS,
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

let playerId = -1;
let seq = 1;
let localTick = 0;
let map: CityMap | null = null;

function onStateUpdated(ackSeq: number | null): void {
  if (!sync.latest || !map) return;
  interp.push(sync.latest);
  const me = sync.latest.players.find((p) => p.id === playerId);
  if (me) {
    predictor.reconcile(me, ackSeq ?? me.lastInputSeq, map);
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

  const scene: Scene | null = sync.latest
    ? { local: predictor.predicted, remotes: interp.sample(playerId) }
    : null;
  render(screen, map, scene, cam, sprites);

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

  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
