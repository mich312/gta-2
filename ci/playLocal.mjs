/**
 * Drive the real game with no server, and photograph it.
 *
 *   pnpm --filter client dev            # or: client/node_modules/.bin/vite client
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
 * Four things learned the hard way, all encoded below:
 *
 * - **Ask for the renderer the plates are of.** `main.ts` reads
 *   `render !== '2d'`, so 3D is the DEFAULT and a URL that says nothing gets
 *   it. These three plates are 2D-renderer plates — `extrude=1`, which this
 *   script has always passed, is read only by the 2D tile layer
 *   (`tiles.extruded`), and "buildings leaning away from the camera" in
 *   `evidence/README.md` is that flag. So `render=2d` is now explicit. It is
 *   also the whole of why this script could never finish on a box without a
 *   GPU: measured on the CI box (`evidence/round8/`), the same session runs at
 *   **0.37 fps through 3D on SwiftShader and 57-60 fps through 2D**, and a
 *   screenshot costs 43 s against 0.2 s. The 3D client has its own plate,
 *   `render-3d-client.png`; it is not this script's job.
 * - **Hold E, do not press it.** `action` is sampled level-triggered once per
 *   30 Hz tick (`keyboard.ts` — `this.has('KeyE', 'Enter')`), so a fast
 *   down/up can land entirely between two samples and be missed. Holding for
 *   ~250 ms is reliable; `keyboard.press` is not.
 * - **The enter radius is wider than the walk-up gets you.** A mover pressed
 *   against a car stops about 18 px from its centre, because the car is
 *   solid. Trigger the door at 30 px or the approach loop spins forever.
 * - **Never photograph a scene you did not stage.** Every shot below declares
 *   what must be true of `__debug` at the moment the shutter opens, and a
 *   scene that cannot meet it throws instead of writing the frame. A round-5
 *   run wrote a `play-dusk.png` with the player still on foot holding
 *   `fists`, because `getInCar` returned false and nothing looked.
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

/**
 * Below this the capture is not worth taking. Input is sampled once per frame
 * and at most `MAX_CATCHUP_TICKS` (5) sim ticks are spent per frame
 * (`main.ts:723`), so a client under 6 fps cannot feed the sim its 30 ticks a
 * second at all: held keys turn into slow motion and every wall-clock duration
 * below means something different from what it says. 20 fps leaves headroom.
 */
const MIN_FPS = 20;

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
      fps: Math.round(d.fps ?? 0),
      decals: d.fx?.decals ?? 0,
      particles: d.fx?.particles ?? 0,
      carKind: d.carKind,
      pos: { x: Math.round(m.pos?.x ?? 0), y: Math.round(m.pos?.y ?? 0) },
    };
  });

const hold = async (page, keys, ms) => {
  for (const k of keys) await page.keyboard.down(k);
  await page.waitForTimeout(ms);
  for (const k of keys) await page.keyboard.up(k);
};

/**
 * How fast the player is travelling, from two position reads.
 *
 * `__debug` publishes the driven car's health, wear, condition, altitude and
 * kind but not its speed, so this is the only way to ask — and it is the
 * question the drift scene turns on.
 */
async function speedPxPerSec(page, overMs = 150) {
  const a = (await dbg(page)).pos;
  await page.waitForTimeout(overMs);
  const b = (await dbg(page)).pos;
  return Math.round(Math.hypot(b.x - a.x, b.y - a.y) / (overMs / 1000));
}

/** Wait for the car to be doing `px/s`, rather than for a number of seconds. */
async function waitForSpeed(page, target, budgetMs) {
  const until = Date.now() + budgetMs;
  let best = 0;
  while (Date.now() < until) {
    const v = await speedPxPerSec(page);
    if (v > best) best = v;
    if (v >= target) return v;
  }
  return -best;
}

/**
 * Walk to the nearest car and get in. Returns whether it worked.
 *
 * Bounded by wall clock rather than by iteration count: an iteration is one
 * key hold plus one `__debug` read, and how much ground that covers depends on
 * the frame rate, so thirty of them is not a budget, it is a number. The door
 * gets several tries — a walk-up can arrive between two `action` samples — and
 * an approach that stops making progress sidesteps rather than leaning on the
 * same key into the same wall.
 */
