# Lens C — the simulation: physics, damage, car AI, police

Round 1, at `1469611`. Ground truth taken as given (build clean; 943 tests, 0
failures; `citybake --check` 0 errors). Every finding below carries a
repro script in this directory that runs against `shared/dist` + `server/dist`
as built.

`pnpm chase` was run and its numbers do **not** contradict the docs once the
tool's own caveat is applied: at 2 stars it reports 3/12 escapes against
ROADMAP C3's "escapable at 1–2, usually", but tracing seed 3 shows the
autopilot drives into a wall at 200 px/s in the first 1.4 s and then holds the
throttle against it for the rest of the run — that measures the autopilot, as
`chase.ts`'s own comment says. Not filed.

## Motorised pursuit shuts down permanently: an officer who leaves a cruiser never gets another, and the cruiser is never removed

severity: significant
lens: C
where: `shared/src/sim/police.ts:678` and `:747` (dismount / bail-out set `v.driverId = null` and drop `cop.vehicleId`), `:1110` (despawn does the same), `motorise` at `:571-593` (only ever called from `maybeSpawnCop`, and its budget counts **all** vehicles of the kind, abandoned ones included)
evidence:
```
$ node evidence/round1/C-repro-copcars.mjs 4 240 mortal
t= 15s  copcars=5 (driven 2, abandoned 3)  tanks=0  live officers=5   motorised=2
t= 30s  copcars=6 (driven 2, abandoned 4)  tanks=0  live officers=24  motorised=2
t= 45s  copcars=6 (driven 0, abandoned 6)  tanks=0  live officers=24  motorised=0
...
t=225s  copcars=6 (driven 0, abandoned 6)  tanks=0  live officers=24  motorised=0

officers dispatched: 308; ever had a car: 6; still in one at the end: 0
```
With an unkillable fugitive the same thing happens faster and with fewer
moving parts — `node evidence/round1/C-repro-copcars.mjs 4 180` gives
`officers dispatched: 5; ever had a car: 4; still in one at the end: 0`, and
`motorised=0` from t=30 s to the end. Three mechanisms compound: (a) `motorise`
is reachable only at spawn, so a dismounted officer is on foot for the rest of
their life; (b) the cruiser they left is `condition: 'ok'` with a null driver,
so nothing in the sim ever removes it — only wrecks get a despawn fuse
(`vehicleDamage.ts:545-585`) and the traffic cull only touches `isAiDriver`
vehicles (`traffic.ts:1129-1148`); (c) those abandoned cars still count in
`motorise`'s `cars >= vehicleCaps[kind]` test, so once six exist no officer in
the city can ever be given a cruiser again, for the life of the process.
repro: `node evidence/round1/C-repro-copcars.mjs 4 240 mortal`
why it matters: this is the whole of ROADMAP C3. After roughly 30–45 s of the
first 3+ star chase on a server, every police response is an on-foot posse at
73–88 px/s against a car at 330 — the exact hole C3 was written to close — and
the city fills with permanently parked police cars.
prior art: `PROGRESS.md` "Police pursuit driving" records this same end state
("**all six** motorised officers abandoned their cars within ~20 ticks … the
motorised response was an on-foot posse that spawned litter") and claims it
fixed: "cruisers stay in the chase". Promote: the driving got better, but the
terminal state is unchanged and now permanent — 6 of 308 officers ever saw a
car, and the litter is what closes the budget.

## `noticedBy` is the one sight test that skips both of its filters: a corpse witnesses crimes, and an invisible player is seen

severity: significant
lens: C
where: `shared/src/sim/police.ts:172-188` — the loop does `if (!cop) continue;` and then `hasLineOfSight(...)`, with no `copIsDown(cop)` test and no `POWER_INVISIBLE` test, unlike `anyCopSees` (`:57`) and `copSees` (`:70`)
evidence:
```
$ node evidence/round1/C-repro-corpse-witness.mjs
no officer at all (control)        noticedBy(noise 34) = false  heat after 60 silenced shots = 0.0   unseenTicks = 0
one LIVE officer, 80 px away       noticedBy(noise 34) = true   heat after 60 silenced shots = 18.0  unseenTicks = 0
one DEAD officer (a corpse)        noticedBy(noise 34) = true   heat after 60 silenced shots = 18.0  unseenTicks = 10
LIVE officer, player INVISIBLE     noticedBy(noise 34) = true   heat after 60 silenced shots = 18.0  unseenTicks = 10
DEAD officer, player INVISIBLE     noticedBy(noise 34) = true   heat after 60 silenced shots = 18.0  unseenTicks = 10
```
The weapon is `silenced` (`noiseRadius` 34) fired 80 px from the officer, so
the noise branch cannot fire — only the sight branch can, and it fires for a
body and for an invisible player alike, indistinguishably from a live one.
repro: `node evidence/round1/C-repro-corpse-witness.mjs`
why it matters: `weapons.ts:271` turns that verdict into `addHeat`, and
`addHeat` (`state.ts:757`) resets `unseenTicks` to 0. So a street you have
cleared of officers goes on reporting you for the 40 s the bodies lie there,
and the invisibility power-up — whose stated job (`police.ts:885-892`) is that
you should not have to spend half of it waiting out a search — cannot stop the
cool-down clock being pinned at zero every time you pull a trigger.
prior art: none found for `noticedBy`. `police.ts:55` records the identical bug
being fixed in `anyCopSees` ("A body witnesses nothing. Without this the
officer you just shot went on reporting your car thefts from the pavement");
`noticedBy` sits fifteen lines below it and was not given the same filter.

## `Math.atan2` and `Math.hypot` in shared sim code, writing fields that `hashSnapshot` hashes

severity: significant
lens: C
where: `shared/src/sim/weapons.ts:361-363` (`damageCop`'s shield facing), `shared/src/sim/traffic.ts:1397` (`ejectDriver`, the carjack path), `shared/src/sim/police.ts:480` and `:778`
evidence:
```
$ node evidence/round1/C-repro-math-trig.mjs
Math.hypot !== Math.sqrt(x*x+y*y) in 72244/199999 samples
carjack door offsets tested: 103040
ped.dirX/dirY differs from the exact-ops form in 34056 (33.1%)
SWAT shield verdict: 2959110 (cop velocity, attacker offset) pairs tested
the frontal/behind verdict differs between Math.atan2 and the pinned dAtan2 in 19
first: {"copVel":[-80,-40],"attackerOffset":[59,-118],"frontal_Math":false,"frontal_pinned":true}
```
`shared/src/math/trig.ts:1-7` states the rule — "Math.sin/cos/atan2 are not
IEEE-pinned … Sim code must never call Math trig directly" — and `PLAN.md` §5
repeats it ("No `Math.sin/cos/atan2/pow` in sim code … `+ - * / sqrt` are
IEEE-exact and fine"). `weapons.ts` imports `HALF_PI, PI, dCos, dSin,
wrapAngle` from that module and then calls `Math.atan2` three times. The
outputs are not cosmetic: `ejectDriver` writes `ped.dirX`/`ped.dirY`, both
hashed in `net/hash.ts`'s peds loop, on every carjack; `damageCop`'s verdict
scales a SWAT/army hit by `frontalDamage` (0.6 / 0.75) and so writes
`cop.health`, also hashed. The shield verdict is a knife edge: at the input
above a 2.2e-16 rad difference flips it.
repro: `node evidence/round1/C-repro-math-trig.mjs`
why it matters: `ci/hostParity.mjs` exists to prove `step()` is bit-identical
in Node and in a browser, and it runs the *whole* step including `stepPolice`
and `stepTraffic`. These three call sites are latent cross-engine desyncs
sitting on the game's headline verb (carjacking) and on the top two police
tiers; today they are invisible only because both hosts happen to be V8.
prior art: `WORLDGEN.md` §41.5 records exactly this defect class being found
and fixed in worldgen — "`Math.hypot` where `Math.sqrt` was required — ECMA-262
pins the second to the exactly rounded result and leaves the first
approximated … it was a desync waiting for the right map". The same sweep was
never done over `shared/src/sim`.

## The car bomb is free arson, and its casualties are credited to nobody

severity: significant
lens: C
where: `shared/src/sim/fittings.ts:54-58` — the `bomb` case assigns `v.condition = 'burning'` and `v.fuseAtTick` by hand instead of going through `damageVehicle`, so `chargeForArson` (`vehicleDamage.ts:297`) never runs and `v.igniterId` is never set; `detonateVehicle` then credits `v.igniterId ?? v.driverId ?? -1` (`vehicleDamage.ts:433`)
evidence:
```
$ node evidence/round1/C-repro-carbomb.mjs
heatPerVehicleKill = 40, heatPerOccupiedVehicleKill = 70

bomb : condition=burning health=200 igniterId=null  |  arsonist's heat at ignition = 0.00
gun  : condition=burning health=  0 igniterId=1     |  arsonist's heat at ignition = 40.00

after the fuse: car condition=wreck; the blast's attackerId was
igniterId(null) ?? driverId(null) ?? -1 = -1 — nobody.
planter's heat = 0.00, wanted level = 0
```
Same car, same street, two ways of setting it alight: shooting it costs 40 heat
and names you as the igniter; the purpose-built bomb costs nothing and names
no one. Because the design is "you set it and you get out", `driverId` is null
by the time the fuse runs, so `blast` is called with `attackerId = -1` and
every player, officer and pedestrian it kills is an unattributed death — no
heat, no kill credit, no frenzy progress. A side effect of the same two lines:
the car burns with `health` still at full (200), so `vehicleWear` reports 0.
repro: `node evidence/round1/C-repro-carbomb.mjs`
why it matters: `GAPS.md` K1 called an unattributed car explosion "both wrong
and a live exploit: it is the only violent act in the game with no cost". K1
shipped, and it closed every ignition path except the one the player buys
specifically in order to blow a car up in a crowd.
prior art: `GAPS.md` K1 (arson attribution, `igniterId`) — built, and it lists
the call sites it threaded; the bomb-arming branch is not one of them because
it never calls `damageVehicle` at all. Promote: K1's own stated exploit is
still open through the fitting sold for it.

## `maybeRoadblock`'s per-kind vehicle budget is algebraically a no-op, and the city goes 2 over

severity: significant
lens: C
where: `shared/src/sim/police.ts:775` — `if (cars + 2 > (t.vehicleCaps[kind] ?? t.maxCopCars) + 2) return;`
evidence: the `+ 2` that is meant to ask "will the two I am about to place still
fit?" appears on both sides and cancels, so the test is `cars > cap` and a
roadblock is allowed whenever the budget is exactly full.
```
$ node evidence/round1/C-repro-roadblock-cap.mjs
vehicleCaps = {"copcar":6,"tank":3}  maxCopCars = 6
seed  11: peak copcars in the world = 8   <-- over budget
seed  47: peak copcars in the world = 7   <-- over budget
seed  89: peak copcars in the world = 7   <-- over budget
seed 101: peak copcars in the world = 8   <-- over budget

worst: 8 copcars against a stated per-kind budget of 6 (seed 11)
```
repro: `node evidence/round1/C-repro-roadblock-cap.mjs`
why it matters: `vehicleCaps.tank` is 3, and `roadblockVehicle` is `tank` at 5
and 6 stars — by the same arithmetic a five-star roadblock may place two more
tanks on top of a full budget, which is precisely what the budget was added to
prevent. The overshoot is also permanent: roadblock cars are spawned with no
driver and, per the first finding, nothing ever removes them, so the two extra
slots stay occupied and further squeeze `motorise`.
prior art: `GTA.md` P3c states the intent — "**`maxCopCars`** gains a per-kind
budget so the city cannot end up with six tanks in it" — but the defect in the
check is recorded nowhere.
