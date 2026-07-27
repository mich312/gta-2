# Design Review — expert panel

**Build reviewed:** `0821b80` (branch `main`), reviewed on branch
`claude/game-review-rockstar-experts-n47cvw`.

**About this document.** The panel below is a set of **review personas** —
deliberately narrow lenses, each written as a specialist who has shipped
top-down open-city action games and is looking for the places where this build
diverges from the genre's originals. They are not real, named individuals and
no real person's opinion is represented here. What *is* real is every code
reference: each claim was checked against the source at the commit above, and
the measured figures in Appendix B come from actually running the thing.

**What was run.** `pnpm build` (clean) · `pnpm test` (73/73 green) ·
`pnpm bots --count=6 --script=brawl --duration=45` (PASS, ticks 1357..1357,
0 desyncs, corrections ≤4.4 px, ~42 KB/s) · `pnpm mapgen --seed=7`
(258 blocks, 635 buildings, 6 shops, 373 car spawns).

**Headline.** The engineering is genuinely strong — deterministic 30 Hz sim,
bit-exact prediction, replay verification, an interest-managed wire protocol
that holds under load. Nobody on this panel is worried about the netcode. The
gap is that a **city simulation** has been built and a **city game** has not
yet been switched on. Roughly a third of the content the data files describe
— traffic, boats, water, police vehicles — exists as tuning JSON and sprite
definitions with **no code behind them**. That is the single biggest lever
here, and it is mostly a matter of connecting things that are already
half-built.

---

## Panel

| # | Persona | Lens |
|---|---|---|
| 1 | **Marek Dvořák** — Vehicle & Traffic Design | cars, emergency services, handling, road life |
| 2 | **Ana Ferreira-Blythe** — World & Level Design | map layout, landmarks, density, spawn geography |
| 3 | **Tomás Iyer** — Combat & Weapons | arsenal, TTK, feedback, melee |
| 4 | **Greta Lindqvist** — Systems & Police AI | wanted levels, pursuit, escape economy |
| 5 | **Kwame Osei-Hart** — City Life & Pedestrians | crowds, reactions, ambient believability |
| 6 | **Ilse Brandt** — Player Feel & Controls | movement, camera, jumping, verbs |
| 7 | **"Bugsy" Nakamura** — Fun Engineer | the toy box, chaos, why you play a second time |

---

## 1. Marek Dvořák — Vehicle & Traffic Design

**Verdict: the streets are a car park, not a city.**

I opened `shared/data/traffic.json` expecting to tune ambient traffic and found
a complete, thoughtful spec — `count: 30`, `cruiseSpeed`, `lookAhead`,
`turnProbe`, `brakeDistance`, `laneHalfWidth`, `laneKeepGain`,
`decisionCadenceTicks`, `turnChance`, plus `boatCount: 8` and
`mooredBoatCount: 8`. Then I grepped for every one of those keys across
`shared/src`, `server/src` and `client/src`. **Zero hits.** There is no
traffic system. The file is a design document with a `.json` extension.

What actually populates the roads is `server/src/session.ts:102` — every third
entry of the map's kerbside spawn list, capped at `MAX_VEHICLES = 48`
(`session.ts:21`). Forty-eight *stationary* cars across a 3840×3840 px world.
That's one car per ~1200 tiles. In the originals the road was the loudest thing
on screen: cars flowing both ways, stopping at junctions, honking, getting
shunted. Here the road is scenery you occasionally park on.

**Emergency services: absent, and this is the one that hurts most.**
The genre's signature is that the city has its *own* agenda and you crash into
it. There is no ambulance, no fire truck, no taxi, no bus, no garbage truck.
More pointedly:

- **There is no police car.** Cops are foot units only (`CopState` in
  `shared/src/sim/state.ts:14`, spawned in `shared/src/sim/police.ts:63`).
  `PROGRESS.md:140` calls this a deliberate deferral, and I accept that — but
  a fully-drawn `copcar` sprite with red/blue light bars already sits in
  `shared/data/sprites.json`, and `client/src/render/lighting.ts:9` already
  defines `sirenRed`/`sirenBlue` light colours. The art and the lighting are
  done. Nothing spawns it.
- **Boats and water are the same story.** `shared/data/vehicles.json` defines a
  full `boat` entry with `"medium": "water"`. `client/src/render/renderer.ts:373`
  branches on `kind === 'boat'`. `shared/data/palette.json` has `water` and
  `sand`. `shared/data/worldgen.json:19` sets `waterWidth: 10`. And
  `shared/src/world/types.ts:7-13` defines exactly six tile types — field,
  road, sidewalk, building, park, lot. **There is no water tile.** `waterWidth`
  isn't even parsed by `parseWorldgenParams` (`shared/src/world/params.ts:42`).
  A boat exists that has no medium to float on.

