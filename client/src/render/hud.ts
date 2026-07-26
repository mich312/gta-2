import type { Catalog, FullSnapshot, GameEvent, PlayerState, ShopKind, Vec2 } from 'shared';
import { INTERNAL_HEIGHT, INTERNAL_WIDTH, TICK_RATE } from 'shared';

const BUY_KEYS = ['Y', 'U', 'I', 'O'];

interface FeedLine {
  text: string;
  expiresAtMs: number;
}

interface Tracer {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  expiresAtMs: number;
}

/** Health/ammo HUD, kill feed, tracers, shop panel, death screen. */
export class Hud {
  cash = 0;
  accountName: string | null = null;

  private feed: FeedLine[] = [];
  private tracers: Tracer[] = [];

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

  drawShop(ctx: CanvasRenderingContext2D, kind: ShopKind, rows: Array<[string, number]>): void {
    const w = 150;
    const h = rows.length * 11 + 24;
    const x = INTERNAL_WIDTH / 2 - w / 2;
    const y = INTERNAL_HEIGHT - h - 26;
    ctx.fillStyle = 'rgba(8, 12, 16, 0.85)';
    ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = kind === 'gun' ? '#c8583c' : '#3ca0c8';
    ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
    ctx.font = '8px monospace';
    ctx.fillStyle = '#e8f0e8';
    ctx.fillText(kind === 'gun' ? 'GUN SHOP' : 'CLOTHING', x + 5, y + 10);
    rows.forEach(([id, price], i) => {
      ctx.fillStyle = '#c0cad0';
      ctx.fillText(`[${BUY_KEYS[i]}] ${id} $${price}`, x + 5, y + 21 + i * 11);
    });
  }

  onEvent(event: GameEvent, nameOf: (id: number) => string): void {
    const now = performance.now();
    if (event.type === 'kill') {
      const by = event.weaponId === 'vehicle' ? 'ran over' : `killed`;
      this.feed.push({
        text: `${nameOf(event.killerId)} ${by} ${nameOf(event.victimId)}`,
        expiresAtMs: now + 6000,
      });
      while (this.feed.length > 5) this.feed.shift();
    } else if (event.type === 'shot') {
      this.tracers.push({
        x0: event.x0,
        y0: event.y0,
        x1: event.x1,
        y1: event.y1,
        expiresAtMs: now + 70,
      });
    }
  }

  draw(
    ctx: CanvasRenderingContext2D,
    me: PlayerState | null,
    snapshot: FullSnapshot | null,
    cam: Vec2,
  ): void {
    const now = performance.now();
    this.feed = this.feed.filter((f) => f.expiresAtMs > now);
    this.tracers = this.tracers.filter((t) => t.expiresAtMs > now);

    // Tracers (world space).
    ctx.strokeStyle = 'rgba(255, 240, 180, 0.8)';
    for (const t of this.tracers) {
      ctx.beginPath();
      ctx.moveTo(Math.floor(t.x0 - cam.x), Math.floor(t.y0 - cam.y));
      ctx.lineTo(Math.floor(t.x1 - cam.x), Math.floor(t.y1 - cam.y));
      ctx.stroke();
    }

    // Kill feed (top right).
    ctx.font = '8px monospace';
    ctx.textAlign = 'right';
    ctx.fillStyle = '#e8e0c8';
    this.feed.forEach((f, i) => ctx.fillText(f.text, INTERNAL_WIDTH - 4, 10 + i * 10));
    ctx.textAlign = 'left';

    if (!me) return;

    // Health bar (bottom left).
    const w = 70;
    ctx.fillStyle = '#000000aa';
    ctx.fillRect(4, INTERNAL_HEIGHT - 22, w + 2, 18);
    ctx.fillStyle = me.health > 30 ? '#57c98a' : '#e05555';
    ctx.fillRect(5, INTERNAL_HEIGHT - 21, Math.max(0, (me.health / 100) * w), 6);
    ctx.strokeStyle = '#ffffff55';
    ctx.strokeRect(4.5, INTERNAL_HEIGHT - 21.5, w + 1, 7);

    // Weapon + ammo.
    const slot = me.weapons[me.activeWeapon];
    ctx.fillStyle = '#d8e0e8';
    ctx.font = '8px monospace';
    ctx.fillText(slot ? `${slot.weaponId} ${slot.ammo}` : 'unarmed', 6, INTERNAL_HEIGHT - 7);

    // Wanted stars.
    if (me.wantedLevel > 0) {
      ctx.fillStyle = '#f0c040';
      ctx.textAlign = 'center';
      ctx.fillText('★'.repeat(me.wantedLevel), INTERNAL_WIDTH / 2, 10);
      ctx.textAlign = 'left';
    }

    // Wallet + account (top left, under the overlay's zone).
    ctx.fillStyle = '#bde8bd';
    ctx.fillText(`$${this.cash}`, 6, 10);
    if (this.accountName) {
      ctx.fillStyle = '#8fa8c8';
      ctx.fillText(this.accountName, 6, 20);
    }

    // Death overlay.
    if (me.mode === 'dead' && snapshot) {
      ctx.fillStyle = 'rgba(20, 0, 0, 0.45)';
      ctx.fillRect(0, 0, INTERNAL_WIDTH, INTERNAL_HEIGHT);
      const secs =
        me.respawnAtTick !== null
          ? Math.max(0, Math.ceil((me.respawnAtTick - snapshot.tick) / TICK_RATE))
          : 0;
      ctx.fillStyle = '#f0d0d0';
      ctx.font = '10px monospace';
      ctx.textAlign = 'center';
      ctx.fillText(`wasted — respawning in ${secs}`, INTERNAL_WIDTH / 2, INTERNAL_HEIGHT / 2);
      ctx.textAlign = 'left';
    }
  }
}
