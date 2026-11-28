import * as THREE from 'three';
import { AMMO } from './ammo.js';
import { CONFIG } from '../config.js';
import { clamp, damp, Spring, lerp, viewmodelToWorld, drawOffset } from '../core/util.js';
import { buildMusket } from './modelRifles.js';
import { muzzleFlashTexture, flameTexture } from './model1911.js';
import { puffTexture } from './explosives.js';
import { Clip, ClipPlayer } from './anim.js';
import { BlockArms, sampleHand, anchorPos } from './arms.js';
import { viewmodelScene, Sway } from './viewmodel.js';

const W = CONFIG.weapon;
const S = {
  energy: 2.1,               // a big soft lead ball: smashes bone, stops in the body more often than a rifle round
  impulse: W.impulse * 2.4,
  speed: 300,
  range: 260,
  hipSpread: 0.03, adsSpread: 0.011,
  misfire: 0.04,             // "flash in the pan": the priming burns, the charge doesn't
  hipPos: [0.12, -0.16, -0.32],
  adsPos: [0, -0.081, -0.13],  // cheek on the stock, looking down the barrel over the front sight
  adsPitch: 0.012,
  gripOffset: [0, 0.06, -0.12],
};
const COCK = { full: 0, half: -0.35, down: -0.8 };
const Z3 = [0, 0, 0];
const P_POS = [-0.13, 0.02, 0.05], P_ROT = [0.12, -0.5, 0.3];        // lock turned towards you (priming the pan)
const V_POS = [-0.12, -0.8, -0.03], V_ROT = [1.0, 0.04, 0.02];       // butt on the ground, muzzle up (loading)
const V_TAP = [V_POS[0], V_POS[1] - 0.012, V_POS[2]];

const CL = {
  reload: new Clip('reload', 6.65, {
    pos: [[0, Z3], [0.35, P_POS], [1.72, P_POS], [2.25, V_POS], [4.56, V_POS], [4.62, V_TAP], [4.72, V_POS], [4.8, V_TAP], [4.9, V_POS], [5.9, V_POS], [6.35, Z3]],
    rot: [[0, Z3], [0.35, P_ROT], [1.72, P_ROT], [2.25, V_ROT], [5.9, V_ROT], [6.35, Z3]],
    cock: [[0, COCK.down], [0.42, COCK.down], [0.55, COCK.half], [6.26, COCK.half], [6.38, COCK.full]],
    friz: [[0, 1], [1.6, 1], [1.72, 0]],
    paper: [[0, 0], [0.85, 0], [0.851, 1], [2.85, 1], [2.851, 0]],
    rodMode: [[0, 0], [3.5, 0], [3.501, 1], [5.45, 1], [5.451, 0]],
    d: [[0, 0], [3.05, 0], [3.22, 0.45], [3.3, 0.45], [3.5, 1], [5.45, 1], [5.62, 0.5], [5.7, 0.5], [5.86, 0.02], [5.92, 0]],
    tipZ: [[0, -1.0], [3.6, -1.0], [3.95, -0.5], [4.15, -0.5], [4.48, -0.1], [4.56, -0.1], [4.62, -0.24], [4.7, -0.08], [4.8, -0.24], [4.88, -0.08], [4.95, -0.08], [5.15, -0.55], [5.25, -0.55], [5.45, -1.04]],
    hz: [[0, 0], [3.05, 0], [3.22, 0.45], [3.3, 0.05], [3.5, 0.6], [3.6, 0.55], [3.95, 0.05], [4.15, 0.4], [4.48, 0.0], [4.56, 0.02], [4.62, 0.16], [4.7, 0.0], [4.8, 0.16], [4.88, 0.0], [4.95, 0.0], [5.15, 0.45], [5.25, 0.05], [5.45, 0.52], [5.62, 0.02], [5.7, 0.48], [5.86, 0.0]],
  }, [[0.55, 'halfCock'], [1.2, 'bite'], [1.48, 'prime'], [1.7, 'frizzen'], [2.5, 'pour'], [2.85, 'ball'], [3.05, 'ramrod'], [3.6, 'ram'], [4.15, 'ram'],
    [4.7, 'ramTap'], [4.88, 'ramTap'], [4.95, 'ramrod'], [5.47, 'ramrod'], [5.9, 'ramTap'], [6.38, 'fullCock']]),
  prime: new Clip('prime', 2.4, {
    pos: [[0, Z3], [0.35, P_POS], [1.85, P_POS], [2.3, Z3]],
    rot: [[0, Z3], [0.35, P_ROT], [1.85, P_ROT], [2.3, Z3]],
    cock: [[0, COCK.down], [0.42, COCK.down], [0.55, COCK.half], [1.82, COCK.half], [1.95, COCK.full]],
    friz: [[0, 1], [1.5, 1], [1.62, 0]],
  }, [[0.55, 'halfCock'], [1.38, 'prime'], [1.6, 'frizzen'], [1.93, 'fullCock']]),
  inspect: new Clip('inspect', 2.6, {
    pos: [[0, Z3], [0.45, P_POS], [1.85, [P_POS[0] + 0.02, P_POS[1] + 0.01, P_POS[2]]], [2.45, Z3]],
    rot: [[0, Z3], [0.45, P_ROT], [1.85, [P_ROT[0] + 0.08, P_ROT[1] - 0.15, P_ROT[2] + 0.1]], [2.45, Z3]],
  }),
};
CL.reload.rh = [[0, 'grip'], [0.3, 'grip'], [0.45, 'lock'], [0.6, 'lock'], [0.85, 'pouch'], [0.95, 'pouch'], [1.15, 'mouth'], [1.25, 'mouth'], [1.42, 'pan'], [1.55, 'pan'],
  [1.68, 'lock'], [1.76, 'lock'], [2.25, 'muzzle'], [2.95, 'muzzle'], [3.05, 'rod'], [5.9, 'rod'], [6.1, 'grip'], [6.25, 'lock'], [6.4, 'lock'], [6.58, 'grip']];
