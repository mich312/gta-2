# FEATURES — turning RESEARCH.md into systems

`RESEARCH.md` says what the two originals did and which of it this project
lacks. This document says **what to build for each of those gaps, where the
code goes, what it costs on the wire, and what has to go green** before it
counts as done.

Same conventions as `ROADMAP.md`: every item states scope, files, determinism
constraints, new tunables, bandwidth, effort, risk, dependencies, and a
verification gate. Effort key: **S** ≤ 1 day · **M** 1–3 days · **L** ≥ 1 week.

**Status: all twelve items are built.** Each landed as its own commit with
its own gate; `PROGRESS.md` has the per-item log and the surprises. What
follows is the plan as written, kept as the record of what was intended and
why — where the build diverged, `PROGRESS.md` says so.

---

## 0. Where this sits

`ROADMAP.md` covered waves A–E and is essentially delivered: binary codec,
ambient traffic, police cruisers, vehicle damage, water and boats, landmarks,
frenzies, stunts. This document is **waves F–I**, and it is a different kind
of work: A–E made the city function, F–I give it *rules* — reasons to act, a
cost for acting, and factions that remember what you did.

Read `RESEARCH.md` §6 ("the mechanics that actually carry the genre") first.
Each item below implements one or more of those eleven ideas, and says which.

---

## 1. The constraints every item obeys

The seven invariants in `ROADMAP.md` §0 still hold in full — bit-identical
`step()`, rng draws at fixed points, `shared/` free of Node and DOM, tunables
that round-trip, six touch points per new entity table, the 50 KB/s gate,
deliberate prediction context. Three more, which this plan's shape depends on:

**8. The sim/server line is decided by one question: does `step()` read it?**

This is the single most important architectural call in this document, and it
splits the features cleanly:

| Lives in the sim (`GameState`) | Lives server-side (like `Economy`) |
|---|---|
| **Respect** — gang AI reads it every tick to decide who to shoot | **Cash** — nothing in `step()` reads a wallet |
| **Busted state** — it's a player mode with physics consequences | **Score and multiplier** — pure bookkeeping over events |
| **Car fittings** — mines detonate inside the sim | **Mission state** — objectives are arbitration, not physics |
| **Timed power-ups** — invisibility changes AI targeting | **Crusher/export payouts** — a cashier decision |

Anything in the right column reaches the sim **only through `SimCommand`s**,
exactly as `Economy.buy()` does today (`server/src/economy/economy.ts:137-153`),
so it is recorded, replayed and desync-checked for free. Anything in the left
column costs wire bytes and a slot in the step order, and must be justified.

**9. Every feature declares its bandwidth cost up front.** The binary codec
took a full 8-bot brawl from 42.6 to ~11 KB/s against a 50 KB/s gate. That
headroom is the budget this whole plan spends, and §4 accounts for it.

**10. New per-player sim fields are batched, not sprinkled.** Five separate
`somethingUntilTick: number` fields cost five field slots in the diff; one
`powerFlags` bitfield plus one `powerUntilTick` costs two. Do it once, in F3,
before the power-ups arrive one at a time and calcify.

---

## 2. Wave map

```
Wave F  (rules, no new entities)   F1 score+multiplier ─┬─ F2 arrest
                                                        └─ F3 arsenal
Wave G  (the city pays you)        G0 vehicle classes ── G1 crusher/export ── G2 fittings ── G3 jobs
Wave H  (factions)                 H1 turf+gang peds ── H2 respect ── H3 missions
Wave I  (texture)                  I1 escalation by kind    I2 radio  [independent]
```

F1 gates everything with a payout. F2 needs F1 (the penalty *is* the
multiplier). H2 needs H1. H3 needs H2 and F1. I1 and I2 are independent and
can be dropped in any gap.

**Recommended order:** F1 → F2 → I1 → F3 → G0 → G1 → G2 → H1 → H2 → H3 → G3 →
I2. I1 rides early because it is small and the police are the system players
touch most; G0 rides ahead of G1 because the export list needs vehicle kinds
worth listing; G3 and I2 ride late because they are flavour, not structure.

---

# Wave F — rules

## F1 — Score, and the multiplier (S–M, low risk)

