import {
  type WorldgenParams,
  type Catalog,
  type CityMap,
  type FullSnapshot,
  type GameEvent,
  type ServerMessage,
  type ShopKind,
  type Vec2,
  Predictor,
  SnapshotSync,
  TICK_MS,
  TILE_SIZE,
  canTakeOff,
  districtAt,
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
import { viewport } from './render/viewport.js';
import {
  cameraLead,
  computeCamera,
  drawNameTags,
  render,
  sceneNight,
  type Scene,
} from './render/renderer.js';
import { SpriteSheet } from './render/sprites.js';
import { TileLayer } from './render/tiles.js';
import { Effects } from './render/effects.js';
import { spawnSceneEffects } from './render/sceneEffects.js';
import { LightPass } from './render/lighting.js';
import { PoseSmoother } from './render/smoothing.js';
import { Connection } from './net/connection.js';
import { LocalConnection } from './net/localConnection.js';
import { CityView } from './three/cityView.js';
import { EntityLayer } from './three/entities.js';
import { SceneryLayer } from './three/scenery.js';
import { Effects3dLayer } from './three/effects3d.js';
import { WorldObjectsLayer } from './three/worldObjects.js';
import { Lights3dLayer } from './three/lights3d.js';
import type { LocalHostOptions } from './local/host.worker.js';
import { Interpolator } from './net/interpolation.js';
import { InputSource } from './input/keyboard.js';
import { NetStats } from './debug/stats.js';
import { DebugOverlay } from './debug/overlay.js';
import { Hud } from './render/hud.js';
import { Minimap } from './render/minimap.js';
import { Audio, stationFor } from './audio/audio.js';

/**
 * How high a given vehicle's horn sits. Big things sound big: it is the one
 * cue that tells you what is behind you without looking.
 */
function hornPitch(kind: string): number {
  if (kind === 'bus' || kind === 'truck' || kind === 'firetruck') return 0.62;
  if (kind === 'van' || kind === 'ambulance') return 0.8;
  if (kind === 'taxi') return 1.18;
  return 1;
}

/**
 * Offline host settings, or null to connect to a server.
 *
 * The knobs the server takes from the environment become query parameters,
 * because offline there is no environment to read — same values, same
 * defaults, different dial.
 */
function localParams(): LocalHostOptions | null {
  const q = new URLSearchParams(location.search);
  if (q.get('local') !== '1') return null;
  const int = (key: string, fallback: number): number => {
    const raw = q.get(key);
    if (raw === null) return fallback;
    const n = Number.parseInt(raw, 10);
    return Number.isFinite(n) ? n : fallback;
  };
  return {
    // Offline the seed is the player's to choose, and it has to be stable
    // across a reload or the city changes under them.
    seed: int('seed', 1),
    pedCount: int('peds', 200),
    roam: q.get('roam') !== '0',
    interestRadius: int('interest', 600),
    provingGround: q.get('proving') === '1',
    difficulty: q.get('difficulty') ?? 'normal',
  };
}

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
  ctx.fillRect(0, viewport.h / 2 - 22, viewport.w, 44);
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
    ctx.fillText(l, viewport.w / 2, viewport.h / 2 - 8 + i * 10);
  });
  ctx.textAlign = 'left';
  ctx.restore();
}

/**
 * Debug override for the hour, `?night=0.85`. A day is 24 minutes long, so
 * without it the only way to look at the night lighting is to wait for it.
 */
function nightOverride(): number | null {
  const raw = new URLSearchParams(location.search).get('night');
  if (raw === null) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : null;
}

const forcedNight = nightOverride();

function playerName(): string {
  let name = sessionStorage.getItem('playerName');
  if (!name) {
    name = `guest-${Math.random().toString(36).slice(2, 7)}`;
    sessionStorage.setItem('playerName', name);
  }
  return name;
}

