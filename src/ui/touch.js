import { settings } from '../settings.js';

/*
 * Touch controls for phones and tablets (played sideways).
 *
 *  - Left thumb: a movement stick. In the Optimal layout it appears wherever the thumb lands on the
 *    left side; pushing it past the ring while going forward sprints.
 *  - Right thumb: drag anywhere that isn't a button to look around. The fire button also looks
 *    while it is held, so you can shoot and track a target with one thumb.
 *  - Buttons change with the item: Fire / Aim / Reload / Inspect for guns, Jab / Hook for fists,
 *    Throw / Lob for the grenade, Grab / Throw / Closer / Farther for the grab tool.
 *  - Top bar: pause, toolbox, spawn menu, slow time, speed up time, x-ray (off → 3D → flat).
 *  - Machete: Slash / Stab. Medkit: Treat (hold) / Morphine / Blood. Defibrillator: Shock (hold, let go).
 *
 * Everything is fed into the normal Input object (virtual keys, mouse buttons, mouse deltas and an
 * analogue stick axis), so the game logic doesn't know whether a keyboard or a finger is used.
 */

const ICONS = {
  fire: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="7" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="12" cy="12" r="2" fill="currentColor"/><path d="M12 1v5M12 18v5M1 12h5M18 12h5" stroke="currentColor" stroke-width="2"/></svg>',
  aim: '<svg viewBox="0 0 24 24"><path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="12" cy="12" r="3.2" fill="currentColor"/></svg>',
  fist: '<svg viewBox="0 0 24 24"><rect x="5" y="7" width="12" height="11" rx="2" fill="currentColor"/><rect x="17" y="9" width="4" height="7" rx="1" fill="currentColor" opacity=".7"/><path d="M8 10h6M8 13h6" stroke="#000" stroke-opacity=".35" stroke-width="1.4"/></svg>',
  hook: '<svg viewBox="0 0 24 24"><path d="M4 18c2-9 8-13 15-12" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/><path d="M15 3l5 3-4 4" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  throw: '<svg viewBox="0 0 24 24"><circle cx="8" cy="15" r="5" fill="currentColor"/><path d="M12 9c3-4 6-5 10-5M18 2l4 2-2 4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
  lob: '<svg viewBox="0 0 24 24"><circle cx="6" cy="17" r="4" fill="currentColor"/><path d="M9 13c3-9 9-10 12-2M21 11l-1 4-3-2" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
  grab: '<svg viewBox="0 0 24 24"><path d="M6 11V6a1.5 1.5 0 013 0v4m0-1V4.5a1.5 1.5 0 013 0V10m0-4.5a1.5 1.5 0 013 0V11m0-3a1.5 1.5 0 013 0v6c0 4-3 7-7 7s-6-2-8-5l-2-3a1.5 1.5 0 012.4-1.8L7 14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  reload: '<svg viewBox="0 0 24 24"><path d="M20 12a8 8 0 11-2.4-5.7" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/><path d="M20 3v5h-5" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  inspect: '<svg viewBox="0 0 24 24"><circle cx="10" cy="10" r="6" fill="none" stroke="currentColor" stroke-width="2.2"/><path d="M15 15l6 6" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"/></svg>',
  closer: '<svg viewBox="0 0 24 24"><path d="M12 4v14M6 12l6 6 6-6" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  farther: '<svg viewBox="0 0 24 24"><path d="M12 20V6M6 12l6-6 6 6" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  jump: '<svg viewBox="0 0 24 24"><path d="M5 14l7-7 7 7M5 20l7-7 7 7" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  crouch: '<svg viewBox="0 0 24 24"><path d="M5 5l7 7 7-7M4 19h16" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  use: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="12" cy="12" r="3.5" fill="currentColor"/></svg>',
  pause: '<svg viewBox="0 0 24 24"><rect x="6" y="5" width="4" height="14" rx="1" fill="currentColor"/><rect x="14" y="5" width="4" height="14" rx="1" fill="currentColor"/></svg>',
  toolbox: '<svg viewBox="0 0 24 24"><rect x="3" y="3" width="8" height="8" rx="1.5" fill="currentColor"/><rect x="13" y="3" width="8" height="8" rx="1.5" fill="currentColor"/><rect x="3" y="13" width="8" height="8" rx="1.5" fill="currentColor"/><rect x="13" y="13" width="8" height="8" rx="1.5" fill="currentColor" opacity=".5"/></svg>',
  slow: '<svg viewBox="0 0 24 24"><path d="M11 6l-7 6 7 6zM20 6l-7 6 7 6z" fill="currentColor"/></svg>',
  fast: '<svg viewBox="0 0 24 24"><path d="M4 6l7 6-7 6zM13 6l7 6-7 6z" fill="currentColor"/></svg>',
  spawn: '<svg viewBox="0 0 24 24"><circle cx="10" cy="7" r="3.5" fill="currentColor"/><path d="M3.5 20c0-4 3-6.5 6.5-6.5s6.5 2.5 6.5 6.5z" fill="currentColor"/><path d="M19 8v6M16 11h6" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>',
  slash: '<svg viewBox="0 0 24 24"><path d="M4 20L18 4l2 2L7 21z" fill="currentColor"/><path d="M3 21l3-1-2-2z" fill="currentColor" opacity=".6"/></svg>',
  stab: '<svg viewBox="0 0 24 24"><path d="M2 12h13l6-3v6l-6-3" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linejoin="round"/><path d="M2 9v6" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"/></svg>',
  medkit: '<svg viewBox="0 0 24 24"><rect x="3" y="6" width="18" height="14" rx="2.5" fill="currentColor"/><path d="M9 6V4h6v2" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 9.5v7M8.5 13h7" stroke="#000" stroke-opacity=".55" stroke-width="2.4" stroke-linecap="round"/></svg>',
  syringe: '<svg viewBox="0 0 24 24"><path d="M15 3l6 6M18 6l-9 9-4 1 1-4 9-9M3 21l3-3" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  blood: '<svg viewBox="0 0 24 24"><path d="M12 3c3 4.5 6 7.5 6 11a6 6 0 01-12 0c0-3.5 3-6.5 6-11z" fill="currentColor"/></svg>',
  bolt: '<svg viewBox="0 0 24 24"><path d="M13 2L4 14h6l-1 8 9-12h-6z" fill="currentColor"/></svg>',
  xray: '<svg viewBox="0 0 24 24"><circle cx="12" cy="5" r="2.6" fill="currentColor"/><path d="M12 8v8M7 10h10M8 13h8M12 16l-3 5M12 16l3 5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
};