**Handling.** The arcade model in `shared/src/sim/vehicle.ts` is clean and it
predicts bit-exactly, which I respect. But it's missing the things that make
driving a *toy*:

- **Cars are indestructible.** `VehicleState` (`state.ts:49`) has no health
  field. You cannot damage, wreck, burn or explode a car. In the originals a
  car on fire that you had ten seconds to leave was a whole emotional beat.
- **Car-vs-car is a wall.** `vehicle.ts:52-56`: overlapping another vehicle
  reverts your position and sets `speed = 0`. Hitting a parked car at 330 px/s
  is a dead stop with no momentum transfer and no damage. You cannot shunt,
  nudge, or plough a line of parked cars. `PROGRESS.md:273` flags this as
  "deliberately crude" — agreed, and it's now the most-felt crudeness in the
  build.
- **Hitting a building bounces you.** `vehicle.ts:48-51` sets
  `speed = -speed * 0.25`. Full-speed into a wall spits you backwards at
  ~82 px/s, undamaged. It reads as rubber, not concrete.
- **No handbrake, no horn.** `client/src/input/keyboard.ts:73` samples the
  intent and there is no key for either. Worse: `Effects.skid()` is fully
  implemented at `client/src/render/effects.ts:218` and **never called from
  anywhere**. The tyre marks are written and unreachable.
- **No drive-by.** `shared/src/sim/weapons.ts:296` gates firing on
  `p.mode !== 'foot'`. Acknowledged as deferred in `PROGRESS.md:235`, but
  combined with "no cop cars", it means every vehicle chase in this game is
  silent.

**Steering note for whoever tunes next.** Authority saturates at
`maxSpeed * minSteerSpeedFrac` = 330 × 0.25 = **82.5 px/s** — a quarter of top
speed. Above that you get a flat 2.8 rad/s regardless of velocity, so turn
radius scales linearly with speed (30 px at 83 px/s, 118 px at 330). It's not
wrong, it's just characterless: every car turns identically because there *is*
only one car. Ten body colours (`sprites.json` `car.variants.body`) is paint,
not a garage.

**My top three:**
1. Implement the traffic sim that `traffic.json` already specifies. Even a
   crude lane-follower at 30 cars transforms the city.
2. Give the police a car. The sprite, the siren colours and the lighting pass
   are already built — this is a spawn path and a driver behaviour, not an art
   task.
3. Vehicle health + a fire/explode state. It unlocks more emergent play per
   line of code than anything else on my list.

---

## 2. Ana Ferreira-Blythe — World & Level Design

**Verdict: a beautifully-generated grid that has no geography.**

I rendered seed 7. The tile art is genuinely lovely — `client/src/render/tiles.ts`
bakes kerbs, lane dots, manholes, paving variation, extruded walls and cast
shadows into cached chunks, and it costs nothing at runtime. Per-square-metre,
this looks better than it has any right to. My problem is at the scale above
that.

**The map has no features.** `shared/src/world/roads.ts` lays 3×3 jittered
arterials and then recursively subdivides. `shared/src/world/districts.ts`
assigns district types by nearest-Voronoi-seed. The result is honest and
readable and completely uniform. There is:

- **No water.** No river, no harbour, no coastline. (See Marek — the palette
  and `waterWidth` are waiting for it.)
- **No islands and therefore no bridges.** The genre's structural signature is
  a city cut into pieces you cross deliberately. Here everything connects to
  everything.
- **No landmarks.** Every building is a coloured rectangle from
  `shared/src/world/buildings.ts:108-162`. Nothing is bigger, taller, oddly
  shaped, or *named*. There is no stadium, no power station, no cathedral, no
  tower you navigate by.
- **No elevation, no freeway, no tunnel, no multi-storey car park, no train.**
  All roads are one plane, one width class (arterial 4 tiles / secondary 2),
  all orthogonal. No diagonals, no curves, no roundabouts, no cul-de-sacs, no
  one-way streets, no traffic lights, no crosswalks (`PROGRESS.md:314`
  acknowledges the last one).
- **No district identity beyond colour.** `residential` gets small houses with
  yard gaps, `industrial` gets slabs on lots, `park` gets a green rectangle.
  The *building shapes* differ; the *street experience* doesn't. Park blocks in
  particular are literally empty green rects — no paths, no ponds, no
  bandstand.

**Scale is the quiet problem.** The world is 240×240 tiles at 16 px =
3840×3840 px. The camera shows 480×270 world px. That's 8 screens wide by 14
tall — about **114 screenfuls**. Sounds big. But at the car's 330 px/s top
speed you cross the entire map, edge to edge, in **11.6 seconds**, and corner
to corner in 16.5. On foot it's 29.5 seconds. There is nowhere far away. A city
you can drive across in twelve seconds cannot make you feel lost, and being
pleasurably lost is most of what a city is for.

