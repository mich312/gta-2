import {
  type CityMap,
  type FullSnapshot,
  type PlayerState,
  type Vec2,
  TILE_SIZE,
  T_BUILDING,
  T_LOT,
  T_PARK,
  T_ROAD,
  T_SIDEWALK,
  T_WATER,
  T_BRIDGE,
  T_BANK,
  T_TREES,
  T_SAND,
  T_FLOOR,
} from 'shared';
import { viewport } from './viewport.js';

/** On-screen size of the map panel, in world (HUD) pixels. */
const SIZE = 74;
/** World pixels covered by the panel. Smaller = more zoomed in. */
const SPAN = 900;
/** Device pixels per tile in the baked texture. */
const BAKE_SCALE = 1;

const TILE_COLORS: Record<number, string> = {
  [T_ROAD]: '#4a5058',
  [T_SIDEWALK]: '#6a7078',
  [T_BUILDING]: '#2a3038',
  [T_PARK]: '#2f4c33',
  [T_LOT]: '#45463f',
  [T_WATER]: '#22384a',
  [T_BRIDGE]: '#5a606a',
  // The quay: light enough that the waterfront outline reads on the radar.
  [T_BANK]: '#77705f',
  [T_TREES]: '#1d3320',
  [T_SAND]: '#b0a074',
  // Shop interiors read as a lit room inside the block, so the radar shows
  // where a shop is without needing its own marker.
  [T_FLOOR]: '#7b6a55',
};
const FIELD_COLOR = '#232a26';

/** `#rrggbb` as the little-endian uint32 an RGBA `ImageData` buffer wants. */
function packColor(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  const r = (n >> 16) & 0xff;
  const g = (n >> 8) & 0xff;
  const b = n & 0xff;
  return (0xff << 24) | (b << 16) | (g << 8) | r;
}

/**
 * Tile palette as packed pixels, indexed by tile id.
 *
 * Built once at module load rather than per bake: it is a handful of entries
 * and the bake is the one place that reads it.
 */
const TILE_PIXELS = ((): Uint32Array => {
  const ids = Object.keys(TILE_COLORS).map(Number);
  const out = new Uint32Array(Math.max(...ids) + 1);
  out.fill(packColor(FIELD_COLOR));
  for (const id of ids) out[id] = packColor(TILE_COLORS[id] as string);
  return out;
})();
const FIELD_PIXEL = packColor(FIELD_COLOR);

/** Gang colours for the turf wash. Mirrors shared/data/gangs.json. */
const TURF_TINT: Record<number, string> = {
  1: '#c8543c',
  2: '#4aa86a',
  3: '#4a7ac8',
  4: '#a86ac8',
  5: '#c8a03c',
  6: '#3cc8b4',
  7: '#c85a8c',
};

/**
 * A radar. The genre has had one since its first entry, and without it this
 * city is 114 screenfuls of near-identical grid with six unmarked shops
 * somewhere in it.
 *
 * The whole city is baked once into an offscreen canvas at one pixel per
 * tile — the client already regenerates the identical CityMap locally, so
 * this costs nothing on the wire — and each frame blits a cropped window of
 * that texture. Markers are drawn on top in HUD space.
 */
export class Minimap {
  private texture: HTMLCanvasElement | null = null;
  private map: CityMap | null = null;
  /** Objective marker, set by the HUD's mission state. */
  marker: { x: number; y: number } | null = null;
  /** Checkpoints still to come on a race, drawn dim behind the next one. */
  route: Array<{ x: number; y: number }> = [];

  setMap(map: CityMap): void {
    this.map = map;
    this.texture = null;
  }

