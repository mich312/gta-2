# Car breakdown and damage — investigation

> **Status: built.** R1–R8 and the two one-line fixes all landed. §6 at the
> bottom records what shipped, the three regressions the work surfaced, and the
> two places the estimates in this document turned out to be wrong.


What the vehicle damage model does today, what is measurably wrong with it, and
what I would change. Every number below was measured against the current tree
by driving the sim, not read off the tuning file and assumed.

Scope: `shared/src/sim/vehicleDamage.ts`, the collision half of
`shared/src/sim/vehicle.ts`, the wear rendering in `client/src/render/renderer.ts`,
and the places damage should touch and does not — audio, HUD, the shops and the
crusher.

---

## 1. What exists

The model is small and it is honest about being small. A vehicle carries three
fields (`state.ts:139-142`):

```
health: number
condition: 'ok' | 'burning' | 'wreck'
fuseAtTick: number | null
```

and one derived quantity, `vehicleWear(v) = (max - health) / max`
(`vehicle.ts:136`), deliberately not stored so it cannot disagree between hosts.

**Damage sources.** Bullets (`weapons.ts:215-236` — vehicles are in the hitscan
ray test), blasts (`vehicleDamage.ts:112-118`), projectiles
(`projectiles.ts:131,168`), mines and car bombs (`fittings.ts:47-58`), and
collisions with walls (`vehicle.ts:89-96`) and other vehicles
(`vehicle.ts:97-123`).

**The state machine.** `damageVehicle` subtracts; at zero the car goes
`burning` with a fuse of `burnSeconds` (7 s). `stepVehicleDamage` runs one
detonation pass per tick over a list frozen in sorted-id order — the design
note at the top of `vehicleDamage.ts` is right that this is the whole
determinism risk and it is handled well. Detonation calls the shared `blast`,
sets `wreck`, ejects the driver, and starts a `wreckSeconds` (25 s) despawn
fuse that will not fire while a living player is within 260 px.

**What wear does.** Two things, both in `driveVehicle` (`vehicle.ts:203-216`):
up to 45 % power loss (`WEAR_POWER_LOSS`) and a steering pull of up to 30 % of
lock, sign taken from the vehicle id so it is the same pull every tick. The
renderer draws up to 7 dents hashed off the id and scorches the paint past half
wear (`renderer.ts:580-635`).

That is the entire system. It is coherent, it is deterministic, and the tests
cover ignition, detonation, chain reactions and wreck clearing (6 tests in
`shared/test/vehicleDamage.test.ts`, all green).

---

## 2. Defects

### D1 — The collision volume is a square of the wrong size, ignoring heading

`overlappingVehicle` (`vehicle.ts:33-51`) is an axis-aligned box test using
**the striker's own** `halfExtent` for both axes and for both vehicles:

```ts
Math.abs(other.pos.x - self.pos.x) < half * 2 &&
Math.abs(other.pos.y - self.pos.y) < half * 2
```

A car has `halfExtent: 9`, so its collision volume is an 18 × 18 px square,
heading-independent. Its *body* is about 26 × 14 px (`sprites.json`: the car
sprite is 53 × 29 at scale 2). Three consequences, all measured:

**Phantom collisions between cars in adjacent lanes.** A two-tile street puts
opposing lanes 16 px apart (`traffic.ts:171` — `centre ± halfWidth * 0.5` on a
32 px carriageway). 16 < 18, so two cars passing in opposite directions collide.
Measured, two cars at cruise speed with a fixed lateral separation:

| lateral separation | collisions during one pass | HP lost (of 200) | closest approach |
|---|---|---|---|
| 8 px  | 8 | 88 | 20.6 px |
| 12 px | 8 | 88 | 22.5 px |
| 16 px | 8 | 88 | 24.8 px |
| 20 px | 0 | 0 | 20.0 px |

Bodies would have to be within ~14 px to touch. At 16 px separation the two
cars never come close to touching, collide eight times, and each loses 44 % of
its health. At 20 px they pass cleanly. The cliff is exactly at `halfExtent * 2`.

**18 px of interpenetration nose-to-tail.** The same square is only 18 px long
against a 26 px car body, so a car can bury a third of its length in the car in
front before the sim notices.

