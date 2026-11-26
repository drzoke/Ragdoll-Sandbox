import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { clamp, damp, Spring, lerp, viewmodelToWorld, drawOffset } from '../core/util.js';
import { buildRemington870, buildShell } from './model870.js';
import { muzzleFlashTexture, flameTexture } from './model1911.js';
import { Clip, ClipPlayer } from './anim.js';
import { Casings } from './casings.js';
import { BlockArms, sampleHand, anchorPos } from './arms.js';
import { viewmodelScene, Sway } from './viewmodel.js';

const W = CONFIG.weapon;
const S = {
  tube: 6,                 // magazine tube capacity (+1 in the chamber)
  pellets: 8,              // 00 buckshot
  hipSpread: 0.05,         // pattern cone (rad)
  adsSpread: 0.036,
  pelletEnergy: 0.5,
  pelletImpulse: 3.4,
  pelletSpeed: 380,
  hipPos: [0.13, -0.155, -0.4],
  adsPos: [0, -0.074, -0.29],
  adsPitch: 0.022,             // the bead sits a little above the receiver: tilt up to line them up
  gripOffset: [0, 0.048, -0.055], // gun root offset from the pivot (the pivot is the right hand)
};
const Z3 = [0, 0, 0];
const R_POS = [-0.06, 0.035, 0.02], R_ROT = [0.32, 0.1, -0.7];  // rolled so the loading port faces the camera

const CL = {
  pump: new Clip('pump', 0.6, {
    pos: [[0, Z3], [0.1, [0, -0.008, 0.012]], [0.24, [-0.004, -0.014, 0.022]], [0.42, [0, -0.008, 0.01]], [0.6, Z3]],
    rot: [[0, Z3], [0.12, [0.06, 0, 0.1]], [0.26, [0.08, 0.02, 0.16]], [0.42, [0.04, 0, 0.08]], [0.6, Z3]],
    pump: [[0, 0], [0.09, 0], [0.23, 1], [0.28, 1], [0.4, 0]],
  }, [[0.2, 'pumpBack'], [0.39, 'pumpFwd']]),
  reloadStart: new Clip('reloadStart', 0.38, {
    pos: [[0, Z3], [0.34, R_POS], [0.38, R_POS]], rot: [[0, Z3], [0.34, R_ROT], [0.38, R_ROT]],
  }),
  reloadShell: new Clip('reloadShell', 0.52, {
    pos: [[0, R_POS], [0.3, R_POS], [0.34, [R_POS[0], R_POS[1] + 0.008, R_POS[2]]], [0.42, R_POS]],
    rot: [[0, R_ROT], [0.3, R_ROT], [0.34, [R_ROT[0] - 0.04, R_ROT[1], R_ROT[2] - 0.03]], [0.42, R_ROT]],
    shell: [[0, 1], [0.335, 1], [0.336, 0]],
  }, [[0.33, 'shellIn']]),
  reloadEnd: new Clip('reloadEnd', 0.42, { pos: [[0, R_POS], [0.38, Z3]], rot: [[0, R_ROT], [0.38, Z3]] }),
  inspect: new Clip('inspect', 2.9, {
    pos: [[0, Z3], [0.45, [-0.06, 0.04, 0.05]], [1.2, [-0.055, 0.045, 0.05]], [1.55, [-0.04, 0.03, 0.04]], [2.3, [-0.04, 0.03, 0.04]], [2.85, Z3]],
    rot: [[0, Z3], [0.45, [0.1, 0.75, 0.25]], [1.2, [0.14, 0.82, 0.2]], [1.55, [0.05, -0.35, -0.45]], [2.3, [0.05, -0.3, -0.42]], [2.85, Z3]],
    pump: [[0, 0], [1.7, 0], [1.85, 0.32], [2.1, 0.32], [2.22, 0]],
  }, [[1.8, 'pumpCheck'], [2.2, 'pumpCheckFwd']]),
};
// left-hand tracks
CL.pump.lh = [[0, 'pump']];
CL.reloadStart.lh = [[0, 'pump'], [0.34, 'pouch']];
CL.reloadShell.lh = [[0, 'pouch'], [0.24, 'portOut'], [0.33, 'portIn'], [0.36, 'portIn'], [0.52, 'pouch']];
CL.reloadEnd.lh = [[0, 'pouch'], [0.38, 'pump']];
CL.inspect.lh = [[0, 'pump']];

const _v = new THREE.Vector3(), _v2 = new THREE.Vector3(), _h = new THREE.Vector3(), _q = new THREE.Quaternion();

/**
 * Remington 870 pump-action shotgun: 8 pellets per shot, pump after every shot (automatic),
 * shells loaded one at a time into the tube (fire to stop reloading early).
 */
