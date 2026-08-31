# Round 5 — lens C (the simulation: physics, damage, car AI, police)

Ground truth at `45bfb3b` taken as given (91 files / 970 tests / 0 failures,
`citybake --check` exit 0, `pnpm parity` OK hash 3118957723). Nothing below is
a failing test in the shipped suite; every finding carries its own script with
a live control.

---

## A pedestrian climbs into a parked police vehicle and both are lost for the rest of the session

severity: significant
lens: C
where: `shared/src/sim/traffic.ts:1111` (the "who is getting in" scan in `stepBoarding`)

evidence:
`stepBoarding`'s boarding scan tests only `!v || v.driverId !== null || v.condition !== 'ok'`.
It never asks `isPoliceVehicle` — the `copFleet` gate R1-C06's round-3 fix added
to `stepTraffic` (`traffic.ts:924`) and to the population cull (`traffic.ts:1170`).
So a parked vehicle in `copFleet` — a roadblock car or tank (`police.ts:980`,
`state.copFleet[id] = -1`), or a cruiser an officer dismounted from
(`police.ts:771`) — is eligible. The ped is deleted, the vehicle is given an
ambient driver id and a `trafficDrivers` record, and then **nothing ever
touches it again**:

* `stepTraffic:924` skips it (it is a police vehicle) — so it is never driven
  and `driver.trip` never advances, which is the condition `stepBoarding`'s
  alighting scan needs, so nobody ever gets out;
* `retireAbandoned` (`police.ts:869`) and `remount` (`police.ts:650`) skip it
  (`driverId !== null`);
* `stepTrafficPopulation:1170` counts it against the ambient budget and then
  refuses to cull it;
* its `trafficDrivers` record survives the sweep at `:1195` (`isAiDriver` is true).

```
$ node evidence/round5/C-repro-ped-boards-cruiser.mjs 1500 9000
CONTROL: ordinary car    boardedAt=3  stillOnMap=true driverId=-91001 driver.trip=1496 movedPx=108.5 pedsLeft=19 aiDrivenCars=14
copcar in copFleet       boardedAt=3  stillOnMap=true driverId=-91001 driver.trip=0    movedPx=0.0   pedsLeft=19 aiDrivenCars=14
staged 0 parked police cars, 9000 ticks: frozen=0  ambient traffic actually circulating=14 (target 14)
staged 2 parked police cars, 9000 ticks: frozen=2  ambient traffic actually circulating=12 (target 14)
staged 4 parked police cars, 9000 ticks: frozen=3  ambient traffic actually circulating=11 (target 14)
```
The control fires: an ordinary car boarded on the same tick drives 108 px and
racks up 1496 trip ticks. The police car does neither, over 9000 ticks (5 min),
and each one permanently costs the city one of its 14 ambient traffic slots.

End to end, with no staging at all — a five-star chase on foot with the crowd
topped up the way `session.ts` tops it up:
```
$ node evidence/round5/C-repro-ped-boards-cruiser.mjs 1500 500 natural
seed 3: first at tick 6323; frozen police vehicles 400231; tanks on the map at the end = 5 against vehicleCaps.tank = 3
seed 11: no natural boarding of a police vehicle in 18000 ticks
seed 29: first at tick 9690; frozen police vehicles 402152; tanks on the map at the end = 4 against vehicleCaps.tank = 3
seed 47: first at tick 9009; frozen police vehicles 402243; tanks on the map at the end = 1 against vehicleCaps.tank = 3
seed 61: first at tick 10759; frozen police vehicles 402217; tanks on the map at the end = 4 against vehicleCaps.tank = 3
seed 101: no natural boarding of a police vehicle in 18000 ticks
```
The vehicle it happens to is a **tank**, because `roadblockVehicle["5"]` is
`tank` and a roadblock pair is parked in the street the fugitive is in. Since
`motorise`'s budget counts every vehicle of the kind (`police.ts:593`) and
`vehicleCaps.tank` is 3, one frozen tank permanently spends a third of the
armoured allowance — the same permanent-budget-exhaustion shape R1-C01 fixed
for cruisers, reached through a door the C06 fix left open.

repro:
```
node evidence/round5/C-repro-ped-boards-cruiser.mjs 1500 9000          # staged, with control
node evidence/round5/C-repro-ped-boards-cruiser.mjs 1500 500 natural   # end to end, ~6 min
```

why it matters: a player who takes a five-star chase past a roadblock leaves a
tank standing in the road that nobody can ever move, that the force can never
replace, and that costs the city a car of ambient traffic — permanently, and
once per occurrence. Four of six seeds produced one inside ten minutes of play.

