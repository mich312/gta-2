import type { Catalog, FullSnapshot, GameEvent, PlayerState, ShopKind, Vec2 } from 'shared';
import { INTERNAL_HEIGHT, INTERNAL_WIDTH, TICK_RATE } from 'shared';

/** What the server tells us about the job in hand. */
export interface MissionView {
  active: boolean;
  text: string;
  tier: string;
  employer: string;
  progress: number;
  target: number;
  secondsLeft: number;
  marker: { x: number; y: number } | null;
  /** Remaining checkpoints for a race; the first of them is `marker`. */
  route?: Array<{ x: number; y: number }>;
  /** Position in the employer's chain, 0/0 when this is off-chain work. */
  chainStep?: number;
  chainOf?: number;
}

const BUY_KEYS = ['Y', 'U', 'I', 'O', 'H', 'J', 'N', 'P'];
/** Gang colours, in gang-id order. Mirrors shared/data/gangs.json. */
const GANG_COLORS = [
  '#c8543c',
  '#4aa86a',
  '#4a7ac8',
  '#a86ac8',
  '#c8a03c',
  '#3cc8b4',
  '#c85a8c',
];
const GANG_NAMES = [
  'Kessler Row',
  'Sunnyside',
  'The Quay',
  'Halloran',
  'Marrow Street',
  'The Vaults',
  'Ostrey',
];

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
  /** Score multiplier. Every award is worth this much more. */
  multiplier = 1;
  private multiplierChangedAtMs = 0;
  accountName: string | null = null;
  /** Named landmark the player is at, shown so the city is legible. */
  place: string | null = null;
  /** District the player is standing in, for the standing readout. */
  district: string | null = null;
  /** What the garage bolted to the car the player is currently in. */
  fitting = '';
  fittingAmmo = 0;
  /** The job in hand, straight off the wire. */
  private mission: MissionView | null = null;
  /** Vehicle kinds the crushers are paying over the odds for. */
  private exportKinds: string[] = [];
  private exportBonus = 1;

  private feed: FeedLine[] = [];
  private tracers: Tracer[] = [];
  /** Previous health, for spotting the moment damage lands. */
  private lastHealth = 100;
  private hurtUntilMs = 0;
  /** Wall-clock ms the local player died at; drives the death fade. */
  private diedAtMs = 0;
  private wasDead = false;
  /** True while the current down-state is an arrest rather than a death. */
  private wasBusted = false;

  notice(text: string): void {
    this.feed.push({ text, expiresAtMs: performance.now() + 5000 });
    while (this.feed.length > 5) this.feed.shift();
  }

  /** Lifetime earned per district: how well each one knows you (L3). */
  private standing: Record<string, number> = {};

  /** A `wallet` message landed. Announce the multiplier only when it moves. */
  setWallet(cash: number, multiplier: number, standing: Record<string, number> = {}): void {
    this.cash = cash;
    this.standing = standing;
    if (multiplier !== this.multiplier) {
      const up = multiplier > this.multiplier;
      // The first climb off ×1 is the one worth explaining; after that the
      // number in the corner speaks for itself.
      if (up && this.multiplier === 1) this.notice(`multiplier ×${multiplier} — everything pays more`);
      else if (!up) this.notice(`multiplier down to ×${multiplier}`);
      this.multiplier = multiplier;
      this.multiplierChangedAtMs = performance.now();
    }
  }

  /** A `missionState` message landed. */
  setMission(m: MissionView): void {
    const had = this.mission?.active === true;
    this.mission = m;
    if (m.active && !had) this.notice(`${m.employer}: ${m.text}`);
  }

  /** Marker the renderer should point at, if any. */
  get missionMarker(): { x: number; y: number } | null {
    return this.mission?.active ? this.mission.marker : null;
  }

  /** The rest of a race's checkpoints, drawn dim behind the next one. */
  get missionRoute(): Array<{ x: number; y: number }> {
    return this.mission?.active ? (this.mission.route ?? []) : [];
  }

  /** The crushers' shopping list changed. */
  setExports(kinds: string[], bonus: number): void {
    const fresh = kinds.join(',') !== this.exportKinds.join(',');
    this.exportKinds = kinds;
    this.exportBonus = bonus;
    if (fresh && kinds.length > 0) this.notice(`wanted at the crushers: ${kinds.join(', ')}`);
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
    ctx.strokeStyle =
      kind === 'gun'
        ? '#c8583c'
        : kind === 'spray'
          ? '#c8a03c'
          : kind === 'clinic'
            ? '#e06a6a'
            : '#3ca0c8';
    ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
    ctx.font = '8px monospace';
    ctx.fillStyle = '#e8f0e8';
    ctx.fillText(
      kind === 'gun'
        ? 'GUN SHOP'
        : kind === 'spray'
          ? "PAY'N'SPRAY"
          : kind === 'clinic'
            ? 'HOSPITAL'
            : 'CLOTHING',
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
    }
    // Arrives one tick before the snapshot showing you down, which is why
    // the flag is set here and read by the overlay rather than derived.
    if (event.type === 'busted') this.wasBusted = true;
    if (event.type === 'gangTurned' && event.hostile) {
      this.notice(`${GANG_NAMES[event.gangId - 1] ?? 'a gang'} wants you off their streets`);
    }
    if (event.type === 'jailCardUsed') this.notice('you walk — card spent');
    // A firefight two streets away is worth knowing about: it is the clearest
    // sign the city has business of its own. Rate-limited by the feed itself,
    // which keeps five lines and drops the oldest.
    if (event.type === 'gangFight') {
      const a = GANG_NAMES[event.gangId - 1] ?? 'a gang';
      const b = GANG_NAMES[event.rivalId - 1] ?? 'a gang';
      const line = `${a} and ${b} are at it`;
      if (this.feed[this.feed.length - 1]?.text !== line) this.notice(line);
    }
  }

  /**
   * A round in flight. Called by the event handler rather than driven off
   * `shot` here, because a `shot` is not necessarily a shot: the sim reports a
   * punch the same way, and drawing a tracer for one put a bullet line and a
   * puff of smoke on the end of the player's fist. Only the caller knows which
   * weapon threw the event, so only the caller may ask for a tracer.
   */
  tracer(x0: number, y0: number, x1: number, y1: number): void {
    this.tracers.push({ x0, y0, x1, y1, expiresAtMs: performance.now() + 70 });
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

    // What is bolted to the car you are in, and how much of it is left.
    if (me.mode === 'driving' && this.fitting) {
      ctx.fillStyle = '#d8b45a';
      ctx.font = '8px monospace';
      ctx.fillText(
        this.fittingAmmo > 1 ? `[F] ${this.fitting} ${this.fittingAmmo}` : `[F] ${this.fitting}`,
        6,
        INTERNAL_HEIGHT - 17,
      );
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

    // The job in hand, top centre under the stars: employer, what they want,
    // how far along you are and how long you have. A mission you have to
    // remember is a mission you will fail for the wrong reason.
    if (this.mission?.active) {
      const m = this.mission;
      ctx.textAlign = 'center';
      ctx.font = '8px monospace';
      ctx.fillStyle =
        m.tier === 'red' ? '#e07a6a' : m.tier === 'yellow' ? '#e0c86a' : '#8fd6a0';
      const chain =
        m.chainOf && m.chainStep ? `  [${m.chainStep}/${m.chainOf}]` : '';
      ctx.fillText(`${m.employer.toUpperCase()} — ${m.text}${chain}`, INTERNAL_WIDTH / 2, 34);
      ctx.fillStyle = m.secondsLeft <= 15 ? '#e05555' : '#c0cad0';
      ctx.fillText(
        `${m.progress}/${m.target}   ${m.secondsLeft}s`,
        INTERNAL_WIDTH / 2,
        44,
      );
      ctx.textAlign = 'left';
    }

    // Respect, one bar per gang, always all of them. Showing only the gang
    // whose ground you are on would hide the cost of what you just did:
    // the point of the mechanic is that pleasing one displeases another.
    //
    // On its own backing panel because the first version drew 3px bars
    // straight onto the road and was, in practice, invisible.
    if (me.respect.length > 0) {
      // Narrower bars rather than fewer of them. Seven at the old 26px is
      // 220px of a 480px screen; showing only the nearby gangs would fit, but
      // the panel's whole reason for existing is that pleasing one gang
      // displeases another, and hiding four of them hides the mechanic.
      const bw = me.respect.length > 4 ? 14 : 26;
      const gap = me.respect.length > 4 ? 3 : 4;
      const panelW = me.respect.length * (bw + gap) + 10;
      const panelH = 20;
      const panelX = INTERNAL_WIDTH / 2 - panelW / 2;
      const panelY = INTERNAL_HEIGHT - 34;
      ctx.fillStyle = 'rgba(8, 12, 16, 0.72)';
      ctx.fillRect(panelX, panelY, panelW, panelH);
      ctx.strokeStyle = 'rgba(200, 220, 235, 0.25)';
      ctx.strokeRect(panelX + 0.5, panelY + 0.5, panelW - 1, panelH - 1);
      ctx.font = '8px monospace';
      ctx.fillStyle = '#8fa8c8';
      ctx.fillText('RESPECT', panelX + 5, panelY + 8);

      me.respect.forEach((value, i) => {
        const x = panelX + 5 + i * (bw + gap);
        const y = panelY + 12;
        // An empty track you can see, so "neutral with everybody" still
        // reads as a state rather than as nothing being drawn.
        ctx.fillStyle = 'rgba(255, 255, 255, 0.13)';
        ctx.fillRect(x, y, bw, 4);
        const frac = Math.max(-1, Math.min(1, value / 60));
        const half = bw / 2;
        ctx.fillStyle = GANG_COLORS[i] ?? '#8fa8c8';
        if (frac >= 0) ctx.fillRect(x + half, y, Math.max(1, half * frac), 4);
        else ctx.fillRect(x + half + half * frac, y, Math.max(1, -half * frac), 4);
        // Centre tick, so you can see which side of neutral you are on.
        ctx.fillStyle = 'rgba(230, 240, 250, 0.65)';
        ctx.fillRect(x + half, y - 1, 1, 6);
      });
    }

    // The export list, bottom right: the city's standing order, and the
    // reason to drive past three cars to take a fourth.
    if (this.exportKinds.length > 0) {
      ctx.font = '8px monospace';
      ctx.textAlign = 'right';
      ctx.fillStyle = '#8fa8c8';
      // NOT "WANTED": that word belongs to the police, and using it here for
      // the crushers' shopping list put two unrelated meanings on screen at
      // once.
      ctx.fillText(`EXPORT x${this.exportBonus}`, INTERNAL_WIDTH - 6, INTERNAL_HEIGHT - 46);
      ctx.fillStyle = '#d8c88f';
      this.exportKinds.forEach((k, i) => {
        ctx.fillText(k, INTERNAL_WIDTH - 6, INTERNAL_HEIGHT - 37 + i * 8);
      });
      ctx.textAlign = 'left';
    }

    // Where you are. The city had nothing to navigate by and nowhere to
    // arrange to meet; a name under the radar is most of the fix.
    if (this.place) {
      ctx.fillStyle = '#a8b8c8';
      ctx.font = '8px monospace';
      ctx.textAlign = 'right';
      ctx.fillText(this.place, INTERNAL_WIDTH - 6, 90);
      // How well this district knows you, under its name. Standing is
      // invisible otherwise, and an invisible gate is indistinguishable from
      // a broken shop: the first thing it does is refuse to sell you a
      // rocket, and you have to be able to see why.
      if (this.district) {
        const earned = this.standing[this.district] ?? 0;
        ctx.fillStyle = '#7f93a8';
        ctx.fillText(`${this.district} · known $${earned}`, INTERNAL_WIDTH - 6, 100);
      }
      ctx.textAlign = 'left';
    }

    // Active power-ups, under the wanted stars. Named, because a coloured
    // pip tells you something is on but not what, and these change how the
    // game plays rather than topping up a bar.
    if (me.powerFlags !== 0 && snapshot) {
      const secs = Math.max(0, Math.ceil((me.powerUntilTick - snapshot.tick) / TICK_RATE));
      const lit: string[] = [];
      if ((me.powerFlags & 1) !== 0) lit.push(`DOUBLE DAMAGE ${secs}`);
      if ((me.powerFlags & 2) !== 0) lit.push(`INVISIBLE ${secs}`);
      if ((me.powerFlags & 4) !== 0) lit.push(`FAST RELOAD ${secs}`);
      if ((me.powerFlags & 8) !== 0) lit.push('GET OUT OF JAIL FREE');
      // Without this, being stunned is indistinguishable from the game
      // having stopped listening to you — which is the worst thing a
      // multiplayer game can look like.
      if ((me.powerFlags & 16) !== 0) lit.push('STUNNED');
      ctx.textAlign = 'center';
      lit.forEach((text, i) => {
        ctx.fillStyle = i === lit.length - 1 && (me.powerFlags & 8) !== 0 ? '#e8e0c0' : '#ff9a5a';
        ctx.fillText(text, INTERNAL_WIDTH / 2, 22 + i * 10);
      });
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
    // The multiplier sits beside the cash because it is a property of the
    // cash: it says what the next thing you do is worth. It pulses for a
    // second when it moves, in either direction — losing it should sting.
    if (this.multiplier > 1) {
      const since = now - this.multiplierChangedAtMs;
      ctx.fillStyle = since < 1000 && Math.floor(since / 125) % 2 === 0 ? '#fff2a8' : '#f0c040';
      ctx.fillText(`×${this.multiplier}`, 6 + ctx.measureText(`$${this.cash}`).width + 5, 10);
    }
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
      // Two ways down, two colours: red for the hospital, blue for the cells.
      // They cost different things, so they must not look the same.
      ctx.fillStyle = this.wasBusted
        ? `rgba(0, 6, 20, ${(0.6 * t).toFixed(3)})`
        : `rgba(18, 0, 0, ${(0.55 * t).toFixed(3)})`;
      ctx.fillRect(0, 0, INTERNAL_WIDTH, INTERNAL_HEIGHT);
      ctx.textAlign = 'center';
      ctx.fillStyle = this.wasBusted
        ? `rgba(190, 212, 240, ${t.toFixed(3)})`
        : `rgba(232, 196, 196, ${t.toFixed(3)})`;
      ctx.font = '16px monospace';
      ctx.fillText(this.wasBusted ? 'BUSTED' : 'WASTED', INTERNAL_WIDTH / 2, INTERNAL_HEIGHT / 2 - 4);
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
      this.wasBusted = false;
    }
  }
}
