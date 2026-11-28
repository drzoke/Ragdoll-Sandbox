import * as THREE from 'three';
import { damp, drawOffset, clamp } from '../core/util.js';
import { BlockArms } from '../weapon/arms.js';
import { viewmodelScene, Sway } from '../weapon/viewmodel.js';
import { AMMO } from '../weapon/ammo.js';
import { mergeGeometries } from '../world/build.js';

// VS Undead gadgets: the proximity mine and the sentry gun. Both are placed on the ground in
// front of you. In multiplayer the host's game runs them (the friends see copies).

const M = {
  olive: new THREE.MeshStandardMaterial({ color: 0x4a5238, roughness: 0.7, metalness: 0.2 }),
  dark: new THREE.MeshStandardMaterial({ color: 0x1c1e21, roughness: 0.5, metalness: 0.5 }),
  metal: new THREE.MeshStandardMaterial({ color: 0x3a3e44, roughness: 0.35, metalness: 0.8 }),
  led: new THREE.MeshBasicMaterial({ color: 0x40ff60 }),
  ledRed: new THREE.MeshBasicMaterial({ color: 0xff3020 }),
  yellow: new THREE.MeshStandardMaterial({ color: 0xc9a22a, roughness: 0.6 }),
};
export const GADGET_MATERIALS = M;

const part = (geo, x, y, z, rx = 0, ry = 0, rz = 0) => ({ geo, matrix: new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz)), new THREE.Vector3(1, 1, 1)) });
const mesh = (items, mat) => { const m = new THREE.Mesh(mergeGeometries(items), mat); m.castShadow = true; m.receiveShadow = true; return m; };

/** A flat round anti-personnel mine with a pressure plate and a blinking light. */
export function buildMine() {
  const root = new THREE.Group();
  root.add(mesh([part(new THREE.CylinderGeometry(0.12, 0.13, 0.05, 18), 0, 0.025, 0)], M.olive));
  root.add(mesh([part(new THREE.CylinderGeometry(0.06, 0.06, 0.02, 14), 0, 0.058, 0), part(new THREE.BoxGeometry(0.05, 0.012, 0.03), 0.09, 0.052, 0)], M.dark));
  root.add(mesh([part(new THREE.TorusGeometry(0.11, 0.006, 4, 24), 0, 0.05, 0, Math.PI / 2)], M.yellow));
  const led = new THREE.Mesh(new THREE.SphereGeometry(0.008, 6, 4), M.led);
  led.position.set(0.09, 0.062, 0);
  root.add(led);
  return { root, led };
}

/** A sentry gun on a low tripod: the head turns and tilts, two barrels and an ammo box. */
export function buildSentry() {
  const root = new THREE.Group();
  const legs = [];
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2;
    legs.push(part(new THREE.CylinderGeometry(0.018, 0.022, 0.62, 6), Math.sin(a) * 0.2, 0.26, Math.cos(a) * 0.2, Math.cos(a) * 0.55, 0, -Math.sin(a) * 0.55));
  }
  root.add(mesh([...legs, part(new THREE.CylinderGeometry(0.05, 0.06, 0.12, 10), 0, 0.52, 0)], M.dark));
  const yaw = new THREE.Group(); yaw.position.y = 0.6; root.add(yaw);
  yaw.add(mesh([part(new THREE.CylinderGeometry(0.09, 0.1, 0.06, 14), 0, 0, 0)], M.metal));
  const pitch = new THREE.Group(); pitch.position.y = 0.12; yaw.add(pitch);
  pitch.add(mesh([part(new THREE.BoxGeometry(0.2, 0.16, 0.32), 0, 0, 0), part(new THREE.BoxGeometry(0.06, 0.05, 0.04), 0, 0.1, -0.08)], M.olive));
  pitch.add(mesh([part(new THREE.CylinderGeometry(0.016, 0.016, 0.42, 8), 0.045, 0.02, -0.36, Math.PI / 2), part(new THREE.CylinderGeometry(0.016, 0.016, 0.42, 8), -0.045, 0.02, -0.36, Math.PI / 2),
    part(new THREE.BoxGeometry(0.16, 0.12, 0.14), -0.17, -0.02, 0.04)], M.dark));
  const led = new THREE.Mesh(new THREE.SphereGeometry(0.012, 6, 4), M.led);
  led.position.set(0, 0.13, -0.08);
  pitch.add(led);
  const muzzle = new THREE.Object3D(); muzzle.position.set(0, 0.02, -0.58); pitch.add(muzzle);
  const flash = new THREE.PointLight(0xffb050, 0, 6, 2); flash.position.copy(muzzle.position); pitch.add(flash);
  return { root, yaw, pitch, muzzle, led, flash };
}

