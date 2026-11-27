import { settings } from '../settings.js';
import { ItemPreview } from '../ui/preview.js';

const $ = (id) => document.getElementById(id);

// Pictures of the items (used on the hotbar, and in the toolbox on the Low preset).
const ICONS = {
  Fists: `<svg viewBox="0 0 64 40"><rect x="10" y="12" width="18" height="18" rx="2" fill="currentColor"/><rect x="2" y="16" width="10" height="10" fill="currentColor" opacity=".75"/><rect x="36" y="10" width="18" height="18" rx="2" fill="currentColor"/><rect x="52" y="14" width="10" height="10" fill="currentColor" opacity=".75"/><path d="M14 17h10M14 21h10M40 15h10M40 19h10" stroke="#000" stroke-opacity=".35" stroke-width="1.5"/></svg>`,
  'Remington 870': `<svg viewBox="0 0 64 40"><path d="M2 15h30v-2h4v2h26v3H36v2h12v3H34l-2 2H22l-3 3-12 6-4-4 9-6v-3H2z" fill="currentColor"/><rect x="38" y="19" width="12" height="5" rx="1" fill="currentColor" opacity=".7"/></svg>`,
  Grenade: `<svg viewBox="0 0 64 40"><circle cx="30" cy="24" r="13" fill="currentColor"/><rect x="25" y="6" width="10" height="7" fill="currentColor"/><path d="M35 8h6l3 6-2 12" stroke="currentColor" stroke-width="3" fill="none"/><circle cx="20" cy="10" r="5" stroke="currentColor" stroke-width="2" fill="none"/></svg>`,
  M1911: `<svg viewBox="0 0 64 40"><path d="M4 9h50l3 3v6H31l-2 3h-6l-3 15H8l5-18H4z" fill="currentColor"/></svg>`,
  Grab: `<svg viewBox="0 0 64 40"><path d="M8 13h30v12H20l-3 11h-8l3-11H8z" fill="currentColor"/><rect x="38" y="15" width="8" height="8" fill="currentColor"/><path d="M46 12l10-4v4l-7 3zM46 26l10 4v-4l-7-3z" fill="currentColor"/><circle cx="52" cy="19" r="3" fill="#fff"/></svg>`,
};
const INFO = {
  Fists: { category: 'weapons', type: 'Melee', text: 'Your bare fists. Left click throws quick jabs, right click a hard hook. Punches leave bruises and can knock the ragdoll down or out.' },
  'Remington 870': { category: 'weapons', type: 'Shotgun', text: 'Pump-action 12 gauge: 8 pellets per shot, 6 shells in the tube plus one in the chamber. It pumps itself after each shot. R loads one shell at a time; fire to stop loading.' },
  Grenade: { category: 'weapons', type: 'Explosive', text: 'Green ball grenade. Left click pulls the pin and throws it, right click lobs it underhand. It goes off 3 seconds after it leaves your hand and leaves black scorch marks. Shoot one to set it off early.' },
  M1911: { category: 'weapons', type: 'Pistol', text: 'Semi-automatic .45 pistol with 7 rounds plus one in the chamber. Left click fires, right click aims, R reloads.' },
  Grab: { category: 'tools', type: 'Tool', text: 'Picks up ragdolls and loose body parts from a distance. Right click grabs or drops, left click throws. Swing them into things to break bones.' },
};
const CATEGORIES = [['all', 'All'], ['weapons', 'Weapons'], ['tools', 'Tools']];

/**
 * Inventory of tools ("toolbox"): hotbar at the bottom, Tab opens the full toolbox (a square
 * window with a scrolling item grid and categories on the right). Number keys, Q or the mouse
 * wheel switch tools. Also handles the holster → draw animation and the controls panel.
 */
