# RESEARCH — the two originals, feature by feature

A reference on the mechanics of the two 1997/1999 DMA Design top-down
open-city games, written so that design arguments in `ROADMAP.md` can cite
something concrete instead of somebody's memory of playing them.

This is a **research document, not a spec**. Nothing here is a commitment to
build. Where a mechanic is worth an analogue in this project, §6 says so and
points at the file it would live in. Names, brands, gang names, city names,
radio-station names and music are **not** to be copied — this repo is original
work in the genre, and the value of the research is the *systems*, not the
nouns.

## 0. Method and confidence

Direct page fetches were unavailable from this container: `gta.fandom.com`,
`wikipedia.org`, `grandtheftwiki.com`, `strategywiki.org` and `wikigta.org`
all return **403 at the egress proxy**, which is an environment policy, not a
site outage. Everything below therefore comes from web-search result
summaries (sources listed in §7) plus general knowledge of the games.

Claims are marked:

- unmarked — corroborated by at least one search result quoted in §7;
- **⚠** — believed correct but *not* corroborated by a source I could reach;
  treat as a hypothesis to check before any of it drives a design decision.

---

# 1. The first game (1997)

## 1.1 Frame

Top-down, sprite-based, viewed from directly overhead; the camera zooms out as
speed rises so a fast car still has usable lookahead. Free-roam within the
current level, with the whole city open from the first second — the structural
idea that the genre is built on.

Three cities, each based on a real US one, each visited twice, for **six
levels total**. The player picks one of **eight cosmetic characters** (four
male, four female) — identical in behaviour, differing only in sprite.

## 1.2 Level structure and the target score

Each level is "reach a target score, with five lives to do it in". The score
counter **is** the money counter: the same number pays for respray jobs, and
what you spend is subtracted from your progress toward the target. That single
identity — score is money is progress — is the game's whole economy.

| # | Level | City | Target |
|---|---|---|---|
| 1 | Gangsta Bang | Liberty City | $1,000,000 |
| 2 | Heist Almighty | Liberty City | $2,000,000 |
| 3 | Mandarin Mayhem | San Andreas | $2,000,000 |
| 4 | Tequila Slammer | San Andreas | $3,000,000 |
| 5 | Bent Cop Blues | Vice City | $3,000,000 |
| 6 | Rasta Blasta | Vice City | $5,000,000 |

Freeplay earns: ramming a car, running down a pedestrian, killing a cop,
stealing and selling cars, chaining vehicle explosions (a chain multiplies the
payout per explosion). But the target is set so that **freeplay alone is a
grind** — roughly 14–16 stolen vehicles to clear a target — and jobs are where
the real money is. That's the pressure that makes players take missions
voluntarily rather than being railroaded into them.

## 1.3 The score multiplier

The core loop's amplifier. Every point award is multiplied by the current
multiplier before it lands: at ×3, ramming a car pays 30 instead of 10.
Completing a mission both pays a large lump and **raises the multiplier**, so
the next job pays more again. It is the reason a good run accelerates.

The multiplier is also the punishment currency: **arrest halves it**. Not
death — arrest. See §1.5.

## 1.4 Mission delivery

Missions are taken by **answering ringing public payphones**. Some arrive on
the spot instead, and some trigger on entering a specific vehicle. There is no
mission menu, no marker to drive into: the city rings at you and you choose
whether to pick up. Bosses are voices on the phone, not characters you meet.

## 1.5 Wanted level, arrest, and death

Wanted level rises when police **witness** a crime — the witness condition,
not the crime itself, is what escalates.

| Level | Police behaviour |
|---|---|
| 1 | Minor crime (a few pedestrians, hitting an officer, exploding a car). Police give chase only if already nearby. |
| 2 | Up to two cars actively chase; they shoot or arrest on sight. |
| 3 | First "serious" tier. **Roadblocks**, manned by armoured officers with pistols. Officers run at full speed and take more damage. They deliberately ram the player off the road. |
| 4 | Pedestrians start disappearing from the streets. Roadblocks on major roads, shoot on sight, all available units converge. Machine-gun cops. |

Two ways down from a wanted level, and neither is "wait":

1. drive into a **spray shop** (respray clears it, and costs money — i.e.
   costs score);
2. collect a **police bribe** pickup (a spinning gold coin) in one of a small
   number of fixed places per city.

Consequences differ by outcome, which is the interesting part:

