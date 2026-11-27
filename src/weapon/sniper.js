import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { clamp, damp, Spring, lerp, viewmodelToWorld, drawOffset } from '../core/util.js';
import { buildSniper, buildRound } from './modelRifles.js';
import { muzzleFlashTexture, flameTexture } from './model1911.js';
import { Clip, ClipPlayer } from './anim.js';
import { Casings } from './casings.js';
import { BlockArms, sampleHand, anchorPos } from './arms.js';
import { viewmodelScene, Sway } from './viewmodel.js';

const W = CONFIG.weapon;
const S = {
  mag: 5,                    // detachable box magazine (+1 in the chamber)
  energy: 3.3,               // .308: goes through a body (or two) and most armour
  impulse: W.impulse * 1.7,
  speed: 820,
  range: 900,
  hipSpread: 0.03,           // shooting from the hip with a scoped rifle is a guess
  hipPos: [0.15, -0.165, -0.38],
  adsPos: [0, -0.102, -0.15],  // scope eyepiece right in front of the eye
  gripOffset: [0, 0.05, -0.06],
  zooms: [4, 6, 8, 12],
  holdTime: 4,               // seconds you can hold your breath
};
const Z3 = [0, 0, 0];
const B_ROT = [0.03, -0.02, 0.16];                                       // canted a little so the bolt shows
const R_POS = [-0.05, 0.05, 0.03], R_ROT = [0.2, 0.15, -0.55];           // rolled so the magazine well faces you

const CL = {
  bolt: new Clip('bolt', 0.95, {
    pos: [[0, Z3], [0.14, [0.008, -0.01, 0.012]], [0.42, [0.014, -0.014, 0.024]], [0.76, [0.006, -0.006, 0.008]], [0.95, Z3]],
    rot: [[0, Z3], [0.14, B_ROT], [0.42, [B_ROT[0] + 0.03, B_ROT[1], B_ROT[2] + 0.05]], [0.76, B_ROT], [0.95, Z3]],
    lift: [[0, 0], [0.14, 0], [0.25, 1], [0.6, 1], [0.7, 0]],
    slide: [[0, 0], [0.27, 0], [0.4, 1], [0.46, 1], [0.58, 0]],
  }, [[0.2, 'boltUp'], [0.37, 'boltBack'], [0.55, 'boltFwd'], [0.68, 'boltDown']]),
  reload: new Clip('reload', 1.6, {
    pos: [[0, Z3], [0.28, R_POS], [1.2, R_POS], [1.24, [R_POS[0], R_POS[1] + 0.01, R_POS[2]]], [1.32, R_POS], [1.56, Z3]],
    rot: [[0, Z3], [0.28, R_ROT], [1.2, R_ROT], [1.24, [R_ROT[0] + 0.04, R_ROT[1], R_ROT[2] - 0.03]], [1.32, R_ROT], [1.56, Z3]],
    // 0 = in the rifle, 1 = in the left hand, 2 = hidden (swapped at the pouch)
    magMode: [[0, 0], [0.34, 0], [0.341, 1], [0.6, 1], [0.601, 1], [1.17, 1], [1.171, 0]],
  }, [[0.34, 'magOut'], [0.62, 'magSwap'], [1.17, 'magIn']]),
  inspect: new Clip('inspect', 2.8, {
    pos: [[0, Z3], [0.45, [-0.07, 0.04, 0.06]], [1.2, [-0.065, 0.045, 0.06]], [1.55, [-0.04, 0.03, 0.05]], [2.3, [-0.04, 0.03, 0.05]], [2.75, Z3]],
    rot: [[0, Z3], [0.45, [0.1, 0.7, 0.25]], [1.2, [0.14, 0.78, 0.2]], [1.55, [0.05, -0.3, 0.35]], [2.3, [0.05, -0.28, 0.32]], [2.75, Z3]],
    lift: [[0, 0], [1.7, 0], [1.8, 1], [2.15, 1], [2.25, 0]],
    slide: [[0, 0], [1.82, 0], [1.92, 0.25], [2.06, 0.25], [2.14, 0]],
  }, [[1.76, 'boltUp'], [1.9, 'boltCheck'], [2.12, 'boltFwd'], [2.24, 'boltDown']]),
};
// hand tracks (named targets): the right hand works the bolt, the left swaps magazines
CL.bolt.rh = [[0, 'grip'], [0.13, 'knob'], [0.72, 'knob'], [0.9, 'grip']];
CL.bolt.lh = [[0, 'fore']];
CL.reload.lh = [[0, 'fore'], [0.32, 'mag'], [0.36, 'mag'], [0.6, 'pouch'], [0.7, 'pouch'], [1.02, 'magBelow'], [1.17, 'mag'], [1.22, 'mag'], [1.5, 'fore']];
CL.reload.rh = [[0, 'grip']];
CL.inspect.lh = [[0, 'fore']];
CL.inspect.rh = [[0, 'grip'], [1.6, 'grip'], [1.74, 'knob'], [2.26, 'knob'], [2.42, 'grip']];

