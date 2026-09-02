import {
  type FullSnapshot,
  type ServerMessage,
  PROTOCOL_VERSION,
  SnapshotSync,
  binaryCodec,
  generateCity,
  initTuning,
  parseServerMessage,
  type CityMap,
  type WorldgenParams,
} from 'shared';
import { Interpolator } from '../net/interpolation.js';
import { SpriteSheet } from '../render/sprites.js';
import { TileLayer } from '../render/tiles.js';
import { CityView } from './cityView.js';
import { EntityLayer } from './entities.js';
import { GroundLayer } from './ground.js';
import { SceneryLayer } from './scenery.js';

/**
 * The game, playable, in 3D.
 *
 * Deliberately not a second copy of `main.ts`. It runs the same offline host
 * over the same protocol and feeds the same `Interpolator` the 2D renderer
 * uses, so both views are drawing the identical interpolated state and any
 * disagreement between them is a rendering bug rather than two games.
 *
 * What it leaves out, on purpose, is client-side prediction. `main.ts`
 * predicts the local player and reconciles by rewind/replay; here the local
 * player is interpolated like everyone else. Against a worker host the round
 * trip is sub-millisecond so it does not read as lag, and leaving it out
 * keeps this file about rendering. Prediction comes back with 3D.md W3b,
 * where the HUD and the rest of the 6,528-line renderer do too.
 */

export interface LiveOptions {
  canvas: HTMLCanvasElement;
  seed: number;
  pitch: number;
  viewHeight: number;
  peds: number;
  night: number;
  /** How wet the streets are, 0 to 1. Fixed here; the game runs it off a clock. */
  wet: number;
}

export class Live {
  private readonly sync = new SnapshotSync();
  private readonly interp = new Interpolator();
  private worker: Worker | null = null;
  private view: CityView | null = null;
  private entities: EntityLayer | null = null;
  private scenery: SceneryLayer | null = null;
  private ground: GroundLayer | null = null;
  /**
   * The 2D tile painter, here only as the ground layer's texture source.
   *
   * It needs a `SpriteSheet` to draw entities and this one is never loaded —
   * `groundChunk` paints terrain and nothing else, so it never asks.
   */
  private readonly tiles = new TileLayer(new SpriteSheet());
  private map: CityMap | null = null;
  private seed = 0;
  private playerId = -1;
  private last = performance.now();
  private seq = 0;

  /** Held keys, sampled on the tick grid like the real client does. */
  private readonly keys = new Set<string>();
  private aim = 0;

  constructor(private readonly opts: LiveOptions) {}

  start(): void {
    const worker = new Worker(new URL('../local/host.worker.ts', import.meta.url), {
      type: 'module',
    });
    this.worker = worker;
    worker.onmessage = (ev: MessageEvent) => this.onFrame(ev.data);
    worker.postMessage({
      localBoot: {
        seed: this.opts.seed,
        pedCount: this.opts.peds,
        interestRadius: 900,
        provingGround: false,
        heights: false,
        difficulty: 'normal',
      },
    });
    this.send({ type: 'join', protocol: PROTOCOL_VERSION, name: 'three' });

    addEventListener('keydown', (e) => {
      this.keys.add(e.code);
      if (e.code.startsWith('Arrow') || e.code === 'Space') e.preventDefault();
    });
    addEventListener('keyup', (e) => this.keys.delete(e.code));

    requestAnimationFrame(this.frame);
  }

  private send(msg: unknown): void {
    const data = binaryCodec.encode(msg as never);
    if (typeof data === 'string') this.worker?.postMessage(data);
    else this.worker?.postMessage(data, [data.buffer as ArrayBuffer]);
  }

  private onFrame(data: unknown): void {
    if (data && typeof data === 'object' && !ArrayBuffer.isView(data) && 'type' in data) return;
    const frame =
      typeof data === 'string'
        ? data
        : data instanceof ArrayBuffer
          ? new Uint8Array(data)
          : (data as Uint8Array);
    let msg: ServerMessage | null;
    try {
      msg = parseServerMessage(binaryCodec.decode(frame));
    } catch {
      return;
    }
    if (!msg) return;

    if (msg.type === 'welcome') {
      this.playerId = msg.playerId;
      initTuning(msg.tuning, { lenient: true });
      this.seed = msg.seed;
      this.map = generateCity(msg.seed, msg.worldgen);
      this.view = new CityView({
        canvas: this.opts.canvas,
        map: this.map,
        pitch: this.opts.pitch,
        viewHeight: this.opts.viewHeight,
        post: true,
      });
      this.view.setNight(this.opts.night);
      this.entities = new EntityLayer(this.view.world);
      this.scenery = new SceneryLayer(this.view.world);
      this.scenery.setMap(this.map);
      this.ground = new GroundLayer(this.view.world, this.tiles);
      this.tiles.setMap(this.map);
      this.ground.setMap(this.map);
      this.ground.setWeather(this.opts.wet, this.opts.night);
    }
    if (this.sync.applyServerMessage(msg) && this.sync.latest) {
      this.interp.push(this.sync.latest as FullSnapshot);
    }
  }

  private has(...codes: string[]): boolean {
    return codes.some((c) => this.keys.has(c));
  }

  private readonly frame = (now: number): void => {
    const dt = Math.min(100, now - this.last);
    this.last = now;

    // One input a frame is enough at 60 Hz against a 30 Hz sim; the host
    // queues them and the extra is dropped rather than doubling the rate.
    if (this.playerId >= 0) {
      this.send({
        type: 'input',
        ackTick: this.sync.ackTick,
        intents: [
          {
            seq: this.seq++,
            tick: this.sync.latest?.tick ?? 0,
            up: this.has('KeyW', 'ArrowUp'),
            down: this.has('KeyS', 'ArrowDown'),
            left: this.has('KeyA', 'ArrowLeft'),
            right: this.has('KeyD', 'ArrowRight'),
            fire: this.has('Space'),
            aimAngle: this.aim,
            action: this.has('KeyE', 'Enter'),
            fitting: this.has('KeyF'),
            horn: this.has('KeyQ'),
            slot: -1,
            viewTick: this.interp.viewTick(),
          },
        ],
      });
    }

    this.interp.advance(dt);

    if (this.view && this.entities) {
      const world = this.interp.sample(-1, null);
      this.entities.update(world, -1);
      this.scenery?.updateProps(world.props);
      const me = world.players.find((p) => p.player.id === this.playerId);
      const inCar = me
        ? world.vehicles.find((v) => v.vehicle.id === me.player.vehicleId)
        : undefined;
      const fx = inCar ? inCar.x : (me?.x ?? 0);
      const fy = inCar ? inCar.y : (me?.y ?? 0);
      if (me) this.view.lookAt(fx, fy);
      // `lookAt` takes the centre of the frame; the ground layer wants the
      // top-left corner, as the 2D renderer means a camera. The width is
      // guessed at twice the height rather than measured off the canvas —
      // this page has no `viewport`, and the layer only uses the box to
      // decide which chunks to paint, with a margin round it either way.
      const gw = this.opts.viewHeight * 2;
      const gh = this.opts.viewHeight;
      this.ground?.update({ x: fx - gw / 2, y: fy - gh / 2 }, { w: gw, h: gh });
      this.view.render();
    }

    requestAnimationFrame(this.frame);
  };

  stats(): { draws: number; triangles: number; instances: number } | null {
    return this.view?.stats() ?? null;
  }
}
