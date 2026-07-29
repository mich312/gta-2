# GTA — the things still missing

`AUDIT.md` walked the original feature list; `GAPS.md` turned what it found
into systems, and all sixteen of its items are built. This document is a
different kind of list. It comes from **playing the thing**, and every item on
it is a complaint rather than an omission:

1. You cannot lose the police.
2. It is too hard.
3. ~~Maybe the map should rotate instead of the player, while walking and
   driving — with a settings toggle.~~ **Declined after costing — see §10.**
4. The "person lying on the floor" sprite is not good enough.
5. More car variation; bicycles; motorcycles.
6. Police should come in waves, with various equipment.
7. Plane / helicopter / airstrip, and the military at five stars.
8. *(added in review)* Every type of vehicle can be found somewhere in the
   world.

Complaints are better input than audits, because a missing feature is a
guess about what would be fun and a complaint is a measurement of what is
not. Two of these (1 and 2) are the same bug seen from two angles, and that
bug is the most important thing in this document.

Same conventions as `ROADMAP.md`, `FEATURES.md` and `GAPS.md`: every item
states scope, files, determinism constraints, prediction impact, new
tunables, bandwidth, effort, risk, dependencies, and a verification gate.
Effort key: **S** ≤ 1 day · **M** 1–3 days · **L** ≥ 1 week.

**Status: all nine items are built.** Each landed as its own commit with its
own gate, in the order of §2. Baseline before the first: 50 test files, 580
tests. After the last: **55 files, 650 tests**, plus `pnpm bots
--count=8 --script=brawl` at 0 desyncs and a replay that re-simulates to
identical hashes. (`pnpm build` first — the client tests resolve `shared`
through its built entry.)

Five things the build changed about the plan, all of them found by making it
work rather than by arguing:

- **P1 needed a radio.** Removing the pursuit's omniscience left nothing in
  its place, and units dispatched to where a suspect *was* circled 300 px
  away — just outside the 260 they can see — for a whole wave without ever
  making contact. Dispatch now updates units en route while the suspect is
  still hot, gated on the same cool-down that governs everything else.
- **P1c deadlocked the whole system.** Suppressing spawns whenever a player
  is unseen also suppresses the FIRST car: commit a crime on an empty street
  and three seconds later nobody can see you, so nobody is sent, so nobody
  ever can. Dispatching the first unit is the crime being reported;
  suppressing the second is the search being called off.
- **The dispatch budget had to stop counting searchers.** Six units combing
  the wrong block read as a full response while a suspect stood in plain
  view three streets away.
- **P3's waves did not group.** Taking the unitIndex-th valid kerbside point
  scatters them, because the spawn list is row-major over the window; a wave
  of five measured 1126 px across. They stage on one point now.
- **S2 got easier, not harder.** The plan costed an airstrip against city
  blocks and found it barely fits. The countryside that landed on main
  mid-build made it straightforward, and an airfield in a meadow is where
  one belongs.

---

## 1. What the code actually does today

Not a summary — the specific lines each complaint lands on. Every number
below was read out of the repository, not remembered.

### The chase

| Fact | Where |
|---|---|
| Heat decays **only** while no living officer has line of sight within `sightRange` (260 px) | `shared/src/sim/police.ts:510`, `anyCopSees` at `:43` |
| Decay is 5 heat/s, flat | `shared/data/police.json` `heatDecayPerSec` |
| A star is 100 heat; the ladder runs to 6; heat caps at 699 | `shared/src/sim/state.ts:612`, `:617` |
| A pursuing officer steers at the fugitive's **true position**, always, with no memory and no notion of having lost them | `shared/src/sim/police.ts:618-624` |
| One officer spawns every 18 ticks, 260–640 px away, while `assigned < copsPerStar × wanted` | `shared/src/sim/police.ts:112-156` |
| Officers of one wanted level are all the same kind; the kind ladder is `patrol ×3, swat, fed, army` | `police.ts:99` (`copKindFor`), `police.json` `tiers` |
| The only exits from heat: a respray (`clearHeat` command), a `bribe` pickup, an arrest, and death | `sim/step.ts:246`, `sim/pickups.ts:138`, `sim/weapons.ts:405`, `:490` |

Put those together and the first complaint is not a balance problem, it is a
**structural** one:

> The decay gate is closed by the presence of officers, and the number of
> officers present is a function of the wanted level. The higher the level,
> the more witnesses the spawner manufactures to keep the gate closed. A
> level-5 chase needs 100 seconds of nobody seeing you, and the system's
> response to level 5 is to guarantee that somebody does.

No officer in the code is ever capable of losing you. `drivePursuit` and the
on-foot chase both read `target.pos` directly. There is no last-known
position, no search, no giving up short of the 15-second `despawnTicks`
timer that only starts once you are **already** un-wanted. The escape valve
the genre is built on — break line of sight, take a corner, go quiet — does
not exist in the simulation at all.

### The difficulty

| Unit | Weapon | Sustained DPS | Health |
|---|---|---|---|
| Player | — | — | 100 + up to 100 armour |
| `patrol` | `copPistol` 7 dmg / 12 ticks | 17.5 | 50 |
| `swat` | `copShotgun` 8 / 22 | 10.9 | 90 |
| `fed` | `copSmg` 6 / 4 | **45.0** | 120 |
| `army` | `copRifle` 14 / 8 | **52.5** | 220 |

`copsPerStar` is 2 and `maxCopsPerPlayer` is 10, so a five-star response is
ten federal agents at 45 DPS each. Against 200 effective health that is
**under half a second** if they all hold line of sight. Officers are
hitscan, have no reaction delay, no burst pause, and their only source of
miss is one spread roll (`police.ts:200-205`) — accuracy does not fall off
with range, and it does not care that you are doing 200 px/s in a car.

And the ladder is easy to climb by accident: `heatPerPedKill` is 80, so
**one pedestrian under the wheels is four-fifths of a star** and four is
three stars. Heat is deliberately not gated on witnesses (`weapons.ts:264-270`
argues the case, and it is a good argument), so driving down a busy street
badly is a three-star crime you commit without a shot fired. Combine that
with §1's finding that heat cannot come down, and "too hard" is exactly what
falls out. The two complaints are the same complaint.

