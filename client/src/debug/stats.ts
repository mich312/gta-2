/** Rolling network/tick counters feeding the debug overlay. */
export class NetStats {
  rttMs = 0;
  kbpsIn = 0;
  kbpsOut = 0;
  /** Measured server snapshot rate (should sit at the tick rate). */
  snapshotRate = 0;
  /** Display-rate counters: the numbers to watch when the game feels laggy. */
  fps = 0;
  frameMs = 0;
  /** Worst frame in the current window — a spike no average would show. */
  frameMsPeak = 0;
  /**
   * CPU milliseconds actually spent in the world render, as percentiles over
   * the last 600 frames.
   *
   * Distinct from `frameMs`, and the distinction is the point: `frameMs` is
   * the gap between rAF callbacks, so vsync pins it at 16.7 and it reads the
   * same whether a frame cost 2 ms or 16 ms. It can tell you the renderer has
   * *already* missed, never how close it is to missing. Any question about
   * headroom — which is every question about whether a new pass is
   * affordable — needs this instead.
   */
  renderMs = { p50: 0, p95: 0, p99: 0, max: 0 };

  private bytesIn = 0;
  private bytesOut = 0;
  private windowStart = performance.now();
  private snapshotTimes: number[] = [];
  private frames = 0;
  private frameMsSum = 0;
  private frameMsMax = 0;
  /** Ring of recent render costs; 600 frames is ten seconds at 60. */
  private renderSamples: number[] = [];

  addIn(n: number): void {
    this.bytesIn += n;
  }

  addOut(n: number): void {
    this.bytesOut += n;
  }

  onSnapshot(): void {
    const now = performance.now();
    this.snapshotTimes.push(now);
    while (this.snapshotTimes.length > 0 && (this.snapshotTimes[0] as number) < now - 2000) {
      this.snapshotTimes.shift();
    }
    this.snapshotRate = this.snapshotTimes.length / 2;
  }

  onPong(sentAt: number): void {
    this.rttMs = performance.now() - sentAt;
  }

  /** Called once per rendered frame with the real delta since the last one. */
  onFrame(deltaMs: number): void {
    this.frames++;
    this.frameMsSum += deltaMs;
    if (deltaMs > this.frameMsMax) this.frameMsMax = deltaMs;
  }

  /** Called once per frame with the cost of the world render alone. */
  onRender(ms: number): void {
    this.renderSamples.push(ms);
    if (this.renderSamples.length > 600) this.renderSamples.shift();
  }

  private percentiles(): { p50: number; p95: number; p99: number; max: number } {
    if (this.renderSamples.length === 0) return { p50: 0, p95: 0, p99: 0, max: 0 };
    const s = [...this.renderSamples].sort((a, b) => a - b);
    const at = (q: number): number => s[Math.min(s.length - 1, Math.floor(q * s.length))] as number;
    return { p50: at(0.5), p95: at(0.95), p99: at(0.99), max: s[s.length - 1] as number };
  }

  update(): void {
    const now = performance.now();
    const dt = now - this.windowStart;
    if (dt >= 1000) {
      this.kbpsIn = this.bytesIn / (dt / 1000) / 1024;
      this.kbpsOut = this.bytesOut / (dt / 1000) / 1024;
      this.fps = this.frames / (dt / 1000);
      this.frameMs = this.frames > 0 ? this.frameMsSum / this.frames : 0;
      this.frameMsPeak = this.frameMsMax;
      this.renderMs = this.percentiles();
      this.bytesIn = 0;
      this.bytesOut = 0;
      this.frames = 0;
      this.frameMsSum = 0;
      this.frameMsMax = 0;
      this.windowStart = now;
    }
  }
}
