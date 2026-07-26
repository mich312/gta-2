import type { Catalog, FullSnapshot, GameEvent, PlayerState, ShopKind } from 'shared';
import { INTERNAL_HEIGHT, INTERNAL_WIDTH, TICK_RATE } from 'shared';

const BUY_KEYS = ['Y', 'U', 'I', 'O'];

interface FeedLine {
  text: string;
  expiresAtMs: number;
}

/**
 * Diegetic-ish HUD: framed panels, a health bar with a damage ghost that
 * bleeds down after hits, procedural weapon glyphs, easing cash counter,
 * pulsing wanted stars and a proper WASTED card. All draws are plain
 * fills/text at internal resolution — no allocations in the frame loop
 * beyond the feed array.
 */
export class Hud {
  cash = 0;
  accountName: string | null = null;

  private feed: FeedLine[] = [];
  /** Trails the real health downward for the classic ghost-damage bar. */
  private ghostHealth = 100;
  private shownCash = 0;
  private lastWanted = 0;
  private wantedFlashUntil = 0;

  notice(text: string): void {
    this.feed.push({ text, expiresAtMs: performance.now() + 5000 });
    while (this.feed.length > 5) this.feed.shift();
  }

  /** Items for the shop the player is standing in, in stable order. */
  shopRows(catalog: Catalog, kind: ShopKind): Array<[string, number]> {
    return Object.entries(catalog)
      .filter(([, item]) => item.shop === kind)
      .slice(0, BUY_KEYS.length)
      .map(([id, item]) => [id, item.price]);
  }

  onEvent(event: GameEvent, nameOf: (id: number) => string): void {
    if (event.type === 'kill') {
      const by = event.weaponId === 'vehicle' ? 'ran over' : 'killed';
      this.feed.push({
        text: `${nameOf(event.killerId)} ${by} ${nameOf(event.victimId)}`,
        expiresAtMs: performance.now() + 6000,
      });
      while (this.feed.length > 5) this.feed.shift();
    }
  }

  drawShop(ctx: CanvasRenderingContext2D, kind: ShopKind, rows: Array<[string, number]>): void {
    const w = 168;
    const h = rows.length * 12 + 30;
    const x = Math.floor(INTERNAL_WIDTH / 2 - w / 2);
    const y = INTERNAL_HEIGHT - h - 30;
    const accent = kind === 'gun' ? '#c8583c' : '#3ca0c8';

    panel(ctx, x, y, w, h, accent);
    ctx.font = '8px monospace';
    ctx.fillStyle = accent;
    ctx.fillText(kind === 'gun' ? '▪ GUN SHOP' : '▪ CLOTHING', x + 6, y + 11);
    ctx.fillStyle = 'rgba(200, 210, 220, 0.5)';
    ctx.fillText('press key to buy', x + w - 82, y + 11);
    ctx.fillStyle = 'rgba(255,255,255,0.12)';
    ctx.fillRect(x + 4, y + 15, w - 8, 1);

    rows.forEach(([id, price], i) => {
      const ry = y + 26 + i * 12;
      const affordable = price <= this.cash;
      ctx.fillStyle = affordable ? '#e8f0e8' : '#7a828c';
      ctx.fillText(`[${BUY_KEYS[i]}]`, x + 6, ry);
      ctx.fillText(id, x + 30, ry);
      ctx.fillStyle = affordable ? '#bde8bd' : '#8c7a7a';
      const priceText = `$${price}`;
      ctx.fillText(priceText, x + w - 6 - priceText.length * 5, ry);
    });
  }

