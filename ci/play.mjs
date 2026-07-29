import { chromium } from 'playwright';

/**
 * Drive the real game in a real browser and take pictures of it.
 *
 * The contact sheets check the drawings; this checks the GAME — that the
 * server, the client, the sim and the art agree once they are all running at
 * once. Every action goes through the ordinary input path, keys and mouse.
 * `window.__debug` is READ, never written: it is used to know when a thing
 * has happened, not to make it happen.
 *
 *   PROVING_GROUND=1 PORT=8099 node server/dist/index.js
 *   pnpm --filter client dev -- --port 5199
 *   node play.mjs "http://localhost:5199/?server=ws://127.0.0.1:8099" shots
 */
const [url, outDir] = process.argv.slice(2);
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const p = await b.newPage({ viewport: { width: 1280, height: 720 } });
const errs = [];
p.on('pageerror', (e) => errs.push(String(e)));

await p.goto(url, { waitUntil: 'networkidle' });
await p.waitForTimeout(2500);
await p.mouse.click(640, 360);
await p.waitForTimeout(1200);

const dbg = () => p.evaluate(() => {
  const d = window.__debug ?? {};
  return {
    x: Math.round(d.me?.pos?.x ?? 0), y: Math.round(d.me?.pos?.y ?? 0),
    mode: d.me?.mode, heat: Math.round(d.me?.heat ?? 0),
    wanted: d.me?.wantedLevel ?? 0, unseen: d.me?.unseenTicks ?? 0,
    cops: d.cops ?? 0,
  };
});
const shot = (n) => p.screenshot({ path: `${outDir}/${n}.png` });
const hold = async (keys, ms) => {
  for (const k of keys) await p.keyboard.down(k);
  await p.waitForTimeout(ms);
  for (const k of keys) await p.keyboard.up(k);
};
/** Fire in a sweep around the avatar: roughly what a spree looks like. */
const spray = async (rounds, ms = 130) => {
  for (let i = 0; i < rounds; i++) {
    const a = (i / rounds) * Math.PI * 2;
    await p.mouse.move(640 + Math.cos(a) * 250, 360 + Math.sin(a) * 210);
    await p.mouse.down();
    await p.waitForTimeout(ms);
    await p.mouse.up();
    await p.waitForTimeout(40);
  }
};

await shot('01-street');
console.log('street:', JSON.stringify(await dbg()));

// Kit from the proving ground: J is the arsenal row. Then an automatic.
await p.keyboard.press('KeyJ');
await p.waitForTimeout(400);
await p.keyboard.press('Digit3');
await p.waitForTimeout(200);

// Walk out of the depot and onto a street, spraying as we go. A crowd is
// what turns a gun into a wanted level.
const WALK = [['KeyS'], ['KeyD'], ['KeyS', 'KeyD'], ['KeyA'], ['KeyW']];
for (let i = 0; i < 30; i++) {
  await hold(WALK[i % WALK.length], 700);
  await spray(8);
  const st = await dbg();
  if (i % 5 === 0) console.log(' ', i, JSON.stringify(st));
  if (st.wanted >= 3) break;
}
console.log('wanted:', JSON.stringify(await dbg()));
await shot('02-wanted');

for (let i = 0; i < 14 && (await dbg()).cops < 2; i++) {
  await spray(4);
  await p.waitForTimeout(500);
}
console.log('response:', JSON.stringify(await dbg()));
await shot('03-response');

// Now run for it, and watch the stars dim as the cool-down starts.
for (let i = 0; i < 14; i++) {
  await hold([['KeyA'], ['KeyW'], ['KeyA', 'KeyW'], ['KeyW']][i % 4], 800);
  const st = await dbg();
  if (st.unseen > 30 && st.wanted > 0) break;
}
console.log('hiding:', JSON.stringify(await dbg()));
await shot('04-hiding');

await hold(['KeyW'], 2000);
console.log('final:', JSON.stringify(await dbg()));
await shot('05-final');

if (errs.length) console.log('PAGE ERRORS:\n' + errs.slice(0, 6).join('\n'));
await b.close();
