import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { PROTOCOL_VERSION, binaryCodec, parseServerMessage, type ServerMessage } from 'shared';

/**
 * Full-stack restart-survival check (phase 5 gate, over the real wire):
 *   boot server -> join -> register account -> observe wallet ->
 *   kill server -> boot a fresh server on the SAME persistence file ->
 *   join -> login -> wallet must match, and starting cash must NOT have
 *   been seeded twice (the idempotent ref is doing its job).
 */

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function startServer(port: number, persistPath: string): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    const entry = fileURLToPath(new URL('../index.js', import.meta.url));
    const child = spawn(process.execPath, [entry], {
      env: {
        ...process.env,
        HOST: '127.0.0.1',
        PORT: String(port),
        REPLAY: '0',
        PERSIST_PATH: persistPath,
      },
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    child.stdout.on('data', (c: Buffer) => {
      if (c.toString().includes('listening on')) resolve(child);
    });
    child.once('exit', () => reject(new Error('server died early')));
    setTimeout(() => reject(new Error('server start timeout')), 10_000).unref();
  });
}

interface Client {
  send(msg: unknown): void;
  next(type: string, timeoutMs?: number): Promise<ServerMessage>;
  close(): void;
}

function connect(port: number): Promise<Client> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    const waiting: Array<{ type: string; resolve: (m: ServerMessage) => void }> = [];
    ws.on('message', (data) => {
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
      const frame = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
      const msg = parseServerMessage(binaryCodec.decode(frame));
      if (!msg) return;
      const i = waiting.findIndex((w) => w.type === msg.type);
      if (i >= 0) (waiting.splice(i, 1)[0] as { resolve: (m: ServerMessage) => void }).resolve(msg);
    });
    ws.on('open', () =>
      resolve({
        send: (msg) =>
          ws.send(binaryCodec.encode(msg as Parameters<typeof binaryCodec.encode>[0])),
        next: (type, timeoutMs = 5000) =>
          new Promise((res, rej) => {
            waiting.push({ type, resolve: res });
            setTimeout(() => rej(new Error(`timeout waiting for ${type}`)), timeoutMs).unref();
          }),
        close: () => ws.close(),
      }),
    );
    ws.on('error', reject);
  });
}

async function main(): Promise<void> {
  const persistPath = join(mkdtempSync(join(tmpdir(), 'persist-e2e-')), 'persist.db'); // sqlite path
  const port = 9500 + Math.floor(Math.random() * 400);

  // ---- life 1: register
  let server = await startServer(port, persistPath);
  let client = await connect(port);
  client.send({ type: 'join', protocol: PROTOCOL_VERSION, name: 'e2e' });
  await client.next('welcome');
  client.send({ type: 'register', username: 'e2e_user', password: 'e2e-password' });
  const acct1 = await client.next('account');
  if (acct1.type !== 'account' || !acct1.ok) throw new Error('register failed');
  const wallet1 = await client.next('wallet');
  if (wallet1.type !== 'wallet') throw new Error('no wallet');
  console.log(`life1: registered, cash=${wallet1.cash}`);
  client.close();
  server.kill('SIGTERM');
  await sleep(500);

  // ---- life 2: login on a fresh process, same store
  server = await startServer(port, persistPath);
  client = await connect(port);
  client.send({ type: 'join', protocol: PROTOCOL_VERSION, name: 'e2e-again' });
  await client.next('welcome');
  client.send({ type: 'login', username: 'e2e_user', password: 'e2e-password' });
  const acct2 = await client.next('account');
  if (acct2.type !== 'account' || !acct2.ok) throw new Error('login after restart failed');
  const wallet2 = await client.next('wallet');
  if (wallet2.type !== 'wallet') throw new Error('no wallet after restart');
  console.log(`life2: logged in after restart, cash=${wallet2.cash}`);
  client.close();
  server.kill('SIGTERM');

  if (wallet2.cash !== wallet1.cash) {
    throw new Error(
      `FAIL: cash changed across restart (${wallet1.cash} -> ${wallet2.cash}); ` +
        'starting-cash seeding is not idempotent or the store did not reload',
    );
  }
  console.log('PASS: account and cash survived the restart, seeded exactly once');
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
