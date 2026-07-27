# PROGRESS

## Wider side streets

A two-tile secondary road is 32 px and a car's collision box is 18, so two
cars could not pass each other on any side street in the city: every parked
car plugged its road, every meeting was a standoff, and about half of all
ambient traffic was stationary in a busy neighbourhood however the parking was
arranged. `secondaryWidth` is 3. Over six seeds with a crowd and 48 parked
cars, traffic under way goes 57.5% -> 66.8%, and the worst neighbourhood 44%
-> 54% — the point being not the average but that a bad draw is no longer a
car park. Block sizes grow to match, so the asphalt comes out of the road grid
rather than the buildings.

Two knock-on fixes: a cruiser now gets out and walks when the fugitive is
close but behind a wall (wider roads gave pursuit cars room to circle a block
for ever, never near enough to dismount and never blocked enough to give up),
and `openWater` joins `roadLane`/`clearSpot` in the test helpers, because the
boat test assumed the first mooring on the map pointed down the river.

## Deployment: reaching the right server, and not serving stale sprites

Found by running the container path locally — built client, served by the game
server, WebSocket on the same port. `serverUrl()` used the page's origin only
on https, so a built client served over plain http fell back to
`ws://<host>:8080`: wrong for every `docker compose up` on any other port. It
keys off `import.meta.env.DEV` now. And the static server sent no cache headers
at all, so a browser could hold the old `sprites.png` against the new
`sprites.meta.json` and draw every sprite from the wrong coordinates — the game
comes up corrupt for one person after a deploy that was otherwise fine. Fixed
names are `no-cache`; only the content-hashed bundles are immutable.

## Drive-bys, kerbside parking, impacts you can see, and rubber on the road

**Drive-by shooting.** `stepWeapons` gated firing on `mode !== 'foot'`, which
was the right call when there was nothing to shoot at from a moving car and is
not any more. A driver can now fire anything but their fists, the muzzle sits
outside the car's own body (otherwise every drive-by put its first round into
the door it came through, since the ray starts at the car's centre), the
shooter's own car is excluded from the ray, and firing one-handed across a
moving car costs accuracy in proportion to speed.

**Traffic brakes for people.** Drivers now stop for pedestrians, players and
officers on foot — but only inside the distance they can actually stop in,
which is a much shorter probe than the one they use for cars. Standing in the
road holds traffic up; stepping off the kerb in front of a moving car still
gets you run over. A driver waiting for somebody to cross gets three times the
patience of one nosed into a wall, because people move on their own and a car
reversing away from a pedestrian looks deranged. Pedestrians now also scatter
from a car that is right on top of them at any speed, not just from one doing
140+, so a stopped car moves them along instead of waiting forever.

**Run-over feedback.** A non-fatal car strike emitted nothing at all: the
victim's HUD flashed red and that was the entire outward sign. There is now a
`runOver` event carrying the point, the car's line and its speed, and the
client throws blood along it and plays a thud (synthesised from
`audio.json` like everything else).

**Parked cars.** Three separate problems, one of them embarrassing:
- The session took the first N of a row-major list, so every parked car in the
  city was in the map's top-left corner — jamming those few streets solid and
  leaving the rest of the city bare. They are sampled across the whole list
  now.
- They sat in the middle of the carriageway. `map.parkingSpots` is a new list,
  separate from the kerbside spawn points that cops, roadblocks and ambient
  traffic are drawn from (those must not move), with cars flush against the
  kerb where the road is wide enough to pass and half up on the pavement where
  it is not — a car is 18 px and a lane is 16.
- Traffic modelled one lane per direction, so a car parked on a four-tile
  arterial pushed everything on that side into the oncoming half, where it met
  the traffic coming the other way and both stopped. Wide roads now have two
  lanes each way and a driver takes the first that is free, with the oncoming
  half as a last resort.

**Brake marks.** `Effects.skid` was written complete and never called until
cornering brought it to life; braking is the other half, and the one you see
most, because every car in the city brakes. Marks go down under hard
deceleration (300 px/s²: the pedal, not lifting off) — four wheels locked,
against two under a slide — and a crash is excluded, because a rebound off a
wall is not a brake mark.

## Police pursuit driving

The cruisers were the last vehicles in the game driving badly. The pursuit
controller held full throttle whenever it was under `copCarSpeed` and steered
bang-bang with a 0.06 rad deadband, straight at the target whatever stood
between them. Three consequences: a cruiser that arrived facing the wrong way
drove a circle the width of a block instead of turning round; one nosed into a
wall sat there bouncing off it; and one with a building between it and the
fugitive drove into that building. All three ended at the bail-out, which took
the officer's car away. Measured over a four-star chase: **all six** motorised
officers abandoned their cars within ~20 ticks of getting them — the motorised
response was an on-foot posse that spawned litter.

Now: proportional steering on the shared `driveVehicle`, corner speeds by
heading error, a tight U-turn at walking pace when pointing the wrong way (the
turn radius is speed/turnRate, so 40 px/s comes round inside a two-tile street
where 300 px/s cannot), a bounded reverse to back out of whatever it is wedged
in, and — when the straight line runs through a building — a greedy road-grid
detour instead of a wall. The bail-out survives as the last resort it was meant
to be, and now distinguishes wedged (counts fast) from driving-but-not-gaining
(counts slowly), so an honest detour round a block no longer costs an officer
their car. Same four-star chase: cruisers stay in the chase, and the officers
who do end up on foot are mostly the ones who deliberately pulled up inside
`dismountDist`.

