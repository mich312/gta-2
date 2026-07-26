import {
  type Building,
  type CityMap,
  type Vec2,
  INTERNAL_HEIGHT,
  INTERNAL_WIDTH,
  TILE_SIZE,
} from 'shared';
import palette from 'shared/data/palette.json';
import { EXTRUDE_PARALLAX, SUN_SHADOW_X, SUN_SHADOW_Y } from './style.js';
import { VisualStream, hash2, mix, shade } from './visualRng.js';
import { type TreeInstance, treeTone, treesInView } from './ground.js';

/**
 * Fake-3D structures, GTA2 style. Roofs are the building footprint sheared
 * away from the screen centre by a per-storey parallax factor; the walls are
 * the quads joining footprint to roof. Straight overhead (screen centre) a
 * building is a flat roof; near the screen edge you see down its street
 * face. Drawn AFTER entities so walls and canopies genuinely occlude
 * whatever walks behind them — that one ordering rule buys the whole
 * illusion of height.
 *
 * All decoration (storey count, roof furniture, tree tone) hashes off the
 * map seed and the footprint, so every client sees identical architecture.
 */

interface Structure {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  storeys: number;
  wall: string;
  wallDark: string;
  roof: string;
  roofEdge: string;
  furniture: RoofBox[];
  extras: RoofExtras;
}

interface RoofBox {
  /** Offset within the roof, px from the footprint's top-left. */
  x: number;
  y: number;
  w: number;
  h: number;
  kind: 'ac' | 'vent' | 'skylight' | 'antenna';
}

interface RoofExtras {
  /** Expansion-seam grid on big slabs. */
  seams: boolean;
  /** Downtown vanity helipad. */
  helipad: boolean;
}

const STOREYS: Record<string, [number, number]> = {
  downtown: [3, 6],
  commercial: [2, 4],
  residential: [1, 3],
  industrial: [1, 2],
  park: [1, 1],
};

export class BuildingRenderer {
  private readonly structures: Structure[];

  constructor(private readonly map: CityMap) {
    this.structures = map.buildings.map((b) => makeStructure(map, b));
  }

  /** Ground shadows for structures and trees. Before the entity pass. */
  drawShadows(ctx: CanvasRenderingContext2D, cam: Vec2, daylight: number): void {
    if (daylight <= 0.05) return;
    const alpha = 0.16 * daylight;
    ctx.fillStyle = `rgba(6, 8, 14, ${alpha.toFixed(3)})`;
    for (const s of this.visible(cam, 40)) {
      const ox = SUN_SHADOW_X * Math.min(3, s.storeys) * 0.8;
      const oy = SUN_SHADOW_Y * Math.min(3, s.storeys) * 0.8;
      ctx.fillRect(s.x0 - cam.x + ox, s.y0 - cam.y + oy, s.x1 - s.x0, s.y1 - s.y0);
    }
    for (const tree of treesInView(this.map, cam)) {
      ctx.beginPath();
      ctx.ellipse(
        tree.x - cam.x + SUN_SHADOW_X,
        tree.y - cam.y + SUN_SHADOW_Y,
        tree.r * 0.9,
        tree.r * 0.6,
        0,
        0,
        Math.PI * 2,
      );
      ctx.fill();
    }
  }

  /** Walls, roofs, roof furniture and tree canopies. After entities. */
  drawStructures(ctx: CanvasRenderingContext2D, cam: Vec2): void {
    const cx = cam.x + INTERNAL_WIDTH / 2;
    const cy = cam.y + INTERNAL_HEIGHT / 2;

    // Inner (small lean) first so outer structures paint over them.
    const inView = this.visible(cam, 64);
    inView.sort((a, b) => distToCentre(a, cx, cy) - distToCentre(b, cx, cy));

    for (const s of inView) drawStructure(ctx, s, cam, cx, cy);

    for (const tree of treesInView(this.map, cam)) drawTree(ctx, this.map, tree, cam, cx, cy);
  }