- **Arrested** — dropped at the nearest police station, lose all weapons and
  armour, **lose half the score multiplier**, wanted level reset to zero.
- **Killed** — lose a life (five per level) and your weapons; game over on the
  fifth. ⚠

The design point: arrest is not a soft failure. It costs the thing you spent
the whole level building.

## 1.6 Weapons

A deliberately tiny set, each with one clear role:

| Weapon | Role |
|---|---|
| Fists | Cannot kill. Immobilises a target for a few seconds. |
| Pistol | Slow fire rate, **one-shot kill**. Ammo is everywhere, especially near hospitals and police stations. |
| Machine gun | Rapid fire, limited ammo, found in specific places. Also what police carry at wanted 4. |
| Rocket launcher | Anti-vehicle; buildings catch fire when hit. Rare. |
| Flamethrower | Sets people alight, blows cars up, best against groups. Rare. |

The player dies in **one hit** unless wearing body armour, and armour only
stops bullets. Combat is lethal in both directions — a design choice that
makes cover and cars matter more than aim.

## 1.7 Pickups and power-ups

Around seven pickup types. ⚠ (one source says "seven power-up pickups"; the
enumerated ones are:)

- **Body armour** — absorbs bullet damage, the only thing between you and
  one-shot death.
- **Police bribe** — spinning gold coin, clears the wanted level.
- **Get Out of Jail Free card** — cancels the next arrest. ⚠
- **Multiplier** — raises the score multiplier directly.
- **Extra life**.
- **Speed-up** — awarded for completing all kill frenzies in a level. ⚠
- **Kill frenzy** — see below.

## 1.8 Kill frenzies

Timed rampage side-objectives, marked by a pickup: a weapon with effectively
unlimited ammo, a target count, a clock. Present in the base game and carried
into both expansions. The genre's canonical answer to "give the player a
reason to use the sandbox violently on purpose".

## 1.9 Vehicles, city services, and the money loop

**59 vehicles**, some non-drivable. Everything on the street is stealable;
theft is the title. Supporting city fixtures:

- **Pay 'n' Spray / spray shop** — repaint, clears wanted, costs money.
- **Bomb garages** — fit a car bomb for a fee.
- **Dock cranes / import-export** — deliver requested vehicle types to a crane
  for a bounty. The original "the city has a shopping list" job.

**Seven radio stations**, one per genre, playing when you enter a car — and
emergency vehicles (squad car, fire truck, ambulance) get a **police-band
track** instead. Radio is diegetic: it changes with the car you steal, so the
soundtrack is a property of the theft.

## 1.10 Multiplayer

1–4 players over IP, PC only. Two modes: **deathmatch** and **Cannonball Run**
(a checkpoint race). Joining meant typing IP addresses by hand.

## 1.11 Expansions

- **London 1969** — 30+ new vehicles (Minis, double-deckers, Hackney cabs),
  30+ missions, currency in pounds, **driving on the left**. All base systems
  retained: cranes, kill frenzies, police bribes, Pay 'n' Spray, bomb garages.
- **London 1961** — a second, smaller pack; the same characters eight years
  younger.

## 1.12 Ports

The Game Boy Color version converted the cities **tile-for-tile** from the PC
original — enormous for the hardware — at the cost of detail, two missions,
and all gore and swearing.

---

# 2. The second game (1999)

## 2.1 Frame

One city ("Anywhere City", near-future) split into **three districts** —
Downtown, Residential, Industrial — unlocked in sequence rather than six
separate levels. Same overhead camera, much richer simulation underneath:
gangs that hold territory, react to you, and fight each other.

## 2.2 Gangs and territory

**Three gangs per district**, nine slots over seven distinct factions, with
one corporate gang present in **all three** districts as the constant
antagonist. Each has a home turf, a signature car, a colour, and a radio
station.

| District | Gangs |
|---|---|
| Downtown | the corporation, the asylum escapees (microcars, surgical green), the drug-lab syndicate (sports cars, deep blue) |
| Residential | the corporation, the trailer-park rednecks, the pacifists-turned-violent |
| Industrial | the corporation, the Russian mob, the science faction |

Gang members walk their own streets, drive their own cars, and shoot on sight
if they hate you. Hijacking a gang car gets you attacked by its occupants.

## 2.3 Respect — the system that defines the game

A **per-gang respect meter, shown on the HUD for all three gangs of the
current district simultaneously**. It is a zero-sum web: the same act that
buys you one gang buys you an enemy.