### The camera (background for the declined item — §10)

- The frame is axis-aligned throughout. One rounded origin per frame, and
  every world position is `originX + round(wx × RENDER_SCALE)` — two
  **separable** helpers, `dx(wx)` and `dy(wy)`, used at 43 sites in
  `renderer.ts:349-350`.
- Ground is pre-painted into 8×8-tile chunk canvases and blitted
  axis-aligned (`tiles.ts:128-158`).
- Sprites bake their rotation once per angle step (32 steps) into their own
  canvas, so drawing is a plain axis-aligned blit — `sprites.ts:76-139`, and
  `GRAPHICS.md` Part 1 explains why: `ctx.rotate` per draw resamples pixel
  art at every angle and makes it crawl.
- The light pass bakes shadow sprites keyed on **world** position and blits
  them axis-aligned (`lighting.ts:373-397`).
- On-foot movement is screen-relative by explicit design, and the design note
  at `sim/player.ts:47-59` records that aim-relative movement was tried and
  was worse. The wire carries four booleans (`up/down/left/right`).

So the renderer is not hostile to a rotating camera, but it does assume an
axis-aligned world in four separate places, and the input protocol assumes an
un-rotated screen.

### The dead, the traffic, the sky

- A body is the **standing sprite**, stretched 1.5× along the axis it fell
  and squeezed to 0.82× across it (`renderer.ts:1022-1023`, `drawBody` at
  `:1070`). The comment there is honest about it: "no new art, and legible at
  480×270". It reads as a person seen from slightly further away, not as a
  person on the ground. There is no dedicated corpse art in `sprites.json` —
  35 sprite definitions, 106 sheet frames, none of them prone.
- 14 vehicle kinds in `vehicles.json`; 11 of them in the traffic mix. Colour
  variation exists (`car` has 10 body colours, `gangcar` 4) but **silhouette**
  variation does not: every civilian car is one shape. No two-wheelers of any
  kind, and nothing slower than a car other than walking (78 px/s).
- `LANDMARK_KINDS` is `stadium, power, tower, hospital, police`
  (`world/types.ts:79`). Nothing flies: no `z` on `VehicleState`, no air
  medium (`vehicles.json` has `medium: "water"` for boats and nothing else),
  and `tiers[5]` names `army` but an army officer is a patrolman with a rifle
  and more health.

---

## 2. Wave map

```
Wave P  (the chase becomes a game)   P1 losing them ── P2 the difficulty pass ── P3 waves and equipment
Wave R  (the street)                 R1 bodies          R2 two wheels and more bodywork ── R3 every vehicle has a home
Wave S  (the sky)                    S1 the helicopter ── S2 airstrip + aircraft ── S3 the military at five
```

**Dependencies that are real, not stylistic:**

- **P2 needs P1.** Softening the police without giving them a way to lose you
  makes the game longer, not easier: you would survive the chase you still
  cannot end. P1 first, always.
- **P3 needs P1.** Waves are a rhythm — pressure, then a lull. Without an
  escape the lull is just a slower loss, and waves make the game *harder*.
- **R3 needs R2**, and only in the sense that a home has to exist for every
  kind R2 adds — its machinery is independent, and it is the item that stops
  R2's six new bodies from being six new lottery tickets.
- **S1 needs P1.** A helicopter is only interesting as a thing that holds the
  cool-down clock open. Built before P1 there is no clock for it to hold.
- **S3 needs P3 and S1.** "The military at five stars" is a wave composition
  plus air support; both are other items' machinery.
- **S2 needs R3** to give the aircraft it adds somewhere to sit, and unblocks
  S3's gunship variant. It is the largest single item here.
- **R1 needs nothing and unblocks nothing.** It can land in any gap.

**Recommended order:** P1 → P2 → R1 → P3 → R2 → R3 → S1 → S2 → S3.

*(Built in exactly this order.)*

P1 rides first because it is the actual bug and because every other item in
Wave P and Wave S is tuned against it. R1 rides third because it is the
cheapest visible improvement in the document — a day of sprite data — and
because a run of three systems items in a row is how a plan loses its nerve.

**The camera is out.** An earlier draft of this document carried a Wave Q —
rotate the map rather than the player, behind a settings toggle. It was
costed at **L**, at the highest risk in the plan, and it required a protocol
bump purely to express on-foot movement in world space (four booleans can
only name eight directions, so a camera at 37° would walk you at 45°). It has
been dropped on the owner's call. The fixed north-up camera stays. What was
learned in costing it is worth keeping, and §10 records it.

---

## 3. The constraints every item obeys

All the invariants from `ROADMAP.md` §0, `FEATURES.md` §1 and `GAPS.md` §1
hold in full. Four of them do the work here:

**The sim owns anything `step()` reads.** Cop memory, wave composition, a
helicopter's position and an aircraft's altitude are all sim state and all go
on the wire. Camera rotation, the settings toggle and every millisecond of
smoothing applied to either are **render-side only** and must never reach an
`InputIntent` — a client that could rotate the sim's frame could desync it.

**The cheapest sim state is no sim state.** P3's wave index is derived from
`state.tick − wantedSinceTick` rather than counted, which costs one field
instead of two and cannot drift.

**Every gameplay number is a tunable in `shared/data/*.json`,** shipped in
the `welcome` payload. The tuning payload is part of the wire contract:
adding a key to it means bumping `PROTOCOL_VERSION` (`constants.ts:26`,
currently 8), because a client that cannot parse the tuning it is sent hangs
on "connecting…".

**Bandwidth.** Measured today ~10.5 KB/s per client against a 50 KB/s hard
gate. §9 accounts for every byte this plan adds; the total is well under
1 KB/s, and the largest single contributor is Wave S's helicopter.

---

# Wave P — the chase becomes a game

## P1 — losing the police

**The complaint:** you cannot lose them.

**Scope.** Give an officer the ability to lose track of a fugitive, and give
the wanted level a cool-down clock instead of a presence gate. Three changes,
all in `shared/src/sim/police.ts`, and none of them touch what happens while
you are actually being chased in the open.

### P1a — an officer has a memory

`CopState` gains three fields:

```ts
/** Where the target was last seen, q8. Null-ish (-1) when never seen. */
lastSeenX: number;
lastSeenY: number;
/** Ticks spent searching since sight was lost. 0 while in contact. */
searchTicks: number;
```

