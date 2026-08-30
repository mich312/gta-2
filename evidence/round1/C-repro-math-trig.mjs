/**
 * Lens C, finding 3: `Math.atan2` / `Math.hypot` in shared sim code.
 *
 *   node evidence/round1/C-repro-math-trig.mjs
 *
 * PLAN.md §5 and the header of `shared/src/math/trig.ts` both state the rule:
 * "No Math.sin/cos/atan2/pow in sim code" — only `+ - * / sqrt` are IEEE-exact
 * across engines. Three call sites in `shared/src/sim` break it, and all three
 * feed fields that `hashSnapshot` hashes.
 */
import { dAtan2, wrapAngle, HALF_PI } from '../../shared/dist/math/trig.js';

// --- 1. Math.hypot is NOT the exactly-rounded value sqrt(x*x+y*y) gives -----
let differs = 0;
let firstH = null;
for (let i = 1; i < 200000; i++) {
  const x = (i % 997) + 0.125;
  const y = (i % 577) + 0.375;
  const a = Math.hypot(x, y);
  const b = Math.sqrt(x * x + y * y);
  if (a !== b) { differs++; if (!firstH) firstH = { x, y, hypot: a, sqrt: b }; }
}
console.log(`Math.hypot !== Math.sqrt(x*x+y*y) in ${differs}/199999 samples — so its last bit is`);
console.log(`implementation-defined, not pinned. first: ${JSON.stringify(firstH)}\n`);

// --- 2. traffic.ts:1397 — the carjack path writes a hashed field -----------
// `ejectDriver` does d = Math.hypot(dx, dy); ped.dirX = dx / d; ped.dirY = dy / d.
// `ped.dirX` / `ped.dirY` are hashed (net/hash.ts, the peds loop) and shipped.
let dirDiff = 0;
let tested = 0;
let firstD = null;
for (let dx = -20; dx <= 20; dx += 0.125) {
  for (let dy = -20; dy <= 20; dy += 0.125) {
    if (dx === 0 && dy === 0) continue;
    tested++;
    const dH = Math.hypot(dx, dy);
    const dS = Math.sqrt(dx * dx + dy * dy);
    if (dx / dH !== dx / dS || dy / dH !== dy / dS) {
      dirDiff++;
      if (!firstD) firstD = { dx, dy, dirX_hypot: dx / dH, dirX_exact: dx / dS };
    }
  }
}
console.log(`carjack door offsets tested: ${tested}`);
console.log(`ped.dirX/dirY differs from the exact-ops form in ${dirDiff} (${(100 * dirDiff / tested).toFixed(1)}%)`);
console.log(`first: ${JSON.stringify(firstD)}\n`);

// --- 3. weapons.ts:361-363 — the shield verdict is a knife edge -------------
// damageCop: facing = Math.atan2(...), bearing = Math.atan2(...),
//            frontal = |wrapAngle(bearing - facing)| < HALF_PI, and a frontal
//            hit on SWAT/army deals 0.6x / 0.75x. One ulp decides the verdict.
let flips = 0;
let n = 0;
let firstF = null;
for (let vx = -80; vx <= 80; vx += 0.125) {
  for (let vy = -80; vy <= 80; vy += 8) {
    for (let ax = -200; ax <= 200; ax += 37) {
      for (let ay = -200; ay <= 200; ay += 41) {
        if (ax === 0 && ay === 0) continue;
        n++;
        const frontM = Math.abs(wrapAngle(Math.atan2(ay, ax) - Math.atan2(vy, vx))) < HALF_PI;
        const frontD = Math.abs(wrapAngle(dAtan2(ay, ax) - dAtan2(vy, vx))) < HALF_PI;
        if (frontM !== frontD) {
          flips++;
          if (!firstF) {
            firstF = {
              copVel: [vx, vy],
              attackerOffset: [ax, ay],
              MathAtan2Angle: wrapAngle(Math.atan2(ay, ax) - Math.atan2(vy, vx)),
              dAtan2Angle: wrapAngle(dAtan2(ay, ax) - dAtan2(vy, vx)),
              frontal_Math: frontM,
              frontal_pinned: frontD,
            };
          }
        }
      }
    }
  }
}
console.log(`SWAT shield verdict: ${n} (cop velocity, attacker offset) pairs tested`);
console.log(`the frontal/behind verdict differs between Math.atan2 and the pinned dAtan2 in ${flips}`);
console.log(`first: ${JSON.stringify(firstF)}`);
console.log(`(the angle difference there is ${Math.abs((firstF.MathAtan2Angle - firstF.dAtan2Angle)).toExponential(2)} rad —`);
console.log(` a sub-ulp wobble decides a 0.6x damage multiplier on a hashed field.)`);