const SENTRY_AMMO = 180, SENTRY_RANGE = 28, SENTRY_RATE = 0.105;
const _v = new THREE.Vector3(), _d = new THREE.Vector3(), _m = new THREE.Vector3();

export class Gadgets {
  constructor({ scene, map, ragdolls, audio }) {
    this.scene = scene; this.map = map; this.ragdolls = ragdolls; this.audio = audio;
    this.list = [];
    this.nextId = 1;
    this.ray = new THREE.Raycaster();
    this.explosives = null; this.ballistics = null;
    this.onPlace = null; this.onRemove = null; this.onShot = null;   // multiplayer hooks
  }

  meshes() { const out = []; for (const g of this.list) out.push(...g.hit); return out; }

  place(kind, pos, yaw, { id = 0, owner = 0, ammo = SENTRY_AMMO } = {}) {
    const g = { id: id || this.nextId++, kind, pos: pos.clone(), yaw, owner, age: 0, dead: false };
    this.nextId = Math.max(this.nextId, g.id + 1);
    if (kind === 'mine') {
      const m = buildMine();
      g.model = m; g.armT = 1.6; g.trip = -1;
      m.root.position.copy(pos); m.root.rotation.y = yaw;
      g.hit = [m.root.children[0]];
    } else {
      const m = buildSentry();
      g.model = m; g.ammo = ammo; g.cool = 0.6; g.aimYaw = yaw; g.aimPitch = 0; g.target = null; g.seekT = 0; g.emptyT = -1; g.flashT = 9;
      m.root.position.copy(pos); m.root.rotation.y = 0; m.yaw.rotation.y = yaw;
      g.hit = [m.root.children[0], m.pitch.children[0]];
      g.collider = this.map.addCollider(new THREE.Vector3(pos.x - 0.25, pos.y, pos.z - 0.25), new THREE.Vector3(pos.x + 0.25, pos.y + 0.85, pos.z + 0.25), { walk: false, surface: 'metal' });
    }
    for (const h of g.hit) { h.userData.metal = true; h.userData.gadget = g; h.userData.onShot = (b) => this.shot(g, b); }
    this.scene.add(g.model.root);
    this.list.push(g);
    this.audio.play(kind === 'mine' ? 'clink' : 'magIn');
    this.onPlace?.(g);
    return g;
  }

  remove(g) {
    if (g.dead) return;
    g.dead = true;
    this.scene.remove(g.model.root);
    if (g.collider) this.map.removeCollider(g.collider);
    this.list = this.list.filter((x) => x !== g);
    this.onRemove?.(g);
  }

  clear() { for (const g of [...this.list]) this.remove(g); }
  byId(id) { return this.list.find((g) => g.id === id); }

  /** A bullet sets a mine off; a sentry takes the hit and carries on. */
  shot(g, b) { if (g.kind === 'mine' && this.host && !g.dead && g.armT <= 0) this.blow(g, b.owner || g.owner); }

  blow(g, owner = g.owner) {
    if (g.dead) return;
    const p = g.pos.clone().add(_v.set(0, 0.12, 0));
    this.remove(g);
    this.explosives?.explode(p, owner);
    this.onBlow?.(p);
  }

  zombies() { return this.ragdolls.list.filter((r) => r.zombie && !r.hidden && !r.removed && r.health.alive); }

  /** host = this game runs the gadgets (the friends' copies only aim). */
  update(dt, host = true) {
    this.host = host;
    if (!this.list.length) return;
    const zs = this.zombies();
    for (const g of [...this.list]) {
      g.age += dt;
      if (g.kind === 'mine') this.updateMine(g, dt, zs, host);
      else this.updateSentry(g, dt, zs, host);
    }
  }

  updateMine(g, dt, zs, host) {
    g.armT -= dt;
    const blink = g.trip >= 0 ? Math.sin(g.age * 40) > 0 : g.armT > 0 ? Math.sin(g.age * 8) > 0 : (g.age % 1.6) < 0.08;
    g.model.led.material = g.armT > 0 || g.trip >= 0 ? M.ledRed : M.led;
    g.model.led.visible = blink;
    if (!host || g.armT > 0) return;
    if (g.trip >= 0) { g.trip -= dt; if (g.trip < 0) this.blow(g); return; }
    for (const z of zs) {
      for (const n of ['pelvis', 'footL', 'footR']) {
        const b = z.parts[n]?.body;
        if (!b || z.parts[n].removed) continue;
        if (Math.hypot(b.position.x - g.pos.x, b.position.z - g.pos.z) < 1.35 && b.position.y - g.pos.y < 1.3) {
          g.trip = 0.22; this.audio.play('pin'); return;
        }
      }
    }
  }

