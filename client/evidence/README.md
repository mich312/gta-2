# Evidence pages

Three dev-only pages that photograph the game's own code, for checking that a
feature is really there rather than remembering that it was written.

They are not part of the build: `vite build` only follows `client/index.html`,
so these are reachable under `pnpm dev` and nowhere else.

Each page reads its cases from the URL fragment as URL-encoded JSON, so one
page can produce a whole contact sheet in a single screenshot.

| Page | Drives | Cases |
| --- | --- | --- |
| `sprites.html` | the generated `sprites.png` + frame map | `[[title, [spriteName, …]], …]` |
| `hud.html` | the production `Hud.draw` / `Hud.drawShop`, over a real snapshot | `[{title, player, cash, multiplier, mission, shop, exports, clip, …}, …]` |
| `world.html` | the production `render()` and `Minimap.draw`, over a real `step()`ed `GameState` on the real city | `[{title, stage, ticks, input, loadout, clip, scale, minimap}, …]` |

`world.html`'s `stage` is a JavaScript source string run with `state`, `map`,
`me`, `anchor` and the entity factories in scope; return a `GameState` to
replace the current one. `clip` is `[x, y, w, h]` in the 480×270 HUD space.

Example:

    pnpm dev
    open '.../evidence/hud.html#'"$(python3 -c 'import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1]))' \
      '[{"title":"four stars","player":{"wantedLevel":4},"clip":[0,0,480,40]}]')"

`AUDIT.md` at the repo root is the write-up these produced.
