// Failure-rate harness for the persistCheck instrument (R9-D02 / R9-D04).
//
// A 1-in-10 race passes a single run on a fixed OR an unfixed tree, so the
// only honest reading is a rate over many runs at a stated load. This also
// counts the servers each run leaves behind (R9-D04) — and kills them between
// runs, because orphans raise the load and inflate the very rate being
// measured.
//
//   node evidence/round10/D02-rate.mjs <runs> <label>
import { execFileSync, spawn } from 'node:child_process';

const runs = Number(process.argv[2] ?? 20);
const label = process.argv[3] ?? 'unlabelled';

const livePids = () => {
  try {
    return new Set(
      execFileSync('pgrep', ['-f', 'server/dist/index.js'], { encoding: 'utf8' })
        .split('\n')
        .filter(Boolean),
    );
  } catch {
    return new Set();
  }
};
const load = () => execFileSync('cat', ['/proc/loadavg'], { encoding: 'utf8' }).split(' ')[0];

const runOnce = () =>
  new Promise((resolve) => {
    const p = spawn(process.execPath, ['server/dist/tools/persistCheck.js'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    p.stdout.on('data', (c) => (out += c));
    p.stderr.on('data', (c) => (out += c));
    p.once('exit', (code) => resolve({ code, out }));
  });

let fails = 0;
let orphansTotal = 0;
const reasons = [];
console.log(`# persistCheck rate: ${label}, ${runs} runs, load at start ${load()}`);
for (let i = 1; i <= runs; i++) {
  const before = livePids();
  const { code, out } = await runOnce();
  await new Promise((r) => setTimeout(r, 300)); // let a SIGTERMed server actually exit
  const after = livePids();
  const orphans = [...after].filter((pid) => !before.has(pid));
  orphansTotal += orphans.length;
  if (code !== 0) {
    fails++;
    const why =
      out
        .split('\n')
        .filter((l) => /Error|timeout waiting|FAIL/.test(l))
        .join(' | ') || out.split('\n').filter(Boolean).slice(-1).join('');
    reasons.push(`run ${i}: ${why}`);
  }
  console.log(
    `run ${String(i).padStart(3)}: ${code === 0 ? 'PASS' : 'FAIL'}  orphans=${orphans.length}  load=${load()}`,
  );
  for (const pid of orphans) {
    try {
      process.kill(Number(pid), 'SIGKILL');
    } catch {
      /* already gone */
    }
  }
}
console.log(
  `\n# ${label}: ${fails}/${runs} failed, ${orphansTotal} orphaned server(s), load at end ${load()}`,
);
for (const r of reasons) console.log('  ' + r);