export class Shotgun {
  constructor({ mainScene, mainCamera, player, audio, environment, onFire }) {
    this.name = 'Remington 870';
    this.short = 'Shotgun';
    this.player = player; this.audio = audio; this.mainCamera = mainCamera; this.onFire = onFire;
    const vm = viewmodelScene(environment);
    this.scene = vm.scene; this.camera = vm.camera;
    this.flashLightVM = new THREE.PointLight(0xffb060, 0, 1.6, 2); this.scene.add(this.flashLightVM);

    this.pivot = new THREE.Group(); this.scene.add(this.pivot);
    this.gun = buildRemington870();
    this.gun.root.position.set(...S.gripOffset);
    this.pivot.add(this.gun.root);

    // muzzle flash: big star sprite + side flame planes
    this.flash = new THREE.Sprite(new THREE.SpriteMaterial({ map: muzzleFlashTexture(), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }));
    this.flash.scale.setScalar(0.16); this.flash.position.set(0, 0, -0.05); this.flash.visible = false;
    this.gun.muzzle.add(this.flash);
    const flameMat = new THREE.MeshBasicMaterial({ map: flameTexture(), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, side: THREE.DoubleSide });
    const flameGeo = new THREE.PlaneGeometry(0.09, 0.24).translate(0, 0.12, 0).rotateX(-Math.PI / 2);
    this.flame = new THREE.Group();
    for (let i = 0; i < 3; i++) { const m = new THREE.Mesh(flameGeo, flameMat); m.rotation.z = (i / 3) * Math.PI; this.flame.add(m); }
    this.flame.visible = false;
    this.gun.muzzle.add(this.flame);

    // hands + the shell carried in the left hand while loading
    this.arms = new BlockArms(this.scene, { handSize: 0.062 });
    this.handShell = buildShell();
    this.handShell.visible = false;
    this.scene.add(this.handShell);
    const portOut = new THREE.Object3D(); portOut.position.set(-0.004, -0.11, -0.085); this.gun.root.add(portOut);
    const portIn = new THREE.Object3D(); portIn.position.set(-0.002, -0.078, -0.098); this.gun.root.add(portIn);
    this.handTargets = {
      pump: () => anchorPos(this.gun.pumpHand, _h),
      portOut: () => anchorPos(portOut, _h),
      portIn: () => anchorPos(portIn, _h),
      pouch: new THREE.Vector3(-0.15, -0.4, -0.2),
    };

    this.worldFlash = new THREE.PointLight(0xffa850, 0, 11, 2);
    mainScene.add(this.worldFlash);
    this.hulls = new Casings(mainScene, null, audio, { build: () => buildShell(), sound: 'hull', rest: 0.0105 });

    // ---- state ----
    this.tube = S.tube;
    this.chamber = 'live';      // 'live' | 'spent' | null
    this.raise = 0;
    this.drawing = true;
    this.ads = 0; this.sprint = 0;
    this.fireT = 99; this.cooldown = 0;
    this.anim = new ClipPlayer();
    this.pumpQueued = -1;       // time until the automatic pump
    this.reloading = false; this.stopReload = false;
    this.kickBack = new Spring(240, 15); this.kickRot = new Spring(200, 13); this.kickSide = new Spring(200, 16); this.kickRoll = new Spring(200, 16);
    this.sway = new Sway(player);
    this._ev = (e, c) => this.onEvent(e, c);
  }

  get busy() { return this.anim.playing || this.pumpQueued >= 0; }
  get state() { return this.anim.clip ? this.anim.clip.name : 'idle'; }
  resize(aspect) { this.camera.aspect = aspect; this.camera.updateProjectionMatrix(); }
  refill() {}

  get controls() {
    return [['Left click', 'Fire (pumps by itself)'], ['Right click', 'Aim down sights'], ['R', 'Load shells (fire to stop)'], ['F', 'Inspect']];
  }
  status() { return null; }
  ammo() {
    return { mag: this.tube, chamber: this.chamber === 'live' ? '+1' : '+0', reserve: '∞', name: 'Remington 870 · 12 gauge', low: this.tube <= 1 && this.chamber !== 'live' };
  }
  crosshair() { return { gap: 15 + Math.max(0, 0.25 - this.fireT) * 60, ads: this.ads > 0.6 }; }