/**
 * Which renderer draws the world. **3D is the default**; `?render=2d` is the
 * way back to Canvas 2D.
 *
 * Only the world layer swaps either way. The HUD, the minimap, the debug
 * overlay, input, audio and — crucially — client-side prediction with
 * rewind/replay reconciliation are shared, which is why this lives in
 * `main.ts` rather than on a page of its own.
 *
 * The 2D path is not deprecated and is not going away. It is the measured
 * one — 60 fps, p50 4.5 ms — it needs no GPU, and it remains the fallback for
 * a machine that cannot afford WebGL or a driver that will not give it one.
 * `?render=2d` should keep working for as long as that is true.
 */
/**
 * Can this browser actually give us WebGL?
 *
 * Asked before choosing, not discovered mid-frame. A context is cheap to
 * probe and immediately released; the alternative — find out when three.js
 * throws — is what shipped, and on a machine with WebGL disabled it killed
 * the game outright rather than falling back.
 */
function webglAvailable(): boolean {
  try {
    const probe = document.createElement('canvas');
    const gl =
      probe.getContext('webgl2') ??
      probe.getContext('webgl') ??
      probe.getContext('experimental-webgl');
    if (!gl) return false;
    // Release it rather than leaving a context alive: browsers cap how many
    // a page may hold, and the real renderer needs one of them.
    (gl as WebGLRenderingContext).getExtension('WEBGL_lose_context')?.loseContext();
    return true;
  } catch {
    return false;
  }
}

const wants3d = new URLSearchParams(location.search).get('render') !== '2d';
let render3d = wants3d && webglAvailable();
if (wants3d && !render3d) {
  console.warn('WebGL unavailable — falling back to the 2D renderer');
}
const canvas = document.getElementById('game') as HTMLCanvasElement;
// In 3D the HUD canvas has to be see-through — both in its drawing context
// and in its CSS background, which is opaque black for the 2D renderer.
if (render3d) document.body.classList.add('render3d');
const screen = setupCanvas(canvas, { alpha: render3d });
const overlay = new DebugOverlay();
const input = new InputSource(screen, () => overlay.toggle());
const stats = new NetStats();
const sync = new SnapshotSync();
const predictor = new Predictor();
const interp = new Interpolator();
const sprites = new SpriteSheet();
const tiles = new TileLayer(sprites);
// `?extrude=1` swaps the baked, fixed-direction wall sweep for true parallax
// extrusion drawn per frame (SHIP.md U2). A flag while it is being measured.
tiles.extruded = new URLSearchParams(location.search).get('extrude') === '1';
const effects = new Effects();
const lights = new LightPass();
{
  // An escape hatch for a machine that cannot afford the pass: `?lights=cheap`
  // keeps the grade and the lamps but drops the shadow casting and the bloom,
  // which are the only two parts that measured as costing anything at all.
  // `?lights=off` leaves the scene ungraded.
  const q = new URLSearchParams(location.search).get('lights');
  if (q === 'off') lights.enabled = false;
  else if (q === 'cheap') lights.cheap = true;
}
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
/**
 * Three.js world layer, created on the first frame that has a map.
 *
 * Declared up here with the rest of the session's state rather than beside
 * `drawWorld3d`, because `adoptMap` reads it and `adoptMap` is reachable from
 * the first server message — which arrives after `conn.connect()`, further down
 * this file than the old declaration was.
 */