`CARDINALS`/`dirIsOpen`/`nearestCardinal` moved to `sim/roadgrid.ts`, shared by
traffic and pursuit — both AIs navigate by probing the tile grid, and only the
lane discipline differs.

## Play-test fixes — facing, traffic, impacts, fists, shop interiors

Five things reported from actually playing it.

**The avatar did not face the way it ran.** The sim only knows `aimAngle` —
the mouse — and the sprite was drawn at it, so running north with the pointer
east read as a crab walk. On foot the body now turns to the direction of
travel, eased at a fixed rate per second; aim wins while standing still and
while shooting, and the aim tick still shows the firing line. Presentation
only: the sim still shoots along `aimAngle`.

**Ambient traffic was broken three separate ways.** (1) Lane keeping aimed at
the centre of the *tile* a car stood on rather than at a side of the
carriageway, so on any road wider than one tile — all of them — oncoming cars
shared a lane; its deadband (`laneHalfWidth`, 14 px) was also nearly a tile
wide, so it never engaged at all. Drivers now measure the road across their
direction of travel and pure-pursue the centre of its right-hand half with a
proportional wheel. (2) A junction turn assigned `heading += ±90°` outright,
teleporting the car sideways; turns are steered now, slowing to `turnSpeed`
for the corner — a key that had sat in the tuning file with nothing reading
it. (3) "Blocked" held the brake down, and past a standstill the brake is
reverse, so anything stuck behind a parked car reversed away down the street;
blocked now brakes and holds, and reverse is a bounded recovery shunt. Falling
out of the measurement work: the obstacle probe treated kerbs and grass as
walls (only buildings, water and cars are solid), overtaking so a parked car
is not a permanent roadblock, bridges counting as road, and a car that has
wandered off the carriageway steering back onto it. Over 5 seeds: 84% of cars
under way (was 23%), 91% on the correct side (was a coin toss), 2.3% off the
road (was 45%). Driver intent lives in `state.trafficDrivers` — no client
simulates traffic, so it stays off the wire and out of the desync hash.

**Cars could not hit anybody.** The run-over threshold was 130 px/s and
ambient traffic cruises at 104, so every NPC car in the city drove through
players, pedestrians and officers untouched; the only vehicle that could run
anyone over was one a player was flooring. 40 px/s now, damage scaling with
speed, and a hit throws you along the car's line instead of only denting your
health.

**Fists fired bullets.** A melee swing is reported as a `shot` event and the
client drew every `shot` the same way: muzzle flash, spark cone, ricochet and
a bullet hole in the tarmac. The avatar also held a pistol whatever was
selected. Two new sprite families (`playerFist`, `playerPunch`) and a melee
effect keyed off `weapons.*.melee`, so any future melee weapon behaves the
same way.

**Shops had no inside.** Buying happened through a closed wall — the shop was
an awning on the pavement and a menu that opened when you stood near it. The
generator now hollows the building out: a one-tile wall ring, a room of
walkable `T_FLOOR` behind it, and a doorway punched through the shopfront
(two tiles wide for a respray, because a car is wider than one tile). The roof
simply is not drawn over floor tiles, so the room reads as a cutaway from
above with no second render pass and no per-building height. Counter along the
back wall, shelves down the sides, a marked-out bay for a garage; the server
serves you anywhere inside the room, not only in the doorway.

## Waves A2–E1 — the roadmap, delivered

Everything in `ROADMAP.md` after the A1 fixes. Each wave was committed and
gated separately; this is the combined log.

**A2 — the world stops being consume-only.** Peds were removed permanently
and props stayed broken for the session, so a long game monotonically
stripped the city. Props now carry `respawnAtTick` and a `stepProps` stage
repairs them once nobody is within `respawnMinDistFromPlayer`. Ped top-ups
live in the session rather than `step()`, because the decision needs to know
where clients are looking, which is server knowledge.

**A3 — fists, armour, pickups.** The only way to raise health in the whole
game was to die, which made fleeing pointless and turned the 3 s respawn into
the cheapest medkit on the map. Fists are a melee weapon with `infiniteAmmo`
that survives death, so an unarmed player always has a verb. Pickups are a new
entity table with fixed worldgen positions, so only `active`/`respawnAtTick`
ever move on the wire. Armour soaks damage before health.

**A4 — minimap, camera lead, HUD.** The client already regenerates the
identical `CityMap`, so a radar costs nothing on the wire: the city bakes once
into an offscreen canvas and each frame blits a clamped window of it. The
camera leads towards travel — at 330 px/s a car crossed the viewport in
1.45 s, so the driver was permanently steering into the blind half of the
screen.

**A5 — procedural audio.** Synthesised at runtime from `shared/data/audio.json`;
no binary assets, matching how the sprite sheet is already generated from a
JSON shape description. Headless-safe by construction.

**B — binary wire codec.** The enabler. Measured 42.6 → **9.2 KB/s** inbound
(4.6×) and 5.4 → 0.34 KB/s outbound (16×). Only `snapshot`/`full`/`input` are
binary; everything else stays JSON behind a tag byte.