/** Layout buttons (the ones you can move in the layout editor). base = diameter in px. */
const BUTTONS = {
  fire: { base: 84, kind: 'fire', look: true, primary: true },
  fireL: { base: 58, kind: 'fire' },
  alt: { base: 64, kind: 'alt' },
  reload: { base: 52, kind: 'key', code: 'KeyR' },
  inspect: { base: 46, kind: 'key', code: 'KeyF' },
  jump: { base: 58, kind: 'key', code: 'Space' },
  crouch: { base: 52, kind: 'toggle', code: 'KeyC' },
  use: { base: 58, kind: 'key', code: 'KeyE' },
};

/**
 * Layout presets: centre of each button as a fraction of the screen (inside the safe area).
 * stick: null = floating (appears under the thumb), otherwise its resting place.
 */
export const LAYOUTS = {
  optimal: {
    label: 'Optimal', side: 'left', floating: true,
    pos: { stick: [0.15, 0.73], fire: [0.885, 0.64], fireL: [0.085, 0.36], alt: [0.75, 0.79], reload: [0.765, 0.5], inspect: [0.665, 0.6], jump: [0.955, 0.4], crouch: [0.955, 0.89], use: [0.6, 0.66] },
  },
  classic: {
    label: 'Classic', side: 'left', floating: false,
    pos: { stick: [0.15, 0.66], fire: [0.87, 0.6], alt: [0.87, 0.28], reload: [0.74, 0.84], inspect: [0.65, 0.88], jump: [0.965, 0.82], crouch: [0.745, 0.55], use: [0.6, 0.62] },
  },
};
LAYOUTS.lefty = {
  label: 'Left-handed', side: 'right', floating: true,
  pos: Object.fromEntries(Object.entries(LAYOUTS.optimal.pos).map(([k, [x, y]]) => [k, [1 - x, y]])),
};