let world3d: {
  view: CityView;
  entities: EntityLayer;
  scenery: SceneryLayer;
  fx: Effects3dLayer;
  objects: WorldObjectsLayer;
  lights: Lights3dLayer;
} | null = null;
let lastSeed = 0;
let lastWorldgen: WorldgenParams | null = null;
let catalog: Catalog | null = null;
/** Hidden packages this player has already found; the rest still glint. */
let foundPackages = new Set<number>();
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
  // Collision prediction reads the positions the renderer is about to DRAW,
  // not the newest ones off the wire — see Interpolator.vehiclesAsDrawn. For
  // the parked cars that make up most of what you hit the two are identical;
  // for anything moving, the snapshot is three ticks ahead of its own sprite.
  predictor.setWorld(interp.vehiclesAsDrawn());
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
  // Half the viewport, live: the frame follows the window now, so a listener
  // offset frozen at module load would put the ears in the wrong place on
  // every screen that is not exactly the design size.
  const halfW = viewport.w / 2;
  const cx = cam.x + halfW;
  const cy = cam.y + viewport.h / 2;
  const dx = x - cx;
  const dy = y - cy;
  return { dist: Math.hypot(dx, dy), pan: Math.max(-1, Math.min(1, dx / halfW)) };
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
    // sign at all — the victim's HUD flashed and nothing else happened. The
    // spray scales with the speed: being clipped at a walking pace and being
    // hit by a bus at 300 px/s should not throw the same amount of blood.
    effects.blood(event.x, event.y, event.angle, 1 + Math.min(1.4, event.speed / 190));
    const at = listen(event.x, event.y);
    audio.play('thud', at.dist, at.pan);
  } else if (event.type === 'horn') {
    // Played from the event for everybody including the person who pressed
    // the key. A horn is not a gunshot: nobody is aiming with it, so the
    // round trip costs nothing worth adding a local-echo path for.
    const at = listen(event.x, event.y);
    audio.play('horn', at.dist, at.pan, hornPitch(event.kind));
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
  } else if (event.type === 'casualtySaved') {
    // Somebody the city got to in time. The same chime a pickup makes, which
    // is the one sound in the game that already means "that went well".
    const at = listen(event.x, event.y);
    audio.play('pickup', at.dist, at.pan);
  } else if (event.type === 'pickupTaken') {
    const at = listen(event.x, event.y);
    audio.play('pickup', at.dist, at.pan);
  } else if (event.type === 'pedDown' || event.type === 'copDown') {
    // The commonest killing in the game, and until the event carried a
    // position it was the only one that threw nothing: `shot` says where the
    // round stopped, never whether it stopped in somebody.
    effects.blood(event.x, event.y, Math.random() * Math.PI * 2, 1.15);
    const at = listen(event.x, event.y);
    audio.play('death', at.dist, at.pan);
  } else if (event.type === 'kill') {
    const victim = sync.latest?.players.find((p) => p.id === event.victimId);
    if (victim) {
      effects.blood(victim.pos.x, victim.pos.y, Math.random() * Math.PI * 2, 1.35);
      const at = listen(victim.pos.x, victim.pos.y);
      audio.play('death', at.dist, at.pan);
    }
  }
}

/**
 * Adopt a newly generated city. Every layer that holds map-derived state is
 * told here, and only here.
 *
 * There are two paths to a new map — the `welcome` that starts a session and
 * the `rebase` that moves its window — and they each used to carry their own
 * list of who to tell. They drifted, which is the only way this kind of bug
 * ever happens: the 3D world was built lazily on the first frame and never
 * rebuilt, so after the first rebase it drew the region the player had left
 * while the sim, the collision and the radar were all in the new one. One
 * function, one list, and a new layer is added in one place or in none.
 */
function adoptMap(next: CityMap): void {
  map = next;
  tiles.setMap(next);
  minimap.setMap(next);
  if (world3d) {
    world3d.view.setMap(next);
    world3d.scenery.setMap(next);
    world3d.objects.setMap(next);
    world3d.lights.setMap(next);
  }
}

function onServerMessage(msg: ServerMessage): void {
  try {
    handleServerMessage(msg);
  } catch (err) {
    // Never let one bad message stop the game loop dead.
    fatal = `client error: ${err instanceof Error ? err.message : String(err)}`;
    console.error(err);
  }
}

/**
 * `?local=1` runs the whole game in a Web Worker in this tab — no server, no
 * socket (SHIP.md T1). `?seed=` picks the city, since offline there is no
 * server to have chosen one.
 */
