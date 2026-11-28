import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { clamp, damp, Spring, lerp, viewmodelToWorld, drawOffset } from '../core/util.js';
import { muzzleFlashTexture, flameTexture } from './model1911.js';
import { Clip, ClipPlayer } from './anim.js';
import { Casings } from './casings.js';
import { BlockArms, sampleHand, anchorPos } from './arms.js';
import { viewmodelScene, Sway } from './viewmodel.js';
import { buildRifle, buildSMG, buildCombatShotgun, buildSmallCasing } from './modelAuto.js';
import { AMMO } from './ammo.js';

const W = CONFIG.weapon;
const Z3 = [0, 0, 0];

/**
 * The VS Undead guns (only sold by the merchant and found in supply drops):
 *  - Assault rifle: full auto, 30 rounds of 5.56, hits hard and goes through bodies.
 *  - Submachine gun: very fast full auto, 32 rounds of .45 (the pistol's ammo), light recoil.
 *  - Combat shotgun: semi-automatic, 8 shells in a box magazine, 8 pellets a shot.
 */
export const AUTO_GUNS = {
  rifle: {
    name: 'Assault Rifle', short: 'Rifle', build: buildRifle, ammo: 'rifle', ammoName: '5.56 mm', mag: 30, rpm: 690, auto: true,
    energy: 1.3, impulse: 12, speed: 900, range: 160, size: 1.05, glow: 0.075,
    hip: 0.03, ads: 0.0035, recoil: [0.022, 0.009], kick: 1.1, sound: 'rifle', reload: 2.1,
    hipPos: [0.13, -0.17, -0.46], adsZ: -0.26, sightY: 0.1, grip: [0, 0.03, -0.03], fov: 0.8,
    casing: () => buildSmallCasing(0.045, 0.0046),
  },
  smg: {
    name: 'Submachine Gun', short: 'SMG', build: buildSMG, ammo: 'pistol', ammoName: '.45 ACP', mag: 32, rpm: 900, auto: true,
    energy: 0.92, impulse: 9, speed: 280, range: 110, size: 0.9, glow: 0.07,
    hip: 0.038, ads: 0.009, recoil: [0.014, 0.012], kick: 0.75, sound: 'smg', reload: 1.8,
    hipPos: [0.13, -0.17, -0.42], adsZ: -0.26, sightY: 0.093, grip: [0, 0.03, -0.03], fov: 0.86,
    casing: () => buildSmallCasing(0.028, 0.0058),
  },
  autoshotgun: {
    name: 'Combat Shotgun', short: 'Combat SG', build: buildCombatShotgun, ammo: 'shells', ammoName: '12 gauge', mag: 8, rpm: 260, auto: false,
    pellets: 8, energy: 0.58, impulse: 3.4, speed: 380, range: 70, size: 0.55, glow: 0.04,
    hip: 0.055, ads: 0.04, recoil: [0.09, 0.025], kick: 2.2, sound: 'autoshotgun', reload: 2.3,
    hipPos: [0.14, -0.18, -0.48], adsZ: -0.3, sightY: 0.095, grip: [0, 0.03, -0.035], fov: 0.86,
    casing: null,
  },
};

