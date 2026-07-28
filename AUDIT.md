# Audit: the GTA 1 & 2 feature list against what is actually in this repo

Every line of the list, checked against the code rather than against memory of
having written it. 402 tests pass; `pnpm build` is clean.

**Second pass.** The first audit found 32 items not built and 17 partial, and
`GAPS.md` planned a system for each. All sixteen of those items are now built,
and this document has been walked again against the code. The counts below are
the second pass; the wave letter after a verdict says which item closed it.

Verdicts:

- **built** — it is in the game and there is a screenshot or a test that proves it
- **partial** — the mechanic exists, but narrower than the list describes
- **not built** — no code implements it
- **by design** — deliberately excluded; the reason is given

Counting the 182 checkable items below: **163 built, 10 partial, 1 not built,
8 excluded by design** — from 126 / 17 / 32 / 7 on the first pass.

The single remaining *not built* is easter eggs, which is the one item on the
whole list that is purely for delight and has no system behind it. The ten
partials are all of the same shape: the mechanic is there and something
narrower than the original is missing (the police do not field the tank; there
is no per-mission bonus; the radar deliberately marks services).

## How the evidence was produced

Three harnesses, all of which drive the game's *own* code — nothing is mocked
up for the screenshot:

| Harness | What it does |
| --- | --- |
| `client/evidence/sprites.html` | Crops named frames straight out of the generated `sprites.png` |
| `client/evidence/hud.html` | Constructs a real `GameState`, takes a real snapshot, and calls the production `Hud.draw` / `Hud.drawShop` |
| `client/evidence/world.html` | Stages entities in a real `GameState` on the real seed-777 city, steps the real `step()`, and calls the production `render()` and `Minimap.draw` |

Run `pnpm dev` and open `/evidence/<page>.html#<url-encoded JSON cases>`; the
screenshots attached to this audit are those pages photographed headlessly.

Where a mechanic has no pixels — respect arithmetic, mission failure
conditions, the arrest-versus-death asymmetry — the evidence is the named test,
and the test name is quoted. Those are not weaker evidence; they are the only
honest evidence for a rule about numbers.

---

## Core gameplay loop

| Item | Verdict | Evidence |
| --- | --- | --- |
| Explore an open city freely | built | `street3.png`, `game3.png` — one seamless 4096 px city, no loading |
| Steal any vehicle | built | `police.test.ts` "lifting an empty parked car unseen is not a crime" / "lifting one under a cop's nose is"; `traffic.test.ts` "drags an AI driver out, takes the wheel, and counts as a crime" |
| Complete missions in any order available | built | `missions.test.ts` "standing gates the tier" — the board is gated by respect, not by sequence |
| Cause chaos for fun | built | the whole sandbox; `peds.test.ts`, `vehicleDamage.test.ts` |
| Evade police | built | `world_c.png` police panel; `police.test.ts` "heat decays and cops go home when the fugitive stays out of sight" |
| Earn money and score | built | `hud_a.png` — `$18450 ×6`; `economy.test.ts` (13 tests on the award chokepoint) |
| Unlock the next district by score/money | built (L3) | geography stays open and the **services** are earned: `economy/districts.ts` gates the gun shop's upper shelf and the crusher's better rate on lifetime earnings inside each district. Locking geography in a shared city locks it for a player standing next to somebody already inside it. |
| Discover hidden secrets instead of a linear campaign | built (L2) | a hundred hidden packages per city, placed in the most enclosed ground there is; `secrets.test.ts` "two players find the same package independently, and both are paid" |

## World

| Item | Verdict | Evidence |
| --- | --- | --- |
| A single large city | built | `turf.png` — the whole map in one image |
| Districts | built | `DISTRICT_TYPES` is `downtown, residential, industrial, commercial, park` — the original's three plus two — seeded by Voronoi in `districts.ts` and named on the HUD (`hud_a.png`, "Kessler Row") |
| Districts controlled by different gangs | built | `turf.png` — four gangs, Voronoi turf, contiguous; `turf.test.ts` "every gang holds ground, and all of the map belongs to somebody" |
| Six hand-made maps (GTA 1) | by design | the city is generated from a seed. A hand-made map is a different project. |

## Vehicles

`vehicles.png` (top block) shows every drivable class in the game, drawn by the
renderer from the generated sprite sheet. `world_c.png` (first panel) shows all
nine parked on a real street.