**Size mismatch.** Because the test uses only the striker's extent, a car
detects a bus (`halfExtent: 15`) only within 18 px of the bus's centre — well
inside the bus. Ramming a bus at 200 px/s with the throttle held destroys both
vehicles, because the striker is inside the victim and re-triggers contact every
tick as it rebounds and is driven back in.

### D2 — There is no mass

Three separate places treat all vehicles as equal:

- `shove = v.speed * 0.55` (`vehicle.ts:105`) — a car shoves a bus exactly as
  hard as a bus shoves a car.
- `hit.heading = v.heading` (`vehicle.ts:114`) — the struck vehicle's heading is
  *assigned*, not nudged. A T-boned bus instantly points the way the car that
  hit it was going.
- Each party takes damage scaled by **its own** `collisionDamagePerSpeed`
  (`vehicleDamage.ts:186-188`), and that coefficient is *larger* for heavier
  vehicles (car 0.055, truck 0.1045, bus 0.1155). Combined with their larger
  health pools it nets out to roughly equal proportional damage — so the heavy
  vehicle gains nothing.

Measured, one vehicle rammed into another with the throttle held:

```
bus   -> car   @148 px/s : bus lost 29.2%,  car lost 27.8%
truck -> car   @156 px/s : truck lost 31.0%, car lost 29.3%
car   -> car   @200 px/s : 37.8% each
```

The bus comes off *worse* than the car it hit. There is no reason to prefer a
truck for anything, which quietly wastes the whole `traffic.mix` vehicle roster.

### D3 — Ramming is not a verb

A clean single impact resolves correctly — one damage application, then
separation (traced tick by tick: contact at 186 px/s → 10 damage → rebound to
−46 px/s → clean separation). The problem is the magnitude. Measured, a car
driven into a wall at full speed, repeatedly:

**27 full-speed wall impacts to set a car burning.**

Against an SMG at 7 damage per shot on a 3-tick cooldown — 70 dps — the same car
burns in **2.9 seconds**. Gunfire destroys a car roughly 25× faster than the
worst crash the physics can produce. Given that the collision thresholds are
already generous (damage only above 54 px/s into a wall, 36 px/s into a car,
and wall damage is further scaled by 0.7 at `vehicle.ts:94`), the car is not a
weapon and cannot be made into one by playing well.

### D4 — A car is pristine or written off, with almost nothing in between

This is the one you notice while playing, and it has two halves.

**The body.** `drawDents` (`renderer.ts:596`) draws
`count = Math.floor(wear * MAX_DENTS)` dents with `MAX_DENTS = 7`. The first
dent therefore needs `200 / 7 = 28.6` damage. A full-speed wall impact does 7.7.

> **You have to crash into a wall at full speed roughly four times before your
> car shows a single mark.** Car-to-car, 2.6 times. The scorched-paint pass at
> `wear > 0.5` needs thirteen full-speed impacts.

So the ordinary case — clip a bollard, scrape a bus, take a corner badly — leaves
the bodywork *completely untouched*. There is no "a little dented". And when
dents do arrive they arrive in a batch of one, then two, then three, at fixed
wear steps, in positions hashed off the vehicle id — so they are not where you
were hit. You can reverse into a wall and watch a dent appear on the bonnet.

**The lights.** Every lamp on a car is one boolean: `if (!occupied) return`
(`renderer.ts:733`). Both headlights, the headlight cone and both brake lights
are either all on or all off, and nothing about damage touches any of them. A
car that has been through a wall at 200 px/s has two perfect headlights.

Between "showroom" and "on fire" the model has exactly two states it can show:
some dents, and darker paint. That is the whole visual vocabulary.

### D5 — `vehicleBurning` is emitted, encoded, relayed, and handled by nobody

The event is declared (`events.ts:59`), pushed by both ignition paths
(`vehicleDamage.ts:42`, `fittings.ts:58`) and carried to the client. There is no
branch for it in `onGameEvent` (`client/src/main.ts:217-289`). So when the car
you are sitting in catches fire and starts a 7-second fuse:

- no sound,
- no HUD notice (the HUD has no vehicle readout at all — `carWear` and
  `carCondition` go only to the debug overlay, `main.ts:571-572`),
