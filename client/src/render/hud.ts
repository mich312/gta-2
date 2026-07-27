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
  /** Named landmark the player is at, shown so the city is legible. */
  place: string | null = null;

  private feed: FeedLine[] = [];
  private tracers: Tracer[] = [];
  /** Previous health, for spotting the moment damage lands. */
  private lastHealth = 100;
  private hurtUntilMs = 0;
  /** Wall-clock ms the local player died at; drives the death fade. */
  private diedAtMs = 0;
  private wasDead = false;

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
    ctx.strokeStyle = kind === 'gun' ? '#c8583c' : kind === 'spray' ? '#c8a03c' : '#3ca0c8';
    ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
    ctx.font = '8px monospace';
    ctx.fillStyle = '#e8f0e8';
    ctx.fillText(
      kind === 'gun' ? 'GUN SHOP' : kind === 'spray' ? "PAY'N'SPRAY" : 'CLOTHING',
      x + 5,
      y + 10,
    );
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
    speed = 0,
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
    // Armour rides directly under health — it is spent first, so it reads as
    // the outer layer of the same bar.
    if (me.armour > 0) {
      ctx.fillStyle = '#5aa8e0';
      ctx.fillRect(5, INTERNAL_HEIGHT - 13, Math.max(0, (me.armour / 100) * w), 3);
    }

    // Weapon + ammo. Fists have no magazine, so they show no number, and a
    // nearly-empty gun turns amber before it turns into a problem.
    const slot = me.weapons[me.activeWeapon];
    ctx.font = '8px monospace';
    if (!slot) {
      ctx.fillStyle = '#d8e0e8';
      ctx.fillText('unarmed', 6, INTERNAL_HEIGHT - 7);
    } else if (slot.weaponId === 'fists') {
      ctx.fillStyle = '#d8e0e8';
      ctx.fillText('fists', 6, INTERNAL_HEIGHT - 7);
    } else {
      ctx.fillStyle = slot.ammo <= 10 ? '#e0a03c' : '#d8e0e8';
      ctx.fillText(`${slot.weaponId} ${slot.ammo}`, 6, INTERNAL_HEIGHT - 7);
    }

    // Speedometer, driving only.
    if (me.mode === 'driving') {
      ctx.fillStyle = '#9fb4c4';
      ctx.textAlign = 'right';
      ctx.fillText(`${Math.round(Math.abs(speed))}`, INTERNAL_WIDTH - 84, INTERNAL_HEIGHT - 7);
      ctx.textAlign = 'left';
    }

    // Damage flash: a red vignette on the frame health actually dropped.
    if (me.health < this.lastHealth) this.hurtUntilMs = now + 220;
    this.lastHealth = me.health;
    if (now < this.hurtUntilMs) {
      const a = ((this.hurtUntilMs - now) / 220) * 0.3;
      ctx.fillStyle = `rgba(180, 20, 20, ${a.toFixed(3)})`;
      ctx.fillRect(0, 0, INTERNAL_WIDTH, INTERNAL_HEIGHT);
    }

    // Where you are. The city had nothing to navigate by and nowhere to
    // arrange to meet; a name under the radar is most of the fix.
    if (this.place) {
      ctx.fillStyle = '#a8b8c8';
      ctx.font = '8px monospace';
      ctx.textAlign = 'right';
      ctx.fillText(this.place, INTERNAL_WIDTH - 6, 90);
      ctx.textAlign = 'left';
    }

    // Kill frenzy: the only thing on screen with a clock on it.
    if (me.frenzyTarget > 0 && snapshot) {
      const left = me.frenzyEndsAtTick
        ? Math.max(0, Math.ceil((me.frenzyEndsAtTick - snapshot.tick) / TICK_RATE))
        : 0;
      const w = 96;
      const x = INTERNAL_WIDTH / 2 - w / 2;
      ctx.fillStyle = 'rgba(8, 12, 16, 0.8)';
      ctx.fillRect(x, 20, w, 20);
      ctx.strokeStyle = left <= 5 ? '#e05555' : '#f0c040';
      ctx.strokeRect(x + 0.5, 20.5, w - 1, 19);
      ctx.fillStyle = '#f0c040';
      ctx.font = '8px monospace';
      ctx.textAlign = 'center';
      ctx.fillText('KILL FRENZY', INTERNAL_WIDTH / 2, 30);
      ctx.fillStyle = '#e8f0e8';
      ctx.fillText(`${me.frenzyKills} / ${me.frenzyTarget}    ${left}s`, INTERNAL_WIDTH / 2, 38);
      ctx.textAlign = 'left';
    }

    // Airborne: a shadow gap under the car is not readable on its own, so
    // say it.
    if (me.z > 0) {
      ctx.fillStyle = '#f0e0a0';
      ctx.font = '8px monospace';
      ctx.textAlign = 'center';
      ctx.fillText('AIRBORNE', INTERNAL_WIDTH / 2, INTERNAL_HEIGHT - 40);
      ctx.textAlign = 'left';
    }

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

    // Death: a beat, not a switch. The overlay eases in over half a second
    // so dying registers as something that happened to you.
    if (me.mode === 'dead') {
      if (!this.wasDead) {
        this.diedAtMs = now;
        this.wasDead = true;
      }
      const t = Math.min(1, (now - this.diedAtMs) / 500);
      ctx.fillStyle = `rgba(18, 0, 0, ${(0.55 * t).toFixed(3)})`;
      ctx.fillRect(0, 0, INTERNAL_WIDTH, INTERNAL_HEIGHT);
      ctx.textAlign = 'center';
      ctx.fillStyle = `rgba(232, 196, 196, ${t.toFixed(3)})`;
      ctx.font = '16px monospace';
      ctx.fillText('WASTED', INTERNAL_WIDTH / 2, INTERNAL_HEIGHT / 2 - 4);
      if (snapshot) {
        const secs =
          me.respawnAtTick !== null
            ? Math.max(0, Math.ceil((me.respawnAtTick - snapshot.tick) / TICK_RATE))
            : 0;
        ctx.font = '8px monospace';
        ctx.fillStyle = `rgba(200, 170, 170, ${t.toFixed(3)})`;
        ctx.fillText(`respawning in ${secs}`, INTERNAL_WIDTH / 2, INTERNAL_HEIGHT / 2 + 10);
      }
      ctx.textAlign = 'left';
    } else {
      this.wasDead = false;
    }
  }
}