const R_POS = [-0.05, 0.06, 0.03], R_ROT = [0.25, 0.15, -0.45];
function reloadClips(dur) {
  const k = dur / 2.1;
  const T = (x) => x * k;
  const tracks = (empty) => ({
    pos: [[0, Z3], [T(0.25), R_POS], [T(1.25), R_POS], [T(1.32), [R_POS[0], R_POS[1] + 0.012, R_POS[2]]], [T(1.42), R_POS], ...(empty ? [[T(1.62), [-0.03, 0.04, 0.03]], [T(1.72), [-0.03, 0.04, 0.05]]] : []), [T(empty ? 2.0 : 1.75), Z3]],
    rot: [[0, Z3], [T(0.25), R_ROT], [T(1.25), R_ROT], [T(1.32), [R_ROT[0] + 0.05, R_ROT[1], R_ROT[2]]], [T(1.42), R_ROT], [T(empty ? 2.0 : 1.75), Z3]],
    // the magazine: 0 home, 1 a hand's length below, 2 gone (dropped)
    mag: [[0, 0], [T(0.38), 0], [T(0.5), 1], [T(0.56), 2], [T(0.85), 2], [T(0.95), 1], [T(1.25), 0.15], [T(1.3), 0]],
    bolt: empty ? [[0, 0], [T(1.6), 0], [T(1.68), 1], [T(1.76), 0]] : [[0, 0]],
  });
  const ev = (empty) => [[T(0.45), 'magOut'], [T(1.3), 'magIn'], ...(empty ? [[T(1.68), 'bolt']] : [])];
  const reload = new Clip('reload', T(1.85), tracks(false), ev(false));
  const reloadEmpty = new Clip('reloadEmpty', T(2.1), tracks(true), ev(true));
  for (const c of [reload, reloadEmpty]) c.lh = [[0, 'support'], [T(0.3), 'mag'], [T(0.5), 'magLow'], [T(0.62), 'pouch'], [T(0.9), 'pouch'], [T(1.0), 'magLow'], [T(1.28), 'mag'], [T(1.4), 'support']];
  reloadEmpty.lh = [...reload.lh.slice(0, -1), [T(1.45), 'bolt'], [T(1.62), 'bolt'], [T(1.7), 'boltBack'], [T(1.95), 'support']];
  return { reload, reloadEmpty };
}

const _v = new THREE.Vector3(), _v2 = new THREE.Vector3(), _h = new THREE.Vector3();

export class AutoGun {
  constructor(kind, { mainScene, mainCamera, player, audio, environment, onFire }) {
    const S = this.S = AUTO_GUNS[kind];
    this.kind = kind;
    this.name = S.name; this.short = S.short;
    this.vsOnly = true;
    this.player = player; this.audio = audio; this.mainCamera = mainCamera; this.onFire = onFire;
    const vm = viewmodelScene(environment);
    this.scene = vm.scene; this.camera = vm.camera;
    this.flashLightVM = new THREE.PointLight(0xffb060, 0, 1.6, 2); this.scene.add(this.flashLightVM);
    this.pivot = new THREE.Group(); this.scene.add(this.pivot);
    this.gun = S.build();
    this.gun.root.position.set(...S.grip);
    this.pivot.add(this.gun.root);
    this.adsPos = [0, -(S.grip[1] + S.sightY), S.adsZ];

    this.flash = new THREE.Sprite(new THREE.SpriteMaterial({ map: muzzleFlashTexture(), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }));
    this.flash.scale.setScalar(0.12); this.flash.position.set(0, 0, -0.04); this.flash.visible = false;
    this.gun.muzzle.add(this.flash);
    const flameMat = new THREE.MeshBasicMaterial({ map: flameTexture(), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, side: THREE.DoubleSide });
    const flameGeo = new THREE.PlaneGeometry(0.06, 0.16).translate(0, 0.08, 0).rotateX(-Math.PI / 2);
    this.flame = new THREE.Group();
    for (let i = 0; i < 3; i++) { const m = new THREE.Mesh(flameGeo, flameMat); m.rotation.z = (i / 3) * Math.PI; this.flame.add(m); }
    this.flame.visible = false;
    this.gun.muzzle.add(this.flame);

    this.arms = new BlockArms(this.scene, { handSize: 0.06 });
    this.handMag = this.gun.mag.clone(true);
    this.handMag.visible = false;
    this.scene.add(this.handMag);
    this.handTargets = {
      support: () => anchorPos(this.gun.supportPoint, _h),
      mag: () => anchorPos(this.gun.magPoint, _h),
      magLow: () => anchorPos(this.gun.magPoint, _h).add(_v.set(-0.02, -0.08, 0.02)),
      pouch: new THREE.Vector3(-0.16, -0.4, -0.2),
      bolt: () => anchorPos(this.gun.bolt, _h).add(_v.set(0.012, 0, 0)),
      boltBack: () => anchorPos(this.gun.bolt, _h).add(_v.set(0.012, 0, 0.06)),
    };
    this.clips = reloadClips(S.reload);
    this.worldFlash = new THREE.PointLight(0xffa850, 0, 10, 2);
    mainScene.add(this.worldFlash);
    this.casings = S.casing ? new Casings(mainScene, null, audio, { build: S.casing, rest: 0.005 }) : null;

    this.mag = S.mag; this.chambered = true;
    this.raise = 0; this.drawing = true;
    this.ads = 0; this.sprint = 0;
    this.fireT = 99; this.cooldown = 0; this.burst = 0;
    this.anim = new ClipPlayer();
    this.kickBack = new Spring(300, 18); this.kickRot = new Spring(240, 15); this.kickSide = new Spring(220, 17); this.kickRoll = new Spring(220, 17);
    this.sway = new Sway(player);
    this._ev = (e, c) => this.onEvent(e, c);
  }

