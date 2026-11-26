// Keyboard + mouse state with per-frame "pressed" edges and pointer-lock aware mouse deltas.
export class Input {
  constructor(target) {
    this.down = new Set();
    this.pressed = new Set();
    this.released = new Set();
    this.mouseDown = [false, false, false];
    this.mousePressed = [false, false, false];
    this.mouseDX = 0;
    this.mouseDY = 0;
    this.locked = false;
    this.enabled = false; // only true while the game is being played
    this.keyboardLocked = false; // true when Keyboard Lock is active (fullscreen, Chrome/Edge)

    addEventListener('keydown', (e) => {
      if (!this.enabled) return;
      if (['Space', 'Tab', 'F3', 'KeyF'].includes(e.code)) e.preventDefault();
      if (!this.down.has(e.code)) this.pressed.add(e.code);
      this.down.add(e.code);
    });
    addEventListener('keyup', (e) => {
      this.down.delete(e.code);
      this.released.add(e.code);
    });
    target.addEventListener('mousedown', (e) => {
      if (!this.enabled) return;
      this.mouseDown[e.button] = true;
      this.mousePressed[e.button] = true;
    });
    addEventListener('mouseup', (e) => { this.mouseDown[e.button] = false; });
    addEventListener('contextmenu', (e) => e.preventDefault());
    addEventListener('mousemove', (e) => {
      if (!this.enabled) return;
      this.mouseDX += e.movementX || 0;
      this.mouseDY += e.movementY || 0;
    });
    addEventListener('blur', () => this.clear());
  }

  isDown(code) { return this.enabled && this.down.has(code); }
  wasPressed(code) { return this.enabled && this.pressed.has(code); }

  consumeMouse() {
    const d = [this.mouseDX, this.mouseDY];
    this.mouseDX = this.mouseDY = 0;
    return d;
  }

  endFrame() {
    this.pressed.clear();
    this.released.clear();
    this.mousePressed = [false, false, false];
  }

  clear() {
    this.down.clear();
    this.mouseDown = [false, false, false];
    this.mouseDX = this.mouseDY = 0;
  }
}