async function getInCar(page, budgetMs = 90000) {
  const until = Date.now() + budgetMs;
  let bestDist = Infinity;
  let stalled = 0;
  let doorTries = 0;
  while (Date.now() < until) {
    const s = await dbg(page);
    if (s.mode === 'driving') return true;
    const n = s.nearest;
    if (!n) {
      await hold(page, ['KeyD'], 300);
      continue;
    }
    if (n.dist < 30) {
      doorTries++;
      await hold(page, ['KeyE'], 250); // held, not pressed — see the header
      await page.waitForTimeout(300);
      // A door that will not open after several honest tries is a car wedged
      // against something; walk off and let `nearestVehicle` pick another.
      if (doorTries % 6 === 0) await hold(page, ['KeyA', 'KeyW'], 600);
      continue;
    }
    if (n.dist < bestDist - 4) {
      bestDist = n.dist;
      stalled = 0;
    } else if (++stalled >= 4) {
      // Pressed against something between here and the car. Slide along it.
      await hold(page, [Math.abs(n.dx) > Math.abs(n.dy) ? 'KeyW' : 'KeyD'], 500);
      stalled = 0;
      bestDist = Infinity;
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

/**
 * @param expect  Given the `__debug` read taken at the moment of the shot,
 *                return null if the frame shows what the caption claims, or
 *                the reason it does not. A scene that fails this writes no
 *                file and stops the run.
 */
async function scene(name, query, script, expect) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 810 }, deviceScaleFactor: 1 });
  const errs = [];
  page.on('pageerror', (e) => errs.push(String(e)));
  // `load`, not `networkidle`: the live client holds the connection open for
  // as long as the tab is (evidence/README.md), so idle is not a state it is
  // guaranteed to reach. What the script actually wants is a game, and the
  // game says so itself — `__debug.tick` is the sim's own clock.
  await page.goto(`${origin}/?local=1&render=2d&extrude=1&${query}`, {
    waitUntil: 'load',
    timeout: 120000,
  });
  await page.waitForFunction(() => (globalThis.__debug?.tick ?? -1) > 30, null, { timeout: 120000 });
  await page.waitForTimeout(1500);
  // The canvas wants focus before it sees a key, and the audio context wants
  // a gesture before it starts.
  await page.mouse.click(720, 405);
  await page.waitForTimeout(1200);

  const fps = (await dbg(page)).fps;
  if (fps < MIN_FPS) {
    throw new Error(
      `${name}: ${fps} fps, under the ${MIN_FPS} fps this capture needs. Held keys become ` +
        `slow motion below that and every duration in this script stops meaning what it says. ` +
        `Check the client is really on the 2D renderer.`,
    );
  }

  const staged = await script(page);

  const s = await dbg(page);
  const wrong = expect(s, staged);
  if (wrong) {
    throw new Error(`${name}: not staged — ${wrong}. state: ${JSON.stringify(s)}`);
  }
  // `justBefore` is the last thing that happens before the shutter, with no
  // `__debug` read between it and the capture. A muzzle flash lives 90 ms
  // (`render/effects.ts`) — shorter than a round trip plus a `dbg` read — so
  // anything that brief has to be triggered here rather than in the script.
  if (typeof staged?.justBefore === 'function') await staged.justBefore();
  await page.screenshot({ path: `${outDir}/${name}.png`, timeout: 120000 });
  console.log(`${name}: ${JSON.stringify(s)}`);
  if (errs.length) console.log(`  page errors: ${errs.slice(0, 3).join(' | ')}`);
  await page.close();
}

// Dusk: headlight cones, lamp pools, traffic under signals. The one shot that
// shows the lighting pass and the parallax extrusion doing their jobs at once.
await scene(
  'play-dusk',
  'seed=7&night=0.55',
  async (page) => {
    if (!(await getInCar(page))) throw new Error('play-dusk: never got into a car');
    await hold(page, ['KeyW'], 2200);
  },
  (s) => (s.mode === 'driving' ? null : `player is ${s.mode}, not driving`),
);