*Implements ideas #1 and #2: one number for score-money-progress, and a
multiplier that success raises and arrest halves.*

Today `Economy` credits flat amounts per kill/frenzy/stunt
(`economy.ts:158-189`) and keeps a separate `scores` map of
kills/frenzies/bestStunt for the leaderboard (`economy.ts:192`). There is no
multiplier anywhere, and the leaderboard ranks on a tally that spending cannot
touch — so buying a shotgun costs you nothing you care about.

**The design call, stated plainly.** The originals fuse score and money into
one number, so every purchase sets your progress back. That tension is the
point. In a persistent shared city there is no "level target" to be set back
*from* — so the question is what the leaderboard ranks on.

**Recommendation: rank on cash.** One number, exactly like the originals: your
wallet *is* your standing, spending is a real decision, and a rich player is
visibly a successful one. Keep `scores` as a lifetime-earned stat for flavour,
but it stops being the rank. The alternative — a monotonic score that spending
can't touch — is easier and strictly worse, because it makes every shop free
in the only currency that ranks you.

**The multiplier.** Per-player, server-side, in `Economy`:

- every award routes through one `applyMultiplier()` chokepoint — no credit
  path may bypass it, and the gate tests exactly that;
- **rises** on frenzy completion (+1) and, once H3 lands, on mission
  completion (+1, the big one);
- **halves** on arrest (F2), rounded down, floor 1;
- **unchanged** by death — that asymmetry is the whole point of F2;
- session-scoped, not persisted. It's a streak, and a streak that survives
  logout is not a streak.

**Files.** `server/src/economy/economy.ts` (multiplier state + chokepoint),
`server/src/economy/awards.ts` (award sources), `shared/src/net/messages.ts`
(extend `{ type: 'wallet', cash }` with `multiplier` and `lifetime`),
`server/src/net/broadcast.ts` (send on change), `client/src/render/hud.ts`
(cash and `×N`).

**Determinism.** None — no sim state changes. The multiplier never enters
`step()`, the hash, or a replay.

**Tuning.** `economy.json`: `multiplier.{max, frenzyGain, missionGain,
bustPenalty}`.

**Bandwidth.** Zero on the snapshot path; the `wallet` message already exists
and fires only on change.

**Gate.** Unit tests: every award path multiplies (assert by enumerating the
credit call sites — a new unmultiplied path must fail the test); multiplier
floors at 1 and caps; ledger stays append-only with idempotent refs; the
`persistCheck` e2e still passes.

## F2 — Arrest is not death (M, medium risk)

*Implements idea #5: two failure modes with different costs.*

Cops here only kill (`police.ts:93` `copFire`). The originals' most-copied
mechanic is that being **busted** and being **wasted** cost different things —
and busted costs more, because it takes the multiplier.

**Behaviour.** A cop adjacent to a player who is **on foot** and slow starts a
grab: `bustTicks` of contact and the player is busted rather than shot. Run,
and you get shot instead. That is the whole risk calculus — surrender is
cheaper in health and dearer in progress.

- **Busted** → respawn at the nearest police-station landmark, lose weapons
  and armour, heat cleared, **multiplier halved**.
- **Wasted** → respawn at the nearest hospital (already built, D2), lose
  weapons per `WEAPONS_LOST_ON_DEATH`, **multiplier intact**.

**Files.** `shared/src/sim/state.ts` (`PlayerMode` gains `'busted'`),
`shared/src/sim/police.ts` (the grab, at a fixed slot inside `stepPolice`),
`shared/src/sim/events.ts` (`busted` event), `shared/src/world/amenities.ts`
(a `police` landmark kind alongside `hospital`), `server/src/session.ts`
(respawn target selection), `server/src/economy/economy.ts` (the penalty),
`client/src/render/hud.ts` (a BUSTED state distinct from WASTED).

**Determinism.** The grab check iterates cops in sorted id order at a fixed
position in `stepPolice`, before `copFire`, so a cop that can bust never also
shoots on the same tick. `PlayerMode` is already a snapshot field, so the
transition is on the wire for free.

**Prediction.** Being grabbed is an authoritative event the client cannot
predict; it arrives as a correction. Acceptable — it is rare and dramatic, and
the client should *want* to hard-cut on it.

