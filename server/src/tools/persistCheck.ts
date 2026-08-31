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

// Every server this check spawns, so a failure anywhere kills them too. A
// failed run used to exit through `main().catch` without touching its
// children, leaving a live 30 Hz session with a bound port behind — and the
// load from those orphans makes the next run fail as well.
const spawned = new Set<ChildProcess>();
let reaped = false;
function killAll(): void {
  if (reaped) return;
  reaped = true;
  for (const child of spawned) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
  spawned.clear();
}
process.on('exit', killAll);
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    killAll();
    process.exit(1);
  });
}

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
    spawned.add(child);
    child.once('exit', () => spawned.delete(child));
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
    // Frames that arrived before anyone asked for them. `await next('account')`
    // resolves its promise, but the caller's `next('wallet')` does not run
    // until the microtask after that — so a wallet the server sent in the same
    // event-loop turn as the account frame used to arrive with `waiting` still
    // empty, and was dropped. The check then blamed the server for losing a
    // wallet it had sent.
    //
    // Keeping unclaimed frames fixes that, but only under one invariant: this
    // buffer holds what has arrived SINCE the last request we sent or the last
    // reply we accepted, and nothing older. Without it the buffer answers with
    // a stale frame — the server sends a wallet on join as well, the guest one,
    // already holding startingCash, so `next('wallet')` after `register` would
    // hand back the pre-register guest wallet and the check would compare two
    // guest wallets and pass whatever the account had actually stored. A false
    // green in place of a false red is not an improvement. Hence the two
    // `arrived.length = 0` below, and the cap, so the 30 Hz snapshot stream
    // cannot grow the buffer without limit.
    const arrived: ServerMessage[] = [];
    const ARRIVED_MAX = 64;
    ws.on('message', (data) => {
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
      const frame = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
      const msg = parseServerMessage(binaryCodec.decode(frame));
      if (!msg) return;
      const i = waiting.findIndex((w) => w.type === msg.type);
      if (i >= 0) {
        arrived.length = 0; // a reply accepted: everything before it is stale
        (waiting.splice(i, 1)[0] as { resolve: (m: ServerMessage) => void }).resolve(msg);
        return;
      }
      arrived.push(msg);
      if (arrived.length > ARRIVED_MAX) arrived.shift();
    });
    ws.on('open', () =>
      resolve({
        send: (msg) => {
          // A request opens a new window: anything unclaimed that arrived
          // before it answers something else.
          arrived.length = 0;
          ws.send(binaryCodec.encode(msg as Parameters<typeof binaryCodec.encode>[0]));
        },
        next: (type, timeoutMs = 5000) =>
          new Promise((res, rej) => {
            const early = arrived.findIndex((m) => m.type === type);
            if (early >= 0) {
              res(arrived.splice(early, 1)[0] as ServerMessage);
              return;
            }
            const waiter = { type, resolve: res };
            waiting.push(waiter);
            setTimeout(() => {
              const j = waiting.indexOf(waiter);
              if (j >= 0) waiting.splice(j, 1);
              rej(new Error(`timeout waiting for ${type}`));
            }, timeoutMs).unref();
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
  killAll(); // a failed check must not leave its servers running
  process.exit(1);
});
