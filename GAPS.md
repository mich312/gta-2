# GAPS — turning AUDIT.md into systems

`AUDIT.md` walked the original GTA 1 & 2 feature list and found 32 items not
built and 17 partial. This document says **what to build for each of them,
where the code goes, what it costs on the wire, and what has to go green**
before it counts as done.

Same conventions as `ROADMAP.md` and `FEATURES.md`: every item states scope,
files, determinism constraints, prediction impact, new tunables, bandwidth,
effort, risk, dependencies, and a verification gate. Effort key: **S** ≤ 1 day
· **M** 1–3 days · **L** ≥ 1 week.

**Status: planned, nothing built.**

---

## 0. What this document is not

It is not a second pass over ground `FEATURES.md` already covered. Respect,
turf, payphone missions, police escalation, the crusher economy, the
multiplier, projectiles, fittings, jobs and the radio are **built and tested**
— see `AUDIT.md` for the per-item evidence. Everything below is a gap that
audit found, and only that.

Three of the audit's exclusions stay excluded, for reasons that have not
changed: save points, discrete multiplayer match modes, and voiced radio ads.
§7 restates why, and offers the shared-world version of each, so that they are
declined on the record rather than forgotten.

---

## 1. The constraints every item obeys

All ten invariants from `ROADMAP.md` §0 and `FEATURES.md` §1 hold in full.
Two of them do most of the work in this plan and are worth restating, because
the cheapest design for six of the sixteen items below falls straight out of
them:

**Invariant 8 — the sim/server line is decided by "does `step()` read it?"**

| Lives in the sim (`GameState`, on the wire) | Lives server-side (like `Economy`) |
|---|---|
| **Ped and driver AI state** — J2, J3, J4 | **Hidden-package finds** — a per-account tally, L2 |
| **Barrels and fire** — K2, K3, they damage things | **District standing** — bookkeeping over awards, L3 |
| **Stun** — M2, it changes what a body can do | **Mission chain cursor** — arbitration, N3 |
| **Weapon noise radius** — M2, cops read it | **Multiplier crates' effect** — the multiplier is already server-side, O2 |

**The cheapest sim state is no sim state.** Three systems below (J1 traffic
signals, L1 day/night, and part of L2) need a value that every host agrees on
and that changes every tick. All three get it the same way: **derive it from
`state.tick`, which is already shared, already in every snapshot, and already
in the hash.** A pure function of tick costs zero bytes, cannot desync, and
cannot drift between two players standing at the same junction. If you find
yourself adding a field for something a formula over `tick` can produce, stop.

**Bandwidth budget.** Measured today: **~10.5 KB/s** per client against the
50 KB/s hard gate. §6 accounts for every byte this plan adds; the total is
about **2.0 KB/s**, most of it in one item (M3, wider gangs).

---

## 2. Wave map

```
Wave J  (the city runs itself)   J1 signals ──┐
                                 J3 boarding ─┴─ J2 horns+flee ── J4 gang war
Wave K  (hazards bite back)      K1 arson is a crime ── K2 barrels ── K3 fire spread
Wave L  (a clock, and secrets)   L1 day/night   L2 secrets   L3 district standing
Wave M  (content the systems carry)  M1 roster ── M2 two real weapons ── M3 gangs 5–7
Wave N  (missions with shape)    N1 three kinds ── N2 escort+car failure ── N3 chains
Wave O  (money you can find)     O1 cash and robbery   O2 multiplier crates
```

**Dependencies that are real, not stylistic:**

- **J2's bail-out needs J3.** A driver who abandons a burning car becomes a
  pedestrian — that is J3's machinery run backwards. J2's *horn* half is
  independent and can land first.
- **K3 needs K1.** Fire that spreads without attribution launders arson: burn
  one car, let it take the block, and the police never learn who did it.
- **M1's gang cars need M3's gang plumbing** only if you want more than four
  liveries. Otherwise M1 stands alone.
- **N2 needs N1** (it extends the same failure machinery) and **N3 needs N1**
  (a chain of one kind of job is not a chain).
- **L3 needs nothing**, and unblocks nothing. It can go anywhere.

**Recommended order:** K1 → J1 → K2 → J3 → J2 → J4 → L1 → M1 → O2 → L3 → M2 →
N1 → K3 → N2 → M3 → L2 → O1.

K1 rides first because it is an afternoon's work and closes a live exploit
(wrecking a car is currently free). J1 rides second because it is the single
most visible "the city is running itself" change per unit of effort. L2 and O1
ride last because they are the two items where the shared-world premise fights
the original design hardest, and they benefit from everything else being
settled first.

---

# Wave J — the city runs itself without you

The audit's sharpest finding: the streets are busy but they are not *governed*.
Cars negotiate junctions by gap acceptance alone, nobody sounds a horn, nobody
gets into a car, and gangs that hate each other walk past each other.

## J1 — Traffic signals (M, medium risk)

*Closes: "Drivers stop at lights" — not built.*

`traffic.ts` runs a competent lane model: `laneControl` tracks the
carriageway, `junctionExit` picks the lane out of a junction, and gap
acceptance yields to whoever got there first (`traffic.ts:226-237`). What it
has never had is a rule that stops cars **when nothing is in the way**, which
is what makes a junction read as governed rather than merely survivable.

**The design call: signals are a pure function of tick and junction, and hold
no state at all.**

```
phaseAt(junctionIndex, tick) -> 'ns' | 'ew'
  = ((tick + junctionIndex * OFFSET) / PHASE_TICKS) % 2
```

Junctions are static map data — worldgen already knows where they are, because
`junctionExit` finds them. Add `map.junctions: Array<{tx, ty, arms}>` at
generation time and index into it. The phase then costs **zero sim fields,
zero wire bytes, and cannot desync**, and the client renders the light by
calling the same function with the tick it is rendering. Two players stopped
at the same junction see the same red because they are computing the same
number, not because a server told them.

The `OFFSET` term is what stops the whole city going green at once — it
staggers phases by junction, exactly the way `assignTurf` staggers its Voronoi
seeds (`turf.ts`).

**Behaviour.**

- An ambient driver approaching a junction on the red axis brakes to a stop at
  the stop line and holds. `laneControl` gains one clause, ahead of the
  gap-acceptance clause it already has.
- **Amber is a real phase**, not decoration: a car already inside the box on
  amber clears it rather than stopping dead in the middle. Without this, the
  first red creates a permanent obstacle and the city gridlocks.
- **Police in pursuit ignore signals.** A chase that stops at a red is not a
  chase. `stepPolice`'s cruiser driving path skips the check when the cruiser
  has a target.
- **Players are not policed for running a red.** The originals did not, and a
  heat source that fires while you are driving normally would make every
  journey a crime.