**C1 — vehicle damage and explosions.** `VehicleState` had no health field, so
nothing in a game about driving could destroy a car, and car-vs-car reverted
position and zeroed speed. Now: bullets, collisions and blasts damage cars;
they burn on a fuse and detonate with radius damage; car-vs-car is momentum
transfer.

**C2 — ambient traffic and carjacking.** `traffic.json` had existed from the
start as a complete spec with zero references anywhere. AI drivers are marked
by a negative `driverId`, which makes occupied cars correctly un-enterable and
turns the jack into an explicit action — the verb the genre is named after,
previously impossible to express because no vehicle had an occupant.

**C3 — police vehicles, roadblocks, Pay'n'Spray.** The review's top finding:
cops at 122 px/s against a player car at 330, with no vehicles, so any car was
a guaranteed escape. Escalation now changes kind — foot posse, then cruisers
at three stars, then roadblocks at four — and a respray garage clears heat, so
losing the cops is a play rather than a stopwatch.

**D1 — water, bridges, boats.** Collision became medium-aware, which was the
roadmap's flagged risk since it runs inside prediction; it went in alone with
tests before any content. The river is carved before the roads, and only
arterials bridge it, so it stays a chokepoint.

**D2 — landmarks, hospitals, park interiors.** Named oversized structures to
navigate by, and the dead now wake at the *nearest hospital* instead of a
uniformly-random kerbside point three districts away.

**E1 — frenzies, stunts, score.** Kill frenzies reuse the pickup table with a
clock; stunt ramps add the vertical dimension (`z`/`vz`), with airborne
vehicles ignoring tile collision entirely. Payouts and a session leaderboard
run through the economy.

**Verification.** 157 tests green (from 73). `pnpm bots --count=8
--script=brawl --duration=60`: **PASS**, ticks 1811..1811, 0 desyncs, 0 stale,
0 full resyncs, corrections ≤4.4 px, peak **~11 KB/s** per client against the
50 KB/s gate. Replay re-simulates to identical hashes. `persistCheck` passes.
Client typechecks and `vite build` succeeds (88 KB, 31 KB gzipped). Verified
in a real browser throughout via Playwright: 14 AI cars all under way, police
cruisers with light bars, pickups, river, parks and minimap all rendering at
60 fps with no page errors.

**RNG-order note.** Several waves shifted the worldgen and sim rng streams
(cop spawn gating, the spray shop quota, river carving, landmark placement).
**Replays recorded before this work will not re-simulate.** Expected per
`ROADMAP.md` §5 and recorded here so a future desync hunt does not chase it.

**Deliberately deferred.** Missions and a story campaign, gangs/territory/
respect, building interiors, weapon drops on the ground, mobile controls — all
still out of scope per `ROADMAP.md` §6. Also speed-based camera zoom: the tile
layer bakes chunks at a fixed device-pixels-per-tile, so a variable zoom needs
either constant re-baking or a non-integer blit, and camera lead addresses most
of the same complaint.

**Least confident about.** (1) Balance across the board. Wanted-level
lethality, frenzy targets, stunt payouts, traffic density and explosion radius
are all first-pass numbers chosen by reading the model, not by playing. (2)
The police dismount rules (`dismountDist`, the accumulate-and-decay stuck
counter) went through three wrong versions before settling; they are correct
under test but the thresholds are guesses. (3) The bail-out interacts with
vehicle damage in a way I like but did not design: a wedged cruiser rams the
wall until it detonates, killing the officer. It is good emergent behaviour
and it is also not a decision anyone made.

## Wave A1 — correctness fixes from the review

First slice of `ROADMAP.md`, which addresses `REVIEW.md`. Five defects, no
new systems.

**What changed.**

1. **Cops can be run over.** `stepVehicleImpacts` iterated players and peds
   but never cops, so an officer was immune to a car at any speed. Added the
   missing loop in a fixed order (players → cops → peds; never reorder — the
   damage feeds heat, heat feeds cop spawning, and spawning draws rng).
   Run-over damage routes through `damageCop`, so it still raises heat on the
   driver and still emits `copDown`. `CopState` gains `carHitCooldown`,
   mirroring the player field of the same name — without it a car parked on
   an officer lands 30 hits a second. New field is in `COP_FIELDS` and in the
   hash, per the six-touch-point rule.
2. **The fifth star does something.** `desired = min(copsPerStar × wanted,
   maxCopsPerPlayer)` clamped 4 and 5 stars to the same 8 cops, so the top
   tier was a HUD glyph and nothing else. `maxCopsPerPlayer` is now 10
   (= `copsPerStar × 5`), which is the minimum change that makes the tiers
   distinct. This is an interim: the real fix is escalation by *kind* rather
   than count, which arrives with police vehicles (roadmap C3).
3. **Lifting an empty parked car is no longer a crime.** `tryEnterVehicle`
   added heat unconditionally — "witnessed or not" — so seven trips to your
   own parked car earned a star. Heat now applies only when a cop has line of
   sight. Taking an *occupied* car stays a crime, but no vehicle has an
   occupant until NPC drivers land (roadmap C2), where the jack becomes an
   explicit action; that branch is deliberately not written yet rather than
   written unreachable.