- no screen effect.

The only cue is the flame particles drawn under your own sprite
(`renderer.ts:694`), which the car body largely covers. Every other consequential
event in the game announces itself. This one kills you.

### D6 — A car crash makes no sound

`integrateVehicle` emits no event on impact — not for a wall, not for another
vehicle. There is consequently no crash sound in `audio.json` (the sound list is
`pistol, smg, shotgun, copPistol, fists, impact, thud, death, propDown, pickup,
explosion`) and no way to add one without adding the event first. Shooting,
punching, running someone over, smashing a bin and blowing something up all have
an event and a sound. Hitting a bus at 200 px/s is silent.

### D7 — You survive your own car exploding

`explosionDamage` is 85 (`vehicles.json`) against a player pool of 100, and
`explode` (`vehicleDamage.ts:121-139`) fires the blast *before* ejecting the
driver, whose position is pinned to the vehicle's (`step.ts:87-89`). So a
full-health, unarmoured player standing at the exact centre of their own
detonating car walks out with 15 HP. The fuse is meant to be a decision — bail
or ride it out — and the wrong answer is currently survivable.

### D8 — Damage has no economic weight

- The respray (`step.ts:190-201`) clears heat, wanted level and cop interest.
  It does not touch `health`. There is no repair anywhere in the game.
- The shop catalog has a `heal` item kind for players (`clinic`) and no
  equivalent for vehicles (`shop.json`).
- The crusher pays `base × exportBonus` by vehicle **kind** only
  (`economy.ts:305-307`). A car one shunt from bursting into flames exports for
  exactly what a showroom one does.

So damage costs the player handling and nothing else, and there is no sink for
the money the crusher prints.

### D9 — `health` is an f64 on the wire

`binary.ts:435` writes `w.f64(v.health)` while every other vehicle field is
quantised — `q8` for position and speed, `q256` for heading, `u8` for condition.
Eight bytes for a number whose only consumers are a `> 0` test and a 0..1 wear
ratio that feeds a 7-step dent count and a power multiplier. Collision damage
produces fractional values (5.72, 10.0…), so the float is load-bearing today,
but only because nothing rounds.

### D10 — Two small dead things

- `shared/test/vehicleDamage.test.ts` imports `roadLane` twice, at line 11 and
  again at line 20. It survives because tests are not type-checked —
  `shared/tsconfig.json` has `"include": ["src"]` — and esbuild tolerates it.
- `renderer.ts` calls `layRubber` twice in `drawVehicle`, at line 702 and line
  741. Harmless (the first call has already overwritten `skidState`, so the
  second sees `dtMs === 0` and returns), but it is a duplicated line.

---

## 3. What the model cannot express

These are not bugs; they are the shape of the design.

**G1 — One scalar, no components.** Everything visible and everything felt is
derived from a single number. There is no way to say "the left headlight is
gone", "the bonnet is buckled", "the near-side front tyre is flat" — because
there is nowhere to put it. §4 R4 is the answer to this and is written out in
full.

**G2 — No damage direction.** `damageVehicle(state, v, amount, events)` carries
no impact point, so the renderer hashes dents off the vehicle id rather than
placing them where you were hit, and "this car soaks a frontal impact better
than a side one" is not expressible.