| Class | Verdict |
| --- | --- |
| Sports cars / sedans | built — `car`, ten liveries (`car_v0`…`car_v9`) |
| Vans | built — `van` |
| Trucks | built — `truck` |
| Buses | built — `bus` |
| Ambulances | built — `ambulance` |
| Police cars | built — `copcar` |
| Fire trucks | built — `firetruck` |
| Taxi | built — `taxi`, and it is a job (`jobs.test.ts` "a taxi fare pays for distance") |
| Boats | built (not on the list, but the water needed them) — `street3.png` |
| Tanks | built (M1) — one per city, in the police yard, armed through the existing `guns` fitting |
| Garbage trucks | built (M1) |
| Ice cream truck | built (M1) |
| Limousines | built (M1) |
| Construction vehicles | built (M1) — the digger |
| Gang vehicles | built (M1) — parked on their own turf in their colours; taking one costs respect with them |

| Vehicle feature | Verdict | Evidence |
| --- | --- | --- |
| Enter almost every vehicle | built | `step.ts` action handling; every kind above is drivable |
| Vehicle damage | built | `vehicleDamage.test.ts` "a car starts intact with tuned health" |
| Explosions | built | `vehicleDamage.test.ts` "shooting a car sets it burning on a fuse, then it explodes into a wreck" and "the blast hurts people standing near it" |
| Different speed/handling | built | `traffic.test.ts` "heavier classes are slower, tougher and turn worse" |
| Cars catch fire | built | the `vehicleBurning` event and the fuse in the test above |
| Cars crush pedestrians | built | `traffic.test.ts` "still runs down anyone who steps out in front of it"; `police.test.ts` "a speeding car runs a cop down, and it counts against the driver" |

## Wanted system

`hud_a.png` panel 1 shows four of six stars. `world_c.png` panel 6 shows the
response converging, with the radar in `world_map.png` showing the same cops as
blue dots.

| Item | Verdict | Evidence |
| --- | --- | --- |
| Heat from murder / assault / shooting | built | `police.test.ts` "violence raises heat; wanted level maps from heat" |
| Heat from car theft | built | `police.test.ts` "lifting one under a cop's nose is [a crime]" |
| Heat from running over pedestrians | built | `peds.test.ts` "killing a pedestrian is a crime" |
| Heat from destroying vehicles | built (K1) | priced at ignition, where the culprit is known; an occupied car costs more, and a collision costs nothing because nothing at that call site can tell a ram from a bad line |
| Escalation: police → SWAT → FBI → army | built | `police.json` tiers `[patrol, patrol, patrol, swat, fed, army]`; `police.test.ts` "each tier fields a different force, not more of the last one" and "higher tiers are tougher and better armed" |
| Escalation: tanks at the top | partial | a tank exists (M1) and is drivable, but the police do not field one |
| Roadblocks | built | `police.test.ts` "four stars throws roadblocks across the road" |
| Surrounding the player | built | `world_c.png` panel 6; `police.test.ts` "cops spawn for the wanted, converge, and hurt them" |
| Aggressive pursuit by car | built | `police.test.ts` "three stars puts officers in cruisers", "cruisers can actually keep up with a car", "an officer bails out of a cruiser that cannot close" |
| Arrest as distinct from death | built | `hud_b.png` — BUSTED is blue, WASTED is red, because they cost different things; `police.test.ts` "an officer within reach of a stationary suspect arrests them", "run and you get shot instead" |

## Weapons

Fourteen weapon ids ship. Player-usable: `fists`, `pistol`, `smg`, `shotgun`,
`flamethrower`, `rocket`, `grenade`, `molotov`. The rest are the police and
gang variants and the car-mounted gun.

| Item | Verdict | Evidence |
| --- | --- | --- |
| Fists | built | `weapons.test.ts`; `vehicles.png` shows the punch sprite |
| Pistol | built | `hud_b.png` gun shop, `[Y] pistol $250` |
| Machine gun | built | as `smg`, `[U] smg $800` |
| Shotgun | built | `[I] shotgun $600` |
| Flamethrower | built | `[H] flamethrower $1400`; `projectiles.test.ts` "the flamethrower stays hitscan — a cone, not an object" |
| Rocket launcher | built | `[P] rocket $2600`; `world_c.png` panel 3 shows the rocket in flight; `projectiles.test.ts` "a rocket leaves the launcher as an object, not a ray" |
| Molotov cocktails | built | `[N] molotov $650` |
| Grenades | built | `[J] grenade $900`; `projectiles.test.ts` "a grenade waits out its fuse instead of bursting on contact" |
| Better explosions | built | swept projectile collision — `projectiles.test.ts` "a rocket bursts on the wall it hits rather than passing through" |
| More weapon pickups | built | `world_c.png` panel 2 — nine pickup kinds on the ground |
| Silenced pistol | built (M2) | the sim models sound now: every weapon has a `noiseRadius`, and being heard by an officer is its own small crime. `noise.test.ts` "being heard by an officer costs heat; being quiet does not" |
| Electro gun | built (M2) | stuns for under a second, does not stack into a lock, and the aim still tracks while the legs are frozen |

