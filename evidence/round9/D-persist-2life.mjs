// persistCheck's exact flow, with every non-snapshot frame logged, run in a
// loop until it fails.  Usage: node evidence/round9/D-persist-2life.mjs [runs]
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from '/home/user/gta-2/server/node_modules/ws/index.js';
import { PROTOCOL_VERSION, binaryCodec, parseServerMessage } from '/home/user/gta-2/server/node_modules/shared/dist/index.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const kids = [];
function startServer(port, persistPath) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['server/dist/index.js'], {
      env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), REPLAY: '0', PERSIST_PATH: persistPath },
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    kids.push(child);
    child.stdout.on('data', (c) => { if (c.toString().includes('listening on')) resolve(child); });
    child.once('exit', () => reject(new Error('server died early')));
    setTimeout(() => reject(new Error('server start timeout')), 15000).unref();
  });
}
function connect(port, tag, log) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    const waiting = [];
    ws.on('message', (data) => {
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
      const msg = parseServerMessage(binaryCodec.decode(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)));
      if (!msg) return;
      const i = waiting.findIndex((w) => w.type === msg.type);
      const delivered = i >= 0;
      if (delivered) waiting.splice(i, 1)[0].resolve(msg);
      if (msg.type !== 'snapshot' && msg.type !== 'full')
        log.push(`${tag} ${(Date.now() - t0).toString().padStart(6)}ms ${msg.type.padEnd(13)} delivered=${delivered}`);
    });
    ws.on('open', () => resolve({
      send: (m) => ws.send(binaryCodec.encode(m)),
      next: (type, timeoutMs = 5000) => new Promise((res, rej) => {
        waiting.push({ type, resolve: res });
        setTimeout(() => rej(new Error(`timeout waiting for ${type}`)), timeoutMs).unref();
      }),
      close: () => ws.close(),
    }));
    ws.on('error', reject);
  });
}
let t0 = 0;
async function once(port, log) {
  t0 = Date.now();
  const persistPath = join(mkdtempSync(join(tmpdir(), 'D2life-')), 'persist.db');
  let server = await startServer(port, persistPath);
  let c = await connect(port, 'L1', log);
  c.send({ type: 'join', protocol: PROTOCOL_VERSION, name: 'e2e' });
  await c.next('welcome');
  log.push('L1 --- sent register');
  c.send({ type: 'register', username: 'e2e_user', password: 'e2e-password' });
  const a1 = await c.next('account');
  const w1 = await c.next('wallet');
  c.close(); server.kill('SIGTERM'); await sleep(500);
  log.push('--- life 2 ---');
  server = await startServer(port, persistPath);
  c = await connect(port, 'L2', log);
  c.send({ type: 'join', protocol: PROTOCOL_VERSION, name: 'e2e-again' });
  await c.next('welcome');
  log.push('L2 --- sent login');
  c.send({ type: 'login', username: 'e2e_user', password: 'e2e-password' });
  const a2 = await c.next('account');
  const w2 = await c.next('wallet');
  c.close(); server.kill('SIGTERM');
  return { log, cash: [w1.cash, w2.cash], ok: [a1.ok, a2.ok] };
}
const runs = Number(process.argv[2] ?? 5);
for (let i = 0; i < runs; i++) {
  const port = 9600 + Math.floor(Math.random() * 300);
  const log = [];
  try {
    const r = await once(port, log);
    console.log(`run ${i + 1}: PASS cash=${r.cash} ok=${r.ok}`);
  } catch (err) {
    console.log(`run ${i + 1}: FAIL ${err.message}`);
    console.log(log.join('\n'));
    break;
  }
}
for (const k of kids) k.kill('SIGKILL');
process.exit(0);