CL.prime.rh = [[0, 'grip'], [0.3, 'grip'], [0.45, 'lock'], [0.6, 'lock'], [0.85, 'pouch'], [0.95, 'pouch'], [1.25, 'pan'], [1.42, 'pan'], [1.55, 'lock'], [1.98, 'lock'], [2.25, 'grip']];
CL.inspect.rh = [[0, 'grip']];

const _v = new THREE.Vector3(), _v2 = new THREE.Vector3(), _v3 = new THREE.Vector3(), _h = new THREE.Vector3();

/** World-space black-powder smoke: a thick white cloud that hangs around for seconds. */
export class PowderSmoke {
  constructor(scene, max = 48) {
    this.tex = puffTexture(false);
    this.pool = []; this.live = [];
    for (let i = 0; i < max; i++) {
      const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.tex, transparent: true, depthWrite: false, color: 0xe4e2dc, opacity: 0 }));
      s.visible = false; s.renderOrder = 5; scene.add(s); this.pool.push(s);
    }
  }
  puff(pos, vel, { size = 0.4, grow = 2.2, life = 5, opacity = 0.62, shade = 0.9, color = null } = {}) {
    const s = this.pool.length ? this.pool.pop() : this.live.shift().s;
    s.visible = true; s.position.copy(pos); s.scale.setScalar(size);
    s.material.rotation = Math.random() * Math.PI * 2;
    if (color !== null) s.material.color.set(color); else s.material.color.setScalar(shade);
    this.live.push({ s, vel: vel.clone(), age: 0, life, size, grow, opacity, spin: (Math.random() - 0.5) * 0.4 });
  }
  clear() { for (const p of this.live) { p.s.visible = false; this.pool.push(p.s); } this.live.length = 0; }
  update(dt) {
    for (let i = this.live.length - 1; i >= 0; i--) {
      const p = this.live[i];
      p.age += dt;
      if (p.age >= p.life) { p.s.visible = false; this.pool.push(p.s); this.live.splice(i, 1); continue; }
      p.vel.multiplyScalar(Math.exp(-3.2 * dt));
      p.vel.y += 0.06 * dt; p.vel.x += 0.05 * dt;   // a little rise and drift
      p.s.position.addScaledVector(p.vel, dt);
      const u = p.age / p.life;
      p.s.scale.setScalar(p.size + (p.grow - p.size) * (1 - Math.pow(1 - u, 2.2)));
      p.s.material.rotation += p.spin * dt;
      p.s.material.opacity = p.opacity * Math.min(1, p.age / 0.06) * Math.pow(1 - u, 1.4);
    }
  }
}

