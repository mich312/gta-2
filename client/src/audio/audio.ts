import audioSpec from 'shared/data/audio.json';

interface SoundSpec {
  kind: string;
  attack: number;
  decay: number;
  filter: number;
  gain: number;
  tone: number;
  toneGain: number;
  toneDecay: number;
  sweepTo?: number;
}

const SPEC = audioSpec as unknown as {
  masterGain: number;
  maxVoices: number;
  audibleRadius: number;
  sounds: Record<string, SoundSpec>;
  engine: { baseHz: number; hzPerSpeed: number; gain: number; filter: number };
  siren: { lowHz: number; highHz: number; periodSec: number; gain: number };
};

/**
 * Everything you hear is synthesised at runtime from `shared/data/audio.json`.
 *
 * No binary assets anywhere: the sprite sheet is already generated from a JSON
 * shape description, and doing the same for audio keeps the whole project
 * asset-free and every sound tunable in exactly the way every other number in
 * this game is tunable.
 *
 * Browsers refuse to start an AudioContext before a user gesture, and the bot
 * harness has no AudioContext at all, so every entry point here is a no-op
 * until `resume()` succeeds and a no-op forever if the API is missing.
 */
export class Audio {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  private voices = 0;
  private muted = false;

  /** Engine and siren are continuous, so they are held rather than triggered. */
  private engine: { osc: OscillatorNode; gain: GainNode; filter: BiquadFilterNode } | null = null;
  private siren: { osc: OscillatorNode; gain: GainNode } | null = null;

