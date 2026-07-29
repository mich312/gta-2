/**
 * Drive the real game with no server, and photograph it.
 *
 *   pnpm --filter client dev
 *   node ci/playLocal.mjs [outDir]
 *
 * `ci/play.mjs` does the same job against a running server. This one uses the
 * offline host (`?local=1`, SHIP.md T1), so a capture needs one process
 * instead of two and a fixed seed gives the same city every time.
 *
 * Everything goes through the ordinary input path — keys and mouse.
 * `window.__debug` is READ, never written: it is used to know when something
 * has happened, not to make it happen.
 *
 * Two things learned the hard way, both encoded below:
 *
 * - **Hold E, do not press it.** `action` is sampled level-triggered once per
 *   30 Hz tick (`keyboard.ts` — `this.has('KeyE', 'Enter')`), so a fast
 *   down/up can land entirely between two samples and be missed. Holding for
 *   ~250 ms is reliable; `keyboard.press` is not.
 * - **The enter radius is wider than the walk-up gets you.** A mover pressed
 *   against a car stops about 18 px from its centre, because the car is
 *   solid. Trigger the door at 30 px or the approach loop spins forever.
 *
 * What this does NOT do is stage a police chase. Scripted sprays into a crowd
 * do not reliably produce a wanted level — the same unreliability
 * `evidence/README.md` records for `ci/play.mjs`. The wanted states are
 * covered by `/hud-sheet.html`, and the chase itself by `pnpm chase`, which
 * measures escape rate per star level instead of hoping for one.
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const outDir = process.argv[2] ?? 'evidence';
const origin = process.env.CLIENT_ORIGIN ?? 'http://localhost:5173';
mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM ?? '/opt/pw-browsers/chromium',
});

const dbg = (page) =>
  page.evaluate(() => {
    const d = globalThis.__debug ?? {};
    const m = d.me ?? {};
    return {
      mode: m.mode,
      wanted: m.wantedLevel ?? 0,
      cops: d.cops ?? 0,
      health: Math.round(m.health ?? 0),
      weapon: m.weapons?.[m.activeWeapon]?.weaponId,
      ammo: m.weapons?.[m.activeWeapon]?.ammo,
      nearest: d.nearestVehicle,
      vehicles: d.vehicles,
      peds: d.peds,
      pos: { x: Math.round(m.pos?.x ?? 0), y: Math.round(m.pos?.y ?? 0) },
    };
  });

const hold = async (page, keys, ms) => {
  for (const k of keys) await page.keyboard.down(k);
  await page.waitForTimeout(ms);
  for (const k of keys) await page.keyboard.up(k);
};

/** Walk to the nearest car and get in. Returns whether it worked. */
async function getInCar(page) {
  for (let i = 0; i < 30; i++) {
    const s = await dbg(page);
    if (s.mode === 'driving') return true;
    const n = s.nearest;
    if (!n) {
      await hold(page, ['KeyD'], 300);
      continue;
    }
    if (n.dist < 30) {
      await hold(page, ['KeyE'], 250); // held, not pressed — see the header
      await page.waitForTimeout(300);
      continue;
    }
    const keys = [];
    if (n.dy < -5) keys.push('KeyW');
    else if (n.dy > 5) keys.push('KeyS');
    if (n.dx < -5) keys.push('KeyA');
    else if (n.dx > 5) keys.push('KeyD');
    await hold(page, keys.length ? keys : ['KeyD'], 240);
  }
  return false;
}

async function scene(name, query, script) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 810 }, deviceScaleFactor: 1 });
  const errs = [];
  page.on('pageerror', (e) => errs.push(String(e)));
  await page.goto(`${origin}/?local=1&extrude=1&${query}`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(2600);
  // The canvas wants focus before it sees a key, and the audio context wants
  // a gesture before it starts.
  await page.mouse.click(720, 405);
  await page.waitForTimeout(700);

  await script(page);

  await page.screenshot({ path: `${outDir}/${name}.png` });
  console.log(`${name}: ${JSON.stringify(await dbg(page))}`);
  if (errs.length) console.log(`  page errors: ${errs.slice(0, 3).join(' | ')}`);
  await page.close();
}

// Dusk: headlight cones, lamp pools, traffic under signals. The one shot that
// shows the lighting pass and the parallax extrusion doing their jobs at once.
await scene('play-dusk', 'seed=7&night=0.55', async (page) => {
  await getInCar(page);
  await hold(page, ['KeyW'], 2200);
});

// Daylight, cornering hard enough to lay rubber down.
await scene('play-drift', 'seed=7&night=0', async (page) => {
  await getInCar(page);
  await hold(page, ['KeyW'], 1800);
  await hold(page, ['KeyW', 'KeyD'], 900);
  await hold(page, ['KeyW'], 1200);
});

// On foot, armed. Slot 2 is the pistol every player spawns with — no proving
// ground needed, which keeps the capture on an ordinary session.
await scene('play-foot', 'seed=7&night=0.12', async (page) => {
  await hold(page, ['Digit2'], 150);
  await page.waitForTimeout(400);
  await hold(page, ['KeyS'], 900);
  await page.mouse.move(980, 300);
  await page.mouse.down();
  await page.waitForTimeout(200);
  await page.mouse.up();
});

await browser.close();