**Tuning.** `police.json`: `bustRadius`, `bustTicks`, `bustSpeedMax`.
`economy.json`: `multiplier.bustPenalty`.

**Bandwidth.** ~0 (one existing enum field gains a value).

**Gate.** A bot that stands still beside a cop ends busted; one that keeps
running ends shot. Multiplier halves on bust and survives death. Replay
re-simulates to identical hashes across a bust.

## F3 — The arsenal, and behaviour-altering power-ups (M–L, medium risk)

*Implements the breadth `RESEARCH.md` §7 item 9 flags, and idea #4 (bribes as
a located exit from heat).*

Four player weapons today (`weapons.json`: fists, pistol, smg, shotgun) and
four pickup kinds (health, armour, ammo, frenzy). Everything is hitscan and
every pickup tops up a bar.

**Two sub-parts, and the first is the expensive one.**

**F3a — projectiles.** Rocket launcher, grenade and molotov all need a
travelling object with a fuse, which means **a new entity table** and all six
touch points from `ROADMAP.md` §0.5: `state.ts` (create/clone) → `snapshot.ts`
(field list) → `hash.ts` → `broadcast.ts` (interest filter) →
`interpolation.ts` → `renderer.ts`. Fields: `id, kind, pos, vel, ownerId,
fuseAtTick`. They are few, short-lived and only exist during combat.

Detonation reuses `vehicleDamage.ts`'s existing explosion path, which already
does chain reactions deterministically. Flamethrower is **not** a projectile —
it is a short cone of repeated hitscan, cheaper and closer to how it behaved.

**F3b — the power-up batch.** Per invariant #10, add the container *once*:
`PlayerState.powerFlags` (bitfield) + `powerUntilTick`. Then:

| Power-up | Effect | Where it reads |
|---|---|---|
| Police bribe | Clears heat instantly | `pickups.ts` → `addHeat` |
| Get out of jail free | Cancels the next bust, then clears | `police.ts` grab check (F2) |
| Double damage | Damage ×2 while lit | `weapons.ts` damage calc |
| Invisibility | Cops and peds do not acquire you | `police.ts` + `peds.ts` targeting |
| Fast reload | Fire cooldown ×0.5 | `weapons.ts` cooldown |

All five are sim state, because `step()` reads every one of them.

**Files.** `shared/src/sim/projectiles.ts` (new), `weapons.ts`, `pickups.ts`,
`state.ts`, `snapshot.ts`, `hash.ts`, `server/src/net/broadcast.ts`,
`client/src/net/interpolation.ts`, `client/src/render/renderer.ts`,
`shared/data/weapons.json`, `shared/data/pickups.json`.

**Determinism.** `stepProjectiles` takes a **fixed slot after `stepWeapons`
and before `stepVehicleImpacts`** — spawned by firing, resolved before the
things they hit move. Iterate in sorted id order. This inserts rng draws only
if we add spread; if we do, it shifts every downstream draw and must be noted
in `PROGRESS.md` per invariant #2.

**Tuning.** `weapons.json` entries per new weapon (damage, radius, speed,
fuse, cone). `pickups.json`: durations per power-up.

**Bandwidth.** The one real cost in Wave F. Estimate ~0.5–1.5 KB/s per client
**during combat only**, zero otherwise; power-up flags are two fields on an
existing entity, changing rarely.

**Gate.** Chain-reaction determinism (two runs, identical hashes) — the
existing 10-car test extended to rockets. Fists still never run out. Bot
brawl stays under the gate with projectiles flying. Property test: a
projectile's fuse always resolves, never leaks.

---

# Wave G — the city pays you

## G0 — Vehicle classes (S–M, low risk)

*The prerequisite the first draft of this document missed.*

`vehicles.json` defines exactly **three** kinds — `car`, `boat`, `copcar`.
There is no taxi, no ambulance, no bus, no fire truck. G3 was written against
a taxi that has never existed, and G1's export list needs kinds worth listing.

Add `taxi`, `ambulance`, `bus`, `van`, `truck` and `firetruck` with distinct
mass, acceleration and top speed, sprites via `pnpm sprites`, and a weighted
spawn mix in `traffic.json` so the streets stop being one car in six colours.
Mostly data. It pays off three times over: the export list gets a shopping
list, the jobs get their vehicles, and a city of identical hatchbacks is the
most visible thing separating this from the originals' 59- and 69-vehicle
rosters.