4. **Dead tunables.** `police.marineSpeed` had zero references anywhere and
   is deleted. `police.spawnCooldownTicks` was parsed, defaulted and never
   read; it is now wired as the real inter-arrival gate, taken straight off
   the tick counter (`state.tick % spawnCooldownTicks`) so it needs no state
   of its own, and checked before any rng draw so the stream stays fixed.
   Also folded the duplicated line-of-sight scan in `stepPolice` into a
   shared `anyCopSees`.
5. **Skid marks reach the screen.** `Effects.skid()` was fully implemented
   and called from nowhere. `drawVehicle` now lays rubber under both rear
   wheels when a vehicle is above 170 px/s and yawing faster than 1.9 rad/s,
   emitted on a 45 ms wall-clock cadence so a 240 Hz display does not lay
   four times the rubber of a 60 Hz one.

**Verification.** 77 tests green (up from 73). New coverage: empty-car theft
unseen costs no heat; the same theft under a cop's nose does; a speeding car
damages an officer, respects the immunity window, and eventually kills them
with a `copDown` event; a second cop cannot reach the street sooner than
`spawnCooldownTicks`; the five-star posse outnumbers the four-star one.
`pnpm bots --count=8 --script=brawl --duration=60`: **PASS**, ticks
1809..1809, 0 desyncs, 0 stale, 0 full resyncs, corrections ≤4.42 px, peak
**38.0 KB/s** per client against the 50 KB/s gate. Recorded replay
re-simulated twice to the identical final hash (`8e632cf`). Client
typechecks.

**RNG-order note.** Gating cop spawns on `spawnCooldownTicks` changes when
`maybeSpawnCop` draws, so the rng stream diverges from pre-A1 builds:
**replays recorded before this change will not re-simulate.** Expected and
accepted per `ROADMAP.md` §5; recorded here so a future desync hunt does not
chase it as a ghost.

**Deliberately deferred.** Everything else in `ROADMAP.md`. Specifically not
touched here: the binary codec (Wave B) that the traffic and police-vehicle
work is blocked on, ped/prop respawn (A2), fists and pickups (A3), minimap
and camera (A4), audio (A5). `traffic.json`, the `boat` tuning, the `copcar`
sprite, `worldgen.waterWidth` and the `water`/`sand` palette entries are all
still unreferenced — left in place deliberately, because C2/C3/D1 implement
them; they are pending, not rotting.

**Least confident about.** (1) The cop run-over damage multiplier reuses the
player's 0.12 rather than the pedestrian's 0.2, so an officer survives one
clip at top speed and dies to two. That is a guess, not a tuned number, and
it interacts with the 5-star lethality below. (2) Raising `maxCopsPerPlayer`
to 10 makes a five-star chase *more* lethal — 10 cops at 17.5 DPS is 175 DPS,
so a full-health player dies in ~0.57 s, worse than the 0.71 s the review
already flagged. That is the honest interim consequence of making the tier
distinct, and it should not ship to players before A3's armour and pickups
land. (3) The skid thresholds were picked by reading the steering model
(peak authority is 2.8 rad/s), not by watching a car corner — they want a
human eye before they are trusted.

## Fix — `Unknown builtin module: node:sqlite`

**What changed.** The SQLite backend assumed `node:sqlite` is a guaranteed
builtin. It is not: it is absent before Node 22.5, flagged behind
`--experimental-sqlite` on 22.5–22.12, and compiled out of some distro
builds — all of which throw `Unknown builtin module: node:sqlite`. Because
the import sat at module scope in `sqliteStore.ts`, that throw happened at
load time and killed server startup outright, before any fallback could
run, and even when `PERSIST_PATH` pointed at a `.json` file that never
wanted SQLite. The module is now required lazily (`createRequire`, so the
store stays synchronous) on first `SqliteStore` construction, and
`createStore` degrades to the JSON `FileStore` at the sibling `.json` path
with a warning naming the Node requirement rather than refusing to boot.
The warning is loud because the save file changes: an existing `.db` is not
read by the file store.

Also fixed: `.gitignore` had an unanchored `data/`, which matched
`shared/data/` as well as the runtime persistence dir and silently kept the
gameplay tunables out of the repo. It is now anchored to `/data/` and
`server/data/`.

**Verification.** `createStore.test.ts` covers backend selection on
whichever Node runs the suite; `persistFallback.test.ts` mocks the module
away to exercise the no-SQLite path everywhere (fallback store registers an
account, appends, rejects a duplicate ref, and reloads from disk). The real
failure was reproduced end-to-end against the built `dist/` with
`node:sqlite` blocked at `Module._load`: the store falls back, persists,
and reloads. `tsc -b server` clean.

## Phase 8 — destructible props

**What changed.** Lamp posts, bins, and fences as sim entities with exactly
one transition: intact → broken. No rigid bodies, no debris simulation —
per the brief, networked rigid-body destruction is a trap and we did not
walk into it. Worldgen places ~400 pieces of street furniture
deterministically (lamps on kerbs, bins against walls, fences along park
edges, orientation-aware); the session spawns them as recorded commands.
Bullets hit props (nearest-hit alongside walls/players/cops/peds; a lamp
post will eat your shot) and chip hp; cars at speed smash them outright and
shed a sliver of momentum per prop (a discrete nudge, not a collision
response). Broken props are inert: no ray hits, no re-break, swapped
sprite. Props never block movement — street furniture is small, and keeping
it out of the collision world means prediction, cop pursuit, and ped wander
all stay untouched. `propDown` events flow for future audio/particles.
Because props are static-until-broken, their delta cost is near zero: one
patch row when broken, plus AOI enter/leave rows.