  /**
   * Night-life pass, drawn AFTER the darkness composite so it glows: lit
   * windows strung along visible wall faces and warm skylights. Which
   * windows are awake hashes off the map seed + window index, so the same
   * flats burn the midnight oil for everyone.
   */
  drawEmissive(ctx: CanvasRenderingContext2D, cam: Vec2, darkness: number): void {
    if (darkness < 0.08) return;
    const cx = cam.x + INTERNAL_WIDTH / 2;
    const cy = cam.y + INTERNAL_HEIGHT / 2;
    const alpha = Math.min(0.85, darkness + 0.15);

    for (const s of this.visible(cam, 64)) {
      const bx0 = s.x0 - cam.x;
      const by0 = s.y0 - cam.y;
      const bx1 = s.x1 - cam.x;
      const by1 = s.y1 - cam.y;
      const [lx0, ly0] = lean(s.x0, s.y0, cx, cy, s.storeys);
      const [lx1, ly1] = lean(s.x1, s.y1, cx, cy, s.storeys);
      const centreX = cx - cam.x;
      const centreY = cy - cam.y;
      const seedX = Math.round(s.x0 / TILE_SIZE);
      const seedY = Math.round(s.y0 / TILE_SIZE);

      // A window strip along each visible wall face, mid-height.
      const strip = (
        ax: number, ay: number, bx: number, byy: number,
        aox: number, aoy: number, box: number, boy: number,
        faceId: number,
      ): void => {
        const len = Math.hypot(bx - ax, byy - ay);
        const n = Math.floor(len / 9);
        for (let i = 1; i < n; i++) {
          const t = i / n;
          const h = hash2(this.map.seed ^ 0xf1a, seedX * 8 + faceId, seedY * 8 + i);
          if (h % 100 >= 34) continue; // ~1/3 of windows lit
          const warm = h % 5 === 0 ? '255, 200, 120' : '210, 225, 200';
          const mx = ax + (bx - ax) * t + (aox + (box - aox) * t) * 0.55;
          const my = ay + (byy - ay) * t + (aoy + (boy - aoy) * t) * 0.55;
          ctx.fillStyle = `rgba(${warm}, ${(alpha * 0.9).toFixed(3)})`;
          ctx.fillRect(Math.round(mx) - 1, Math.round(my) - 1, 2, 2);
        }
      };
      if (centreX < bx0) strip(bx0, by0, bx0, by1, lx0, ly0, lx0, ly1, 0);
      if (centreX > bx1) strip(bx1, by0, bx1, by1, lx1, ly0, lx1, ly1, 1);
      if (centreY < by0) strip(bx0, by0, bx1, by0, lx0, ly0, lx1, ly0, 2);
      if (centreY > by1) strip(bx0, by1, bx1, by1, lx0, ly1, lx1, ly1, 3);

      // Skylights leak a soft glow upward.
      const mlx = (lx0 + lx1) / 2;
      const mly = (ly0 + ly1) / 2;
      for (const f of s.furniture) {
        if (f.kind !== 'skylight') continue;
        const fx = bx0 + mlx + f.x + f.w / 2;
        const fy = by0 + mly + f.y + f.h / 2;
        const g = ctx.createRadialGradient(fx, fy, 1, fx, fy, 9);
        g.addColorStop(0, `rgba(140, 190, 230, ${(alpha * 0.5).toFixed(3)})`);
        g.addColorStop(1, 'rgba(140, 190, 230, 0)');
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(fx, fy, 9, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  private visible(cam: Vec2, margin: number): Structure[] {
    const out: Structure[] = [];
    for (const s of this.structures) {
      if (
        s.x1 < cam.x - margin ||
        s.y1 < cam.y - margin ||
        s.x0 > cam.x + INTERNAL_WIDTH + margin ||
        s.y0 > cam.y + INTERNAL_HEIGHT + margin
      ) {
        continue;
      }
      out.push(s);
    }
    return out;
  }
}

function distToCentre(s: Structure, cx: number, cy: number): number {
  const mx = (s.x0 + s.x1) / 2;
  const my = (s.y0 + s.y1) / 2;
  return (mx - cx) * (mx - cx) + (my - cy) * (my - cy);
}

function makeStructure(map: CityMap, b: Building): Structure {
  const s = new VisualStream(map.seed ^ 0xb1d, b.x, b.y);
  const range = STOREYS[b.district] ?? [1, 2];
  const storeys = range[0] + s.int(range[1] - range[0] + 1);
  // Each district owns a small family of façade hues; every building picks
  // one, so blocks read as a neighbourhood instead of a single flat colour.
  const variants = (palette.buildingVariants as Record<string, string[]>)[b.district];
  const base =
    (variants && variants.length > 0 ? variants[s.int(variants.length)] : undefined) ??
    (palette.building as Record<string, string>)[b.district] ??
    palette.building.downtown;
  const tint = s.range(-0.06, 0.06);
  // Walls sit in shade and keep the district hue; roofs read as weathered
  // concrete — district colour pulled well toward grey, lighter when taller.
  const wall = shade(base, tint - 0.32);
  const roofBase = shade(mix(base, '#8b8d92', 0.45), tint - 0.02 + storeys * 0.02);

  const wpx = b.w * TILE_SIZE;
  const hpx = b.h * TILE_SIZE;
  const furniture: RoofBox[] = [];
  const boxes = Math.min(8, 2 + s.int(2 + Math.floor((wpx * hpx) / 1800)));
  for (let i = 0; i < boxes; i++) {
    const kindRoll = s.next();
    const kind: RoofBox['kind'] =
      kindRoll < 0.4 ? 'ac' : kindRoll < 0.65 ? 'vent' : kindRoll < 0.9 ? 'skylight' : 'antenna';
    const bw = kind === 'ac' ? 6 + s.int(4) : kind === 'skylight' ? 8 + s.int(6) : 3 + s.int(2);
    const bh = kind === 'ac' ? 5 + s.int(3) : kind === 'skylight' ? 5 + s.int(3) : 3 + s.int(2);
    if (wpx < bw + 10 || hpx < bh + 10) continue;
    furniture.push({
      x: 5 + s.int(Math.max(1, wpx - bw - 10)),
      y: 5 + s.int(Math.max(1, hpx - bh - 10)),
      w: bw,
      h: bh,
      kind,
    });
  }

  return {
    x0: b.x * TILE_SIZE,
    y0: b.y * TILE_SIZE,
    x1: (b.x + b.w) * TILE_SIZE,
    y1: (b.y + b.h) * TILE_SIZE,
    storeys,
    wall,
    wallDark: shade(base, tint - 0.46),
    roof: roofBase,
    roofEdge: shade(base, tint + 0.14),
    furniture,
    extras: {
      seams: wpx * hpx > 4200,
      helipad: b.district === 'downtown' && wpx >= 64 && hpx >= 64 && s.chance(0.2),
    },
  };
}

/** Roof-corner lean for a world point at the given storey count. */
function lean(px: number, py: number, cx: number, cy: number, storeys: number): [number, number] {
  const k = EXTRUDE_PARALLAX * storeys;
  return [(px - cx) * k, (py - cy) * k];
}

function drawStructure(
  ctx: CanvasRenderingContext2D,
  s: Structure,
  cam: Vec2,
  cx: number,
  cy: number,
): void {
  const bx0 = s.x0 - cam.x;
  const by0 = s.y0 - cam.y;
  const bx1 = s.x1 - cam.x;
  const by1 = s.y1 - cam.y;

  const [lx0, ly0] = lean(s.x0, s.y0, cx, cy, s.storeys);
  const [lx1, ly1] = lean(s.x1, s.y1, cx, cy, s.storeys);

  // Wall quads: only faces turned toward the screen centre are visible.
  // Left face when the centre is left of the building, etc.
  const quad = (
    ax: number, ay: number, bx: number, byy: number,
    aox: number, aoy: number, box: number, boy: number,
    fill: string,
  ): void => {
    ctx.fillStyle = fill;
    ctx.beginPath();
    ctx.moveTo(ax, ay);
    ctx.lineTo(bx, byy);
    ctx.lineTo(bx + box, byy + boy);
    ctx.lineTo(ax + aox, ay + aoy);
    ctx.closePath();
    ctx.fill();
  };

  const centreX = cx - cam.x;
  const centreY = cy - cam.y;
  if (centreX < bx0) quad(bx0, by0, bx0, by1, lx0, ly0, lx0, ly1, s.wall);
  if (centreX > bx1) quad(bx1, by0, bx1, by1, lx1, ly0, lx1, ly1, s.wallDark);
  if (centreY < by0) quad(bx0, by0, bx1, by0, lx0, ly0, lx1, ly0, shade(s.wall, 0.10));
  if (centreY > by1) quad(bx0, by1, bx1, by1, lx0, ly1, lx1, ly1, s.wallDark);

  // Roof: the footprint with each corner displaced by its own lean. The
  // lean separates per axis, so corner (x0,y1) shifts by (lx0, ly1).
  ctx.fillStyle = s.roof;
  ctx.beginPath();
  ctx.moveTo(bx0 + lx0, by0 + ly0);
  ctx.lineTo(bx1 + lx1, by0 + ly0);
  ctx.lineTo(bx1 + lx1, by1 + ly1);
  ctx.lineTo(bx0 + lx0, by1 + ly1);
  ctx.closePath();
  ctx.fill();

  // Parapet: a light lip along the roof's outline.
  ctx.strokeStyle = s.roofEdge;
  ctx.lineWidth = 1;
  ctx.stroke();

  // Roof furniture rides the roof's mean lean; clipped so nothing spills.
  const mlx = (lx0 + lx1) / 2;
  const mly = (ly0 + ly1) / 2;
  ctx.save();
  ctx.clip();

  // Inner parapet shadow line makes the lip read as raised.
  ctx.strokeStyle = 'rgba(0,0,0,0.18)';
  ctx.strokeRect(bx0 + mlx + 2.5, by0 + mly + 2.5, bx1 - bx0 - 5, by1 - by0 - 5);

  if (s.extras.seams) {
    ctx.strokeStyle = 'rgba(0,0,0,0.08)';
    ctx.beginPath();
    for (let gx = bx0 + 24; gx < bx1 - 6; gx += 24) {
      ctx.moveTo(gx + mlx, by0 + mly);
      ctx.lineTo(gx + mlx, by1 + mly);
    }
    for (let gy = by0 + 24; gy < by1 - 6; gy += 24) {
      ctx.moveTo(bx0 + mlx, gy + mly);
      ctx.lineTo(bx1 + mlx, gy + mly);
    }
    ctx.stroke();
  }

  if (s.extras.helipad) {
    const hx = (bx0 + bx1) / 2 + mlx;
    const hy = (by0 + by1) / 2 + mly;
    ctx.strokeStyle = 'rgba(220, 214, 180, 0.55)';
    ctx.beginPath();
    ctx.arc(hx, hy, 14, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = 'rgba(220, 214, 180, 0.55)';
    ctx.fillRect(hx - 4, hy - 5, 2, 10);
    ctx.fillRect(hx + 2, hy - 5, 2, 10);
    ctx.fillRect(hx - 3, hy - 1, 6, 2);
  }
  for (const f of s.furniture) {
    const fx = Math.round(bx0 + mlx + f.x);
    const fy = Math.round(by0 + mly + f.y);
    switch (f.kind) {
      case 'ac':
        ctx.fillStyle = 'rgba(0,0,0,0.30)';
        ctx.fillRect(fx + 1, fy + 1, f.w, f.h);
        ctx.fillStyle = '#9aa0a8';
        ctx.fillRect(fx, fy, f.w, f.h);
        ctx.fillStyle = '#70767e';
        ctx.fillRect(fx + 1, fy + 1, f.w - 2, 1);
        break;
      case 'vent':
        ctx.fillStyle = 'rgba(0,0,0,0.30)';
        ctx.fillRect(fx + 1, fy + 1, f.w, f.h);
        ctx.fillStyle = shade(s.roof, 0.22);
        ctx.fillRect(fx, fy, f.w, f.h);
        break;
      case 'skylight':
        ctx.fillStyle = '#3a4c5e';
        ctx.fillRect(fx, fy, f.w, f.h);
        ctx.fillStyle = '#587389';
        ctx.fillRect(fx + 1, fy + 1, f.w - 2, 1);
        break;
      case 'antenna':
        ctx.fillStyle = 'rgba(0,0,0,0.35)';
        ctx.fillRect(fx, fy, 1, 1);
        ctx.fillStyle = '#c8ccd2';
        ctx.fillRect(fx, fy - 2, 1, 3);
        break;
    }
  }
  ctx.restore();
}

const TREE_TONES = ['#2f5a33', '#39653a', '#2a4f36'] as const;

function drawTree(
  ctx: CanvasRenderingContext2D,
  map: CityMap,
  tree: TreeInstance,
  cam: Vec2,
  cx: number,
  cy: number,
): void {
  const [lx, ly] = lean(tree.x, tree.y, cx, cy, 1.6);
  const x = tree.x - cam.x + lx;
  const y = tree.y - cam.y + ly;
  const tone = TREE_TONES[treeTone(map, tree)] as string;
  ctx.fillStyle = shade(tone, -0.25);
  ctx.beginPath();
  ctx.arc(x, y, tree.r, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = tone;
  ctx.beginPath();
  ctx.arc(x - tree.r * 0.15, y - tree.r * 0.15, tree.r * 0.8, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = shade(tone, 0.18);
  ctx.beginPath();
  ctx.arc(x - tree.r * 0.3, y - tree.r * 0.3, tree.r * 0.4, 0, Math.PI * 2);
  ctx.fill();
}
