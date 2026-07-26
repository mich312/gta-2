import {
  type CityMap,
  type GameEvent,
  type PlayerState,
  type Vec2,
  type VehicleState,
  INTERNAL_HEIGHT,
  INTERNAL_WIDTH,
  PLAYER_RADIUS,
  TILE_SIZE,
} from 'shared';
import palette from 'shared/data/palette.json';
import type { Screen } from './canvas.js';
import type { RenderWorld } from '../net/interpolation.js';
import {
  SpriteAtlas,
  copSpriteKey,
  pedSpriteKey,
  playerSpriteKey,
  propSpriteKey,
  vehicleSpriteKey,
} from './atlas.js';
import { GroundRenderer } from './ground.js';
import { BuildingRenderer } from './buildings.js';
import { LightingPass, daylightAt } from './lighting.js';
import { ParticleSystem } from './particles.js';
import { DecalLayer } from './decals.js';
import { WeatherSystem } from './weather.js';
import { Minimap } from './minimap.js';
import { PostFx } from './post.js';
import type { SmoothCamera } from './camera.js';
import {
  type GfxQuality,
  NIGHT_MAX_DARKNESS,
  SUN_SHADOW_X,
  SUN_SHADOW_Y,
  detectQuality,
  detectTimeOverride,
} from './style.js';

export interface Scene {
  /** Predicted local player (zero input lag). */
  local: PlayerState | null;
  /** Predicted vehicle when the local player is driving. */
  localVehicle: VehicleState | null;
  /** Remote entities on the interpolated timeline. */
  remotes: RenderWorld;
  /** Newest server tick — drives day/night + weather. */
  tick: number;
}

interface Tracer {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  expiresAtMs: number;
}

interface Tracked {
  x: number;
  y: number;
  dist: number;
  lastSeenFrame: number;
  emitAtMs: number;
  /** Previous heading, for turn-rate (tyre squeal) detection. */
  heading: number;
}

/**
 * The full frame pipeline. Pass order is the architecture:
 *
 *   ground chunks → cast shadows → decals → shop glow → ground particles →
 *   entities (shadow blob + sprite + label) → building extrusion & tree
 *   canopies (occluding!) → air particles → tracers → lighting → weather →
 *   post vignette
 *
 * Everything stateful (walk phases, skid tracking, tracers, particle pool)
 * lives here so main.ts stays wiring-only. The HUD draws after this, in
 * screen space, from main.
 */
export class RenderPipeline {
  readonly atlas = new SpriteAtlas();
  readonly particles = new ParticleSystem();
  readonly decals = new DecalLayer();
  readonly lighting = new LightingPass();
  readonly post = new PostFx();
  private readonly quality: GfxQuality = detectQuality();

  private map: CityMap | null = null;
  private ground: GroundRenderer | null = null;
  private buildings: BuildingRenderer | null = null;
  private weather: WeatherSystem | null = null;
  private minimap: Minimap | null = null;

  private readonly tracers: Tracer[] = [];
  private readonly tracked = new Map<string, Tracked>();
  private frame = 0;
  /** Latest computed daylight, for other passes (HUD may peek too). */
  daylight = 1;
  rain = 0;

  bindMap(map: CityMap): void {
    this.map = map;
    this.ground = new GroundRenderer(map);
    this.buildings = new BuildingRenderer(map);
    this.weather = new WeatherSystem(map.seed);
    this.minimap = new Minimap(map);
  }

  get boundMinimap(): Minimap | null {
    return this.minimap;
  }

  /** Feed world events (shots, prop breaks) into visuals. */
  onGameEvent(event: GameEvent, now: number): void {
    switch (event.type) {
      case 'shot': {
        this.tracers.push({ x0: event.x0, y0: event.y0, x1: event.x1, y1: event.y1, expiresAtMs: now + 75 });
        if (this.tracers.length > 48) this.tracers.shift();
        const angle = Math.atan2(event.y1 - event.y0, event.x1 - event.x0);
        if (this.quality === 'high') {
          this.particles.muzzle(
            event.x0 + Math.cos(angle) * (PLAYER_RADIUS + 5),
            event.y0 + Math.sin(angle) * (PLAYER_RADIUS + 5),
            angle,
          );
          this.particles.impact(event.x1, event.y1, angle);
        }
        break;
      }
      case 'propDown': {
        if (this.quality === 'high') {
          const tint =
            event.kind === 'bin' ? '#3d6b4f' : event.kind === 'fence' ? '#7d6a4f' : '#8a9099';
          this.particles.debris(event.x, event.y, tint);
        }
        this.decals.stain(event.x, event.y, now);
        break;
      }
      default:
        break;
    }
  }

