import {
  type Catalog,
  type CityMap,
  type GameEvent,
  type ServerMessage,
  type ShopKind,
  type Vec2,
  Predictor,
  SnapshotSync,
  INTERNAL_HEIGHT,
  INTERNAL_WIDTH,
  TICK_MS,
  TILE_SIZE,
  PART_HEADLIGHT_L,
  PART_HEADLIGHT_R,
  PART_TAILLIGHT_L,
  PART_TAILLIGHT_R,
  PART_TYRE_FL,
  PART_TYRE_FR,
  PART_TYRE_RL,
  PART_TYRE_RR,
  PART_WINDSCREEN,
  generateCity,
  getVehicleTuning,
  getWeaponTuning,
  initTuning,
  vehicleWear,
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
import { Audio, stationFor } from './audio/audio.js';

function serverUrl(): string {
  const override = new URLSearchParams(location.search).get('server');
  if (override) return override;
  // Behind a TLS proxy (e.g. https://gta.mich312.com) the server shares the
  // page's origin and speaks wss on the standard port — a browser on an https
  // page refuses to open an insecure ws://. Local dev (http) keeps :8080,
  // which is also the port the container publishes, so a plain-http page and
  // the game server are on it either way. Use `?server=` for anything else.
  if (location.protocol === 'https:') return `wss://${location.host}`;
  return `ws://${location.hostname}:8080`;
}

/**
 * The one thing the player must always be told: the game cannot start, and
 * why. Drawn over the top of everything, in HUD (world-pixel) units.
 */
function drawFatal(ctx: CanvasRenderingContext2D, text: string): void {
  ctx.save();
  ctx.fillStyle = 'rgba(10, 6, 8, 0.82)';
  ctx.fillRect(0, INTERNAL_HEIGHT / 2 - 22, INTERNAL_WIDTH, 44);
  ctx.fillStyle = '#ff8a7a';
  ctx.font = '8px monospace';
  ctx.textAlign = 'center';
  // Wrapped by hand: the canvas has no text layout and the message is long.
  const words = text.split(' ');
  const lines: string[] = [];
  let line = '';
  for (const w of words) {
    if ((line + ' ' + w).trim().length > 68) {
      lines.push(line.trim());
      line = w;
    } else line += ' ' + w;
  }
  lines.push(line.trim());
  lines.slice(0, 4).forEach((l, i) => {
    ctx.fillText(l, INTERNAL_WIDTH / 2, INTERNAL_HEIGHT / 2 - 8 + i * 10);
  });
  ctx.textAlign = 'left';
  ctx.restore();
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

/** Set when something has gone wrong badly enough that the game cannot start. */
let fatal: string | null = null;
let playerId = -1;
let seq = 1;
let localTick = 0;
let map: CityMap | null = null;
let catalog: Catalog | null = null;
/** Station currently playing, so a change can be announced once. */
let lastStation: number | null = null;

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
    // Shops have an inside now, so the whole room counts as being in the shop
    // — standing at the counter is the obvious place to expect the menu.
    const r = s.interior;
    if (
      me.pos.x >= r.x * TILE_SIZE &&
      me.pos.y >= r.y * TILE_SIZE &&
      me.pos.x <= (r.x + r.w) * TILE_SIZE &&
      me.pos.y <= (r.y + r.h) * TILE_SIZE
    ) {
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
  // Collision prediction reads the newest authoritative positions, not the
  // ~100 ms interpolated ones: for the parked cars that make up most of what
  // you hit, the snapshot is exact.
  predictor.setWorld(sync.latest.vehicles);
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
    // The event carries no weapon id, so the shooter's active weapon names
    // the sound; a cop shot (negative id) is always the cop pistol.
    const shooter =
      event.playerId >= 0 ? sync.latest?.players.find((p) => p.id === event.playerId) : null;
    const weapon =
      event.playerId < 0
        ? 'copPistol'
        : (shooter?.weapons[shooter.activeWeapon]?.weaponId ?? 'pistol');
    const at = listen(event.x0, event.y0);
    const tuning = getWeaponTuning(weapon);
    if (tuning?.melee) {
      // A swing, not a shot. The sim reports both as `shot`, so the reach of
      // the ray is what says whether the punch found anything: a miss runs the
      // full range of the weapon.
      const reach = Math.hypot(event.x1 - event.x0, event.y1 - event.y0);
      const connected = reach < tuning.range - 1;
      effects.punch(event.x1, event.y1, angle, connected);
      audio.play(weapon, at.dist, at.pan);
      return;
    }
    hud.tracer(event.x0, event.y0, event.x1, event.y1);
    effects.muzzleFlash(event.x0, event.y0, angle);
    effects.impact(event.x1, event.y1, angle);
    audio.play(weapon, at.dist, at.pan);
    const hit = listen(event.x1, event.y1);
    audio.play('impact', hit.dist, hit.pan);
  } else if (event.type === 'runOver') {
    // A car connecting with somebody. Non-fatal hits used to have no outward
    // sign at all — the victim's HUD flashed and nothing else happened.
    effects.blood(event.x, event.y, event.angle);
    const at = listen(event.x, event.y);
    audio.play('thud', at.dist, at.pan);
  } else if (event.type === 'propDown') {
    effects.debris(event.x, event.y);
    const at = listen(event.x, event.y);
    audio.play('propDown', at.dist, at.pan);
  } else if (event.type === 'explosion') {
    effects.explosion(event.x, event.y, event.radius);
    const at = listen(event.x, event.y);
    audio.play('explosion', at.dist, at.pan);
  } else if (event.type === 'vehicleCollided') {
    // Metal on metal. There was no collision event at all until now, so a
    // crash was the one physical interaction in the game that made no sound:
    // you could put a car into a bus at full speed in silence.
    const at = listen(event.x, event.y);
    effects.debris(event.x, event.y);
    audio.play(event.speed > 120 ? 'crash' : 'crunch', at.dist, at.pan);
  } else if (event.type === 'vehiclePartBroke') {
    const at = listen(event.x, event.y);
    const glassy =
      (event.part & (PART_HEADLIGHT_L | PART_HEADLIGHT_R | PART_TAILLIGHT_L | PART_TAILLIGHT_R | PART_WINDSCREEN)) !== 0;
    const tyre =
      (event.part & (PART_TYRE_FL | PART_TYRE_FR | PART_TYRE_RL | PART_TYRE_RR)) !== 0;
    if (glassy) audio.play('glass', at.dist, at.pan);
    else if (tyre) audio.play('blowout', at.dist, at.pan);
    if (tyre && event.vehicleId === predictor.predicted?.vehicleId) {
      hud.notice('tyre gone — she pulls now');
    }
  } else if (event.type === 'vehicleBurning') {
    // The event has existed, been encoded and been relayed since vehicle
    // damage landed, and nothing on the client handled it: your car caught
    // fire on a seven-second fuse and said nothing at all.
    const at = listen(event.x, event.y);
    audio.play('crash', at.dist, at.pan);
    effects.debris(event.x, event.y);
    if (event.vehicleId === predictor.predicted?.vehicleId) {
      hud.notice('GET OUT — she is going up');
      hud.alarm(7);
    }
  } else if (event.type === 'frenzyEnded') {
    hud.notice(
      event.completed
        ? `frenzy complete — ${event.kills}/${event.target}`
        : `frenzy failed — ${event.kills}/${event.target}`,
    );
    if (event.completed) audio.play('pickup', 0, 0);
  } else if (event.type === 'stuntLaunched') {
    const at = listen(event.x, event.y);
    audio.play('pickup', at.dist, at.pan);
  } else if (event.type === 'stuntLanded') {
    effects.debris(event.x, event.y);
    const at = listen(event.x, event.y);
    audio.play('impact', at.dist, at.pan);
    if (event.playerId === playerId && event.distance > 40) {
      hud.notice(`stunt jump — ${event.distance}px`);
    }
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
  onDisconnected: (attempts) => {
    // A server that is not running looked exactly like one that is: the canvas
    // said "connecting…" for ever and the only clue was in the console.
    if (attempts >= 2 && playerId < 0) {
      fatal = `cannot reach the server at ${serverUrl()} — is it running? (node server/dist/index.js)`;
    }
  },
  onMessage: (msg) => {
    try {
      handleServerMessage(msg);
    } catch (err) {
      // Never let one bad message stop the game loop dead.
      fatal = `client error: ${err instanceof Error ? err.message : String(err)}`;
      console.error(err);
    }
  },
});
conn.connect();

function handleServerMessage(msg: ServerMessage): void {
  switch (msg.type) {
      case 'welcome':
        playerId = msg.playerId;
        localTick = msg.tick;
        sessionStorage.setItem('resumeToken', msg.resumeToken);
        // Tunables + worldgen come from the server (single source of truth);
        // the whole city regenerates locally from the seed.
        {
          // Lenient: the server owns these files and the client cannot fix
          // them. One unparseable number used to throw right here, killing
          // the frame loop and leaving the game on "connecting…" for ever,
          // with the reason only in a console nobody has open.
          const fellBack = initTuning(msg.tuning, { lenient: true });
          if (fellBack.length > 0) {
            const why = `server tuning not understood (${fellBack.join(', ')}) — using defaults`;
            console.warn(why);
            hud.notice(why);
          }
        }
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
        hud.setWallet(msg.cash, msg.multiplier);
        break;
      case 'exports':
        hud.setExports(msg.kinds, msg.bonus);
        break;
      case 'missionState':
        hud.setMission(msg);
        break;
      case 'account':
        hud.accountName = msg.ok ? msg.username : hud.accountName;
        hud.notice(msg.message);
        break;
      case 'error':
        // Shown, not just logged: a rejected join used to leave the canvas
        // saying "connecting…" with the reason invisible.
        console.error(msg);
        fatal = `${msg.code}: ${msg.message}`;
        break;
  }
}

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

  const missionAction = input.consumeMissionAction();
  if (missionAction) conn.send({ type: 'mission', action: missionAction });

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
                kind: predictor.predictedVehicle?.kind ?? 'car',
                pos: smoothVehicle,
                heading: smoothVehicle.angle,
                speed: predictor.predictedVehicle?.speed ?? 0,
                condition: predictor.predictedVehicle?.condition ?? 'ok',
                wear: predictor.predictedVehicle ? vehicleWear(predictor.predictedVehicle) : 0,
                zones: predictor.predictedVehicle?.zones ?? [0, 0, 0, 0],
                broken: predictor.predictedVehicle?.broken ?? 0,
                z: predictor.predicted?.z ?? 0,
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
  if (fatal) drawFatal(screen.ctx, fatal);
  if (shopKind && catalog) {
    hud.drawShop(screen.ctx, shopKind, hud.shopRows(catalog, shopKind));
  }
  hud.place = currentLandmark();
  // The fitting lives on the car, so the HUD reads it off whatever the local
  // player is sitting in — predicted, like everything else about that car.
  const myCar = predictor.predictedVehicle;
  hud.fitting = myCar?.fitting ?? '';
  hud.fittingAmmo = myCar?.fittingAmmo ?? 0;
  // The condition of the car you are in, for the damage diagram. Predicted
  // rather than snapshot-derived so the panel moves on the frame you hit
  // something rather than on the next snapshot.
  const drivenCar = predictor.predictedVehicle;
  hud.car = drivenCar
    ? {
        zones: drivenCar.zones,
        broken: drivenCar.broken,
        wear: vehicleWear(drivenCar),
        maxHealth: getVehicleTuning(drivenCar.kind).health,
      }
    : null;
  minimap.marker = hud.missionMarker;
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

  // The radio belongs to the car, not to the session: get out and it stops,
  // steal a different one and the station changes with it.
  const myCarId = predictor.predicted?.vehicleId ?? null;
  const myCarKind = predictor.predictedVehicle?.kind ?? '';
  const station = driving && myCarId !== null ? stationFor(myCarId, myCarKind) : null;
  if (station !== lastStation) {
    if (station !== null) hud.notice(`radio: ${audio.stationName(station)}`);
    lastStation = station;
  }
  audio.setRadio(station, now);

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
    // Condition of the car being driven: what the dents and the handling
    // penalty are drawn from, and the only way a test can tell a battered car
    // from a fresh one without reading pixels.
    carHealth: predictor.predictedVehicle?.health ?? null,
    carWear: predictor.predictedVehicle ? vehicleWear(predictor.predictedVehicle) : null,
    carBroken: predictor.predictedVehicle?.broken ?? null,
    carCondition: predictor.predictedVehicle?.condition ?? null,
    fps: stats.fps,
    frameMs: stats.frameMs,
    frameMsPeak: stats.frameMsPeak,
  };

  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