**Verification.** 67 tests green: all three kinds placed, shotgun-vs-bin
transition (breaks, emits propDown, stays broken, never re-hit), speeding
car smashing a lamp with measurable momentum loss, and mass-destruction
determinism (10 props, 120 ticks of spray, identical hashes). Full-sandbox
8-bot brawl — players + 200 peds + ~400 props + police swarm — lockstep,
0 desyncs, ~42 KB/s per client (still under the phase-7 gate). Joyride and
replay checks clean. A tuning round-trip asymmetry (props.json flat shape
vs parsed {kinds} shape in welcome/replay headers) was caught by the replay
test and fixed with a dual-shape parser.

**Deliberately deferred (post-phase-8 backlog per brief).** Missions,
races, leaderboards, audio, mobile controls. Also: prop respawning (broken
stays broken for the session), vehicle destructibility, debris particles.

**Least confident about.** Prop density/placement aesthetics — numbers
chosen by eye on mapgen output, not by walking the streets. Fences not
blocking movement is the most gameplay-visible consequence of the
no-collision choice (you can stroll through a park fence; you just can't
pretend it survived a car). If props must block later, they'll need to
join the prediction context — a deliberate seam, not an accident.

## Phase 7 — pedestrian crowds + interest management

**What changed.** 200 pedestrians per session: sim entities that wander
sidewalks (weighted direction picks that prefer staying on pavement), flee
gunfire, deaths, and speeding cars, and die to bullets and bumpers — killing
one is a crime. NPCs (peds AND cops) move on a staggered 3-tick cadence
(10 Hz with 3× steps — interpolation renders it smooth, sim cost and delta
traffic drop to a third). Interest management: per-client filtered
snapshots — players always included, driven cars ride along, parked cars/
cops/peds only within a 600 px radius — with the delta base being the
filtered snapshot that client acked (per-slot ring), so AOI enter/leave
falls out as ordinary add/remove rows and the client needed zero changes.
Positional events (shots) are radius-filtered too; kill-feed events stay
global. Getting under budget took real bandwidth work: quantizing sim
floats to exact-binary grids (pos/vel 1/8 px, angles 1/256 — 17-digit JSON
floats were the single biggest cost), integer tracer endpoints, dropping
`lastInputSeq` from diffs (remote clients never read it; own reconciliation
rides the message ackSeq), and an exact-binary heat-decay rate.

**Verification.** 63 tests green: ped wander determinism with zero
building-clips over 200 peds × 300 ticks, gunfire scatter, ped-kill heat,
AOI filter correctness (everything excluded is provably far), a moving
client staying hash-consistent through 600 ticks of AOI churn (500+ hashed
deltas, 0 desyncs), and stale-ack full-snapshot fallback. THE GATE: 8-bot
brawl with 200 peds + police swarm — 40-44 KB/s per client, under the
50 KB/s budget, 0 desyncs, lockstep (harness now fails any run over
50 KB/s, permanently). Quantization surfaced a genuine -0 bug (JSON writes
-0 as "0", hashes disagreed by a sign bit) — fixed at quantizer and hash.

**Deliberately deferred.** The binary codec — JSON now fits the budget with
headroom, so per the plan ("switch when profiling proves it") it stays JSON;
the Codec seam is ready when richer traffic (phase 8 props, more players)
needs it. Ped variety (one sprite), sidewalk crossing behavior at lights,
per-district ped density.

**Least confident about.** The 10 Hz NPC cadence under packet loss —
interpolation smooths steady streams; a hiccup drops NPC keyframes harder
than player ones. Brawl clusters bots (worst case for AOI); a pathological
all-eight-players-in-one-plaza scenario still fits budget by measurement,
but barely half of it is headroom. -0 taught me JSON round-tripping has
sharp edges; if another eigenvalue like NaN ever enters the sim it will
desync — sanitizeIntent guards the only external float inputs, but a sim
bug producing NaN would poison hashes silently.

## Phase 6 — police and wanted levels

**What changed.** Heat-based wanted system, entirely in the sim: violence
against players adds heat proportional to damage plus a kill bonus, car
theft adds a little, killing a cop adds a lot; `wantedLevel` = heat/100
clamped to 1–5. Heat decays only while NO cop has line of sight — hide to
cool off; heat survives death by design (dying is not a laundering
mechanic). Cops are sim entities that spawn deterministically from the
kerbside spawn list in a ring around the fugitive (one per tick, ramping to
2 per star, capped per player and globally), pursue with greedy steering —
axis-separated wall-slide plus an rng sidestep when wedged, which the road
grid makes look smarter than it is — and fire only with LOS inside range.
Players can shoot back: cops have health and drop, at a price. All numbers
in `police.json`. Cop shots/`copDown` are events; clients render cops
(sprite, interpolated), tracers, and wanted stars.

**Verification.** 56 tests green: crimes raise heat (violence, theft),
decay-while-hidden to zero, level-3 chase (posse spawns within 10 s,
converges inside firing range, draws blood — the "tense at level 3" gate as
a machine-checkable proxy: pressure arrives fast, from multiple directions,
and standing still is lethal), cop-killing raises heat, and the entire
chase hashing identically across runs. 8-bot brawl with live police: PASS,
lockstep, 0 desyncs; kill counts now include deaths-by-cop. Replay with the
full police sim re-simulates hash-identical.