**Spawning is geographically meaningless.** `placePlayerSpawns`
(`shared/src/world/amenities.ts:189`) picks 16 points from every third sidewalk
tile, rejecting any closer than 30 tiles to another. `pickSpawn`
(`shared/src/sim/step.ts:180`) then chooses **uniformly at random** among them
on every spawn *and every respawn*. So you die downtown and wake up in a
suburb three districts away with no idea where you are. In the originals you
respawned at the nearest **hospital** — a real, findable place on the map,
which is what made losing a chase a setback instead of a teleport. Sixteen
anonymous kerbside points, chosen at random, is the least legible option
available.

**Six shops. One hundred and fourteen screens. No map.** `shopQuota` is
3 gun + 3 clothing (`worldgen.json`). `placeShops`
(`amenities.ts:56`) spreads them across preferred districts with a 20-tile
minimum separation. They are marked in the world only by a doorway zone you
have to physically stand in (`client/src/main.ts:74`). There is **no minimap,
no radar, no map screen, no waypoint, no compass** — I grepped
`client/src/render/hud.ts` and the whole client for `minimap`/`radar` and got
nothing. The genre has had a radar since its first entry. Right now the only
way to find a gun shop is to drive the whole city looking for a red-outlined
doorway.

**Street furniture is sparse and non-interactive.** `placeProps`
(`amenities.ts:145`) drops a lamp every 9th kerbside tile, a bin every 13th
wall tile, a fence every 2nd park-edge tile, then hard-caps the lot at
**400** (`amenities.ts:186`). Across 114 screens that's ~3.5 props per
screenful. And per `PROGRESS.md:60` none of them collide — you walk through
park fences. They also never respawn, so a long session strictly decays.

**My top three:**
1. Water + a river cutting the map + two or three bridges. It creates
   geography, chokepoints, chases with real decisions, and it switches on the
   boat that's already written.
2. A minimap. Nothing else on my list changes the play experience as much per
   hour of work.
3. Respawn at the nearest of a handful of *named, visible* hospitals instead
   of a random point. Turns death into a place you know.

---

## 3. Tomás Iyer — Combat & Weapons

**Verdict: three guns, no hands.**

The arsenal is `shared/data/weapons.json`: `pistol`, `smg`, `shotgun`, plus
`copPistol` which the player can't have. **Three usable weapons.** The
originals shipped with something closer to a dozen and, crucially, with
weapons that had *different verbs* — area denial, arcing throwables, vehicle
removal, sustained burn. Everything here is a hitscan ray with a damage number
and a cone. There is:

- **No melee.** None. Look at `stepWeapons` (`weapons.ts:293-309`): if
  `p.weapons[p.activeWeapon]` is missing or `ammo <= 0`, the loop `continue`s.
  A player with no weapon has **no attack of any kind** — no fist, no kick, no
  pistol whip. Since death clears your loadout entirely (`weapons.ts:264`) and
  `WEAPONS_LOST_ON_DEATH` defaults true, "unarmed and helpless" is a real
  state a player can be in. In the originals you always had fists.
- **No explosives, no throwables, no fire, no rocket.** Nothing that damages
  an area, arcs over a wall, or removes a vehicle. Combine that with
  "vehicles are indestructible" and there is literally no way to destroy a car
  in this game.
- **No reload.** Ammo is a single pool per weapon (`WeaponSlot` at
  `state.ts:9`) and fire rate is a flat cooldown. There's no magazine, so no
  rhythm, no reload window to punish, no decision about when to top up.
- **No headshots, no damage falloff, no directionality, no knockback**
  (`PROGRESS.md:237` acknowledges the last two). `rayCircleDistance`
  (`weapons.ts:59`) treats every body as one uniform circle of `PLAYER_RADIUS`
  = 6 px.
- **No weapon pickups on the ground.** Deliberate per `PLAN.md` (dupe/grief
  surface) and I understand the reasoning — but it means the *only* source of
  weapons in the entire game is 3 gun shops you have to find without a map.
  That's a very thin supply line.

**The numbers, measured:**

| Weapon | DPS | Shots to kill (100 HP) | TTK |
|---|---|---|---|
| pistol | 40.0 | 9 | 2.50 s |
| smg | 70.0 | 15 | 1.43 s |
| shotgun (all 6 pellets) | 67.5 | 2 | 0.80 s |
| copPistol (one cop) | 17.5 | 15 | 5.71 s |

