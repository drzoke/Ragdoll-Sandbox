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
    this.wheel = 0;          // accumulated wheel steps this frame (+ = down/towards user)
    this.locked = false;
    this.enabled = false; // only true while the game is being played
    this.keyboardLocked = false; // true when Keyboard Lock is active (fullscreen, Chrome/Edge)
    this.axis = { x: 0, y: 0 };  // analogue movement from the touch stick (x right, y back), -1..1
    this.touchMode = false;      // touch controls are on: ignore the browser's emulated mouse events

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
      if (!this.enabled || this.touchMode) return;
      this.mouseDown[e.button] = true;
      this.mousePressed[e.button] = true;
    });
    addEventListener('mouseup', (e) => { this.mouseDown[e.button] = false; });
    addEventListener('contextmenu', (e) => e.preventDefault());
    addEventListener('mousemove', (e) => {
      if (!this.enabled || (this.touchMode && !document.pointerLockElement)) return;
      this.mouseDX += e.movementX || 0;
      this.mouseDY += e.movementY || 0;
    });
    addEventListener('wheel', (e) => {
      if (!this.enabled) return;
      this.wheel += Math.sign(e.deltaY);
    }, { passive: true });
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
    this.wheel = 0;
  }

  clear() {
    this.down.clear();
    this.axis.x = this.axis.y = 0;
    this.mouseDown = [false, false, false];
    this.mouseDX = this.mouseDY = 0;
  }
}