  updateSentry(g, dt, zs, host) {
    const m = g.model;
    g.seekT -= dt; g.cool -= dt; g.flashT += dt;
    const eye = _m.copy(g.pos).add(_v.set(0, 0.74, 0));
    if (g.seekT <= 0 && g.ammo > 0) {
      g.seekT = 0.25;
      let best = null, bestD = SENTRY_RANGE;
      for (const z of zs) {
        const part = z.parts.chest && !z.parts.chest.removed ? z.parts.chest : z.parts.pelvis;
        const p = part.body.position;
        const d = Math.hypot(p.x - eye.x, p.y - eye.y, p.z - eye.z);
        if (d >= bestD) continue;
        // only what it can see
        _d.set(p.x - eye.x, p.y - eye.y, p.z - eye.z).normalize();
        this.ray.set(eye, _d); this.ray.far = d - 0.3;
        if (this.ray.intersectObjects(this.map.solidMeshes, false).length) continue;
        best = z; bestD = d;
      }
      g.target = best;
    }
    const t = g.target;
    if (t && (t.removed || !t.health.alive)) g.target = null;
    let aligned = false;
    if (g.target) {
      const head = g.target.parts.head && !g.target.parts.head.removed && g.target.health.parts.head.attached ? g.target.parts.head : g.target.parts.chest;
      const p = head.body.position;
      const wantYaw = Math.atan2(-(p.x - eye.x), -(p.z - eye.z));
      const wantPitch = Math.atan2(p.y - eye.y, Math.hypot(p.x - eye.x, p.z - eye.z));
      let dy = wantYaw - g.aimYaw; dy = Math.atan2(Math.sin(dy), Math.cos(dy));
      g.aimYaw += clamp(dy, -6 * dt, 6 * dt);
      g.aimPitch += (wantPitch - g.aimPitch) * damp(10, dt);
      aligned = Math.abs(dy) < 0.06;
      if (host && aligned && g.cool <= 0 && g.ammo > 0) this.fire(g, p);
    } else g.aimYaw += dt * 0.4 * Math.sin(g.age * 0.5);
    m.yaw.rotation.y = g.aimYaw;
    m.pitch.rotation.x = g.aimPitch;
    m.flash.intensity = g.flashT < 0.04 ? 14 : 0;
    m.led.material = g.ammo > 0 ? M.led : M.ledRed;
    m.led.visible = g.ammo > 0 || (g.age % 0.5) < 0.25;
    if (host && g.ammo <= 0) {
      if (g.emptyT < 0) { g.emptyT = 0; this.audio.play('dry'); }
      g.emptyT += dt;
      if (g.emptyT > 6) this.remove(g);
    }
  }

  fire(g, at) {
    g.cool = SENTRY_RATE; g.ammo--; g.flashT = 0;
    const from = g.model.muzzle.getWorldPosition(new THREE.Vector3());
    const dir = new THREE.Vector3(at.x, at.y, at.z).sub(from).normalize();
    dir.x += (Math.random() - 0.5) * 0.035; dir.y += (Math.random() - 0.5) * 0.03; dir.z += (Math.random() - 0.5) * 0.035;
    dir.normalize();
    this.ballistics?.fire(from.clone().addScaledVector(dir, 0.05), dir, from, { energy: 0.95, impulse: 8, speed: 600, range: 60, life: 1, size: 0.8, glowSize: 0.05, owner: g.owner, bot: true, snd: 'turret' });
    this.audio.play('turret');
    this.onShot?.(g);
  }

  record(g) { return { id: g.id, k: g.kind, p: [g.pos.x, g.pos.y, g.pos.z], y: g.yaw, o: g.owner, a: g.ammo }; }
}

/**
 * The tool for placing a mine or a sentry gun: hold it out, look at the ground in front of you and
 * left click to put it down.
 */
