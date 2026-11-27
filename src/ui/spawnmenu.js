import * as THREE from 'three';
import { settings } from '../settings.js';
import { WORLD } from '../world/world.js';

const $ = (id) => document.getElementById(id);
export const MAX_RAGDOLLS = 12;

const TEMPER = { brave: 0.35, normal: 1, timid: 1.7 };

// The head on each card: the ragdoll is a plain gray ball, the zombie a rotting green one.
const HEADS = {
  ragdoll: `<svg viewBox="0 0 100 100"><defs><radialGradient id="hg-r" cx=".38" cy=".34" r=".75"><stop offset="0" stop-color="#b4b8bc"/><stop offset=".6" stop-color="#83878c"/><stop offset="1" stop-color="#5d6064"/></radialGradient></defs>
    <circle cx="50" cy="50" r="34" fill="url(#hg-r)"/></svg>`,
  zombie: `<svg viewBox="0 0 100 100"><defs><radialGradient id="hg-z" cx=".38" cy=".34" r=".75"><stop offset="0" stop-color="#a3b98c"/><stop offset=".6" stop-color="#748a5f"/><stop offset="1" stop-color="#4b5c3d"/></radialGradient>
    <clipPath id="hc-z"><circle cx="50" cy="50" r="34"/></clipPath></defs>
    <circle cx="50" cy="50" r="34" fill="url(#hg-z)"/>
    <g clip-path="url(#hc-z)">
      <ellipse cx="34" cy="66" rx="9" ry="6" fill="#4e5f3f" opacity=".55"/><ellipse cx="66" cy="30" rx="7" ry="5" fill="#4e5f3f" opacity=".5"/>
      <path d="M28 70l7-9 6 3 4-6 5 3-2 9-8 2-6 6z" fill="#7d1410" opacity=".85"/><path d="M33 74v14M42 70v10" stroke="#7d1410" stroke-width="3" stroke-linecap="round"/>
      <circle cx="70" cy="58" r="5" fill="#8e1a12" opacity=".9"/><circle cx="76" cy="64" r="2.2" fill="#8e1a12"/><circle cx="64" cy="66" r="1.6" fill="#8e1a12"/>
      <path d="M58 22c4 2 8 1 10-2" stroke="#3a2a22" stroke-width="1.6" fill="none" opacity=".6"/>
    </g>
    <circle cx="40" cy="46" r="4.2" fill="#ece7a6"/><circle cx="60" cy="46" r="4.2" fill="#ece7a6"/>
    <circle cx="40" cy="46" r="1.4" fill="#59551e"/><circle cx="60" cy="46" r="1.4" fill="#59551e"/></svg>`,
};

const KINDS = [
  { id: 'ragdoll', name: 'Ragdoll', type: 'Human', cat: 'humans', text: 'The gray test subject. Wanders around, bleeds, breaks and passes out like a real body. Classic behaviour ignores you; V2 (experimental) notices you, puts its hands up, ducks and runs.' },
  { id: 'zombie', name: 'Zombie', type: 'Undead', cat: 'undead', text: 'Shambles after the nearest living person on its floor (you too), arms out, and claws and bites. It feels no pain and doesn\'t bleed out: destroy the brain or take the head off. Anyone it bites gets infected and comes back as a zombie after they die.' },
];
const CATS = [['all', 'All'], ['humans', 'Humans'], ['undead', 'Undead']];

/**
 * Spawn menu (B, or the person button on touch screens), laid out like the toolbox: pick Ragdoll
 * or Zombie from the cards (categories on the right), set how many, armour, behaviour and where
 * below, then Spawn (or double click the card). Also removes everyone or cleans up blood.
 * The choices are remembered between visits.
 */
export class SpawnMenu {
  constructor({ ragdolls, camera, map, audio, hud, onOpenChange, onRemoveAll, onCleanUp }) {
    this.ragdolls = ragdolls; this.camera = camera; this.map = map; this.audio = audio; this.hud = hud;
    this.onOpenChange = onOpenChange; this.onRemoveAll = onRemoveAll; this.onCleanUp = onCleanUp;
    this.isOpen = false;
    this.el = $('spawnmenu');
    this.raycaster = new THREE.Raycaster();
    this.opts = {
      kind: settings.get('spawnKind') === 'zombie' ? 'zombie' : 'ragdoll',
      count: settings.get('spawnCount') || 1,
      helmet: !!settings.get('spawnHelmet'),
      vest: !!settings.get('spawnVest'),
      where: settings.get('spawnWhere') || 'look',
      temper: settings.get('spawnTemper') || 'normal',
      behavior: settings.get('spawnBehavior') === 'v2' ? 'v2' : 'classic',
    };
    this.cat = 'all';
    const grid = $('spawn-grid');
    grid.innerHTML = KINDS.map((k) => `<button class="tool-card spawn-card" data-kind="${k.id}" data-cat="${k.cat}">
        <span class="key"></span><div class="pv"><div class="head">${HEADS[k.id]}</div></div><b>${k.name}</b><small>${k.type}</small></button>`).join('');
    $('spawn-cats').innerHTML = CATS.map(([id, label]) => `<button data-cat="${id}">${label}<span>${id === 'all' ? KINDS.length : KINDS.filter((k) => k.cat === id).length}</span></button>`).join('');
    this.el.addEventListener('click', (e) => this.onClick(e));
    grid.addEventListener('dblclick', (e) => { const c = e.target.closest('[data-kind]'); if (c) { this.pick(c.dataset.kind); this.spawn(); this.close(); } });
    this.render();
  }