  get busy() { return this.anim.playing; }
  get state() { return this.anim.clip ? this.anim.clip.name : 'idle'; }
  resize(aspect) { this.camera.aspect = aspect; this.camera.updateProjectionMatrix(); }
  refill() { this.mag = this.S.mag; this.chambered = true; }

  get controls() {
    return [['Left click', this.S.auto ? 'Fire (hold for full auto)' : 'Fire'], ['Right click', 'Aim down sights'], ['R', 'Reload']];
  }
  status() { return null; }
  ammo() {
    const S = this.S;
    return { mag: this.mag, chamber: this.chambered ? '+1' : '+0', reserve: AMMO.label(S.ammo), name: `${S.name} · ${S.ammoName}`, low: this.mag <= Math.ceil(S.mag * 0.15) };
  }
  crosshair() { return { gap: 10 + Math.min(14, this.burst * 1.6) + Math.max(0, 0.15 - this.fireT) * 40, ads: this.ads > 0.6 }; }

  update(dt, input, active, worldDt = dt) {
    const p = this.player, S = this.S;
    active = active && this.raise > 0.9;
    this.cooldown = Math.max(this.cooldown - dt, -dt); this.fireT += dt;
    if (this.fireT > 0.25) this.burst = Math.max(0, this.burst - dt * 12);
    const reloading = this.state.startsWith('reload');
    const wantAds = active && input.mouseDown[2] && !reloading && !p.sprinting;
    this.ads += ((wantAds ? 1 : 0) - this.ads) * damp(13, dt);
    if (this.raise > 0) { p.aiming = this.ads > 0.5; p.aimFov = S.fov; this.ownsFov = true; }
    else if (this.ownsFov) { p.aimFov = undefined; this.ownsFov = false; }
    this.sprint += ((p.sprinting && !reloading ? 1 : 0) - this.sprint) * damp(8, dt);
    if (active) {
      const trig = S.auto ? input.mouseDown[0] : input.mousePressed[0];
      if (trig) {
        this.tryFire(input.mousePressed[0]);
        // full auto at a low frame rate: the rounds that were due this frame
        for (let n = 0; S.auto && n < 3 && this.cooldown <= 0 && this.chambered && !this.busy; n++) this.tryFire(false);
      }
      if (input.wasPressed('KeyR')) this.tryReload();
    }
    this.anim.update(dt);
    this.animate(dt);
    this.casings?.update(worldDt);
  }