  /**
   * The whole city into an offscreen canvas, one pixel per tile.
   *
   * Written as pixels rather than as rectangles. A `fillRect` per tile is the
   * obvious way to say this and it was fine on a 240-tile map; on a 768-tile
   * one it is 589,824 canvas calls and it cost 240–300 ms of frozen tab on the
   * first frame after joining — the single largest piece of client work the
   * bigger map added. One `putImageData` over a typed array is the same
   * picture for about a tenth of that.
   */
  private bake(map: CityMap): HTMLCanvasElement {
    const W = map.widthTiles;
    const H = map.heightTiles;
    const canvas = document.createElement('canvas');
    canvas.width = W * BAKE_SCALE;
    canvas.height = H * BAKE_SCALE;
    const ctx = canvas.getContext('2d') as CanvasRenderingContext2D;

    const image = new ImageData(W, H);
    const px = new Uint32Array(image.data.buffer);
    for (let i = 0; i < px.length; i++) {
      const tile = map.tiles[i] as number;
      px[i] = tile < TILE_PIXELS.length ? (TILE_PIXELS[tile] as number) : FIELD_PIXEL;
    }

    if (BAKE_SCALE === 1) {
      ctx.putImageData(image, 0, 0);
      return canvas;
    }
    // Scaled bake: draw the 1:1 image and let the compositor blow it up.
    const src = document.createElement('canvas');
    src.width = W;
    src.height = H;
    (src.getContext('2d') as CanvasRenderingContext2D).putImageData(image, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(src, 0, 0, canvas.width, canvas.height);
    return canvas;
  }

  /** Draw the panel. Call under `hudTransform`. */
  draw(
    ctx: CanvasRenderingContext2D,
    me: PlayerState | null,
    center: Vec2 | null,
    snapshot: FullSnapshot | null,
  ): void {
    const map = this.map;
    if (!map || !center) return;
    if (!this.texture) {
      const __b = performance.now();
      this.texture = this.bake(map);
      (globalThis as never as { __jt: string[] }).__jt?.push(
        `minimap.bake ${Math.round(performance.now() - __b)}`,
      );
    }

    const x0 = viewport.w - SIZE - 4;
    const y0 = 4;

    ctx.save();
    ctx.beginPath();
    ctx.rect(x0, y0, SIZE, SIZE);
    ctx.clip();

    // Source window in texture pixels, centred on the player and clamped so
    // the panel never shows off-map emptiness at the city edges.
    const texPerWorld = BAKE_SCALE / TILE_SIZE;
    const srcSpan = SPAN * texPerWorld;
    const sx = Math.max(
      0,
      Math.min(this.texture.width - srcSpan, center.x * texPerWorld - srcSpan / 2),
    );
    const sy = Math.max(
      0,
      Math.min(this.texture.height - srcSpan, center.y * texPerWorld - srcSpan / 2),
    );
    ctx.fillStyle = '#11161c';
    ctx.fillRect(x0, y0, SIZE, SIZE);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(this.texture, sx, sy, srcSpan, srcSpan, x0, y0, SIZE, SIZE);

    // World position -> panel position, using the same clamped window.
    const px = (wx: number): number => x0 + (wx * texPerWorld - sx) * (SIZE / srcSpan);
    const py = (wy: number): number => y0 + (wy * texPerWorld - sy) * (SIZE / srcSpan);
    const inPanel = (x: number, y: number): boolean =>
      x >= x0 - 1 && y >= y0 - 1 && x <= x0 + SIZE + 1 && y <= y0 + SIZE + 1;

    const dot = (wx: number, wy: number, color: string, r: number): void => {
      const x = px(wx);
      const y = py(wy);
      if (!inPanel(x, y)) return;
      ctx.fillStyle = color;
      ctx.fillRect(x - r, y - r, r * 2, r * 2);
    };

    // Turf: a faint wash under everything, so you can see whose ground you
    // are on without anything as loud as a border.
    if (map.turfCellsWide > 0) {
      const cellPx = (map.widthTiles / map.turfCellsWide) * TILE_SIZE;
      // 0.22 drowned the city: the radar went uniformly purple and the
      // streets under it stopped being readable. Territory is context, not
      // the subject of the panel.
      ctx.globalAlpha = 0.11;
      for (let i = 0; i < map.turfCells.length; i++) {
        const gang = map.turfCells[i] as number;
        const tint = TURF_TINT[gang];
        if (!tint) continue;
        const gx = (i % map.turfCellsWide) * cellPx;
        const gy = Math.floor(i / map.turfCellsWide) * cellPx;
        const x = px(gx);
        const y = py(gy);
        const w = (cellPx / TILE_SIZE) * BAKE_SCALE * (SIZE / (SPAN * (BAKE_SCALE / TILE_SIZE)));
        if (x + w < x0 || y + w < y0 || x > x0 + SIZE || y > y0 + SIZE) continue;
        ctx.fillStyle = tint;
        ctx.fillRect(x, y, w, w);
      }
      ctx.globalAlpha = 1;
    }

    // Landmarks: the things you actually navigate by. Drawn under the shop
    // and entity markers so they never cover a live target.
    for (const l of map.landmarks) {
      const cx = (l.x + l.w / 2) * TILE_SIZE;
      const cy = (l.y + l.h / 2) * TILE_SIZE;
      // Hospital red, station blue: the two places you get sent against your
      // will, and the ones worth spotting before you need them.
      const tint =
        l.kind === 'hospital' ? '#e06a6a' : l.kind === 'police' ? '#6a9ce0' : '#c9cdd4';
      dot(cx, cy, tint, 2);
    }

    // Payphones: the city's job board, and useless if you cannot find one.
    for (const q of map.payphones) dot(q.x, q.y, '#d8d0a0', 1.5);

    // Crushers: you have to be able to find one to use one. Green, because
    // amber is already the respray garage and these are not the same errand.
    for (const c of map.cranes) dot(c.x, c.y, '#7fd6a8', 2);

    // Shops are the reason this panel exists: six of them across the whole
    // city, otherwise findable only by driving into their doorway.
    for (const shop of map.shops) {
      dot(
        (shop.doorX + 0.5) * TILE_SIZE,
        (shop.doorY + 0.5) * TILE_SIZE,
        shop.kind === 'depot'
          ? '#7ad46a'
          : shop.kind === 'gun'
          ? '#c8583c'
          : shop.kind === 'spray'
            ? '#c8a03c'
            : shop.kind === 'clinic'
              ? '#e06a6a'
              : '#3ca0c8',
        1.5,
      );
    }
    // Where a given KIND of vehicle lives. A home you cannot find is not a
    // home, and "where is a fire engine" should have an answer that does not
    // involve driving in circles. Deliberately dim and small: these are
    // standing facts about the map, not errands, and they must not compete
    // with the shops or the job board above.
    for (const h of map.vehicleHomes) dot(h.x, h.y, '#9aa6b4', 1);

    if (snapshot) {
      for (const pu of snapshot.pickups) {
        if (!pu.active) continue;
        dot(pu.pos.x, pu.pos.y, pu.kind === 'health' ? '#57c98a' : '#5aa8e0', 1);
      }
      for (const cop of snapshot.cops) dot(cop.pos.x, cop.pos.y, '#4f7fe0', 1.5);
      for (const p of snapshot.players) {
        if (p.mode === 'dead' || (me && p.id === me.id)) continue;
        dot(p.pos.x, p.pos.y, '#e05555', 1.5);
      }
    }
    // Where the job wants you, over everything except yourself.
    // The rest of the route first, dimmer and smaller, so the NEXT one is
    // unambiguous — a race drawn as five identical dots is a race you lose by
    // going to the wrong one.
    for (let i = 1; i < this.route.length; i++) {
      const c = this.route[i]!;
      dot(c.x, c.y, 'rgba(255, 210, 122, 0.45)', 1.5);
    }
    if (this.marker) dot(this.marker.x, this.marker.y, '#ffd27a', 2.5);

    // Own marker last, so nothing can cover it.
    dot(center.x, center.y, '#ffffff', 1.5);

    ctx.restore();
    ctx.strokeStyle = 'rgba(200, 220, 235, 0.35)';
    ctx.strokeRect(x0 + 0.5, y0 + 0.5, SIZE - 1, SIZE - 1);
  }
}