The pursuit loop (`police.ts:588-662`) and `drivePursuit` (`:342`) stop
reading `target.pos` unconditionally:

- **In sight** (`hasLineOfSight` within `sightRange`): behave exactly as
  today, and write `lastSeen*` every tick. `searchTicks = 0`.
- **Out of sight**: steer at `lastSeen*` instead. On arriving within
  `searchArriveDist` of it, start a bounded search — the officer walks the
  road grid outward using `dirIsOpen`/`nearestCardinal`, which already exist
  for exactly this kind of decision (`sim/roadgrid.ts`, used by `detourDir`
  at `police.ts:313`). Deterministic: the direction comes from the existing
  rng stream, drawn at a fixed cadence.
- **`searchTicks ≥ searchGiveUpTicks`**: `targetId = null`. The officer falls
  into the existing idle path (`police.ts:577-584`) and despawns on
  `despawnTicks` as it always did.

A cruiser searches the same way but faster and over a wider radius, which is
what makes a car chase and a foot chase feel different in the right
direction: outrunning a cruiser is easy, hiding from one is not.

### P1b — a cool-down clock, not a presence gate

`PlayerState` gains `lastSeenTick: number` — the last tick any living officer
had line of sight. `stepPolice`'s decay block (`police.ts:507-514`) becomes:

```
unseen = state.tick - p.lastSeenTick
if (unseen >= wantedCooldownTicks) {
  ramp = min(heatDecayMax, heatDecayPerSec * (1 + heatDecayRamp * (unseen - wantedCooldownTicks) / TICK_RATE))
  p.heat = max(0, p.heat - ramp * DT)
}
```

Two properties this buys that the gate cannot:

- **It is legible.** "Clear in 4…3…2…" is a number the HUD can show
  (`render/hud.ts`), and a chase you can see yourself winning is a different
  experience from one you can only see yourself losing.
- **It accelerates.** A flat 5/s means a five-star level takes 100 seconds of
  perfect play. With `heatDecayRamp`, the same escape takes about 35 — long
  enough to be an achievement, short enough to attempt.

### P1c — the spawner stops re-acquiring you

`maybeSpawnCop` (`police.ts:112`) returns early for any player currently
inside the cool-down window. This is the line that closes the loop: today the
spawner's job is to place a fresh pair of eyes 260 px from a fugitive every
0.6 s, which is precisely the thing preventing the escape. Officers already
on the street keep searching; nobody new is dispatched to a person nobody can
see.

**Files.** `shared/src/sim/police.ts` (the bulk), `shared/src/sim/state.ts`
(`CopState`, `PlayerState`, `createCop`, clone paths), `shared/src/net/binary.ts`
+ `snapshot.ts` (three cop fields, one player field), `shared/data/police.json`,
`shared/src/tuning.ts`, `client/src/render/hud.ts` (the clear-in readout).

**Determinism.** The search direction is one rng draw at a fixed cadence,
drawn from `state.rng` like every other police decision, so the stream stays
fixed for a given seed. `lastSeenTick` is written from a pure line-of-sight
test over the map. Nothing here reads wall-clock.

**Prediction.** None. Cops are not predicted; the client interpolates them.

**New tunables** (`police.json`): `searchGiveUpTicks` (240), `searchArriveDist`
(40), `searchWanderTicks` (30), `wantedCooldownTicks` (90),
`heatDecayRamp` (0.35), `heatDecayMax` (26), `carSearchSpeedScale` (1.4).

**Bandwidth.** 3 fields × ~2 B on cops that have lost sight, 4 B once per
player per sighting change. Under 100 B/s at a busy five-star chase.

**Effort M. Risk M** — the risk is a search that looks stupid (an officer
pacing a junction while the player watches from ten feet away through a
wall). Mitigation: the search is a road-grid walk, not a random one, and the
give-up timer is short enough that a stupid-looking officer leaves.

**Gate.**
- New tests in `shared/test/police.test.ts`: an officer with a wall between
  them and the target stops steering at the target; `searchGiveUpTicks`
  elapsed clears `targetId`; heat decays after `wantedCooldownTicks` and not
  before; the ramp reaches `heatDecayMax` and does not exceed it.
- A new bot script `flee` in `server/src/bots/scripts.ts`: commit crimes to
  4 stars, then drive away from the nearest officer for 90 s. **The number
  that has to move: fraction of runs reaching 0 heat.** It is 0 today; the
  gate is ≥ 70 %.
- `pnpm replay` on a recorded chase re-simulates to identical hashes.

---

## P2 — the difficulty pass

**The complaint:** it's too hard.

**Scope.** Make the police survivable without making them ignorable. P1 fixed
the structural half; this is the numbers half, plus three mechanical changes
that no amount of tuning substitutes for.

### P2a — accuracy that falls off (mechanical)

`copFire` (`police.ts:189`) currently rolls one spread value and fires. It
gains two multipliers, both in the officer's favour when you stand still and
against them when you run:

```
spread × (1 + rangeSpread × d / fireRange)
        × (1 + speedSpread × targetSpeed / referenceSpeed)
```

This is the single biggest lever in the item, and it is the *fair* one: it
never makes an officer miss a stationary target at point-blank range, and it
stops ten federal agents deleting a car doing 200 px/s across a junction.

### P2b — a burst cadence (mechanical)

Officers fire on a flat cooldown, so their DPS is their sustained DPS. Cop
weapons gain `burstCount` and `burstPauseTicks` (`weapons.json`, applied in
`copFire` via a `burstLeft` counter on `CopState`). A fed becomes three
rounds then a beat. Peak lethality is unchanged — being caught in the open is
still a mistake — but sustained DPS roughly halves, and the beats are what
give you the gaps to move in.

### P2c — riflemen keep their distance (mechanical)

Every officer today walks to `bustRadius - 2` and stops (`police.ts:618`),
so a five-star response is ten people in a huddle around you, all at minimum
range. Cop kinds gain `preferredRange`: `patrol` closes to arrest (0, as
now), `swat` closes, `fed` and `army` hold at 120–150 px. It costs one clamp
in the chase branch, it makes the top tiers read as a cordon rather than a
mob, and it means the arrest mechanic still belongs to the officers whose job
it is.

