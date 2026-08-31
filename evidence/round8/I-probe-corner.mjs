/**
 * When, in a scripted corner, is the car actually sliding?
 *
 *   node evidence/round8/I-probe-corner.mjs
 *
 * `play-drift`'s first fixed run photographed a car standing still against a
 * kerb with its marks behind it: the straight was long enough to reach the far
 * side of the junction before the wheel went over. This samples the whole
 * manoeuvre at 100 ms — speed from two position reads, and the decal pool
 * (`__debug.fx.decals`) for the rubber — so the durations in the script come
 * off a measurement instead of a guess.
 *
 * `window.__debug` is READ only.
 */
import { chromium } from 'playwright';

const origin = process.env.CLIENT_ORIGIN ?? 'http://localhost:5961';
const b = await chromium.launch({
  executablePath: process.env.CHROMIUM ?? '/opt/pw-browsers/chromium',
});
const p = await b.newPage({ viewport: { width: 1440, height: 810 }, deviceScaleFactor: 1 });
await p.goto(`${origin}/?local=1&render=2d&extrude=1&seed=7&night=0`, {
  waitUntil: 'load',
  timeout: 120000,
});
await p.waitForFunction(() => (globalThis.__debug?.tick ?? -1) > 30, null, { timeout: 120000 });
await p.waitForTimeout(1500);
await p.mouse.click(720, 405);
await p.waitForTimeout(1200);

const dbg = () =>
  p.evaluate(() => {
    const d = globalThis.__debug ?? {};
    const m = d.me ?? {};
    return {
      mode: m.mode,
      decals: d.fx?.decals ?? 0,
      nearest: d.nearestVehicle,
      x: m.pos?.x ?? 0,
      y: m.pos?.y ?? 0,
    };
  });
const hold = async (keys, ms) => {
  for (const k of keys) await p.keyboard.down(k);
  await p.waitForTimeout(ms);
  for (const k of keys) await p.keyboard.up(k);
};

// The harness's own walk-up, copied rather than approximated: a probe that
// measures a corner from the pavement measures walking.
{
  const until = Date.now() + 90000;
  let bestDist = Infinity;
  let stalled = 0;
  let doorTries = 0;
  while (Date.now() < until) {
    const s = await dbg();
    if (s.mode === 'driving') break;
    const n = s.nearest;
    if (!n) {
      await hold(['KeyD'], 300);
      continue;
    }
    if (n.dist < 30) {
      doorTries++;
      await hold(['KeyE'], 250);
      await p.waitForTimeout(300);
      if (doorTries % 6 === 0) await hold(['KeyA', 'KeyW'], 600);
      continue;
    }
    if (n.dist < bestDist - 4) {
      bestDist = n.dist;
      stalled = 0;
    } else if (++stalled >= 4) {
      await hold([Math.abs(n.dx) > Math.abs(n.dy) ? 'KeyW' : 'KeyD'], 500);
      stalled = 0;
      bestDist = Infinity;
      continue;
    }
    const keys = [];
    if (n.dy < -5) keys.push('KeyW');
    else if (n.dy > 5) keys.push('KeyS');
    if (n.dx < -5) keys.push('KeyA');
    else if (n.dx > 5) keys.push('KeyD');
    await hold(keys.length ? keys : ['KeyD'], 240);
  }
}
console.log('mode before the run-up:', (await dbg()).mode);

const t0 = Date.now();
let prev = await dbg();
const rows = [];
await p.keyboard.down('KeyW');
let wheelAt = null;
for (let i = 0; i < 60; i++) {
  await p.waitForTimeout(100);
  const s = await dbg();
  const dt = 0.1;
  rows.push({
    ms: Date.now() - t0,
    px: Math.round(Math.hypot(s.x - prev.x, s.y - prev.y) / dt),
    decals: s.decals,
    wheel: wheelAt !== null,
  });
  prev = s;
  // Wheel over once the car is past the skid threshold and has had a moment
  // to settle on the straight.
  if (wheelAt === null && rows.length >= 26) {
    await p.keyboard.down('KeyD');
    wheelAt = rows.length;
  }
}
await p.keyboard.up('KeyW');
await p.keyboard.up('KeyD');

console.log(`wheel over at sample ${wheelAt} (${wheelAt * 100} ms)`);
console.log('ms\tpx/s\tdecals\twheel');
for (const r of rows) console.log(`${r.ms}\t${r.px}\t${r.decals}\t${r.wheel ? 'D' : ''}`);
await b.close();