**G3 — No lateral or angular velocity.** The vehicle model is a signed speed
along a heading (`vehicle.ts:15-19`, explicitly "deliberately not rigid-body
anything"). A collision cannot spin you, cannot slide you sideways, and cannot
impart an impulse — only reassign a heading. This is the ceiling every other
collision improvement runs into.

**G4 — Landing is free.** `stepStunts` (`frenzy.ts:95-113`) integrates `z`,
accumulates `airDist`, emits `stuntLanded` and does nothing else. A 300 px jump
costs no health.

**G5 — Bailing out is free.** `tryExitVehicle` (`vehicle.ts:299`) has no speed
check. You step out of a burning car at 200 px/s and stand still, unhurt, which
makes the burn fuse a non-decision as soon as you know about it (see D5).

**G6 — A burning car is invulnerable.** `damageVehicle` returns early unless
`condition === 'ok'` and `blast` skips non-`ok` vehicles. A rocket into a row of
burning cars does nothing; you cannot hurry a chain reaction along.

**G7 — A wreck is an immovable bollard.** It stays in `state.vehicles.ids` so
traffic queues behind it (correct), cannot be shoved (`hit.condition !== 'wreck'`
guard at `vehicle.ts:113`), and will not despawn while any living player is
within 260 px. A wreck dropped in a junction blocks it for as long as someone
stands nearby.

**G8 — Ambient traffic never heals.** Wear is monotonic and nothing repairs it.
Measured over five simulated minutes of ambient traffic with one idle player:

```
t= 60s  22 cars, 6 showing damage,  mean wear 0.6%
t=120s  24 cars, 11 showing damage, mean wear 1.2%
t=180s  28 cars, 14 showing damage, mean wear 1.9%
t=240s  33 cars, 15 showing damage, mean wear 1.9%
t=300s  33 cars, 17 showing damage, mean wear 2.4%
```

Half the fleet is visibly dented after five minutes and the trend does not
flatten. On a long-lived server the city fills with battered cars — driven by
D1, since ambient drivers pass each other inside the phantom-collision band.

---

## 4. What I would do

Ordered by value per unit of risk. The determinism rules apply throughout:
everything in `shared/` must be exactly reproducible — `dCos`/`dSin` rather than
`Math.cos`/`Math.sin`, `q8`/`q256` on anything that reaches the wire, no
`Math.random`, and sorted-id iteration.

### R1 — An oriented collision box, sized from both vehicles (fixes D1)

The single highest-value change, and it fixes a bug that is actively degrading
the city right now. Replace `overlappingVehicle`'s square with a separating-axis
test between two oriented rectangles, using each vehicle's own half-length and
half-width:

- Add `halfLength` and `halfWidth` to `VehicleTuning` (`tuning.ts:13-39`) and
  `vehicles.json`, derived from the sprite footprints — car 13 × 7, bus 22 × 8,
  truck 20 × 8. Keep `halfExtent` for tile collision, which genuinely wants a
  circle-ish box.
- SAT on two rectangles is four axis tests using `dCos`/`dSin` — deterministic,
  and cheap enough at the tens-of-vehicles scale the AOI already enforces.
- Return the minimum-translation vector and the **contact point** as well as the
  boolean. R2 needs the first, R4 needs the second.

Expected effect: opposing traffic stops shredding itself, nose-to-tail contact
registers at the bumper instead of a third of the way in, and a car can no
longer end up inside a bus.

A cheaper interim fix if SAT is too much for one change: use
`(self.halfExtent + other.halfExtent)` instead of `self.halfExtent * 2`, and
raise the threshold to a circle test. That kills the size mismatch but not the
lane-passing bug, since it makes the volume *larger*. I would not stop there.

### R2 — Mass (fixes D2)

Add `mass` to `VehicleTuning` — car 1.0, van 1.4, truck 2.2, bus 2.5 — and use
it in three places:

- **Shove**: split the impulse by mass ratio rather than a flat 0.55. The
  striker keeps `m_other / (m_self + m_other)` of the exchange, the victim gets
  the rest.
- **Heading**: blend the struck vehicle's heading toward the striker's by the
  same ratio instead of assigning it, so a bus barely deflects.
- **Damage**: redefine `collisionDamagePerSpeed` as damage *dealt*, and divide
  the received amount by the receiver's mass. Ramming a bus in a car should hurt
  the car; the current table already encodes "trucks hit harder", it is just
  applied to the wrong party.

All three are multiplications by tuned fractions, which are exact under IEEE-754
and therefore prediction-safe, matching the note at `vehicle.ts:174-190`.

### R3 — Make ramming worth doing (fixes D3, and unlocks R4)

With R1 and R2 landed the numbers can be re-derived rather than guessed. Targets
I would aim at: a full-speed head-on into a wall costs ~15 % of a car's health
(≈7 impacts to destroy, not 27); a full-speed ram into a parked car costs the
victim ~25 % and the striker ~15 %; a truck flattening a car in three hits while
taking a scratch. That is `collisionDamagePerSpeed` roughly quadrupled for a car
— 0.055 → **0.21** — and mass-divided for the receiver.

Add a **repeat-contact debounce** at the same time — a `lastCollisionTick` on
`VehicleState`, ignoring damage from the same pair within ~4 ticks. Without it,
quadrupling the coefficient turns the held-throttle-against-a-wall case into an
instant kill, and R1 will not fully prevent sustained overlap.

This has to land with R4 rather than after it. R4's breakage ladder is expressed
in fractions of vehicle health, and under *today's* collision damage almost none
of it is reachable by driving: a full-speed wall impact is 3.8 % of a car.

### R4 — A damage map instead of a slider (fixes D4, addresses G1 and G2)

This is the detail the model is missing. Keep `health` as the single
authoritative number for the burn/wreck state machine — it is the right call for
the wire and for determinism — and add a compact record of **where** the car has
been hit. Everything visible and everything mechanical then derives from that.

#### 4.1 State

Two new fields on `VehicleState` (`state.ts:139`):

```ts
/** Damage accumulated per body zone, 0-255. Index: 0 front, 1 right, 2 rear, 3 left. */
zones: number[];
/** One bit per breakable component. See COMPONENT_* below. */
broken: number;
```

`broken` is a 16-bit field:

| bit | component | bit | component |
|---|---|---|---|
| 0 | headlight L | 8 | tyre front-L |
| 1 | headlight R | 9 | tyre front-R |
| 2 | tail light L | 10 | tyre rear-L |
| 3 | tail light R | 11 | tyre rear-R |
| 4 | windscreen | 12 | door L |
| 5 | bonnet | 13 | door R |
| 6 | boot | 14 | bumper front |
| 7 | radiator | 15 | bumper rear |

#### 4.2 Routing a hit to a zone

`damageVehicle` grows an optional impact point — supplied by the bullet hit
position (`weapons.ts` already computes it), the blast centre, and R1's contact
point:

```ts
function zoneOf(v: VehicleState, ix: number, iy: number): number {
  const a = wrapAngle(dAtan2(iy - v.pos.y, ix - v.pos.x) - v.heading);
  if (a < QUARTER_PI && a >= -QUARTER_PI) return 0;      // front
  if (a >= QUARTER_PI && a < THREE_QUARTER_PI) return 1; // right
  if (a >= THREE_QUARTER_PI || a < -THREE_QUARTER_PI) return 2; // rear
  return 3;                                              // left
}
```

`dAtan2` is the existing deterministic table (`math/trig.ts`), the comparisons
are on integers after rounding, and the accumulator saturates at 255. Damage
with no impact point (a car bomb, say) spreads evenly across all four.

#### 4.3 The breakage ladder

Thresholds are **fractions of the vehicle's own `health`**, so a bus's headlight
takes proportionally more to shatter than a hatchback's. One shared table in
`vehicleDamage.ts`; no per-kind tuning needed unless a specific vehicle wants it.

| zone damage | what happens | car (200 hp) | felt as |
|---|---|---|---|
| 0.03 | first dent in that quadrant | 6 | a scuff on the corner you hit |
| 0.04 | bumper on that end comes loose | 8 | cosmetic |
| 0.06 | second dent | 12 | |
| 0.07 | **near-side lamp on that end shatters** | 14 | one headlight out |
| 0.09 | third dent | 18 | |
| 0.11 | **off-side lamp on that end shatters** | 22 | both out — night driving is over |
| 0.12 | fourth dent (that quadrant is full) | 24 | |
| 0.18 | bonnet buckles (front) / boot springs (rear) | 36 | grey smoke starts |
| 0.22 | door on that side hangs off (left/right) | 44 | driver no longer shielded from bullets |
| 0.24 | windscreen crazes | 48 | |
| 0.32 | radiator holed (front only) | 64 | black smoke, −15 % top speed |

The asymmetric lamp thresholds (0.07 and 0.11) are the whole point: **lights go
one at a time.** A single headlight is the most legible damage cue the genre has,
and it costs one bit and one comparison.

Worked example, a car under R3's collision numbers (`collisionDamagePerSpeed`
0.21, wall impacts further scaled by 0.7):