export class PlaceTool {
  constructor(kind, { mainCamera, player, audio, environment, map, onPlace }) {
    this.kind = kind;
    this.name = kind === 'mine' ? 'Proximity Mine' : 'Sentry Gun';
    this.short = kind === 'mine' ? 'Mine' : 'Sentry';
    this.vsOnly = true;
    this.pool = kind === 'mine' ? 'mine' : 'turret';
    this.player = player; this.audio = audio; this.mainCamera = mainCamera; this.map = map; this.onPlace = onPlace;
    const vm = viewmodelScene(environment);
    this.scene = vm.scene; this.camera = vm.camera;
    this.pivot = new THREE.Group(); this.scene.add(this.pivot);
    if (kind === 'mine') {
      this.model = buildMine().root;
      this.model.rotation.set(0.9, 0.2, 0);
      this.model.scale.setScalar(0.9);
    } else {
      // folded up in its carry case
      const root = new THREE.Group();
      root.add(mesh([part(new THREE.BoxGeometry(0.34, 0.2, 0.18), 0, 0, 0)], M.olive));
      root.add(mesh([part(new THREE.BoxGeometry(0.16, 0.03, 0.03), 0, 0.12, 0), part(new THREE.CylinderGeometry(0.014, 0.014, 0.3, 6), 0.05, 0.03, 0.1, 0, 0, Math.PI / 2), part(new THREE.CylinderGeometry(0.014, 0.014, 0.3, 6), 0.05, -0.03, 0.1, 0, 0, Math.PI / 2)], M.dark));
      root.rotation.set(0.1, 0.35, 0);
      this.model = root;
    }
    this.pivot.add(this.model);
    this.arms = new BlockArms(this.scene, { handSize: 0.064 });
    this.raise = 0; this.drawing = true;
    this.sway = new Sway(player);
    this.cool = 0; this.placeT = 9;
    this.ray = new THREE.Raycaster();
    this.spot = null;
  }

  resize(aspect) { this.camera.aspect = aspect; this.camera.updateProjectionMatrix(); }
  refill() {}
  get controls() { return [['Left click', this.kind === 'mine' ? 'Put the mine down (it arms after a second)' : 'Set up the sentry gun']]; }
  status() { return { title: this.name, sub: `${AMMO.label(this.pool)} left${this.kind === 'mine' ? ' · goes off when a zombie steps near' : ' · 180 rounds, shoots zombies it sees'}` }; }
  crosshair() { return { gap: 6, dot: true }; }

  /** Where it would go: the ground 1.2 to 2.5 m in front of you. */
  findSpot() {
    const cam = this.mainCamera, p = this.player;
    const fwd = new THREE.Vector3(-Math.sin(p.yaw), 0, -Math.cos(p.yaw));
    const d = this.kind === 'mine' ? 1.6 : 1.8;
    const at = new THREE.Vector3(p.pos.x, p.pos.y + 1, p.pos.z).addScaledVector(fwd, d);
    this.ray.set(at, new THREE.Vector3(0, -1, 0)); this.ray.far = 3;
    const hit = this.ray.intersectObjects(this.map.solidMeshes, false)[0];
    if (!hit || hit.point.y > p.pos.y + 0.4 || hit.point.y < p.pos.y - 1.2) return null;
    // something in the way between you and the spot
    this.ray.set(cam.getWorldPosition(new THREE.Vector3()), at.clone().sub(cam.position).normalize()); this.ray.far = at.distanceTo(cam.position);
    if (this.ray.intersectObjects(this.map.solidMeshes, false).some((h) => h.distance < this.ray.far - 0.1)) return null;
    return { pos: hit.point.clone(), yaw: p.yaw };
  }

  update(dt, input, active) {
    active = active && this.raise > 0.9;
    this.cool -= dt; this.placeT += dt;
    const have = AMMO.has(this.pool);
    if (active && input.mousePressed[0] && this.cool <= 0) {
      if (!have) { this.audio.play('deny'); this.say?.(`No ${this.kind === 'mine' ? 'mines' : 'sentry guns'} left`); }
      else {
        const s = this.findSpot();
        if (!s) { this.audio.play('deny'); this.say?.('Look at clear ground in front of you'); }
        else { AMMO.take(this.pool, 1); this.onPlace(this.kind, s.pos, s.yaw); this.cool = 0.6; this.placeT = 0; }
      }
    }
    // pose: held low in both hands; dips when you put one down
    const sw = this.sway.update(dt, { rate: 9 });
    const dr = drawOffset(this.raise, this.drawing);
    const dip = this.placeT < 0.5 ? Math.sin((this.placeT / 0.5) * Math.PI) : 0;
    this.model.visible = have || this.placeT < 0.25;
    const big = this.kind !== 'mine';
    this.pivot.position.set(0.02 + sw.x + sw.bobX + dr.x, (big ? -0.3 : -0.26) + sw.y + sw.bobY + sw.idle + dr.y - dip * 0.15, -0.46 + dr.z + dip * 0.05);
    this.pivot.rotation.set(dr.rx + sw.y + dip * 0.4, sw.x, dr.rz);
    this.pivot.updateMatrixWorld(true);
    const w = big ? 0.19 : 0.13;
    this.arms.set('right', this.pivot.localToWorld(new THREE.Vector3(w, -0.03, 0.02)), { roll: 0.5, visible: this.model.visible });
    this.arms.set('left', this.pivot.localToWorld(new THREE.Vector3(-w, -0.03, 0.02)), { roll: -0.5, visible: this.model.visible });
  }
}