**Files.** `shared/src/world/roads.ts` (emit `junctions` during generation),
`shared/src/world/types.ts` (`CityMap.junctions`), `shared/src/sim/roadgrid.ts`
(`phaseAt`, `stopLineFor`), `shared/src/sim/traffic.ts` (the brake clause),
`shared/src/sim/police.ts` (the pursuit exemption),
`client/src/render/tiles.ts` (the signal head at each arm — it already draws
kerbs and crossings from map data), `client/src/render/lighting.ts` (a red/amber/green
`LightKind`, which costs nothing: `'red'` and `'blue'` already exist).

**Determinism.** No rng, no new state, no new step-order slot — the clause
lives inside the existing `stepTraffic` call. The phase is a function of
`tick`, which is the most deterministic thing in the codebase.

**Prediction.** None. The predictor never simulates ambient traffic.

**Tuning.** `traffic.json`: `signals.{phaseTicks, amberTicks, junctionOffset,
stopLineGap}`.

**Bandwidth.** Zero. `map.junctions` ships once in the welcome message with
the rest of the map, and it is derived data — if it grows the welcome message
uncomfortably, drop it and recompute it client-side from the tiles.

**Gate.** The existing `traffic.test.ts` "does not gridlock: traffic keeps
moving over a long run" must still pass — it is the whole risk of this item in
one assertion, and it should be strengthened to assert a minimum *fraction* of
traffic under way at every sample, not just at the end. New tests: two cars
approaching a junction on opposite axes never both hold green; a car on amber
inside the box clears rather than stops; a pursuing cruiser crosses a red; the
phase is identical at the same tick on two independently generated states.

## J2 — Horns, and drivers with self-preservation (S–M, low risk)

*Closes: "Drivers honk" — not built; "Drivers flee danger" — partial.*

Two small things that between them change how the street sounds and feels.

**The horn.** When `laneControl` reports a driver blocked by *a person* for
more than `hornAfterTicks` (it already computes `personBlocked`,
`traffic.ts:519`), emit a `horn` event. Players get a horn key that emits the
same event. The client synthesises the beep from `audio.json` like every other
sound — a two-tone square with a short decay — and the pitch varies by vehicle
kind, so a bus and a hatchback are distinguishable without looking.

This is a **pure event**: no sim state, no wire cost beyond the event itself,
and it is the cheapest single change in this document with the largest effect
on how alive the street sounds.

**Self-preservation.** Drivers already brake for people. They do not react to
gunfire, explosions or a burning car. Add a `panic` counter to `TrafficDriver`
— which is **off-wire by design** (`state.ts:152-159`), so this costs nothing
on the snapshot — set when a `shot`, `explosion` or `vehicleBurning` event
lands within `panicRadius`. While panicked a driver:

- takes the first exit away from the source rather than following `dir`;
- ignores signals (J1) and accepts smaller gaps;
- after `bailTicks`, **abandons the car and runs** — which needs J3.

**Files.** `shared/src/sim/traffic.ts` (horn trigger, panic state machine),
`shared/src/sim/events.ts` (`horn`), `shared/src/sim/input.ts` +
`client/src/input/keyboard.ts` (the horn key), `client/src/audio/audio.ts` and
`shared/data/audio.json` (the sound), `shared/data/traffic.json` (tuning).

**Determinism.** `panic` is set from events already produced this tick, read
in sorted-vehicle-id order inside the existing `stepTraffic` slot. No rng.

**Prediction.** A player's own horn is a local sound played immediately and
also emitted as an event — a double-play risk. Guard it the way the tracer
path already does (`hud.ts:163-170`): only the emitter plays locally, and the
event is ignored for the local player.

**Tuning.** `traffic.json`: `hornAfterTicks`, `hornCooldownTicks`,
`panicRadius`, `panicTicks`, `bailTicks`.

**Bandwidth.** One event kind, fired rarely and rate-limited per vehicle.
Budget **< 0.1 KB/s**.

**Gate.** A ped standing in the road for two seconds draws exactly one horn,
not thirty. A driver within `panicRadius` of an explosion leaves the area
inside two seconds. Horn events are deterministic across two runs. The
gridlock test still passes with panic enabled.

## J3 — Pedestrians who board, and drivers who get out (M, medium risk)

*Closes: "Pedestrians enter vehicles" — not built.*

Today traffic springs into existence with its driver already aboard
(`pickKind` → `createVehicle` → a `TrafficDriver` entry) and a car that stops
being driven simply coasts. Nobody is ever seen getting in or out, which is
the single biggest reason the crowd and the traffic read as two unrelated
simulations sharing a street.

**Behaviour, both directions.**

- **Boarding.** A civilian ped in `walk` mode, within `boardRadius` of a
  parked, empty, intact vehicle, with a small per-tick probability, walks to
  the door, and after `boardTicks` the ped is removed and the vehicle gains a
  `TrafficDriver`. The car then joins ambient traffic like any other.
- **Alighting.** An ambient driver whose journey has run `tripTicks`, near a
  free kerb, parks, and the reverse happens: the driver record is dropped and
  a ped is inserted at the door.
- **Bailing.** J2's panicked driver alights immediately, wherever it is, and
  spawns in `flee` mode rather than `walk`.

**The determinism trap, stated up front.** This moves population between two
entity tables inside one tick. Both tables are id-keyed and iterated in sorted
order, so the rule is: **all removals are collected first, then applied, then
all insertions are applied, each in sorted order** — the same discipline
`stepVehicleDamage` already uses for its `detonating` / `clearing` split
(`vehicleDamage.ts:150-156`). Doing it inline while iterating will produce a
host-dependent order and a desync, and it will not show up until a bot run.