prior art: **known, and it is the un-fixed half of a closed entry.** R1-C06's
filing lists it explicitly — "also in range: `stepTrafficPopulation:1081-1083`
lets a **pedestrian** board an abandoned cruiser (`v.driverId !== null` is the
only occupancy test)" — and the round-3 fix note says the `copFleet` gate went
in "at two sites in `traffic.ts`: `stepTraffic`'s mint-and-steer, and the
population cull's **decision**". The boarding scan is a third site and was not
one of them; R1-C06 is nonetheless marked `[x] FIXED round 3`. Promote,
because the C06 fix is what made it permanent: before the gate, a boarded
cruiser was at least driven by `stepTraffic` and culled like any other ambient
car. GAPS.md's boarding gate ("a ped never boards an occupied, burning or
wrecked car") does not cover police vehicles.

---

## A body on the tarmac stops a bolted car gun's rounds, and bursts a rocket

severity: significant
lens: C
where: `shared/src/sim/fittings.ts:163-165` and `shared/src/sim/projectiles.ts:188-190`

evidence: `fireOnce` skips downed officers on purpose —
`weapons.ts:165`, `if (!cop || copIsDown(cop)) continue; // shoot through a body, not into it`
— and says the same about pedestrians two loops later. The car-gun hit test
and the projectile sweep both iterate `state.cops.ids` with only `if (!cop) continue`,
so a corpse is selected as the hit; `damageCop` then returns immediately
(`copIsDown`) and the round is absorbed. A body lies in the street for
`peds.corpseSec` (40 s).

```
$ node evidence/round5/C-repro-corpse-stops-cargun.mjs
car guns, clear line   (CONTROL)  damage to the live officer 120px away = 9   tracer reached 100px
car guns, corpse at 60px          damage to the live officer 120px away = 0   tracer reached 40px
smg     , clear line   (CONTROL)  damage to the live officer 120px away = 7   tracer reached 102px
smg     , corpse at 60px          damage to the live officer 120px away = 7   tracer reached 102px
rocket  , clear line   (CONTROL)  damage to the live officer 120px away = 107.5
rocket  , corpse at 60px          damage to the live officer 120px away = 32.5
```
Both controls fire. The hand weapon shoots straight through the body, exactly
as the codebase says it should; the car gun's tracer stops dead at the corpse
(40 px is muzzle-to-body) and deals nothing, and the rocket bursts on the body
for a third of the damage.

repro: `node evidence/round5/C-repro-corpse-stops-cargun.mjs`

why it matters: the two weapons this applies to are the five- and six-star
weapons — the tank's gun and the launcher — and the moment they are being used
is the moment the street is full of officers you have just killed. Your own
kills become cover for the wave behind them, and the tracer visibly stops in
mid-air at a body the renderer draws lying flat.

prior art: none found. `weapons.ts:165` records the rule these two sites are
out of step with; R1-C02 fixed the same "a body is not a live officer" mistake
in `noticedBy`/`anyCopSees` and did not sweep the hit tests.

---

## Ambient traffic's cull leaks a permanent driverless car every time it fires

severity: significant
lens: C
where: `shared/src/sim/traffic.ts:1189` against `traffic.ts:1314` (`putAiVehicle`)

evidence: the cull despawns an ambient car with
`v.driverId = null; // becomes an ordinary parked car, then is reused`
and `putAiVehicle` then mints a brand-new entity (`state.nextEntityId++`) for
every replacement. Nothing in `shared/src` removes an intact, driverless,
non-police vehicle: `retireAbandoned` takes only `copFleet` cars, the wreck
clearer takes only wrecks, and the cull itself only nulls the driver. The one
reuse channel is a pedestrian boarding it in `stepBoarding`, which needs a ped
inside `boardRadius` (40 px) — and a culled car is by construction
`despawnDist` (1100 px) from every player, which is exactly where no ped is,
because the crowd is topped up around players.

Measured with the crowd live at 200+, and with a starting parked fleet of the
size `session.ts` lays down for this map, so both the baseline and the reuse
channel are honest:
```
$ node evidence/round5/C-repro-parked-car-leak.mjs 36000
start: vehicles=193
t=120s  vehicles=223 (ai 14, driverless 208) peds=200  sim cost 2299 ms/1000 ticks
t=600s  vehicles=270 (ai 14, driverless 256) peds=220  sim cost 3580 ms/1000 ticks
t=1200s vehicles=286 (ai 14, driverless 272) peds=226  sim cost 4107 ms/1000 ticks
```
+48% on the vehicle table and +79% on sim cost in twenty minutes of one player
driving, still climbing at the end, from a single player. `nextEntityId`
advances by one per cull for ever.

repro: `node evidence/round5/C-repro-parked-car-leak.mjs 36000` (~3 min)

why it matters: the city silently fills with cars nobody parked — the vehicle
table nearly doubles in a long session — and every per-tick loop that walks
`state.vehicles.ids` (the run-over sweep, `overlappingVehicle`, `scanAhead`,
`motorise`'s budget, `fireOnce`'s hit test) pays for them. It is under the tick
budget at one player and it is monotone, which is the property that matters:
nothing brings it back down short of a restart.