### P2d — the numbers

| Number | Now | Proposed | Why |
|---|---|---|---|
| `copsPerStar` | 2 | 1 | Escalation by kind, which is what `police.ts:92-98` already says the design intends. Ten of anything is a mob. |
| `maxCopsPerPlayer` | 10 | 7 | With P3's waves, arrivals are grouped; a lower ceiling is what makes a lull a lull. |
| `heatPerPedKill` | 80 | 45 | Still serious; no longer four-fifths of a star. |
| *(new)* `heatPerRoadKill` | — | 25 | Someone under your wheels at speed is not the same crime as someone you shot. Split at `sim/peds.ts:492`, which already knows the attacker. |
| `heatPerTheft` | 15 | 15 | Unchanged. Stealing cars is the game. |
| `fireRange` | 190 | 175 | With P2c, riflemen already stand off; this stops the pistol tier sniping. |
| `bustSpeedMax` | 40 | 55 | Arrest is the merciful outcome and it is currently hard to trigger by accident. |
| `pickups.health.value` | 40 | 40 | Unchanged; §P1 is the reason chases end, not attrition. |

### P2e — a difficulty preset, on the server

`police.json` gains a `presets` block (`relaxed` / `normal` / `hard`)
carrying overrides for the dozen numbers above; `DIFFICULTY` in
`server/src/config.ts` picks one at boot, and the resolved tuning ships in
`welcome` exactly as today. **Server-side, not per-client** — it is a
property of the session, and a client-selectable difficulty in a shared world
is not a difficulty setting, it is an exploit.

**Files.** `shared/src/sim/police.ts`, `shared/src/sim/peds.ts` (the road-kill
split), `shared/data/police.json`, `shared/data/weapons.json`,
`shared/src/tuning.ts`, `server/src/config.ts`.

**Determinism.** The extra spread terms are computed from sim state and
consume the same single rng draw. `burstLeft` is an integer counter on the
cop. Nothing new is random.

**Bandwidth.** One small counter per cop. Negligible.

**Effort M. Risk M** — the risk is over-correcting into a police force that
is decorative. Mitigation is the gate: the numbers below are two-sided.

**Gate.**
- `shared/test/police.test.ts`: spread grows with range and with target
  speed and is unchanged at zero of both; a burst fires `burstCount` then
  pauses; a `fed` stops at `preferredRange` and does not walk into bust
  range.
- The `flee` bot script from P1, extended: **median survival time at 4 stars
  while driving** must go up by ≥ 3×, and **median survival at 4 stars while
  standing still in the open** must not go up by more than 1.5×. Both
  numbers, not one.
- `pnpm bots --count=8 --script=brawl --duration=60` still passes its
  desync/bandwidth gates.

---

## P3 — waves, and various equipment

**The complaint:** police should come in waves with various equipment.

**Scope.** Replace the one-officer-every-18-ticks drip with grouped arrivals
and quiet gaps, and make the tiers visibly and behaviourally different.

### P3a — a wave is a composition

`PlayerState` gains `wantedSinceTick: number` (set when heat first crosses
into a star, cleared with the wanted level). The wave index is **derived**,
not stored:

```
wave = floor((state.tick - p.wantedSinceTick) / wavePeriodTicks)
```

`police.json` gains a wave table keyed by wanted level:

```json
"waves": {
  "1": [{ "kind": "patrol", "count": 1, "vehicle": null }],
  "3": [{ "kind": "patrol", "count": 2, "vehicle": "copcar" }],
  "4": [{ "kind": "swat",   "count": 3, "vehicle": "copcar" }],
  "5": [{ "kind": "fed",    "count": 2, "vehicle": "copcar" },
        { "kind": "swat",   "count": 2, "vehicle": "copcar" }],
  "6": [{ "kind": "army",   "count": 3, "vehicle": "tank" },
        { "kind": "fed",    "count": 2, "vehicle": "copcar" }]
}
```

`maybeSpawnCop` becomes `maybeSpawnWave`: on a wave boundary it places the
whole group **from one kerbside point**, on consecutive ticks, so the
response arrives from a direction rather than materialising around you. Then
`waveGapTicks` of nothing. The existing per-tick spawn budget stays — one
entity per tick, so a wave is still a ramp, just a much shorter one.

The lull is the point. It is what makes P1's cool-down window reachable
without making the police weak, and it is the thing the drip can never
produce: today the pressure is a constant, and a constant has no shape.

### P3b — equipment

Two halves, and both are cheap because the machinery exists.

**Behaviour.** `police.json`'s `kinds` block already carries health, weapon
and move speed per kind. It gains `preferredRange` (from P2c), `shield` (a
frontal damage multiplier for SWAT, applied in `damageCop` —
`sim/weapons.ts:354` region), and `vehicle` (which car this kind arrives in,
so `motorise` at `police.ts:277` stops hard-coding `copcar` and a `tank`
becomes a legitimate arrival).

**Art.** Officers are one sprite tinted per kind today
(`renderer.ts:484-489`, `COP_TINT`). Four sprite definitions in
`shared/data/sprites.json` — `cop`, `copSwat`, `copFed`, `copArmy` — with
helmet, vest and long-gun silhouettes, at the same 29×29 and the same four
walk frames. `sprites.json` is declarative shapes (rect/ellipse/disc + z +
colour), so this is data, not code: about 15 shapes per sprite. Roughly
+12 sheet frames on a 106-frame, 68 KB sheet.

**Files.** `shared/src/sim/police.ts`, `shared/src/sim/state.ts`,
`shared/data/police.json`, `shared/data/sprites.json`,
`client/src/render/renderer.ts` (sprite name per kind, replacing the tint),
`shared/src/tuning.ts`.

**Determinism.** The wave index is a pure function of two integers already in
the state and already in the hash. The kerbside pick uses the existing rng
walk (`police.ts:136-138`) once per wave rather than once per officer, which
*reduces* rng traffic.

**Bandwidth.** One int per player, changing once per chase. Nothing per cop.

**Effort M. Risk M** — the risk is a wave that arrives on top of you because
the one kerbside point it picked happened to be behind you. Mitigation:
prefer a spawn point on the far side of the fugitive's velocity vector, which
is the same "ahead of travel" arithmetic `maybeRoadblock` already does at
`police.ts:468-473`.