const _v = new THREE.Vector3(), _v2 = new THREE.Vector3(), _v3 = new THREE.Vector3(), _h = new THREE.Vector3();

/** The DOM scope overlay (black ring, mil-dot reticle, zoom and breath readouts). */
function scopeOverlay() {
  let el = document.getElementById('scope');
  if (el) return el;
  el = document.createElement('div');
  el.id = 'scope';
  el.className = 'hidden';
  const dots = [];
  for (const s of [-1, 1]) for (let i = 1; i <= 4; i++) { const d = s * i * 9; dots.push(`<circle cx="${d}" cy="0" r="1"/><circle cx="0" cy="${d}" r="1"/>`); }
  const ticks = [];
  for (let i = 1; i <= 4; i++) { const y = i * 9 + 4.5; ticks.push(`<path d="M-2.2 ${y}H2.2"/>`); }
  el.innerHTML = `<div class="sc-ring"></div>
    <svg class="sc-ret" viewBox="-100 -100 200 200" aria-hidden="true">
      <g stroke="#000" fill="none"><path d="M-100 0H-44M44 0H100M0 44V100M0 -100V-44" stroke-width="3"/>
      <path d="M-44 0H44M0 -44V44" stroke-width="0.45"/><g stroke-width="0.5">${ticks.join('')}</g></g>
      <g fill="#000">${dots.join('')}</g>
      <circle r="0.7" fill="#c3182a"/>
    </svg>
    <div class="sc-info"><b class="sc-zoom">8×</b><div class="sc-breath"><i></i></div><span class="sc-hint">Scroll: zoom · Shift: hold breath</span></div>`;
  document.body.appendChild(el);
  return el;
}

/**
 * Bolt-action sniper rifle (.308, 5-round box magazine). The bolt is worked after every shot (by
 * itself), which takes you off the scope for a moment. Right click looks through the 4–12× scope:
 * scroll to zoom, Shift to hold your breath and steady the drift.
 */