The spread is sane and the shotgun-vs-smg tradeoff (0.22 rad cone, 140 range
vs 0.07 rad, 200 range) is a real choice. But `PROGRESS.md:239` is honest that
"balance numbers are untested by humans", and it shows in one place: the
pistol is the *default respawn loadout* (`server/src/session.ts:24`) and it's
strictly the worst gun with a 2.5 s TTK. Every fight you enter fresh off a
respawn, you enter losing.

**Feedback is thin.** `client/src/render/effects.ts` does muzzle flash,
impact sparks, blood and debris, and they're nicely done. But there is **no
audio anywhere in the client** — I grepped for `Audio`, `AudioContext`,
`sound`: zero hits. No gunshot, no ricochet, no engine, no siren, no scream,
no radio. `PROGRESS.md:60` lists audio as deferred. I want to underline how
much of combat *feel* lives in the 40 ms after you pull a trigger, and right
now all of it is visual.

Tracers last 70 ms (`hud.ts:73`) and hit registration is instant with no
travel time, so at 200+ px range a fight is two players sliding sideways while
health bars drain with no sense of a projectile between them.

**My top three:**
1. Fists. A default melee that never runs out. One afternoon of work, removes
   the helpless state entirely.
2. One area weapon — grenades or a molotov. It's the single missing verb, and
   it pairs with vehicle damage to unlock everything.
3. Audio. Even three sounds (shot, impact, engine) would double the perceived
   quality of the combat.

---

## 4. Greta Lindqvist — Systems & Police AI

**Verdict: a well-built heat system attached to a police force that cannot
catch anyone.**

The heat model in `shared/src/sim/police.ts` is the most *designed* thing in
the build and I like a lot of it. Heat accrues per crime, `wantedLevel =
floor(heat/100)` capped at 5 (`state.ts:202`), cops spawn from kerbside points
in a 260–640 px ring around the fugitive, one per tick — "a ramp, not a wall"
(`police.ts:66`), which is exactly right. Line-of-sight gating on both fire
and heat decay is the correct instinct. Pursuit hashes identically across
runs.

Now the problems, roughly in order of severity.

**A car defeats the entire police force.** Cop `moveSpeed` is 122 px/s
(`police.json`). Car `maxSpeed` is 330. Cops have no vehicles. So the moment
you sit in *any* car, a 5-star pursuit becomes a formality — you drive away at
2.7× their top speed and they cannot follow. There is no roadblock, no
spike strip, no helicopter, no radio-in. The wanted system's entire tension
arc collapses the instant the player touches a car door, which in this game is
every ~30 seconds.

**Conversely, on foot you cannot escape at all.** Player walk speed is 130
vs cop 122 — an **8 px/s margin, 6%**. Over ten seconds of sprinting you gain
80 px, and their fire range is 190. So on foot escape is impossible and in a
car it's trivial. There is no middle. The originals had that middle: alleys,
cutting through buildings, the Pay'n'Spray, the cop-bribe pickup.

**There is no way to lose a wanted level except waiting.** `heatDecayPerSec`
is 5, and only while *no* cop has line of sight (`police.ts:129-135`). One
star = 20 s of clean running; five stars = 120 s. There is **no Pay'n'Spray,
no bribe pickup, no safehouse, no changing cars** — the clothing shop exists
(`shop.json`) but `setCosmetic` (`step.ts:135`) only changes `cosmeticId`; it
does not touch heat. A wardrobe change that doesn't shake the cops is a
missed open goal.

**Wanted level 5 is identical to wanted level 4.** `police.ts:48`:

```ts
const desired = Math.min(t.copsPerStar * wanted, t.maxCopsPerPlayer);
```

With `copsPerStar: 2` and `maxCopsPerPlayer: 8`, four stars requests 8 and
five stars requests 10 → clamped to 8. **The fifth star adds nothing.** It
draws an extra `★` on the HUD (`hud.ts:125`) and changes no behaviour at all.
Either raise the cap or — much better — make higher tiers change *kind* rather
than *count*: cars at 3, roadblocks at 4, something worse at 5. That's how the
originals escalated.

**You cannot run over a cop.** `stepVehicleImpacts`
(`weapons.ts:314`) iterates `state.players.ids` and `state.peds.ids`. It does
**not** iterate `state.cops.ids`. A police officer is immune to a car doing
330 px/s. Pedestrians die; players take 39.6 damage a hit; cops are untouched.
I'm fairly confident this is an oversight rather than a decision, and it's a
one-loop fix.

**Stealing a parked car is always a crime.** `tryEnterVehicle`
(`vehicle.ts:121`) unconditionally calls `addHeat(p, heatPerTheft)` — the
comment says "witnessed or not". Seven car entries = one star, including
getting back into the car you parked ten seconds ago. In the originals, an
*empty* car was free; the crime was pulling someone out of an *occupied* one,
in view of a cop. Since no vehicle in this game has an occupant, the one form
of grand theft auto that should be a crime doesn't exist, and the one that
shouldn't be always is.