**The population trap.** `stepTrafficPopulation` tops traffic up to a target
and `session.ts` tops peds up to theirs ("tops pedestrians back up to target
after a massacre"). If boarding moves a body from one pool to the other, both
top-ups fire and the city inflates. The two counts must be **reconciled
against one budget**: a boarded ped is not a dead ped, and traffic gained from
boarding counts against the traffic target rather than adding to it.

**Files.** `shared/src/sim/peds.ts` (the board decision and the walk-to-door
mode), `shared/src/sim/traffic.ts` (accepting a boarded car into the driver
pool, the alight decision, the population reconciliation),
`shared/src/sim/state.ts` (`PedState.mode` gains `'boarding'`),
`server/src/session.ts` (ped top-up must not count boarded peds as losses).

**Determinism.** One rng draw per candidate ped per tick is far too many.
Draw **once per tick** for the whole pool and select the *n*th eligible ped by
sorted id — the same trick `pickKind` uses to spend exactly one value per
spawn (`traffic.ts:28-32`). Insert the draw at a fixed point in `stepPeds`;
note in `PROGRESS.md` that it shifts every downstream draw and invalidates
older replays.

**Prediction.** None — neither peds nor ambient traffic are predicted. A car
that starts moving because someone got in arrives as an ordinary snapshot
update.

**Tuning.** `peds.json`: `boardRadius`, `boardChancePerTick`, `boardTicks`.
`traffic.json`: `tripTicks`, `alightSearchTicks`.

**Bandwidth.** Net **zero to slightly negative**: a boarded ped stops being a
ped-table row and becomes a driver on a vehicle row that already existed. A
driven car costs more per tick than a parked one, so the real figure depends
on the board/alight ratio; budget **+0.2 KB/s** and measure.

**Gate.** Over a 60 s bot run: at least one board and one alight occur; the
total population (peds + drivers) stays within ±5% of the sum of the two
targets; two runs from the same seed produce identical hashes; a ped never
boards an occupied, burning or wrecked car; a boarded car obeys J1's signals.

## J4 — Gang war: rivals who fight rivals (M–L, medium-high risk)

*Closes: "Gang members attack rivals" — not built.*

`stepHostileGangMember` (`peds.ts`) makes a gang member hostile **to the
player** on their own turf when respect is low, and `respect.ts` already knows
who hates whom (`rivalsOf`, and `turf.test.ts` "rivalry is mutual"). The
missing half is that two gangs who hate each other will walk past each other
without a word.

**Behaviour.** A gang ped standing on ground that is **not** its own gang's,
within `engageRadius` of a ped belonging to the gang that holds it (or its
declared rival), engages: closes, fires `gangPistol` on the existing reload
cadence, and — this is the part that makes it a *system* rather than a brawl —
**a kill shifts turf pressure**. Winning a firefight on rival ground makes the
next spawn there marginally more likely to be the winner's.

**The performance trap, stated up front.** 200 peds naively pairwise is 20,000
distance checks a tick, and the sim runs at 30 Hz on the server with players
waiting. The fix is the structure the map already has: **bucket peds by turf
cell once per tick** (`map.turfCellTiles` exists), then only consider pairs
inside a cell and its four neighbours. That is O(n) with a small constant and
it is deterministic if the buckets are built by ascending ped id.

**The gameplay trap.** A city where gangs fight constantly kills every gang
member within minutes and leaves the streets empty. Three brakes, all tuned:
engagements only start on **contested ground** (a cell whose holder is not the
shooter's gang), only `maxConcurrentFights` run at once city-wide, and a fight
that neither side wins inside `fightTimeoutTicks` breaks off.

**Respect must not leak.** `creditGangKill` currently credits a *player* for a
gang death (`peds.ts:276`). A gang member shot by another gang member must
credit **nobody** — otherwise standing in the right postcode earns you respect
for free. The attacker id threaded through the damage path is the
discriminator, and this is the one test that matters most in this item.

**Files.** `shared/src/sim/peds.ts` (bucketing, engagement, the fight state),
`shared/src/sim/respect.ts` (the no-credit rule; optional turf pressure),
`shared/src/sim/state.ts` (`PedState.mode` gains `'fighting'`; reuse `timer`
as the reload clock, as `stepHostileGangMember` already does),
`shared/src/sim/events.ts` (`gangFight`, for the kill feed),
`client/src/render/hud.ts` (a feed line, so a firefight two streets away is
legible).

**Determinism.** Buckets built by ascending ped id; engagements resolved in
ascending attacker id; one rng draw per tick for the whole engagement pool,
not one per candidate.

**Prediction.** None.

**Tuning.** `gangs.json`: `engageRadius`, `fightTimeoutTicks`,
`maxConcurrentFights`, `contestedOnly`.

**Bandwidth.** Peds are already on the wire and already move; a fighting ped
moves no more than a fleeing one. Budget **+0.3 KB/s** for the raised movement
rate during fights.

**Gate.** Two rival gang peds placed on contested ground engage within two
seconds; two peds of the same gang never do; a gang member killed by another
gang member credits no player any respect (the leak test); a 60 s run with
fighting enabled leaves at least 70% of the gang population alive; tick time
stays inside budget with 200 peds; identical hashes across two runs.

---

# Wave K — hazards that bite back

## K1 — Wrecking a car is a crime (S, low risk)

*Closes: "Heat from destroying vehicles" — not built.*

`damageVehicle` takes no attacker (`vehicleDamage.ts:30-35`), so the police
never learn who set the car alight. Blowing up a bus in front of a patrol is
currently free, which is both wrong and a live exploit: it is the only violent
act in the game with no cost.

**The change is small and entirely mechanical:** thread
`attackerId: number | null` through `damageVehicle` — six call sites
(`vehicle.ts:94,120,121`, `vehicleDamage.ts:117`, `weapons.ts:259`,
`fittings.ts:186`) — store it as `VehicleState.igniterId`, and call `addHeat`
at the moment of ignition, where the attacker is known, rather than at
detonation, where it is not.

**There is a second bug hiding in here, and the igniter fixes it too.**
`explode()` credits the blast to `v.driverId ?? -1` (`vehicleDamage.ts:124`) —
"whoever was at the wheel owns the deaths". For a crash that is right. For
arson it is exactly backwards: torch a bus at a crowded stop and the *driver*
is charged with the casualties while the arsonist walks. Once `igniterId`
exists, `explode` credits `igniterId ?? driverId ?? -1`, and the fire you set
is the fire you answer for. K3 then inherits the field rather than adding one.

**Three prices, not one**, because the acts are not equivalent:

| Act | Heat |
| --- | --- |
| Wrecking an empty parked car | `heatPerVehicleKill` |
| Wrecking an occupied car | that, plus the existing per-death heat for whoever was inside |
| A collision you did not aim | **none** — `vehicle.ts:120-121` passes `null`, because a traffic accident is not arson |

That last row is the one that makes this item safe. Without it, every scrape
in traffic is a crime and the wanted system becomes noise.

**Files.** `shared/src/sim/vehicleDamage.ts`, `shared/src/sim/vehicle.ts`,
`shared/src/sim/weapons.ts`, `shared/src/sim/fittings.ts`,
`shared/src/sim/state.ts` (`igniterId`), `shared/data/police.json`.

**Determinism.** Heat is an existing player field written at an existing point
in the step order. `igniterId` is written once, at ignition, in the same pass.
Nothing new in the step order and no rng.

**Prediction.** Heat is not predicted today and stays that way.

**Tuning.** `police.json`: `heatPerVehicleKill`, `heatPerOccupiedVehicleKill`.

**Bandwidth.** One field on the vehicle table, written once per vehicle
lifetime, null for the overwhelming majority of vehicles. Budget
**+0.15 KB/s** — the same field K3 would otherwise have added.

**Gate.** Shooting a parked car raises the shooter's heat and nobody else's;
a rocket that takes three cars charges for three; two cars colliding in
ambient traffic raises nobody's heat; a bus torched at a stop credits the
arsonist with the deaths and not the driver; the crusher path is unaffected
(you are still paid for delivering, not charged for arriving).

## K2 — Explosive barrels, and props that hurt (S–M, low risk)

*Closes: "Explosive barrels" — not built.*

There is a barrel sprite and the tile layer scatters it as scenery
(`tiles.ts:779`) with no entity behind it. Meanwhile `props.json` already
describes destructible lamps, bins and fences with hp and radius, and
`stepProps` already handles their destruction and respawn.

**So this item adds no new entity table.** A barrel is a prop with one extra
field:

```json
"barrel": { "hp": 8, "radius": 6, "blast": { "radius": 46, "damage": 55 } }
```

On destruction, a prop with a `blast` block calls `blast()` — the same
function a rocket and a burning car already use (`vehicleDamage.ts:63`), so
barrels hurt players, cops, peds, other props and vehicles through code that
is already tested for victim ordering, and they already take an `attackerId`,
so K1's attribution carries.

**Two things must happen together or barrels will double up:** worldgen must
place them into `propSpawns`, and `tiles.ts:779` must stop drawing decorative
ones. The renderer draws props from the entity table already.

**Placement is the design work**, not the code. Barrels belong where they are
a decision: at the mouths of alleys, against industrial-district walls, beside
the cranes. Scattered evenly they are a random tax on driving; clustered at
chokepoints they are a weapon.

**Files.** `shared/data/props.json`, `shared/src/tuning.ts` (parse `blast`),
`shared/src/sim/weapons.ts` (`stepProps` → `blast()` when a prop has a
blast), `shared/src/world/amenities.ts` (placement),
`client/src/render/tiles.ts` (delete the decorative draw).

**Determinism.** Prop destruction already resolves in sorted id order.
A barrel destroyed by another barrel's blast must go on the **next** tick,
not recursively within this one — collect, then apply, the same discipline as
J3.

**Prediction.** None; props are not predicted.

**Tuning.** `props.json`: `barrel.blast.{radius, damage}`, plus placement
counts in `worldgen.json`.

**Bandwidth.** Props are already on the wire and change only on destruction.
Budget **+0.1 KB/s** for the added count.

**Gate.** A shot barrel damages a player standing beside it and not one across
the street; a barrel destroyed by a neighbour's blast detonates on the
following tick and the chain terminates; a barrel is never generated inside a
building or on water (the `world.test.ts` invariants already assert this shape
for other props); no barrel is drawn twice.

## K3 — Fire that spreads (M, medium risk)

*Closes: "Fire spreads" — partial. Depends on K1.*

A car burns for a tuned fuse and then explodes, and the blast can ignite its
neighbours (`vehicleDamage.ts:115-117`). What does not happen is the thing the
list means: **fire spreading before the explosion**, so that a burning car in
a packed street is a developing situation rather than a countdown.

**Behaviour.** While a vehicle is `burning`, once per `spreadIntervalTicks`,
it ignites one intact vehicle or blast-capable prop within `spreadRadius`
— the **nearest** one, ties broken by ascending id, so there is no rng and no
ambiguity. Molotovs and the flamethrower gain the same behaviour by lighting a
short-lived fire at the point of impact.

**Attribution carries.** The ignited vehicle inherits the original arsonist's
id from K1's plumbing, so a fire you start is a fire you are wanted for,
however far it travels. This is why K3 depends on K1 and not merely follows it.

**The runaway trap, stated up front.** Spread is exponential by nature and the
map has car parks. Three brakes: a per-vehicle `spreadBudget` of one ignition
each, a city-wide cap on simultaneous fires, and — the important one — spread
**stops at the road edge**, so a fire crosses a car park but not a river or a
plaza. Without the cap, one molotov in the wrong place is a citywide fire and
a tick-time cliff.

**Files.** `shared/src/sim/vehicleDamage.ts` (the spread pass, at its own
fixed slot inside `stepVehicleDamage`), `shared/data/vehicles.json`,
`client/src/render/effects.ts` (fire that reads as spreading rather than as
nine separate car fires). No new state: `igniterId` arrives with K1.

**Determinism.** Nearest-by-distance with ascending-id tie-break, evaluated in
ascending burning-vehicle id, collected then applied. No rng.

**Prediction.** None.

**Tuning.** `vehicles.json`: `fire.{spreadRadius, spreadIntervalTicks,
maxConcurrent, spreadBudget}`.

**Bandwidth.** Zero — the one field this item needs is K1's, and K1 pays for
it. If K1's estimate proves optimistic, the fallback for both items is to hold
the igniter map server-side: nothing in `step()` reads it except `addHeat`,
and the server can apply heat from the `vehicleBurning` event instead.

**Gate.** A burning car ignites its neighbour within the tuned interval; a
full car park burns out completely and the run terminates inside the tick-time
budget; the concurrent cap holds under a deliberate arson attack; heat lands
on the original arsonist for every car in the chain; identical hashes twice.

---

# Wave L — a clock, and things worth finding

## L1 — Day and night (M, medium risk, mostly render-side)

*Closes: "Day/night lighting" — not built.*

There is one fixed dusk grade (`config.ts` `AMBIENT`, `AMBIENT_TINT`,
`VIGNETTE`) with dynamic lamps, headlights and muzzle flashes over it. It
looks good, which is why this item is about a **clock**, not a repaint.

**The design call: time of day is a pure function of `state.tick`.**

```
timeOfDay(tick) = (tick / TICK_RATE / dayLengthSec) % 1
```

Zero sim fields, zero wire bytes, and — the point — two players standing on
the same corner see the same sky, because they are computing the same number
from the tick they are already rendering. A server-pushed clock would cost a
message and could skew; a client clock would desync visually the moment
someone's tab slept.

**What changes with it.**

- **Render:** `AMBIENT`, `AMBIENT_TINT` and `VIGNETTE` become functions of
  `timeOfDay`, interpolated across four keyframes (dawn, day, dusk, night).
  Lamps and shop lights fade in at dusk instead of burning at noon.
  Headlights strengthen. This is most of the work and none of the risk.
- **Sim, deliberately little:** the ped population target scales down
  overnight and the traffic target with it. That is sim state — but it is a
  *target*, read at the existing top-up point, drawing no new rng.

**What I would not do:** make cops see less far at night. It is the obvious
next idea and it is a trap — it turns a visual feature into a stealth mechanic
nobody asked for, and it makes the wanted system's difficulty a function of a
clock the player cannot read precisely. Tune it as a tunable defaulted to 1.0
so the option exists and is off.

**Files.** `client/src/render/config.ts` (keyframes), `client/src/render/lighting.ts`
and `client/src/render/renderer.ts` (grade from `timeOfDay`),
`client/src/render/tiles.ts` (lit windows at night — the tile cache must be
invalidated on phase change, not per frame, or this item becomes a performance
regression), `shared/src/sim/traffic.ts` and `server/src/session.ts`
(population targets), `shared/data/worldgen.json` (`dayLengthSec`).

**Determinism.** The population target is derived from `tick`; the top-up
loops are unchanged. No new draws.

**Prediction.** None — the clock is derived, so a predicted frame and a
reconciled frame agree by construction.

**Tuning.** `worldgen.json`: `dayLengthSec` (suggest 24 real minutes, so a
session spans a couple of days), `night.{pedScale, trafficScale, copSightScale}`.

**Bandwidth.** Zero.

**Gate.** Two clients at the same tick compute the same `timeOfDay` to the
bit; the tile cache rebuilds a bounded number of times per in-game day (assert
a count, this is the performance risk in one number); the ped population at
night lands within tolerance of the scaled target; hashes identical across a
full day-night cycle.

## L2 — Secrets worth finding (M, low risk, high design risk)

*Closes: "Hidden packages", "Secret vehicles", "Easter eggs" — not built;
"Hidden weapons", "Shortcuts" — partial.*

**This is the item where the shared-world premise fights the original design
hardest, and it needs its call made before any code.** A hidden package is a
one-time find. In a city with thirty people in it, every package is found in
the first hour and the mechanic is dead for everyone who arrives on day two.

**The design call: the *world* is shared, the *finding* is personal.**

Packages are **not sim pickups**. They are positions in the map plus a
per-account found-set, checked server-side by proximity in the same pass that
already handles shop doorways (`economy.ts` "rejects buys away from the
doorway"). A package you have found renders dim and pays nothing; a package
your neighbour has found is still there for you. This costs the sim nothing,
cannot desync, and survives an arbitrary number of players.

The same rule handles **hidden weapons**: crates in unlikely places, taken
once per account, then dim.

**Four kinds of secret, and they are not the same work:**

1. **Packages** (100 of them, worldgen-placed in alley dead-ends, on the far
   side of fences, under bridges). Reward at thresholds: cash at 10, a weapon
   delivered to your spawn at 25, a permanent multiplier floor at 50, a secret
   vehicle at 100. Server-side ledger, persisted with the account.
2. **Secret vehicles** — one tank (M1) parked in a walled yard reachable only
   by a stunt ramp; one limousine behind a fence. These are placement, not
   code, once M1 exists.
3. **Easter eggs** — a handful of hand-placed scenes worldgen composes at
   fixed seeds-relative offsets. Cheap, and the only item in this document
   that is purely for delight.
4. **Shortcuts** — worldgen already carves alleys; the change is that a small
   number of them are **not drawn on the radar**. One flag on a road tile,
   read by `minimap.ts` and nothing else.

**The honest tension with the radar.** `AUDIT.md` records that this project
deliberately marks payphones, cranes and clinics, because in a shared world
"where is everyone" beats "go and find it". L2 does not reverse that; it adds
a second layer that is *not* marked. Both can be true: the services are on the
map, the secrets are not.

**Files.** `shared/src/world/amenities.ts` (placement of packages, secret
crates, unmarked alleys), `shared/src/world/types.ts`
(`CityMap.packages`, a `hidden` flag on shortcut tiles),
`server/src/economy/secrets.ts` (**new** — proximity check, per-account
found-set, thresholds), `server/src/persist/*` (the ledger),
`shared/src/net/messages.ts` (a `secrets` message: found count and the last
find), `client/src/render/renderer.ts` (dim vs bright),
`client/src/render/minimap.ts` (respect the `hidden` flag).

**Determinism.** None required — none of this enters `step()`. That is the
point of the design call.

**Prediction.** None.

**Tuning.** `worldgen.json`: `secrets.{packageCount, hiddenAlleyFraction}`.
A new `secrets.json` for the reward thresholds.

**Bandwidth.** One message on a find, plus the package positions in the
welcome message (100 × 4 bytes ≈ 400 B, once). Budget **< 0.05 KB/s**.

**Gate.** Every package is reachable on foot from a player spawn (a pathing
assertion, and the one that will actually fail during development); no package
is inside a building or on water; two accounts find the same package
independently and both are paid; the same account is paid exactly once;
finds survive a server restart (`persistCheck`); an unmarked alley is absent
from the radar and present in the world.

## L3 — District standing (M, medium risk)

*Closes: "Unlock the next district by score/money" and "Score unlocks new
areas" — not built.*

The originals gated geography on score. `AUDIT.md` records why this project
does not: locking a district locks it for a player standing next to someone
who is inside it, and there is no single-player "level target" to be set back
from.

**The design call: keep the geography open, gate the *services*.**

Every district (`DISTRICT_TYPES` = downtown, residential, industrial,
commercial, park) tracks your **standing** — lifetime earnings attributed to
work done inside it, server-side, persisted. Standing buys you:

- **the crusher's better rates** in that district;
- **the gun shop's upper shelf** — rockets and the flamethrower are downtown
  purchases only, and only once downtown knows you;
- **the payphone's higher tiers**, alongside the gang-respect gate that
  already exists (`missions.test.ts` "standing gates the tier").

You can walk anywhere from minute one. What you can *do* there grows. That
preserves the progression the original was reaching for — "there is more city
than you have earned yet" — without a wall, and it composes with the respect
system rather than duplicating it: respect is *who* trusts you, standing is
*where* you are known.

**Files.** `server/src/economy/economy.ts` (attribute each award to the
district it happened in — `districtAt(map, x, y)` already exists,
`types.ts:158`), `server/src/economy/districts.ts` (**new** — the standing
table and the gates), `server/src/missions/missions.ts` (the tier gate),
`shared/src/net/messages.ts` (standing in the `wallet` message),
`client/src/render/hud.ts` (a standing line under the place name — the HUD
already names your district, `hud_a.png`),
`client/src/render/minimap.ts` (shade districts by standing).

**Determinism.** None — entirely server-side, like the multiplier.

**Prediction.** None.

**Tuning.** A new `districts.json`: per-district thresholds and what each
unlocks.

**Bandwidth.** Five small numbers on the existing `wallet` message, which
fires only on change. Budget **< 0.05 KB/s**.

**Gate.** An award earned in the industrial district raises industrial
standing and no other; the upper shelf is refused below threshold and sold
above it, with the refusal reaching the HUD as a reason rather than a silent
no-op; standing persists across a restart; the leaderboard still ranks on cash
(`economy.test.ts`) and is not quietly replaced by standing.

---

# Wave M — content the systems already carry

These are the items `AUDIT.md` called "content, not mechanics". They are
listed with the same rigour as the rest because "it is only data" is how a
data file grows a special case that only one kind uses.

## M1 — The rest of the vehicle roster (S–M, low risk)

*Closes: tanks, garbage trucks, ice cream truck, limousines, construction
vehicles, gang vehicles — all not built.*

Nine classes ship. Six more, and only two need code:

| Kind | Work |
| --- | --- |
| Garbage truck | Data only — `vehicles.json`, `sprites.json`, `traffic.json` mix |
| Ice cream van | Data, plus a jingle in `audio.json` on the existing per-vehicle sound path |
| Limousine | Data only. Worth more at the crusher, which the `byKind` table already supports |
| Construction digger | Data only |
| **Tank** | A vehicle that spawns with `guns` fitted and effectively infinite `fittingAmmo` — the fittings system (G2) already does all of it. Plus: very high `heatPerTheft`, heavy collision damage, immune to small arms |
| **Gang cars** | One new field: `VehicleState.gangId`. Spawns on that gang's turf in their livery; jacking one costs respect with them |

The tank is the interesting one precisely because it needs **no new system** —
it is the fittings system pointed at a chassis, which is the test of whether
G2 was built generally enough. If the tank needs a special case, G2 has a
design flaw worth finding.

**Files.** `shared/data/vehicles.json`, `sprites.json`, `palette.json`,
`traffic.json`, `audio.json`; `shared/src/sim/state.ts` (`gangId`);
`shared/src/sim/traffic.ts` (turf-aware gang-car spawning);
`shared/src/sim/vehicle.ts` (the respect cost on jacking a gang car);
`client/src/render/renderer.ts` (gang livery — `GANG_TINT` already exists).

**Determinism.** Gang-car spawn selection draws from the existing single
per-spawn rng value; the turf lookup is a pure function of position.

**Tuning.** `vehicles.json` rows; `traffic.json` `mix` weights;
`respect.json` `jackGangCarCost`.

**Bandwidth.** `gangId` is one small field on the vehicle table, written once
at spawn. Budget **+0.2 KB/s**.

**Gate.** `traffic.test.ts` "heavier classes are slower, tougher and turn
worse" must still pass **and be extended to cover the new kinds** — this test
has caught a bus faster than a car once already (`PROGRESS.md`). A tank
survives a magazine of pistol fire and does not survive a rocket. A gang car
spawns only on its gang's turf. Jacking one costs respect with that gang and
no other.

## M2 — Two weapons that need new verbs (S–M, medium risk)

*Closes: "Silenced pistol", "Electro gun" — not built.*

`AUDIT.md` argued the silenced pistol would be a reskin, because nothing in
the sim models sound. **So build the thing that makes it real**, and the
weapon follows for free.

**Noise.** Every weapon gains a `noiseRadius`. Cop alerting and ped panic —
which today key off the `shot` event with a hardcoded radius — key off it
instead. A silenced pistol is then a genuine mechanic: the same damage, a
fraction of the noise, and a real reason to carry it into a turf you would
rather not stir up. This is a **small change with large reach**, because it
retroactively differentiates every weapon already in the game: a shotgun
should wake a street the flamethrower does not.

**Stun.** The electro gun sets a target to a `stunned` state for
`stunTicks` — cannot move, cannot fire, can be walked past or finished. Peds,
cops and players all stun. This is a new `PlayerMode` value and a new
`PedState.mode` value, which the snapshot carries for free (both fields are
already on the wire).

The interesting consequence, and the reason to tune it carefully: a stunned
player is a helpless player, and helplessness is the least fun state in any
game. Keep `stunTicks` short — under a second — and make it a tool for
escaping or closing, not for winning.

**Files.** `shared/data/weapons.json` (`noiseRadius` on every row, `electro`),
`shared/src/tuning.ts`, `shared/src/sim/weapons.ts` (noise emission, the stun
application), `shared/src/sim/police.ts` and `shared/src/sim/peds.ts` (react to
noise rather than to a fixed radius), `shared/src/sim/state.ts` (`stunnedUntilTick`
— fold it into the existing `powerUntilTick` batching discipline from
`FEATURES.md` invariant 10 rather than adding a fresh field),
`shared/data/shop.json`.

**Determinism.** Noise is read at the existing police and ped step slots. The
stun clock is compared against `tick`, like every other timed state.

**Prediction.** Being stunned is authoritative and unpredictable, like being
busted (`FEATURES.md` F2) — it arrives as a correction, and that is correct:
the client should hard-cut on it.

**Tuning.** `weapons.json`: `noiseRadius` per weapon, `electro.stunTicks`.

**Bandwidth.** Zero new fields if the stun clock folds into the existing
power-up batch; otherwise one field. Budget **~0**.

**Gate.** A silenced kill inside a cop's sight raises heat; the same kill
outside it does not draw the cops a loud pistol would; a stunned player cannot
move or fire and recovers exactly on schedule; a stunned cop stops shooting;
stun does not stack into a lock (a second hit does not extend an active stun
past the cap).

## M3 — Gangs five, six and seven (S, low risk, touches the wire)

*Closes: "Seven gangs" — partial (four).*

`MAX_GANGS = 4` (`constants.ts`), the respect array is four wide, and
`assignTurf` is already parameterised by `gangCount` (`worldgen.json`
`turf.gangCount`). So this is mostly a constant and three data rows — with one
real consequence.

**The wire cost is the item.** `PlayerState.respect` is a fixed-width array in
the snapshot and the hash. Seven gangs is three more signed values per player
per snapshot. That is the largest single bandwidth addition in this plan and
it must be measured rather than assumed.

**The HUD is the other half.** Seven signed bars will not fit the current
respect panel at 26 px each (`hud.ts` — the panel is already
`respect.length * 30 + 10` wide, which at seven is 220 px of a 480 px screen).
Either the bars narrow to 14 px, or the panel shows the gangs whose turf you
are on or near and keeps the rest in a compact strip. **Narrow bars are the
safer call**, because the panel's whole reason for existing is that pleasing
one gang displeases another, and hiding four of them hides the mechanic.

**Files.** `shared/src/constants.ts`, `shared/data/gangs.json` (three rows,
names, colours, rivalries), `shared/data/worldgen.json` (`turf.gangCount`),
`client/src/render/hud.ts` (`GANG_COLORS`, `GANG_NAMES`, the narrower panel),
`client/src/render/minimap.ts` (turf wash), `client/src/render/renderer.ts`
(`GANG_TINT`).

**Determinism.** `assignTurf` is already general; more seeds is more Voronoi.
The rng draw count per generation changes, which shifts downstream draws —
note it in `PROGRESS.md`, as invariant 2 requires.

**Tuning.** `gangs.json` rows; `worldgen.json` `turf.gangCount`.

**Bandwidth.** **+0.6 KB/s** estimated, and this is the number to verify
first — if it lands materially higher, the fallback is to send only the
respect values that have moved, which the delta codec can already express.

**Gate.** `turf.test.ts` "every gang holds ground, and all of the map belongs
to somebody" and "rivalry is mutual" must pass at seven; the respect panel
fits and all seven bars are legible at 1× scale (a screenshot through
`client/evidence/hud.html`); the 50 KB/s gate holds with 8 bots.

---

# Wave N — missions with shape

## N1 — Three new mission kinds (M, medium risk)

*Closes: "Escape", "Race", "Bomb placement" — not built; "Time trials" —
partial.*

Three kinds ship (`hit`, `sweep`, `delivery`) across three tiers. All the
machinery for more already exists in `Missions`: a spec board, a deadline, a
marker, progress counting, and failure on death and on the clock.

| Kind | Objective | New machinery |
| --- | --- | --- |
| **Escape** | Take on `n` stars, then reach a marker and stay clean for `t` seconds | None — reads `wantedLevel` and position |
| **Race** | Hit `n` markers in sequence inside the deadline | An ordered marker list instead of one marker |
| **Bomb** | Drive a `bomb`-fitted car to a target and detonate it | None — the `bomb` fitting exists (G2) |

**Escape is the one worth building first**, because it is the only mission
type in this document that makes the police *the objective* rather than the
obstacle, and the police are this project's most developed system.

A **time trial** is a race with one marker and a tight clock — no new kind,
one row on the board.

**Files.** `server/src/missions/missions.ts` (three spec kinds, the ordered
marker list, per-kind progress), `shared/src/net/messages.ts` (`MissionView`
carries a marker *list*), `client/src/render/hud.ts` and
`client/src/render/minimap.ts` (next marker highlighted, the rest dim).

**Determinism.** None — missions are server-side arbitration, exactly as
`FEATURES.md` invariant 8 requires. They reach the sim only as `SimCommand`s.

**Tuning.** `missions.json` (extracted from the current in-file `SPECS` board,
which is the right moment to do it).

**Bandwidth.** A marker list instead of one marker on a message that fires on
change. Budget **< 0.05 KB/s**.

**Gate.** Each kind can be completed and can be failed; the race's markers
must be hit **in order** (an out-of-order hit does not count — the test that
will catch the obvious implementation); a bomb mission fails if the fitted car
is destroyed early; every kind respects the respect gate that already governs
the board.

## N2 — Escort, and failure that includes the car (M, medium risk)

*Closes: "Escort" — not built; "Fail if the vehicle is destroyed" — not
built.*

**Vehicle-destroyed failure is the small half.** `Missions.step()` already
watches for the player's death; it gains a watch on the mission's vehicle
reaching `condition === 'wreck'`. One clause, one test.

**Escort is the large half**, and it is the only item in Wave N that needs sim
work: it requires an NPC that **follows you** rather than wandering or
fleeing. That is a new `PedState.mode` (`'following'`) with a lead target,
plus the pathing to keep it out of walls — which the ped walker already does
for wandering, so this is a change of destination rather than a new walker.

The escortee must also be **protectable**: rival gang peds (J4) and cops must
be able to target it, or the mission has no failure state other than the
clock. This is the dependency that makes N2 much better after J4 than before
it.

**Files.** `server/src/missions/missions.ts` (the kind, the failure clause),
`shared/src/sim/peds.ts` (`following` mode), `shared/src/sim/commands.ts`
(a command to designate a ped as an escortee, since the server chooses it),
`shared/src/sim/state.ts` (`PedState.escortOf: number | null`),
`client/src/render/renderer.ts` (mark the escortee — an unmarked NPC you must
protect is a mission you fail without knowing why).

**Determinism.** The follow target is a player id resolved in sorted ped id
order inside the existing `stepPeds` slot. No rng.

**Tuning.** `missions.json`: `escort.{leadDistance, loseDistance}`.

**Bandwidth.** One nullable id on the ped table, set on one ped at a time.
Budget **< 0.05 KB/s**.

**Gate.** The escortee follows within `leadDistance` through a junction and
around a corner; it does not walk into buildings or water; killing it fails
the mission; losing it by `loseDistance` for `t` seconds fails the mission;
a delivery mission fails when its car is wrecked and not when it is merely
dented.

## N3 — Chains: a job that leads to the next (M–L, medium risk)

*Closes: "Mission chains" — partial; "Better mission scripting" — partial.*

The board is flat: seven specs, gated by respect tier, offered on a rotating
cursor (`missions.ts` `offerCursor`). A gang has work, but no *story*.

**The design call: chains are per-player, per-gang, and short.** Each gang
gets a chain of four to six jobs. Finishing chain step *k* for a gang means the
next phone in their turf offers step *k+1* rather than a random spec. Steps
escalate in tier, and the last step of a chain is that gang's best-paying job
and raises the multiplier by more.

This is a **server-side cursor per (player, gang)** — a `Map<playerId,
number[]>` in `Missions`, persisted with the account. It composes with the
respect gate rather than replacing it: respect decides *whether* a gang talks
to you, the chain decides *what they say next*.

**Why short chains.** A twenty-mission chain in a persistent world is a
commitment the player cannot pause, and this game has no cutscenes to carry
one. Four to six jobs is enough to feel like a relationship and short enough
to finish in a session.

**Files.** `server/src/missions/missions.ts` (chain definition and cursor),
`shared/data/missions.json` (the four chains — extracted from `SPECS` per N1),
`server/src/persist/*` (cursor persistence),
`client/src/render/hud.ts` (chain position — "Sunnyside, job 3 of 5" — because
a chain the player cannot see is a chain that feels like a coincidence).

**Determinism.** None — server-side arbitration.

**Tuning.** `missions.json`: the chains themselves.

**Bandwidth.** Two small numbers on the existing `missionState` message.
Budget **~0**.

**Gate.** Finishing step *k* offers step *k+1* at that gang's next phone and
not at a rival's; abandoning does not advance the cursor; the cursor survives
a restart; a completed chain rolls over to the gang's flat board rather than
dead-ending; two players' cursors are independent.

---

# Wave O — money you can find

## O1 — Cash on the ground, and something to rob (M, medium risk)

*Closes: "Money pickups" — not built; "Earned from robbery" — partial.*

`AUDIT.md` records the current position: money comes from work and never off
the pavement. That is defensible, and this item does **not** reverse it by
scattering cash crates — which would make the city a coin-collecting game and
undercut every earning path already built.

**Two sources, both tied to an act:**

1. **Bodies drop what they carried.** A killed ped drops a small cash pickup
   that persists briefly. Small enough that farming peds loses to any real
   earning path — the existing per-minute caps and repeat-decay in
   `awards.ts` are the model, and cash drops must route through the same
   chokepoint or they become the farm.
2. **Shops can be held up.** Stand in a shop doorway, armed, and hold for
   `robTicks`: you take the till, gain substantial heat, and that shop is shut
   for `reopenTicks`. This gives the gun shop, the clothing shop and the
   pay'n'spray a second use, and it gives the police something to arrive at.

The till is the better half by a distance: it is a **located, defended,
repeatable** earning path, which is what the original's robbery meant, and it
composes with the police escalation this project has already built.

**Files.** `shared/src/sim/peds.ts` (the drop, as an existing-table pickup),
`shared/data/pickups.json` (`cash`), `shared/src/sim/pickups.ts` (collection
emits an event; the *amount* is decided server-side, because money is not sim
state — invariant 8), `server/src/economy/economy.ts` (the credit through the
existing chokepoint, the till, the caps), `shared/src/sim/state.ts` (shop
closed-state, or hold it server-side and refuse the buy — **prefer
server-side**, it is one refusal path in code that already refuses),
`client/src/render/hud.ts` (a robbery progress bar and the closed sign).

**Determinism.** The drop is an existing-table insertion at an existing slot.
The *value* never enters the sim.

**Tuning.** `pickups.json`: `cash.value`. `economy.json`: `rob.{ticks, take,
reopenTicks, heat}`.

**Bandwidth.** Cash pickups are short-lived rows on a table already on the
wire. Budget **+0.15 KB/s**.

**Gate.** Killing pedestrians for ten minutes earns materially less than one
mission (assert the ratio — this is the anti-farm test and it is the only one
that matters here); a robbery raises heat and closes the shop; a closed shop
refuses purchases with a reason; the till pays once per hold-up, not per tick;
the ledger stays append-only and idempotent.

## O2 — Multiplier crates (S, low risk)

*Closes: "Multiplier pickups" — not built.*

The multiplier exists, is server-side, and rises on frenzies and missions
(`economy.ts` `raiseMultiplier`). A crate that raises it is one data row plus
one handler on a path that already exists.

- New pickup kind `multi` in `pickups.json`, placed by the existing worldgen
  scatter (`powerups.test.ts` "worldgen scatters power-up crates, and staples
  still dominate" already asserts the shape and must keep passing).
- Collection emits the existing `pickupTaken` event; `Economy` handles the
  kind and calls `raiseMultiplier(playerId, gain)` — the same chokepoint the
  frenzy path uses.
- **Rare**, and it respects the existing cap. A crate that hands out the cap
  makes frenzies and missions pointless, which are the two paths the
  multiplier exists to reward.

**Files.** `shared/data/pickups.json`, `shared/src/sim/pickups.ts` (nothing,
if the kind is handled generically — check, and if it is not, that is a small
design debt worth paying here), `server/src/economy/economy.ts` (the handler),
`client/src/render/renderer.ts` (`PICKUP_COLORS`).

**Determinism.** None beyond the existing pickup path.

**Tuning.** `pickups.json`: `multi.value` (the gain). `economy.json`:
`multiplier.pickupGain`.

**Bandwidth.** Zero — one more value in an existing enum.

**Gate.** Collecting a crate raises the multiplier by the tuned gain and never
past the cap; the staple-dominance assertion in `powerups.test.ts` still
holds; the crate is on the standard respawn cooldown.

---

## 6. Bandwidth accounting

Measured today: **~10.5 KB/s** per client, 6 bots, against the 50 KB/s hard
gate. Every estimate below is a budget to be **verified with the bot harness**,
not a claim.

| Item | Estimate | Why |
| --- | --- | --- |
| J1 signals | 0 | Derived from `tick` |
| J2 horns + flee | < 0.1 | One rate-limited event; `TrafficDriver` is off-wire |
| J3 boarding | +0.2 | Population moves between tables; driven cars cost more than parked |
| J4 gang war | +0.3 | Existing rows, raised movement rate during fights |
| K1 arson | +0.15 | `igniterId`, written once per vehicle |
| K2 barrels | +0.1 | More rows on an existing near-static table |
| K3 fire spread | 0 | Reuses K1's `igniterId` |
| L1 day/night | 0 | Derived from `tick` |
| L2 secrets | < 0.05 | Server-side; positions ship once |
| L3 district standing | < 0.05 | Five numbers on an on-change message |
| M1 roster | +0.2 | `gangId`, written once at spawn |
| M2 weapons | ~0 | Stun folds into the existing power-up batch |
| **M3 gangs 5–7** | **+0.6** | **Three more respect values per player per snapshot** |
| N1 mission kinds | < 0.05 | On-change message |
| N2 escort | < 0.05 | One nullable id on one ped |
| N3 chains | ~0 | Two numbers on an existing message |
| O1 cash + robbery | +0.15 | Short-lived pickup rows |
| O2 multiplier crates | 0 | An existing enum gains a value |
| **Total** | **≈ +2.0 KB/s** | **≈ 12.5 KB/s of a 50 KB/s gate** |

M3 is over a third of the total on its own and is the one measurement to take
early. If it lands materially higher than budgeted, the fallback is
respect-value deltas, which the binary codec can already express.

## 7. The exclusions, restated

`AUDIT.md` recorded seven items excluded by design. Three of them are worth
restating with the shared-world version, so that they stay declined on the
record rather than being quietly forgotten:

**Save points that cost money.** Declined. A save *point* is a single-player
idea: this world does not stop when you walk away from it, so there is nowhere
for one to be. The shared-world version already exists — cash and lifetime
earnings are written continuously to an append-only ledger. What *could* be
built, if the "saving costs something" tension is the part worth keeping, is a
**bank**: a located building where you deposit cash to protect it from arrest,
with a fee. That is a real mechanic with a real decision in it, and it belongs
in a future wave rather than in this one.

**Discrete multiplayer modes** (deathmatch, team games, capture). Declined.
There are no modes; everyone is in one persistent city with a leaderboard.
The genuinely interesting shared-world version is **players joining gangs** —
turf, rivalry and respect already exist and are already faction-shaped, so
player-held turf is a much shorter path to "team game" than a mode system
would be. It is a large enough idea to deserve its own document.

**Voiced radio ads.** Declined, and this one is structural: every sound in this
project is synthesised from `audio.json` at load, and there are no binary audio
assets by rule. Voice acting cannot come from an oscillator. The nearest
honest version is **more stations and a dispatch band with more chatter
patterns**, which the radio system already supports.

The remaining exclusions — hand-made maps, per-mission bonuses, unmarked
services — stand as recorded in `AUDIT.md`.

## 8. What I would build first, if only three things

If this plan is never finished, these three are the ones that pay:

1. **K1 — wrecking a car is a crime.** An afternoon, and it closes the only
   violent act in the game with no consequence.
2. **J1 — traffic signals.** The largest visible change per unit of effort in
   this document, and it costs nothing on the wire.
3. **J4 — gang war.** The one item that makes the city look like it is running
   itself rather than waiting for the player to arrive. It is also the hardest
   of the three, and the respect-leak test is the part to write first.
