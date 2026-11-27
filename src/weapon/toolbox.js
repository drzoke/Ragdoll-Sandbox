import { settings } from '../settings.js';
import { ItemPreview } from '../ui/preview.js';

const $ = (id) => document.getElementById(id);

// Pictures of the items (used on the hotbar, and in the toolbox on the Low preset).
const ICONS = {
  Fists: `<svg viewBox="0 0 64 40"><rect x="10" y="12" width="18" height="18" rx="2" fill="currentColor"/><rect x="2" y="16" width="10" height="10" fill="currentColor" opacity=".75"/><rect x="36" y="10" width="18" height="18" rx="2" fill="currentColor"/><rect x="52" y="14" width="10" height="10" fill="currentColor" opacity=".75"/><path d="M14 17h10M14 21h10M40 15h10M40 19h10" stroke="#000" stroke-opacity=".35" stroke-width="1.5"/></svg>`,
  'Remington 870': `<svg viewBox="0 0 64 40"><path d="M2 15h30v-2h4v2h26v3H36v2h12v3H34l-2 2H22l-3 3-12 6-4-4 9-6v-3H2z" fill="currentColor"/><rect x="38" y="19" width="12" height="5" rx="1" fill="currentColor" opacity=".7"/></svg>`,
  Grenade: `<svg viewBox="0 0 64 40"><circle cx="30" cy="24" r="13" fill="currentColor"/><rect x="25" y="6" width="10" height="7" fill="currentColor"/><path d="M35 8h6l3 6-2 12" stroke="currentColor" stroke-width="3" fill="none"/><circle cx="20" cy="10" r="5" stroke="currentColor" stroke-width="2" fill="none"/></svg>`,
  M1911: `<svg viewBox="0 0 64 40"><path d="M4 9h50l3 3v6H31l-2 3h-6l-3 15H8l5-18H4z" fill="currentColor"/></svg>`,
  Machete: `<svg viewBox="0 0 64 40"><path d="M2 27l7-5 4 4-6 6z" fill="currentColor"/><path d="M12 21L50 6c6-2 10 0 11 3-1 3-5 5-11 7L15 26z" fill="currentColor"/><path d="M15 26l35-10c4-1 8-3 10-6" stroke="#fff" stroke-opacity=".45" stroke-width="1.3" fill="none"/><rect x="9" y="19" width="4" height="10" rx="1" transform="rotate(-38 11 24)" fill="currentColor" opacity=".7"/></svg>`,
  Medkit: `<svg viewBox="0 0 64 40"><rect x="12" y="9" width="40" height="27" rx="5" fill="currentColor"/><path d="M25 9V5h14v4" stroke="currentColor" stroke-width="3" fill="none"/><path d="M32 15v15M24.5 22.5h15" stroke="#000" stroke-opacity=".5" stroke-width="4.5" stroke-linecap="round"/></svg>`,
  Defibrillator: `<svg viewBox="0 0 64 40"><rect x="4" y="10" width="18" height="16" rx="3" fill="currentColor"/><rect x="42" y="10" width="18" height="16" rx="3" fill="currentColor"/><rect x="10" y="26" width="6" height="10" rx="2" fill="currentColor" opacity=".7"/><rect x="48" y="26" width="6" height="10" rx="2" fill="currentColor" opacity=".7"/><path d="M34 6l-7 12h5l-2 10 8-13h-5z" fill="currentColor"/></svg>`,
  Grab: `<svg viewBox="0 0 64 40"><path d="M8 13h30v12H20l-3 11h-8l3-11H8z" fill="currentColor"/><rect x="38" y="15" width="8" height="8" fill="currentColor"/><path d="M46 12l10-4v4l-7 3zM46 26l10 4v-4l-7-3z" fill="currentColor"/><circle cx="52" cy="19" r="3" fill="#fff"/></svg>`,
};
const INFO = {
  Fists: { category: 'weapons', type: 'Melee', text: 'Your bare fists. Left click throws quick jabs, right click a hard hook. Punches leave bruises and can knock the ragdoll down or out.' },
  'Remington 870': { category: 'weapons', type: 'Shotgun', text: 'Pump-action 12 gauge: 8 pellets per shot, 6 shells in the tube plus one in the chamber. It pumps itself after each shot. R loads one shell at a time; fire to stop loading.' },
  Grenade: { category: 'weapons', type: 'Explosive', text: 'Green ball grenade. Left click pulls the pin and throws it, right click lobs it underhand. It goes off 3 seconds after it leaves your hand and leaves black scorch marks. Shoot one to set it off early.' },
  M1911: { category: 'weapons', type: 'Pistol', text: 'Semi-automatic .45 pistol with 7 rounds plus one in the chamber. Left click fires, right click aims, R reloads.' },
  Machete: { category: 'weapons', type: 'Melee', text: 'A 40 cm blade. Left click slashes (forehand, then backhand): long cuts that bleed hard and get deeper on the same spot, until they chop through a limb or the neck. Wrist, ankle and hamstring cuts sever tendons. Right click stabs deep into the organs.' },
  Medkit: { category: 'medical', type: 'Medical', text: 'Look at a body part and hold left click to treat it: bandages on its wounds, a tourniquet above a stump, a splint on a broken bone, a dressing on a bad burn. Right click gives morphine (twice slows the breathing), R hangs a 750 ml blood bag.' },
  Defibrillator: { category: 'medical', type: 'Medical', text: 'Hold left click to charge, let go with the paddles on the chest. It can restart a heart that has stopped if the heart and enough blood are left: give a blood bag first after heavy bleeding. Shocking a heart that is still beating can stop it.' },
  Grab: { category: 'tools', type: 'Tool', text: 'Picks up ragdolls and loose body parts from a distance. Right click grabs or drops, left click throws. Swing them into things to break bones.' },
};
const CATEGORIES = [['all', 'All'], ['weapons', 'Weapons'], ['medical', 'Medical'], ['tools', 'Tools']];