  onClick(e) {
    const b = e.target.closest('button');
    if (!b) return;
    this.audio.unlock();
    if (b.dataset.kind) { this.pick(b.dataset.kind); return; }
    if (b.dataset.cat && b.closest('#spawn-cats')) { this.cat = b.dataset.cat; this.audio.play('click'); this.render(); return; }
    if (b.dataset.opt) {
      const k = b.dataset.opt;
      if (k === 'helmet' || k === 'vest') this.opts[k] = !this.opts[k];
      else this.opts[k] = k === 'count' ? Number(b.dataset.v) : b.dataset.v;
      settings.set(`spawn${k[0].toUpperCase()}${k.slice(1)}`, this.opts[k]);
      this.audio.play('click');
      this.render();
    } else if (b.id === 'sm-spawn') { this.spawn(); this.close(); }
    else if (b.id === 'sm-clear') { this.onRemoveAll?.(); this.render(); }
    else if (b.id === 'sm-clean') { this.onCleanUp?.(); }
    else if (b.id === 'sm-close') this.close();
  }

  pick(kind) {
    if (this.opts.kind !== kind) { this.opts.kind = kind; settings.set('spawnKind', kind); }
    this.audio.play('click');
    this.render();
  }

  open() {
    if (this.isOpen) return;
    this.isOpen = true;
    this.el.classList.remove('hidden');
    this.render();
    this.onOpenChange?.(true);
  }
  close() { if (!this.isOpen) return; this.isOpen = false; this.el.classList.add('hidden'); this.onOpenChange?.(false); }
  toggle() { if (this.isOpen) this.close(); else this.open(); }

  render() {
    const o = this.opts, k = KINDS.find((x) => x.id === o.kind);
    const alive = this.ragdolls.list.filter((r) => !r.hidden);
    const nz = alive.filter((r) => r.zombie).length, nr = alive.length - nz;
    for (const c of this.el.querySelectorAll('.spawn-card')) {
      const id = c.dataset.kind, n = id === 'zombie' ? nz : nr;
      c.classList.toggle('picked', id === o.kind);
      c.classList.toggle('hidden', this.cat !== 'all' && c.dataset.cat !== this.cat);
      c.querySelector('.key').textContent = n ? `${n} in world` : '';
    }
    for (const c of $('spawn-cats').querySelectorAll('button')) c.classList.toggle('on', c.dataset.cat === this.cat);
    const seg = (opt, list) => `<div class="seg">${list.map(([v, label]) => `<button data-opt="${opt}" data-v="${v}" class="${String(o[opt]) === String(v) ? 'on' : ''}">${label}</button>`).join('')}</div>`;
    const human = o.kind === 'ragdoll';
    const many = o.count > 1, noun = human ? (many ? 'ragdolls' : 'ragdoll') : (many ? 'zombies' : 'zombie');
    $('sm-info').innerHTML = `
      <div class="sm-desc"><b>${k.name}</b><span class="tag">${k.type}</span><p>${k.text}</p></div>
      <div class="sm-opts2">
        <div><h3>How many</h3>${seg('count', [[1, '1'], [2, '2'], [3, '3'], [5, '5'], [8, '8']])}</div>
        <div><h3>Where</h3>${seg('where', [['look', 'Where I look'], ['front', 'In front'], ['spawn', 'Spawn point']])}</div>
        <div><h3>Armour</h3><div class="chips"><button data-opt="helmet" class="${o.helmet ? 'on' : ''}">Helmet</button><button data-opt="vest" class="${o.vest ? 'on' : ''}">Vest</button></div></div>
        ${human ? `<div><h3>Behaviour</h3>${seg('behavior', [['classic', 'Classic'], ['v2', 'V2 <i class="exp">experimental</i>']])}</div>` : ''}
        ${human && o.behavior === 'v2' ? `<div><h3>Temperament</h3>${seg('temper', [['brave', 'Brave'], ['normal', 'Normal'], ['timid', 'Timid']])}</div>` : ''}
      </div>
      <button id="sm-spawn" class="sm-go">Spawn ${many ? `${o.count} ` : ''}${noun}</button>
      <div class="sm-row"><button id="sm-clear">Remove everyone</button><button id="sm-clean">Clean up blood</button></div>
      <p class="note" id="sm-count">${nr} ragdoll${nr === 1 ? '' : 's'} and ${nz} zombie${nz === 1 ? '' : 's'} in the world (up to ${MAX_RAGDOLLS} in all).</p>`;
  }