/** What the buttons do and say for each item. */
function toolButtons(tool) {
  switch (tool?.name) {
    case 'Fists': return { fire: ['Jab', 'fist'], alt: ['Hook', 'hook'] };
    case 'M1911':
    case 'Remington 870': return { fire: ['Fire', 'fire'], alt: ['Aim', 'aim', 'aim'], reload: ['Reload', 'reload'], inspect: ['Inspect', 'inspect'] };
    case 'Grenade': return { fire: ['Throw', 'throw'], alt: ['Lob', 'lob'] };
    case 'Machete': return { fire: ['Slash', 'slash'], alt: ['Stab', 'stab'] };
    case 'Medkit': return { fire: ['Treat', 'medkit'], alt: ['Morphine', 'syringe'], reload: ['Blood', 'blood'] };
    case 'Defibrillator': return { fire: ['Shock', 'bolt'] };
    case 'Grab': return tool.held
      ? { fire: ['Throw', 'throw'], alt: ['Drop', 'grab'], reload: ['Closer', 'closer', 'hold'], inspect: ['Farther', 'farther', 'hold'] }
      : { fire: ['Push', 'throw'], alt: ['Grab', 'grab'] };
    default: return { fire: ['Use', 'fire'], alt: ['Alt', 'aim'] };
  }
}

const SIZE_MUL = { small: 0.84, medium: 1, large: 1.2 };
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

export class TouchControls {
  /**
   * opts: input, toolbox, onPause(), onXray(), isAiming(), onEditDone()
   */
  constructor(opts) {
    this.o = opts;
    this.input = opts.input;
    this.active = false;
    this.playing = false;
    this.editing = false;
    this.portrait = false;
    this.toolName = '';
    this.aimLatched = false;
    this.crouchLatched = false;
    this.fireDown = new Set();   // pointer ids holding a fire button
    this.altDown = null;         // pointer id holding the alt button (hold mode / non-guns)
    this.keyHolds = new Map();   // pointer id -> key code held
    this.stick = null;           // { id, cx, cy, x, y }
    this.look = null;            // { id, x, y }
    this.lookFrom = new Map();   // pointer id -> last position (look pointer and fire buttons)
    this.useVisible = false;
    this.labelsKey = '';
    this.build();
    settings.onChange((k) => { if (k.startsWith('touch')) this.layout(); });
    addEventListener('resize', () => this.layout());
    screen.orientation?.addEventListener?.('change', () => setTimeout(() => this.layout(), 60));
  }

  // ------------------------------------------------------------------ DOM
  build() {
    const root = this.root = document.createElement('div');
    root.id = 'touch';
    root.className = 'hidden';
    root.innerHTML = `
      <div class="tc-area">
        <div class="tc-stick"><div class="tc-ring"></div><div class="tc-knob"></div><span>Sprint</span></div>
        ${Object.entries(BUTTONS).map(([id, b]) => `<div class="tc-btn tc-${b.kind}${b.primary ? ' primary' : ''}" data-id="${id}"><i></i><b></b></div>`).join('')}
        <div class="tc-top left"><div class="tc-mini" data-act="pause" title="Pause">${ICONS.pause}</div><div class="tc-mini" data-act="toolbox" title="Toolbox">${ICONS.toolbox}</div><div class="tc-mini" data-act="spawn" title="Spawn menu">${ICONS.spawn}</div></div>
        <div class="tc-top right"><div class="tc-mini" data-act="slow" title="Slow down time">${ICONS.slow}</div><div class="tc-mini" data-act="fast" title="Speed up time">${ICONS.fast}</div><div class="tc-mini wide" data-act="xray" title="X-ray">${ICONS.xray}<em>X-ray</em></div></div>
      </div>
      <div class="tc-edit hidden"><span>Drag the buttons to move them</span><button data-edit="reset">Reset</button><button data-edit="done" class="on">Done</button></div>`;
    document.body.appendChild(root);
    this.area = root.querySelector('.tc-area');
    this.stickEl = root.querySelector('.tc-stick');
    this.knob = root.querySelector('.tc-knob');
    this.btns = Object.fromEntries([...root.querySelectorAll('.tc-btn')].map((el) => [el.dataset.id, el]));
    this.editBar = root.querySelector('.tc-edit');

    // rotate-your-phone screen
    this.rotate = document.createElement('div');
    this.rotate.id = 'rotate';
    this.rotate.className = 'hidden';
    this.rotate.innerHTML = `<div><svg viewBox="0 0 64 64"><rect x="20" y="6" width="24" height="42" rx="4" fill="none" stroke="currentColor" stroke-width="3"/><path d="M10 40a24 24 0 0 0 26 18" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"/><path d="M33 52l4 6-7 2" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg><b>Turn your phone sideways</b><span>The game plays in landscape.</span></div>`;
    document.body.appendChild(this.rotate);

    root.addEventListener('pointerdown', (e) => this.down(e));
    root.addEventListener('pointermove', (e) => this.move(e));
    root.addEventListener('pointerup', (e) => this.up(e));
    root.addEventListener('pointercancel', (e) => this.up(e));
    root.addEventListener('contextmenu', (e) => e.preventDefault());
    this.editBar.addEventListener('click', (e) => {
      const b = e.target.closest('button'); if (!b) return;
      if (b.dataset.edit === 'reset') { this.editPos = structuredClone(LAYOUTS[this.editBase].pos); this.layout(); }
      else this.finishEdit();
    });
    // stop the page from zooming or scrolling on double taps / pinches
    for (const ev of ['gesturestart', 'gesturechange', 'dblclick']) document.addEventListener(ev, (e) => { if (this.active) e.preventDefault(); }, { passive: false });
    document.addEventListener('touchmove', (e) => { if (this.active && e.target.closest?.('#touch, #game')) e.preventDefault(); }, { passive: false });
  }

