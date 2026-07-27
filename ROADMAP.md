# ROADMAP — phases 9+ (fixing what REVIEW.md found)

Companion to `REVIEW.md`. That document says what's wrong; this one says what
to build, in what order, and how we'll know it worked.

Written to the same conventions as `PLAN.md`: each item states its scope, the
files it touches, the determinism constraints it must respect, the tuning it
adds, and a verification gate that has to go green before the phase is
considered done.

---

## 0. The invariants nothing on this roadmap may break

Every item below is subordinate to these. If a design choice conflicts with
one of them, the design changes — not the invariant.

1. **`step()` stays bit-identical everywhere.** Same state + inputs + commands
   + map ⇒ same result, on any engine. New subsystems get a **fixed position
   in the step order** (`shared/src/sim/step.ts:84-87`) and iterate in
   sorted-id order.
2. **`state.rng` advances only inside `step()`, in a fixed sequence.** A new
   system that draws random numbers must draw them at a deterministic point.
   Inserting a draw *shifts every downstream draw* — that's acceptable between
   versions (old replays won't re-simulate) but must be called out in
   `PROGRESS.md` when it happens.
3. **`shared/` imports nothing from Node or the DOM.** Tunables arrive via
   `initTuning()`; each host loads them its own way.
4. **Every new tunable round-trips.** Add to `shared/data/*.json`, parse in
   `shared/src/tuning.ts`, add a default, and verify the welcome-message and
   replay-header shapes match. (See the `props.json` dual-shape bug at
   `PROGRESS.md:57` — this has bitten once already.)
5. **Every new entity table needs six touch points**, or it will desync or go
   invisible: `state.ts` (create/clone) → `snapshot.ts` (field list) →
   `hash.ts` (hash fields) → `broadcast.ts` (interest filter) →
   `interpolation.ts` (client) → `renderer.ts`.
6. **The 50 KB/s per-client gate is a hard gate.** The bot harness fails the
   build on it, and it should stay that way.
7. **Prediction context is limited on purpose.** The client predicts the local
   player and their vehicle only; `overlapsOtherVehicle` returns `false` when
   `state === null` (`vehicle.ts:22`). Anything new that affects local player
   motion must either enter the predictor's context or accept a visible
   correction. Choose deliberately, don't discover it.

---

## 1. The bandwidth wall — why the order is what it is

The review's #1 and #2 priorities (police cars, ambient traffic) **cannot be
built next**, because there is no room on the wire for them. Measured on this
build, 6 bots, 30 s:

| Config | Per-client inbound | Share of the 50 KB/s gate |
|---|---|---|
| `PED_COUNT=200` (default) | **42.6 KB/s** | 85% |
| `PED_COUNT=0` | **26.1 KB/s** | 52% |
| ⇒ 200 pedestrians | **16.5 KB/s** | 33% |

Headroom today is **~7.4 KB/s**.

A pedestrian moves on a 3-tick cadence (10 Hz) and costs ~1.1 KB/s while in
interest range. A vehicle moving at the full 30 Hz tick rate, sending
`pos`/`heading`/`speed` as JSON, costs roughly **3× that — ~3.3 KB/s each**.

So the current budget affords **about two moving vehicles in view.** Ambient
traffic at any believable density needs eight to twelve. Police cars need
another two to six on top. The wire is the binding constraint, and no amount
of gameplay design gets around it.

`PROGRESS.md:100` deferred the binary codec with "JSON now fits the budget."
It no longer will. The `Codec` interface at `shared/src/net/codec.ts:10` was
written for exactly this moment — "switching to a binary encoding later means
writing one new implementation of this interface." That's Wave B, and it gates
the two highest-value gameplay items.

**Everything that does *not* touch the wire ships first.** That's Wave A, and
it happens to contain most of the cheap wins.

---

## 2. Wave map

```
Wave A  (no new bandwidth)      A1 fixes → A2 respawn → A3 combat verbs
                                A4 UX/HUD → A5 audio          [independent]
                                        │
Wave B  (enabler)               B1 binary codec → B2 cadence tiers
                                        │
Wave C  (living streets)        C1 vehicle damage → C2 traffic → C3 police cars
                                        │
Wave D  (geography)             D1 water/bridges/boats → D2 landmarks
                                        │
Wave E  (reasons to play)       E1 frenzies/stunts/score
```

Wave A and Wave B are independent of each other and can run in parallel.
Wave D1 is independent of B and C and can start any time — it's the longest
lead item, so starting it early is reasonable.

Effort key: **S** ≤ 1 day · **M** 1–3 days · **L** ≥ 1 week.

---

# Wave A — free wins

Nothing here adds a moving entity to the wire. All of it can land before the
codec work finishes.

## A1 — Correctness fixes (S, low risk)

The verified defects from `REVIEW.md` Appendix A. No new systems, no new
tunables except where noted.

| Fix | Change | Files |
|---|---|---|
| Cops can be run over | Add a `state.cops.ids` loop alongside players and peds; route through `damageCop` so it still raises heat and emits `copDown` | `shared/src/sim/weapons.ts:314-348` |
| Wanted 5 ≠ wanted 4 | Raise `maxCopsPerPlayer` to 12 as an interim, then supersede in C3 where higher tiers change *kind* not *count* | `shared/data/police.json`, `shared/src/sim/police.ts:48` |
| Car theft heat rule | Only add heat when the vehicle has an occupant (`driverId !== null`) **or** a cop has line of sight. Until C2 lands there are no occupants, so this effectively makes empty parked cars free — which is the correct genre behaviour | `shared/src/sim/vehicle.ts:121` |
| Dead tunables | Delete `police.marineSpeed`; either wire `police.spawnCooldownTicks` into `maybeSpawnCop` as a real inter-spawn gate or remove it (prefer wiring it — the ramp is currently "one per tick" with no tuning knob) | `shared/data/police.json`, `shared/src/sim/police.ts:36`, `shared/src/tuning.ts:42,147,225` |
| Orphaned skid marks | Call the already-written `Effects.skid()` from `drawVehicle` when |speed| is high and heading delta exceeds a threshold | `client/src/render/renderer.ts:355`, `client/src/render/effects.ts:218` |

**Determinism:** the cop run-over loop enters `stepVehicleImpacts` — fix its
position in the iteration order (players → cops → peds) and never change it.
`damageCop` already handles heat and events.

**Do not delete yet:** `traffic.json`, the `boat` tuning, `copcar` sprite,
`waterWidth`, `palette.water/sand`. Those get implemented in C2/C3/D1. Leave
them and reference this roadmap in a comment so the next reader knows they're
pending, not rotting.

**Gate:** new unit tests for each fix (car-kills-cop raises heat and emits
`copDown`; entering an empty car adds zero heat; wanted 5 fields more cops than
wanted 4). Full suite green. Bot brawl PASS, 0 desyncs.

## A2 — The world stops being consumable (S, low risk)

Pedestrians and props are removed permanently and never come back
(`peds.ts:156`, no prop respawn path). A long session monotonically empties.

- **Peds:** maintain a target population in the session. When
  `state.peds.ids.length < pedCount`, emit `spawnPed` commands at map
  `pedSpawns` points **outside every player's interest radius**, rate-limited
  to a few per second so nobody watches a person materialise.
- **Props:** add `respawnAtTick` to `PropState`; a broken prop flips back to
  `intact` after a tuned delay, again only when unobserved.

**Where:** ped topping-up belongs in `server/src/session.ts` as commands (so it
lands in replays and reproduces exactly) — *not* in `step()`, because it needs
to know about interest radii, which is server concern. Prop respawn is a pure
sim timer and belongs in `step()`.

**Tuning:** `peds.json` → `respawnRatePerSec`, `respawnMinDistFromPlayer`.
`props.json` → `respawnDelaySec`.

**Wire cost:** near zero. Props are static; ped count is unchanged in steady
state.

**Gate:** a 10-minute 8-bot brawl ends with ped count within 5% of target and
prop count within 10% of initial. Replay re-simulates hash-identical.

## A3 — Combat verbs: fists, pickups, armour (M, medium risk)

Three gaps that compound: no melee, no healing, no armour.

**Fists.** `stepWeapons` (`weapons.ts:293-309`) `continue`s when the slot is
missing or empty, so an unarmed player has no attack at all.

- Add `melee: boolean` and `infiniteAmmo: boolean` to `WeaponTuning`.
- Add a `fists` entry: `damage 8`, `cooldownTicks 12`, `range 22`,
  `spread 0.35`, `pellets 1`, `melee true`, `infiniteAmmo true`.
- Grant `fists` in slot 0 at spawn **and** on respawn; never clear it in
  `applyDamage` (`weapons.ts:264` currently empties `weapons` entirely — keep
  fists).
- Skip the `slot.ammo--` decrement when `infiniteAmmo`.
- Melee reuses the existing hitscan path with a short range. Simple, exact, and
  it predicts.

**Pickups.** New sim entity table — health, armour, ammo. Placed by worldgen at
deterministic points (park corners, alley ends, industrial lots), respawning on
a timer.

- `PickupState { id, kind, pos, active, respawnAtTick }` in `state.ts`.
- All six touch points from §0.5. Static positions mean the only fields that
  ever change are `active` and `respawnAtTick` — very cheap deltas.
- Collection happens in `step()`: a foot player overlapping an active pickup
  consumes it, in sorted-id order.

**Armour.** New `armour: number` field on `PlayerState`, absorbing damage
before health in `applyDamage`. **This touches prediction, the snapshot field
list and the hash** — all three, or it desyncs.

**Tuning:** new `pickups.json` — per-kind value, radius, respawn delay, and
worldgen density.

**Gate:** unit tests for fists-never-run-out, armour-absorbs-first,
pickup-respawn-timing. Prediction test: a player collecting armour reconciles
with correction ≤ threshold. Bot brawl PASS with a new `scavenge` script.

## A4 — UX and camera (M, medium risk — one item is thornier than it looks)

**Minimap (S).** The single highest-value UI addition. Client-only, no wire
cost: the client already regenerates the whole `CityMap` locally
(`main.ts:143`). Bake a downsampled tile image once at map load into an
offscreen canvas, blit a cropped window of it into a HUD corner, overlay
player/cop/shop markers. Shops must be marked — six of them across ~114
screenfuls is currently unfindable.

**Camera look-ahead (S).** `computeCamera` (`renderer.ts:47`) centres hard on
the player. Offset the target toward velocity (driving) or aim (on foot),
clamped, and run it through the existing `PoseSmoother` so it eases rather than
snaps.

**Speed-based zoom (M, and be careful).** At 330 px/s you cross the 480 px
viewport in 1.45 s, leaving ~0.73 s of visible road. The fix is to widen the
view with speed — but this is **more invasive than it appears**:
`client/src/render/tiles.ts` bakes chunks at a fixed device-pixels-per-tile,
so a continuously variable zoom either re-bakes chunks constantly or blits at
a non-integer scale and shimmers. Two workable options:

- **Two discrete zoom levels** (on-foot and driving), each with its own baked
  chunk scale, cross-faded on transition. Predictable, sharp, more memory.
- **Blit-scale only**, letting the existing 2× backing store absorb it. Much
  simpler; some softness at intermediate zooms.

Recommend prototyping the second first and only building the first if it looks
bad. Decide with eyes on it, not in advance.

**HUD (S).** Speedometer while driving, damage-direction flash, low-ammo
warning, hit marker. All read from state the client already has.

**Death beat (S).** Three seconds and a text line (`hud.ts:148`) is abrupt.
Hold the camera, desaturate, ease the overlay in. No sim change — the respawn
tick is already known.

**Gate:** manual review pass (this is a feel phase — the bot harness cannot
judge it). Frame time stays within budget at the widest zoom, verified on the
debug overlay.

## A5 — Audio (M, low risk)

Zero audio exists today. The client already receives every discrete event it
needs — `shot`, `kill`, `death`, `propDown` (`shared/src/sim/events.ts`) —
plus `explosion` and siren state from Wave C.

**Recommendation: synthesise procedurally with WebAudio; ship no binary
assets.** This matches the repo's existing philosophy — sprites are generated
by `server/src/tools/sprites.ts` from a JSON shape description, not authored
by hand. A parallel `shared/data/audio.json` describing oscillator/noise/
envelope parameters per sound would keep the whole project asset-free and
tunable in the same way everything else is.

Scope: gunshot per weapon, impact, engine loop (pitch tracks `|speed|`), siren,
explosion, ped scream, UI clicks. Positional gain and pan from world offset
relative to the camera. A global mute key.

**Gate:** no dropped frames with 16 concurrent voices; audio never blocks the
render loop; mute works; the client still runs headless (the bot harness must
not need an audio context).

---

# Wave B — bandwidth headroom

## B1 — Binary codec (M, medium risk, high value)

The enabler for everything in Wave C. The seam already exists: implement
`Codec` (`shared/src/net/codec.ts:10`) and nothing in client, server or bots
changes structurally.

Design:

- **Varint entity ids**, field **bitmask per patch** instead of JSON keys.
- **Quantised positions**: values are already `q8` (⅛ px) in the sim
  (`vec.ts`), so send `int16` at ⅛-px resolution — 4 bytes for a position
  instead of ~28 characters of JSON.
- **Heading as `uint8`** — already `q256` (`vehicle.ts:87`), so this is
  lossless, not lossy.
- **Speed as `int16`.**

Estimated per-vehicle patch: **~10 bytes vs ~75** for JSON. That's the ~7×
reduction that makes Wave C affordable.

**Critical constraint:** the codec must be **lossless with respect to
everything the hash covers** (`shared/src/net/hash.ts`). Quantisation is only
safe because the sim *already* quantises to exactly these steps. Verify that,
don't assume it — a codec that rounds differently than `q8`/`q256` will
produce a desync that looks like a physics bug and will cost days.

**Rollout:** keep `jsonCodec` and negotiate in the join handshake, so the
harness can run both and diff them. Delete the JSON path only once binary has
been green for a full phase.

**Gate:** a codec round-trip property test over randomly generated snapshots
(encode → decode → deep-equal, and hash-equal). Bot brawl PASS at ≤ 40% of the
previous byte count. Replay re-simulates hash-identical. Both codecs produce
identical `hashSnapshot` results.

## B2 — Cadence tiers and interest tuning (S, low risk)

Peds and cops already step on a staggered 3-tick cadence
(`peds.ts:127`, `police.ts:174`) — NPC motion at 10 Hz, interpolated smooth,
delta traffic cut to a third. Generalise it:

- Ambient traffic → 3-tick cadence (same trick, same justification).
- Player-driven and police-pursuit vehicles → full 30 Hz (they're the ones
  being watched closely).
- Consider distance tiers: full rate inside ~250 px, third rate beyond.

**Risk to watch:** vehicles move ~2.5× faster than pedestrians, so 10 Hz
motion has 2.5× the interpolation gap. It may read as choppy where peds don't.
Measure before committing; falling back to full rate for traffic within ~200 px
is the escape hatch.

**Gate:** bot brawl bandwidth report before/after. No increase in prediction
corrections.

---

# Wave C — living streets

Everything here depends on B1. Attempting it first will breach the gate.

## C1 — Vehicle damage, wrecks and explosions (M, medium risk)

Nothing in the game can currently destroy a car — `VehicleState`
(`state.ts:49`) has no health field.

- Add `health`, `state: 'ok' | 'burning' | 'wreck'`, `burnUntilTick`.
- Damage sources: bullets (already ray-hit vehicles? no — add vehicles to the
  `fireOnce` candidate list in `weapons.ts:92-173`), collisions scaled by
  impact speed, explosions.
- `burning` → emits smoke/fire; explodes when `burnUntilTick` elapses.
- Explosion: radius damage to players, cops, peds, props **and other
  vehicles**, in sorted-id order, single pass per tick. Chain reactions emerge
  naturally — a burning car ignites its neighbour, which ignites the next.
- New `explosion` SimEvent for client effects and audio.
- Wrecks stay as blocking scenery, then despawn on a timer (unobserved, per
  A2's pattern).

**Determinism:** chain reactions are the risk. One explosion pass per tick, in
sorted-id order, with damage applied to a snapshot of the candidate list taken
*before* the pass — otherwise the iteration order determines the outcome and
two hosts can diverge. Write the test that fires 10 cars packed together and
asserts identical hashes across two runs.

**Also fix here:** car-vs-car is currently a dead stop with position revert
(`vehicle.ts:52-56`). Replace with momentum transfer — both vehicles take
damage and exchange speed proportional to closing velocity. This is the single
biggest driving-feel improvement available.

**Prediction:** car-vs-car remains outside the prediction context
(`vehicle.ts:22`), so collisions will produce a correction. That's already
true today and already accepted (`PROGRESS.md:258`); just make sure the
correction magnitude doesn't grow past the harness threshold.

**Tuning:** `vehicles.json` → `health`, `burnSeconds`, `explosionRadius`,
`explosionDamage`, `collisionDamagePerSpeed`, `wreckDespawnSec`.

**Gate:** 10-car chain-reaction determinism test (two runs, identical hashes).
Bot brawl PASS. Corrections stay within threshold.

## C2 — Ambient traffic, NPC drivers, carjacking (L, medium-high risk)

Implements `shared/data/traffic.json`, which is a complete spec with zero code
behind it today.

**AI drivers via negative ids.** Set `driverId` to a negative value for an AI
driver. `tryEnterVehicle` already skips vehicles with `driverId !== null`
(`vehicle.ts:109`), so occupied cars are correctly un-enterable by default —
and **carjacking becomes an explicit new path**, which is exactly where the
genre's headline verb belongs.

**Driving behaviour**, using the parameters `traffic.json` already names:
follow the road tile grid, `lookAhead` for obstacles, `turnProbe` at
junctions, `turnChance` to pick, `brakeDistance` + `brakeDistancePerSpeed` for
stopping, `laneHalfWidth` + `laneKeepGain` to hold a lane,
`blockedTimeoutTicks` to give up and re-route, `decisionCadenceTicks` to keep
per-car cost near zero.

**Carjacking.** Action button near an occupied vehicle → AI driver ejected
(becomes a fleeing ped), player takes the wheel. Heat applies **here** — this
is the actual grand theft auto, unlike A1's empty parked car. Optionally gate
on speed at first, then remove the gate once it feels good; jacking a moving
car is the better version.

**Density.** `count: 30` across ~114 screenfuls is far too sparse to read as
traffic — it works out to roughly 2 cars in view. Recommend **maintaining
density near players** rather than a global count: spawn ahead of players at
the interest-radius edge, despawn behind. Same trick as A2's ped topping-up.
Retune `count` to a per-player target of ~8–12 in view.

**Gate:** bandwidth stays under the gate with 8 bots and full traffic (this is
the phase most likely to breach it — measure early and often). New `traffic`
bot script that drives against the flow. Replay hash-identical. No gridlock
after a 10-minute run — assert that mean traffic speed stays above a floor.

## C3 — Police vehicles, roadblocks, and a real escalation ladder (M, medium risk)

The review's #1 priority, and it needs C1 + C2 first.

**The hole being fixed:** cops move at 122 px/s, the player's car does 330, and
cops have no vehicles. Any car defeats the entire police force. Conversely on
foot the margin is 6% (130 vs 122), so escape is impossible. There is no
middle.

**Escalation by kind, not count** — this also supersedes A1's interim fix for
the inert fifth star:

| Stars | Response |
|---|---|
| 1 | Foot patrol (today's behaviour) |
| 2 | More foot units, wider spawn ring |
| 3 | **Police cars** — pursuit driving, sirens |
| 4 | Cars + **roadblocks** ahead on the road grid |
| 5 | Heavier units, aggressive ramming, faster respawn |

**Implementation.** `CopState` gains `vehicleId`. A police car is a vehicle of
kind `copcar` with `driverId` set to the cop's (negative) id — the same
mechanism as C2's AI drivers, reusing the pursuit steering already in
`police.ts:171-198` with vehicle physics substituted. The `copcar` sprite is
already drawn, and `sirenRed`/`sirenBlue` already exist in the lighting pass
(`client/src/render/lighting.ts:9`) — this is a spawn path and a behaviour,
not an art task.

**Roadblocks.** Two vehicles placed across a road tile ahead of the fugitive's
predicted path, derived deterministically from the road grid.

**Losing the cops.** Add a Pay'n'Spray equivalent: a garage amenity in
worldgen; drive in, pay, heat zeroes. Routed through the economy as a
`SimCommand` like every other purchase, so it stays outside the sim and
replays cleanly. This gives the player a *play* for escaping instead of a
20-second stopwatch.

**Balance flag from the review:** 8 cops at 17.5 DPS is 140 DPS — a
full-health player dies in 0.71 s. With A3's armour and pickups landed, re-tune
`copPistol` damage and cop accuracy so a 4–5 star chase is survivable-but-hard
rather than a coin flip.

**Gate:** a `pursuit` bot script that assesses whether a fleeing bot in a car
can be caught at 3+ stars (it should be, sometimes) and can escape at 1–2 (it
should, usually). Bandwidth under gate with cars + traffic. Replay
hash-identical.

---

# Wave D — geography

## D1 — Water, river, bridges, boats (L, high risk — start early)

The longest lead item. Independent of Waves B and C, so it can run in
parallel from the start.

Today: `worldgen.json:19` sets `waterWidth: 10` (never parsed),
`vehicles.json` has full `boat` tuning with `"medium": "water"`,
`renderer.ts:373` branches on `kind === 'boat'`, `palette.json` has `water`
and `sand` — and `world/types.ts:7-13` defines no water tile. A boat exists
with nothing to float on.

- Add `T_WATER = 6` (and optionally `T_SAND = 7`).
- **Carve the river before roads** in `generateCity` (`generate.ts:57`), so
  the road generator subdivides around it.
- **Bridges** where arterials cross water — carve road tiles over water and
  mark them, since they must be solid ground for cars.
- **Boats** at moored spawn points (`traffic.json` already specifies
  `mooredBoatCount: 8` and `boatCount: 8`).

**The hard part, stated plainly:** `moveWithCollision` and `isSolidTile`
(`shared/src/world/collide.ts`) currently have no concept of medium. Water must
be solid for players and cars but passable for boats, and land the reverse.
That means threading a medium parameter through the core collision path —
**which is inside the prediction hot loop**, so it must stay bit-exact. This is
the riskiest change on the roadmap. Do it first, in isolation, with tests, and
prove prediction still reconciles before adding any content on top.

**Why it's worth it:** a river with bridges creates the geography the map
completely lacks — chokepoints, chases with real decisions, districts that
feel separated, and a reason for the boat that's already written.

**Gate:** worldgen determinism test across 50 seeds (river always connects
edge-to-edge, every landmass reachable by road, no orphaned blocks). Prediction
test: a player walking into water is blocked identically on client and server.
Bot script that drives a boat.

## D2 — Landmarks, hospitals, district identity (M, low risk)

- **Landmarks:** a handful of oversized, distinctly-shaped, *named* buildings
  per city — stadium, power station, tower. Placed by worldgen, drawn
  distinctly, labelled on A4's minimap. Navigation currently has no anchors at
  all.
- **Hospitals:** replace `pickSpawn`'s uniform-random choice over 16 anonymous
  points (`step.ts:180`) with respawn at the **nearest hospital** to where you
  died. This is the single change that makes death legible instead of a
  teleport.
- **Park interiors:** park blocks are currently empty green rectangles
  (`buildings.ts:159-161`). Paths, ponds, benches (the sprite exists), trees.
- **District character:** vary street furniture density, prop kinds and lamp
  spacing per district, not just building colour.

**Gate:** worldgen tests (every seed produces ≥ N hospitals, ≥ M landmarks,
all reachable). Manual map review across several seeds.

---

# Wave E — reasons to play

## E1 — Frenzies, stunts, score (M, medium risk)

The review's blunt summary: there is no goal and no score. Money buys three
guns and four jackets; the economy has nothing to want.

- **Kill frenzies (S).** A pickup starts a timer and a target count; hitting it
  pays out. Trigger lives in the sim as a pickup (reuses A3's table); progress
  is tracked server-side off the existing `kill` events; the reward is an
  ordinary economy transaction. Tiny, and it's the classic loop.
- **Stunt jumps (M — most speculative item here).** Needs a vertical
  dimension: `z`/`vz` on players and vehicles, airborne entities skipping tile
  collision, sprite scaling and shadow offset while in the air, a landing
  check, and a bonus payout. This is genuinely new sim state with prediction,
  snapshot and hash implications. It's also the best replacement for the jump
  the genre never had — worth doing, but scope it honestly and don't bundle it
  with anything else.
- **Score and leaderboard (S).** Persist per-session and all-time stats through
  the existing ledger. The economy layer already has the right shape for it.
- **Give money something to buy.** With C1 landed, vehicle repair. With C3,
  Pay'n'Spray. Safehouses, garages, weapon upgrades.

**Gate:** frenzy payout is idempotent under the ledger's `UNIQUE ref` rule.
Stunt state hashes identically. `persistCheck` still passes.

---

## 3. Suggested sequencing

Two tracks in parallel, because Wave A needs no netcode work and Wave B needs
no gameplay work.

| Slot | Track 1 (gameplay) | Track 2 (netcode/world) |
|---|---|---|
| 1 | A1 fixes, A2 respawn | B1 binary codec |
| 2 | A3 combat verbs | B1 binary codec |
| 3 | A4 UX + minimap | B2 cadence tiers · D1 water (collision medium) |
| 4 | A5 audio | D1 water (river, bridges, boats) |
| 5 | C1 vehicle damage | D1 finish |
| 6 | C2 traffic + carjacking | D2 landmarks + hospitals |
| 7 | C3 police vehicles | D2 finish |
| 8 | E1 frenzies + score | — |

After slot 3 the game is meaningfully better to play. After slot 7 it is the
game the data files have been describing all along.

---

## 4. Standing verification gates

Every phase, no exceptions:

- `pnpm test` green, with new tests for the phase's behaviour.
- `pnpm bots --count=8 --script=brawl --duration=60` → **PASS**, 0 desyncs,
  tick spread ≤ 1, corrections within threshold.
- Per-client bandwidth **under 50 KB/s**, reported in `PROGRESS.md` with the
  measured number (not "fits").
- `pnpm replay <file>` re-simulates to identical hashes.
- `node server/dist/tools/persistCheck.js` passes for anything touching the
  economy.
- A `PROGRESS.md` entry in the existing format: what was built, what was
  verified with real numbers, **what was deliberately deferred**, and **what
  we're least confident about**. That last section has caught real problems
  twice in this project's history; keep it honest.

---

## 5. Risks, ranked

| Risk | Where | Mitigation |
|---|---|---|
| **Codec quantisation desync** | B1 | Quantise to exactly the sim's existing `q8`/`q256` steps — verify, don't assume. Property test encode→decode→hash-equal. Keep JSON codec alive and diff the two. |
| **Water collision breaks prediction** | D1 | Land the medium-aware collision change alone, with tests, before any content. It's in the prediction hot loop. |
| **Traffic breaches the bandwidth gate** | C2 | Measure at 2, 4, 8 cars in view before building the full system. B2 cadence tiers are the lever. |
| **Explosion chain-reaction non-determinism** | C1 | Single pass per tick, sorted-id order, candidate list snapshotted before the pass. Dedicated 10-car test. |
| **Zoom fights the baked tile cache** | A4 | Prototype blit-scaling first; only build dual-scale chunk baking if it looks bad. |
| **RNG-order churn invalidates old replays** | any phase adding a draw | Expected and acceptable — but state it explicitly in `PROGRESS.md` each time, so a future desync hunt doesn't chase a ghost. |
| **Scope creep in E1 stunts** | E1 | It's real new sim state (`z`/`vz`) with prediction implications. Ship it alone. |

---

## 6. What this roadmap deliberately does not do

Naming these so they're decisions rather than oversights:

- **Missions and a story campaign.** Deferred at `PROGRESS.md:60` and still
  correctly deferred — this is a multiplayer sandbox, and E1's frenzies and
  scores are the right amount of structure for it.
- **Gangs, territory and respect.** Attractive, and a natural fit for the
  district system, but it's a whole social layer. Revisit after Wave D gives
  districts real character.
- **Building interiors.** Excluded by the original brief; shops stay doorway
  zones.
- **Weapon drops on the ground.** Rejected in `PLAN.md` as a dupe/grief
  surface. A3's pickups are fixed, respawning world objects instead — a
  different thing, deliberately.
- **Mobile controls.** Still deferred.