| impact | front-zone damage | resulting state |
|---|---|---|
| kerb at 80 px/s | 11.8 | one dent, front bumper loose |
| wall at 120 px/s | 17.6 | two dents, bumper, **left headlight out** |
| wall at 160 px/s | 23.5 | three dents, bumper, **both headlights out** |
| wall at 200 px/s | 29.4 | four dents, bumper, both headlights out |
| head-on into a parked car at 200 | 42.0 | quadrant full, bonnet buckled and smoking |

That is a car that gets progressively, visibly worse from the first prang —
which is what "a little dented" means and what the current model cannot produce
at all (D4: four full-speed crashes before the first mark).

#### 4.4 What each component does

*Mechanical, in `shared/` — these must be deterministic:*

- **Radiator** — top speed × 0.85, stacking with the existing wear power loss.
- **Tyre** — a steering pull toward the flat side and top speed × 0.88 per flat.
  This finally gives `pullSign(id)` (`vehicle.ts:143-150`) a real cause: the
  comment there admits the id is a stand-in, and a blown near-side front tyre is
  the honest reason a car pulls left. Tyres take damage from bullets whose
  impact point lands within 6 px of a wheel — local `(±8, ±5)`, the positions
  `layRubber` already uses — and from kerb strikes above 140 px/s.