  /** Blood visuals for a confirmed kill (position resolved by the caller). */
  onKillAt(x: number, y: number, now: number): void {
    this.decals.blood(x, y, now);
    if (this.quality === 'high') this.particles.blood(x, y, Math.random() * Math.PI * 2);
  }

  render(screen: Screen, map: CityMap | null, scene: Scene | null, camera: SmoothCamera, nowMs: number, dtMs: number): void {
    const { ctx } = screen;
    this.frame++;

    if (!map || !scene || !this.ground || !this.buildings || !this.weather) {
      drawConnecting(ctx, nowMs);
      return;
    }

    const cam = camera.pos;
    this.daylight = detectTimeOverride() ?? daylightAt(scene.tick);
    this.rain = this.quality === 'high' ? (this.weather.intensityAt(scene.tick)) : 0;

    if (this.quality === 'high') {
      this.particles.update(dtMs);
      this.weather.update(dtMs, this.rain);
      this.trackVehicles(scene, nowMs);
    }
    this.trackWalkers(scene);

    // --- 1. ground (plus the animated glint pass over open water)
    this.ground.draw(ctx, cam);
    this.ground.drawShimmer(ctx, cam, nowMs);

    // --- 2. cast shadows (buildings + trees), under everything mobile
    this.buildings.drawShadows(ctx, cam, this.daylight);

    // --- 3. decals
    this.decals.draw(ctx, cam, nowMs, INTERNAL_WIDTH, INTERNAL_HEIGHT);

    // --- 4. shop doorways
    this.drawShops(ctx, map, cam, nowMs);

    // --- 5. ground-level particles (debris, blood)
    if (this.quality === 'high') this.particles.drawGround(ctx, cam);

    // --- 6. entities
    this.drawEntities(ctx, scene, cam);

    // --- 7. occluding structure pass
    this.buildings.drawStructures(ctx, cam);

    // --- 8. air particles
    if (this.quality === 'high') this.particles.drawAir(ctx, cam);

    // --- 9. tracers (bright over everything worldly)
    this.drawTracers(ctx, cam, nowMs);

    // --- 10. lighting, then emissive city lights over the darkness
    if (this.quality === 'high') {
      this.collectLights(scene, map, cam, nowMs);
      const darkness = Math.min(
        0.85,
        (1 - this.daylight) * NIGHT_MAX_DARKNESS + this.weather.darknessBonus(this.rain),
      );
      this.lighting.compose(ctx, cam, darkness);
      this.buildings.drawEmissive(ctx, cam, darkness);
    }

    // --- 11. weather
    if (this.quality === 'high') this.weather.draw(ctx, this.rain);

    // --- 12. vignette + hit feedback
    this.post.observeHealth(scene.local?.health ?? null, nowMs);
    this.post.draw(ctx, nowMs, dtMs, scene.local?.health ?? null);
  }

  // ----------------------------------------------------------- entities

