import type { InputIntent } from 'shared';
import { INTERNAL_HEIGHT, INTERNAL_WIDTH } from 'shared';
import type { Screen } from '../render/canvas.js';

/**
 * Keyboard + mouse sampling. Produces InputIntents at sim-tick cadence;
 * nothing here touches the sim directly. `~` toggles the debug overlay.
 */
export class InputSource {
  /** Mouse position in internal-resolution pixels. */
  mouseX = INTERNAL_WIDTH / 2;
  mouseY = INTERNAL_HEIGHT / 2;

  private readonly keys = new Set<string>();
  private mouseDown = false;

  constructor(screen: Screen, onToggleOverlay: () => void) {
    window.addEventListener('keydown', (e) => {
      if (e.code === 'Backquote') {
        onToggleOverlay();
        e.preventDefault();
        return;
      }
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
    screen.canvas.addEventListener('mousedown', () => (this.mouseDown = true));
    window.addEventListener('mouseup', () => (this.mouseDown = false));
    screen.canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  private has(...codes: string[]): boolean {
    return codes.some((c) => this.keys.has(c));
  }

  /**
   * playerScreen: the local player's position in internal-res pixels, so aim
   * is computed relative to the avatar rather than the screen centre.
   */
  sample(seq: number, tick: number, playerScreen: { x: number; y: number } | null): InputIntent {
    const px = playerScreen?.x ?? INTERNAL_WIDTH / 2;
    const py = playerScreen?.y ?? INTERNAL_HEIGHT / 2;
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
    };
  }
}