- **Door** — removes the driver's bullet shield. Today a driver is protected
  because `vehicleHitRadius` (14.5) exceeds `PLAYER_RADIUS` (6), so the ray hits
  the car first (`weapons.ts:215-236`). With that side's door gone, skip the
  vehicle for rays arriving from that zone. This makes shooting out a driver a
  two-stage act rather than a health-pool race.
- **Bonnet / boot / bumper / windscreen / lamps** — no mechanical effect.

*Visual, in `client/` — free, since they derive from synced state:*

- **Lamps.** `drawVehicle` (`renderer.ts:715-745`) currently emits two headlight
  points, one cone, and two brake points, gated only on `occupied`. Gate each on
  its bit; with one headlight gone, halve the cone's spread and offset its origin
  to the surviving lamp. A one-eyed car coming the other way at night is
  instantly readable.
- **Dents.** Replace `count = Math.floor(wear * MAX_DENTS)` with a per-zone
  count, `Math.min(4, Math.floor(zone / (max * 0.03)))`, and confine each
  zone's dents to its quadrant of the sprite footprint. Keep the
  `hash(id, zone, i)` placement so a given car's damage is stable across frames
  and client restarts, and keep the `source-atop` clip — that part is right.
- **Missing panels.** A lost bumper or door is a `destination-out` notch clipped
  to the sprite at that zone's edge, drawn before the dents.
- **Glass.** A crazed windscreen is a short white crackle stroke over the cabin;
  a shattered lamp is a 2 px dark dot where the light used to be.
- **Smoke.** New `Effects.engineSmoke(x, y, heading, black)` spawning from the
  bonnet at a wall-clock cadence (the same guard `exhaust` uses at
  `renderer.ts:748`, so a 240 Hz display does not smoke four times as hard).
  Grey at the bonnet threshold, black at the radiator.

#### 4.5 The wreck

A wreck currently draws the intact sprite darkened (`renderer.ts:664-673`). With
components it should be a real shell: force every bit in `broken` on detonation,
so the burnt-out car has no glass, no bumpers, no lights and four flat tyres.
One line in `explode`, and the wreck stops looking like a car someone parked in
the shade.

#### 4.6 Wire cost

`zones` as four `u8`s and `broken` as a `u16` is **6 bytes**, and both are
per-field diffed (`snapshot.ts:87` `VEHICLE_FIELDS`, mask written at
`binary.ts:577`) so they cost nothing on a car that has not been hit this tick.
`VEHICLE_CODECS` goes from 10 fields to 12; the varint mask stays two bytes (it
does not need a third until 15). Quantising `health` to a `u8` (R7) frees 7
bytes, so the entire component system is **net −1 byte** per changed vehicle.

Both fields are hashed state and must therefore be added to `hashState`
(`hash.ts:91`) *and* to `VEHICLE_FIELDS`. The comment at `snapshot.ts:78-82`
about `airDist` is the precedent and the warning: a hashed field left out of the
diff produced 25 desyncs per bot against a sim that replayed perfectly.

#### 4.7 Determinism

