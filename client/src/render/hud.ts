import type { Catalog, FullSnapshot, GameEvent, PlayerState, ShopKind, Vec2 } from 'shared';
import { DEPOT_ROWS, getTuning } from 'shared';
import { viewport } from './viewport.js';
import {
  PART_HEADLIGHT_L,
  PART_HEADLIGHT_R,
  PART_RADIATOR,
  PART_TAILLIGHT_L,
  PART_TAILLIGHT_R,
  PART_TYRE_FL,
  PART_TYRE_FR,
  PART_TYRE_RL,
  PART_TYRE_RR,
  TICK_RATE,
  ZONE_FRONT,
  ZONE_LEFT,
  ZONE_REAR,
  ZONE_RIGHT,
} from 'shared';

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
  /**
   * Condition of the car being driven, for the damage diagram.
   *
   * `carWear` was computed on every frame and sent only to the debug overlay,
   * so the one readout the driver actually needed was the one nobody could
   * see. Null when on foot.
   */
  car: { zones: number[]; broken: number; wear: number; maxHealth: number } | null = null;
  /** Wall-clock ms the "get out" alarm stops flashing at. */
  private alarmUntilMs = 0;

  /** Flash the panel: the car is on a fuse and you have this long. */
  alarm(seconds: number): void {
    this.alarmUntilMs = performance.now() + seconds * 1000;
  }
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
    // The proving ground has no catalog and no prices — it is a debug room,
    // not a shop, and the only thing it borrows is this panel.
    if (kind === 'depot') {
      return DEPOT_ROWS.slice(0, BUY_KEYS.length).map((r) => [r.id, 0]);
    }
    return Object.entries(catalog)
      .filter(([, item]) => item.shop === kind)
      .slice(0, BUY_KEYS.length)
      .map(([id, item]) => [id, item.price]);
  }

  drawShop(ctx: CanvasRenderingContext2D, kind: ShopKind, rows: Array<[string, number]>): void {
    const w = 150;
    const h = rows.length * 11 + 24;
    const x = viewport.w / 2 - w / 2;
    const y = viewport.h - h - 26;
    ctx.fillStyle = 'rgba(8, 12, 16, 0.85)';
    ctx.fillRect(x, y, w, h);
    ctx.strokeStyle =
      kind === 'gun'
        ? '#c8583c'
        : kind === 'spray'
          ? '#c8a03c'
          : kind === 'clinic'
            ? '#e06a6a'
            : kind === 'depot'
              ? '#7ad46a'
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
            : kind === 'depot'
              ? 'PROVING GROUND'
              : 'CLOTHING',
      x + 5,
      y + 10,
    );
    rows.forEach(([id, price], i) => {
      ctx.fillStyle = '#c0cad0';
      // Nothing in the proving ground has a price, and printing "$0" against
      // eight rows reads as a bug rather than as a gift.
      ctx.fillText(`[${BUY_KEYS[i]}] ${id}${price > 0 ? ` $${price}` : ''}`, x + 5, y + 21 + i * 11);
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

  /**
   * The damage diagram: a plan view of the car with the bent panels shaded
   * and the broken parts picked out.
   *
   * A bar would have said the same thing as `health`, which is the thing the
   * driver could already infer. What they could not see is WHICH corner has
   * gone, which lamp is out and whether a tyre is flat — the facts that
   * decide whether to keep the car or dump it.
   */
  private drawCarCondition(
    ctx: CanvasRenderingContext2D,
    car: { zones: number[]; broken: number; wear: number; maxHealth: number },
    now: number,
  ): void {
    const w = 26;
    const h = 15;
    const x = viewport.w - w - 6;
    const y = viewport.h - h - 6;
    const flashing = now < this.alarmUntilMs && Math.floor(now / 160) % 2 === 0;

    ctx.fillStyle = flashing ? 'rgba(120, 20, 16, 0.85)' : 'rgba(10, 12, 16, 0.72)';
    ctx.fillRect(x - 2, y - 2, w + 4, h + 4);

    // The body, nose to the right, matching the speedometer's reading order.
    // Each quadrant is tinted by how much damage it has taken.
    const zoneRects: Array<[number, number, number, number, number]> = [
      [ZONE_FRONT, x + w * 0.62, y + h * 0.18, w * 0.36, h * 0.64],
      [ZONE_REAR, x + w * 0.02, y + h * 0.18, w * 0.36, h * 0.64],
      [ZONE_LEFT, x + w * 0.2, y, w * 0.6, h * 0.3],
      [ZONE_RIGHT, x + w * 0.2, y + h * 0.7, w * 0.6, h * 0.3],
    ];
    ctx.fillStyle = '#3c4652';
    ctx.fillRect(x + w * 0.02, y + h * 0.18, w * 0.96, h * 0.64);
    ctx.fillRect(x + w * 0.2, y, w * 0.6, h);
    for (const [z, rx, ry, rw, rh] of zoneRects) {
      // Saturates at a third of the car's health into one quadrant, which is
      // about where that corner has nothing left to give.
      const t = Math.min(1, (car.zones[z] ?? 0) / Math.max(1, car.maxHealth * 0.33));
      if (t <= 0.02) continue;
      const r = Math.round(70 + t * 150);
      const g = Math.round(90 - t * 60);
      ctx.fillStyle = `rgba(${r}, ${g}, 40, ${(0.35 + t * 0.55).toFixed(2)})`;
      ctx.fillRect(rx, ry, rw, rh);
    }

    // Lamps: lit while they are there, dark sockets once they are not.
    const lamp = (lx: number, ly: number, out: boolean): void => {
      ctx.fillStyle = out ? '#2a2a2e' : '#e8dfa8';
      ctx.fillRect(lx, ly, 2, 2);
    };
    lamp(x + w - 3, y + 2, (car.broken & PART_HEADLIGHT_L) !== 0);
    lamp(x + w - 3, y + h - 4, (car.broken & PART_HEADLIGHT_R) !== 0);
    lamp(x + 1, y + 2, (car.broken & PART_TAILLIGHT_L) !== 0);
    lamp(x + 1, y + h - 4, (car.broken & PART_TAILLIGHT_R) !== 0);

    // Flat tyres, at the corners they are actually at.
    const tyre = (tx: number, ty: number, flat: boolean): void => {
      if (!flat) return;
      ctx.fillStyle = '#d8543c';
      ctx.fillRect(tx, ty, 3, 2);
    };
    tyre(x + w * 0.66, y - 1, (car.broken & PART_TYRE_FL) !== 0);
    tyre(x + w * 0.66, y + h - 1, (car.broken & PART_TYRE_FR) !== 0);
    tyre(x + w * 0.18, y - 1, (car.broken & PART_TYRE_RL) !== 0);
    tyre(x + w * 0.18, y + h - 1, (car.broken & PART_TYRE_RR) !== 0);

    // A holed radiator is the one that stops you finishing the job.
    if ((car.broken & PART_RADIATOR) !== 0) {
      ctx.fillStyle = '#e8a33c';
      ctx.font = '7px monospace';
      ctx.textAlign = 'right';
      ctx.fillText('RAD', x - 4, y + h - 4);
      ctx.textAlign = 'left';
      ctx.font = '8px monospace';
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
    this.feed.forEach((f, i) => ctx.fillText(f.text, viewport.w - 4, 10 + i * 10));
    ctx.textAlign = 'left';

    if (!me) return;

    // Health bar (bottom left).
    const w = 70;
    ctx.fillStyle = '#000000aa';
    ctx.fillRect(4, viewport.h - 22, w + 2, 18);
    ctx.fillStyle = me.health > 30 ? '#57c98a' : '#e05555';
    ctx.fillRect(5, viewport.h - 21, Math.max(0, (me.health / 100) * w), 6);
    ctx.strokeStyle = '#ffffff55';
    ctx.strokeRect(4.5, viewport.h - 21.5, w + 1, 7);
    // Armour rides directly under health — it is spent first, so it reads as
    // the outer layer of the same bar.
    if (me.armour > 0) {
      ctx.fillStyle = '#5aa8e0';
      ctx.fillRect(5, viewport.h - 13, Math.max(0, (me.armour / 100) * w), 3);
    }

    // Weapon + ammo. Fists have no magazine, so they show no number, and a
    // nearly-empty gun turns amber before it turns into a problem.
    const slot = me.weapons[me.activeWeapon];
    ctx.font = '8px monospace';
    if (!slot) {
      ctx.fillStyle = '#d8e0e8';
      ctx.fillText('unarmed', 6, viewport.h - 7);
    } else if (slot.weaponId === 'fists') {
      ctx.fillStyle = '#d8e0e8';
      ctx.fillText('fists', 6, viewport.h - 7);
    } else {
      ctx.fillStyle = slot.ammo <= 10 ? '#e0a03c' : '#d8e0e8';
      ctx.fillText(`${slot.weaponId} ${slot.ammo}`, 6, viewport.h - 7);
    }

    // What is bolted to the car you are in, and how much of it is left.
    if (me.mode === 'driving' && this.fitting) {
      ctx.fillStyle = '#d8b45a';
      ctx.font = '8px monospace';
      ctx.fillText(
        this.fittingAmmo > 1 ? `[F] ${this.fitting} ${this.fittingAmmo}` : `[F] ${this.fitting}`,
        6,
        viewport.h - 17,
      );
    }

    // Speedometer, driving only.
    if (me.mode === 'driving') {
      ctx.fillStyle = '#9fb4c4';
      ctx.textAlign = 'right';
      ctx.fillText(`${Math.round(Math.abs(speed))}`, viewport.w - 84, viewport.h - 7);
      ctx.textAlign = 'left';
      if (this.car) this.drawCarCondition(ctx, this.car, now);
    }

    // Damage flash: a red vignette on the frame health actually dropped.
    if (me.health < this.lastHealth) this.hurtUntilMs = now + 220;
    this.lastHealth = me.health;
    if (now < this.hurtUntilMs) {
      const a = ((this.hurtUntilMs - now) / 220) * 0.3;
      ctx.fillStyle = `rgba(180, 20, 20, ${a.toFixed(3)})`;
      ctx.fillRect(0, 0, viewport.w, viewport.h);
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
      ctx.fillText(`${m.employer.toUpperCase()} — ${m.text}${chain}`, viewport.w / 2, 34);
      ctx.fillStyle = m.secondsLeft <= 15 ? '#e05555' : '#c0cad0';
      ctx.fillText(
        `${m.progress}/${m.target}   ${m.secondsLeft}s`,
        viewport.w / 2,
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
      const panelX = viewport.w / 2 - panelW / 2;
      const panelY = viewport.h - 34;
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
      ctx.fillText(`EXPORT x${this.exportBonus}`, viewport.w - 6, viewport.h - 46);
      ctx.fillStyle = '#d8c88f';
      this.exportKinds.forEach((k, i) => {
        ctx.fillText(k, viewport.w - 6, viewport.h - 37 + i * 8);
      });
      ctx.textAlign = 'left';
    }

    // Where you are. The city had nothing to navigate by and nowhere to
    // arrange to meet; a name under the radar is most of the fix.
    if (this.place) {
      ctx.fillStyle = '#a8b8c8';
      ctx.font = '8px monospace';
      ctx.textAlign = 'right';
      ctx.fillText(this.place, viewport.w - 6, 90);
      // How well this district knows you, under its name. Standing is
      // invisible otherwise, and an invisible gate is indistinguishable from
      // a broken shop: the first thing it does is refuse to sell you a
      // rocket, and you have to be able to see why.
      if (this.district) {
        const earned = this.standing[this.district] ?? 0;
        ctx.fillStyle = '#7f93a8';
        ctx.fillText(`${this.district} · known $${earned}`, viewport.w - 6, 100);
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
        ctx.fillText(text, viewport.w / 2, 22 + i * 10);
      });
      ctx.textAlign = 'left';
    }

    // Kill frenzy: the only thing on screen with a clock on it.
    if (me.frenzyTarget > 0 && snapshot) {
      const left = me.frenzyEndsAtTick
        ? Math.max(0, Math.ceil((me.frenzyEndsAtTick - snapshot.tick) / TICK_RATE))
        : 0;
      const w = 96;
      const x = viewport.w / 2 - w / 2;
      ctx.fillStyle = 'rgba(8, 12, 16, 0.8)';
      ctx.fillRect(x, 20, w, 20);
      ctx.strokeStyle = left <= 5 ? '#e05555' : '#f0c040';
      ctx.strokeRect(x + 0.5, 20.5, w - 1, 19);
      ctx.fillStyle = '#f0c040';
      ctx.font = '8px monospace';
      ctx.textAlign = 'center';
      ctx.fillText('KILL FRENZY', viewport.w / 2, 30);
      ctx.fillStyle = '#e8f0e8';
      ctx.fillText(`${me.frenzyKills} / ${me.frenzyTarget}    ${left}s`, viewport.w / 2, 38);
      ctx.textAlign = 'left';
    }

    // Airborne: a shadow gap under the car is not readable on its own, so
    // say it.
    if (me.z > 0) {
      ctx.fillStyle = '#f0e0a0';
      ctx.font = '8px monospace';
      ctx.textAlign = 'center';
      ctx.fillText('AIRBORNE', viewport.w / 2, viewport.h - 40);
      ctx.textAlign = 'left';
    }

    // Wanted stars, and — the half that makes a chase a game rather than a
    // countdown to death — whether you are currently getting away with it.
    //
    // The stars dim and a clock appears the moment nobody official has eyes
    // on you, and it counts down to the point where the heat starts coming
    // off. Without it the escape is invisible: the player has no way to tell
    // "they have lost me, keep going" from "they are about to come round that
    // corner", and a mechanic nobody can perceive is not a mechanic. See
    // GTA.md P1b.
    if (me.wantedLevel > 0) {
      const cool = getTuning().police.wantedCooldownTicks;
      const hidden = me.unseenTicks > 0;
      const clear = me.unseenTicks >= cool;
      ctx.textAlign = 'center';
      // Bright while they can see you, dim while they cannot, and green once
      // the heat is actually draining.
      ctx.fillStyle = clear ? '#8fd88f' : hidden ? '#8a7a3c' : '#f0c040';
      ctx.fillText('★'.repeat(me.wantedLevel), viewport.w / 2, 10);
      if (hidden) {
        const left = Math.max(0, Math.ceil((cool - me.unseenTicks) / TICK_RATE));
        ctx.fillStyle = clear ? '#8fd88f' : '#cfcfcf';
        ctx.fillText(clear ? 'losing them' : `hidden ${left}`, viewport.w / 2, 19);
      }
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
      ctx.fillRect(0, 0, viewport.w, viewport.h);
      ctx.textAlign = 'center';
      ctx.fillStyle = this.wasBusted
        ? `rgba(190, 212, 240, ${t.toFixed(3)})`
        : `rgba(232, 196, 196, ${t.toFixed(3)})`;
      ctx.font = '16px monospace';
      ctx.fillText(this.wasBusted ? 'BUSTED' : 'WASTED', viewport.w / 2, viewport.h / 2 - 4);
      if (snapshot) {
        const secs =
          me.respawnAtTick !== null
            ? Math.max(0, Math.ceil((me.respawnAtTick - snapshot.tick) / TICK_RATE))
            : 0;
        ctx.font = '8px monospace';
        ctx.fillStyle = `rgba(200, 170, 170, ${t.toFixed(3)})`;
        ctx.fillText(`respawning in ${secs}`, viewport.w / 2, viewport.h / 2 + 10);
      }
      ctx.textAlign = 'left';
    } else {
      this.wasDead = false;
      this.wasBusted = false;
    }
  }
}
