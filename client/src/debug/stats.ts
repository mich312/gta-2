/** Rolling network/tick counters feeding the debug overlay. */
export class NetStats {
  rttMs = 0;
  kbpsIn = 0;
  kbpsOut = 0;
  /** Measured server snapshot rate (should sit at the tick rate). */
  snapshotRate = 0;

  private bytesIn = 0;
  private bytesOut = 0;
  private windowStart = performance.now();
  private snapshotTimes: number[] = [];

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

  update(): void {
    const now = performance.now();
    const dt = now - this.windowStart;
    if (dt >= 1000) {
      this.kbpsIn = this.bytesIn / (dt / 1000) / 1024;
      this.kbpsOut = this.bytesOut / (dt / 1000) / 1024;
      this.bytesIn = 0;
      this.bytesOut = 0;
      this.windowStart = now;
    }
  }
}
