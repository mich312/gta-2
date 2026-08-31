// Background CPU load for the persistCheck rate measurement.
// R9-D02 fails 1-in-10 quiet and 6-in-10 at load 5.9, so a fixed tree must be
// measured under load or the reading means nothing.
//
//   node evidence/round10/D02-load.mjs <spinners> <seconds>
import { spawn } from 'node:child_process';

const spinners = Number(process.argv[2] ?? 5);
const seconds = Number(process.argv[3] ?? 180);
const kids = [];
for (let i = 0; i < spinners; i++) {
  kids.push(
    spawn(process.execPath, ['-e', 'const end=Date.now()+' + seconds * 1000 + ';while(Date.now()<end);'], {
      stdio: 'ignore',
    }),
  );
}
console.log(`load: ${spinners} spinners for ${seconds}s (pids ${kids.map((k) => k.pid).join(',')})`);
const stop = () => {
  for (const k of kids) k.kill('SIGKILL');
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