// Daylight, cornering hard enough to lay rubber down. `SKID_MIN_SPEED` is 170
// and `SKID_MIN_YAW_RATE` 1.9 rad/s (`render/sceneEffects.ts`), so the corner
// has to be taken with the throttle still down — and the decal pool has to
// show for it, or this is a picture of a car going round a bend.
//
// The straight is driven until the car is FAST, not for a number of seconds:
// where `getInCar` leaves you decides how much road there is, and a fixed
// 2.6 s run-up either arrives under the skid threshold or arrives at the far
// kerb. `evidence/round8/I-probe-corner.mjs` sampled the whole manoeuvre at
// 100 ms — from the wheel going over, the slide is worth about 350 ms and the
// car is into something by 550 — so the shutter opens inside that window,
// throttle and wheel still held. The first fixed run photographed the
// aftermath: a car standing still against a kerb with its marks behind it.
//
// And the corner is ATTEMPTED, not performed. Which way the car is pointing
// when the door shuts is not something this script chooses, so one run in
// three used to put the wheel over a car's length short of a wall. A failed
// attempt reverses out and goes again rather than photographing the wreck.
await scene(
  'play-drift',
  'seed=7&night=0',
  async (page) => {
    if (!(await getInCar(page))) throw new Error('play-drift: never got into a car');
    let why = 'no attempt made';
    for (let attempt = 1; attempt <= 5; attempt++) {
      await page.keyboard.up('KeyD');
      await page.keyboard.up('KeyW');
      if (attempt > 1) await hold(page, ['KeyS'], 800); // back off whatever we found
      await page.keyboard.down('KeyW');
      const runUp = await waitForSpeed(page, 200, 12000);
      if (runUp < 0) {
        await page.keyboard.up('KeyW');
        why = `never got past ${-runUp} px/s on the straight`;
        continue;
      }
      const before = (await dbg(page)).decals;
      await page.keyboard.down('KeyD');
      await page.waitForTimeout(120);
      const pxPerSec = await speedPxPerSec(page);
      const now = await dbg(page);
      if (pxPerSec >= 60 && now.decals > before) {
        return { decalsBeforeCorner: before, runUp, pxPerSec, attempt };
      }
      why =
        pxPerSec < 60
          ? `the car stopped in the corner at ${pxPerSec} px/s`
          : `no rubber: ${before} decals before, ${now.decals} after`;
    }
    throw new Error(`play-drift: five corners and no slide — last: ${why}`);
  },
  (s, staged) =>
    s.mode !== 'driving'
      ? `player is ${s.mode}, not driving`
      : s.decals <= staged.decalsBeforeCorner
        ? `no rubber laid: ${staged.decalsBeforeCorner} decals before the corner, ${s.decals} after`
        : staged.pxPerSec < 60
          ? `the car is not moving through the corner: ${staged.pxPerSec} px/s`
          : null,
);

// On foot, armed. Slot 2 is the pistol every player spawns with — no proving
// ground needed, which keeps the capture on an ordinary session. The old
// script fired once, waited 200 ms and then asked for a picture, which is
// longer than any part of a muzzle event lasts; this one shoots on the shot.
await scene(
  'play-foot',
  'seed=7&night=0.12',
  async (page) => {
    await hold(page, ['Digit2'], 250);
    await page.waitForTimeout(400);
    await hold(page, ['KeyS'], 900);
    const start = await dbg(page);
    await page.mouse.move(980, 300);
    // The whole muzzle event is short: the flash light lives 0.09 s, its
    // sparks 0.06-0.13 s and its smoke 0.28 s (`render/effects.ts`), and the
    // tracer 70 ms (`render/hud.ts`). The pistol is also one round per press,
    // so leaning on the button fires once and then nothing. Fire rounds until
    // the particle pool says one is still in the air, and open the shutter on
    // that — rather than firing once, waiting, and photographing the smoke's
    // absence.
    let live = start.particles;
    for (let i = 0; i < 12 && live <= start.particles; i++) {
      await page.mouse.down();
      await page.waitForTimeout(60);
      await page.mouse.up();
      live = (await dbg(page)).particles;
      if (live <= start.particles) await page.waitForTimeout(140);
    }
    return {
      start,
      particlesInFlight: live,
      // Three more rounds, the last with nothing between it and the capture.
      // The 90 ms flash is a coin toss whichever way this is written — the
      // capture is not synchronous with the game's frames — but muzzle smoke
      // lives 0.28 s, so a burst puts something at the barrel either way.
      justBefore: async () => {
        for (let i = 0; i < 3; i++) {
          await page.mouse.up();
          await page.waitForTimeout(50);
          await page.mouse.down();
          if (i < 2) await page.waitForTimeout(50);
        }
      },
    };
  },
  // Not the ammo count: `me` is the PREDICTED player and the round is spent by
  // the host, so a read taken 60 ms after the trigger still says 90. The
  // particle pool is local and immediate, and muzzle smoke has exactly one
  // source.
  (s, staged) =>
    s.mode !== 'foot'
      ? `player is ${s.mode}, not on foot`
      : s.weapon !== 'pistol'
        ? `weapon is ${s.weapon}, not the pistol`
        : staged.particlesInFlight > staged.start.particles
          ? null
          : `nothing left the barrel: ${staged.start.particles} particles before, ` +
            `${staged.particlesInFlight} after twelve trigger pulls`,
);

await browser.close();