  update(dt, input, active, worldDt = dt) {
    const p = this.player;
    active = active && this.raise > 0.9;
    this.cooldown -= dt; this.fireT += dt;
    const reloadPose = this.reloading || this.state.startsWith('reload');
    const wantAds = active && input.mouseDown[2] && !reloadPose && !p.sprinting && this.state !== 'inspect';
    this.ads += ((wantAds ? 1 : 0) - this.ads) * damp(12, dt);
    p.aiming = this.ads > 0.5;
    this.sprint += ((p.sprinting && !reloadPose ? 1 : 0) - this.sprint) * damp(8, dt);

    if (active) {
      if (input.mousePressed[0]) this.tryFire();
      if (input.wasPressed('KeyR')) this.tryReload();
      if (input.wasPressed('KeyF') && !this.busy) this.anim.play(CL.inspect, this._ev);
    }
    if (this.pumpQueued >= 0) {
      this.pumpQueued -= dt;
      if (this.pumpQueued < 0 && !this.anim.playing) this.anim.play(CL.pump, this._ev);
      else if (this.pumpQueued < 0) this.pumpQueued = 0;
    }
    this.anim.update(dt);
    this.animate(dt);
    this.hulls.update(worldDt);
  }

  tryFire() {
    if (this.reloading) { this.stopReload = true; return; }
    if (this.busy) { if (this.state === 'inspect') this.anim.stop(); else return; }
    if (this.cooldown > 0 || this.sprint > 0.5) return;
    if (this.chamber !== 'live') {
      this.audio.play('dry'); this.cooldown = 0.25;
      if (this.chamber === 'spent' || this.tube > 0) this.pumpQueued = 0.05; // rack it
      return;
    }
    this.chamber = 'spent';
    this.fireT = 0; this.cooldown = 0.2;
    const cam = this.mainCamera;
    const origin = cam.getWorldPosition(new THREE.Vector3());
    const fwd = cam.getWorldDirection(new THREE.Vector3());
    const right = _v.set(1, 0, 0).applyQuaternion(cam.quaternion), up = _v2.set(0, 1, 0).applyQuaternion(cam.quaternion);
    const moving = clamp(this.player.speed2D / CONFIG.player.walkSpeed);
    const cone = lerp(S.hipSpread, S.adsSpread, this.ads) + moving * 0.012 + (this.player.onGround ? 0 : 0.02);
    const muzzle = this.muzzleWorld(new THREE.Vector3());
    const shot = { hits: new Map() };
    for (let i = 0; i < S.pellets; i++) {
      // even-ish pattern: one pellet near the centre, the rest on a jittered ring
      const a = (i / S.pellets) * Math.PI * 2 + Math.random() * 0.8;
      const r = i === 0 ? Math.random() * cone * 0.3 : cone * (0.45 + Math.random() * 0.55);
      const d = fwd.clone().addScaledVector(right, Math.cos(a) * r).addScaledVector(up, Math.sin(a) * r).normalize();
      this.onFire(origin, d, muzzle, { energy: S.pelletEnergy, impulse: S.pelletImpulse, size: 0.55, glowSize: 0.04, pellet: true, shot, speed: S.pelletSpeed, range: 70, life: 0.6 });
    }
    // heavy recoil
    const adsMul = lerp(1, 0.75, this.ads);
    this.player.addRecoil(0.11 * adsMul * (0.9 + Math.random() * 0.2), (Math.random() - 0.4) * 0.03);
    this.kickBack.kick(2.6 * adsMul); this.kickRot.kick(9 * adsMul);
    this.kickSide.kick((Math.random() - 0.5) * 0.6); this.kickRoll.kick((Math.random() - 0.3) * 3);
    this.player.fovKick = 2.4;
    this.audio.play('shotgun');
    this.flash.material.rotation = Math.random() * Math.PI * 2;
    this.flash.scale.setScalar(0.15 + Math.random() * 0.08);
    this.flame.rotation.z = Math.random() * Math.PI;
    this.flame.scale.set(0.9 + Math.random() * 0.4, 0.8 + Math.random() * 0.5, 1);
    this.pumpQueued = 0.16;
  }

  tryReload() {
    if (this.busy || this.reloading || this.sprint > 0.5) return;
    if (this.tube >= S.tube) { if (this.chamber !== 'live') this.pumpQueued = 0; return; }
    this.reloading = true; this.stopReload = false;
    this.anim.play(CL.reloadStart, this._ev);
  }

  onEvent(e, clip) {
    switch (e) {
      case 'pumpBack':
        this.audio.play('pumpBack');
        if (this.chamber) { this.ejectHull(this.chamber === 'live'); this.chamber = null; }
        break;
      case 'pumpFwd':
        this.audio.play('pumpFwd');
        if (this.tube > 0) { this.tube--; this.chamber = 'live'; }
        break;
      case 'pumpCheck': this.audio.play('pumpBack'); break;
      case 'pumpCheckFwd': this.audio.play('pumpFwd'); break;
      case 'shellIn': this.audio.play('shellIn'); this.tube = Math.min(S.tube, this.tube + 1); break;
      case 'end':
        if (!this.reloading) break;
        if (clip === CL.reloadStart || clip === CL.reloadShell) {
          if (this.tube < S.tube && !this.stopReload) this.anim.play(CL.reloadShell, this._ev);
          else this.anim.play(CL.reloadEnd, this._ev);
        } else if (clip === CL.reloadEnd) {
          this.reloading = false;
          if (this.chamber !== 'live' && this.tube > 0) this.pumpQueued = 0;
        }
        break;
    }
  }