  /** Turn the touch controls on or off (body.touch switches the HUD to its mobile layout). */
  setActive(on) {
    this.active = on;
    this.input.touchMode = on;
    document.body.classList.toggle('touch', on);
    this.root.classList.toggle('hidden', !on);
    this.reset();
    this.layout();
  }

  setPlaying(p) {
    this.playing = p;
    if (!p) this.reset();
    this.refreshVisibility();
  }

  refreshVisibility() {
    this.root.classList.toggle('hidden', !this.active || (!this.playing && !this.editing));
    this.portrait = this.active && innerHeight > innerWidth * 1.05;
    this.rotate.classList.toggle('hidden', !(this.active && this.playing && this.portrait));
  }

  // ------------------------------------------------------------------ layout
  currentLayout() {
    if (this.editing) return { ...LAYOUTS[this.editBase], pos: this.editPos };
    const name = settings.get('touchLayout');
    if (name === 'custom') {
      const c = settings.get('touchCustom');
      if (c && LAYOUTS[c.base]) return { ...LAYOUTS[c.base], label: 'Custom', pos: { ...LAYOUTS[c.base].pos, ...c.pos } };
    }
    return LAYOUTS[name] || LAYOUTS.optimal;
  }

  layout() {
    if (!this.root) return;
    this.refreshVisibility();
    const L = this.L = this.currentLayout();
    const W = this.area.clientWidth || innerWidth, H = this.area.clientHeight || innerHeight;
    this.scale = clamp(Math.min(W, H) / 390, 0.78, 1.5) * (SIZE_MUL[settings.get('touchButtonSize')] || 1);
    this.root.style.setProperty('--tc-op', settings.get('touchOpacity'));
    this.root.classList.toggle('editing', this.editing);
    this.root.classList.toggle('lefty', L.side === 'right');
    for (const [id, el] of Object.entries(this.btns)) {
      const p = L.pos[id];
      el.classList.toggle('absent', !p);
      if (!p) continue;
      const d = BUTTONS[id].base * this.scale;
      el.style.width = el.style.height = `${d.toFixed(0)}px`;
      el.style.left = `${(p[0] * 100).toFixed(2)}%`;
      el.style.top = `${(p[1] * 100).toFixed(2)}%`;
    }
    this.stickR = 58 * this.scale;
    this.stickEl.style.width = this.stickEl.style.height = `${(this.stickR * 2).toFixed(0)}px`;
    this.knob.style.width = this.knob.style.height = `${(this.stickR * 0.9).toFixed(0)}px`;
    if (!this.stick) this.placeStick(L.pos.stick[0] * W, L.pos.stick[1] * H);
    this.labelsKey = '';
  }