  draw(
    ctx: CanvasRenderingContext2D,
    me: PlayerState | null,
    snapshot: FullSnapshot | null,
    dtMs: number,
  ): void {
    const now = performance.now();
    this.feed = this.feed.filter((f) => f.expiresAtMs > now);

    // Kill feed, top right, each line on its own backing strip.
    ctx.font = '8px monospace';
    this.feed.forEach((f, i) => {
      const tw = f.text.length * 5 + 8;
      const fx = INTERNAL_WIDTH - tw - 3;
      const fy = 5 + i * 11;
      const alpha = Math.min(1, (f.expiresAtMs - now) / 800);
      ctx.fillStyle = `rgba(8, 11, 16, ${(0.62 * alpha).toFixed(3)})`;
      ctx.fillRect(fx, fy, tw, 10);
      ctx.fillStyle = `rgba(226, 218, 190, ${alpha.toFixed(3)})`;
      ctx.fillText(f.text, fx + 4, fy + 8);
    });

    if (!me) return;

    // ------------------------------------------------------ vitals panel
    const px = 4;
    const py = INTERNAL_HEIGHT - 30;
    panel(ctx, px, py, 96, 26, '#2e3742');

    // Health with ghost trail.
    const barW = 86;
    this.ghostHealth = Math.max(me.health, this.ghostHealth - dtMs * 0.045);
    if (me.health >= this.ghostHealth) this.ghostHealth = me.health;
    ctx.fillStyle = '#161b22';
    ctx.fillRect(px + 5, py + 5, barW, 6);
    ctx.fillStyle = 'rgba(214, 128, 60, 0.85)';
    ctx.fillRect(px + 5, py + 5, Math.max(0, (this.ghostHealth / 100) * barW), 6);
    const healthColor = me.health > 60 ? '#57c98a' : me.health > 30 ? '#d0b04a' : '#e05555';
    ctx.fillStyle = healthColor;
    ctx.fillRect(px + 5, py + 5, Math.max(0, (me.health / 100) * barW), 6);
    ctx.fillStyle = 'rgba(255,255,255,0.14)';
    ctx.fillRect(px + 5, py + 5, Math.max(0, (me.health / 100) * barW), 1);

    // Weapon glyph + ammo.
    const slot = me.weapons[me.activeWeapon];
    drawWeaponGlyph(ctx, px + 5, py + 15, slot ? slot.weaponId : null);
    ctx.font = '8px monospace';
    ctx.fillStyle = '#d8e0e8';
    ctx.fillText(slot ? `${slot.weaponId}` : 'unarmed', px + 22, py + 22);
    if (slot) {
      const ammoText = String(slot.ammo);
      ctx.fillStyle = slot.ammo <= 10 ? '#e08a55' : '#9ab0c4';
      ctx.fillText(ammoText, px + 96 - 6 - ammoText.length * 5, py + 22);
    }

    // -------------------------------------------------------- cash panel
    this.shownCash += (this.cash - this.shownCash) * Math.min(1, dtMs / 120);
    if (Math.abs(this.cash - this.shownCash) < 1) this.shownCash = this.cash;
    const cashText = `$${Math.round(this.shownCash)}`;
    panel(ctx, 4, 4, cashText.length * 5 + 12, 13, '#2e3742');
    ctx.font = '8px monospace';
    ctx.fillStyle = '#bde8bd';
    ctx.fillText(cashText, 10, 13);
    if (this.accountName) {
      ctx.fillStyle = 'rgba(143, 168, 200, 0.8)';
      ctx.fillText(this.accountName, 10, 24);
    }

    // ------------------------------------------------------ wanted stars
    if (me.wantedLevel > this.lastWanted) this.wantedFlashUntil = now + 900;
    this.lastWanted = me.wantedLevel;
    if (me.wantedLevel > 0) {
      const flash = now < this.wantedFlashUntil && Math.floor(now / 120) % 2 === 0;
      const cx0 = INTERNAL_WIDTH / 2 - 5 * 11 / 2;
      for (let i = 0; i < 5; i++) {
        const filled = i < me.wantedLevel;
        ctx.font = '9px monospace';
        ctx.fillStyle = filled ? (flash ? '#ffffff' : '#f0c040') : 'rgba(120, 126, 140, 0.35)';
        ctx.fillText('★', cx0 + i * 11, 12);
      }
    }

    // ------------------------------------------------------ death screen
    if (me.mode === 'dead' && snapshot) {
      ctx.fillStyle = 'rgba(12, 2, 2, 0.55)';
      ctx.fillRect(0, 0, INTERNAL_WIDTH, INTERNAL_HEIGHT);
      const secs =
        me.respawnAtTick !== null
          ? Math.max(0, Math.ceil((me.respawnAtTick - snapshot.tick) / TICK_RATE))
          : 0;

      const word = 'WASTED';
      ctx.font = 'bold 24px monospace';
      ctx.textAlign = 'center';
      ctx.fillStyle = 'rgba(0, 0, 0, 0.6)';
      ctx.fillText(word, INTERNAL_WIDTH / 2 + 2, INTERNAL_HEIGHT / 2 + 2);
      ctx.fillStyle = '#c03a3a';
      ctx.fillText(word, INTERNAL_WIDTH / 2, INTERNAL_HEIGHT / 2);
      ctx.font = '8px monospace';
      ctx.fillStyle = '#d8c0c0';
      ctx.fillText(`respawning in ${secs}`, INTERNAL_WIDTH / 2, INTERNAL_HEIGHT / 2 + 16);
      ctx.textAlign = 'left';

      // Respawn progress sliver.
      if (me.respawnAtTick !== null) {
        const total = 90; // RESPAWN_DELAY_TICKS
        const remaining = Math.max(0, me.respawnAtTick - snapshot.tick);
        const frac = 1 - Math.min(1, remaining / total);
        const bw = 120;
        ctx.fillStyle = 'rgba(255,255,255,0.15)';
        ctx.fillRect(INTERNAL_WIDTH / 2 - bw / 2, INTERNAL_HEIGHT / 2 + 24, bw, 3);
        ctx.fillStyle = '#c03a3a';
        ctx.fillRect(INTERNAL_WIDTH / 2 - bw / 2, INTERNAL_HEIGHT / 2 + 24, bw * frac, 3);
      }
    }
  }
}