  private drawEntities(ctx: CanvasRenderingContext2D, scene: Scene, cam: Vec2): void {
    const shDx = 1 + SUN_SHADOW_X * 0.4 * this.daylight;
    const shDy = 1 + SUN_SHADOW_Y * 0.4 * this.daylight;

    for (const prop of scene.remotes.props) {
      const sx = prop.pos.x - cam.x;
      const sy = prop.pos.y - cam.y;
      const rot = prop.orient === 1 ? Math.PI / 2 : 0;
      this.atlas.draw(ctx, propSpriteKey(prop.kind, prop.intact), sx, sy, rot);
    }

    // Vehicle shadows + bodies (remote first, then the predicted one).
    for (const rv of scene.remotes.vehicles) {
      const sx = rv.x - cam.x;
      const sy = rv.y - cam.y;
      const blob = rv.vehicle.kind === 'boat' ? 'blob:28x12' : 'blob:24x13';
      this.atlas.draw(ctx, blob, sx + shDx, sy + shDy, rv.heading);
      this.atlas.draw(ctx, vehicleSpriteKey(rv.vehicle), sx, sy, rv.heading);
    }
    if (scene.localVehicle && scene.local) {
      const sx = scene.localVehicle.pos.x - cam.x;
      const sy = scene.localVehicle.pos.y - cam.y;
      const blob = scene.localVehicle.kind === 'boat' ? 'blob:28x12' : 'blob:24x13';
      this.atlas.draw(ctx, blob, sx + shDx, sy + shDy, scene.localVehicle.heading);
      this.atlas.draw(ctx, vehicleSpriteKey(scene.localVehicle), sx, sy, scene.localVehicle.heading);
    }

    const brollies = this.rain > 0.25;
    for (const pd of scene.remotes.peds) {
      const sx = pd.x - cam.x;
      const sy = pd.y - cam.y;
      const angle = Math.atan2(pd.ped.dirY, pd.ped.dirX);
      this.atlas.draw(ctx, 'blob:10x7', sx + shDx, sy + shDy, 0);
      this.atlas.draw(ctx, pedSpriteKey(pd.ped.id), sx, sy, angle, this.walkFrame(`e${pd.ped.id}`));
      if (brollies && pd.ped.id % 3 === 0) this.drawUmbrella(ctx, sx, sy, pd.ped.id);
    }

    for (const c of scene.remotes.cops) {
      const sx = c.x - cam.x;
      const sy = c.y - cam.y;
      const angle = Math.atan2(c.cop.vel.y, c.cop.vel.x);
      if (c.cop.marine) {
        // Harbor patrol rides a police launch, not a pair of shoes.
        this.atlas.draw(ctx, 'blob:28x12', sx + shDx, sy + shDy, angle);
        this.atlas.draw(ctx, 'boat:police', sx, sy, angle);
      } else {
        this.atlas.draw(ctx, 'blob:10x7', sx + shDx, sy + shDy, 0);
        this.atlas.draw(ctx, copSpriteKey(), sx, sy, angle, this.walkFrame(`c${c.cop.id}`));
      }
    }

    for (const r of scene.remotes.players) {
      this.drawPlayer(ctx, r.player, r.x - cam.x, r.y - cam.y, r.aimAngle, false, shDx, shDy);
    }
    if (scene.local && scene.local.mode !== 'driving') {
      this.drawPlayer(
        ctx,
        scene.local,
        scene.local.pos.x - cam.x,
        scene.local.pos.y - cam.y,
        scene.local.aimAngle,
        true,
        shDx,
        shDy,
      );
    }
  }

  private drawPlayer(
    ctx: CanvasRenderingContext2D,
    p: PlayerState,
    sx: number,
    sy: number,
    aim: number,
    isLocal: boolean,
    shDx: number,
    shDy: number,
  ): void {
    if (p.mode === 'dead') return;
    this.atlas.draw(ctx, 'blob:10x7', sx + shDx, sy + shDy, 0);
    this.atlas.draw(ctx, playerSpriteKey(p, isLocal), sx, sy, aim, this.walkFrame(`p${p.id}`));

    if (isLocal) {
      // Soft aim tick, kept subtle — the sprite's weapon does most of it.
      ctx.strokeStyle = 'rgba(255,255,255,0.28)';
      ctx.beginPath();
      ctx.moveTo(sx + Math.cos(aim) * (PLAYER_RADIUS + 4), sy + Math.sin(aim) * (PLAYER_RADIUS + 4));
      ctx.lineTo(sx + Math.cos(aim) * (PLAYER_RADIUS + 8), sy + Math.sin(aim) * (PLAYER_RADIUS + 8));
      ctx.stroke();
    }

    ctx.font = '8px monospace';
    ctx.textAlign = 'center';
    const tw = p.name.length * 5;
    ctx.fillStyle = 'rgba(8, 11, 16, 0.55)';
    ctx.fillRect(Math.floor(sx - tw / 2) - 2, sy - PLAYER_RADIUS - 14, tw + 4, 9);
    ctx.fillStyle = isLocal ? '#e8f0e8' : '#aeb8c2';
    ctx.fillText(p.name, Math.floor(sx), sy - PLAYER_RADIUS - 7);
    ctx.textAlign = 'left';
  }