**Balance flag:** eight cops at 17.5 DPS each is **140 DPS**. A full-health
player caught in the open at 4–5 stars dies in **0.71 s**. There is no armour,
no cover system, and — see below — no healing. That's not difficulty, that's a
coin flip.

**Also, no healing exists in this game.** I grepped the whole sim. The only
write that raises player health is `p.health = 100` in the `respawnPlayer`
command (`step.ts:115`). No health pickups, no armour pickups, no hospital, no
regeneration, no medkit. Once you're at 12 HP the *only* way back to full is
to die. That single fact distorts every other system: it makes fleeing
pointless, makes the 3-second respawn (`weapons.ts:15`) the cheapest way to
heal, and turns "death" into a resource.

**My top three:**
1. Police cars at wanted level 3+. Fixes the "car = invincible" hole and the
   "level 5 does nothing" hole in one change.
2. Health pickups. The absence is currently load-bearing on the wrong side.
3. A Pay'n'Spray equivalent, or make the clothing shop clear heat. Give the
   player a *play* for losing the cops instead of a stopwatch.

---

## 5. Kwame Osei-Hart — City Life & Pedestrians

**Verdict: the crowd is the best-value system in the build and it's one
behaviour short of alive.**

I want to lead with praise, because `shared/src/sim/peds.ts` is a lovely piece
of restraint. 200 pedestrians, each about 20 lines of logic, wandering on a
sidewalk-weighted direction pick (`pickDirection`, `peds.ts:27`, double weight
for staying on pavement), stepping on a **staggered 3-tick cadence** so NPC
motion runs at 10 Hz and costs a third of the delta bandwidth while the client
interpolates it smooth (`peds.ts:127`). They flee gunshots and deaths within
170 px, and they scatter from cars doing 140+ within 90 px. In the bot runs
the streets read as populated. For the cost, that is excellent.

Now the gaps against the originals.

**Nobody drives.** No pedestrian ever enters a vehicle, and no vehicle ever
has an NPC driver. This removes the genre's most iconic single interaction:
walking up to a moving car, opening the door, and pulling the driver out. It
isn't even possible to express here — `tryEnterVehicle` (`vehicle.ts:109`)
skips any vehicle with `driverId !== null`, and there's a
`MAX_BOARDING_SPEED = 40` gate (`vehicle.ts:100`) so you can't board anything
moving. Carjacking, the verb the genre is named for, is absent.

**Pedestrians have exactly two states.** `PedMode` is `'walk' | 'flee'`
(`state.ts:35`). There's no idling, no queuing, no sitting on the benches that
`sprites.json` defines, no crossing at junctions, no waiting for traffic (there
is no traffic), no groups, no arguments, no reacting to *you* specifically
until you shoot. They also never react to a wanted player walking past with a
gun out — only to the shot itself.

**They never come back.** Peds are spawned once, in the `Session` constructor
(`server/src/session.ts:126-134`), and `damagePed` (`peds.ts:156`) removes them
permanently. There is no respawn path anywhere. A long session monotonically
depopulates the city — kill 200 pedestrians and the streets stay empty until
someone restarts the server. Same for props (`PROGRESS.md:60`). This is the
one I'd fix first: an entropy-only world is a world that gets worse the longer
you play it.

**No gangs, no factions, no territory.** The district system
(`districts.ts`) generates five district *types* and paints them, but nobody
lives in them. The originals put rival gangs in each area with a respect meter,
so district identity was a *social* fact you navigated, not a colour. Right now
`downtown` and `commercial` differ only in building packing density
(`buildings.ts:109-114`) and palette.

**No day/night, no weather.** `client/src/render/lighting.ts` applies a fixed
dusk grade with lamp pools and headlight cones — and it looks great, genuinely,
it's the best-looking part of the client. But it's the same time of day
forever. A cycle would cost almost nothing given the pass already exists, and
would change how the same street reads across a session.

**My top three:**
1. Ped and prop respawn. The world should not be a consumable.
2. NPC drivers — which requires traffic (see Marek), and pays off in
   carjacking, which is the headline verb.
3. A day/night cycle over the existing lighting pass. Cheap, and the lighting
   is already built to carry it.

---

## 6. Ilse Brandt — Player Feel & Controls

**Verdict: the motion is exemplary; the vocabulary is four verbs wide.**

Credit where it's due first, because this is the area that most builds get
wrong and this one gets right. `client/src/render/smoothing.ts` samples the
local player *between* simulation ticks so motion is continuous at any display
rate; `client/src/render/config.ts` renders into a backing store at 2× and
keeps the camera un-rounded; corrections arrive as a glide to the smoothing
target rather than a snap (`main.ts:110`). Measured corrections in a 6-bot
brawl were 0.0–4.4 px. It feels good, and that's hard.