Rises when you: complete a gang's missions, kill members of that gang's
rivals.
Falls when you: fail its missions, kill its members — including as collateral
damage — or work for a rival.

What respect buys:

- **Access.** Each gang offers **seven missions: two green, three yellow, two
  red.** On entering a district you sit at one respect with everyone, so only
  the greens are open. Yellows need some respect; reds need maximum, pay very
  well, and are hard.
- **Protection.** A gang that likes you will **shield you from police** when
  you have a wanted level in their territory.
- **Safety.** At negative respect its members attack on sight, and its turf
  becomes a place you drive through fast.

Missions are still taken from **payphones**, now colour-coded by the difficulty
tier they offer. Completing one pays money, respect, and a **money
multiplier** — the first game's score multiplier, retained.

## 2.4 Wanted level and escalating law enforcement

The key change from the first game: higher tiers change the **kind** of
opposition, not just the count.

| Tier | Responder |
|---|---|
| 1–2 | Police |
| 3 | SWAT |
| 4 | FBI |
| 5–6 | Army (tanks) |

The ceiling is **per district**: Downtown caps at 4, Residential at 5 (PC),
Industrial at 6 — so the district you're in determines how bad it can get.
⚠ (corroborated by one source only, and it describes the caps in terms of
"heads"; the head-count-to-responder mapping above is the widely-known one.)

Wanted level is cleared by a respray, a police-bribe power-up, a get-out-of-
jail-free card, or by completing a kill frenzy.

## 2.5 Weapons

The first game's core weapons carried over with minor improvements, plus
**six new portable weapons** — two of them variants of existing firearms (a
silenced automatic, dual-wielded pistols), the rest new: a shotgun-class gun,
an electro weapon, and two thrown weapons (grenade, molotov). ⚠ (the "six new,
two of which are modifications" split is sourced; the specific naming of each
is from general knowledge.)

The genuinely new idea is **acquisition**: as well as fixed pickups, weapons
now come **off the bodies of dead gang members and law enforcers**, and **out
of car crushers**. The city supplies you as a consequence of play rather than
from a map of static spawn points.

## 2.6 Power-ups — fifteen, up from the first game's handful

Fifteen power-ups, found in the city or produced by crushing cars. They
alter behaviour rather than just topping up a bar:

- **Invisibility**, **Shield**, **Double Damage** ("weapons twice as powerful
  for a brief moment"), **Fast Reload**, **Electro-fingers** ⚠
- **Body armour**, **health**, **extra life** ⚠
- **Police bribe**, **Get Out of Jail Free card** ⚠
- **Respect** (instant standing with a gang) ⚠
- **Money multiplier** ⚠
- **Instant Gang** — a temporary escort of gang members, ~40 seconds; **cut
  from the shipped game** and known from the design document.

Only the fifteen-count, invisibility, double damage and the cut Instant Gang
are sourced; the rest of the enumeration is from general knowledge and should
be verified.

## 2.7 Garages: the three-shop economy

Garage complexes appear in every district and bundle three services:

- **Respray** — repairs the car and clears the wanted level, for a fee.
- **Bomb shop** — fits a car bomb; **$5,000 per use**.
- **Car crusher** — drive a stolen car under the crane, collect the payout
  from the conveyor. The reward depends on the vehicle, and it is not just
  cash: crushers dispense **weapons and power-ups**, including police bribes.

That last one is the mechanic worth stealing conceptually. It closes the loop
between the theft verb and the combat verb: a stolen car is not just money,
it's ammunition, and the city has a lookup table telling you which car is
worth which reward.

## 2.8 Kill frenzies, sharpened

**120-second** limit. Two forms:

- a **green skull icon**: kill N people or destroy N vehicles with a supplied
  weapon — infinite ammo while active, and **you cannot switch weapons** until
  it resolves;
- a **parked vehicle**: enter it and run down N people or destroy N cars with
  the vehicle's own weapons.

Pass: **wanted level cleared and +1 life**. Fail (timeout, busted, or wasted):
the wanted level stays if you're still alive, and **the frenzy does not
respawn** — you must reload a save to retry.

## 2.9 Jobs and special vehicles

Ordinary vehicles carry job loops, which is where the "living city" feeling
comes from:

- **Taxi** — fares get in at random while you drive one; the meter runs until
  you stop and they get out.
- **Bus, ambulance, fire truck, police car** — service-vehicle loops. ⚠
- **Tank** — army vehicle, the top of the escalation ladder and a reward for
  surviving it.
- **Train** — a working elevated railway you can ride across the map, an
  alternative to driving.

**69 vehicles** total.

## 2.10 Saving costs money

The famous one: progress is saved **at a church**, and saving **costs cash**.
Since money is also score and also the mission economy, saving is a real
decision — you pay for the right not to lose the run. Consoles handled this
differently.

## 2.11 Radio

**Eleven stations**, several of them **owned by the gangs** — the Russian
mob's station broadcasts in the Industrial district, and so on. The radio
doubles as a map legend: what you're hearing tells you whose turf you're on.
One station covers the whole city; the rest are regional.

## 2.12 Multiplayer

Up to **6 players**, in practice ≤3 over consumer broadband of the era and 6
on LAN. Modes: deathmatch, **Tag**, and a third. Shipped with a Windows
"GTA2 Manager" front-end for hosting and joining — a real improvement over
typing IPs.

## 2.13 Port differences

| | PC | PlayStation | Dreamcast | Game Boy Color |
|---|---|---|---|---|
| Protagonist | fixed | fixed | fixed | 6 selectable |
| Time of day | noon + dusk | day only | dusk only | day only |
| Narrator | yes | no | yes | no |
| Content | uncut | toned down (T) | — | toned down (T) |
| Saving | church | church | church | password system |

---

# 3. What changed between the two

| System | 1997 | 1999 |
|---|---|---|
| Structure | 6 levels, 3 cities, target score per level | 1 city, 3 districts unlocked in sequence |
| Progression gate | reach a score | complete missions / respect |
| Factions | mission-givers only | 7 gangs, 3 per district, with turf and AI |
| Reputation | none | per-gang respect, zero-sum, gates missions and safety |
| Police | 4 tiers, more units per tier | 6 tiers, each a **different force** (police→SWAT→FBI→army) |
| Weapons | 5 | ~11, plus loot-from-corpses and crusher rewards |
| Power-ups | ~7 | 15 |
| Saving | per level | pay-to-save at a church |
| Shops | spray, bomb garage, crane | respray + bomb + crusher, bundled per district |
| Multiplayer | 4p, deathmatch + race | 6p, deathmatch + Tag, with a lobby manager |
| Frenzies | yes | yes, 120 s, +1 life, clears wanted, one-shot |
| Radio | 7 stations, genre-per-station | 11 stations, gang-affiliated, regional |

The through-line: the first game is an **arcade score attack** wearing an open
city; the second is a **reputation simulator** wearing the same city. Both
keep the same physical verbs — steal, drive, shoot, run — and differ entirely
in what wraps them.

---

# 4. The mechanics that actually carry the genre

Stripping the nouns away, the load-bearing ideas are:

1. **One number is score, money, and progress.** Spending hurts progress.
   Every shop purchase is a real cost, not a menu transaction.
2. **A multiplier that missions raise and arrest halves.** Risk compounds in
   both directions, and the punishment targets the accumulated thing.
3. **Crime must be witnessed to be punished.** Heat is a property of
   observation, not of the act.
4. **Two exits from heat, both costly and located** — a shop you must drive to
   and a pickup you must know the location of. Never "wait it out".
5. **Death and arrest are different failures with different costs.**
6. **Escalation changes the kind of enemy, not the count.**
7. **The city hands out rewards for using it as intended** — crush a car, get
   a weapon; deliver a car, get paid; drive a taxi, get fares.
8. **Reputation is zero-sum across factions**, so every choice closes a door.
9. **Timed rampages** as the sanctioned reason to go loud.
10. **Diegetic audio as a map legend.**
11. **Saving as an economic decision.**

---

# 5. Where this project already stands

Assessed against `shared/src/sim/` and `shared/data/` on this branch. This is
description, not a plan — `ROADMAP.md` owns sequencing.

**Have analogues of:**

| Original mechanic | Here |
|---|---|
| Open city, districts | `shared/src/world/` — generated districts, roads, landmarks, hospitals, parks |
| Stealable traffic + parked cars | `sim/traffic.ts`, `sim/vehicle.ts`, lane-based ambient AI, kerbside parking |
| Pedestrians reacting | `sim/peds.ts` — scatter, run-over, respawn |
| Wanted level | `sim/police.ts` + `data/police.json` — heat, stars, cop cars, roadblocks, decay |
| Respray clears heat | `police.sprayCost`, spray shops in `world/amenities.ts` |
| Kill frenzies | `sim/frenzy.ts`, `pickups.frenzy*` |
| Stunt jumps | vertical position/velocity in `sim/state.ts:138` |
| Pickups | `sim/pickups.ts` — health, armour, ammo |
| Shops | `data/shop.json` — gun, clothing, spray; interiors |
| Vehicle damage / burn / wreck | `sim/vehicleDamage.ts` |
| Drive-by shooting | `sim/weapons.ts` |
| Money economy | `server/src/economy/` — append-only ledger, persistence |

**No analogue yet** — listed by how much genre character is missing, not by
implementation cost:

1. **Score-and-multiplier economy.** `economy.ts:192` keeps a leaderboard of
   kills/frenzies/best stunt; there is no single number that is
   simultaneously score, money and progress, and no multiplier at all. This is
   idea #1 and #2 from §4 — the largest single gap.
2. **Arrest.** Cops here only kill. There is no bust state, no station, no
   differentiated penalty, so idea #5 is entirely absent.
3. **Gangs and respect.** No factions, no turf, no reputation. The whole of
   the second game's identity.
4. **Mission delivery.** No payphones, no jobs, no objectives — the freeplay
   sandbox exists without a reason to leave it.
5. **Escalation by kind.** `police.json` scales `copsPerStar` and
   `maxCopsPerPlayer`; every tier is the same cop, more of them. `ROADMAP.md`
   A1 already flags this ("higher tiers change *kind* not *count*").
6. **Car crusher / import-export.** Nothing converts a stolen car into money
   or equipment. Cheap to add and directly rewards the title verb.
7. **Bomb shop / car bombs.**
8. **Service-vehicle jobs** — taxi fares, ambulance, fire, vigilante.
9. **Weapon and power-up breadth.** Four player weapons
   (fists/pistol/smg/shotgun); no explosive, incendiary or thrown weapon, and
   no behaviour-altering power-ups (invisibility, double damage, bribe,
   get-out-of-jail).
10. **Radio.** No in-car audio at all — nothing in `data/audio.json` or the
    client references it.
11. **Lives / pay-to-save.** Not applicable in the same form: this is a
    persistent multiplayer sandbox, not a level-based single-player run, so
    "five lives to reach a target" has no direct translation. Worth noting as
    *deliberately* out of scope rather than missing.

Point 11 generalises: both originals are single-player, level-scoped, and
save-based, and this project is none of those. The score/multiplier, arrest,
respect and escalation ideas port cleanly to a persistent shared city. Lives,
level targets and pay-to-save do not, and should not be forced.

---

# 6. Open questions for a second pass

Things I could not verify and that would change a design if they went the
other way:

- The exact enumeration of the first game's power-ups (source says seven; I
  can name six with confidence).
