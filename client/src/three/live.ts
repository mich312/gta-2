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
} from 'shared';
import { Interpolator } from '../net/interpolation.js';
import { CityView } from './cityView.js';
import { EntityLayer } from './entities.js';

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
}

export class Live {
  private readonly sync = new SnapshotSync();
  private readonly interp = new Interpolator();
  private worker: Worker | null = null;
  private view: CityView | null = null;
  private entities: EntityLayer | null = null;
  private map: CityMap | null = null;
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
        roam: true,
        interestRadius: 900,
        provingGround: false,
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
      this.map = generateCity(msg.seed, msg.worldgen);
      this.view = new CityView({
        canvas: this.opts.canvas,
        map: this.map,
        pitch: this.opts.pitch,
        viewHeight: this.opts.viewHeight,
      });
      this.view.setNight(this.opts.night);
      this.entities = new EntityLayer(this.view.scene);
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
      const me = world.players.find((p) => p.player.id === this.playerId);
      const inCar = me
        ? world.vehicles.find((v) => v.vehicle.id === me.player.vehicleId)
        : undefined;
      const fx = inCar ? inCar.x : (me?.x ?? 0);
      const fy = inCar ? inCar.y : (me?.y ?? 0);
      if (me) this.view.lookAt(fx, fy);
      this.view.render();
    }

    requestAnimationFrame(this.frame);
  };

  stats(): { draws: number; triangles: number; instances: number } | null {
    return this.view?.stats() ?? null;
  }
}