**The full verb list.** From `client/src/input/keyboard.ts:73`: move, aim,
fire, action (enter/exit/buy), switch slot. Plus buy keys and login. That's it.

**There is no jump.** I checked — no jump key, no vertical state, no `z`
anywhere in `PlayerState` (`state.ts:59`). Now, I want to be precise here,
because "no jump" is *period-correct*: the top-down originals this is styled
after had no jump button either. So I don't score it as a regression. What I
do score is that nothing took its place. Those games gave you a punch, a kick,
and — critically — **stunt jumps** off ramps, with a slow-motion airborne
moment and a bonus. Here there is no ramp, no air, no vertical dimension of
any kind, and no melee to compensate. The player's body can do exactly one
thing: translate.

**No sprint, no crouch, no roll, no cover, no lean.** Movement is a single
speed: 130 px/s, accelerated at 900 px/s² (`player.json`), diagonal-normalised
(`player.ts:35`). It's responsive and it's uniform. There's no stamina, no
"oh god run" gear, no way to make yourself a smaller target.

**Two camera notes.**

- **The camera never zooms out.** The view is a fixed 480×270 world px
  (`shared/src/constants.ts:10`). On foot at 130 px/s that's generous. In a car
  at 330 px/s you cross the viewport width in **1.45 seconds**, so you have
  ~0.73 s of visible road ahead of you. That's below comfortable reaction time
  for a junction decision. The originals zoomed the camera out with speed for
  exactly this reason. This is my single highest-value note in this section.
- **The camera doesn't lead.** `computeCamera` (`renderer.ts:47`) centres
  hard on the player and clamps to map bounds. No look-ahead offset toward
  velocity or aim, so at speed you're always driving into the blind half of
  the screen.

**Death is abrupt.** `applyDamage` (`weapons.ts:252-266`) zeroes health, drops
you out of the car, clears your weapons and schedules a respawn 90 ticks (3 s)
later. The HUD draws "wasted — respawning in N" (`hud.ts:148`). There's no
death animation, no ragdoll, no camera hold, no slow-motion — you stop existing
and a counter appears. Three seconds is also very short for a beat that's
meant to sting.

**Small HUD gaps:** no speedometer, no compass, no damage-direction
indicator, no ammo-low warning, no hit marker. Health, ammo, stars, cash
(`hud.ts:104-135`) and that's the lot.

**My top three:**
1. Speed-proportional camera zoom-out. Fixes the worst feel problem in the
   build.
2. A melee attack — it's the missing body verb and it doubles as Tomás's
   fix for the unarmed state.
3. Camera look-ahead toward velocity when driving.

---

## 7. "Bugsy" Nakamura — Fun Engineer

**Verdict: it's a very good sandbox with nothing in the box.**

Right. My job isn't correctness, it's whether I want a second go. So I played
it the way a player would, and here's the honest shape of a session:

*I spawn on a pavement. I don't know where I am — nobody does, there's no map.
I walk. The streets look terrific and are completely still: 48 cars, all
parked, all empty, forever. I find a car. Getting in is a crime, apparently, so
I now have heat. I drive. I cross the entire city in twelve seconds. I run over
some pedestrians — this works and is satisfying and they scatter properly. I
get a star. Cops appear on foot. I drive away at three times their speed and
literally nothing can follow me. I wait twenty seconds and it's over. Then I go
looking for a gun shop, without a map, across a hundred screens. That's the
loop.*

**What's actually fun right now**, and I mean this sincerely:
- Ploughing a crowd at speed. `stepVehicleImpacts` + the ped flee logic
  produce a genuinely great scatter. This is the best moment in the game.
- Smashing lamps and bins at speed. The 8% momentum loss per prop
  (`props.json` `crashSpeedLoss`) is a lovely little tactile detail.
- The lighting. Headlight cones over wet-looking asphalt at dusk is a *mood*.
- A close shotgun fight. 0.8 s TTK, punchy.

**What kills the fun, in order:**

1. **Nothing chases you.** Once you're in a car, no threat in this game can
   reach you. Every escalation ends the same way: get in car, leave. If I can't
   lose, I can't win.
2. **Nothing blows up.** No car damage, no explosions, no fire, no grenades,
   no chain reactions. In a genre built on gleeful destruction, the total set
   of things I can destroy is: lamp posts, bins, park fences, and living
   things. I cannot destroy a *car*. That's the toy I most wanted.