**Files.** `shared/data/vehicles.json`, `shared/data/traffic.json`,
`shared/data/sprites.json`, sprite regeneration, `client/src/render/renderer.ts`.

**Determinism.** Spawn-mix selection draws from the existing traffic rng at
its existing point — a weighted pick replacing a uniform one shifts no draw
counts. Verify, don't assume.

**Bandwidth.** `kind` is already a vehicle field. ~0.

**Gate.** Worldgen/traffic determinism across 50 seeds. Every class drives —
no kind that spawns but cannot be entered or steered. Bot cruise run stays
under the gate.

---

## G1 — Car crusher and the export list (M, low risk)

*Implements idea #7: the city rewards you for using it as intended.*

Nothing currently converts a stolen car into anything. This is the cheapest
high-value item in the document, because the hard parts already exist: the
respray is **already a drive-in purchase** (`economy.ts:106-110`,
`item.kind === 'spray'`), so the "drive a vehicle into a place and transact"
mechanic is built and tested.

**Two halves, matching the originals:**

- **Crusher** — drive any car in, it is destroyed, you are paid by vehicle
  kind. Crucially, the payout is **sometimes equipment, not cash**: a weapon
  grant or a police bribe, exactly as the originals' crushers dispensed. That
  closes the loop between the theft verb and the combat verb.
- **Export list** — a rotating list of three wanted vehicle kinds per session,
  refreshed on a timer, shown on the HUD. Delivering a listed kind pays a
  large premium. This is the "city has a shopping list" job, and it is what
  makes players look at traffic as inventory rather than scenery.

**Files.** `shared/src/world/amenities.ts` (crane sites, industrial district,
placed like shops), `shared/src/world/types.ts` (`CityMap.cranes`),
`server/src/economy/economy.ts` (the cashier logic + rotating list),
`shared/data/economy.json` (payout table by kind), `client/src/render/hud.ts`.

**Determinism.** Vehicle destruction is issued as a `SimCommand`, so it is
recorded, replayed and hashed like every other economy write. The list rotates
off wall-clock time on the **server**, never inside `step()`.

**Tuning.** `economy.json`: `crush.{base, byKind, exportBonus, listSize,
refreshSec, equipmentChance}`.

**Bandwidth.** One-time map data plus a low-frequency list message. ~0.

**Gate.** An e2e in the shape of `persistCheck`: drive a car in, the vehicle
is gone from state, the ledger is credited **exactly once** (idempotent ref),
and the recorded replay re-simulates to identical hashes.

## G2 — Bomb shop and car fittings (M, medium risk)

*The mechanic `RESEARCH.md` §2.7 documents with real prices, and the answer to
"why is this car worth more than the next one".*

Garages already exist as shop buildings. Extend them to arm the car:

| Fitting | Price ratio | Behaviour |
|---|---|---|
| Bomb | ×1 | Arms; detonates on trigger or on exit-plus-delay |
| Oil slick | ×2 | Drops behind; anything crossing it loses control |
| Machine guns | ×5 | Forward-firing from the car |
| Mines | ×10 | Dropped behind; detonate on contact |

The originals' absolute figures ($5k/$10k/$25k/$50k) don't transfer — a pistol
here is $250 — but **the ratios are the design**, and they are what makes a
fitted car something you protect rather than abandon at the next junction.

**Implementation, and the shortcut worth taking.** `VehicleState` gains
`fitting` and `fittingAmmo` (two small fields, changing rarely). Slicks and
mines are dropped objects — and `props` is **already** a table of static,
damageable, positioned things with all six touch points wired
(`PROP_FIELDS` at `snapshot.ts:101`). Extending props with the new kinds plus
an `ownerId` is far cheaper than a new table. The caveat, and it is a real
one: props have a respawn path (`respawnAtTick`), and a consumed mine must
never come back. Gate that explicitly.

Car guns reuse the drive-by code, which already excludes the shooter's own
vehicle from the ray.

**Files.** `state.ts`, `vehicle.ts`, `weapons.ts`, `vehicleDamage.ts`,
`snapshot.ts`, `hash.ts`, `shared/data/vehicles.json`, `shared/data/shop.json`,
`renderer.ts`.