const conn = localParams()
  ? new LocalConnection({
      name: playerName(),
      stats,
      host: localParams()!,
      onMessage: onServerMessage,
    })
  : new Connection({
      url: serverUrl(),
      name: playerName(),
      stats,
      getResumeToken: () => sessionStorage.getItem('resumeToken'),
      onDisconnected: (attempts) => {
        // A server that is not running looked exactly like one that is: the canvas
        // said "connecting…" for ever and the only clue was in the console.
        if (attempts >= 2 && playerId < 0) {
          fatal =
            `cannot reach the server at ${serverUrl()} — is it running? ` +
            '(node server/dist/index.js), or add ?local=1 to play with no server';
        }
      },
      onMessage: onServerMessage,
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
        lastSeed = msg.seed;
        lastWorldgen = msg.worldgen;
        adoptMap(generateCity(msg.seed, msg.worldgen));
        catalog = msg.catalog;
        sync.applyServerMessage(msg);
        stats.onSnapshot();
        onStateUpdated(null);
        break;
      case 'rebase':
        // The session window moved (ROAM=1). Regenerate at the new origin;
        // the snapshot right behind this message is already in the new
        // frame, so prediction reconciles into it on arrival. One visible
        // snap at the boundary is the accepted cost.
        if (lastWorldgen !== null) {
          lastWorldgen = { ...lastWorldgen, windowX: msg.windowX, windowY: msg.windowY };
          adoptMap(generateCity(lastSeed, lastWorldgen));
          hud.notice('leaving the region — the world continues');
        }
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
        hud.setWallet(msg.cash, msg.multiplier, msg.standing);
        break;
      case 'secrets':
        foundPackages = new Set(msg.found);
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
/** Smoothed camera lead. Eased so a hard corner glides instead of snapping. */
let lead: Vec2 = { x: 0, y: 0 };


/**
 * Draw the world in 3D, from the same `Scene` the 2D renderer consumes.
 *
 * The camera is centred on the same point the 2D view is centred on and
 * covers the same `viewport.h` of world, so the HUD, the minimap and mouse
 * aim keep agreeing with what is on screen. Aim survives the perspective
 * projection because the camera hangs directly over the player: the mapping
 * is radially symmetric about screen centre, which is the only property
 * `InputSource`'s angle actually depends on.
 */
/**
 * Give up on 3D for the rest of the session.
 *
 * Puts the HUD canvas back the way the 2D renderer needs it — opaque
 * background, no transparent world showing through — and says so on screen,
 * because a silent downgrade is how somebody spends an hour wondering why it
 * looks different from the screenshots.
 */
function fallBackTo2d(): void {
  render3d = false;
  // Hand the GPU back before letting go of the renderer. The canvas is only
  // hidden, so without this the context, its shadow map and a whole city's
  // buffers stay resident — on precisely the machine that has just failed to
  // render 3D, and browsers cap how many live WebGL contexts a page may hold.
  world3d?.view.dispose();
  world3d = null;
  const worldCanvas = document.getElementById('world') as HTMLCanvasElement | null;
  if (worldCanvas) worldCanvas.hidden = true;
  document.body.classList.remove('render3d');
  hud.notice('3D unavailable on this device — using the 2D renderer');
}

/**
 * Notice when the GPU takes the context away, and do something about it.
 *
 * This is the one 3D failure the `try/catch` around `drawWorld3d` cannot see.
 * three.js does not throw on a lost context — it sets a flag and quietly makes
 * `render()` a no-op — so the simulation kept ticking, input kept working, the
 * frame counter kept counting, and the player got a blank white screen
 * reporting a happy 60 fps for as long as they cared to watch it.
 *
 * `preventDefault` is what makes the context restorable at all. If it comes
 * back, the city is rebuilt into the new context by the ordinary path: the
 * layers are dropped so the next frame constructs them again. If it does not
 * come back, 2D is better than nothing.
 */
function watchContextLoss(worldCanvas: HTMLCanvasElement): void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  worldCanvas.addEventListener('webglcontextlost', (e) => {
    e.preventDefault();
    hud.notice('graphics reset — restoring');
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      if (render3d) fallBackTo2d();
    }, 5000);
  });
  worldCanvas.addEventListener('webglcontextrestored', () => {
    if (timer) clearTimeout(timer);
    timer = null;
    // Everything on the GPU died with the old context. Dropping the layers
    // makes the next frame build them again against the new one.
    world3d = null;
  });
}