  ejectHull(live) {
    const cam = this.mainCamera;
    this.pivot.updateMatrixWorld(true);
    const pos = anchorPos(this.gun.ejectPort, new THREE.Vector3()).applyMatrix4(cam.matrixWorld);
    const vel = new THREE.Vector3(2.2 + Math.random() * 0.8, 1.6 + Math.random() * 0.8, 0.4 + Math.random() * 0.4).applyQuaternion(cam.quaternion);
    vel.x += this.player.vel.x; vel.z += this.player.vel.z;
    this.hulls.spawn(pos, vel);
    const hull = this.hulls.list[this.hulls.list.length - 1].mesh;
    hull.quaternion.copy(cam.quaternion);
  }

  muzzleWorld(out = new THREE.Vector3()) {
    this.pivot.updateMatrixWorld(true);
    return viewmodelToWorld(this.gun.muzzle.getWorldPosition(_v), this.camera, this.mainCamera, out);
  }

  animate(dt) {
    const g = this.gun, p = this.player, a = this.anim;
    const ft = this.fireT;
    // pump slide (travel 8.5 cm)
    g.pump.position.z = a.sample('pump', 0) * 0.085;
    g.trigger.rotation.x = 0.25 - (ft < 0.08 ? 0.2 : 0);

    const flashOn = ft < 0.04;
    this.flash.visible = flashOn;
    this.flame.visible = ft < 0.028;
    this.flash.material.opacity = flashOn ? 1 - ft / 0.04 * 0.5 : 0;
    this.flashLightVM.intensity = flashOn ? 4 : 0;
    this.flashLightVM.position.set(0.05, -0.02, -0.8);
    this.worldFlash.intensity = flashOn ? 90 * (1 - ft / 0.04) + 15 : 0;
    if (flashOn) this.worldFlash.position.copy(this.mainCamera.position).addScaledVector(this.mainCamera.getWorldDirection(_v), 1.0);

    const sw = this.sway.update(dt, { ads: this.ads, heavy: 1.2, rate: 8 });
    const kb = this.kickBack.update(dt), kr = this.kickRot.update(dt), ks = this.kickSide.update(dt), kroll = this.kickRoll.update(dt);
    const pos = a.sample('pos', Z3), rot = a.sample('rot', Z3);
    const sp = this.sprint, dr = drawOffset(this.raise, this.drawing);
    const hip = S.hipPos, ads = S.adsPos;
    this.pivot.position.set(
      lerp(hip[0], ads[0], this.ads) + sw.x + sw.bobX + pos[0] - sp * 0.03 + ks * 0.004 + dr.x,
      lerp(hip[1], ads[1], this.ads) + sw.y + sw.bobY + sw.idle + pos[1] - sp * 0.04 - p.crouch * 0.01 + kr * 0.003 + dr.y,
      lerp(hip[2], ads[2], this.ads) + pos[2] + kb * 0.02 + sp * 0.03 + dr.z
    );
    this.pivot.rotation.set(
      rot[0] + kr * 0.045 - sp * 0.35 + sw.y * 1.5 + dr.rx + S.adsPitch * this.ads,
      rot[1] + lerp(0.012, 0, this.ads) + sp * 0.75 + sw.x * 1.5 + ks * 0.02,
      rot[2] + kroll * 0.02 + sw.x * 1.2 + sp * 0.2 + dr.rz,
      'YXZ'
    );
    const fov = W.weaponFov * lerp(1, 0.88, this.ads);
    if (Math.abs(this.camera.fov - fov) > 0.01) { this.camera.fov = fov; this.camera.updateProjectionMatrix(); }

    // ---- hands ----
    this.pivot.updateMatrixWorld(true);
    this.arms.setOn('right', g.gripPoint, { roll: 0.2 });
    const left = sampleHand(a.clip?.lh || [[0, 'pump']], a.time, this.handTargets, _v2);
    this.arms.set('left', left, { roll: -0.2 });
    const shellOn = a.clip?.tracks.shell ? a.sample('shell', 0) > 0.5 : false;
    this.handShell.visible = shellOn;
    if (shellOn) {
      // shell sits on top of the left hand, lined up with the magazine tube
      g.root.getWorldQuaternion(_q);
      const up = _v.set(0, 1, 0).applyQuaternion(_q);
      this.handShell.position.copy(left).addScaledVector(up, 0.045);
      this.handShell.quaternion.copy(_q);
    }
  }
}