- Whether the get-out-of-jail-free card existed in the first game or only the
  second.
- The precise second-game wanted-tier → responder mapping, and whether the
  per-district caps are 4/5/6 as one source states.
- Exact respect thresholds for yellow and red missions.
- The car-crusher reward table — which vehicle yields which weapon or
  power-up. This is documented in community guides and would be the concrete
  reference if we ever build the analogue.

All of these are answerable from the community wikis once the environment can
reach them; §0 explains why it currently cannot.

---

# 7. Sources

Everything above that is unmarked traces to one of these. Pages were read via
search-result summaries only, per §0.

- [Grand Theft Auto (1997 game) — GTA Wiki](https://gta.fandom.com/wiki/Grand_Theft_Auto_(1997_game))
- [Grand Theft Auto (1997) — MobyGames](https://www.mobygames.com/game/417/grand-theft-auto/)
- [Wanted Level in GTA (1997 game) — GTA Wiki](https://gta.fandom.com/wiki/Wanted_Level_in_GTA_(1997_game))
- [Grand Theft Auto 1 — Grand Theft Wiki](https://www.grandtheftwiki.com/Grand_Theft_Auto_1)
- [Weapons in GTA 1 Era — Grand Theft Wiki](https://www.grandtheftwiki.com/Weapons_in_GTA_1_Era)
- [Police Bribes — GTA Wiki](https://gta.fandom.com/wiki/Police_Bribes)
- [Body Armor — GTA Wiki](https://gta.fandom.com/wiki/Body_Armor)
- [Power-ups in GTA 1 — Grand Theft Wiki](https://www.grandtheftwiki.com/Power-ups_in_GTA_1)
- [Radio Stations in GTA 1 — Grand Theft Wiki](https://www.grandtheftwiki.com/Radio_Stations_in_GTA_1)
- [Vehicles in GTA 1 — Grand Theft Wiki](https://www.grandtheftwiki.com/Vehicles_in_GTA_1)
- [Protagonists in GTA (1997 game) — GTA Wiki](https://gta.fandom.com/wiki/Protagonists_in_GTA_(1997_game))
- [Missions in GTA 1 — Grand Theft Wiki](https://www.grandtheftwiki.com/Missions_in_GTA_1)
- [Gangsta Bang — GTA Wiki](https://gta.fandom.com/wiki/Gangsta_Bang)
- [Heist Almighty — GTA Wiki](https://gta.fandom.com/wiki/Heist_Almighty)
- [Grand Theft Auto: Frequently Asked Questions — Speedrun.com](https://www.speedrun.com/gta1/guides/c5c3y)
- [Grand Theft Auto: London 1969 — GTA Wiki](https://gta.fandom.com/wiki/Grand_Theft_Auto:_London_1969)
- [Grand Theft Auto: Mission Pack #1 — London 1969 — MobyGames](https://www.mobygames.com/game/566/grand-theft-auto-mission-pack-1-london-1969/)
- [Grand Theft Auto 2 — GTA Wiki](https://gta.fandom.com/wiki/Grand_Theft_Auto_2)
- [Grand Theft Auto 2 — Grand Theft Wiki](https://www.grandtheftwiki.com/Grand_Theft_Auto_2)
- [Grand Theft Auto 2 — Wikipedia](https://en.wikipedia.org/wiki/Grand_Theft_Auto_2)
- [Respect — GTA Wiki](https://gta.fandom.com/wiki/Respect)
- [Respect — WikiGTA](https://en.wikigta.org/wiki/Respect)
- [Gangs (GTA2) — WikiGTA](https://en.wikigta.org/wiki/Gangs_(GTA2))
- [Zaibatsu Corporation (2D Universe) — GTA Wiki](https://gta.fandom.com/wiki/Zaibatsu_Corporation_(2D_Universe))
- [Grand Theft Auto 2/Gangs — StrategyWiki](https://strategywiki.org/wiki/Grand_Theft_Auto_2/Gangs)
- [Weapons in GTA 2 — GTA Wiki](https://gta.fandom.com/wiki/Weapons_in_GTA_2)
- [Power-ups in GTA 2 — GTA Wiki](https://gta.fandom.com/wiki/Power-ups_in_GTA_2)
- [Beta Content in GTA 2 — GTA Wiki](https://gta.fandom.com/wiki/Beta_Content_in_GTA_2)
- [Garages in GTA 2 — GTA Wiki](https://gta.fandom.com/wiki/Garages_in_GTA_2)
- [Bomb shops — GTA Wiki](https://gta.fandom.com/wiki/Bomb_shops)
- [GTA 2 Car Crusher Guide — GameFAQs](https://gamefaqs.gamespot.com/pc/197478-grand-theft-auto-2/faqs/19307)
- [Grand Theft Auto 2/Kill Frenzies — StrategyWiki](https://strategywiki.org/wiki/Grand_Theft_Auto_2/Kill_Frenzies)
- [Rampages — Grand Theft Wiki](https://www.grandtheftwiki.com/Rampages)
- [List of vehicles (GTA 2) — GTAMods Wiki](https://gtamods.com/wiki/List_of_vehicles_(GTA_2))
- [Taxi (2D Universe) — GTA Wiki](https://gta.fandom.com/wiki/Taxi_(2D_Universe))
- [Train (vehicle) — Grand Theft Wiki](https://www.grandtheftwiki.com/Train_(vehicle))
- [Radio Stations in GTA 2 — GTA Wiki](https://gta.fandom.com/wiki/Radio_Stations_in_GTA_2)
- [Multiplayer — GTAMods Wiki](https://gtamods.com/wiki/Multiplayer)
- [GTA2 multiplayer guide — GTAMP](https://gtamp.com/gta2/gta2-multiplayer/)
- [Multiplayer (GTA2) — WikiGTA](https://en.wikigta.org/wiki/Multiplayer_(GTA2))
- [Game Boy Color — GTA Wiki](https://gta.fandom.com/wiki/Game_Boy_Color)
- [Protagonists in GTA 2 (GBC) — GTA Wiki](https://gta.fandom.com/wiki/Protagonists_in_GTA_2_(GBC))