/**
 * Cars you could get into, nearest first, for the debug readout.
 *
 * A harness driving the game has to be able to find one — walking in hopeful
 * circles pressing the action key is how the first attempt at this failed.
 */
function boardable(
  me: { pos: { x: number; y: number } },
  snap: FullSnapshot,
): Array<{ id: number; kind: string; dx: number; dy: number; dist: number }> {
  const out: Array<{ id: number; kind: string; dx: number; dy: number; dist: number }> = [];
  for (const v of snap.vehicles) {
    if (v.driverId !== null || v.condition === 'wreck') continue;
    const dx = v.pos.x - me.pos.x;
    const dy = v.pos.y - me.pos.y;
    out.push({ id: v.id, kind: v.kind, dx, dy, dist: Math.hypot(dx, dy) });
  }
  return out.sort((a, b) => a.dist - b.dist);
}

function drawWorld3d(scene: Scene | null): void {
  if (!map || !scene) return;
  const worldCanvas = document.getElementById('world') as HTMLCanvasElement;
  if (!world3d) {
    worldCanvas.hidden = false;
    const view = new CityView({
      canvas: worldCanvas,
      map,
      pitch: 0,
      viewHeight: viewport.h,
    });
    watchContextLoss(worldCanvas);
    world3d = {
      view,
      // `view.world`, not `view.scene`: entities and scenery are placed at the
      // positions the sim gives them, and that is the group where a world
      // coordinate means what the rest of the game means by it.
      entities: new EntityLayer(view.world),
      scenery: new SceneryLayer(view.world),
      fx: new Effects3dLayer(view.world),
      objects: new WorldObjectsLayer(view.world),
      lights: new Lights3dLayer(view.world),
    };
    world3d.scenery.setMap(map);
    world3d.objects.setMap(map);
    world3d.lights.setMap(map);
  }
  const { view, entities, scenery, fx, objects, lights: lights3d } = world3d;

  // Match the HUD canvas exactly, in both backing store and CSS box, so a
  // world pixel lands on the same screen pixel in both layers.
  if (worldCanvas.width !== viewport.deviceW || worldCanvas.height !== viewport.deviceH) {
    view.resize(viewport.deviceW, viewport.deviceH);
    // The frame covers a different amount of world after a resize, and the HUD
    // and the radar have already moved to the new figure.
    view.setViewHeight(viewport.h);
  }
  worldCanvas.style.width = canvas.style.width;
  worldCanvas.style.height = canvas.style.height;

  view.setNight(lights.nightAmount);
  entities.update(scene.remotes, playerId, {
    ...(scene.localPos && scene.local
      ? {
          player: {
            ...scene.localPos,
            z: scene.local.z ?? 0,
            heading: scene.localPos.angle,
            // A dead local player lies on the tarmac like anybody else, and the
            // pose is hashed off their id so it is the same body on every screen.
            id: scene.local.id,
            mode: scene.local.mode,
            cosmeticId: scene.local.cosmeticId,
          },
        }
      : {}),
    ...(scene.localVehicle && predictor.predictedVehicle
      ? {
          vehicle: {
            id: predictor.predictedVehicle.id,
            kind: scene.localVehicle.kind,
            x: scene.localVehicle.pos.x,
            y: scene.localVehicle.pos.y,
            z: scene.localVehicle.z,
            heading: scene.localVehicle.heading,
            wear: scene.localVehicle.wear,
            paint: predictor.predictedVehicle.paint,
            gangId: predictor.predictedVehicle.gangId,
            // Your own turret comes off your own smoothed aim, not off the
            // wire, so the barrel answers the mouse on the frame you move it.
            aim: scene.localPos?.angle ?? scene.local?.aimAngle ?? null,
          },
        }
      : {}),
  });
  scenery.updateProps(scene.remotes.props);
  fx.update(effects);
  objects.update(scene, cam, { w: viewport.w, h: viewport.h });
  const focus = { x: cam.x + viewport.w / 2, y: cam.y + viewport.h / 2 };
  // `?lights=off` leaves the scene lit by the sun alone; `?lights=cheap` keeps
  // the lighting but spends a quarter of the budget on it.
  lights3d.setCheap(lights.cheap);
  if (lights.enabled) {
    lights3d.update(scene, effects, lights.nightAmount, focus, cam, {
      w: viewport.w,
      h: viewport.h,
    });
  }
  view.lookAt(focus.x, focus.y);
  view.render();
}