**Determinism.** Mine detonation resolves inside `stepVehicleImpacts`, in
sorted id order, so two cars crossing the same mine on the same tick resolve
identically everywhere.

**Bandwidth.** ~0.1 KB/s (two fields, on change only).

**Gate.** A consumed mine never respawns (explicit test). Two-cars-one-mine
determinism. Chain reaction of a bombed car into traffic re-simulates
identically.

## G3 — Hospitals, casualties, and service jobs (M, medium risk)

*Idea #7 again, in the mode that makes a city feel inhabited rather than
staged. Depends on G0 for the vehicles it drives.*

### G3a — Hospitals you can walk into (S)

Hospitals already exist as landmarks with door positions (`map.hospitals`,
`amenities.ts:604`) and are already the death-respawn anchor
(`step.ts:141`, `nearestHospital` at `step.ts:232`). But that is *all* they
are: you wake up outside one and there is nothing to do there.

Make the hospital a **shop kind** (`clinic`) in the system that already
handles gun and clothing shops — doorway detection, carved interior, server-
side purchase validation, all of it built and tested (`economy.ts:94-155`).
Sell health and armour. This is close to free and it converts a landmark that
currently only punishes you into one you choose to drive to.

### G3b — Downed pedestrians (S–M)

Today a ped is alive or removed. Add `'downed'` to `PedMode` (a field already
on the wire) with a bleed-out timer: a ped hit by a car or caught by a stray
round has a chance to go down rather than die outright, lies there for
`bleedOutSec`, and then dies.

This is the piece that makes the ambulance a *job* instead of a delivery
minigame, and it has a property worth stating: **your violence generates the
work.** In a shared city, one player's hit-and-run is another player's fare.
Nothing else in this plan couples two players' play that cheaply.

### G3c — The ambulance (M)

Drive an ambulance to a downed ped, load them (removed from the ped table
while aboard, exactly as the taxi fare is), deliver to a hospital door, get
paid — **more the faster you are and the more life they have left**, so the
job rewards driving well rather than driving far.

And the ambient half, which the research called out and which is nearly free:
**ambulances turn up on their own.** A downed ped with no player interest
draws an AI ambulance that drives to it using the pursuit controller the
police cruisers already have, loads, and leaves. The city reacting to your
carnage without you is most of what makes it feel simulated.

### G3d — Taxi and vigilante (S–M)

- **Taxi** — fares board while you drive one, pay per distance, dismount at
  the destination. Server-side job runner; the sim only sees `despawnPed` and
  `spawnPed` commands.
- **Vigilante** — in a cruiser, killing a wanted player or a hostile ped pays
  a bounty. Nearly free: a new reader over events that already exist in
  `Economy.processTick`.

**Still deferred: the fire truck.** Extinguishing needs a verb the game has no
analogue for — every other job here reuses drive-to-a-place-and-transact.
Vehicle fires exist (`vehicleDamage.ts`), so this is a real future item, just
not this one.

**Files.** `shared/data/vehicles.json`, `shared/data/traffic.json`,
`shared/data/shop.json`, `shared/data/peds.json`, `shared/src/sim/peds.ts`
(downed state), `shared/src/sim/state.ts` (`PedMode`),
`shared/src/world/amenities.ts` (clinic shops at hospital buildings),
`server/src/economy/jobs.ts` (new), `server/src/economy/economy.ts`,
`shared/src/sim/commands.ts`, `client/src/render/hud.ts`, sprite regeneration.

**Determinism.** The downed state and its timer are sim state and step inside
`stepPeds` at its existing slot — no new rng draws if the down-versus-die roll
reuses the draw the damage path already makes; if it needs its own, that
shifts every downstream draw and goes in `PROGRESS.md` per invariant #2.
Everything else is command-driven from outside the sim.

**Tuning.** `peds.json`: `downChance`, `bleedOutSec`. `economy.json`:
`jobs.{taxiPerPx, ambulanceBase, ambulanceSpeedBonus, vigilanteBounty}`.

**Bandwidth.** `PedMode` gains a value — no new field, ~0. Ambient ambulances
are ordinary vehicles and cost what any vehicle costs while in view.