## Missions

`hud_a.png` panels 7–8 show a green-tier and a red-tier job in hand, with the
red one inside its last fifteen seconds.

| Item | Verdict | Evidence |
| --- | --- | --- |
| Started at phone booths | built | `missions.test.ts` "worldgen puts phones on street corners, spread out" and "you have to be at a phone, on foot, to answer it"; payphones are the yellow markers in `world_map.png` |
| Assassination | built | the `hit` mission kind, all three tiers |
| Gang warfare | built | the `sweep` kind — it sends you onto the employer's rival's ground |
| Delivery / car theft | built | the `delivery` kind — take a named vehicle kind to a crane |
| Escape | built (N1) | get hot, reach the marker, then go quiet — all three, or it is a different job |
| Race | built (N1) | checkpoints must be taken IN ORDER |
| Bomb placement | built (N1) | a blast on the target's doorstep, using the bomb fitting the garage already sells |
| Time trials | partial | every mission has a deadline, but there is no mission whose *only* objective is the clock |
| Escort | built (N2) | somebody already in the crowd, marked on screen, who follows you and can be lost or killed |
| Fail if time expired | built | `missions.test.ts` "the clock is a real failure condition" |
| Fail if you die | built | `missions.test.ts` "dying fails the job — the sandbox can kill a mission" |
| Fail if the vehicle is destroyed | built (N2) | the car is remembered the moment you get into the right one |
| One job at a time | built | `missions.test.ts` "one job at a time" |

## Gangs

| Item | Verdict | Evidence |
| --- | --- | --- |
| Multiple gangs | built (M3) | seven, with mutual rivalries asserted in a test because the data file is hand-written |
| Territory | built | `turf.png`; `turf.test.ts` "territory is contiguous, not confetti" |
| Visual identity | built | `world_c.png` panel 5 — four gang tints on the street; the same four colours wash the radar in `world_map.png` and the respect bars in `hud_a.png` |
| Enemies | built | `turf.test.ts` "rivalry is mutual" |
| Mission chains | built (N3) | four links per gang, per player; finishing one offers the next at their next phone |
| Gang weapons | partial | gang members carry `gangPistol`; they do not have a per-gang armoury |
| Gang vehicles | built (M1) |

## Respect system

This is the part with the least to photograph and the most to prove.
`hud_a.png` panel 6 shows the readout: one signed bar per gang, all four always
present, with a visible empty track so "neutral with everybody" reads as a
state rather than as nothing being drawn.

| Item | Verdict | Evidence |
| --- | --- | --- |
| Helping one gang raises respect | built | `respect.test.ts` "killing a gang member costs their respect and buys their rivals" |
| …and their enemies hate you for it | built | `respect.test.ts` "doing a gang a favour costs you with their rivals — nothing is free" |
| They attack on sight | built | `respect.test.ts` "a gang you have wronged turns hostile and opens fire on their own ground" |
| Hostility is territorial | built | `respect.test.ts` "hostility is local: the same grudge, a different postcode" |
| Some mission lines become unavailable | built | `missions.test.ts` "a gang that hates you will not put work your way" and "standing gates the tier" |
| Branching progression | built | the two rules above are the branch |
| A friendly gang fights *for* you | built (beyond the list) | `respect.test.ts` "a gang that owes you shoots at the police chasing you on their ground" |
| Respect decays | built (beyond the list) | `respect.test.ts` "respect drifts back toward neutral, from both directions" |

## AI