**Gate.** `shared/test/police.test.ts`: a wave spawns its full composition
within `count` ticks and then nothing for `waveGapTicks`; a level-6 wave
contains a tank; wave composition is identical for two runs of the same seed.
Plus `pnpm sprites -- --preview=8 --only=copSwat` eyeballed, and an evidence
PNG per tier in `evidence/`.

---

# Wave R — the street

## R1 — bodies

**The complaint:** better "person lying on the floor" sprite(s).

**Scope.** Dedicated prone art, replacing the stretch-the-standing-sprite
trick at `renderer.ts:1132-1145`.

Everything else about `drawBody` is good and stays: the blood that runs out
over `BLEED_SEC` in the body's own frame, the hashed pool that guarantees a
corpse discovered a minute later is not on clean tarmac, the drained colour,
and the breathing that distinguishes a casualty on the bleed-out clock (an
ambulance is coming for them) from a corpse (nothing is). That distinction is
load-bearing and is currently carried by an alpha value and a colour. It
should be carried by the pose.

**New sprites** in `shared/data/sprites.json`, all at the existing 29×29,
pivot-centred, `rotations: 32`, single frame:

| Sprite | Pose | Used for |
|---|---|---|
| `pedDead` ×3 poses | face-down splayed / curled on one side / on the back, arms out | `PedMode.dead`, chosen by `hash(id) % 3` |
| `pedDowned` | on one side, one knee drawn up, one arm across | `PedMode.downed` — the bleed-out clock |
| `playerDead` ×2 poses | as above, carrying the `shirt` variant axis | a dead player before respawn |
| `copDead` | face-down, cap displaced | `copIsDown` |

The `shirt` variant axis carries over unchanged, so peds and players keep
their existing colour variety for free (6 shirts × 3 poses = 18 ped frames).
Poses are hashed off the entity id, so a given body has the same pose on
every client and for as long as it lies there.

**Why this is a day's work and not a week's.** `sprites.json` is declarative
— rects, ellipses, discs, a `z` for the lighting relief, an optional noise
term — and the generator (`server/src/tools/sprites.ts`) does the lighting,
the outline and the sheet packing. A prone figure is 8–12 shapes. The
renderer change is deleting the `BODY_LONG`/`BODY_WIDE` scale block and
asking for a different sprite name.

**Files.** `shared/data/sprites.json`, `client/src/render/renderer.ts`
(`drawBody` and its three call sites), regenerate with `pnpm sprites`.

**Bandwidth.** None — the sheet is a static asset, +~20 KB on a 68 KB PNG,
fetched once.

**Effort S. Risk L.**

**Gate.** `pnpm sprites -- --preview=8 --only=pedDead` contact sheet
eyeballed at 8×; a `client/test/` case asserting every `PedMode` and cop
down-state maps to a sprite that exists in the sheet (the same shape as the
existing `vehicleSprite.test.ts` gate, which is the test that already catches
"a boat drawn as a car"); refreshed `evidence/street-blood-*.png`.

---

## R2 — two wheels, and more bodywork

**The complaint:** more car variation, bicycles, motorcycles.

### R2a — more bodywork

Vehicle kinds are strings end to end — `createVehicle` takes one
(`state.ts:524`), the codec writes it as a string (`binary.ts:433`), and the
renderer maps it to a sprite. **A new vehicle kind costs no protocol change
at all.** Six new civilian bodies, each with its own silhouette, its own
`halfLength`/`halfWidth`/`mass`/`handling`, and all sharing the existing
10-colour `body` variant axis:

| Kind | Character |
|---|---|
| `coupe` | short, quick, twitchy |
| `estate` | long, heavy, understeers |
| `pickup` | tall, slow to turn, shrugs off shunts |
| `sports` | fastest civilian car, fragile |
| `hatch` | small, cheap, the default of the default |
| `muscle` | fast in a straight line, terrible turn rate |

Six sprites × 10 colours = 60 visual cars for six sprite definitions. They
join `traffic.json`'s `mix` with weights, and `car`'s weight of 50 comes
down to make room — a street where half the cars are the same shape is the
thing being fixed.

Worth doing at the same time, because it is nearly free: the mix is global
today, and `districtAt` is a lookup. A `districtMix` override (`sports` and
`limo` weighted up downtown, `pickup` and `truck` up in industrial) makes the
districts read differently from the driver's seat, which is the only place
most players ever see them from.

### R2b — motorcycles

A motorcycle is not a small car; three things make it a different verb, and
two of them are new sim rules.

- **Geometry and handling** (data): `halfLength 7`, `halfWidth 2.5`,
  `mass 0.25`, `maxSpeed` above every car, `turnRate` roughly double,
  `health` ~70. Filtering between stopped traffic falls out of the existing
  half-extent collision for free.
- **You come off it** (new, `sim/vehicleDamage.ts` + `sim/bodies.ts`): a
  collision above `ejectSpeed` throws the rider — `driverId = null`, the
  player placed at the bike's nose with the impact's velocity, stunned for
  `ejectStunTicks` via the existing `stunPlayer` (`weapons.ts:434`). This is
  the risk that makes the speed a decision.
- **The rider is visible** (renderer): the bike sprite plus the rider's own
  sprite composited at a seat offset, rotated with the bike. The renderer
  already composites a turret over a hull at a tuned offset
  (`renderer.ts` `drawTurret`, `vehicles.json` `turretOffset`), so this is
  the same mechanism with a `riderOffset`.

Kinds: `moto` (civilian), `copbike` (a P3 wave composition that can filter
through the traffic jam it caused).

### R2c — bicycles

The same chassis with no engine, and one rule that makes it worth having:

- `accel` low, `maxSpeed` ~110 — above walking (78), below every car.
- **Stealing one is not grand theft auto.** `heatPerTheft` becomes
  per-kind-scalable (a `theftHeat` multiplier on the vehicle tuning, read at
  `sim/vehicle.ts:541`), and a bicycle's is 0. That single number is what
  makes a bike a distinct tool — the quiet way to cross three blocks while
  the cool-down clock from P1 runs down — rather than a slow car.