Integer accumulators, integer thresholds, `dAtan2` from the existing table, no
rng, no per-frame state in `shared/`. Breakage is a pure function of
`(zones, health)`, so it re-derives identically on every host and needs no event
of its own — though a `componentBroken` event is worth adding anyway so the
client can play a glass-tinkle at the right moment rather than noticing on the
next frame.

### R5 — Tell the player (fixes D5, D6)

Three small pieces, and the cheapest real improvement in the list:

1. Add `{ type: 'vehicleCollided'; tick; x; y; speed; vehicleId }` to `SimEvent`
   and push it from both branches of `integrateVehicle`. Add `crash` and
   `crunch` entries to `audio.json` — low-frequency noise bursts, gain scaled by
   closing speed, the same shape as `propDown`.
2. Handle `vehicleBurning` in `onGameEvent`: a fire sound, and if the burning
   vehicle is the one the local player is driving, `hud.notice('get out — she's
   going up')` plus a red pulse. The event already carries `vehicleId`, so the
   check is one comparison against `predictor.predictedVehicle?.id`.
3. Put a vehicle condition bar on the HUD while driving, beside the fitting
   readout. `carWear` is already computed and already crosses into `main.ts`; it
   currently goes only to the debug overlay. With R4 landed this becomes a small
   car outline with the broken components picked out — the standard damage
   diagram, and a far better readout than a bar.

### R6 — A price on damage (fixes D8)

- Add repair to `shop.json` at the `spray` shop — the drive-through path already
  exists for resprays and fittings (`economy.ts:184-187`), so this needs only a
  new `SimCommand`. With R4 there are two sensible tiers rather than one:
  **panel-beating** (~150) clears `zones` and the cosmetic bits — dents, bumpers,
  glass, lamps — and **a rebuild** (~350) also clears the radiator and tyres and
  restores `health`. Cosmetic damage being cheap to fix and mechanical damage
  dear is the right shape: it makes "is this worth fixing?" a question.
- Scale the crush payout by condition in `tryCrush` — `Math.floor(base × bonus ×
  (1 − wear × 0.6))`, with a further deduction per broken mechanical component.
  That makes "drive it there carefully" a skill, gives the export list teeth, and
  closes the loop with the repair shop: it can be worth paying 150 to recover 400
  of crush value.
- Refuse to crush a `wreck` outright, or pay scrap for it.

### R7 — Quantise `health` (fixes D9)

Round collision and blast damage to whole numbers in `damageVehicle` and write
health as a `u8` percentage or a `q8`. Saves 7 bytes per changed vehicle per
snapshot — which is what pays for R4's six — and makes R4's thresholds land on
stable integers instead of flickering on a fractional boundary. Do this
alongside R3, because rounding changes balance and the two should be tuned
together.

### R8 — Consequences for stunts and bail-outs (addresses G4, G5)

- Landing damage in `stepStunts` proportional to `vz` at touchdown, routed to the
  front zone so a bad landing takes out the lights and the radiator — which is
  exactly what R4 makes expressible. It also gives `stuntLanded` a reason to
  carry impact speed.
- A speed check in `tryExitVehicle`: above ~60 px/s you take a tumble — health
  cost scaled by speed and a brief `mode` where you cannot shoot. That turns
  the burn fuse into the decision it was designed to be.

---

## 5. Suggested order

| # | Change | Fixes | Size | Risk |
|---|---|---|---|---|
| 1 | R5 — crash event, sound, burning notice, HUD readout | D5, D6 | S | low |
| 2 | R1 — oriented collision box from both extents | D1 | M | medium |
| 3 | R2 — mass in shove, heading and damage | D2 | S | low |
| 4 | R3 + R7 — rebalance, debounce, quantise health | D3, D9 | S | medium |
| 5 | R4 — damage map: zones, components, lights, progressive dents | D4, G1, G2 | L | medium |
| 6 | R6 — two-tier repair, condition-scaled crush payout | D8 | S | low |
| 7 | R8 — landing damage, bail-out tumble | G4, G5 | S | low |

R5 first because it is the cheapest and the player currently dies to a system
that never speaks. R1 second because it is a live bug degrading every car in the
city. R3 must not land before R1, or quadrupled collision damage lands on a
broken collision test — and R4 must not land before R3, because its ladder is
calibrated in fractions of health that today's collisions cannot reach.