function frameBody(now: number): void {
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
    const intent = input.sample(seq++, localTick, playerScreen, interp.viewTick());
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
                // A stunt jump lifts the PLAYER and the car with them; an
                // aircraft carries its own altitude. Whichever is higher is
                // the one you are looking at.
                z: Math.max(predictor.predicted?.z ?? 0, predictor.predictedVehicle?.z ?? 0),
                gangId: predictor.predictedVehicle?.gangId ?? 0,
                paint: predictor.predictedVehicle?.paint ?? -1,
              }
            : null,
        remotes: interp.sample(playerId, driving ? (predictor.predicted?.vehicleId ?? null) : null),
        foundPackages,
        dt: frameMs / 1000,
        nowMs: now,
        night: forcedNight,
        // The newest authoritative tick, not the last acked one: traffic
        // signals are a function of it, and rendering the phase three ticks
        // in the past would show a light the cars in front had already
        // obeyed.
        tick: sync.latest.tick,
      }
    : null;
  // Advance the particle pools and spawn what this frame's world implies, for
  // BOTH renderers. This used to happen inside the 2D `render()`, which is why
  // 3D had no skid marks, no exhaust, no engine smoke and no blood pools: the
  // effects were never created, let alone drawn.
  if (scene) {
    effects.update(scene.dt);
    spawnSceneEffects(effects, scene);
    // The hour, for whichever renderer draws. This lived inside the 2D
    // `render()`, so the 3D path read a night amount nothing had ever set and
    // the city sat at a fixed dusk for the whole session.
    if (map) lights.setNight(sceneNight(map, scene));
  }

  {
    // Measured around the world render only — not the HUD, not the minimap,
    // not the overlay that reports it. See NetStats.renderMs for why the rAF
    // delta cannot answer this.
    const t0 = performance.now();
    if (render3d) {
      try {
        drawWorld3d(scene);
        // The HUD canvas is transparent in this mode, so last frame's HUD
        // would otherwise smear over this one.
        screen.ctx.clearRect(0, 0, viewport.deviceW, viewport.deviceH);
      } catch (err) {
        // A driver that refuses a context, a shader that will not compile on
        // this GPU, anything at all: fall back for good rather than throwing
        // once a frame. Before this guard the exception escaped `frame()`,
        // the rAF at the bottom never ran, and the whole game stopped dead on
        // a black screen — with the sim still ticking in its worker, unseen.
        console.error('3D renderer failed; falling back to 2D', err);
        fallBackTo2d();
        render(screen, map, scene, cam, sprites, tiles, effects, lights);
      }
    } else {
      render(screen, map, scene, cam, sprites, tiles, effects, lights);
    }
    stats.onRender(performance.now() - t0);
  }

  // HUD and overlay draw in world-pixel units, whatever the backing store is.
  hudTransform(screen.ctx);
  if (fatal) drawFatal(screen.ctx, fatal);
  if (shopKind && catalog) {
    hud.drawShop(screen.ctx, shopKind, hud.shopRows(catalog, shopKind));
  }
  hud.place = currentLandmark();
  {
    const me = predictor.predicted;
    hud.district =
      map && me
        ? districtAt(map, Math.floor(me.pos.x / TILE_SIZE), Math.floor(me.pos.y / TILE_SIZE))
        : null;
  }
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
  // The flight control, off the same predicted vehicle: `canTakeOff` is the
  // sim's own answer, so the prompt and the key agree by construction rather
  // than by two implementations happening to match.
  hud.aircraft =
    drivenCar && map && getVehicleTuning(drivenCar.kind).medium === 'air'
      ? {
          airborne: drivenCar.z > 0,
          climbing: drivenCar.climb,
          ready: canTakeOff(drivenCar, map),
        }
      : null;
  minimap.marker = hud.missionMarker;
  minimap.route = hud.missionRoute;
  hud.draw(
    screen.ctx,
    predictor.predicted ?? null,
    sync.latest,
    cam,
    predictor.predictedVehicle?.speed ?? 0,
  );
  // Over the world and under the panels: a name should not cover the radar.
  if (scene) drawNameTags(screen.ctx, scene, cam);
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
    vehicleBodies: overlay.visible
      ? [
          ...interp.sample(playerId, null).vehicles.map((rv) => ({
            x: rv.x,
            y: rv.y,
            heading: rv.heading,
            kind: rv.vehicle.kind,
          })),
          ...(drivenCar
            ? [
                {
                  x: drivenCar.pos.x,
                  y: drivenCar.pos.y,
                  heading: drivenCar.heading,
                  kind: drivenCar.kind,
                },
              ]
            : []),
        ]
      : [],
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
    // Which window onto the world this is. It MOVES — a rebase regenerates
    // the map at a new origin — and without it a test looking at the screen
    // has no way to say which city it is looking at, which is exactly the
    // question when the terrain and the radar disagree.
    region: lastWorldgen ? { x: lastWorldgen.windowX, y: lastWorldgen.windowY } : null,
    tick: sync.latest?.tick ?? -1,
    // Live particles and decals. Both renderers present the same pools, so a
    // count that moves in one and not the other is a presentation bug and a
    // count that moves in neither is a spawning one.
    fx: effects.counts(),
    // What the 3D light budget spent this frame, and what it was asked for.
    lights3d: world3d?.lights.counts() ?? null,
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
    carZones: predictor.predictedVehicle?.zones ?? null,
    // Nearest car you could get into, and how far. A harness driving the game
    // has to be able to find one — walking in hopeful circles pressing the
    // action key is how the first attempt at this failed.
    nearestVehicle: (() => {
      const me = predictor.predicted;
      if (!me || !sync.latest) return null;
      return boardable(me, sync.latest)[0] ?? null;
    })(),
    /**
     * The eight nearest cars you could get into, with their kinds.
     *
     * `nearestVehicle` alone is not enough to drive the game with: a harness
     * told to photograph the tank has to be able to walk past the coupe parked
     * next to it, and the proving ground hands out a row of six cars.
     */
    boardableVehicles: (() => {
      const me = predictor.predicted;
      if (!me || !sync.latest) return [];
      return boardable(me, sync.latest).slice(0, 8);
    })(),
    carCondition: predictor.predictedVehicle?.condition ?? null,
    // Altitude and the take-off latch. Same reason as `carHealth`: a harness
    // driving the game cannot tell a helicopter in the air from one on the
    // ground by reading pixels, and flight is the one part of driving whose
    // whole state is a number the screen only hints at.
    carZ: predictor.predictedVehicle?.z ?? null,
    carClimb: predictor.predictedVehicle?.climb ?? null,
    carKind: predictor.predictedVehicle?.kind ?? null,
    fps: stats.fps,
    frameMs: stats.frameMs,
    frameMsPeak: stats.frameMsPeak,
    renderMs: stats.renderMs,
    buildings: tiles.lastBuildingsDrawn,
  };

}

/**
 * The frame loop, which must not be able to stop.
 *
 * `frameBody` used to reschedule itself on its own last line, so anything
 * that threw anywhere inside it took the whole game down — the canvas froze
 * on whatever was last drawn while the simulation carried on ticking in its
 * worker, unseen and unreachable. That is precisely how the 3D renderer
 * failing to get a WebGL context turned into a black screen instead of a
 * fallback.
 *
 * Rescheduling in a `finally` makes that structurally impossible: one bad
 * frame is one bad frame. The error still reaches the console, and the
 * player still gets told, but the game keeps running.
 */
function frame(now: number): void {
  try {
    frameBody(now);
  } catch (err) {
    console.error(err);
    fatal = `client error: ${err instanceof Error ? err.message : String(err)}`;
  } finally {
    requestAnimationFrame(frame);
  }
}
requestAnimationFrame(frame);