- Bicycles in the traffic mix at a low weight. The traffic AI drives kinds
  generically, so a civilian on a bike is free content.

**Files.** `shared/data/vehicles.json`, `shared/data/traffic.json`,
`shared/data/sprites.json`, `shared/src/sim/vehicle.ts` (theft scaling),
`shared/src/sim/vehicleDamage.ts` (ejection), `client/src/render/renderer.ts`
(`vehicleSpriteName`, rider compositing), `shared/src/tuning.ts`.

**Determinism.** Ejection is a threshold test on a collision the sim already
computes; no new rng.

**Bandwidth.** Zero. Kind is already a string on the wire, and no new fields.

**Effort M** (R2a is S on its own; the two-wheelers are the M). **Risk L.**

**Gate.** `client/test/vehicleSprite.test.ts` already asserts every kind in
the parsed tuning has a sprite — it will fail until the art exists, which is
the gate working as designed. New `shared/test/vehicle.test.ts` cases: a
motorcycle above `ejectSpeed` ejects and stuns its rider and one below does
not; a bicycle theft adds no heat and a car theft still does.
`pnpm bots --script=joyride` for stability.

---

## R3 — every vehicle kind has a home

**The requirement:** every type of vehicle can be found somewhere in the
world.

**What is true today.** Nominally every kind is reachable; practically most
are not.

| Source | Kinds it supplies |
|---|---|
| `PARKED_CYCLE` (`amenities.ts:568`) | `car`, `van`, `taxi`, `truck` — and only these four |
| `traffic.json` `mix` | 11 kinds, but weighted: `digger` is **1 in 100**, `icecream` 2, `firetruck` 3 |
| `boatSpawns` / moorings | `boat` |
| `placeTank` (`amenities.ts:575`) | `tank` — exactly one, behind the first police station |
| police spawns / `markGangCars` | `copcar`, `gangcar` |

So a digger is a 1-in-100 roll on a traffic spawn that despawns at 1100 px:
"findable" in the sense that a lottery ticket is winnable. And R2 makes it
worse before it makes it better — six new bodies, two two-wheelers and (with
S2) two aircraft, all competing for the same weighted roll.

**The rule this item makes true, and tests:** *every kind in `vehicles.json`
is either common in the traffic mix, or has at least one fixed, findable
home on the map.* Not a lottery — a place you can drive to.

### R3a — vehicle homes as worldgen data

`CityMap` gains `vehicleHomes: VehicleSpawn[]`, a list **separate from**
`parkingSpots`, for two reasons that are both bugs waiting to happen:

- `session.ts:168` strides `parkingSpots` by `length / MAX_VEHICLES` and
  keeps roughly one spot in six. `placeTank` already had to be special-cased
  back in at `session.ts:171-173` because of it. Homes must never be sampled
  away, and generalising that special case is exactly what this list is.
- `markGangCars` (`turf.ts:116`) overwrites the kind of every seventh
  parking spot with `gangcar`. A fire station whose engine turned into a gang
  car one seed in seven is not a home.

Placement runs after landmarks, keyed off what the city already generates,
driven by a `vehicleHomes` block in `worldgen.json` so the roster is data:

| Kind | Home | Anchor that already exists |
|---|---|---|
| `ambulance` | hospital forecourt | `landmarks` kind `hospital` |
| `copcar` | station yard | `landmarks` kind `police` |
| `tank` | station yard, one per city | `placeTank`, folded into this |
| `firetruck` | fire station | new: an industrial/commercial block, lattice-placed |
| `bus` | depot bay | largest `T_LOT` in a commercial block |
| `garbage`, `truck`, `van` | industrial yard | `T_LOT` in an industrial district |
| `digger` | building site | `T_LOT` in industrial, adjacent to a building |
| `limo` | tower forecourt | `landmarks` kind `tower` |
| `taxi` | rank | stadium and downtown arterial kerbs |
| `icecream` | park edge | `T_PARK` boundary |
| `boat` | moorings | `boatSpawns` (already) |
| `moto`, `bicycle` | racks, everywhere | kerbside; also in `PARKED_CYCLE` |
| `plane`, `heli` | airstrip apron, helipad | S2 |

### R3b — the mix stops carrying kinds it cannot carry

With homes in place, `traffic.json`'s `mix` goes back to being what it is
good at — the *common* stock — and the specialist vehicles come off it or
drop to a garnish weight. A firetruck belongs at a fire station and
occasionally on a call, not as 3 % of all traffic.

### R3c — the minimap knows

A home you cannot find is not a home. Landmark-anchored homes get a small
icon on the minimap at the same tier as shops (`minimap.ts:185-200` already
draws shop kinds in distinct colours), so "where is a bus" has an answer that
does not involve driving in circles.

**Files.** `shared/src/world/types.ts` (`vehicleHomes`), `shared/src/world/amenities.ts`
(placement; absorbs `placeTank`), `shared/src/world/generate.ts`,
`shared/data/worldgen.json`, `shared/data/traffic.json`,
`server/src/session.ts` (spawn homes unconditionally, drop the tank
special-case), `shared/src/world/turf.ts` (leave homes alone),
`client/src/render/minimap.ts`.

**Determinism.** Placement is derived from tiles and landmarks with no rng
draw of its own, exactly as `placeParking` is, so no seed's city changes
shape because a home was added.

**Bandwidth.** Zero — the map is generated on both ends, never transmitted.

**Effort M. Risk L.**

**Gate.** The important one is a **completeness test**, not a spot check:
enumerate `getTuning().vehicles`, and for every kind assert it is either
weighted ≥ 5 in the traffic mix or has ≥ 1 entry in `map.vehicleHomes`, over
several seeds. That test is the requirement, written down. Plus: homes are on
drivable ground, homes survive `session.ts`'s stride, and `markGangCars`
never rewrites one.

---

# Wave S — the sky

## S1 — the helicopter

**The complaint** (first half of item 7): helicopter, and the military at
five stars.

**Scope.** A police helicopter as a **cop unit**, not a vehicle. It is by far
the cheaper half of "things that fly", it needs no new medium and no altitude
on the wire, and it is the unit that makes P1's escape interesting rather
than automatic.

A `heli` entry in `police.json`'s `kinds`, spawned by a P3 wave from
`heliFromStar` (3). What makes it different from an officer:

