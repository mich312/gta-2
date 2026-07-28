import type { InputIntent } from 'shared';
import type { Screen } from '../render/canvas.js';
import { viewport } from '../render/viewport.js';

/**
 * Keyboard + mouse sampling. Produces InputIntents at sim-tick cadence;
 * nothing here touches the sim directly. `~` toggles the debug overlay.
 */
export class InputSource {
  /** Mouse position in internal-resolution pixels. */
  mouseX = viewport.w / 2;
  mouseY = viewport.h / 2;

  private readonly keys = new Set<string>();
  private mouseDown = false;
  /** Weapon slot pressed since the last sample; -1 = no change. */
  private pendingSlot = -1;
  /** Shop row key (Y/U/I/O -> 0..3) pressed since last check. */
  private pendingBuyRow: number | null = null;
  /** 'login' | 'register' requested via L / K. */
  private pendingAccountAction: 'login' | 'register' | null = null;
  /** M pressed since the last check. */
  private pendingMute = false;
  private pendingMission: 'take' | 'abandon' | null = null;
  /** Any input at all yet? Browsers gate AudioContext behind a gesture. */
  private gestured = false;

  constructor(screen: Screen, onToggleOverlay: () => void) {
    window.addEventListener('keydown', (e) => {
      if (e.code === 'Backquote') {
        onToggleOverlay();
        e.preventDefault();
        return;
      }
      const slotMatch = /^Digit([1-8])$/.exec(e.code);
      if (slotMatch) this.pendingSlot = Number.parseInt(slotMatch[1] as string, 10) - 1;
      // Eight, not four: the gun shop's shelf grew past the original row of
      // keys when launchers and thrown weapons arrived, and a shop item you
      // cannot press a key for is an item that does not exist.
      const buyRows: Record<string, number> = {
        KeyY: 0,
        KeyU: 1,
        KeyI: 2,
        KeyO: 3,
        KeyH: 4,
        KeyJ: 5,
        KeyN: 6,
        KeyP: 7,
      };
      if (e.code in buyRows) this.pendingBuyRow = buyRows[e.code] as number;
      if (e.code === 'KeyM') this.pendingMute = true;
      // R answers the phone. The action key is spoken for by car doors.
      if (e.code === 'KeyR') this.pendingMission = 'take';
      if (e.code === 'KeyG') this.pendingMission = 'abandon';
      this.gestured = true;
      if (e.code === 'KeyL') this.pendingAccountAction = 'login';
      if (e.code === 'KeyK') this.pendingAccountAction = 'register';
      this.keys.add(e.code);
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => {
      this.keys.clear();
      this.mouseDown = false;
    });
    screen.canvas.addEventListener('mousemove', (e) => {
      const rect = screen.canvas.getBoundingClientRect();
      this.mouseX = (e.clientX - rect.left) / screen.scale;
      this.mouseY = (e.clientY - rect.top) / screen.scale;
    });
    screen.canvas.addEventListener('mousedown', () => {
      this.mouseDown = true;
      this.gestured = true;
    });
    window.addEventListener('mouseup', () => (this.mouseDown = false));
    screen.canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  consumeBuyRow(): number | null {
    const row = this.pendingBuyRow;
    this.pendingBuyRow = null;
    return row;
  }

  consumeMute(): boolean {
    const m = this.pendingMute;
    this.pendingMute = false;
    return m;
  }

  /** Answering the phone (R) or walking away from the job (G). */
  consumeMissionAction(): 'take' | 'abandon' | null {
    const a = this.pendingMission;
    this.pendingMission = null;
    return a;
  }

  /** True once the user has pressed or clicked anything at all. */
  get hasGestured(): boolean {
    return this.gestured;
  }

  consumeAccountAction(): 'login' | 'register' | null {
    const a = this.pendingAccountAction;
    this.pendingAccountAction = null;
    return a;
  }

  private has(...codes: string[]): boolean {
    return codes.some((c) => this.keys.has(c));
  }

  /**
   * playerScreen: the local player's position in internal-res pixels, so aim
   * is computed relative to the avatar rather than the screen centre.
   */
  sample(seq: number, tick: number, playerScreen: { x: number; y: number } | null): InputIntent {
    const px = playerScreen?.x ?? viewport.w / 2;
    const py = playerScreen?.y ?? viewport.h / 2;
    const slot = this.pendingSlot;
    this.pendingSlot = -1;
    return {
      seq,
      tick,
      up: this.has('KeyW', 'ArrowUp'),
      down: this.has('KeyS', 'ArrowDown'),
      left: this.has('KeyA', 'ArrowLeft'),
      right: this.has('KeyD', 'ArrowRight'),
      fire: this.mouseDown || this.has('Space'),
      // Math.atan2 is fine here: the angle is input DATA sent to the sim,
      // not a computation the sim will redo.
      aimAngle: Math.atan2(this.mouseY - py, this.mouseX - px),
      action: this.has('KeyE', 'Enter'),
      // F for whatever the garage bolted on. Separate from fire, because a
      // driver can lean out with a pistol and work the guns at the same time.
      fitting: this.has('KeyF'),
      // Held is one press: the sim edge-triggers it, and this stops a leant-on
      // key sending thirty horn intents a second.
      // Not H: that is already a shop row. The sim edge-triggers this, so a
      // leant-on key is one press rather than thirty a second.
      horn: this.has('KeyQ'),
      slot,
    };
  }
}