**Gate.** Fares and ambulance runs pay per distance and cannot be farmed by
circling the pickup (explicit anti-exploit test). A downed ped either is
collected or dies — never leaks. Vigilante pays only in a cruiser. Two
players racing for the same downed ped: exactly one is paid.

---

# Wave H — factions

This is the wave that makes the game the second one rather than the first, and
it is where the difficulty is.

## H1 — Turf and gang pedestrians (M, medium risk)

Worldgen already produces districts (`world/districts.ts`) and 200 peds with
no identity. Give the map **turf**: a deterministic partition of blocks among
3–4 gangs, derived from the district map with the session seed, exposed as
`CityMap.turf`.

Peds gain `gangId` (0 = civilian). Gang peds spawn preferentially on their own
turf, render in the gang's colour, and carry weapons.

**Bandwidth.** `gangId` never changes after spawn, so it costs one byte per
ped **at creation only** — roughly 0.2 KB/s at the current ped population and
churn, and nothing in steady state.

**Files.** `world/districts.ts`, `world/types.ts`, `world/amenities.ts`,
`sim/state.ts`, `sim/peds.ts`, `snapshot.ts`, `hash.ts`, `renderer.ts`,
`shared/data/peds.json`, `shared/data/palette.json`.

**Gate.** Worldgen determinism across 50 seeds: every seed partitions all
blocks, no gang gets zero turf, turf is contiguous enough to read as territory
rather than confetti.

## H2 — Respect (M–L, high risk)

*Implements idea #8: reputation is zero-sum, so every choice closes a door.
This is the single most distinctive mechanic in either original.*

**Respect is sim state.** Not economy state — gang AI reads it every tick to
decide whether to shoot you, so it must be inside `step()`, in the hash, and
on the wire. `PlayerState.respect: number[]`, one small signed int per gang,
four gangs, four bytes, changing rarely.

**The rules, all applied inside `step()` at one fixed point after every system
that can produce a kill:**

- kill a gang's member: **−X with that gang, +X/2 with its rivals** (rival
  table in `shared/data/gangs.json`);
- complete a gang's mission (H3): **+Y**, and −Y/2 with its rivals;
- below a hostility threshold, that gang's peds attack you on sight;
- above a friendship threshold, that gang's peds **shoot at cops chasing you**
  in their turf — the originals' "gangs protect you from the police", and the
  best emergent behaviour in the whole plan for the cost.

The zero-sum coupling is the feature. Farming one gang's missions makes half
the map hostile, and that has to *feel* like a decision, not a bug — which is
why the HUD must show all gangs' standing at once, as the original did.

**Files.** `sim/state.ts`, `sim/peds.ts`, `sim/police.ts`, `sim/step.ts` (one
new fixed slot), `shared/data/gangs.json` (new), `snapshot.ts`, `hash.ts`,
`client/src/render/hud.ts`.

**Determinism.** Respect updates iterate kills in event order, which is
already deterministic, and apply in sorted gang order. No new rng draws.

