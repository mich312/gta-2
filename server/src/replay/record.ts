import { createWriteStream, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { WriteStream } from 'node:fs';
import type { ReplayHeader, ReplayTickRecord } from 'shared';

export interface ReplaySink {
  writeLine(line: string): void;
  close(): void;
}

export class MemorySink implements ReplaySink {
  readonly lines: string[] = [];
  writeLine(line: string): void {
    this.lines.push(line);
  }
  close(): void {}
}

export class FileSink implements ReplaySink {
  private readonly stream: WriteStream;
  constructor(readonly path: string) {
    this.stream = createWriteStream(path, { flags: 'w' });
  }
  writeLine(line: string): void {
    this.stream.write(line + '\n');
  }
  close(): void {
    this.stream.end();
  }
}

export class ReplayRecorder {
  constructor(
    private readonly sink: ReplaySink,
    header: ReplayHeader,
  ) {
    this.sink.writeLine(JSON.stringify(header));
  }

  record(rec: ReplayTickRecord): void {
    this.sink.writeLine(JSON.stringify(rec));
  }

  close(): void {
    this.sink.close();
  }
}

export function createFileRecorder(dir: string, seed: number): ReplayRecorder {
  mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const path = join(dir, `session-${stamp}-seed${seed}.jsonl`);
  const recorder = new ReplayRecorder(new FileSink(path), {
    version: 1,
    seed,
    tickRate: 30,
    startedAt: new Date().toISOString(),
  });
  console.log(`recording replay to ${path}`);
  return recorder;
}
