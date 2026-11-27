import * as THREE from 'three';
import { settings } from '../settings.js';
import { CONFIG } from '../config.js';

const $ = (id) => document.getElementById(id);
export const MAX_RAGDOLLS = 12;

const TEMPER = { brave: 0.35, normal: 1, timid: 1.7 };

/**
 * Spawn menu (B, or the person button on touch screens): how many ragdolls, which armour, how
 * easily they get scared and where they appear. Also removes every ragdoll or cleans up blood.
 * The choices are remembered between visits.
 */
export class SpawnMenu {
  constructor({ ragdolls, camera, map, audio, hud, onOpenChange, onRemoveAll, onCleanUp }) {
    this.ragdolls = ragdolls; this.camera = camera; this.map = map; this.audio = audio; this.hud = hud;
    this.onOpenChange = onOpenChange;
    this.isOpen = false;
    this.el = $('spawnmenu');
    this.raycaster = new THREE.Raycaster();
    this.opts = {
      count: settings.get('spawnCount') || 1,
      helmet: !!settings.get('spawnHelmet'),
      vest: !!settings.get('spawnVest'),
      where: settings.get('spawnWhere') || 'look',
      temper: settings.get('spawnTemper') || 'normal',
    };
    this.el.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      this.audio.unlock();
      if (b.dataset.opt) {
        const k = b.dataset.opt;
        if (k === 'helmet' || k === 'vest') this.opts[k] = !this.opts[k];
        else this.opts[k] = k === 'count' ? Number(b.dataset.v) : b.dataset.v;
        settings.set(`spawn${k[0].toUpperCase()}${k.slice(1)}`, this.opts[k]);
        this.audio.play('click');
        this.render();
      } else if (b.id === 'sm-spawn') { this.spawn(); this.close(); }
      else if (b.id === 'sm-clear') { onRemoveAll?.(); this.render(); }
      else if (b.id === 'sm-clean') { onCleanUp?.(); }
      else if (b.id === 'sm-close') this.close();
    });
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
    const o = this.opts;
    for (const b of this.el.querySelectorAll('[data-opt]')) {
      const k = b.dataset.opt;
      b.classList.toggle('on', k === 'helmet' || k === 'vest' ? o[k] : String(o[k]) === b.dataset.v);
    }
    const fig = $('sm-figure');
    fig.classList.toggle('helmet', o.helmet); fig.classList.toggle('vest', o.vest);
    const n = this.ragdolls.list.length;
    $('sm-count').textContent = `${n} ragdoll${n === 1 ? '' : 's'} in the world (up to ${MAX_RAGDOLLS}).`;
    $('sm-spawn').textContent = `Spawn ${o.count > 1 ? `${o.count} ragdolls` : 'ragdoll'}`;
  }

  /** Is this floor spot clear of blocks (with a margin)? */
  free(x, z, m = 0.45) {
    const B = CONFIG.map.boundary - 1;
    if (Math.abs(x) > B || Math.abs(z) > B) return false;
    return !this.map.colliders.some((c) => x > c.min.x - m && x < c.max.x + m && z > c.min.z - m && z < c.max.z + m && c.max.y > 0.05);
  }

  /** Where the first ragdoll goes. */
  anchor() {
    const cam = this.camera;
    const eye = cam.getWorldPosition(new THREE.Vector3());
    const fwd = cam.getWorldDirection(new THREE.Vector3());
    const flat = fwd.clone().setY(0).normalize();
    if (this.opts.where === 'spawn') return new THREE.Vector3(...CONFIG.ragdoll.spawn);
    if (this.opts.where === 'front') return eye.clone().setY(0).addScaledVector(flat, 3);
    // where you look: the floor point under the crosshair (up to 30 m), stepping back from walls
    this.raycaster.set(eye, fwd); this.raycaster.far = 30;
    const hit = this.raycaster.intersectObjects(this.map.solidMeshes, false)[0];
    let p = hit ? hit.point.clone() : eye.clone().addScaledVector(fwd, 6);
    if (!hit || p.y > 0.05) {
      // looking at a wall, block or the sky: come back towards you until there is clear floor
      p.y = 0;
      const back = flat.clone().negate();
      for (let i = 0; i < 40 && !this.free(p.x, p.z); i++) p.addScaledVector(back, 0.3);
    }
    const toEye = eye.clone().setY(0).sub(p.clone().setY(0));
    if (toEye.length() < 1.2) p.addScaledVector(flat, 1.2 - toEye.length());
    return p.setY(0);
  }

  spawn() {
    const o = this.opts;
    const room = MAX_RAGDOLLS - this.ragdolls.list.length;
    if (room <= 0) { this.audio.play('deny'); this.hud.toast(`There are already ${MAX_RAGDOLLS} ragdolls. Remove some first.`); return; }
    const n = Math.min(o.count, room);
    const eye = this.camera.getWorldPosition(new THREE.Vector3()).setY(0);
    const a = this.anchor();
    const toward = eye.clone().sub(a).normalize();
    const side = new THREE.Vector3(toward.z, 0, -toward.x);
    const spawned = [];
    for (let i = 0; i < n; i++) {
      // a row across your view (and a second row behind it for big groups)
      const row = i < 5 ? 0 : 1, k = row ? i - 5 : i, inRow = row ? n - 5 : Math.min(5, n);
      const off = (k - (inRow - 1) / 2) * 0.95;
      const p = a.clone().addScaledVector(side, off).addScaledVector(toward, -row * 1.1);
      for (let j = 0; j < 12 && !this.free(p.x, p.z, 0.35); j++) p.addScaledVector(toward, 0.35);
      const yaw = Math.atan2(eye.x - p.x, eye.z - p.z) + (Math.random() - 0.5) * 0.3;
      const r = this.ragdolls.spawn([p.x, 0, p.z], yaw, { armor: { helmet: o.helmet, vest: o.vest } });
      r.brain.fearMul = TEMPER[o.temper] || 1;
      spawned.push(r);
    }
    this.audio.play('button');
    const what = [o.helmet && 'helmet', o.vest && 'vest'].filter(Boolean).join(' and ');
    this.hud.toast(`Spawned ${n} ragdoll${n > 1 ? 's' : ''}${what ? ` with ${what}` : ''}${n < o.count ? ` (max ${MAX_RAGDOLLS})` : ''}`);
    return spawned;
  }
}