/**
 * Flintlock musket (.75 calibre, smoothbore, muzzle-loaded). Pull the trigger and the flint strikes
 * the frizzen, the priming flashes in the pan, and a moment later the main charge goes off in a
 * cloud of white smoke. One shot, then a long reload: half-cock, prime, pour, ram, cock.
 */
export class Musket {
  constructor({ mainScene, mainCamera, player, audio, environment, onFire }) {
    this.name = 'Flintlock Musket';
    this.short = 'Musket';
    this.player = player; this.audio = audio; this.mainCamera = mainCamera; this.onFire = onFire;
    const vm = viewmodelScene(environment);
    this.scene = vm.scene; this.camera = vm.camera;
    this.flashLightVM = new THREE.PointLight(0xffb060, 0, 2.2, 2); this.scene.add(this.flashLightVM);

    this.pivot = new THREE.Group(); this.scene.add(this.pivot);
    this.gun = buildMusket();
    this.gun.root.position.set(...S.gripOffset);
    this.pivot.add(this.gun.root);
    this.materials = this.gun.materials;

    const add = (tex) => new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }));
    this.flash = add(muzzleFlashTexture()); this.flash.scale.setScalar(0.34); this.flash.position.set(0, 0, -0.1); this.flash.visible = false;
    this.gun.muzzle.add(this.flash);
    const flameMat = new THREE.MeshBasicMaterial({ map: flameTexture(), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, side: THREE.DoubleSide });
    const flameGeo = new THREE.PlaneGeometry(0.16, 0.42).translate(0, 0.21, 0).rotateX(-Math.PI / 2);
    this.flame = new THREE.Group();
    for (let i = 0; i < 3; i++) { const m = new THREE.Mesh(flameGeo, flameMat); m.rotation.z = (i / 3) * Math.PI; this.flame.add(m); }
    this.flame.visible = false;
    this.gun.muzzle.add(this.flame);
    // sparks off the frizzen, then the flash of the priming
    this.sparks = add(muzzleFlashTexture()); this.sparks.scale.setScalar(0.05); this.sparks.visible = false; this.sparks.material.color.set(0xffd27a);
    this.gun.panPoint.add(this.sparks);
    this.panFlash = add(puffTexture(true)); this.panFlash.scale.setScalar(0.12); this.panFlash.visible = false;
    this.panFlash.position.set(0.01, 0.025, 0);
    this.gun.panPoint.add(this.panFlash);

    // hands + the paper cartridge in the right hand
    this.arms = new BlockArms(this.scene, { handSize: 0.062 });
    const paper = new THREE.Mesh(new THREE.CylinderGeometry(0.0085, 0.0085, 0.06, 10), new THREE.MeshStandardMaterial({ color: 0xe9dfc6, roughness: 0.9 }));
    paper.rotation.x = 0.4; paper.position.set(0, 0.03, -0.02);
    this.paper = paper; this.arms.right.hold.add(paper); paper.visible = false;
    const lock = new THREE.Object3D(); lock.position.set(0.04, 0.03, 0.03); this.gun.root.add(lock);
    const pan = new THREE.Object3D(); pan.position.set(0.038, 0.035, -0.03); this.gun.root.add(pan);
    const muzzle = new THREE.Object3D(); muzzle.position.set(0.018, 0.01, -1.1); this.gun.root.add(muzzle);
    this.rodHand = new THREE.Object3D(); this.gun.root.add(this.rodHand);
    this.handTargets = {
      grip: () => anchorPos(this.gun.gripPoint, _h),
      fore: () => anchorPos(this.gun.foreHand, _h),
      lock: () => anchorPos(lock, _h),
      pan: () => anchorPos(pan, _h),
      muzzle: () => anchorPos(muzzle, _h),
      rod: () => anchorPos(this.rodHand, _h),
      mouth: new THREE.Vector3(0.02, -0.13, -0.17),
      pouch: new THREE.Vector3(0.2, -0.46, -0.12),
    };

    this.worldFlash = new THREE.PointLight(0xffa850, 0, 16, 2);
    mainScene.add(this.worldFlash);
    this.smoke = new PowderSmoke(mainScene);

    // ---- state ----
    this.loaded = true; this.primed = true; this.cock = 'full'; this.frizzenOpen = false;
    this.raise = 0; this.drawing = true;
    this.ads = 0; this.sprint = 0;
    this.fireT = 99; this.strikeT = 99; this.panT = 99;
    this.seq = null;            // the lock is going off
    this.msg = ''; this.msgT = 0;
    this.misfire = S.misfire;
    this.anim = new ClipPlayer();
    this.kickBack = new Spring(200, 12); this.kickRot = new Spring(170, 11); this.kickSide = new Spring(200, 16); this.kickRoll = new Spring(200, 16);
    this.sway = new Sway(player);
    this._ev = (e, c) => this.onEvent(e, c);
  }

  get busy() { return this.anim.playing || !!this.seq; }
  get state() { return this.anim.clip ? this.anim.clip.name : this.seq ? 'firing' : 'idle'; }
  resize(aspect) { this.camera.aspect = aspect; this.camera.updateProjectionMatrix(); }
  refill() {}

  get controls() {
    return [['Left click', 'Fire (a moment after the flash in the pan)'], ['Right click', 'Aim down the barrel'], ['R', 'Reload (about 6 seconds)'], ['F', 'Inspect']];
  }
  status() { return null; }
  ammo() {
    const ready = this.loaded && this.primed && this.cock === 'full';
    const name = this.msgT > 0 ? this.msg : this.anim.clip === CL.reload ? 'Reloading…' : 'Flintlock · .75 ball';
    return { mag: this.loaded ? 1 : 0, chamber: ready ? 'ready' : this.loaded ? 'unprimed' : 'empty', reserve: AMMO.label('ball'), name, low: !ready };
  }
  crosshair() { return { gap: 20 + Math.max(0, 0.35 - this.fireT) * 70, ads: this.ads > 0.6 }; }

  update(dt, input, active, worldDt = dt) {
    const p = this.player;
    active = active && this.raise > 0.9;
    this.fireT += dt; this.strikeT += dt; this.panT += dt;
    this.msgT -= dt;
    const st = this.state;
    const wantAds = active && input.mouseDown[2] && !this.anim.playing && !p.sprinting;
    this.ads += ((wantAds ? 1 : 0) - this.ads) * damp(9, dt);
    if (this.raise > 0) p.aiming = this.ads > 0.5;
    this.sprint += ((p.sprinting && st !== 'reload' && st !== 'prime' ? 1 : 0) - this.sprint) * damp(8, dt);

    if (active) {
      if (input.mousePressed[0]) this.tryFire();
      if (input.wasPressed('KeyR')) this.tryReload();
      if (input.wasPressed('KeyF') && !this.busy) this.anim.play(CL.inspect, this._ev);
    }
    if (this.seq) this.runLock(dt);
    this.anim.update(dt);
    this.animate(dt);
    this.smoke.update(worldDt);
  }

  tryFire() {
    if (this.busy) { if (this.state === 'inspect') this.anim.stop(); else return; }
    if (this.sprint > 0.5) return;
    if (this.cock !== 'full') { this.tryReload(); return; }   // nothing to fire: start loading
    // the cock falls: flint on steel, the frizzen snaps open over the pan
    this.cock = 'down'; this.frizzenOpen = true; this.strikeT = 0;
    this.audio.play('flint');
    const fires = this.primed;
    this.seq = { t: 0, pan: fires ? 0.03 : -1, boom: fires && this.loaded && Math.random() >= this.misfire ? 0.03 + 0.11 + Math.random() * 0.09 : -1 };
    if (fires && this.loaded && this.seq.boom < 0) { this.msg = 'Flash in the pan! Press R to prime again'; this.msgT = 2.6; }
    this.primed = false;
  }

  runLock(dt) {
    const s = this.seq;
    const prev = s.t; s.t += dt;
    if (s.pan >= 0 && prev < s.pan && s.t >= s.pan) {
      this.panT = 0; this.audio.play('pan');
      this.panPuffs(3);
    }
    if (s.boom >= 0 && prev < s.boom && s.t >= s.boom) this.boom();
    if (s.t > Math.max(s.pan, s.boom) + 0.05) this.seq = null;
  }

  boom() {
    this.loaded = false;
    this.fireT = 0;
    const cam = this.mainCamera;
    const origin = cam.getWorldPosition(new THREE.Vector3());
    const fwd = cam.getWorldDirection(new THREE.Vector3());
    const right = _v.set(1, 0, 0).applyQuaternion(cam.quaternion), up = _v2.set(0, 1, 0).applyQuaternion(cam.quaternion);
    const moving = clamp(this.player.speed2D / CONFIG.player.walkSpeed);
    const cone = lerp(S.hipSpread, S.adsSpread, this.ads) + moving * 0.01 + (this.player.onGround ? 0 : 0.02);
    const a = Math.random() * Math.PI * 2, r = Math.sqrt(Math.random()) * cone;
    const dir = fwd.clone().addScaledVector(right, Math.cos(a) * r).addScaledVector(up, Math.sin(a) * r).normalize();
    const muzzle = this.muzzleWorld(new THREE.Vector3());
    this.onFire(origin, dir, muzzle, { energy: S.energy, impulse: S.impulse, speed: S.speed, range: S.range, life: 1.6, size: 1.3, glowSize: 0.05 });
    // a huge kick into the shoulder
    const adsMul = lerp(1, 0.8, this.ads);
    this.player.addRecoil(0.15 * adsMul * (0.9 + Math.random() * 0.2), (Math.random() - 0.4) * 0.035);
    this.player.addShake?.(0.45);
    this.kickBack.kick(3.6 * adsMul); this.kickRot.kick(12 * adsMul);
    this.kickSide.kick((Math.random() - 0.5) * 0.7); this.kickRoll.kick((Math.random() - 0.3) * 3.5);
    this.player.fovKick = 3.2;
    this.audio.play('musket');
    this.flash.material.rotation = Math.random() * Math.PI * 2;
    this.flash.scale.setScalar(0.3 + Math.random() * 0.12);
    this.flame.rotation.z = Math.random() * Math.PI;
    this.flame.scale.set(0.9 + Math.random() * 0.4, 0.9 + Math.random() * 0.5, 1);
    // the cloud: blasted out of the muzzle, then it hangs in the air for seconds
    const at = muzzle.clone().addScaledVector(dir, 0.15);
    for (let i = 0; i < 26; i++) {
      const k = i / 25;
      const v = dir.clone().multiplyScalar(lerp(16, 1.2, Math.sqrt(k)) * (0.7 + Math.random() * 0.6));
      v.x += (Math.random() - 0.5) * 1.6; v.y += (Math.random() - 0.25) * 1.3; v.z += (Math.random() - 0.5) * 1.6;
      this.smoke.puff(at, v, { size: 0.3 + Math.random() * 0.35, grow: 2.2 + Math.random() * 2, life: 5 + Math.random() * 3.5, opacity: 0.8 + Math.random() * 0.15, shade: 0.86 + Math.random() * 0.1 });
    }
    // a dense ball right at the muzzle
    for (let i = 0; i < 3; i++) this.smoke.puff(at, _v3.copy(dir).multiplyScalar(2 + i), { size: 0.5, grow: 2.6, life: 3.5, opacity: 0.95, shade: 0.95 });
    this.panPuffs(2);
  }

  /** Little puffs from the pan, off to the right of your face (kept small so they don't blind you). */
  panPuffs(n) {
    const cam = this.mainCamera;
    const pos = this.panWorld(new THREE.Vector3());
    const right = _v2.set(1, 0, 0).applyQuaternion(cam.quaternion);
    pos.addScaledVector(right, 0.12).addScaledVector(cam.getWorldDirection(_v3), 0.25);
    for (let i = 0; i < n; i++) {
      const v = right.clone().multiplyScalar(0.4 + Math.random() * 0.4); v.y += 0.45 + Math.random() * 0.3;
      this.smoke.puff(pos, v, { size: 0.04, grow: 0.35 + Math.random() * 0.2, life: 1.3 + Math.random() * 0.6, opacity: 0.5 });
    }
  }

  tryReload() {
    if (this.busy || this.sprint > 0.5) return;
    if (this.loaded && this.primed && this.cock === 'full') return;
    if (!this.loaded && !AMMO.has('ball')) { this.audio.play('dry'); return; }
    this.msgT = 0;
    this.anim.play(this.loaded ? CL.prime : CL.reload, this._ev);
  }

  onEvent(e, clip) {
    const a = this.audio;
    switch (e) {
      case 'halfCock': a.play('hammer'); this.cock = 'half'; break;
      case 'bite': a.play('paper'); break;
      case 'prime': a.play('powder'); this.primed = true; break;
      case 'frizzen': a.play('frizzen'); this.frizzenOpen = false; break;
      case 'pour': a.play('powder'); break;
      case 'ball': a.play('paper'); break;
      case 'ramrod': a.play('ramrod'); break;
      case 'ram': a.play('ramrod'); break;
      case 'ramTap': a.play('ramTap'); break;
      case 'fullCock': a.play('hammer'); this.cock = 'full'; break;
      case 'end':
        if (clip === CL.reload) { AMMO.take('ball', 1); this.loaded = true; this.primed = true; this.cock = 'full'; this.frizzenOpen = false; }
        else if (clip === CL.prime) { this.primed = true; this.cock = 'full'; this.frizzenOpen = false; }
        break;
    }
  }

  muzzleWorld(out = new THREE.Vector3()) {
    this.pivot.updateMatrixWorld(true);
    return viewmodelToWorld(this.gun.muzzle.getWorldPosition(_v), this.camera, this.mainCamera, out);
  }
  panWorld(out = new THREE.Vector3()) {
    this.pivot.updateMatrixWorld(true);
    return viewmodelToWorld(this.gun.panPoint.getWorldPosition(_v), this.camera, this.mainCamera, out);
  }

  animate(dt) {
    const g = this.gun, p = this.player, a = this.anim;
    const ft = this.fireT;
    // lock: the cock, the frizzen, the ramrod
    const fall = clamp(this.strikeT / 0.03);
    const cockNow = this.cock === 'down' ? lerp(COCK.full, COCK.down, fall) : COCK[this.cock];
    g.cock.rotation.x = a.clip?.tracks.cock ? a.sample('cock', cockNow) : cockNow;
    const frizNow = this.frizzenOpen ? (this.strikeT < 0.05 ? clamp(this.strikeT / 0.03) : 1) : 0;
    g.frizzen.rotation.x = -1.1 * (a.clip?.tracks.friz ? a.sample('friz', frizNow) : frizNow);
    g.trigger.rotation.x = 0.3 - (this.strikeT < 0.12 ? 0.22 : 0);
    const reload = a.clip === CL.reload;
    const inBore = reload && a.sample('rodMode', 0) > 0.5;
    if (inBore) {
      g.ramrod.rotation.y = Math.PI;
      g.ramrod.position.set(0, 0.026, a.sample('tipZ', -1) - 1.02);
    } else {
      g.ramrod.rotation.y = 0;
      g.ramrod.position.set(0, 0, reload ? -a.sample('d', 0) : 0);
    }
    if (reload) this.rodHand.position.set(0.016, inBore ? 0.004 : -0.022, -1.04 - a.sample('hz', 0));
    this.paper.visible = reload && a.sample('paper', 0) > 0.5;

    this.sparks.visible = this.strikeT < 0.05;
    if (this.sparks.visible) { this.sparks.material.rotation = Math.random() * 6; this.sparks.scale.setScalar(0.035 + Math.random() * 0.04); }
    const panOn = this.panT < 0.09;
    this.panFlash.visible = panOn;
    if (panOn) { const u = this.panT / 0.09; this.panFlash.scale.setScalar(0.07 + u * 0.12); this.panFlash.material.opacity = 1 - u; }
    const flashOn = ft < 0.06;
    this.flash.visible = flashOn;
    this.flame.visible = ft < 0.04;
    this.flash.material.opacity = flashOn ? 1 - ft / 0.06 * 0.5 : 0;
    this.flashLightVM.intensity = flashOn ? 6 : panOn ? 2 : 0;
    this.flashLightVM.position.set(flashOn ? 0.05 : 0.12, -0.02, flashOn ? -1.2 : -0.35);
    this.worldFlash.intensity = flashOn ? 140 * (1 - ft / 0.06) + 20 : panOn ? 12 : 0;
    if (flashOn || panOn) this.worldFlash.position.copy(this.mainCamera.position).addScaledVector(this.mainCamera.getWorldDirection(_v), flashOn ? 1.5 : 0.4);

    const sw = this.sway.update(dt, { ads: this.ads, heavy: 1.5, rate: 6.5 });
    const kb = this.kickBack.update(dt), kr = this.kickRot.update(dt), ks = this.kickSide.update(dt), kroll = this.kickRoll.update(dt);
    const pos = a.sample('pos', Z3), rot = a.sample('rot', Z3);
    const sp = this.sprint, dr = drawOffset(this.raise, this.drawing);
    const hip = S.hipPos, ads = S.adsPos;
    this.pivot.position.set(
      lerp(hip[0], ads[0], this.ads) + sw.x + sw.bobX + pos[0] - sp * 0.03 + ks * 0.004 + dr.x,
      lerp(hip[1], ads[1], this.ads) + sw.y + sw.bobY + sw.idle + pos[1] - sp * 0.04 - p.crouch * 0.01 + kr * 0.003 + dr.y,
      lerp(hip[2], ads[2], this.ads) + pos[2] + kb * 0.024 + sp * 0.03 + dr.z
    );
    this.pivot.rotation.set(
      rot[0] + kr * 0.05 - sp * 0.35 + sw.y * 1.5 + dr.rx + S.adsPitch * this.ads,
      rot[1] + lerp(0.014, 0, this.ads) + sp * 0.75 + sw.x * 1.5 + ks * 0.02,
      rot[2] + kroll * 0.02 + sw.x * 1.2 + sp * 0.2 + dr.rz,
      'YXZ'
    );
    const fov = W.weaponFov * lerp(1, 0.86, this.ads);
    if (Math.abs(this.camera.fov - fov) > 0.01) { this.camera.fov = fov; this.camera.updateProjectionMatrix(); }

    // ---- hands: right on the wrist of the stock (or busy loading), left under the forestock ----
    this.pivot.updateMatrixWorld(true);
    const right = sampleHand(a.clip?.rh || [[0, 'grip']], a.time, this.handTargets, _v2);
    this.arms.set('right', right, { roll: 0.2 });
    this.arms.setOn('left', g.foreHand, { roll: -0.2 });
  }
}