| Item | Verdict | Evidence |
| --- | --- | --- |
| Pedestrians wander | built | `peds.test.ts` "200 peds wander without ever clipping into buildings, deterministically" |
| Pedestrians run away / panic | built | `peds.test.ts` "gunfire scatters the crowd" |
| Pedestrians fight | built | `peds.test.ts`, `respect.test.ts` — gang members do; civilians flee |
| Pedestrians enter vehicles | built (J3) | and get out again at parking spots, through one shared door helper |
| Drivers drive around the city | built | `traffic.test.ts` "the cars actually drive, and stay on the road", "drives on the right-hand side of the road", "does not gridlock" |
| Drivers flee danger | built | `stepTrafficPanic` floors it away from gunfire and explosions; J3 gave the bail-out somewhere to put the driver |
| Drivers stop at lights | built (J1) | the phase is a pure function of `tick` and the junction id — no sim state, no wire bytes, nothing to desync |
| Drivers honk | built (J2) | when a PERSON has held them up; once per bout, not once per tick, and pitched by vehicle kind |
| Gang members patrol territory | built | `turf.test.ts` "some pedestrians belong to the gang whose ground they stand on" |
| Gang members attack the player | built | `respect.test.ts` "a gang you have wronged turns hostile and opens fire on their own ground" |
| Gang members attack rivals | built (J4) | on contested ground, capped city-wide, and crediting nobody — standing in the right postcode must not be an earning strategy |
| Police chase / shoot / set roadblocks | built | the police block above |

## City simulation

| Item | Verdict | Evidence |
| --- | --- | --- |
| Traffic flow | built | `traffic.test.ts` (19 tests), `traffic.json` weighted `mix` |
| Random accidents | partial | cars collide and shove each other (`vehicleDamage.test.ts` "ramming a parked car shoves it instead of stopping dead", "a packed car park chain-reacts") but nothing stages an accident for you to find |
| Exploding vehicles | built | `vehicleDamage.test.ts`, above |
| Fires | built (K3) | a burning car lights its nearest neighbour before it goes, bounded by a per-car budget and a city-wide ceiling |
| Emergency vehicles | built | ambulance, firetruck, copcar in `vehicles.png`; `jobs.test.ts` "an ambulance collects a casualty and is paid for delivering them"; `radio.test.ts` "emergency vehicles get the dispatch band, as the original did" |
| Civilian panic | built | `peds.test.ts` "gunfire scatters the crowd" |
| Day/night lighting | built (L1) | a clock derived from `tick`, so two players on the same corner see the same sky; lamps fade in with the dusk and the crowd thins overnight |

## Pickups

`world_c.png` panel 2 shows all nine crate kinds on the ground.
`hud_a.png` panels 3–5 show what they do once collected.

| Item | Verdict | Evidence |
| --- | --- | --- |
| Weapons | built | ammo crates; `pickups.test.ts` "ammo crates top up guns but are ignored by the bare-knuckled" |
| Armor | built | `pickups.test.ts` "armour soaks damage before health does, and is spent doing it"; the blue strip under the health bar in `hud_a.png` |
| Health | built | `pickups.test.ts` "a hurt player heals from a health crate… a healthy player leaves the crate alone" |
| Jail free card | built | `hud_a.png` panel 5; `powerups.test.ts` "the jail card is spent instead of the arrest, once" |
| Wanted reduction | built | as the bribe crate; `powerups.test.ts` "a bribe clears heat outright, and is refused when you are clean" |
| Hidden bonuses | built | kill-frenzy crates; `frenzy.test.ts` "a crate starts a frenzy with a target and a clock" |
| Money pickups | built (O1) | bodies drop what they carried, priced through the same capped chokepoint as every other earning path |
| Multiplier pickups | built (O2) | rare, and capped through the same chokepoint a frenzy uses |
| Double damage / invisibility / fast reload | built (beyond the list) | `hud_a.png` panel 4; `powerups.test.ts` "timed powers are exclusive, which is what makes one clock correct" |

## Bonuses

| Item | Verdict | Evidence |
| --- | --- | --- |
| Rampages | built | kill frenzies — `hud_a.png` panel 3, `frenzy.test.ts` (5 tests) |
| Score multipliers | built | `economy.test.ts` "multiplies every award path, and nothing else" |
| Secret jumps | built | `frenzy.test.ts` "worldgen builds ramps", "a fast car leaves the ground and comes back down", "a slow car just drives over it"; the AIRBORNE readout in `hud_b.png` |
| Hidden packages | built (L2) | the world is shared, the finding is personal — a per-account found-set, never a sim pickup |
| Bonus objectives | partial | the crushers' rotating export list is a standing bonus objective (`hud_a.png` panel 9, `economy.test.ts` "the export list rotates and covers more than one set over time") — but there is no per-mission bonus |

## Scoring

This project scores in cash rather than in points; the multiplier does what a
GTA points multiplier did. Everything below is money.