  placeStick(x, y) {
    this.stickEl.style.left = `${x}px`; this.stickEl.style.top = `${y}px`;
  }

  // ------------------------------------------------------------------ pointers
  local(e) {
    const r = this.area.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top, W: r.width, H: r.height };
  }

  inStickZone(p) {
    const L = this.L;
    if (!L.floating) {
      const [sx, sy] = L.pos.stick;
      return Math.hypot(p.x - sx * p.W, p.y - sy * p.H) < this.stickR * 1.7;
    }
    const fx = p.x / p.W;
    return (L.side === 'left' ? fx < 0.42 : fx > 0.58) && p.y / p.H > 0.24;
  }

  down(e) {
    e.preventDefault();
    if (this.root.hasPointerCapture?.(e.pointerId) === false) { try { this.root.setPointerCapture(e.pointerId); } catch { /* synthetic */ } }
    const p = this.local(e);
    if (this.editing) return this.editDown(e, p);
    const mini = e.target.closest('.tc-mini');
    if (mini) { this.mini(mini.dataset.act, mini); return; }
    const btn = e.target.closest('.tc-btn');
    if (btn && !btn.classList.contains('absent') && !btn.classList.contains('off')) { this.press(btn.dataset.id, e.pointerId, p); return; }
    if (!this.stick && this.inStickZone(p)) {
      const L = this.L;
      let cx = p.x, cy = p.y;
      if (!L.floating) { cx = L.pos.stick[0] * p.W; cy = L.pos.stick[1] * p.H; }
      else { cx = clamp(cx, this.stickR + 6, p.W - this.stickR - 6); cy = clamp(cy, this.stickR + 6, p.H - this.stickR - 6); }
      this.stick = { id: e.pointerId, cx, cy };
      this.placeStick(cx, cy);
      this.stickEl.classList.add('on');
      this.moveStick(p);
      return;
    }
    if (!this.look) { this.look = { id: e.pointerId }; this.lookFrom.set(e.pointerId, [p.x, p.y]); }
  }

  move(e) {
    const p = this.local(e);
    if (this.editing) return this.editMove(e, p);
    if (this.stick && e.pointerId === this.stick.id) { this.moveStick(p); return; }
    const last = this.lookFrom.get(e.pointerId);
    if (last) {
      const dx = p.x - last[0], dy = p.y - last[1];
      this.lookFrom.set(e.pointerId, [p.x, p.y]);
      this.addLook(dx, dy, p.W);
    }
  }

  up(e) {
    if (this.editing) { this.drag = null; return; }
    const id = e.pointerId;
    if (this.stick && id === this.stick.id) {
      this.stick = null;
      this.input.axis.x = this.input.axis.y = 0;
      this.sprint = false;
      this.stickEl.classList.remove('on', 'sprint');
      this.knob.style.transform = 'translate(-50%, -50%)';
      const L = this.L, r = this.area.getBoundingClientRect();
      this.placeStick(L.pos.stick[0] * r.width, L.pos.stick[1] * r.height);
    }
    if (this.look && id === this.look.id) this.look = null;
    this.lookFrom.delete(id);
    if (this.fireDown.delete(id)) this.btnState('fire', false), this.btnState('fireL', false);
    if (this.altDown === id) { this.altDown = null; this.btnState('alt', this.aimLatched); }
    const held = this.keyHolds.get(id);
    if (held) { this.keyHolds.delete(id); this.btnState(held.id, false); }
  }

  moveStick(p) {
    const s = this.stick;
    let dx = p.x - s.cx, dy = p.y - s.cy;
    const d = Math.hypot(dx, dy), R = this.stickR;
    // sprint: thumb pushed out past the ring while going forward
    this.sprint = settings.get('touchAutoSprint') && d > R * 1.15 && dy < -Math.abs(dx) * 0.9;
    if (this.L.floating && d > R * 1.6) {
      // the stick follows a thumb that drifts far away, so it never runs out of travel
      const k = (d - R * 1.6) / d;
      s.cx += dx * k; s.cy += dy * k; dx = p.x - s.cx; dy = p.y - s.cy;
      this.placeStick(s.cx, s.cy);
    }
    const m = Math.min(1, Math.hypot(dx, dy) / R);
    const a = Math.atan2(dy, dx);
    // small dead zone, then a smooth response
    const mm = m < 0.12 ? 0 : (m - 0.12) / 0.88;
    this.input.axis.x = Math.cos(a) * mm;
    this.input.axis.y = Math.sin(a) * mm;
    this.knob.style.transform = `translate(calc(-50% + ${(Math.cos(a) * m * R).toFixed(1)}px), calc(-50% + ${(Math.sin(a) * m * R).toFixed(1)}px))`;
    this.stickEl.classList.toggle('sprint', !!this.sprint);
  }

  addLook(dx, dy, W) {
    // a full swipe across the screen turns about 200 degrees at sensitivity 1
    const radPerPx = (3.5 / Math.max(W, 320)) * settings.get('touchSens') * (this.o.isAiming?.() ? settings.get('touchAimSens') / 0.7 : 1);
    const k = radPerPx / this.o.mouseSensitivity;
    this.input.mouseDX += dx * k;
    this.input.mouseDY += dy * k * 0.85;
  }

  press(id, pid, p) {
    const b = BUTTONS[id], inp = this.input;
    const spec = toolButtons(this.o.toolbox.active);
    if (b.kind === 'fire') {
      this.fireDown.add(pid);
      inp.mouseDown[0] = true; inp.mousePressed[0] = true;
      if (b.look) this.lookFrom.set(pid, [p.x, p.y]);
      this.btnState(id, true);
    } else if (b.kind === 'alt') {
      const isAim = spec.alt?.[2] === 'aim';
      if (isAim && settings.get('touchAim') === 'toggle') { this.aimLatched = !this.aimLatched; this.btnState('alt', this.aimLatched); }
      else { this.altDown = pid; inp.mouseDown[2] = true; inp.mousePressed[2] = true; this.btnState('alt', true); }
    } else if (b.kind === 'toggle') {
      this.crouchLatched = !this.crouchLatched; this.btnState(id, this.crouchLatched);
    } else {
      inp.pressed.add(b.code); inp.down.add(b.code);
      this.keyHolds.set(pid, { id, code: b.code });
      this.btnState(id, true);
    }
    navigator.vibrate?.(8);
  }

  mini(act, el) {
    const inp = this.input;
    el.classList.add('flash'); setTimeout(() => el.classList.remove('flash'), 150);
    if (act === 'pause') this.o.onPause?.();
    else if (act === 'toolbox') (this.o.onToolbox ? this.o.onToolbox() : this.o.toolbox.toggle());
    else if (act === 'spawn') this.o.onSpawn?.();
    else if (act === 'slow') inp.pressed.add('KeyZ');
    else if (act === 'fast') inp.pressed.add('KeyV');
    else if (act === 'xray') this.o.onXray?.();
  }

  btnState(id, on) { this.btns[id]?.classList.toggle('on', !!on); }

  reset() {
    const inp = this.input;
    this.stick = null; this.look = null; this.lookFrom.clear(); this.fireDown.clear(); this.keyHolds.clear(); this.altDown = null;
    this.aimLatched = false; this.sprint = false;
    inp.axis.x = inp.axis.y = 0;
    this.stickEl?.classList.remove('on', 'sprint');
    if (this.knob) this.knob.style.transform = 'translate(-50%, -50%)';
    for (const id of Object.keys(this.btns || {})) this.btnState(id, id === 'crouch' && this.crouchLatched);
  }

  // ------------------------------------------------------------------ per frame
  /** Write the held state into Input (it can be cleared by blur or the toolbox) and relabel. */
  update(dt, { tool, useVisible, xrayMode }) {
    if (!this.active) return;
    this.refreshVisibility();
    const inp = this.input;
    if (this.editing) return;
    if (tool.name !== this.toolName) { this.toolName = tool.name; this.aimLatched = false; this.btnState('alt', false); }
    const spec = toolButtons(tool);
    inp.mouseDown[0] = this.fireDown.size > 0;
    inp.mouseDown[2] = this.aimLatched || this.altDown !== null;
    for (const code of ['KeyR', 'KeyF', 'Space', 'KeyE', 'KeyC', 'ShiftLeft']) inp.down.delete(code);
    for (const h of this.keyHolds.values()) inp.down.add(h.code);
    if (this.crouchLatched) inp.down.add('KeyC');
    if (this.sprint) inp.down.add('ShiftLeft');
    if (this.sprint && this.crouchLatched) { this.crouchLatched = false; this.btnState('crouch', false); }

    // labels and which buttons show for this item
    const key = `${tool.name}|${JSON.stringify(spec)}|${useVisible}|${xrayMode}`;
    if (key !== this.labelsKey) {
      this.labelsKey = key;
      for (const id of ['fire', 'fireL', 'alt', 'reload', 'inspect']) {
        const s = spec[id === 'fireL' ? 'fire' : id];
        const el = this.btns[id];
        el.classList.toggle('off', !s);
        if (!s) continue;
        el.querySelector('i').innerHTML = ICONS[s[1]] || '';
        el.querySelector('b').textContent = s[0];
      }
      this.setBtn('jump', 'Jump', 'jump'); this.setBtn('crouch', 'Crouch', 'crouch'); this.setBtn('use', 'Press', 'use');
      this.btns.use.classList.toggle('off', !useVisible);
      const xr = this.root.querySelector('[data-act="xray"]');
      xr.classList.toggle('on', xrayMode !== 'off');
      xr.querySelector('em').textContent = xrayMode === 'off' ? 'X-ray' : xrayMode === 'flat' ? 'Flat' : '3D';
    }
  }

  setBtn(id, label, icon) { const el = this.btns[id]; el.querySelector('i').innerHTML = ICONS[icon]; el.querySelector('b').textContent = label; }

  // ------------------------------------------------------------------ layout editor
  startEdit() {
    const cur = this.currentLayout();
    const name = settings.get('touchLayout');
    this.editBase = name === 'custom' ? (settings.get('touchCustom')?.base || 'optimal') : (LAYOUTS[name] ? name : 'optimal');
    this.editPos = structuredClone(cur.pos);
    this.editing = true;
    this.reset();
    this.editBar.classList.remove('hidden');
    for (const id of Object.keys(this.btns)) {
      this.btns[id].classList.remove('off');
      const lbl = { fire: 'Fire', fireL: 'Fire', alt: 'Aim', reload: 'Reload', inspect: 'Inspect', jump: 'Jump', crouch: 'Crouch', use: 'Press' }[id];
      const ic = { fire: 'fire', fireL: 'fire', alt: 'aim', reload: 'reload', inspect: 'inspect', jump: 'jump', crouch: 'crouch', use: 'use' }[id];
      this.setBtn(id, lbl, ic);
    }
    this.labelsKey = '';
    this.layout();
  }

  editDown(e, p) {
    const btn = e.target.closest('.tc-btn');
    if (btn && !btn.classList.contains('absent')) { this.drag = { id: btn.dataset.id, ox: p.x - this.editPos[btn.dataset.id][0] * p.W, oy: p.y - this.editPos[btn.dataset.id][1] * p.H }; return; }
    if (e.target.closest('.tc-stick')) {
      const [sx, sy] = this.editPos.stick;
      this.drag = { id: 'stick', ox: p.x - sx * p.W, oy: p.y - sy * p.H };
    }
  }

  editMove(e, p) {
    if (!this.drag) return;
    const x = clamp((p.x - this.drag.ox) / p.W, 0.03, 0.97), y = clamp((p.y - this.drag.oy) / p.H, 0.12, 0.95);
    this.editPos[this.drag.id] = [Number(x.toFixed(4)), Number(y.toFixed(4))];
    this.layout();
  }

  finishEdit() {
    const base = LAYOUTS[this.editBase].pos;
    const changed = Object.keys(this.editPos).some((k) => !base[k] || base[k][0] !== this.editPos[k][0] || base[k][1] !== this.editPos[k][1]);
    this.editing = false;
    this.editBar.classList.add('hidden');
    if (changed) { settings.set('touchCustom', { base: this.editBase, pos: this.editPos }); settings.set('touchLayout', 'custom'); }
    else if (settings.get('touchLayout') === 'custom') settings.set('touchLayout', this.editBase);
    this.labelsKey = '';
    this.layout();
    this.o.onEditDone?.();
  }
}