R4 is the largest item and the one that answers "the body should be a little
dented, and a light should break". It is deliberately last of the mechanical
work: it wants a collision system that reports *where* it hit (R1), a damage
scale that reaches its thresholds (R3), and an integer health field to hang them
off (R7). Landed on top of those three it is mostly rendering.

D7 (surviving your own explosion) and D10 (the two dead lines) are one-line fixes
that can ride along with whichever change is nearest.

Not recommended: rigid-body physics (G3). The arcade model is a deliberate,
documented choice and prediction depends on how cheap it is. R1 and R2 recover
most of what a rigid body would buy without touching that.

---

## 6. What was built

All of §4 landed, in the order §5 proposed. `299 tests green`, 6-bot lockstep
with `0 desyncs`, and a recorded session re-simulates to an identical hash.

| # | Change | Where |
|---|---|---|
| R1 | Oriented body box, SAT, sized from both vehicles | `sim/vehicle.ts` `boxesOverlap` |
| R2 | Mass in the shove, the heading deflection and the damage split | `sim/vehicle.ts` |
| R3 | `collisionDamagePerSpeed` 0.055 → 0.21, contact debounce | `data/vehicles.json`, `GameState.vehicleHitTick` |
| R4 | `zones[4]` + `broken` bitfield, breakage ladder, parts | `sim/vehicleDamage.ts`, `render/renderer.ts` |
| R5 | `vehicleCollided` / `vehiclePartBroke` events, four sounds, HUD diagram | `sim/events.ts`, `data/audio.json`, `render/hud.ts` |
| R6 | `panelbeat` / `rebuild`, condition-scaled crush payout | `data/shop.json`, `economy.ts` |
| R7 | Integer health, varint on the wire | `sim/vehicleDamage.ts`, `net/binary.ts` |
| R8 | Landing damage to the front zone, bail-out tumble | `sim/frenzy.ts`, `sim/vehicle.ts` |

Protocol 4. There is a contact sheet at `/damage-sheet.html` that draws one car
at every rung of the ladder through the real renderer — the quickest way to
check the drawing after touching any of it.

### Three regressions, all of them real bugs

Landing R1 broke three existing tests. None of them was the test being wrong.

1. **The traffic IDM measured gaps with `halfExtent`.** With a true-length body
   the follower believed it had six pixels of room at the moment the bumpers
   touched, so queues closed up until they collided and the wedged driver
   reversed out. `scanAhead` now projects each obstacle's box onto the
   follower's axes. The obstacle model has to agree with the contact model.
2. **Reverting the whole move on any overlap.** Two interpenetrating vehicles
   could never separate — every escape was undone. A move that increases the
   distance between the centres is now always allowed, which is what "momentum
   transfer, not a brick wall" was supposed to mean in the first place.
3. **`motorise` gave a cruiser to every officer on the same spot.** Pairs of
   them spent chases interpenetrating and shuffling apart at walking pace. The
   officer without room stays on foot.

### Where this document was wrong

- **Wire cost.** §4.6 predicted the damage map would be net −1 byte, on the
  assumption that quantising health would free seven. Measured: health as a
  varint is +2 bytes where the f64 was +8, so it frees six, and `zones` +
  `broken` cost eight. A damage patch is therefore about **+2 bytes** against
  the health-only patch it replaces — and still nothing at all on a car that
  has not been hit this tick. The conclusion (it is cheap) held; the arithmetic
  did not.
- **D7 was fixed by tuning, not by reordering.** The plan implied moving the
  driver ejection relative to the blast. Raising `explosionDamage` from 85 to
  110 is the honest fix: 85 against a 100 HP player is simply not lethal, and
  110 is, while armour still saves you — which is what armour is for.

### Still open

- **G3, lateral and angular velocity.** Not attempted, as recommended. A shunt
  still deflects a heading rather than imparting spin.
- **G6, a burning car is invulnerable.** Unchanged: `damageVehicle` still
  returns early unless `condition === 'ok'`, so a rocket into a row of burning
  cars still does nothing.
- **G7, a wreck cannot be shoved.** Unchanged.