export const BAR_SIZE = 9;

/**
 * Inventory of tools ("toolbox"). You start with only your fists on the hotbar; Tab opens the
 * full toolbox (a square window with a scrolling item grid and categories on the right), where
 * you pick an item and press Equip to put it on the bar (up to 9 items) and take it out, or
 * Remove it from the bar again. Number keys 1–9, Q or the mouse wheel switch between the items
 * on the bar. Also handles the holster → draw animation and the controls panel.
 */
export class Toolbox {
  constructor(tools, { audio, onOpenChange, start = 0 }) {
    this.tools = tools;
    this.audio = audio;
    this.index = start;
    this.bar = [start];          // tool indices on the hotbar, in slot order (at most BAR_SIZE)
    this.picked = start;         // item shown in the toolbox's info panel (with Equip / Remove)
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
    this.el.grid.innerHTML = tools.map((t, i) => `<button class="tool-card" data-i="${i}" data-cat="${INFO[t.name]?.category || 'tools'}">
        <span class="key"></span>
        <div class="pv"><canvas width="240" height="180"></canvas><div class="icon">${ICONS[t.name] || ''}</div></div>
        <b>${t.name}</b><small>${INFO[t.name]?.type || ''}</small></button>`).join('');
    this.cards = [...this.el.grid.querySelectorAll('.tool-card')].map((el) => ({ el, i: Number(el.dataset.i), ctx: el.querySelector('canvas').getContext('2d') }));
    this.el.cats.innerHTML = CATEGORIES.map(([id, label]) => `<button data-cat="${id}">${label}<span>${id === 'all' ? tools.length : tools.filter((t) => INFO[t.name]?.category === id).length}</span></button>`).join('');

    this.el.grid.addEventListener('click', (e) => {
      const card = e.target.closest('.tool-card');
      if (!card) return;
      const i = Number(card.dataset.i);
      // first click picks the item (its info and the Equip button show below); clicking the picked
      // item again (or double clicking) equips it
      if (this.picked === i && e.detail !== 1) return;
      if (this.picked === i) { this.equip(i); return; }
      this.pick(i);
    });
    this.el.grid.addEventListener('dblclick', (e) => { const c = e.target.closest('.tool-card'); if (c) this.equip(Number(c.dataset.i)); });
    this.el.grid.addEventListener('mouseover', (e) => { const c = e.target.closest('.tool-card'); if (c) this.hover = Number(c.dataset.i); });
    this.el.grid.addEventListener('mouseleave', () => { this.hover = -1; });
    this.el.info.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-act]');
      if (!b) return;
      if (b.dataset.act === 'equip') this.equip(this.picked);
      else if (b.dataset.act === 'remove') this.unequip(this.picked);
    });
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
    const flat = level === 'low' || level === 'verylow';
    this.el.box.classList.toggle('icons', flat);
    if (!flat && this.isOpen && !this.preview) this.preview = new ItemPreview();
    this.preview?.setQuality(level);
  }

  pick(i) {
    if (i < 0 || i >= this.tools.length) return;
    this.picked = i;
    this.audio.play('click');
    this.renderHotbar();
  }

  /** Put an item on the bar (if it isn't there yet) and switch to it. A full bar swaps out the
   *  item in your hands. */
  equip(i) {
    if (i < 0 || i >= this.tools.length) return;
    if (!this.bar.includes(i)) {
      if (this.bar.length < BAR_SIZE) this.bar.push(i);
      else this.bar[Math.max(0, this.bar.indexOf(this.index))] = i;
    }
    this.picked = i;
    this.select(i, true);
    this.close();
  }

  /** Take an item off the bar (the last item always stays). */
  unequip(i) {
    const at = this.bar.indexOf(i);
    if (at < 0 || this.bar.length <= 1) return;
    this.bar.splice(at, 1);
    this.audio.play('click');
    if (this.index === i || this.pending === i) this.select(this.bar[Math.min(at, this.bar.length - 1)], true);
    else this.renderHotbar();
  }

  /** Switch to the item in bar slot n (0-based). */
  slot(n) { if (n < this.bar.length) this.select(this.bar[n]); }

  /** Next / previous item on the bar. */
  cycle(step) {
    const at = Math.max(0, this.bar.indexOf(this.pending >= 0 ? this.pending : this.index));
    this.select(this.bar[(at + step + this.bar.length) % this.bar.length]);
  }

  select(i, force = false) {
    if (i < 0 || i >= this.tools.length) return;
    if (!force && !this.bar.includes(i)) return;
    if (i === this.index && this.pending < 0) return;
    this.pending = i;
    this.audio.play('equip');
    this.renderHotbar();
  }

  open() {
    if (this.isOpen) return;
    this.isOpen = true;
    this.picked = this.pending >= 0 ? this.pending : this.index;
    if (this.quality !== 'low' && this.quality !== 'verylow' && !this.preview) { this.preview = new ItemPreview(); this.preview.setQuality(this.quality); }
    this.el.box.classList.remove('hidden');
    this.renderInfo();
    this.onOpenChange?.(true);
  }
  close() { if (!this.isOpen) return; this.isOpen = false; this.el.box.classList.add('hidden'); this.onOpenChange?.(false); }
  toggle() { if (this.isOpen) this.close(); else this.open(); }

  applyControlsVisibility() { this.el.controls.classList.toggle('hidden', !settings.get('showControls')); }

  renderHotbar() {
    const sel = this.pending >= 0 ? this.pending : this.index;
    const key = this.bar.join(',');
    if (key !== this.barKey) {
      this.barKey = key;
      this.el.hotbar.innerHTML = this.bar.map((i, n) => { const t = this.tools[i]; return `<div class="slot" data-i="${i}"><span class="key">${n + 1}</span>${ICONS[t.name] || ''}<span class="nm">${t.short || t.name}</span></div>`; }).join('');
      for (const c of this.cards) { const n = this.bar.indexOf(c.i); c.el.querySelector('.key').textContent = n >= 0 ? n + 1 : ''; c.el.classList.toggle('onbar', n >= 0); }
    }
    this.el.hotbar.querySelectorAll('.slot').forEach((s) => s.classList.toggle('active', Number(s.dataset.i) === sel));
    for (const c of this.cards) { c.el.classList.toggle('active', c.i === sel); c.el.classList.toggle('picked', c.i === this.picked); }
    this.renderInfo();
  }

  renderInfo() {
    const i = this.picked, t = this.tools[i], info = INFO[t.name] || {};
    const inHand = i === (this.pending >= 0 ? this.pending : this.index);
    const slot = this.bar.indexOf(i);
    const full = slot < 0 && this.bar.length >= BAR_SIZE;
    const tags = (inHand ? '<span class="tag on">In your hands</span>' : '') + (slot >= 0 ? `<span class="tag">Slot ${slot + 1}</span>` : '');
    const equipLabel = slot >= 0 ? (inHand ? 'Equipped' : 'Hold it') : 'Equip';
    const btns = `<div class="tb-acts">${slot >= 0 && this.bar.length > 1 ? '<button data-act="remove" class="ghost">Remove from bar</button>' : ''}<button data-act="equip" ${inHand ? 'disabled' : ''}>${equipLabel}</button></div>`;
    const note = full ? `<p class="full">Your bar is full (${BAR_SIZE} items): equipping swaps out the item in your hands.</p>` : '';
    this.el.info.innerHTML = `${btns}<b>${t.name}</b><span class="tag">${info.type || ''}</span>${tags}<p>${info.text || ''}</p>${note}`;
  }

  update(dt, input, playing, worldDt) {
    this.time += dt;
    if (playing && !this.isOpen) {
      for (let n = 0; n < BAR_SIZE; n++) if (input.wasPressed(`Digit${n + 1}`)) this.slot(n);
      if (input.wasPressed('KeyQ')) this.cycle(1);
      // the wheel switches tools unless the grab tool is using it to move what it holds
      if (input.wheel && !this.active.held) this.cycle(input.wheel > 0 ? 1 : -1);
      if (input.wasPressed('KeyH')) settings.set('showControls', !settings.get('showControls'));
    }
    if (this.isOpen) {
      if (input.wasPressed('Enter')) this.equip(this.picked);
      if (this.preview && this.quality !== 'low' && this.quality !== 'verylow') {
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
    const rows = [...t.controls.filter(([k]) => k), [this.bar.length > 1 ? `1–${this.bar.length} or Q` : '1–9 or Q', 'Switch item'], ['Tab', 'Toolbox (equip items)'], ['B', 'Spawn menu'], ['Z', 'Slow down time'], ['V', 'Speed up time'], ['X', 'X-ray (again: 3D / Flat, again: close)'], ['H', 'Hide this list']];
    const key = t.name + JSON.stringify(rows);
    if (key === this.controlsKey) return;
    this.controlsKey = key;
    this.el.ctlTitle.textContent = t.name;
    this.el.ctlList.innerHTML = rows.map(([k, v]) => `<li><kbd>${k}</kbd><span>${v}</span></li>`).join('');
  }
}