**Deliberately deferred.** Cop cars and roadblocks (on-foot posse only —
level 4/5 currently just means *more* cops; vehicle police would be the
next escalation). Pathfinding beyond greedy wall-slide (cops can be juked
around building corners — arguably a feature; BFS on road tiles is the
planned upgrade if chases feel dumb). Wanted-level UI beyond stars.

**Least confident about.** "Genuinely tense" is a human judgment — the
machine proxy (fast convergence + real damage) is necessary but not
sufficient; tune copsPerStar/moveSpeed/copPistol damage after a real chase.
Greedy pursuit can wedge cops on concave building clusters (the sidestep
frees most cases; some pace circles remain). Cop entity + shot-event
bandwidth tripled brawl traffic — phase 7's interest management is now
load-bearing for two reasons.

## Phase 5 — economy, shops, accounts, persistence

**What changed.** The economy lives entirely server-side behind one seam:
`Economy` validates everything (the server is the cashier) and its only
write-path into the sim is the SimCommands it returns (`grantWeapon`,
`setCosmetic`), which the session queues and records like inputs. Cash is an
append-only ledger — no balance column anywhere; balance is a fold over
transactions, every entry carries a reason and a unique idempotency ref
(duplicate refs are rejected, so retried writes can't double-apply, and
"where did this cash come from" is one query). Persistence sits behind a
`PersistenceStore` interface: the JSON `FileStore` (atomic tmp+rename
writes) is the verified implementation in this environment; the reviewed
MySQL schema is in `server/mysql/schema.sql` — see the open questions at the
end of this file. Purchases: `buy` is a request message; the server checks
alive/on-foot, doorway proximity to the right shop kind, price from its own
catalog, and balance. Awards: kills pay with per-victim diminishing returns
inside a time window, driving pays only *novel* road cells at speed, both
under per-minute caps — all numbers in `economy.json`. No player-to-player
transfers exist, killing the entire duping/muling class. Accounts are
optional (guests always play, session-scoped wallets): username+password
with scrypt from node:crypto; cosmetics persist per account and re-equip on
login via a command. Client: wallet + shop panel (stand in a doorway,
Y/U/I/O to buy), L/K prompt-based login/register.

**Verification.** 50 tests green: ledger idempotency + overdraw rejection,
scrypt account verify (case-insensitive uniqueness, wrong-password fail),
kill-award decay/window-reset/rate caps, novel-cell driving pay,
doorway/shop-kind/balance purchase validation, and the phase gate —
cash, transactions, cosmetics, and idempotency surviving a store reload.
Full-stack `persistCheck` over the real wire: register → kill server →
fresh process on the same store → login → wallet identical and starting
cash seeded exactly once. Kill awards ran live during the brawl runs.

**Update (post-review):** persistence target changed from MySQL to SQLite
per review. `SqliteStore` over Node's built-in `node:sqlite` (zero new
dependencies) is now the default backend (`data/persist.db`); same
append-only discipline (INSERT-only transactions, UNIQUE ref as idempotency
key, balance = SUM(delta)). The JSON FileStore remains available via a
`.json` path and both backends run the same restart-survival test suite.

**Deliberately deferred.** Weapon unlocks
as account inventory — per the death-costs-guns design, weapons are
repurchased, only cosmetics + cash persist. A real login UI (window.prompt
is a placeholder). Shop stock limits.

**Least confident about.** Award tuning (does $100/kill vs $250/pistol feel
right?) is untested by humans. Guest wallets route to a pure-memory ledger
(the persist file only ever holds account rows), but a guest's cash
silently evaporating on session end may need messaging in the UI.
prompt()-based login blocks the render loop while open.

## Phase 4 — weapons, damage, death, respawn, kill feed

**What changed.** Hitscan weapons (pistol/smg/shotgun in `weapons.json`):
tile-DDA wall ray + analytic ray-circle target tests, nearest hit wins,
spread rolled from the sim PRNG (server-side weapons pass only — prediction
never touches the rng). Health/damage/death in the sim: dying drops you out
of any car, freezes the corpse, clears weapons, stamps `respawnAtTick`.
Respawning is a server-issued `respawnPlayer` command 3 s after the death
event — which is exactly where the `WEAPONS_LOST_ON_DEATH` flag (default
true) lives: it only decides the loadout the command carries (fresh pistol
vs. weapons at death), so the sim stays flag-free and both settings replay
deterministically. `step()` now emits deterministic SimEvents (shot/kill/
death) via an out-param; the server relays them; the client shows a kill
feed, tracers, health/ammo HUD, and a wasted-screen countdown. Run-over
damage for fast cars with a short immunity window. Weapon switching added as
a `slot` field on the input intent (keys 1-8) — still an intent, but it is
a deliberate extension of the brief's fixed field list, flagged here.
Brawl bot script: chase nearest living player, strafe, shoot.

**Verification.** 44 tests green: hitscan damage/cooldown/ammo/kill/loot-
clear/respawn lifecycle, walls actually block shots, bit-identical combat
determinism (same fight twice), run-over damage. 8-bot brawl 60 s: 21 kills,
every bot died and respawned, 0 desyncs, corrections back to ≤4.33 px once
respawn teleports were correctly excluded from the correction metric (they
are legitimate teleports, not prediction error — that fix is in the
predictor, found by the harness tripping on 2000 px "corrections").
**10-minute unattended 8-bot brawl: PASS — 18010 ticks, 135 kills, every
bot died 14–20 times and respawned, tick spread ≤1, 0 desyncs, corrections
≤10.3 px, no crash.**