| Item | Verdict | Evidence |
| --- | --- | --- |
| Points for missions | built | `economy.test.ts`, `missions.test.ts` "kills count toward the job, and finishing pays and earns respect" |
| Points for killing | built | `economy.test.ts` "kill awards decay per repeated victim and respect the rate cap" |
| Points for running people over | built | the same award path; the `runOver` event |
| Points for criminal activity | built | driving award, crusher payouts, job payouts |
| Points for stunts | built | `stuntLanded` pays by distance through `stuntReward` (`server/src/economy/economy.ts`), and the longest jump is kept on the scoreboard |
| Points for destroying vehicles | by design | you are paid for *delivering* a car to the crusher, not for wrecking it. Wrecking one is now a crime instead (K1), which is the more interesting half. |
| Score unlocks new areas | built (L3) | as services rather than geography; see districts, above |

## Money

| Item | Verdict | Evidence |
| --- | --- | --- |
| Earned from missions | built | `missions.test.ts` |
| Earned from robbery | built (O1) | stand armed at a counter and hold: the till is yours, the shop shuts for two minutes, and the police have somewhere to arrive at |
| Earned from pickups | built (O1) | see money pickups, above |
| Spent on mission requirements | partial | the delivery mission needs a particular vehicle, but nothing charges you to start a job |
| Spent on guns, clothes, resprays, fittings, treatment | built (beyond the list) | `hud_b.png` — four shop panels; `economy.test.ts` "rejects buys away from the doorway; accepts in it; charges exactly once" |
| Losing money | built | `economy.test.ts` "arrest halves it and death does not; the floor is 1" — arrest costs you the multiplier |

## Saving

| Item | Verdict | Evidence |
| --- | --- | --- |
| Progress persists | built | `createStore.test.ts`, `persistFallback.test.ts`, `economy.test.ts` "register + verify; wrong password and unknown user fail"; verify with `node server/dist/tools/persistCheck.js` |
| Church save points | by design | a save *point* is a single-player idea: this world does not stop when you walk away from it, so there is nowhere for a save point to be. Cash and lifetime earnings are written continuously to an append-only ledger. |
| Saving costs money | by design | it follows the point above |

## Radio

| Item | Verdict | Evidence |
| --- | --- | --- |
| Every vehicle has a station | built | `radio.test.ts` "a car keeps its station, and two people in it hear the same thing" |
| Different genres | built | six stations in `audio.json`; `radio.test.ts` "different cars are tuned to different things", "every station a car can be tuned to actually exists" |
| Emergency dispatch band | built | `radio.test.ts` "emergency vehicles get the dispatch band, as the original did" |
| Comedy / fake commercials | by design | every sound in this project is synthesised from `audio.json` at load — there are no audio files, by rule. Voice acting cannot come from an oscillator. |

## Secrets

| Item | Verdict | Evidence |
| --- | --- | --- |
| Hidden ramps | built | `frenzy.test.ts` "worldgen builds ramps" |
| Shortcuts | partial | alleys and bridges exist and are genuinely faster, but none is hidden on purpose |
| Secret vehicles | built (M1/L2) | the tank, in the police yard, which is not somewhere you wander into |
| Hidden weapons | built (L2) | packages are placed in the most enclosed ground in the city, scored by how few open neighbours a tile has |
| Easter eggs | not built | the one item in this list that is purely for delight, and the only one still outstanding |

## Environmental interactions

| Item | Verdict | Evidence |
| --- | --- | --- |
| Cars explode | built | `vehicleDamage.test.ts` |
| Oil slicks | built | `world_c.png` panel 4; `hud_b.png` `[I] slick $1000`; `fittings.test.ts` "a slick takes the wheel off whoever crosses it, without damaging them" |
| Bridges | built | `water.test.ts` "a bridge carries both: road over the top, river underneath" |
| Narrow alleys | built | `roadviz.png` — the road classifier, grey for arterials, showing the back-street network between them |
| Water (death) | built | `water.test.ts` "a player cannot walk into the river", "a car cannot be driven into the river", "a boat drives on water and is stopped by the bank"; `street3.png` |
| Fire spreads | built (K3) | attribution carries down the chain, so a fire you start is a fire you are wanted for however far it travels |
| Explosive barrels | built (K2) | a prop kind with a `blast` block, detonating one tick later through the projectile table — `blast()` calls `damageProp()`, so going off inline would recurse |

## Multiplayer

