import playerTuning from 'shared/data/player.json';
import { SnapshotSync, TICK_MS, initTuning } from 'shared';
import { setupCanvas } from './render/canvas.js';
import { computeCamera, render } from './render/renderer.js';
import { Connection } from './net/connection.js';
import { InputSource } from './input/keyboard.js';
import { NetStats } from './debug/stats.js';
import { DebugOverlay } from './debug/overlay.js';

initTuning({ player: playerTuning });

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

let playerId = -1;
let seq = 1;
let localTick = 0;

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
        sync.applyServerMessage(msg);
        stats.onSnapshot();
        break;
      case 'snapshot':
      case 'full':
        sync.applyServerMessage(msg);
        stats.onSnapshot();
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
  acc += now - last;
  last = now;

  const cam = computeCamera(sync.latest, playerId);
  const me = sync.latest?.players.find((p) => p.id === playerId) ?? null;

  // Sample + send inputs on the fixed tick grid, independent of frame rate.
  while (acc >= TICK_MS) {
    acc -= TICK_MS;
    localTick++;
    const playerScreen = me ? { x: me.pos.x - cam.x, y: me.pos.y - cam.y } : null;
    conn.sendInput(sync.ackTick, [input.sample(seq++, localTick, playerScreen)]);
  }

  stats.update();
  render(screen, sync.latest, playerId, cam);
  overlay.draw(screen.ctx, {
    stats,
    snapshot: sync.latest,
    cam,
    localPlayerId: playerId,
    // Prediction arrives in phase 1; until then predicted === authoritative.
    predictedPos: me ? me.pos : null,
    authoritativePos: me ? me.pos : null,
    desyncs: sync.desyncs,
    fullResyncs: sync.fullResyncs,
  });

  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