/** Dark framed panel with an accent corner tick. */
function panel(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, accent: string): void {
  ctx.fillStyle = 'rgba(9, 12, 17, 0.82)';
  ctx.fillRect(x, y, w, h);
  ctx.strokeStyle = 'rgba(160, 175, 190, 0.28)';
  ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
  ctx.fillStyle = accent;
  ctx.fillRect(x, y, 2, 2);
  ctx.fillRect(x + w - 2, y + h - 2, 2, 2);
}

/** 14×8 pixel-art weapon icons, drawn inline (fist when unarmed). */
function drawWeaponGlyph(ctx: CanvasRenderingContext2D, x: number, y: number, weaponId: string | null): void {
  const steel = '#c3cad2';
  const dark = '#697280';
  switch (weaponId) {
    case 'pistol':
      ctx.fillStyle = steel;
      ctx.fillRect(x, y + 2, 10, 2);
      ctx.fillRect(x + 1, y + 4, 3, 3);
      ctx.fillStyle = dark;
      ctx.fillRect(x + 9, y + 1, 1, 1);
      break;
    case 'smg':
      ctx.fillStyle = steel;
      ctx.fillRect(x, y + 2, 13, 2);
      ctx.fillRect(x + 2, y + 4, 3, 3);
      ctx.fillRect(x + 8, y + 4, 2, 2);
      ctx.fillStyle = dark;
      ctx.fillRect(x + 11, y, 2, 2);
      break;
    case 'shotgun':
      ctx.fillStyle = '#8a6a4a';
      ctx.fillRect(x, y + 2, 4, 3);
      ctx.fillStyle = steel;
      ctx.fillRect(x + 4, y + 2, 10, 2);
      ctx.fillStyle = dark;
      ctx.fillRect(x + 4, y + 4, 4, 1);
      break;
    default:
      // Fist.
      ctx.fillStyle = '#d8a577';
      ctx.fillRect(x + 2, y + 1, 6, 6);
      ctx.fillStyle = '#b8865a';
      ctx.fillRect(x + 3, y + 2, 1, 4);
      ctx.fillRect(x + 5, y + 2, 1, 4);
      break;
  }
}