prior art: none found. R1-C01 fixed exactly this shape for police cruisers and
built `retireAbandoned` for it; the ambient fleet has no equivalent and the
comment at `:1189` asserts a reuse that `putAiVehicle` does not perform.

---

## `police.json`'s `hard` preset sets `carsFromStar: 2` and no car ever appears at two stars

severity: nit
lens: C
where: `shared/data/police.json` `presets.hard.carsFromStar` against `police.ts:415-416` (`if (unit.vehicle && !copStats(unit.kind).flies) motorise(...)`)

evidence: `maybeSpawnCop` motorises a unit from `unit.vehicle`, which comes
from the `waves` table; `carsFromStar` is only read in the `waveUnits`
*fallback* (`police.ts:252-255`), which runs only when `police.json` carries no
`waves` block, and as the gate on `remount` (`police.ts:1192`). The `hard`
preset overrides `carsFromStar` but not `waves`, and `waves["2"]` is
`[{kind:"patrol", count:2, vehicle:null}]` on every difficulty.

```
$ node evidence/round5/C-repro-hard-carsfromstar.mjs hard
$ node evidence/round5/C-repro-hard-carsfromstar.mjs normal
hard:   carsFromStar=2  waves["2"]=[{"kind":"patrol","count":2,"vehicle":null}]
  heat 210 (=2 stars): any copcar in the world? NO   peak motorised officers=0
  heat 310 (=3 stars): any copcar in the world? yes  peak motorised officers=2
normal: carsFromStar=3
  heat 210 (=2 stars): any copcar in the world? NO   peak motorised officers=0
  heat 310 (=3 stars): any copcar in the world? yes  peak motorised officers=2
```
Identical at both difficulties — the knob moves nothing.

repro:
```
node evidence/round5/C-repro-hard-carsfromstar.mjs hard
node evidence/round5/C-repro-hard-carsfromstar.mjs normal
```

why it matters: `hard` is meant to put officers in cars a star earlier and does
not. It is a nit rather than a defect in behaviour because the level it does
apply at — `remount`'s gate — has no cars to find at two stars either, so the
effect is a difficulty key that reads as live and is inert.

prior art: none found. R1-C05 is about a different police number.

---

## Checked and deliberately not filed

* **Determinism.** No `Date.now`/`performance.now`/`Math.random` anywhere in
  `shared/src/sim`. Every `Object.keys` walk in the sim (`ambulanceCalls`,
  `trafficDrivers`, `vehicleHitTick`, `copFleet`, both clone paths) is over
  integer-like keys, which iterate in ascending numeric order. `cloneState`
  deep-copies all four side tables. The R1-C03 trig gate still holds over
  `shared/src/sim`.
* **Trust boundary.** `sanitizeIntent` rejects or clamps every field;
  `viewTick` is re-clamped in `rewoundWorld` to `[tick-12, tick-1]`;
  `queueInput` applies at most one intent per tick whatever a client sends, and
  the seq watermark is monotone. `buy` validates position, shop kind, district
  standing, price and balance server-side, and the proving-ground branch is
  gated on `worldgen.provingGround`. Found nothing a crafted message reaches.
* **Physics.** `moveWithCollision` sub-steps at half a tile, so nothing
  tunnels at any speed in `vehicles.json`. `integrateVehicle`'s separation rule
  (a move that increases centre distance is always allowed) still lets an
  interpenetrating pair escape. `onTheGround` is asked at every ground contact.
* **R1-C01/C06 verified under sustained play.** A 9000-tick five-star chase on
  four seeds, asserting every tick: no officer holding a vehicle whose
  `driverId` is not theirs, no vehicle driven by a missing player, no stale
  `copFleet` or `trafficDrivers` entry, no non-finite position. Zero violations
  on all four. The officers-run-over-by-their-own-cruiser fix holds (the force
  runs 5-8 rather than collapsing).
* **`pnpm bots --count=8 --script=brawl --duration=60`** passes (0 desyncs,
  ~13 KB/s), as GTA.md:430 claims. `--count=4` fails its own zero-deaths gate,
  but that is the spawn lottery — 16 player spawns on a 12288 px map against a
  600 px interest radius — not a sim defect, so it is not filed.
* **`pnpm chase`** run in full: 3/4/5 stars, 5 seeds. Escape 0/5, 1/5, 1/5.
  Nothing in the docs states a rate to contradict; GTA.md's stated gate
  ("escape rate must be > 0 at five stars") is met.
* **Two players can spawn on the identical point** (`step.ts:400`, whose
  comment says "spread-apart"; seeds 7, 9 and 11 give a closest pair of 0 px).
  Dropped: players do not collide with each other, so it is cosmetic.