export class Toolbox {
  constructor(tools, { audio, onOpenChange, start = 0 }) {
    this.tools = tools;
    this.audio = audio;
    this.index = start;
    this.pending = -1;
    this.isOpen = false;
    this.onOpenChange = onOpenChange;
    this.category = 'all';
    this.hover = -1;
    this.time = 0;
    this.quality = settings.get('graphics');
    this.preview = null; // created the first time it's needed (Medium and up)
    for (const t of tools) { t.raise = 0; t.drawing = true; }

    this.el = { hotbar: $('hotbar'), box: $('toolbox'), grid: $('toolbox-grid'), cats: $('toolbox-cats'), info: $('tb-info'),
      controls: $('controls'), ctlList: $('controls-list'), ctlTitle: $('controls-title') };
    this.el.hotbar.innerHTML = tools.map((t, i) => `<div class="slot" data-i="${i}"><span class="key">${i + 1}</span>${ICONS[t.name] || ''}<span class="nm">${t.short || t.name}</span></div>`).join('');
    this.el.grid.innerHTML = tools.map((t, i) => `<button class="tool-card" data-i="${i}" data-cat="${INFO[t.name]?.category || 'tools'}">
        <span class="key">${i + 1}</span>
        <div class="pv"><canvas width="240" height="180"></canvas><div class="icon">${ICONS[t.name] || ''}</div></div>
        <b>${t.name}</b><small>${INFO[t.name]?.type || ''}</small></button>`).join('');
    this.cards = [...this.el.grid.querySelectorAll('.tool-card')].map((el) => ({ el, i: Number(el.dataset.i), ctx: el.querySelector('canvas').getContext('2d') }));
    this.el.cats.innerHTML = CATEGORIES.map(([id, label]) => `<button data-cat="${id}">${label}<span>${id === 'all' ? tools.length : tools.filter((t) => INFO[t.name]?.category === id).length}</span></button>`).join('');

    this.el.grid.addEventListener('click', (e) => {
      const card = e.target.closest('.tool-card');
      if (!card) return;
      this.select(Number(card.dataset.i));
      this.close();
    });
    this.el.grid.addEventListener('mouseover', (e) => { const c = e.target.closest('.tool-card'); if (c) { this.hover = Number(c.dataset.i); this.renderInfo(); } });
    this.el.grid.addEventListener('mouseleave', () => { this.hover = -1; this.renderInfo(); });
    this.el.cats.addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) this.setCategory(b.dataset.cat); });

    this.controlsKey = '';
    this.applyControlsVisibility();
    settings.onChange((k) => { if (k === 'showControls') this.applyControlsVisibility(); });
    this.setCategory('all');
    this.setQuality(this.quality);
    this.renderHotbar();
  }

  get active() { return this.tools[this.index]; }

  setCategory(cat) {
    this.category = cat;
    for (const b of this.el.cats.querySelectorAll('button')) b.classList.toggle('on', b.dataset.cat === cat);
    for (const c of this.cards) c.el.classList.toggle('hidden', cat !== 'all' && c.el.dataset.cat !== cat);
  }

  /** Low: pictures. Medium: spinning models. High / Very High: spinning models with effects. */
  setQuality(level) {
    this.quality = level;
    this.el.box.classList.toggle('icons', level === 'low');
    if (level !== 'low' && this.isOpen && !this.preview) this.preview = new ItemPreview();
    this.preview?.setQuality(level);
  }

  select(i) {
    if (i < 0 || i >= this.tools.length) return;
    if (i === this.index && this.pending < 0) return;
    this.pending = i;
    this.audio.play('equip');
    this.renderHotbar();
  }

  open() {
    if (this.isOpen) return;
    this.isOpen = true;
    if (this.quality !== 'low' && !this.preview) { this.preview = new ItemPreview(); this.preview.setQuality(this.quality); }
    this.el.box.classList.remove('hidden');
    this.renderInfo();
    this.onOpenChange?.(true);
  }
  close() { if (!this.isOpen) return; this.isOpen = false; this.el.box.classList.add('hidden'); this.onOpenChange?.(false); }
  toggle() { if (this.isOpen) this.close(); else this.open(); }

  applyControlsVisibility() { this.el.controls.classList.toggle('hidden', !settings.get('showControls')); }

  renderHotbar() {
    const sel = this.pending >= 0 ? this.pending : this.index;
    this.el.hotbar.querySelectorAll('.slot').forEach((s, i) => s.classList.toggle('active', i === sel));
    for (const c of this.cards) c.el.classList.toggle('active', c.i === sel);
    this.renderInfo();
  }

  renderInfo() {
    const i = this.hover >= 0 ? this.hover : (this.pending >= 0 ? this.pending : this.index);
    const t = this.tools[i], info = INFO[t.name] || {};
    const equipped = i === this.index && this.pending < 0;
    this.el.info.innerHTML = `<b>${t.name}</b><span class="tag">${info.type || ''}</span>${equipped ? '<span class="tag on">Equipped</span>' : ''}<p>${info.text || ''}</p>`;
  }

  update(dt, input, playing, worldDt) {
    this.time += dt;
    if (playing && !this.isOpen) {
      for (let i = 0; i < this.tools.length; i++) if (input.wasPressed(`Digit${i + 1}`)) this.select(i);
      if (input.wasPressed('KeyQ')) this.select((this.index + 1) % this.tools.length);
      // the wheel switches tools unless the grab tool is using it to move what it holds
      if (input.wheel && !this.active.held) this.select((this.index + (input.wheel > 0 ? 1 : this.tools.length - 1)) % this.tools.length);
      if (input.wasPressed('KeyH')) settings.set('showControls', !settings.get('showControls'));
    }
    if (this.isOpen) {
      for (let i = 0; i < this.tools.length; i++) if (input.wasPressed(`Digit${i + 1}`)) { this.select(i); this.close(); }
      if (this.preview && this.quality !== 'low') {
        for (const c of this.cards) if (!c.el.classList.contains('hidden')) this.preview.draw(this.tools[c.i].name, c.ctx, this.time + c.i * 1.3, c.i === this.hover);
      }
    }
    // holster → draw
    const cur = this.active;
    if (this.pending >= 0 && this.pending !== this.index) {
      // holster: drops straight down out of view
      cur.drawing = false;
      cur.raise = Math.max(0, cur.raise - dt / 0.16);
      if (cur.raise <= 0) { this.index = this.pending; this.pending = -1; this.renderHotbar(); }
    } else {
      this.pending = -1;
      // draw: grab, pull up, a little too far, settle (about half a second)
      if (cur.raise < 1) cur.drawing = true;
      cur.raise = Math.min(1, cur.raise + dt / 0.55);
    }
    for (const t of this.tools) if (t !== this.active) { t.raise = 0; t.drawing = true; }
    const usable = playing && !this.isOpen;
    for (const t of this.tools) t.update(dt, input, usable && t === this.active, worldDt);
    this.renderControls();
  }

  renderControls() {
    const t = this.active;
    const rows = [...t.controls.filter(([k]) => k), [`1–${this.tools.length} or Q`, 'Switch item'], ['Tab', 'Open toolbox'], ['Z', 'Slow down time'], ['V', 'Speed up time'], ['X', 'X-ray (again: 3D / Flat, again: close)'], ['H', 'Hide this list']];
    const key = t.name + JSON.stringify(rows);
    if (key === this.controlsKey) return;
    this.controlsKey = key;
    this.el.ctlTitle.textContent = t.name;
    this.el.ctlList.innerHTML = rows.map(([k, v]) => `<li><kbd>${k}</kbd><span>${v}</span></li>`).join('');
  }
}