**Risk.** The highest in the document, for a reason that is not technical:
this is the first system where the world can become **unplayable through
ordinary play** — grind two gangs hostile and a district turns into a
shooting gallery. Mitigations to design in from the start: respect decays
toward neutral over time, hostility has a floor, and turf hostility is local
(a hostile gang's peds elsewhere merely dislike you).

**Gate.** A bot script that kills gang A's members and verifies: A's respect
fell, A's rivals' rose, A's peds turned hostile inside A's turf and stayed
neutral outside it. Determinism across the whole sequence.

## H3 — Payphone missions (L, high risk)

*Implements idea #3's other half and the mission structure `RESEARCH.md` §3.1
catalogues.*

**Architecture: the mission runner lives server-side, outside the sim** — same
posture as `Economy`. It reads sim state and events, writes via `SimCommand`s,
and pushes a per-player `mission` message. Mission scripting must never enter
the hash; a scripted objective is arbitration, not physics.

**Payphones** are map features placed on street corners per district
(`CityMap.payphones`), ringing when a mission is available, taken by the
existing action-button edge — the same input path that already opens car doors
and buys from shops.

**Mission verbs**, from the research: assassinate a target; deliver a vehicle
or person; steal a **specific model** from a specific place; destroy a target;
escort or protect; beat a clock through checkpoints; hit a rival gang.

**Failure conditions are the design**, and all three are derivable from events
that already exist: the mission vehicle is destroyed (`explosion`,
`VehicleCondition`), the clock expires (tick arithmetic), a must-live NPC dies
(`kill`, `pedDown`). Gluing missions to fragile world objects is what makes
the sandbox's own chaos able to kill a job.

**Gating by respect** (H2): green missions at neutral, yellow above a
threshold, red at maximum — the 2/3/2 split per gang from `RESEARCH.md` §2.3.

**Reward:** cash × multiplier, respect with the employer (and its loss with
rivals), and **+1 multiplier** — which is what finally makes F1's multiplier
climb the way the originals' did.

**The multiplayer problem, stated up front.** Both originals are
single-player; missions assume the world is yours. Here two players can hold
missions targeting the same NPC. **Recommendation: per-player mission
instances with first-come arbitration** — the first to complete wins, the
other is failed with a notice explaining why. It is honest, it is cheap, and
it turns a conflict into a race. Co-op sharing is the obvious later
enhancement and should not block the first version.

**Files.** `server/src/missions/` (new: runner, verb implementations,
per-gang mission tables), `shared/src/net/messages.ts` (`mission` message),
`shared/src/world/amenities.ts` (payphone placement), `shared/src/sim/step.ts`
(action-edge handling for phones), `client/src/render/hud.ts` (objective +
marker), `shared/data/missions.json`.

**Bandwidth.** A low-frequency per-player message. ~0.

**Gate.** Each failure condition has a test that triggers it. A mission
completed by one of two racing players fails the other exactly once, with a
notice. Replay re-simulates identically across a full mission. No mission
state appears in the hash.

---

# Wave I — texture

## I1 — Escalation by kind (S–M, low risk)

*Idea #6, and the outstanding item from `ROADMAP.md` A1.*

The ladder is **half built**: `police.ts` already switches kind, not just
count — foot officers, then cruisers from `carsFromStar`, then roadblocks from
`roadblocksFromStar`. What is missing is the top of the ladder. `wantedLevelOf`
clamps at 5 (`state.ts:297`) and every tier above the cruiser threshold is the
same officer in greater numbers.

Add a `kind` field to `CopState` (one byte, set at spawn) and a tier table in
`police.json`: armoured/shotgun units at the SWAT-analogue tier, faster
federal units that do not bail out, and an armoured vehicle at the top. Raise
the clamp to 6 to match the research.

**Files.** `sim/state.ts`, `sim/police.ts`, `shared/data/police.json`,
`snapshot.ts`, `hash.ts`, `renderer.ts`.

**Bandwidth.** ~0 (one byte at spawn).

**Gate.** The A1 test finally passes properly: each tier fields a *different
kind* of unit, not merely more of the last one.

## I2 — Radio (S, low risk)

*Idea #10: diegetic audio as a map legend.*

Client-only. No sim state, no wire cost, no determinism concerns. A station
per vehicle, chosen by hashing the **vehicle id** so it is stable per car and
identical for every player who hears it, with an emergency-band analogue for
cruisers, ambulances and fire trucks. Once H1 lands, gang vehicles take their
gang's station — which turns the radio into the turf indicator it was in the
original.

Everything is synthesised from `shared/data/audio.json` like the rest of the
audio, so there are no assets to license and nothing to stream.

**Files.** `client/src/audio/`, `shared/data/audio.json`.

**Gate.** No dropped frames with radio plus the existing 16-voice ceiling.
Muting still mutes everything.

---

## 3. Sequencing, with reasons

| Order | Item | Effort | Why here |
|---|---|---|---|
| 1 | F1 score + multiplier | S–M | Gates every payout in the document |
| 2 | F2 arrest | M | Needs F1; makes police meaningful rather than lethal |
| 3 | I1 escalation by kind | S–M | Small, and finishes an outstanding roadmap item |
| 4 | F3 arsenal + power-ups | M–L | Biggest wire cost in Wave F; do it before Wave G loads the wire |
| 5 | G0 vehicle classes | S–M | Data-only; unblocks G1's export list and G3's jobs |
| 6 | G1 crusher + export | M | Cheapest high-value item; reuses drive-in purchase |
| 7 | G2 fittings | M | Needs G1's shape; makes cars worth keeping |
| 8 | H1 turf + gang peds | M | Foundation for H2 |
| 9 | H2 respect | M–L | The distinctive mechanic; highest design risk |
| 10 | H3 missions | L | Needs H2 + F1; largest item |
| 11 | G3 hospitals, casualties, jobs | M | Needs G0; flavour, safe to slip |
| 12 | I2 radio | S | Pure texture; safe to slip |

A useful stopping point exists after item 7: F1–G2 alone gives score,
multiplier, arrest, a real arsenal, a city of varied traffic, and somewhere
that pays for stolen cars — most of the first original, and a coherent game.

---

## 4. Bandwidth accounting

Current: ~11 KB/s per client peak against a hard 50 KB/s gate. Estimated
additions:

| Item | Steady state | Peak | Notes |
|---|---|---|---|
| F1 score/multiplier | 0 | 0 | Existing `wallet` message |
| F2 arrest | 0 | 0 | Existing `mode` field gains a value |
| F3 projectiles | 0 | 0.5–1.5 KB/s | Combat only; new table |
| F3 power-up flags | ~0 | ~0 | Two fields, rare changes |
| G0 vehicle classes | 0 | 0 | `kind` is an existing vehicle field |
| G1 crusher/export | 0 | 0 | Map data + low-frequency message |
| G2 fittings | ~0.1 KB/s | ~0.3 KB/s | Two vehicle fields; dropped props |
| H1 ped gangId | ~0.2 KB/s | — | One byte at spawn only |
| H2 respect | ~0 | ~0 | Four bytes per player, rare changes |
| G3 downed peds | ~0 | ~0 | Existing `PedMode` field gains a value |
| H3 missions | 0 | 0 | Per-player message |
| I1 cop kind | ~0 | ~0 | One byte at spawn |
| I2 radio | 0 | 0 | Client-only |
| **Total** | **~0.3 KB/s** | **~2 KB/s** | Against ~39 KB/s of headroom |

The plan is comfortably inside budget, and that is entirely because the binary
codec landed first. The 50 KB/s gate stays a hard build failure regardless.

---

## 5. Risks, ranked

1. **H2 makes the world hostile through ordinary play.** The zero-sum design
   is the feature and the hazard. Decay toward neutral, a hostility floor, and
   turf-local hostility are not polish — design them in at the start.
2. **H3's multiplayer arbitration.** Two players, one target. The
   first-come recommendation is cheap and honest, but it needs to be decided
   before the first verb is written, not after.
3. **F3 is the only item that meaningfully loads the wire.** Measure with the
   bot harness before and after, not at the end of the wave.
4. **Prop reuse in G2.** The respawn path resurrecting a consumed mine is a
   real bug waiting to happen; the gate exists specifically for it.
5. **F1's chokepoint erodes.** A future award path that forgets to multiply is
   invisible in play and obvious in the ledger. The enumeration test is the
   defence, and it must be kept honest as award sources are added.
6. **Scope.** Waves F and G are additive and safe. Wave H is a different game.
   Shipping F+G+I and stopping is a legitimate outcome, not a failure.

---

## 6. What this plan deliberately does not do

From `RESEARCH.md` §7 item 11, restated as decisions rather than omissions:

- **Lives, level targets, and pay-to-save.** Both originals are single-player,
  level-scoped and save-based. This is a persistent shared city where players
  join and leave continuously; "five lives to reach $1,000,000" has no
  meaning here, and pay-to-save has nothing to save.
- **Water as instant death.** The originals used lethal water as a map
  boundary and had no boats. This project has boats and navigable water on
  purpose (`RESEARCH.md` §2.8). Not revisiting that.
- **A day/night cycle.** Neither original had one — time of day was a fixed
  per-platform setting. If we ever add one it is a new idea of ours, not
  fidelity to anything, and it should be argued on its own merits.
- **Hidden packages.** A later-series collectible that neither original had
  (`RESEARCH.md` §5). Frenzies and located power-ups are the genuine article.
- **The fire truck**, for now. Extinguishing is the one job verb with no
  analogue in the game; G3 ships classes, clinics, the ambulance, taxi and
  vigilante, and leaves fire for later.
