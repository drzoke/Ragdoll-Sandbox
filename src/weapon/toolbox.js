import { damp } from '../core/util.js';
import { settings } from '../settings.js';

const $ = (id) => document.getElementById(id);

// Small inline SVG silhouettes for the hotbar / toolbox cards.
const ICONS = {
  M1911: `<svg viewBox="0 0 64 40"><path d="M4 9h50l3 3v6H31l-2 3h-6l-3 15H8l5-18H4z" fill="currentColor"/><rect x="20" y="17" width="9" height="2" fill="#0000"/></svg>`,
  Grab: `<svg viewBox="0 0 64 40"><path d="M8 13h30v12H20l-3 11h-8l3-11H8z" fill="currentColor"/><rect x="38" y="15" width="8" height="8" fill="currentColor"/><path d="M46 12l10-4v4l-7 3zM46 26l10 4v-4l-7-3z" fill="currentColor"/><circle cx="52" cy="19" r="3" fill="#fff"/></svg>`,
};
const BLURB = {
  M1911: 'Semi-auto .45 pistol. 7+1 rounds, real bullet travel.',
  Grab: 'Gravity-field manipulator. Grab, swing, slam and throw ragdolls.',
};

/**
 * Inventory of tools ("toolbox"): hotbar at the bottom, Tab opens the full toolbox, number keys
 * or the mouse wheel switch. Handles the holster → draw animation between tools and the
 * per-tool controls panel on the left.
 */
export class Toolbox {
  constructor(tools, { audio, onOpenChange }) {
    this.tools = tools;
    this.audio = audio;
    this.index = 0;
    this.pending = -1;       // tool we're switching to
    this.isOpen = false;
    this.onOpenChange = onOpenChange;
    for (const t of tools) t.raise = 0;
    tools[0].raise = 0;

    this.el = { hotbar: $('hotbar'), box: $('toolbox'), grid: $('toolbox-grid'), controls: $('controls'), ctlList: $('controls-list'), ctlTitle: $('controls-title') };
    this.el.hotbar.innerHTML = tools.map((t, i) => `<div class="slot" data-i="${i}"><span class="key">${i + 1}</span>${ICONS[t.name] || ''}<span class="nm">${t.name}</span></div>`).join('');
    this.el.grid.innerHTML = tools.map((t, i) => `<button class="tool-card" data-i="${i}"><span class="key">${i + 1}</span>${ICONS[t.name] || ''}<b>${t.name}</b><small>${BLURB[t.name] || ''}</small></button>`).join('')
      + `<div class="tool-card empty"><b>Empty slot</b><small>More tools coming</small></div>`.repeat(2);
    this.el.grid.addEventListener('click', (e) => {
      const card = e.target.closest('.tool-card[data-i]');
      if (!card) return;
      this.select(Number(card.dataset.i));
      this.close();
    });
    this.controlsKey = '';
    this.applyControlsVisibility();
    settings.onChange((k) => { if (k === 'showControls') this.applyControlsVisibility(); });
    this.renderHotbar();
  }

  get active() { return this.tools[this.index]; }

  select(i) {
    if (i < 0 || i >= this.tools.length) return;
    if (i === this.index && this.pending < 0) return;
    this.pending = i;
    this.audio.play('equip');
    this.renderHotbar();
  }

  open() { if (this.isOpen) return; this.isOpen = true; this.el.box.classList.remove('hidden'); this.onOpenChange?.(true); }
  close() { if (!this.isOpen) return; this.isOpen = false; this.el.box.classList.add('hidden'); this.onOpenChange?.(false); }
  toggle() { if (this.isOpen) this.close(); else this.open(); }

  applyControlsVisibility() { this.el.controls.classList.toggle('hidden', !settings.get('showControls')); }

  renderHotbar() {
    const sel = this.pending >= 0 ? this.pending : this.index;
    this.el.hotbar.querySelectorAll('.slot').forEach((s, i) => s.classList.toggle('active', i === sel));
    this.el.grid.querySelectorAll('.tool-card[data-i]').forEach((s, i) => s.classList.toggle('active', i === sel));
  }

  update(dt, input, playing, worldDt) {
    if (playing && !this.isOpen) {
      for (let i = 0; i < this.tools.length; i++) if (input.wasPressed(`Digit${i + 1}`)) this.select(i);
      if (input.wasPressed('KeyQ')) this.select((this.index + 1) % this.tools.length);
      // wheel switches tools unless the grab tool is using it for distance
      if (input.wheel && !this.active.held) this.select((this.index + (input.wheel > 0 ? 1 : this.tools.length - 1)) % this.tools.length);
      if (input.wasPressed('KeyH')) settings.set('showControls', !settings.get('showControls'));
    }
    // holster → draw
    const cur = this.active;
    if (this.pending >= 0 && this.pending !== this.index) {
      cur.raise = Math.max(0, cur.raise - dt / 0.16);
      if (cur.raise <= 0) { this.index = this.pending; this.pending = -1; this.renderHotbar(); }
    } else {
      this.pending = -1;
      cur.raise = Math.min(1, cur.raise + dt / 0.24);
    }
    for (const t of this.tools) if (t !== this.active) t.raise = 0;
    const usable = playing && !this.isOpen;
    for (const t of this.tools) t.update(dt, input, usable && t === this.active, worldDt);
    this.renderControls();
  }

  renderControls() {
    const t = this.active;
    const rows = [...t.controls, ['1 / 2 · Q · wheel', 'Switch tool'], ['Tab', 'Toolbox'], ['Z / V', 'Slow down / speed up time'], ['H', 'Hide this panel']];
    const key = t.name + JSON.stringify(rows);
    if (key === this.controlsKey) return;
    this.controlsKey = key;
    this.el.ctlTitle.textContent = t.name;
    this.el.ctlList.innerHTML = rows.map(([k, v]) => `<li><kbd>${k}</kbd><span>${v}</span></li>`).join('');
  }
}