  /** Call from a user-gesture handler. Safe to call repeatedly. */
  resume(): void {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') void this.ctx.resume();
      return;
    }
    const Ctor =
      typeof globalThis !== 'undefined'
        ? ((globalThis as unknown as Record<string, unknown>)['AudioContext'] as
            | typeof AudioContext
            | undefined)
        : undefined;
    if (!Ctor) return; // headless: stay silent, never throw
    this.ctx = new Ctor();
    this.master = this.ctx.createGain();
    this.master.gain.value = SPEC.masterGain;
    this.master.connect(this.ctx.destination);
    this.noise = this.buildNoise(this.ctx);
  }

  toggleMute(): boolean {
    this.muted = !this.muted;
    if (this.master && this.ctx) {
      this.master.gain.setTargetAtTime(this.muted ? 0 : SPEC.masterGain, this.ctx.currentTime, 0.02);
    }
    return this.muted;
  }

  get enabled(): boolean {
    return this.ctx !== null && !this.muted;
  }

  /** One second of white noise, generated once and reused by every voice. */
  private buildNoise(ctx: AudioContext): AudioBuffer {
    const buf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const data = buf.getChannelData(0);
    // Deterministic LCG rather than Math.random: the same hiss every session,
    // and nothing here should ever be a source of variation.
    let s = 22222;
    for (let i = 0; i < data.length; i++) {
      s = (s * 1664525 + 1013904223) >>> 0;
      data[i] = (s / 0xffffffff) * 2 - 1;
    }
    return buf;
  }

  /**
   * Fire a one-shot. `dist` is world distance from the camera; sounds fall off
   * to nothing past the audible radius so a firefight across the city stays
   * inaudible. `pan` is -1..1.
   */
  play(name: string, dist = 0, pan = 0): void {
    const ctx = this.ctx;
    const master = this.master;
    if (!ctx || !master || this.muted) return;
    if (this.voices >= SPEC.maxVoices) return;
    const spec = SPEC.sounds[name];
    if (!spec) return;

    const falloff = Math.max(0, 1 - dist / SPEC.audibleRadius);
    if (falloff <= 0.01) return;
    const now = ctx.currentTime;

    const out = ctx.createGain();
    out.gain.value = 1;
    const panner = ctx.createStereoPanner();
    panner.pan.value = Math.max(-1, Math.min(1, pan));
    out.connect(panner).connect(master);

    this.voices++;
    const release = (): void => {
      this.voices = Math.max(0, this.voices - 1);
      out.disconnect();
      panner.disconnect();
    };

    // Noise body: the crack of the shot, shaped by a low-pass.
    if (this.noise && spec.gain > 0) {
      const src = ctx.createBufferSource();
      src.buffer = this.noise;
      src.loop = true;
      const filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = spec.filter;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, now);
      g.gain.linearRampToValueAtTime(spec.gain * falloff, now + spec.attack);
      g.gain.exponentialRampToValueAtTime(0.0001, now + spec.attack + spec.decay);
      src.connect(filter).connect(g).connect(out);
      src.start(now);
      src.stop(now + spec.attack + spec.decay + 0.02);
      src.onended = release;
    } else {
      this.voices = Math.max(0, this.voices - 1);
    }

    // Tonal body: the thump underneath it.
    if (spec.tone > 0 && spec.toneGain > 0) {
      const osc = ctx.createOscillator();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(spec.tone, now);
      if (spec.sweepTo !== undefined) {
        osc.frequency.exponentialRampToValueAtTime(
          Math.max(20, spec.sweepTo),
          now + spec.toneDecay,
        );
      }
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, now);
      g.gain.linearRampToValueAtTime(spec.toneGain * falloff, now + spec.attack);
      g.gain.exponentialRampToValueAtTime(0.0001, now + spec.attack + spec.toneDecay);
      osc.connect(g).connect(out);
      osc.start(now);
      osc.stop(now + spec.attack + spec.toneDecay + 0.02);
      if (!this.noise || spec.gain <= 0) osc.onended = release;
    }
  }

  /** Continuous engine note. `speed` is px/s; 0 stops it. */
  setEngine(speed: number): void {
    const ctx = this.ctx;
    const master = this.master;
    if (!ctx || !master) return;
    const mag = Math.abs(speed);

    if (mag < 1) {
      if (this.engine) {
        this.engine.gain.gain.setTargetAtTime(0, ctx.currentTime, 0.08);
        const dying = this.engine;
        this.engine = null;
        setTimeout(() => {
          try {
            dying.osc.stop();
            dying.osc.disconnect();
            dying.gain.disconnect();
            dying.filter.disconnect();
          } catch {
            // already torn down
          }
        }, 400);
      }
      return;
    }

    if (!this.engine) {
      const osc = ctx.createOscillator();
      osc.type = 'sawtooth';
      const filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = SPEC.engine.filter;
      const gain = ctx.createGain();
      gain.gain.value = 0;
      osc.connect(filter).connect(gain).connect(master);
      osc.start();
      this.engine = { osc, gain, filter };
    }
    const hz = SPEC.engine.baseHz + mag * SPEC.engine.hzPerSpeed;
    this.engine.osc.frequency.setTargetAtTime(hz, ctx.currentTime, 0.05);
    this.engine.gain.gain.setTargetAtTime(SPEC.engine.gain, ctx.currentTime, 0.08);
  }

  /**
   * Two-tone siren, on whenever police are nearby. `nowMs` drives the warble
   * off wall-clock so it does not depend on frame rate.
   */
  setSiren(active: boolean, nowMs: number): void {
    const ctx = this.ctx;
    const master = this.master;
    if (!ctx || !master) return;

    if (!active) {
      if (this.siren) {
        this.siren.gain.gain.setTargetAtTime(0, ctx.currentTime, 0.1);
      }
      return;
    }
    if (!this.siren) {
      const osc = ctx.createOscillator();
      osc.type = 'square';
      const gain = ctx.createGain();
      gain.gain.value = 0;
      osc.connect(gain).connect(master);
      osc.start();
      this.siren = { osc, gain };
    }
    const phase = (nowMs / 1000) % SPEC.siren.periodSec;
    const high = phase < SPEC.siren.periodSec / 2;
    this.siren.osc.frequency.setTargetAtTime(
      high ? SPEC.siren.highHz : SPEC.siren.lowHz,
      ctx.currentTime,
      0.01,
    );
    this.siren.gain.gain.setTargetAtTime(SPEC.siren.gain, ctx.currentTime, 0.05);
  }
}