  /** A pedestrian's umbrella, held over the sprite when it rains. */
  private drawUmbrella(ctx: CanvasRenderingContext2D, sx: number, sy: number, id: number): void {
    const COLORS = ['#8a3a3a', '#3a5a8a', '#3d3d46', '#8a743a', '#4d6b56'] as const;
    const c = COLORS[id % COLORS.length] as string;
    const x = Math.floor(sx) + 2; // held a touch off-centre, like a real one
    const y = Math.floor(sy) - 2;
    ctx.fillStyle = 'rgba(10, 12, 16, 0.35)';
    ctx.beginPath();
    ctx.arc(x + 1, y + 1, 6, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = c;
    ctx.beginPath();
    ctx.arc(x, y, 6, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.25)';
    ctx.beginPath();
    ctx.moveTo(x - 6, y);
    ctx.lineTo(x + 6, y);
    ctx.moveTo(x, y - 6);
    ctx.lineTo(x, y + 6);
    ctx.stroke();
    ctx.fillStyle = 'rgba(255,255,255,0.7)';
    ctx.fillRect(x, y, 1, 1);
  }

  // ----------------------------------------------------- animation state

  /** Advance per-entity odometers that drive walk cycles. */
  private trackWalkers(scene: Scene): void {
    const touch = (key: string, x: number, y: number): void => {
      const t = this.tracked.get(key);
      if (!t) {
        this.tracked.set(key, { x, y, dist: 0, lastSeenFrame: this.frame, emitAtMs: 0, heading: 0 });
        return;
      }
      t.dist += Math.hypot(x - t.x, y - t.y);
      t.x = x;
      t.y = y;
      t.lastSeenFrame = this.frame;
    };
    for (const r of scene.remotes.players) touch(`p${r.player.id}`, r.x, r.y);
    if (scene.local) touch(`p${scene.local.id}`, scene.local.pos.x, scene.local.pos.y);
    for (const c of scene.remotes.cops) touch(`c${c.cop.id}`, c.x, c.y);
    for (const pd of scene.remotes.peds) touch(`e${pd.ped.id}`, pd.x, pd.y);

    // Drop stale entries so the map can't grow unbounded.
    if (this.frame % 300 === 0) {
      for (const [k, t] of this.tracked) {
        if (this.frame - t.lastSeenFrame > 600) this.tracked.delete(k);
      }
    }
  }

  private walkFrame(key: string): number {
    const t = this.tracked.get(key);
    if (!t) return 0;
    return Math.floor(t.dist / 7) % 4;
  }

  /** Skid marks, tyre smoke and exhaust for anything on wheels. */
  private trackVehicles(scene: Scene, now: number): void {
    const consider = (id: number, x: number, y: number, heading: number): void => {
      const key = `v${id}`;
      const t = this.tracked.get(key);
      if (!t) {
        this.tracked.set(key, { x, y, dist: 0, lastSeenFrame: this.frame, emitAtMs: 0, heading });
        return;
      }
      const dx = x - t.x;
      const dy = y - t.y;
      const step = Math.hypot(dx, dy);
      t.lastSeenFrame = this.frame;
      if (step > 0.4) {
        // The arcade car never side-slips, so squeal = sharp turn at speed.
        let turn = heading - t.heading;
        while (turn > Math.PI) turn -= Math.PI * 2;
        while (turn < -Math.PI) turn += Math.PI * 2;
        if (step > 2.4 && Math.abs(turn) > 0.045) {
          this.decals.skid(x, y, heading, now);
          if (Math.random() < 0.4) this.particles.tyreSmoke(x - dx * 2, y - dy * 2);
        }
        if (step > 0.9 && now >= t.emitAtMs) {
          t.emitAtMs = now + 120;
          this.particles.exhaust(x - Math.cos(heading) * 13, y - Math.sin(heading) * 13);
        }
      }
      t.x = x;
      t.y = y;
      t.heading = heading;
    };
    for (const rv of scene.remotes.vehicles) consider(rv.vehicle.id, rv.x, rv.y, rv.heading);
    if (scene.localVehicle && scene.local?.vehicleId != null) {
      consider(scene.local.vehicleId, scene.localVehicle.pos.x, scene.localVehicle.pos.y, scene.localVehicle.heading);
    }
  }

  // -------------------------------------------------------------- shops

  private drawShops(ctx: CanvasRenderingContext2D, map: CityMap, cam: Vec2, now: number): void {
    for (const s of map.shops) {
      const sx = s.doorX * TILE_SIZE - cam.x;
      const sy = s.doorY * TILE_SIZE - cam.y;
      if (sx < -TILE_SIZE * 2 || sy < -TILE_SIZE * 2 || sx > INTERNAL_WIDTH + TILE_SIZE || sy > INTERNAL_HEIGHT + TILE_SIZE) {
        continue;
      }
      const accent = s.kind === 'gun' ? palette.shopGun : palette.shopClothing;
      const pulse = 0.4 + 0.18 * Math.sin(now / 400 + s.doorX);

      // Welcome mat glow on the doorway tile.
      ctx.globalAlpha = pulse;
      ctx.fillStyle = accent;
      ctx.fillRect(sx + 2, sy + 2, TILE_SIZE - 4, TILE_SIZE - 4);
      ctx.globalAlpha = 1;
      ctx.strokeStyle = accent;
      ctx.globalAlpha = 0.8;
      ctx.strokeRect(sx + 1.5, sy + 1.5, TILE_SIZE - 3, TILE_SIZE - 3);
      ctx.globalAlpha = 1;

      // Hanging sign.
      const label = s.kind === 'gun' ? 'GUNS' : 'WEAR';
      const w = label.length * 5 + 6;
      ctx.fillStyle = 'rgba(9, 12, 17, 0.85)';
      ctx.fillRect(sx + TILE_SIZE / 2 - w / 2, sy - 12, w, 10);
      ctx.strokeStyle = accent;
      ctx.strokeRect(sx + TILE_SIZE / 2 - w / 2 + 0.5, sy - 11.5, w - 1, 9);
      ctx.font = '8px monospace';
      ctx.textAlign = 'center';
      ctx.fillStyle = accent;
      ctx.fillText(label, sx + TILE_SIZE / 2, sy - 4);
      ctx.textAlign = 'left';
    }
  }

  // ------------------------------------------------------------- lights

  private collectLights(scene: Scene, map: CityMap, cam: Vec2, now: number): void {
    const L = this.lighting;
    L.begin();

    // Street lamps (only intact ones shine).
    for (const prop of scene.remotes.props) {
      if (prop.kind !== 'lamp' || !prop.intact) continue;
      L.points.push({ x: prop.pos.x, y: prop.pos.y, radius: 52, intensity: 0.95, glow: '#ffd98a', glowAlpha: 0.14 });
    }

    // Shop doorways glow warm.
    for (const s of map.shops) {
      const x = (s.doorX + 0.5) * TILE_SIZE;
      const y = (s.doorY + 0.5) * TILE_SIZE;
      if (Math.abs(x - cam.x - INTERNAL_WIDTH / 2) > INTERNAL_WIDTH || Math.abs(y - cam.y - INTERNAL_HEIGHT / 2) > INTERNAL_HEIGHT) continue;
      L.points.push({ x, y, radius: 34, intensity: 0.8, glow: s.kind === 'gun' ? '#e8a075' : '#75c8e8', glowAlpha: 0.10 });
    }

    // Headlights + taillight glow for driven cars and moving traffic;
    // boats carry a soft all-round navigation light instead of a cone.
    const cone = (x: number, y: number, heading: number): void => {
      const fx = x + Math.cos(heading) * 13;
      const fy = y + Math.sin(heading) * 13;
      L.cones.push({ x: fx, y: fy, angle: heading, length: 64, halfWidth: 20, intensity: 0.85 });
      L.points.push({ x: fx, y: fy, radius: 18, intensity: 0.7 });
    };
    const navLight = (x: number, y: number): void => {
      L.points.push({ x, y, radius: 40, intensity: 0.7, glow: '#d8e8c8', glowAlpha: 0.08 });
    };
    for (const rv of scene.remotes.vehicles) {
      const active = rv.vehicle.driverId !== null || (rv.vehicle.ai === 1 && Math.abs(rv.vehicle.speed) > 4);
      if (!active) continue;
      if (rv.vehicle.kind === 'boat') navLight(rv.x, rv.y);
      else cone(rv.x, rv.y, rv.heading);
    }
    if (scene.localVehicle) {
      if (scene.localVehicle.kind === 'boat') navLight(scene.localVehicle.pos.x, scene.localVehicle.pos.y);
      else cone(scene.localVehicle.pos.x, scene.localVehicle.pos.y, scene.localVehicle.heading);
    }

    // Harbor patrol strobes red/blue across the water.
    const strobeBlue = Math.floor(now / 260) % 2 === 0;
    for (const c of scene.remotes.cops) {
      if (!c.cop.marine) continue;
      L.points.push({
        x: c.x,
        y: c.y,
        radius: 46,
        intensity: 0.8,
        glow: strobeBlue ? '#5a8ae8' : '#e05555',
        glowAlpha: 0.16,
      });
    }

    // Fresh muzzle flashes light the street for a beat.
    for (const t of this.tracers) {
      if (t.expiresAtMs > now) {
        L.points.push({ x: t.x0, y: t.y0, radius: 44, intensity: 0.9, glow: '#ffe9b0', glowAlpha: 0.2 });
      }
    }

    // The local player carries a faint presence light so night stays playable.
    if (scene.local) {
      L.points.push({ x: scene.local.pos.x, y: scene.local.pos.y, radius: 60, intensity: 0.35 });
    }
  }

  private drawTracers(ctx: CanvasRenderingContext2D, cam: Vec2, now: number): void {
    for (let i = this.tracers.length - 1; i >= 0; i--) {
      const t = this.tracers[i] as Tracer;
      if (t.expiresAtMs <= now) {
        this.tracers.splice(i, 1);
        continue;
      }
      const alpha = (t.expiresAtMs - now) / 75;
      const x0 = t.x0 - cam.x;
      const y0 = t.y0 - cam.y;
      const x1 = t.x1 - cam.x;
      const y1 = t.y1 - cam.y;
      const g = ctx.createLinearGradient(x0, y0, x1, y1);
      g.addColorStop(0, `rgba(255, 235, 170, ${(0.9 * alpha).toFixed(3)})`);
      g.addColorStop(1, `rgba(255, 235, 170, ${(0.15 * alpha).toFixed(3)})`);
      ctx.strokeStyle = g;
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.lineTo(x1, y1);
      ctx.stroke();
    }
  }
}

function drawConnecting(ctx: CanvasRenderingContext2D, now: number): void {
  ctx.fillStyle = '#0d1015';
  ctx.fillRect(0, 0, INTERNAL_WIDTH, INTERNAL_HEIGHT);

  // Drifting blueprint grid.
  const off = (now / 60) % 24;
  ctx.strokeStyle = 'rgba(70, 90, 110, 0.10)';
  ctx.beginPath();
  for (let x = -24 + off; x < INTERNAL_WIDTH + 24; x += 24) {
    ctx.moveTo(x, 0);
    ctx.lineTo(x, INTERNAL_HEIGHT);
  }
  for (let y = -24 + off; y < INTERNAL_HEIGHT + 24; y += 24) {
    ctx.moveTo(0, y);
    ctx.lineTo(INTERNAL_WIDTH, y);
  }
  ctx.stroke();

  const dots = '.'.repeat(1 + (Math.floor(now / 400) % 3));
  ctx.fillStyle = '#8a939e';
  ctx.font = '10px monospace';
  ctx.textAlign = 'center';
  ctx.fillText(`connecting${dots}`, INTERNAL_WIDTH / 2, INTERNAL_HEIGHT / 2);
  ctx.fillStyle = 'rgba(138, 147, 158, 0.5)';
  ctx.font = '8px monospace';
  ctx.fillText('topdown-city', INTERNAL_WIDTH / 2, INTERNAL_HEIGHT / 2 - 14);
  ctx.textAlign = 'left';
}
