# iteration 7 — `built-staircase`: 19 of its 24 are not drawn, 4 are, and one is a scope leak

No code changed this iteration. The target was to decide whether the signature's
"noisy, cosmetic, architectural fix only" label — carried since iteration 3 on
nobody's measurement — is true. It is true for 74% of the magnitude and false
for the rest, and the part that is false is a first-order visual bug.

`pnpm build` first: every script here reads `shared/dist`, the same decoder
`mapaudit` uses. Baseline is `ce3189b` (iteration 6's close), unrebaked:
**1184 blocks, 4005 buildings**, `citybake --check` at **six warnings**
(`citybake-check.txt`).

## the answer in one table

Grouped by MECHANISM, which is "what repaints the step face", not by the
signature's own severity. All 24, m summing to 540:

| group | n | m | what is on the step face | drawn? |
|---|---|---|---|---|
| **A bridge deck** | 4 | **123** | open water, no curve layer of any kind | **yes, grossly** |
| **B quay on the coast** | 11 | 249 | open water, coast chain over every position | no |
| **C quay inland** | 8 | 153 | pavement / road / field, **bank chain** over every position | no |
| **D yard at 82,462** | 1 | 15 | a diagonal street's kerb | yes, but see below |

B and C together are **19 findings and 402 tiles — 74% of the magnitude —
where the tile staircase exists and no renderer draws it.**

## the measurements

| file | what it settles |
|---|---|
| `attribute.mjs` / (stdout) | re-derives all 24 findings from the bake independently of `mapAudit.ts`; m sums to 540 and the count is 24, so the re-derivation is faithful. Reports, per finding, which chain covers each step face onto water. **`bandOnly=0` everywhere** — the detector's `coast ∪ band` test is carried entirely by `coast`, which is the same layer the 3D renderer's `shoreCut` uses, so its "dissolved" claim is not inflated by the band layer. |
| `curve-cover.mjs` → `curve-cover.txt` | the same 24, but asking the curve layers at **every** profile position rather than only at positions whose far side is water. This is the measurement `builtStaircase` does not take, and it is why group C is mislabelled: the signature counts `faces` only when the outward tile is `T_WATER`, so for an inland quay it counts zero and prints "This edge faces dry ground, which no coast curve describes, so it is drawn as it lies" **without ever consulting the bank chain**. It should: 8 of those 9 have `bare=0`, every position covered. Totals: 741 positions, 376 coast, 197 bank, **168 bare** — and 149 of the 168 are the four bridge decks. |
| `deck-census.mjs` → `deck-census.txt` | sizes the part that is real, city-wide rather than at the four gated findings: 1564 deck tiles, 872 deck/water faces, **835 covered by neither chain**, 872 rail boxes of which **418 sit at a step**. The four findings' 149 bare positions are a subset — the deck problem is ~2.8x the flagged part. |
| `courses.mjs` → `courses.txt` | whether a fix has a curve to follow. 381 authored courses; **100% of deck tiles are within 6 tiles of one**, and each of the four stepped decks has a `ring`/`avenue` course of width 4 running 1.7–2.1 tiles from the flagged edge. So the centreline a straight deck edge would need already ships in the bake. |
| `dump.mjs` | tile dump for a crop, one char per tile — how the 543,327 case was identified as the coast road stepping rather than the quay. |

## the pictures

Top-down is `pnpm mapgen` (the tool's own painter). Eye-level is the **default
3D renderer**, `client/city3d.html`, which decodes the same shipped bake
(`generate.ts:65` — `generateCity` reads `city.data.ts` for the ground, so the
flyover's seed moves only the furniture and the tiles are the audited ones).

| file | |
|---|---|
| `A-bridge-178-478-topdown.png` | `--crop=146,446,64 --scale=16`. The deck is serrated down both sides against open water; the coastline beside it is a smooth curve. The contrast in one frame between an edge the curve layer owns and one it refuses. |
| `A-bridge-178-478-eye.png` | the same span at eye level. The parapet jogs a full tile every few tiles and the span reads as a zig-zag ribbon. **This is the picture that refutes "cosmetic".** |
| `A-bridge-norails-EXPERIMENT.png` | the same shot with `buildBridgeRails` disabled, to attribute how much of the artefact is the rail. The deck still steps, much less severely: the rail is an amplifier, not the cause. Taken by copying `cityGeometry.ts` aside and restoring it — never `git stash`, per FIXER.md. **Not a proposed change**; the tree is unmodified. |
| `B-quay-427-678-topdown.png`, `B-quay-427-678-eye.png` | the largest group-B finding, m=43, 59 step faces. A smooth tan band in both views, top-down and at eye level. Nothing of the staircase is drawn. |
| `C-quay-640-382-topdown.png`, `C-quay-640-382-eye.png` | group C, m=27, far side road/pavement/field. The quay's landward edge is a straight line at eye level — the bank patches (`buildBandPatches`) lay a curve-cut polygon over every band tile whose two sides differ in material. |
| `C-quay-543-327-field-topdown.png` | the one case where something stepped IS visible top-down — and `dump.mjs 528 310 30 34` shows it is the **coast road**, three tiles wide, stepping one tile every three rows. Not the quay, and `road` is not a kind this signature scans. |
| `C-yard-82-462-topdown.png`, `C-yard-82-462-eye.png` | finding D. An ordinary city block with diagonal streets. At eye level its kerbs read straight and I could not tell the flagged edge from the ordinary diagonal-lattice rasterisation. |

## retaking

```bash
pnpm build
node evidence/iter7/attribute.mjs
node evidence/iter7/curve-cover.mjs
node evidence/iter7/deck-census.mjs
node evidence/iter7/courses.mjs
node evidence/iter7/dump.mjs 528 310 30 34

node server/dist/tools/mapgen.js --crop=146,446,64 --scale=16 --out=evidence/iter7/A-bridge-178-478-topdown.png
```

Eye-level, with the dev server up (`pnpm --filter client dev`):

```bash
WAIT_GROUND=20 node evidence/iter7/shot.mjs \
  "http://localhost:5173/city3d.html?fly=1&at=178,478&h=110&pitch=74&night=0" \
  evidence/iter7/A-bridge-178-478-eye.png
```

`shot.mjs` is `ci/shot.mjs` with a smaller viewport and a screenshot timeout
longer than 30s. `ci/shot.mjs` shoots at 2200x1000, which on this box wants
more painted-ground chunks than the 2-per-frame budget delivers; it times its
own screenshot out at 30s and never produces a file. **`WAIT_GROUND` is still
not optional** — `probe-ground.mjs` measures the fill rate (about 2 chunks per
6.5s, plateauing near 20 for a held flyover at this framing), and shooting
before it plateaus photographs flat instanced slabs instead of the city.
