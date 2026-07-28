# Car breakdown and damage — investigation

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
Measured, two cars at cruise speed with a fixed 16 px lateral separation:

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

### D4 — `vehicleBurning` is emitted, encoded, relayed, and handled by nobody

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

### D5 — A car crash makes no sound

`integrateVehicle` emits no event on impact — not for a wall, not for another
vehicle. There is consequently no crash sound in `audio.json` (the sound list is
`pistol, smg, shotgun, copPistol, fists, impact, thud, death, propDown, pickup,
explosion`) and no way to add one without adding the event first. Shooting,
punching, running someone over, smashing a bin and blowing something up all have
an event and a sound. Hitting a bus at 200 px/s is silent.

### D6 — You survive your own car exploding

`explosionDamage` is 85 (`vehicles.json`) against a player pool of 100, and
`explode` (`vehicleDamage.ts:121-139`) fires the blast *before* ejecting the
driver, whose position is pinned to the vehicle's (`step.ts:87-89`). So a
full-health, unarmoured player standing at the exact centre of their own
detonating car walks out with 15 HP. The fuse is meant to be a decision — bail
or ride it out — and the wrong answer is currently survivable.

### D7 — Damage has no economic weight

- The respray (`step.ts:190-201`) clears heat, wanted level and cop interest.
  It does not touch `health`. There is no repair anywhere in the game.
- The shop catalog has a `heal` item kind for players (`clinic`) and no
  equivalent for vehicles (`shop.json`).
- The crusher pays `base × exportBonus` by vehicle **kind** only
  (`economy.ts:305-307`). A car one shunt from bursting into flames exports for
  exactly what a showroom one does.

So damage costs the player handling and nothing else, and there is no sink for
the money the crusher prints.

### D8 — `health` is an f64 on the wire

`binary.ts:435` writes `w.f64(v.health)` while every other vehicle field is
quantised — `q8` for position and speed, `q256` for heading, `u8` for condition.
Eight bytes for a number whose only consumers are a `> 0` test and a 0..1 wear
ratio that feeds a 7-step dent count and a power multiplier. Collision damage
produces fractional values (5.72, 10.0…), so the float is load-bearing today,
but only because nothing rounds.

### D9 — Two small dead things

- `shared/test/vehicleDamage.test.ts` imports `roadLane` twice, at line 11 and
  again at line 20. It survives because tests are not type-checked —
  `shared/tsconfig.json` has `"include": ["src"]` — and esbuild tolerates it.
- `renderer.ts` calls `layRubber` twice in `drawVehicle`, at line 702 and line
  741. Harmless (the first call has already overwritten `skidState`, so the
  second sees `dtMs === 0` and returns), but it is a duplicated line.

---

## 3. What the model cannot express

These are not bugs; they are the shape of the design.

**G1 — One scalar, no components.** Wear drives exactly two effects. There is no
engine smoke stage before fire, no blown tyre, no dead headlight, no bonnet up.
A car at 90 % wear and a car at 55 % wear differ only by dent count and a few
percent of top speed.

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
makes the burn fuse a non-decision as soon as you know about it (see D4).

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
- Return the minimum-translation vector as well as the boolean, which R2 needs.

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

### R3 — Make ramming worth doing (fixes D3)

With R1 and R2 landed the numbers can be re-derived rather than guessed. Targets
I would aim at: a full-speed head-on into a wall costs ~15 % of a car's health
(≈7 impacts to destroy, not 27); a full-speed ram into a parked car costs the
victim ~25 % and the striker ~15 %; a truck flattening a car in three hits while
taking a scratch. That is `collisionDamagePerSpeed` roughly tripled for the
striker and mass-divided for the receiver.

Add a **repeat-contact debounce** at the same time — a `lastCollisionTick` on
`VehicleState`, ignoring damage from the same pair within ~4 ticks. Without it,
tripling the coefficient turns the held-throttle-against-a-wall case into an
instant kill, and R1 will not fully prevent sustained overlap.

### R4 — Tell the player (fixes D4, D5)

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
   currently goes only to the debug overlay.

### R5 — A price on damage (fixes D7)