export class Sniper {
  constructor({ mainScene, mainCamera, player, audio, environment, onFire }) {
    this.name = 'M24 Sniper';
    this.short = 'Sniper';
    this.player = player; this.audio = audio; this.mainCamera = mainCamera; this.onFire = onFire;
    const vm = viewmodelScene(environment);
    this.scene = vm.scene; this.camera = vm.camera;
    this.flashLightVM = new THREE.PointLight(0xffb060, 0, 1.8, 2); this.scene.add(this.flashLightVM);

    this.pivot = new THREE.Group(); this.scene.add(this.pivot);
    this.gun = buildSniper();
    this.gun.root.position.set(...S.gripOffset);
    this.pivot.add(this.gun.root);
    this.materials = this.gun.materials;

    // flash: the brake throws it out to the sides
    this.flash = new THREE.Sprite(new THREE.SpriteMaterial({ map: muzzleFlashTexture(), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }));
    this.flash.scale.setScalar(0.2); this.flash.position.set(0, 0, -0.06); this.flash.visible = false;
    this.gun.muzzle.add(this.flash);
    const flameMat = new THREE.MeshBasicMaterial({ map: flameTexture(), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, side: THREE.DoubleSide });
    const sideGeo = new THREE.PlaneGeometry(0.06, 0.22).translate(0, 0.11, 0);
    this.flame = new THREE.Group();
    for (const s of [-1, 1]) { const m = new THREE.Mesh(sideGeo, flameMat); m.rotation.z = -s * Math.PI / 2; m.position.z = 0.04; this.flame.add(m); }
    const fwd = new THREE.Mesh(new THREE.PlaneGeometry(0.07, 0.26).translate(0, 0.13, 0).rotateX(-Math.PI / 2), flameMat); this.flame.add(fwd);
    this.flame.visible = false;
    this.gun.muzzle.add(this.flame);

    // the magazine (a child of the rifle, moved into the left hand while reloading)
    this.mag = new THREE.Group();
    const magMat = new THREE.MeshStandardMaterial({ color: 0x1a1b1d, metalness: 0.7, roughness: 0.5 });
    const body = new THREE.Mesh(new THREE.BoxGeometry(0.026, 0.07, 0.078), magMat); body.position.y = -0.035; this.mag.add(body);
    const base = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.008, 0.084), magMat); base.position.y = -0.072; this.mag.add(base);
    const top = buildRound(); top.position.set(0, 0.002, 0.004); this.mag.add(top); this.magTop = top;
    this.magSeat = new THREE.Vector3(0, -0.018, -0.1);
    this.mag.position.copy(this.magSeat);
    this.gun.root.add(this.mag);
    this.mag.traverse((o) => { o.castShadow = false; });

    this.arms = new BlockArms(this.scene, { handSize: 0.062 });
    const magHand = new THREE.Object3D(); magHand.position.set(0, -0.098, -0.1); this.gun.root.add(magHand);
    const magBelow = new THREE.Object3D(); magBelow.position.set(-0.01, -0.17, -0.08); this.gun.root.add(magBelow);
    this.handTargets = {
      grip: () => anchorPos(this.gun.gripPoint, _h),
      knob: () => anchorPos(this.gun.boltKnob, _h).add(_v3.set(0.012, -0.004, 0.01)),
      fore: () => anchorPos(this.gun.foreHand, _h),
      mag: () => anchorPos(magHand, _h),
      magBelow: () => anchorPos(magBelow, _h),
      pouch: new THREE.Vector3(-0.16, -0.42, -0.18),
    };

    this.worldFlash = new THREE.PointLight(0xffa850, 0, 14, 2);
    mainScene.add(this.worldFlash);
    this.casings = new Casings(mainScene, null, audio, { build: () => buildRound(), sound: 'casing', rest: 0.006 });
    this.overlay = scopeOverlay();
    this.ui = { zoom: this.overlay.querySelector('.sc-zoom'), breath: this.overlay.querySelector('.sc-breath i'), hint: this.overlay.querySelector('.sc-hint') };

    // ---- state ----
    this.ammoMag = S.mag;
    this.chamber = 'live';     // 'live' | 'spent' | null
    this.raise = 0; this.drawing = true;
    this.ads = 0; this.sprint = 0;
    this.fireT = 99; this.cooldown = 0;
    this.anim = new ClipPlayer();
    this.boltQueued = -1;
    this.zoomI = 2;
    this.breath = S.holdTime; this.holding = false; this.winded = 0;
    this.swayT = Math.random() * 10; this.aimX = 0; this.aimY = 0;
    this.scoped = false; this.ownsFov = false;
    this.kickBack = new Spring(220, 14); this.kickRot = new Spring(190, 12); this.kickSide = new Spring(200, 16); this.kickRoll = new Spring(200, 16);
    this.sway = new Sway(player);
    this._ev = (e, c) => this.onEvent(e, c);
  }

  get busy() { return this.anim.playing || this.boltQueued >= 0; }
  get state() { return this.anim.clip ? this.anim.clip.name : 'idle'; }
  get zoom() { return S.zooms[this.zoomI]; }
  /** Scroll zooms the scope instead of switching items. */
  get wheelLock() { return this.scoped; }
  resize(aspect) { this.camera.aspect = aspect; this.camera.updateProjectionMatrix(); }
  refill() {}

  get controls() {
    return [['Left click', 'Fire (works the bolt by itself)'], ['Right click', 'Scope'], ['Scroll / F', this.scoped ? 'Zoom (4×–12×)' : 'Zoom while scoped'], ['Shift', 'Hold breath while scoped'], ['R', 'Change magazine'], ['F', 'Inspect']];
  }
  status() { return null; }
  ammo() {
    return { mag: this.ammoMag, chamber: this.chamber === 'live' ? '+1' : '+0', reserve: '∞', name: 'M24 · 7.62 mm', low: this.ammoMag === 0 && this.chamber !== 'live' };
  }
  crosshair() { return { gap: 22 + Math.max(0, 0.3 - this.fireT) * 70, ads: this.ads > 0.6 }; }

  update(dt, input, active, worldDt = dt) {
    const p = this.player;
    active = active && this.raise > 0.9;
    this.cooldown -= dt; this.fireT += dt;
    const st = this.state;
    const boltOpen = st === 'bolt' || st === 'reload' || this.boltQueued >= 0 && this.boltQueued < 0.12;
    const wantAds = active && input.mouseDown[2] && !boltOpen && st !== 'inspect' && !p.sprinting;
    this.ads += ((wantAds ? 1 : 0) - this.ads) * damp(wantAds ? 10 : 16, dt);
    this.scoped = this.ads > 0.9 && wantAds;
    if (this.raise > 0) {
      p.aiming = this.ads > 0.5;
      p.aimFov = this.scoped ? 1 / this.zoom : 0.85;
      this.ownsFov = true;
    } else if (this.ownsFov) { p.aimFov = undefined; this.ownsFov = false; }
    this.sprint += ((p.sprinting && st !== 'reload' ? 1 : 0) - this.sprint) * damp(8, dt);

    if (active) {
      if (input.mousePressed[0]) this.tryFire();
      if (input.wasPressed('KeyR')) this.tryReload();
      if (this.scoped && (input.wheel || input.wasPressed('KeyF'))) {
        const n = input.wheel ? (input.wheel < 0 ? 1 : -1) : 1;
        const was = this.zoomI;
        this.zoomI = input.wheel ? clamp(this.zoomI + n, 0, S.zooms.length - 1) : (this.zoomI + 1) % S.zooms.length;
        if (was !== this.zoomI) this.audio.play('scope');
      } else if (input.wasPressed('KeyF') && !this.busy && !this.scoped) this.anim.play(CL.inspect, this._ev);
    }
    if (this.boltQueued >= 0) {
      this.boltQueued -= dt;
      if (this.boltQueued < 0 && !this.anim.playing) this.anim.play(CL.bolt, this._ev);
      else if (this.boltQueued < 0) this.boltQueued = 0;
    }
    this.breathe(dt, input);
    this.anim.update(dt);
    this.animate(dt);
    this.updateOverlay();
    this.casings.update(worldDt);
  }

  /**
   * Scope drift: a slow figure-eight that moves the actual aim (not just the picture). Moving makes
   * it worse, crouching steadies it, Shift holds your breath for a few seconds (then you gasp).
   */
  breathe(dt, input) {
    const p = this.player;
    this.swayT += dt;
    const wantHold = this.scoped && input.isDown('ShiftLeft') && this.winded <= 0 && this.breath > 0;
    if (wantHold && !this.holding) this.audio.play('breath', { hold: true });
    if (!wantHold && this.holding) this.audio.play('breath', { hold: false, gasp: this.breath < 0.3 });
    this.holding = wantHold;
    if (this.holding) {
      this.breath -= dt;
      if (this.breath <= 0) { this.winded = 2.5; this.holding = false; this.audio.play('breath', { hold: false, gasp: true }); }
    } else {
      this.winded = Math.max(0, this.winded - dt);
      this.breath = Math.min(S.holdTime, this.breath + dt * 0.8);
    }
    let amp = 0;
    if (this.scoped) {
      const moving = clamp(p.speed2D / CONFIG.player.walkSpeed);
      amp = 0.0042 * (1 + moving * 2.6) * (p.crouch > 0.5 ? 0.6 : 1) * (this.holding ? 0.12 : 1) * (this.winded > 0 ? 1.8 : 1);
    }
    const t = this.swayT * (this.winded > 0 ? 1.9 : 1);
    const tx = Math.sin(t * 0.9) * amp + Math.sin(t * 2.3 + 1.1) * amp * 0.25;
    const ty = Math.sin(t * 1.8) * amp * 0.6 + Math.cos(t * 0.7) * amp * 0.3;
    const k = damp(this.scoped ? 6 : 10, dt);
    const nx = this.aimX + (tx - this.aimX) * k, ny = this.aimY + (ty - this.aimY) * k;
    p.yaw += nx - this.aimX; p.pitch += ny - this.aimY;
    this.aimX = nx; this.aimY = ny;
  }

  updateOverlay() {
    const on = this.raise > 0 && this.scoped;
    if (on !== this.overlayOn) { this.overlayOn = on; this.overlay.classList.toggle('hidden', !on); document.body.classList.toggle('scoped', on); if (on) this.audio.play('scope'); }
    if (!on) return;
    this.ui.zoom.textContent = `${this.zoom}×`;
    this.ui.breath.style.transform = `scaleX(${(this.breath / S.holdTime).toFixed(3)})`;
    this.ui.breath.parentElement.classList.toggle('winded', this.winded > 0);
    this.ui.hint.textContent = this.isTouch?.() ? 'Zoom button: zoom · Breath button: hold breath' : 'Scroll: zoom · Shift: hold breath';
    // the eye box wobbles a little with the gun
    const sx = (this.sway.x * 900).toFixed(1), sy = (-this.sway.y * 900 + this.kickRot.x * 6).toFixed(1);
    this.overlay.style.setProperty('--sx', `${sx}px`);
    this.overlay.style.setProperty('--sy', `${sy}px`);
  }

  tryFire() {
    if (this.busy) { if (this.state === 'inspect') this.anim.stop(); else return; }
    if (this.cooldown > 0 || this.sprint > 0.5) return;
    if (this.chamber !== 'live') {
      this.audio.play('dry'); this.cooldown = 0.3;
      if (this.chamber === 'spent' || this.ammoMag > 0) this.boltQueued = 0.05;
      return;
    }
    this.chamber = 'spent';
    this.fireT = 0; this.cooldown = 0.25;
    const cam = this.mainCamera;
    const origin = cam.getWorldPosition(new THREE.Vector3());
    const dir = cam.getWorldDirection(new THREE.Vector3());
    if (!this.scoped) {
      // no sights: somewhere near the middle of the screen
      const right = _v.set(1, 0, 0).applyQuaternion(cam.quaternion), up = _v2.set(0, 1, 0).applyQuaternion(cam.quaternion);
      const a = Math.random() * Math.PI * 2, r = Math.sqrt(Math.random()) * lerp(S.hipSpread, S.hipSpread * 0.4, this.ads);
      dir.addScaledVector(right, Math.cos(a) * r).addScaledVector(up, Math.sin(a) * r).normalize();
    }
    const muzzle = this.muzzleWorld(new THREE.Vector3());
    this.onFire(origin, dir, muzzle, { energy: S.energy, impulse: S.impulse, speed: S.speed, range: S.range, life: 2.2, size: 1.25, glowSize: 0.09 });
    const scopeMul = this.scoped ? 0.55 : 1;
    this.player.addRecoil(0.075 * scopeMul * (0.9 + Math.random() * 0.2), (Math.random() - 0.45) * 0.02);
    this.player.addShake?.(this.scoped ? 0.35 : 0.2);
    this.kickBack.kick(3.2); this.kickRot.kick(10);
    this.kickSide.kick((Math.random() - 0.5) * 0.5); this.kickRoll.kick((Math.random() - 0.3) * 2.5);
    this.player.fovKick = this.scoped ? 0 : 2.6;
    this.audio.play('sniper');
    this.flash.material.rotation = Math.random() * Math.PI * 2;
    this.flash.scale.setScalar(0.17 + Math.random() * 0.08);
    this.flame.rotation.z = (Math.random() - 0.5) * 0.4;
    this.flame.scale.set(0.9 + Math.random() * 0.3, 0.8 + Math.random() * 0.5, 1);
    this.boltQueued = 0.38;
  }

  tryReload() {
    if (this.busy || this.sprint > 0.5) return;
    if (this.ammoMag >= S.mag) { if (this.chamber !== 'live') this.boltQueued = 0; return; }
    this.anim.play(CL.reload, this._ev);
  }

  onEvent(e, clip) {
    switch (e) {
      case 'boltUp': this.audio.play('boltUp'); break;
      case 'boltBack':
        this.audio.play('boltBack');
        if (this.chamber) { this.eject(this.chamber === 'live'); this.chamber = null; }
        break;
      case 'boltCheck': this.audio.play('boltBack', { soft: true }); break;
      case 'boltFwd':
        this.audio.play('boltFwd');
        if (clip !== CL.inspect && this.ammoMag > 0 && !this.chamber) { this.ammoMag--; this.chamber = 'live'; }
        break;
      case 'boltDown': this.audio.play('boltDown'); break;
      case 'magOut': this.audio.play('magOut'); break;
      case 'magSwap': this.ammoMag = S.mag; break;
      case 'magIn': this.audio.play('magIn'); break;
      case 'end':
        if (clip === CL.reload && this.chamber !== 'live') this.boltQueued = 0.05;
        break;
    }
  }

  eject(live) {
    const cam = this.mainCamera;
    this.pivot.updateMatrixWorld(true);
    const pos = anchorPos(this.gun.ejectPort, new THREE.Vector3()).applyMatrix4(cam.matrixWorld);
    const vel = new THREE.Vector3(1.8 + Math.random() * 0.7, 1.4 + Math.random() * 0.7, 0.3 + Math.random() * 0.4).applyQuaternion(cam.quaternion);
    vel.x += this.player.vel.x; vel.z += this.player.vel.z;
    this.casings.spawn(pos, vel);
    const c = this.casings.list[this.casings.list.length - 1].mesh;
    c.quaternion.copy(cam.quaternion);
    c.children[c.children.length - 2].visible = live; // a spent case has no bullet
  }

  muzzleWorld(out = new THREE.Vector3()) {
    this.pivot.updateMatrixWorld(true);
    return viewmodelToWorld(this.gun.muzzle.getWorldPosition(_v), this.camera, this.mainCamera, out);
  }

  animate(dt) {
    const g = this.gun, p = this.player, a = this.anim;
    const ft = this.fireT;
    // bolt: lift the handle (rotate about the bore), then pull it back 9 cm
    g.handle.rotation.z = a.sample('lift', 0) * 1.25;
    g.bolt.position.z = a.sample('slide', 0) * 0.09;
    g.trigger.rotation.x = 0.25 - (ft < 0.1 ? 0.2 : 0);
    this.magTop.visible = this.ammoMag > 0 || this.state === 'reload' && a.time > 0.62;

    const flashOn = ft < 0.045;
    this.flash.visible = flashOn && !this.scoped;
    this.flame.visible = ft < 0.03 && !this.scoped;
    this.flash.material.opacity = flashOn ? 1 - ft / 0.045 * 0.5 : 0;
    this.flashLightVM.intensity = flashOn ? 4 : 0;
    this.flashLightVM.position.set(0.05, -0.02, -0.9);
    this.worldFlash.intensity = flashOn ? 110 * (1 - ft / 0.045) + 15 : 0;
    if (flashOn) this.worldFlash.position.copy(this.mainCamera.position).addScaledVector(this.mainCamera.getWorldDirection(_v), 1.2);

    const sw = this.sway.update(dt, { ads: this.ads, heavy: 1.35, rate: 7 });
    const kb = this.kickBack.update(dt), kr = this.kickRot.update(dt), ks = this.kickSide.update(dt), kroll = this.kickRoll.update(dt);
    const pos = a.sample('pos', Z3), rot = a.sample('rot', Z3);
    const sp = this.sprint, dr = drawOffset(this.raise, this.drawing);
    const hip = S.hipPos, ads = S.adsPos;
    this.pivot.position.set(
      lerp(hip[0], ads[0], this.ads) + sw.x + sw.bobX + pos[0] - sp * 0.03 + ks * 0.004 + dr.x,
      lerp(hip[1], ads[1], this.ads) + sw.y + sw.bobY + sw.idle + pos[1] - sp * 0.04 - p.crouch * 0.01 + kr * 0.003 + dr.y,
      lerp(hip[2], ads[2], this.ads) + pos[2] + kb * 0.022 + sp * 0.03 + dr.z
    );
    this.pivot.rotation.set(
      rot[0] + kr * 0.05 - sp * 0.35 + sw.y * 1.5 + dr.rx,
      rot[1] + lerp(0.015, 0, this.ads) + sp * 0.75 + sw.x * 1.5 + ks * 0.02,
      rot[2] + kroll * 0.02 + sw.x * 1.2 + sp * 0.2 + dr.rz,
      'YXZ'
    );
    const fov = W.weaponFov * lerp(1, 0.85, this.ads);
    if (Math.abs(this.camera.fov - fov) > 0.01) { this.camera.fov = fov; this.camera.updateProjectionMatrix(); }

    // looking through the scope: the rifle itself is out of the picture
    const show = !this.scoped;
    this.pivot.visible = show;
    if (!show) { this.arms.hide(); return; }

    // ---- hands ----
    this.pivot.updateMatrixWorld(true);
    const right = sampleHand(a.clip?.rh || [[0, 'grip']], a.time, this.handTargets, _v2);
    this.arms.set('right', right, { roll: 0.2 });
    const left = sampleHand(a.clip?.lh || [[0, 'fore']], a.time, this.handTargets, _v3);
    this.arms.set('left', left, { roll: -0.2 });
    // magazine: in the rifle, or carried by the left hand
    const inHand = a.clip === CL.reload && Math.round(a.sample('magMode', 0)) === 1;
    if (inHand) {
      g.root.worldToLocal(_v.copy(left));
      this.mag.position.set(_v.x, _v.y + 0.08, _v.z);
    } else this.mag.position.copy(this.magSeat);
  }
}