3. **There's no goal and no score.** No missions, no phone booths, no
   checkpoints, no races, no leaderboard, no multiplier, no kill-streak, no
   "kill frenzy". `PROGRESS.md:60` defers all of it, and fine — but the two
   things that pay are `killAward` and a $5-per-novel-512px-cell driving award
   (`economy.json`), and money only buys three guns and four jackets. The
   economy has nothing to want.
4. **The world only degrades.** Peds die permanently, props break
   permanently, neither respawns. Hour two is emptier than hour one. Sandboxes
   have to replenish or they're just a countdown.
5. **It's silent.** No audio at all. I cannot overstate this for *fun*
   specifically — half the joy of a car chase is the noise of it.
6. **Everything cool is already half-built and switched off.** This is the
   thing I keep coming back to. The skid marks are written and never called
   (`effects.ts:218`). The police car is drawn and never spawned. The boat has
   physics and no water. The traffic system has a complete tuning file and no
   code. `marineSpeed: 205` sits in `police.json` and is read by nothing. It's
   like walking through a theme park the day before it opens.

**My cheapest-to-most-fun ranking** — what I'd actually ship next:

| # | Change | Effort | Why it's fun |
|---|---|---|---|
| 1 | **Explodable cars** | M | The missing toy. Chain reactions in a car park is a whole afternoon of play. |
| 2 | **Ambient traffic** (the JSON already exists) | M | Turns a diorama into a city. Also creates things to crash into and jack. |
| 3 | **Police cars + roadblocks** | M | Restores the chase. Makes stars mean something. Makes escape a skill. |
| 4 | **Grenades** | S | One area weapon changes every fight and every chase. |
| 5 | **Kill-frenzy pickups** (timed target count, cash reward) | S | A goal, a timer, a score. The classic dopamine loop, and it's tiny. |
| 6 | **Ped + prop respawn** | S | Stops the world dying. |
| 7 | **Minimap** | S | Removes the "wandering lost with no map" tax on everything else. |
| 8 | **Three sounds** (shot / engine / siren) | S | Biggest perceived-quality jump per hour on this list. |
| 9 | **Stunt ramps + air time + bonus** | M | Replaces the missing jump with something better. |
| 10 | **Speed camera zoom** | S | Makes driving fast feel fast instead of blind. |

Do 1–5 and this stops being a tech demo and starts being a game. Honestly, do
just 1 and 3 and I'll play it for an hour.

---

## Consolidated priorities

The panel converged hard. Ranked by (impact × how much is already built):

| Rank | Change | Raised by | Notes |
|---|---|---|---|
| 1 | **Police vehicles** at wanted 3+ | Marek, Greta, Bugsy | `copcar` sprite + siren lighting already exist. Fixes "car defeats police" *and* "star 5 is inert". |
| 2 | **Ambient traffic** | Marek, Kwame, Bugsy | `traffic.json` is a finished spec with zero implementation. |
| 3 | **Vehicle damage + explosions** | Marek, Tomás, Bugsy | `VehicleState` has no health field; nothing in the game can destroy a car. |
| 4 | **Minimap / radar** | Ana, Bugsy | No map of any kind; 6 shops across ~114 screens. |
| 5 | **Health pickups** | Greta, Tomás | Currently the *only* heal in the game is dying (`step.ts:115`). |
| 6 | **Melee / fists** | Tomás, Ilse | Unarmed players have no attack at all. |
| 7 | **Ped + prop respawn** | Kwame, Bugsy | The world is currently consume-only. |
| 8 | **Water + a river + bridges** | Ana, Marek | Switches on the already-written boat; creates geography. |
| 9 | **Audio** (even 3 sounds) | Tomás, Bugsy | Zero audio in the client today. |
| 10 | **Speed-based camera zoom** | Ilse | 0.73 s of visible road at top speed. |

---

## Appendix A — verified defects & dead code

Each of these was confirmed by reading the source at `0821b80`. They're
separated from the design opinions above because they're facts, not taste.

**Likely bugs**

| # | Finding | Location |
|---|---|---|
| A1 | **Cops cannot be run over.** `stepVehicleImpacts` iterates `players` and `peds` but never `cops`. A cop is immune to a car at any speed. | `shared/src/sim/weapons.ts:314-348` |
| A2 | **Wanted level 5 is behaviourally identical to level 4.** `min(copsPerStar × wanted, maxCopsPerPlayer)` = `min(10, 8)` = `min(8, 8)`. The fifth star only draws an extra HUD glyph. | `shared/src/sim/police.ts:48`, `shared/data/police.json` |
| A3 | **No healing exists.** The only write that raises player health is the respawn command. No pickups, no regen, no armour. | `shared/src/sim/step.ts:115` |
| A4 | **Entering any parked car always adds heat**, including a car you just parked. | `shared/src/sim/vehicle.ts:121` |