- **It ignores the ground.** Skip `moveWithCollision` and
  `pushOutOfVehicles` for this kind; it flies straight at its target at
  `moveSpeed`.
- **It sees.** A much larger `sightRange`, and — this is the whole point —
  it is what holds P1's cool-down clock open. At three stars and up, breaking
  line of sight means breaking it from the *air*: a tunnel, a bridge
  underside, a multi-storey, or shooting the thing down.
- **It lights.** A searchlight cone. `lighting.ts` already draws cones with
  cast shadows (`drawCone`), so this is a call, not a feature.
- **It can be shot down.** It is a `CopState`; `damageCop`, `copIsDown` and
  the corpse timer all apply. A downed helicopter should leave a burning
  wreck — reuse the vehicle explosion path with a one-off `heliWreck` prop.
- **It does not arrest.** `tryBust` skips it.

Because it is a cop and not a vehicle, it costs **nothing new on the wire**:
`CopState` already carries a `kind` string, a position and a velocity.

**Files.** `shared/src/sim/police.ts`, `shared/data/police.json`,
`shared/data/sprites.json` (a rotor-blur sprite, two frames),
`client/src/render/renderer.ts` (draw above everything, big shadow offset —
`drawShadow` at `renderer.ts:276` already takes a height),
`client/src/render/lighting.ts` (the searchlight).

**Determinism.** Straight-line steering on sim state. No new rng.

**Bandwidth.** ~40 B/s while one is up.

**Effort M. Risk M** — the risk is that a unit which cannot be escaped by
driving makes P1 pointless at 3+ stars. Mitigation: `heliFromStar` is a
tunable, the searchlight has a finite radius, and the helicopter loses you on
the same `searchGiveUpTicks` clock as everybody else.

**Gate.** `shared/test/police.test.ts`: a heli ignores walls in its pathing
but still obeys line of sight for `lastSeenTick`; shooting it down clears it
from the pursuit; it never busts. Evidence: a night PNG of the searchlight
over a street.

## S2 — the airstrip, and something to fly

**Scope.** The largest single item in this document, and the only one that
adds a field to `VehicleState`.

**The airstrip.** A new `LandmarkKind: 'airstrip'` (`world/types.ts:79`).
Landmarks are stamped inside city blocks (`world/amenities.ts:752-845`), so
the question is whether a runway fits. Measured across seeds 1, 7 and 42:
blocks reach **29–32 tiles** on their long axis, with several ≥ 24 in every
seed. A **26 × 7** runway (416 × 112 px) fits inside a 28 × 9 block, which
exists in all three. So it fits — but only in the largest blocks, and those
are usually `park` or `industrial`, which is where an airstrip belongs
anyway.

Placement uses the **coverage lattice**, not the flavour roll: one per
`4 × 4` cells, which at `arterialSpacing: 60` is roughly one per city window.
A rolled airstrip would sometimes give a city two and sometimes none, and
"there is an airstrip, and it is over there" is a fact a player should be
able to rely on. It needs a new tile type (`T_RUNWAY`) so the renderer can
paint centreline and threshold markings and so the sim can answer "am I on a
runway".

**The aircraft.** `VehicleState` gains `z: number` (q8, 0 for everything on
the ground) and `vehicles.json` gains `medium: "air"` alongside the existing
`"water"`:

- Below `flightZ`, an aircraft is an ordinary vehicle: it collides with
  tiles, cars and people, and it needs `takeoffSpeed` **on a runway tile** to
  climb.
- Above `flightZ`, tile and vehicle collision are skipped. The city is drawn
  under it; its shadow offsets by `z` through the existing height parameter
  in `drawShadow`.
- Landing needs low speed and descending; touching down anywhere that is not
  flat is a crash, which is the existing explosion path.
- A **helicopter** is the same vehicle with `takeoffSpeed: 0` — vertical, no
  runway, and therefore a rooftop or a helipad rather than the airstrip.

The `z` field is per-field diffed like every other, so it costs nothing for
the 99 % of vehicles sitting on the tarmac.

**Files.** `shared/src/world/types.ts`, `shared/src/world/amenities.ts`,
`shared/src/world/generate.ts`, `shared/data/worldgen.json`,
`shared/src/sim/state.ts`, `shared/src/sim/vehicle.ts`,
`shared/src/net/binary.ts` + `snapshot.ts`, `shared/data/vehicles.json`,
`shared/data/sprites.json`, `client/src/render/tiles.ts` (runway paint),
`client/src/render/renderer.ts` (altitude scaling and shadow),
`client/src/render/minimap.ts`, `shared/src/constants.ts` (protocol bump).

**Determinism.** Worldgen is a pure function of (seed, params) regenerated
identically on both ends, so a new landmark kind is free of wire cost and
changes the city for a given seed — expected, and `shared/test/world.test.ts`
and `landmarks.test.ts` are the gates.

**Bandwidth.** One q8 per airborne vehicle. Effectively zero.