  tryFire(fresh) {
    const S = this.S;
    if (this.busy || this.cooldown > 0 || this.sprint > 0.5) return;
    if (!this.chambered) {
      if (fresh) { this.audio.play('dry'); this.cooldown = 0.2; if (AMMO.has(S.ammo)) this.tryReload(); }
      return;
    }
    // the round in the chamber goes; the next one comes up from the magazine
    if (this.mag > 0) this.mag--; else this.chambered = false;
    this.fireT = 0; this.cooldown += 60 / S.rpm;
    this.burst++;
    const cam = this.mainCamera;
    const origin = cam.getWorldPosition(new THREE.Vector3());
    const fwd = cam.getWorldDirection(new THREE.Vector3());
    const right = _v.set(1, 0, 0).applyQuaternion(cam.quaternion), up = _v2.set(0, 1, 0).applyQuaternion(cam.quaternion);
    const moving = clamp(this.player.speed2D / CONFIG.player.walkSpeed);
    const bloom = Math.min(1, this.burst / 10);
    const spread = lerp(S.hip, S.ads, this.ads) * (1 + bloom * (S.auto ? 1.2 : 0)) + moving * 0.012 + (this.player.onGround ? 0 : 0.025);
    const muzzle = this.muzzleWorld(new THREE.Vector3());
    if (S.pellets) {
      const shot = { hits: new Map() };
      for (let i = 0; i < S.pellets; i++) {
        const a = (i / S.pellets) * Math.PI * 2 + Math.random() * 0.8;
        const r = i === 0 ? Math.random() * spread * 0.3 : spread * (0.45 + Math.random() * 0.55);
        const d = fwd.clone().addScaledVector(right, Math.cos(a) * r).addScaledVector(up, Math.sin(a) * r).normalize();
        this.onFire(origin, d, muzzle, { energy: S.energy, impulse: S.impulse, size: S.size, glowSize: S.glow, pellet: true, shot, speed: S.speed, range: S.range, life: 0.6 });
      }
    } else {
      const a = Math.random() * Math.PI * 2, r = Math.sqrt(Math.random()) * spread;
      const d = fwd.clone().addScaledVector(right, Math.cos(a) * r).addScaledVector(up, Math.sin(a) * r).normalize();
      this.onFire(origin, d, muzzle, { energy: S.energy, impulse: S.impulse, speed: S.speed, range: S.range, life: 1.6, size: S.size, glowSize: S.glow });
    }
    // recoil climbs a little through a long burst
    const adsMul = lerp(1, 0.6, this.ads), climb = 1 + bloom * 0.4;
    this.player.addRecoil(S.recoil[0] * adsMul * climb * (0.85 + Math.random() * 0.3), (Math.random() - 0.45) * S.recoil[1] * 2 * adsMul);
    this.kickBack.kick(S.kick * adsMul); this.kickRot.kick(S.kick * 3 * adsMul);
    this.kickSide.kick((Math.random() - 0.5) * 0.4); this.kickRoll.kick((Math.random() - 0.4) * 1.5);
    this.player.fovKick = S.pellets ? 2.2 : 0.6;
    this.audio.play(S.sound);
    this.flash.material.rotation = Math.random() * Math.PI * 2;
    this.flash.scale.setScalar((S.pellets ? 0.16 : 0.1) + Math.random() * 0.06);
    this.flame.rotation.z = Math.random() * Math.PI;
    this.flame.scale.set(0.8 + Math.random() * 0.5, 0.7 + Math.random() * 0.6, 1);
    this.eject();
    if (!this.chambered && this.mag === 0 && AMMO.has(S.ammo)) setTimeout(() => { if (this.raise > 0.9) this.tryReload(); }, 250);
  }

  tryReload() {
    const S = this.S;
    if (this.busy || this.sprint > 0.5) return;
    if (this.mag >= S.mag) return;
    if (!AMMO.has(S.ammo)) { this.audio.play('deny'); this.say?.(`No ${S.ammoName} left`); return; }
    this.anim.play(this.chambered ? this.clips.reload : this.clips.reloadEmpty, this._ev);
  }

  onEvent(e) {
    const S = this.S;
    switch (e) {
      case 'magOut':
        this.audio.play('magOut');
        // what's left in the old magazine goes back in the pouch
        if (this.mag > 0 && AMMO.finite) AMMO.give(S.ammo, this.mag);
        this.mag = 0;
        break;
      case 'magIn': this.audio.play('magIn'); this.mag = AMMO.take(S.ammo, S.mag); break;
      case 'bolt':
        this.audio.play('boltPull');
        if (!this.chambered && this.mag > 0) { this.mag--; this.chambered = true; }
        break;
    }
  }

  eject() {
    if (!this.casings) return;
    const cam = this.mainCamera;
    this.pivot.updateMatrixWorld(true);
    const pos = this.gun.ejectPort.getWorldPosition(new THREE.Vector3()).applyMatrix4(cam.matrixWorld);
    const vel = new THREE.Vector3(2.4 + Math.random(), 1.4 + Math.random(), 0.2 + Math.random() * 0.4).applyQuaternion(cam.quaternion);
    vel.x += this.player.vel.x; vel.z += this.player.vel.z;
    this.casings?.spawn(pos, vel);
  }

