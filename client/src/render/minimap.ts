import {
  type CityMap,
  type FullSnapshot,
  type PlayerState,
  type Vec2,
  INTERNAL_WIDTH,
  TILE_SIZE,
  T_BUILDING,
  T_LOT,
  T_PARK,
  T_ROAD,
  T_SIDEWALK,
  T_WATER,
  T_BRIDGE,
  T_FLOOR,
} from 'shared';

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
  // Shop interiors read as a lit room inside the block, so the radar shows
  // where a shop is without needing its own marker.
  [T_FLOOR]: '#7b6a55',
};
const FIELD_COLOR = '#232a26';

/** Gang colours for the turf wash. Mirrors shared/data/gangs.json. */
const TURF_TINT: Record<number, string> = {
  1: '#c8543c',
  2: '#4aa86a',
  3: '#4a7ac8',
  4: '#a86ac8',
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

  setMap(map: CityMap): void {
    this.map = map;
    this.texture = null;
  }

  private bake(map: CityMap): HTMLCanvasElement {
    const canvas = document.createElement('canvas');
    canvas.width = map.widthTiles * BAKE_SCALE;
    canvas.height = map.heightTiles * BAKE_SCALE;
    const ctx = canvas.getContext('2d') as CanvasRenderingContext2D;
    ctx.fillStyle = FIELD_COLOR;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    for (let ty = 0; ty < map.heightTiles; ty++) {
      for (let tx = 0; tx < map.widthTiles; tx++) {
        const tile = map.tiles[ty * map.widthTiles + tx] as number;
        const color = TILE_COLORS[tile];
        if (!color) continue;
        ctx.fillStyle = color;
        ctx.fillRect(tx * BAKE_SCALE, ty * BAKE_SCALE, BAKE_SCALE, BAKE_SCALE);
      }
    }
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
    if (!this.texture) this.texture = this.bake(map);

    const x0 = INTERNAL_WIDTH - SIZE - 4;
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
      ctx.globalAlpha = 0.22;
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

    // Crushers: you have to be able to find one to use one. Green, because
    // amber is already the respray garage and these are not the same errand.
    for (const c of map.cranes) dot(c.x, c.y, '#7fd6a8', 2);

    // Shops are the reason this panel exists: six of them across the whole
    // city, otherwise findable only by driving into their doorway.
    for (const shop of map.shops) {
      dot(
        (shop.doorX + 0.5) * TILE_SIZE,
        (shop.doorY + 0.5) * TILE_SIZE,
        shop.kind === 'gun' ? '#c8583c' : shop.kind === 'spray' ? '#c8a03c' : '#3ca0c8',
        1.5,
      );
    }
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
    // Own marker last, so nothing can cover it.
    dot(center.x, center.y, '#ffffff', 1.5);

    ctx.restore();
    ctx.strokeStyle = 'rgba(200, 220, 235, 0.35)';
    ctx.strokeRect(x0 + 0.5, y0 + 0.5, SIZE - 1, SIZE - 1);
  }
}