**Deliberately deferred.** Drive-by shooting (fire is on-foot only).
Vehicle damage/destruction. Weapon pickups/drops on the ground (decided
against in plan — dupe/grief surface). Damage directionality/knockback.

**Least confident about.** Balance numbers (damage/cooldown/spread) are
untested by humans. The kill feed names use snapshot lookup at event time —
a player who disconnects the same tick renders as #id. Shot events are
broadcast unfiltered; at 8 players this is noise, but phase 7's interest
management must filter events too, not just entity deltas.

## Phase 3 — vehicles

**What changed.** Vehicles are sim entities: signed forward speed along a
heading, steering authority that grows with speed (reversing inverts it),
hard friction when coasting, wall crashes damp and slightly rebound speed —
arcade, not rigid-body, all tunables in `vehicles.json`. 48 parked cars
spawn per session from the map's kerbside spawn list (as recorded commands,
so replays reproduce them). Enter/exit is an edge-triggered `action` intent
resolved in the sim: nearest free near-stationary car within radius; a
contested door on the same tick resolves by player id; exit tries left/right/
rear spots and refuses if boxed in. Car-vs-car contact is a simple stop-on-
overlap (server-side only). Snapshots/deltas/hashes generalized over both
entity tables. The predictor now predicts the driven car (same shared
physics), while enter/exit and car-vs-car remain deliberately unpredicted —
server-granted, corrections smoothed. Client interpolates and renders
vehicles; joyride bots seek, steal, and drive cars.

**Verification.** 39 tests green: enter/drive/exit lifecycle, edge-trigger
(holding action doesn't re-trigger), contested same-tick entry with range
gating, wall crash on a synthetic arena (speed >200 px/s, damped on impact,
never penetrates, never passes the wall), and bit-exact driving prediction
(zero correction over 150 ticks of throttle+steering). 8-bot joyride 60 s:
lockstep 1809..1809, 0 desyncs, 4 bots stole and drove cars, corrections
18–22 px only from deliberately-unpredicted transitions (limit 96). Replay
still hash-identical twice.

**Deliberately deferred.** Run-over damage and drive-by fire (phase 4).
Vehicle health/destruction (phase 8 decides if cars burn). Car-vs-car
momentum transfer — stop-on-overlap is deliberately crude; revisit only if
play feels bad. Bots don't pathfind around buildings to reach cars (half of
them nose into walls; harmless for verification purposes).

**Least confident about.** Whether driving "feels weighty" — the numbers
(330 px/s top speed ≈ 20 tiles/s, speed-scaled steering) are reasoned, not
felt; they're one JSON edit away from retuning once a human drives.
Correction magnitude during contested entries under real latency (60 ms
round trip) — bots on localhost show ~20 px; worth watching the ghost when
first played over a real link.

## Phase 2 — procedural city, collision, camera, pixel-art pipeline

**What changed.** `shared/src/world/` generates the whole city as a pure
function of (seed, params): district Voronoi seeds → jittered arterial grid →
recursive block subdivision with district-sized targets → per-district block
fill (downtown packs solid, residential rows with yards, industrial slabs on
open lots, parks stay green) → shops with sidewalk doorway zones (quota'd:
gun shops prefer industrial/commercial, clothing prefers commercial/downtown)
→ parked-car spawn points → spread-apart player spawns. 240×240 tiles at
16 px (3840² px world), generated in ~30 ms. Movement now collides with
building tiles via axis-separated AABB sweeps, sub-stepped ≤ half a tile so
fast movers can't tunnel (a real bug the test caught before vehicles made it
matter). The map threads through `step()` and the predictor; the server ships
its parsed tuning + worldgen params in the welcome message so a server-side
JSON tune can never desync client generation, and replay headers embed both,
making replays self-contained. `pnpm mapgen --seed=N` renders a city PNG
(hand-rolled encoder over node:zlib); `pnpm sprites` emits the placeholder
sprite sheet from palette + shape descriptors; the client draws the tile
world, sprites rotated at draw time, integer-scaled camera clamped to the
city.

**Verification.** 35 tests green: worldgen purity (bit-identical tiles for
same seed), density/district/quota/spawn invariants across seeds, doorways
walkable, collision escape-proofing (600 ticks of input mashing never ends
inside a wall), flush clamping. Rendered seeds 7/8/9 to PNG and eyeballed:
three clearly different cities (different downtown placement, park spread,
block texture). 8-bot 60 s run over the real city: lockstep 1810..1810,
0 desyncs, corrections still exactly one held tick (4.33 px) — collision is
bit-exact in prediction. Fresh replay re-simulates to identical hashes.

**Deliberately deferred.** Explicit road graph (nodes/edges) — police/ped AI
will pathfind on the road tile grid directly (BFS), which is the boring
version; a graph can be derived later if profiling demands it. Crosswalks,
lane markings beyond a sparse dot texture, building interiors (per brief:
none, shops are doorway zones). District-specific palettes beyond building
colors.