- Add a `repair` item to `shop.json` at the `spray` shop — the drive-through
  path already exists for resprays and fittings (`economy.ts:184-187`), so this
  needs only a new `SimCommand` (`repairVehicle`) restoring
  `getVehicleTuning(kind).health`. Price it against `sprayCost` (400); somewhere
  near 250 for a full repair feels right against a crush payout.
- Scale the crush payout by condition in `tryCrush` — `Math.floor(base × bonus ×
  (1 − wear × 0.6))`. That makes "drive it there carefully" a skill, gives the
  export list teeth, and closes the loop with the repair shop: it can be worth
  paying 250 to recover 400 of crush value.
- Refuse to crush a `wreck` outright, or pay scrap for it.

### R6 — A breakdown ladder rather than a slider (addresses G1)

Keep `health` as the single authoritative number — it is the right call for the
wire and for determinism — and derive *stages* from wear rather than adding
state:

| wear | effect |
|---|---|
| > 0.35 | engine smoke: a grey particle from the bonnet at a wall-clock cadence, client-side only |
| > 0.55 | headlights dead — skip the light cones in `drawVehicle` |
| > 0.75 | heavy smoke, and the power loss curve steepens |
| = 1.00 | fire, as today |

All four are pure functions of `vehicleWear`, so they cost nothing on the wire
and cannot desync. The smoke stage is the one that matters: it is the warning
that the burn fuse currently does not give (D4), and it makes a damaged car
readable from across the street, which is what the dents were reaching for.

### R7 — Damage direction (addresses G2)

Extend `damageVehicle` with an optional impact point. Store a small fixed-size
per-vehicle damage vector — four `u8` zone accumulators (front/rear/left/right)
is 4 bytes and quantises cleanly. Then:

- dents land where the car was actually hit, replacing the id hash in
  `drawDents` (`renderer.ts:596-635`);
- the steering pull's sign can come from left/right asymmetry rather than
  `pullSign(id)`, which is currently an admitted stand-in (`vehicle.ts:143-150`);
- a front-heavy hit can be made to cost more power and a side hit more grip.

This is the largest change in the list and I would not do it before R1–R4.

### R8 — Consequences for stunts and bail-outs (addresses G4, G5)

- Landing damage in `stepStunts` proportional to `vz` at touchdown, so a big
  jump is a gamble rather than free money. It also gives `stuntLanded` a reason
  to carry impact speed.
- A speed check in `tryExitVehicle`: above ~60 px/s you take a tumble — health
  cost scaled by speed and a brief `mode` where you cannot shoot. That turns
  the burn fuse into the decision it was designed to be.

### R9 — Quantise `health` (fixes D8)

Round collision and blast damage to whole numbers in `damageVehicle` and write
health as a `u8` percentage or a `q8`. Saves 7 bytes per changed vehicle per
snapshot, and makes the wear ladder in R6 land on stable thresholds instead of
flickering on a fractional boundary. Do this *after* R3, because rounding
changes balance and the two should be tuned together.

---

## 5. Suggested order

| # | Change | Fixes | Size | Risk |
|---|---|---|---|---|
| 1 | R4 — crash event, sound, burning notice, HUD bar | D4, D5 | S | low |
| 2 | R1 — oriented collision box from both extents | D1 | M | medium |
| 3 | R2 — mass in shove, heading and damage | D2 | S | low |
| 4 | R3 — rebalance + repeat-contact debounce | D3 | S | medium |
| 5 | R5 — repair item, condition-scaled crush payout | D7 | S | low |
| 6 | R6 — smoke/lights breakdown ladder | G1 | S | low |
| 7 | R9 — quantise health | D8 | S | low |
| 8 | R8 — landing damage, bail-out tumble | G4, G5 | S | low |
| 9 | R7 — directional damage zones | G2 | L | medium |

R4 first because it is the cheapest and the player currently dies to a system
that never speaks. R1 second because it is a live bug degrading every car in the
city. R3 must not land before R1, or tripled collision damage lands on a broken
collision test.

D6 (surviving your own explosion) and D9 (the two dead lines) are one-line fixes
that can ride along with whichever change is nearest.

Not recommended: rigid-body physics (G3). The arcade model is a deliberate,
documented choice and prediction depends on how cheap it is. R1 and R2 recover
most of what a rigid body would buy without touching that.