**Effort L. Risk M** — the risk is that flight over a city built entirely
around ground collision exposes edges everywhere (interest management,
camera clamping at `computeCamera`'s map-edge clamp, the minimap, the
lighting's occluder set). Mitigation: a low ceiling on `flightZ`, and the
proving ground (`PROVING_GROUND=1`) as the test bench — it exists for exactly
this.

**Gate.** `shared/test/world.test.ts`: exactly one airstrip per window, on
runway tiles, reachable by road, identical across regenerations of a seed.
New `shared/test/flight.test.ts`: below `flightZ` an aircraft collides,
above it does not; takeoff requires runway and speed; landing off-airfield
destroys it. `pnpm mapgen --seed=7` PNG showing the strip.

### S2 as built: the landing, and how it was missed

Asked "can the player fly?", the first honest answer was **yes, one way**.
Taking off worked through the ordinary input path — E into a chopper, W to
climb, cruise height, flying over the city. Coming back down did not, and
both gaps had the same root: the altitude logic sat inside `driveVehicle`,
which only runs when somebody is at the controls.

- **Stepping out mid-air teleported you to the ground.** You went from
  `driving` at altitude 48 to `foot` at altitude 0 in one tick: no fall, no
  damage, no transition — which made bailing out the cheapest way to end a
  flight and made altitude mean nothing.
- **An abandoned aircraft hovered for ever.** `stepVehicleCoasting` — the
  path a driverless vehicle takes — called `integrateVehicle` directly and
  never reached `stepAltitude`, so a chopper you got out of sat at cruise
  height with zero speed, permanently.

**Both are fixed.** `stepAltitude` moved to the top of `integrateVehicle`,
above its own early return, so every vehicle falls whether or not anybody is
flying it; `tryExitVehicle` hands the player the vehicle's altitude on the
way out; and `stepStunts` stopped pinning on-foot players to the ground, so
the jump physics that already existed for ramps bring them down and bill
them for the landing.

Three things the fix turned up that the plan did not anticipate:

- **The drop and the airspeed billed separately for the same jump.** Fall
  damage plus `tryExitVehicle`'s existing bail-out penalty left a
  full-health player on 3 — nominally survivable, functionally a death. Road
  rash is the ground taking your speed off you and there is no ground at
  cruise height, so the tumble penalty is now suppressed while `z > 0`. A
  bail-out costs about two thirds of your health, which is the number the
  constant's comment always claimed.
- **A fall nobody can see is not a fall.** The renderer pinned every on-foot
  sprite to the ground, so a quarter-second drop read as standing still and
  then bleeding for no reason. `drawPlayer` now lifts by `z` and leaves the
  shadow where it belongs — the same trick the air units use. `z` was
  already in the snapshot's player field list, so remote players fall too.
- **Exiting is edge-triggered.** Two tests failed on a held `action` key
  counting as one press; the fix is a released tick between entering and
  leaving, which is also what a player's hands do.

Worth recording how the originals were found, because it generalises: the
flight tests called `driveVehicle` directly, so neither bug was visible to
them. The replacement tests drive `step()` with real inputs — the same entry
point the feature has — and would have caught both on the first run.
`evidence/fall.png` photographs the arc through the real renderer.

## S3 — the military at five stars

**Scope.** Small, once P3 and S1 exist — it is a wave composition and two
behaviours.

- **They arrive in armour.** P3b's per-kind `vehicle` lets an `army` wave
  arrive in `tank`, which already exists as a vehicle kind, already drives
  over cars, and already has a turret. This is the escalation `police.json`'s
  `tiers` has been promising since it was written.
- **Roadblocks change.** `maybeRoadblock` (`police.ts:458`) hard-codes two
  `copcar`s; it gains a per-star vehicle from the wave table, so a five-star
  roadblock is armour across the street.
- **The helicopter becomes a gunship.** The same `heli` unit with
  `copRifle` in place of the observation role.
- **`maxCopCars`** gains a per-kind budget so the city cannot end up with six
  tanks in it.

**Effort M** (given P3 and S1). **Risk M** — the risk is that five stars
becomes unsurvivable again, undoing P2. Mitigation: five stars *should* be
close to unsurvivable; what P1 guarantees is that it is escapable, and that
is the property the gate tests.

**Gate.** `shared/test/police.test.ts`: a level-6 wave contains armour and
respects the per-kind car budget. The `flee` bot script at 5 stars: escape
rate must be > 0 and survival-while-fighting must be short. Both.

---

## 9. Wire cost, totalled

| Item | Fields | Estimate |
|---|---|---|
| P1 | 3 on `CopState`, 1 on `PlayerState` | < 100 B/s |
| P2 | 1 counter on `CopState` | < 20 B/s |
| P3 | 1 on `PlayerState` | < 5 B/s |
| R1 | none (static asset) | 0 |
| R2 | none (kinds are already strings) | 0 |
| R3 | none (the map is generated, never sent) | 0 |
| S1 | none (a cop is already on the wire) | ~40 B/s |
| S2 | 1 q8 on `VehicleState` | < 10 B/s |
| S3 | none | 0 |

**Total ≈ 0.2 KB/s** against ~10.5 KB/s measured today and a 50 KB/s gate.
Bandwidth is not a constraint on any item in this plan; the sprite sheet
growing from 68 KB to ~110 KB is the largest asset change, fetched once.

**Protocol versions.** One bump, **9**, covering the tuning keys P1/P2/P3
add and `VehicleState.z` from S2 — the tuning payload is part of the wire
contract here, so a key added to it is a version change. Folding them into
one bump rather than burning one each is deliberate; `constants.ts` keeps a
changelog against the number. It invalidates replays recorded before it,
which is normal.

---

## 10. What this document declines

- **A client-selectable difficulty.** P2e is server-side. In a shared world,
  a difficulty setting each player chooses is not a setting, it is a cheat.
- **A rotating camera.** Costed in full and dropped on the owner's call. The
  costing is worth keeping, because it is the reason it was ever a hard call:
  the *rendering* half is cheaper than it looks — sprites already bake 32
  rotation steps and cache them (`sprites.ts:91-139`), so a car at heading θ
  under a camera at φ is the same cached blit as a car at θ+φ, and only the
  ground chunks would need a rotated transform. The *input* half is what
  makes it expensive: on-foot movement is four booleans read as screen axes
  (`sim/player.ts:67-68`), four booleans name eight directions, and at a
  camera angle of 37° "forward" would walk you at 45°. There is no version
  of this that keeps the wire as it is. Anyone reviving it should start from
  the intent shape, not the renderer.
- **Aim-relative movement**, again. `sim/player.ts:47-59` already tried it
  and wrote down why it was worse. Recorded here because it is the trap that
  looks like a cheap version of the camera item and is not.
- **Flyable aircraft before S2's groundwork.** A helicopter that is a cop
  (S1) needs no altitude on the wire. One that a player flies needs `z`,
  interest management, camera clamps and a landing model. They are two
  different items and running them together is how the second one takes a
  month.
- **Witness-gated heat.** Rejected once already, on the record
  (`sim/weapons.ts:264-270`), and P1 removes the reason anybody would want it:
  the escape valve is the cool-down, not a hole in the crime detection.

---

## 11. If only three items get built

**P1, P2, R1** — in that order.

P1 is the bug. P2 is the tuning that P1 makes safe to apply. R1 is a day's
sprite data for the most-looked-at object in the game after the player's own
car. That trio turns the two complaints that are actually about the game
being *unplayable* into a game.
