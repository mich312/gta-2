import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { TICK_RATE } from 'shared';
import { Bot } from './bot.js';
import { getScript } from './scripts.js';
import { loadSharedTuning } from '../tuning.js';

/** Bots predict locally; a hold/fast-forward on the server shows up as a
 * correction. Anything beyond ~a few held ticks of movement is a real bug.
 * Driving scripts get more slack: enter/exit transitions and car-vs-car
 * contact are deliberately unpredicted (server-granted).
 *
 * Brawl gets the most: a 30-kill brawl runs at four/five stars, and a cop
 * cruiser ramming a bot at full speed is a server-granted shove the
 * predictor deliberately does not guess at (prediction.ts's contract).
 * The infinite-world arterials let cruisers actually reach full speed, so
 * the worst shove grew — measured across runs: quiet bots 2.65 px, rammed
 * bots 45–229 px, desyncs zero throughout. The limit exists to catch
 * SYSTEMIC divergence (which shows on every bot), not the biggest single
 * lawful shove. */
const CORRECTION_LIMIT_PX: Record<string, number> = { default: 32, joyride: 96, brawl: 256, roam: 96 };
/** Phase-7 gate: with 200 peds, each client must stay under 50 KB/s down. */
const MAX_KBPS_IN = 50;

interface Args {
  count: number;
  script: string;
  duration: number;
  url: string | null;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { count: 8, script: 'cruise', duration: 60, url: null };
  for (const a of argv) {
    const m = /^--([a-z]+)=(.+)$/.exec(a);
    if (!m) continue;
    const [, k, v] = m;
    if (k === 'count') args.count = Number.parseInt(v as string, 10);
    if (k === 'script') args.script = v as string;
    if (k === 'duration') args.duration = Number.parseFloat(v as string);
    if (k === 'url') args.url = v as string;
  }
  return args;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function spawnServer(port: number): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    const entry = fileURLToPath(new URL('../index.js', import.meta.url));
    const child = spawn(process.execPath, [entry], {
      env: { ...process.env, HOST: '127.0.0.1', PORT: String(port) },
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    const timeout = setTimeout(() => reject(new Error('server start timeout')), 10_000);
    child.stdout.on('data', (chunk: Buffer) => {
      const line = chunk.toString();
      process.stdout.write(`[server] ${line}`);
      if (line.includes('listening on')) {
        clearTimeout(timeout);
        resolve(child);
      }
    });
    child.once('exit', (code) => {
      clearTimeout(timeout);
      reject(new Error(`server exited early (code ${code})`));
    });
  });
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const script = getScript(args.script);
  loadSharedTuning(); // bots run the real prediction code, which needs tuning

  let child: ChildProcess | null = null;
  let url = args.url;
  if (!url) {
    const port = 9000 + Math.floor(Math.random() * 1000);
    child = await spawnServer(port);
    url = `ws://127.0.0.1:${port}`;
  }

  console.log(`spawning ${args.count} bots (script=${args.script}) against ${url} for ${args.duration}s`);
  const bots: Bot[] = [];
  try {
    for (let i = 0; i < args.count; i++) {
      const bot = new Bot(url, `bot-${i}`, script, i);
      bots.push(bot);
      await bot.start();
      await sleep(25);
    }

    const progress = setInterval(() => {
      const ticks = bots.map((b) => b.report().lastServerTick);
      const desyncs = bots.reduce((n, b) => n + b.report().desyncs, 0);
      console.log(
        `tick min=${Math.min(...ticks)} max=${Math.max(...ticks)} ` +
          `entities=${bots[0]?.report().entityCount ?? 0} desyncs=${desyncs}`,
      );
    }, 10_000);

    await sleep(args.duration * 1000);
    clearInterval(progress);
  } finally {
    // Collect reports BEFORE stopping sockets (stop() flips connectedAtEnd).
  }

  const reports = bots.map((b) => b.report());
  for (const b of bots) b.stop();
  child?.kill('SIGTERM');

  const ticks = reports.map((r) => r.lastServerTick);
  const minTick = Math.min(...ticks);
  const maxTick = Math.max(...ticks);
  const failures: string[] = [];
  for (const r of reports) {
    if (!r.welcomed) failures.push(`${r.name}: never welcomed`);
    if (!r.connectedAtEnd) failures.push(`${r.name}: connection dropped`);
    if (r.entityCount !== args.count) {
      failures.push(`${r.name}: sees ${r.entityCount} entities, expected ${args.count}`);
    }
    if (r.desyncs > 0) failures.push(`${r.name}: ${r.desyncs} hash desyncs`);
    const corrLimit = CORRECTION_LIMIT_PX[args.script] ?? CORRECTION_LIMIT_PX['default'] ?? 32;
    if (r.maxCorrection > corrLimit) {
      failures.push(`${r.name}: prediction correction ${r.maxCorrection.toFixed(1)}px`);
    }
    const kbps = r.bytesIn / 1024 / args.duration;
    if (kbps > MAX_KBPS_IN) {
      failures.push(`${r.name}: ${kbps.toFixed(1)} KB/s down exceeds ${MAX_KBPS_IN}`);
    }
    for (const e of r.errors) failures.push(`${r.name}: ${e}`);
  }
  if (maxTick - minTick > TICK_RATE) {
    failures.push(`tick spread ${maxTick - minTick} exceeds ${TICK_RATE} (not in lockstep)`);
  }
  if (args.script === 'brawl' && args.duration >= 30) {
    const totalDeaths = reports.reduce((n, r) => n + r.deaths, 0);
    if (totalDeaths === 0) failures.push('brawl produced zero deaths — combat is not happening');
  }

  console.log('--- bot harness report ---');
  for (const r of reports) {
    console.log(
      `${r.name} pid=${r.playerId} tick=${r.lastServerTick} entities=${r.entityCount} ` +
        `desyncs=${r.desyncs} stale=${r.staleDeltas} fulls=${r.fullResyncs} ` +
        `corr=${r.maxCorrection.toFixed(2)}px${r.everDrove ? ' drove' : ''} ` +
        `deaths=${r.deaths} kills=${r.killEventsSeen} ` +
        `in=${(r.bytesIn / 1024).toFixed(1)}KB out=${(r.bytesOut / 1024).toFixed(1)}KB`,
    );
  }
  if (failures.length > 0) {
    console.error('FAIL');
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
  console.log(`PASS: ${args.count} bots, ${args.duration}s, ticks ${minTick}..${maxTick}, 0 desyncs`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
