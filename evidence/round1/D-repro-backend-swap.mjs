import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const { createStore, jsonFallbackPath } = await import('/home/user/gta-2/server/dist/economy/createStore.js');
const { FileStore } = await import('/home/user/gta-2/server/dist/economy/store.js');
const { Ledger } = await import('/home/user/gta-2/server/dist/economy/ledger.js');
const { Accounts } = await import('/home/user/gta-2/server/dist/economy/accounts.js');
const { nodePasswords } = await import('/home/user/gta-2/server/dist/platform/nodePasswords.js');

const dir = mkdtempSync(join(tmpdir(), 'swap-'));
const dbPath = join(dir, 'persist.db');           // what PERSIST_PATH says
const jsonPath = jsonFallbackPath(dbPath);        // where the fallback landed

// Boot 1: this Node had no node:sqlite, so createStore fell back to the .json.
const fallback = new FileStore(jsonPath);
await new Accounts(fallback, nodePasswords).register('erin', 'pw');
new Ledger(fallback).append('acct:erin', 25000, 'a-week-of-play', 'r1');
console.log('after the fallback run :', jsonPath, 'exists =', existsSync(jsonPath),
  '| erin balance =', new Ledger(new FileStore(jsonPath)).balance('acct:erin'));

// Boot 2: same PERSIST_PATH, same volume, a base image whose Node HAS node:sqlite.
const warns = [];
const store = createStore(dbPath, (m) => warns.push(m));
console.log('after the node bump    :', store.constructor.name,
  '| erin account =', store.getAccount('erin'),
  '| erin balance =', new Ledger(store).balance('acct:erin'));
console.log('warnings printed       :', warns.length);
console.log('the .json is still on disk, untouched and unread:', existsSync(jsonPath));