**Dead code / orphaned data** — things that are built and unreachable:

| # | Finding | Location |
|---|---|---|
| A5 | `shared/data/traffic.json` — every key (`count`, `cruiseSpeed`, `lookAhead`, `turnProbe`, `brakeDistance`, `laneHalfWidth`, `laneKeepGain`, `blockedTimeoutTicks`, `decisionCadenceTicks`, `turnChance`, `boatCount`, `mooredBoatCount`, `boatCruiseSpeed`) has **zero references** in any source file. | whole file |
| A6 | `Effects.skid()` is fully implemented and **never called**. | `client/src/render/effects.ts:218` |
| A7 | The `copcar` sprite (body, panels, red/blue light bar) is defined and **never spawned or drawn**. | `shared/data/sprites.json` |
| A8 | The `boat` vehicle has full tuning (`"medium": "water"`), a sprite, and a render branch — but **no water tile type exists**. | `shared/data/vehicles.json`, `client/src/render/renderer.ts:373`, `shared/src/world/types.ts:7-13` |
| A9 | `worldgen.json` sets `waterWidth: 10`; `parseWorldgenParams` never reads it. | `shared/data/worldgen.json:19`, `shared/src/world/params.ts:42-69` |
| A10 | `police.json` sets `marineSpeed: 205` — **zero references** anywhere. | `shared/data/police.json` |
| A11 | `police.spawnCooldownTicks` is declared, parsed and defaulted, but never read by the police sim (spawns are already rate-limited to one per tick by an early `return`). | `shared/src/tuning.ts:42,147,225` vs `shared/src/sim/police.ts:36-70` |
| A12 | Palette entries `water` and `sand` are defined and unused. | `shared/data/palette.json` |

---

## Appendix B — measured figures

| Quantity | Value | Source |
|---|---|---|
| World size | 240×240 tiles = 3840×3840 px | `worldgen.json`, `TILE_SIZE=16` |
| Camera view | 480×270 world px (~114 screenfuls of world) | `shared/src/constants.ts:10-11` |
| Cross-map by car (top speed) | **11.6 s** edge-to-edge, 16.5 s corner-to-corner | 3840 ÷ 330 px/s |
| Cross-map on foot | **29.5 s** | 3840 ÷ 130 px/s |
| Vehicles in world | 48, all parked, all empty | `server/src/session.ts:21,102` |
| Pedestrians | 200, never respawn | `session.ts:126-134`, `PED_COUNT` |
| Props | ≤400, never respawn, no collision | `amenities.ts:186`, `PROGRESS.md:60` |
| Shops | 6 total (3 gun, 3 clothing) | `worldgen.json` `shopQuota` |
| Player spawn points | 16, chosen uniformly at random per (re)spawn | `amenities.ts:189`, `step.ts:180` |
| Usable weapons | 3 (+1 cop-only) | `shared/data/weapons.json` |
| Player TTK | pistol 2.50 s · smg 1.43 s · shotgun 0.80 s | `weapons.json` @ 30 Hz |
| 8-cop combined DPS | 140 → player dies in **0.71 s** | `police.json`, `weapons.json` |
| Player vs cop foot speed | 130 vs 122 px/s (**6%** margin) | `player.json`, `police.json` |
| Player car vs cop foot speed | 330 vs 122 px/s (**2.7×**) | `vehicles.json`, `police.json` |
| Heat to clear 1 star / 5 stars | 20 s / 120 s of unseen running | `heatDecayPerSec: 5` |
| Respawn delay | 3.0 s (90 ticks) | `weapons.ts:15` |
| Audio assets | 0 | grep: no `Audio`/`AudioContext`/`sound` in `client/` |
| Map / radar UI | none | grep: no `minimap`/`radar` in `client/` |

---

## What the panel is *not* worried about

Worth stating plainly, because the list above is long and the engineering
underneath it is not the problem:

- Determinism holds. 6 bots, 45 s, ticks 1357..1357, **0 desyncs**, corrections
  ≤4.4 px, ~42 KB/s per client against a 50 KB/s budget.
- 73/73 tests green, including replay re-simulation to identical hashes and
  interest-management churn under AOI enter/leave.
- The renderer is legitimately good. Chunked tile caching, baked kerbs and lane
  detail, extruded walls, cast shadows, a two-composite lighting pass with lamp
  pools and headlight cones — all essentially free at runtime.
- Sub-tick smoothing makes motion fluid at any display rate.
- The economy's separation from the sim (ledger outside `GameState`, purchases
  entering only as recorded `SimCommand`s) is exactly the right architecture,
  and it means every item on this review's wishlist can be added without
  touching the netcode.

The foundation will carry all of this. What it needs now is the content the
data files are already asking for.