  /** Is this spot clear of walls and props (with a margin), on the floor at height y? */
  free(x, y, z, m = 0.45) {
    const b = this.map.bounds;
    if (x < b.minX + 1 || x > b.maxX - 1 || z < b.minZ + 1 || z > b.maxZ - 1) return false;
    const list = this.map.near(x - m, y + 0.06, z - m, x + m, y + 1.7, z + m);
    for (const c of list) {
      if (c.off) continue;
      if (x > c.min.x - m && x < c.max.x + m && z > c.min.z - m && z < c.max.z + m && c.max.y > y + 0.06 && c.min.y < y + 1.7) return false;
    }
    return true;
  }

  /** Where the first one goes (a point on a floor). */
  anchor() {
    const cam = this.camera;
    const eye = cam.getWorldPosition(new THREE.Vector3());
    const fwd = cam.getWorldDirection(new THREE.Vector3());
    const flat = fwd.clone().setY(0).normalize();
    const feet = WORLD.groundAt(eye.x, eye.z, eye.y);
    if (this.opts.where === 'spawn') return new THREE.Vector3(...this.map.ragdollSpawn.pos);
    if (this.opts.where === 'front') { const p = eye.clone().addScaledVector(flat, 3); p.y = feet; return this.backOff(p, flat, feet); }
    // where you look: the floor point under the crosshair (up to 30 m), stepping back from walls
    this.raycaster.set(eye, fwd); this.raycaster.far = 30;
    const hit = this.raycaster.intersectObjects(this.map.solidMeshes, false)[0];
    const n = hit?.face ? hit.face.normal.clone().transformDirection(hit.object.matrixWorld) : null;
    let p;
    if (hit && n && n.y > 0.7 && hit.point.y < eye.y) p = hit.point.clone();      // a floor
    else { p = hit ? hit.point.clone() : eye.clone().addScaledVector(fwd, 6); p.y = feet; }
    p.y = WORLD.groundAt(p.x, p.z, p.y + 0.3);
    p = this.backOff(p, flat, p.y);
    const toEye = eye.clone().setY(0).sub(p.clone().setY(0));
    if (toEye.length() < 1.2) p.addScaledVector(flat, 1.2 - toEye.length());
    return p;
  }

  /** Come back towards you until there is clear floor. */
  backOff(p, flat, y) {
    const back = flat.clone().negate();
    for (let i = 0; i < 40 && !this.free(p.x, y, p.z); i++) p.addScaledVector(back, 0.3);
    p.y = y;
    return p;
  }

  spawn() {
    const o = this.opts, zombie = o.kind === 'zombie';
    const room = MAX_RAGDOLLS - this.ragdolls.list.filter((r) => !r.hidden).length;
    if (room <= 0) { this.audio.play('deny'); this.hud.toast(`There are already ${MAX_RAGDOLLS} bodies. Remove some first.`); return; }
    const n = Math.min(o.count, room);
    const eye = this.camera.getWorldPosition(new THREE.Vector3());
    const a = this.anchor();
    const toward = eye.clone().setY(0).sub(a.clone().setY(0)).normalize();
    const side = new THREE.Vector3(toward.z, 0, -toward.x);
    const spawned = [];
    for (let i = 0; i < n; i++) {
      // a row across your view (and a second row behind it for big groups)
      const row = i < 5 ? 0 : 1, k = row ? i - 5 : i, inRow = row ? n - 5 : Math.min(5, n);
      const off = (k - (inRow - 1) / 2) * 0.95;
      const p = a.clone().addScaledVector(side, off).addScaledVector(toward, -row * 1.1);
      for (let j = 0; j < 12 && !this.free(p.x, a.y, p.z, 0.35); j++) p.addScaledVector(toward, 0.35);
      const y = WORLD.groundAt(p.x, p.z, a.y + 0.4);
      const yaw = Math.atan2(eye.x - p.x, eye.z - p.z) + (Math.random() - 0.5) * 0.3;
      const r = this.ragdolls.spawn([p.x, y, p.z], yaw, { armor: { helmet: o.helmet, vest: o.vest }, behavior: zombie ? 'classic' : o.behavior, zombie });
      if (!zombie && o.behavior === 'v2') r.brain.fearMul = TEMPER[o.temper] || 1;
      spawned.push(r);
    }
    this.audio.play('button');
    if (zombie) this.audio.play('groan', 0.8);
    const what = [o.helmet && 'helmet', o.vest && 'vest'].filter(Boolean).join(' and ');
    const noun = zombie ? 'zombie' : `${o.behavior === 'v2' ? 'V2 ' : ''}ragdoll`;
    this.hud.toast(`Spawned ${n} ${noun}${n > 1 ? 's' : ''}${what ? ` with ${what}` : ''}${n < o.count ? ` (max ${MAX_RAGDOLLS})` : ''}`);
    return spawned;
  }
}