  muzzleWorld(out = new THREE.Vector3()) {
    this.pivot.updateMatrixWorld(true);
    return viewmodelToWorld(this.gun.muzzle.getWorldPosition(_v), this.camera, this.mainCamera, out);
  }

  animate(dt) {
    const g = this.gun, p = this.player, a = this.anim, S = this.S;
    const ft = this.fireT;
    const flashOn = ft < 0.035;
    this.flash.visible = flashOn;
    this.flame.visible = ft < 0.025;
    this.flash.material.opacity = flashOn ? 1 - ft / 0.035 * 0.5 : 0;
    this.flashLightVM.intensity = flashOn ? 3 : 0;
    this.flashLightVM.position.set(0.05, -0.02, -0.8);
    this.worldFlash.intensity = flashOn ? 70 * (1 - ft / 0.035) + 10 : 0;
    if (flashOn) this.worldFlash.position.copy(this.mainCamera.position).addScaledVector(this.mainCamera.getWorldDirection(_v), 1.0);
    // bolt carrier jumps back with each shot; the magazine comes out and goes back in
    g.bolt.position.z = (g.bolt.userData.z0 ??= g.bolt.position.z) + (ft < 0.05 ? 0.03 * (1 - ft / 0.05) : 0) + a.sample('bolt', 0) * 0.05;
    const m = a.sample('mag', 0);
    g.mag.visible = m < 1.5;
    g.mag.position.copy(g.magHome).y -= Math.min(1, m) * 0.12;

    const sw = this.sway.update(dt, { ads: this.ads, heavy: 1.1, rate: 9 });
    const kb = this.kickBack.update(dt), kr = this.kickRot.update(dt), ks = this.kickSide.update(dt), kroll = this.kickRoll.update(dt);
    const pos = a.sample('pos', Z3), rot = a.sample('rot', Z3);
    const sp = this.sprint, dr = drawOffset(this.raise, this.drawing);
    const hip = S.hipPos, ads = this.adsPos;
    this.pivot.position.set(
      lerp(hip[0], ads[0], this.ads) + sw.x + sw.bobX + pos[0] - sp * 0.03 + ks * 0.003 + dr.x,
      lerp(hip[1], ads[1], this.ads) + sw.y + sw.bobY + sw.idle + pos[1] - sp * 0.04 - p.crouch * 0.01 + kr * 0.002 + dr.y,
      lerp(hip[2], ads[2], this.ads) + pos[2] + kb * 0.015 + sp * 0.03 + dr.z
    );
    this.pivot.rotation.set(
      rot[0] + kr * 0.03 - sp * 0.35 + sw.y * 1.5 + dr.rx,
      rot[1] + lerp(0.012, 0, this.ads) + sp * 0.75 + sw.x * 1.5 + ks * 0.015,
      rot[2] + kroll * 0.015 + sw.x * 1.2 + sp * 0.2 + dr.rz,
      'YXZ'
    );
    const fov = W.weaponFov * lerp(1, 0.86, this.ads);
    if (Math.abs(this.camera.fov - fov) > 0.01) { this.camera.fov = fov; this.camera.updateProjectionMatrix(); }

    this.pivot.updateMatrixWorld(true);
    this.arms.setOn('right', g.gripPoint, { roll: 0.2 });
    const left = sampleHand(a.clip?.lh || [[0, 'support']], a.time, this.handTargets, _v2);
    this.arms.set('left', left, { roll: -0.25 });
    // the fresh magazine rides in the left hand on its way in
    const inHand = m > 0.2 && m < 1.9 && a.time > (a.clip?.duration || 0) * 0.4;
    this.handMag.visible = inHand && !g.mag.visible;
    if (this.handMag.visible) { this.handMag.position.copy(left).add(_v.set(0.01, 0.06, 0)); this.handMag.quaternion.copy(g.root.getWorldQuaternion(new THREE.Quaternion())); }
  }
}