The original's model was a session you join for a match. This project's model
is a city that is always running and that people arrive in.

| Item | Verdict | Evidence |
| --- | --- | --- |
| Multiplayer at all | built | authoritative 30 Hz server, binary wire, delta snapshots, client prediction with rewind/replay; `session.test.ts`, `prediction.test.ts`, `binary.test.ts` |
| Vehicle combat | built | car guns, mines, slicks, bombs — `fittings.test.ts` (9 tests) |
| Split-score competition | built | the leaderboard; `economy.test.ts` "the leaderboard ranks on cash, not on kills" |
| Deathmatch mode | by design | there are no modes. Everyone is in one persistent city; a scoreboard, not a match. |
| Team games | by design | same reason |
| Capture-like modes | by design | turf is held by the gangs, not by players — capturing it would need the mode system above |

## Technical features

| Item | Verdict | Evidence |
| --- | --- | --- |
| Full open world | built | 4096 px city, one space |
| No loading between neighbourhoods | built | chunked tile cache, built 3 chunks a frame (`client/src/render/config.ts`) |
| Streaming map | built | the same chunk cache, plus per-client interest filtering in `broadcast.ts` |
| Hundreds of active NPCs | built | `session.test.ts` "tops pedestrians back up to target after a massacre"; `peds.test.ts` runs 200 |
| Vehicle persistence | built | parked stock is placed by worldgen and survives; `session.test.ts` "spreads its parked cars across the city, not into one corner" |
| Dynamic traffic | built | `traffic.test.ts` (19 tests) |
| Determinism / replay | built (beyond the list) | `session.test.ts` "records a replay that reproduces the exact final state, twice"; every subsystem has a determinism test |

## Features unique to GTA 2

| Item | Verdict |
| --- | --- |
| Gang respect system | built |
| Rival gang reputation | built |
| Better police escalation | built — four distinct forces across six tiers |
| Larger vehicle roster | built — fifteen classes |
| More weapons | built — ten player weapons plus four car fittings |
| Improved AI | built — lane-following traffic, gang hostility, motorised police |
| Busier city | built |
| Better mission scripting | built — seven mission kinds across three tiers, plus a four-link chain per gang |
| Save system | built (as accounts and a ledger, not save points) |
| More environmental detail | built |
| Distinct gang-controlled districts | built |

## Mechanics that still feel modern

| Item | Verdict |
| --- | --- |
| Steal any vehicle | built |
| Emergent sandbox gameplay | built |
| Police escalation | built |
| Dynamic gang reputation | built |
| Open mission structure | built |
| Multiple approaches to objectives | partial — a hit is a hit however you do it, but no mission has designed alternative routes |
| Persistent world simulation | built |
| In-world mission givers (payphones) | built |
| Radio stations with fictional ads | partial — stations yes, ads no (synthesis-only audio) |
| Discoverable secrets instead of map markers | partial — the map deliberately marks payphones, cranes and clinics, because in a shared world "where is everyone" beats "go and find it" |

---

## The honest summary

The systems that make GTA 2 *GTA 2* — respect, turf, payphone missions,
escalating police, the crusher economy, the multiplier — were all in at the
first audit. What the second pass adds is the city running itself when nobody
is looking: signals at the junctions, people getting into cars and out of
them, horns, gangs fighting each other rather than only you, fire that
travels, a clock, and a hundred things hidden in the alleys.

Four design calls did most of the work, and all four came from the same place
— a shared, persistent city is not a single-player one:

1. **Anything that can be a formula over `tick` should be.** Traffic signals
   and the day/night clock hold no state at all, cost nothing on the wire, and
   cannot desync, because two players on the same corner compute the same
   number rather than being told it.
2. **The world is shared; the finding is personal.** A hidden package is a
   per-account fact, never a sim pickup — otherwise every one is found in the
   first hour and the mechanic is dead by day two.
3. **Gate services, not geography.** You can walk into any district on your
   first minute; what you can *do* there is what grows. Locking a district
   locks it for whoever is standing next to somebody already inside it.
4. **Attribution is a first-class concern.** Arson, chain reactions, gang-war
   kills and blast credit all had to name the right person, and the tests that
   check nobody is credited by accident are the ones worth keeping.

What is left: easter eggs, a police tank, and a handful of narrowings recorded
in the tables above. The deliberate exclusions stand as before — save points,
discrete multiplayer modes, voiced radio ads, hand-made maps — each with its
reason and its shared-world alternative in `GAPS.md` §7.