**Least confident about.** District *feel* at street level — the aerial PNGs
read distinct, but on-foot distinctiveness (building height cues, prop
density) is thin until props (phase 8) and peds (phase 7) arrive. Residential
blocks lean sparse; worldgen.json numbers are all tunable without a rebuild
if the density feels wrong in play.

## Phase 1 — prediction, reconciliation, interpolation

**What changed.** The server now consumes exactly one input intent per tick,
in seq order (with a 6-tick bounded hold for gaps and a fast-forward drain
for bursts) — the contract reconciliation needs. Extracted
`stepPlayerMovement()` so one function moves a player on the server, in the
client predictor, and in bots. Added `Predictor` to shared/: applies local
inputs instantly (zero input lag), and on every snapshot rewinds to the
authoritative player and replays unacked inputs; it tracks correction
magnitude, which the overlay shows as ghost drift. The browser client renders
the local player from the predictor and remote players through a new
~100 ms (3-tick) interpolation buffer with a servo'd render clock — no
snapping, no extrapolation. Bots now run the identical Predictor and the
harness fails if any correction exceeds 32 px.

**Verification.** 29 tests green, including an in-process client/server
prediction test proving zero correction when each input is applied exactly
once, and convergence (corrections return to zero, no accumulated drift)
after a deliberately dropped input. 8-bot 60 s run: lockstep ticks
1807..1807, 0 desyncs, max correction 4.33 px — exactly one tick of walk
speed, the expected transient when setInterval jitter makes the server hold
an input for one tick; it does not accumulate.

**Deliberately deferred.** Smoothing of reconciliation corrections (currently
applied instantly — at 4 px it's invisible; revisit when vehicles raise
speeds). Input redundancy (sending last N intents per message) — TCP
WebSockets don't drop, only delay, so holds are rare and bounded.

**Least confident about.** The "two tabs feel" criterion is verified by
proxy (bots + math) since this environment has no browser windows;
interpolation smoothness under real frame-rate jank is untested. The render
clock servo (5% pull toward target delay) is a guess that may need tuning on
a real 60 ms connection.

## Phase 0 — workspace, sim skeleton, transport, bots, overlay, replay

**What changed.** Built the entire phase-0 skeleton from an empty repo: pnpm
workspace (`shared`/`server`/`client`), the deterministic sim core in
`shared/` (fixed 30 Hz `step()`, seeded mulberry32 PRNG stored in GameState,
sorted-id entity tables, deterministic polynomial sin/cos/atan2 so no engine
transcendentals ever touch the sim), the full wire protocol behind the
`Codec` interface (JSON now), delta snapshots against per-client acked ticks
with a 3 s ring and full-resync fallback, periodic FNV state hashes in
snapshots as the desync tripwire, the authoritative server (drift-corrected
tick loop, join/resume with per-session tokens, input sanitation at the trust
boundary), record/replay (every session records; the replay runner re-sims
and hash-verifies), the bot harness, and a minimal browser client (fixed
480×270 integer-scaled canvas, keyboard/mouse intents, `~` overlay with tick
rate, RTT, entities, KB/s, hitboxes, and the predicted-vs-authoritative ghost
slot). Sim tunables live in `shared/data/player.json`, loaded by each host
and injected via `initTuning()`. The `WEAPONS_LOST_ON_DEATH` env flag is
parsed in server config, ready for phase 4/5.

**Verification.** `pnpm test`: 27 tests green across shared+server, including
step determinism (same seed+inputs ⇒ identical hash), delta round-trip
equality, trust-boundary rejection tests, and a pinned PRNG known-answer
sequence. `pnpm bots --count=8 --script=cruise --duration=60`: all 8 bots
finished at the identical tick (1808..1808), 8 entities each, 0 desyncs,
0 stale deltas, 0 full resyncs; a 20 s `jitter` chaos run also passed. The
recorded replay of the live 8-bot session re-simulated twice to the same
final hash (`8fbba894`). Client typechecks and `vite build` passes.

**Deliberately deferred.** Prediction/reconciliation and interpolation
(phase 1) — the client renders raw snapshots, so remote motion quantizes to
snapshot arrival for now and the overlay ghost is trivially zero. The server
applies the newest queued intent per tick (input hold); phase 1 changes
consumption to one-intent-per-tick by seq for reconciliation. Snapshot
deltas diff whole fields (a moving player resends pos+vel every tick) — fine
under JSON, revisit with the binary codec or interest management. Deviations
from the PLAN file list: added `shared/src/net/sync.ts` (snapshot reassembly
shared by client and bots), `shared/src/net/hash.ts`, `shared/src/tuning.ts`,
and `server/src/tuning.ts` (fs loader); per-phase entity tables
(vehicles/peds/props) will be added to GameState in their phases rather than
sitting empty now.

**Least confident about.** (1) Wall-clock input timing: bots and client send
intents on their own setInterval/rAF clocks and the server applies "latest
wins" — good enough for lockstep verification, but phase 1's
tick-aligned input scheduling is where real timing bugs will surface, and
the current smoothness is not evidence they don't exist. (2) The resume path
is tested at the session level but not end-to-end under a real mid-game
socket drop with a stale ack ring. (3) Bandwidth (~29 KB/s per client with 8
players under JSON) is fine now but the JSON+full-field-diff combination has
no headroom for phase 7's pedestrians — the interest-management milestone is
carrying real load.
