import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from '/home/user/gta-2/server/node_modules/ws/index.js';
import { PROTOCOL_VERSION, binaryCodec, parseServerMessage } from '/home/user/gta-2/server/node_modules/shared/dist/index.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function startServer(port, persistPath) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['server/dist/index.js'], {
      env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), REPLAY: '0', PERSIST_PATH: persistPath },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', (c) => { process.stdout.write('[srv] '+c); if (c.toString().includes('listening on')) resolve(child); });
    child.stderr.on('data', (c) => process.stdout.write('[srv-err] '+c));
    setTimeout(() => reject(new Error('start timeout')), 10000).unref();
  });
}
function connect(port, tag) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    const seen = [];
    ws.on('message', (data) => {
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
      const msg = parseServerMessage(binaryCodec.decode(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)));
      if (!msg) { console.log(`[${tag}] UNPARSEABLE frame len=${buf.length}`); return; }
      if (msg.type === 'snapshot' || msg.type === 'full') return;
      seen.push(msg.type);
      console.log(`[${tag}] <- ${msg.type} ${JSON.stringify(msg).slice(0,200)}`);
    });
    ws.on('open', () => resolve({ send: (m) => ws.send(binaryCodec.encode(m)), close: () => ws.close(), seen }));
  });
}
const persistPath = join(mkdtempSync(join(tmpdir(), 'ptrace-')), 'persist.db');
const port = 9911;
console.log('store', persistPath);
let server = await startServer(port, persistPath);
let c = await connect(port, 'life1');
c.send({ type: 'join', protocol: PROTOCOL_VERSION, name: 'e2e' });
await sleep(600);
c.send({ type: 'register', username: 'e2e_user', password: 'e2e-password' });
await sleep(2000);
c.close(); server.kill('SIGTERM'); await sleep(700);
console.log('--- life 2 ---');
server = await startServer(port, persistPath);
let d = await connect(port, 'life2');
d.send({ type: 'join', protocol: PROTOCOL_VERSION, name: 'e2e-again' });
await sleep(600);
d.send({ type: 'login', username: 'e2e_user', password: 'e2e-password' });
await sleep(3000);
d.close(); server.kill('SIGTERM');
await sleep(300);
process.exit(0);
