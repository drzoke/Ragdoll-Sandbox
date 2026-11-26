import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { clamp, damp, Spring, lerp, viewmodelToWorld, drawOffset } from '../core/util.js';
import { buildM1911, muzzleFlashTexture, flameTexture } from './model1911.js';
import { ClipPlayer, CLIPS } from './anim.js';
import { Casings } from './casings.js';
import { BlockArms, sampleHand, anchorPos } from './arms.js';

const W = CONFIG.weapon;
const _v = new THREE.Vector3(), _v2 = new THREE.Vector3(), _h1 = new THREE.Vector3(), _h2 = new THREE.Vector3();

/**
 * M1911 viewmodel + weapon logic.
 * Rendered in its own scene/camera (no clipping into the world), layered over the main view.
 * Firing calls `onFire(origin, direction)`; ballistics are resolved outside.
 */
export class Pistol {
  constructor({ mainScene, mainCamera, player, audio, environment, onFire }) {
    this.player = player; this.audio = audio; this.onFire = onFire;
    this.mainCamera = mainCamera;

    // ---- viewmodel scene ----
    this.scene = new THREE.Scene();
    this.scene.environment = environment;
    this.scene.environmentIntensity = 0.9;
    this.camera = new THREE.PerspectiveCamera(W.weaponFov, 1, 0.01, 10);
    this.scene.add(new THREE.HemisphereLight(0xe8eef5, 0x55575a, 1.4));
    const key = new THREE.DirectionalLight(0xffffff, 2.2); key.position.set(0.6, 1, 0.4); this.scene.add(key);
    const rim = new THREE.DirectionalLight(0xbcd4ff, 0.9); rim.position.set(-1, 0.3, -0.6); this.scene.add(rim);
    this.flashLightVM = new THREE.PointLight(0xffb060, 0, 1.2, 2); this.scene.add(this.flashLightVM);

    this.pivot = new THREE.Group(); this.scene.add(this.pivot);
    this.gun = buildM1911();
    this.gun.root.position.set(...W.gripOffset);
    this.pivot.add(this.gun.root);

    this.flash = new THREE.Sprite(new THREE.SpriteMaterial({ map: muzzleFlashTexture(), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }));
    this.flash.scale.setScalar(0.09);
    this.flash.position.set(0, 0, -0.035);
    this.flash.visible = false;
    this.gun.muzzle.add(this.flash);
    // Side-on flame: crossed additive planes along the barrel, visible from the side.
    const flameMat = new THREE.MeshBasicMaterial({ map: flameTexture(), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, side: THREE.DoubleSide });
    const flameGeo = new THREE.PlaneGeometry(0.05, 0.13).translate(0, 0.065, 0).rotateX(-Math.PI / 2);
    this.flame = new THREE.Group();
    for (let i = 0; i < 3; i++) { const m = new THREE.Mesh(flameGeo, flameMat); m.rotation.z = (i / 3) * Math.PI; this.flame.add(m); }
    this.flame.position.set(0, 0, -0.01);
    this.flame.visible = false;
    this.gun.muzzle.add(this.flame);
    // ---- hands: anchors on the gun the blocky hands snap to ----
    this.arms = new BlockArms(this.scene, { handSize: 0.058 });
    const anchor = (parent, x, y, z) => { const o = new THREE.Object3D(); o.position.set(x, y, z); parent.add(o); return o; };
    this.anchors = {
      grip: anchor(this.gun.root, 0.002, -0.066, 0.02),
      support: anchor(this.gun.root, -0.036, -0.078, 0.004),
      mag: anchor(this.gun.mag, -0.004, -0.112, 0.004),
      slide: anchor(this.gun.slide, -0.024, 0.006, -0.026),
    };
    this.handTargets = {
      support: () => anchorPos(this.anchors.support, _h1),
      mag: () => anchorPos(this.anchors.mag, _h1),
      slide: () => anchorPos(this.anchors.slide, _h1),
      pouch: new THREE.Vector3(-0.17, -0.36, -0.22),
      low: new THREE.Vector3(-0.22, -0.4, -0.14),
    };
    this.raise = 1;          // 0 = holstered, 1 = up (set by the toolbox)
    this.name = 'M1911';

    // World-side muzzle light + casings
    this.worldFlash = new THREE.PointLight(0xffa850, 0, 9, 2);
    mainScene.add(this.worldFlash);
    this.casings = new Casings(mainScene, this.gun.materials.brass, audio);

    // ---- state ----
    this.mag = W.magSize;
    this.chambered = true;
    this.reserve = W.startReserve;
    this.slideLocked = false;
    this.cooldown = 0;
    this.fireT = 99;          // time since last shot
    this.ads = 0;
    this.sprint = 0;
    this.anim = new ClipPlayer();
    this.dropMags = [];
    this.kickBack = new Spring(320, 20);
    this.kickRot = new Spring(260, 17);
    this.kickSide = new Spring(220, 18);
    this.kickRoll = new Spring(220, 18);
    this.swayX = 0; this.swayY = 0;
    this.lastYaw = player.yaw; this.lastPitch = player.pitch;
    this.hammer = 1;
    this.ejected = true;
  }

  get busy() { return this.anim.playing; }
  get state() { return this.anim.clip ? this.anim.clip.name : 'idle'; }

  resize(aspect) { this.camera.aspect = aspect; this.camera.updateProjectionMatrix(); }

  refill() { this.reserve = W.startReserve; }

  get controls() {
    return [
      ['Left click', 'Fire'], ['Right click', 'Aim down sights'], ['R', 'Reload'], ['F', 'Inspect'],
    ];
  }

  status() { return null; }

  update(dt, input, active, worldDt = dt) {
    const p = this.player;
    active = active && this.raise > 0.9;
    this.cooldown -= dt;
    this.fireT += dt;

    // ---- input ----
    const wantAds = active && input.mouseDown[2] && !this.busy && !p.sprinting;
    this.ads += ((wantAds ? 1 : 0) - this.ads) * damp(14, dt);
    p.aiming = this.ads > 0.5;
    this.sprint += ((p.sprinting && !this.busy ? 1 : 0) - this.sprint) * damp(8, dt);

    if (active) {
      if (input.mousePressed[0]) this.tryFire();
      if (input.wasPressed('KeyR')) this.tryReload();
      if (input.wasPressed('KeyF')) this.tryInspect();
    }

    this.anim.update(dt);
    this.animateGun(dt);
    this.updateArms();
    this.updateDropMags(dt);
    this.casings.update(worldDt);
  }

  /** Right hand on the grip; left hand supports, fetches magazines and racks the slide. */
  updateArms() {
    this.pivot.updateMatrixWorld(true);
    this.arms.setOn('right', this.anchors.grip, { roll: 0.1 });
    const clip = this.anim.clip;
    const left = clip?.lh ? sampleHand(clip.lh, this.anim.time, this.handTargets, _h2) : anchorPos(this.anchors.support, _h2);
    this.arms.set('left', left, { roll: -0.25 });
  }

  muzzleWorld(out = new THREE.Vector3()) {
    this.pivot.updateMatrixWorld(true);
    return viewmodelToWorld(this.gun.muzzle.getWorldPosition(_v), this.camera, this.mainCamera, out);
  }

  tryFire() {
    if (this.cooldown > 0 || this.sprint > 0.5) return;
    if (this.busy) { if (this.state === 'inspect') this.anim.stop(); else return; }
    if (!this.chambered) { this.audio.play('dry'); this.cooldown = 0.2; this.hammer = 0; return; }
    this.cooldown = W.minShotInterval;
    this.fireT = 0;
    this.chambered = false;
    if (this.mag > 0) { this.mag--; this.chambered = true; } else this.slideLocked = true;

    // Ballistics ray with spread
    const cam = this.mainCamera;
    const origin = cam.getWorldPosition(new THREE.Vector3());
    const dir = cam.getWorldDirection(new THREE.Vector3());
    const moving = clamp(this.player.speed2D / CONFIG.player.walkSpeed);
    const spread = lerp(W.hipSpread, W.adsSpread, this.ads) + W.moveSpread * moving * (1 - this.ads * 0.6) + (this.player.onGround ? 0 : 0.03);
    const right = _v.set(1, 0, 0).applyQuaternion(cam.quaternion), up = _v2.set(0, 1, 0).applyQuaternion(cam.quaternion);
    const a = Math.random() * Math.PI * 2, r = Math.sqrt(Math.random()) * spread;
    dir.addScaledVector(right, Math.cos(a) * r).addScaledVector(up, Math.sin(a) * r).normalize();
    const muzzle = this.muzzleWorld(new THREE.Vector3());
    this.onFire(origin, dir, muzzle);

    // Recoil: camera + viewmodel
    const rc = W.recoil, adsMul = lerp(1, 0.7, this.ads);
    this.player.addRecoil(rc.pitch * adsMul * (0.85 + Math.random() * 0.3), (Math.random() - 0.4) * rc.yaw * 2);
    this.kickBack.kick(rc.viewKickBack * 30 * adsMul);
    this.kickRot.kick(rc.viewKickRot * 30 * adsMul);
    this.kickSide.kick((Math.random() - 0.5) * 0.4);
    this.kickRoll.kick((Math.random() - 0.3) * 2.2);
    this.player.fovKick = 1.2;
    this.audio.play('shot');
    this.flash.visible = true;
    this.flash.material.rotation = Math.random() * Math.PI * 2;
    this.flash.scale.setScalar(0.08 + Math.random() * 0.06);
    this.flame.rotation.z = Math.random() * Math.PI;
    this.flame.scale.set(0.8 + Math.random() * 0.5, 0.8 + Math.random() * 0.6, 1);
    this.hammer = 0;
    this.ejected = false;
  }

  tryReload() {
    if (this.busy || this.sprint > 0.5) return;
    if (this.mag >= W.magSize) return;
    if (!W.infiniteReserve && this.reserve <= 0) return;
    const empty = this.slideLocked;
    this.anim.play(empty ? CLIPS.reloadEmpty : CLIPS.reload, (e) => this.onAnimEvent(e));
  }

  tryInspect() {
    if (this.busy) return;
    this.anim.play(CLIPS.inspect, (e) => this.onAnimEvent(e));
  }

  onAnimEvent(e) {
    switch (e) {
      case 'magOut': {
        this.audio.play('magOut');
        // Leftover rounds go back to the reserve (keeps the count simple).
        if (!W.infiniteReserve) this.reserve += this.mag;
        this.mag = 0;
        this.spawnDropMag();
        break;
      }
      case 'magIn': {
        this.audio.play('magIn');
        const take = W.infiniteReserve ? W.magSize : Math.min(W.magSize, this.reserve);
        if (!W.infiniteReserve) this.reserve -= take;
        this.mag = take;
        break;
      }
      case 'slideRelease':
        this.audio.play('slide');
        if (this.mag > 0) { this.mag--; this.chambered = true; }
        this.slideLocked = false; this.hammer = 1;
        break;
      case 'slideBack': this.audio.play('slide'); break;
      case 'click': this.audio.play('click'); break;
    }
  }

  spawnDropMag() {
    const g = this.gun;
    const m = g.mag.clone(true);
    this.gun.mag.updateWorldMatrix(true, true);
    m.matrix.copy(g.mag.matrixWorld);
    m.matrix.decompose(m.position, m.quaternion, m.scale);
    this.scene.add(m);
    const dir = g.magDir.clone().applyQuaternion(g.mag.parent.getWorldQuaternion(new THREE.Quaternion()));
    this.dropMags.push({ mesh: m, vel: dir.multiplyScalar(1.2), life: 0.9 });
  }

  updateDropMags(dt) {
    for (const d of this.dropMags) {
      d.vel.y -= 9.81 * dt;
      d.mesh.position.addScaledVector(d.vel, dt);
      d.mesh.rotation.x += dt * 2;
      d.life -= dt;
      if (d.life <= 0) this.scene.remove(d.mesh);
    }
    this.dropMags = this.dropMags.filter((d) => d.life > 0);
  }

  ejectCasing() {
    const cam = this.mainCamera;
    const local = this.gun.ejectPort.getWorldPosition(new THREE.Vector3()); // weapon-camera space == main camera local space
    const pos = local.clone().applyMatrix4(cam.matrixWorld);
    const q = cam.quaternion;
    const vel = new THREE.Vector3(1.8 + Math.random() * 0.8, 2.2 + Math.random() * 0.8, 0.3 + Math.random() * 0.4).applyQuaternion(q);
    vel.x += this.player.vel.x; vel.z += this.player.vel.z;
    this.casings.spawn(pos, vel);
  }

  animateGun(dt) {
    const g = this.gun, p = this.player, a = this.anim;

    // ---- slide / hammer / trigger mechanics ----
    const ft = this.fireT;
    let slide = 0;
    if (ft < 0.03) slide = ft / 0.03;
    else if (ft < 0.1) slide = this.slideLocked ? 1 : 1 - (ft - 0.03) / 0.07;
    else slide = this.slideLocked ? 1 : 0;
    if (ft > 0.012 && !this.ejected) { this.ejected = true; this.ejectCasing(); }
    if (a.clip?.tracks.slide) slide = Math.max(a.clip.name === 'reloadEmpty' ? 0 : slide, a.sample('slide', slide));
    g.slide.position.z = 0.03 * slide;
    if (slide > 0.4) this.hammer = 1;
    g.hammer.rotation.x = this.hammer * 0.78;
    g.trigger.position.z = -0.044 + (ft < 0.07 ? 0.0035 : 0);
    g.mag.userData.round.visible = this.mag > 0 || a.clip?.name?.startsWith('reload');

    // magazine track (0 = seated, >2 = hidden off-screen)
    const magT = a.sample('mag', 0);
    // (a fresh magazine comes up from below the screen in the left hand)
    g.mag.visible = magT < 3.5;
    g.mag.position.copy(g.magBasePos).addScaledVector(g.magDir, magT * 0.1);

    // ---- muzzle flash ----
    const flashOn = ft < 0.035;
    this.flash.visible = flashOn;
    this.flame.visible = ft < 0.022;
    this.flash.material.opacity = flashOn ? 1 - ft / 0.035 * 0.5 : 0;
    this.flashLightVM.intensity = flashOn ? 3 : 0;
    this.flashLightVM.position.set(0.1, -0.05, -0.55);
    this.worldFlash.intensity = flashOn ? 55 * (1 - ft / 0.035) + 10 : 0;
    if (flashOn) this.worldFlash.position.copy(this.mainCamera.position).addScaledVector(this.mainCamera.getWorldDirection(_v), 0.8);

    // ---- sway (lags behind mouse look) ----
    const dYaw = p.yaw - this.lastYaw, dPitch = p.pitch - this.lastPitch;
    this.lastYaw = p.yaw; this.lastPitch = p.pitch;
    const swayMul = lerp(1, 0.2, this.ads);
    this.swayX += (clamp(-dYaw * 1.6, -0.06, 0.06) * swayMul - this.swayX) * damp(10, dt);
    this.swayY += (clamp(dPitch * 1.6, -0.06, 0.06) * swayMul - this.swayY) * damp(10, dt);

    // ---- bob ----
    const bobA = p.bobAmount * lerp(1, 0.15, this.ads);
    const bobX = Math.cos(p.bobPhase) * 0.009 * bobA;
    const bobY = -Math.abs(Math.sin(p.bobPhase)) * 0.011 * bobA;
    const idle = Math.sin(performance.now() * 0.0013) * 0.0015 * (1 - this.ads * 0.8);

    // ---- springs ----
    const kb = this.kickBack.update(dt), kr = this.kickRot.update(dt), ks = this.kickSide.update(dt), kroll = this.kickRoll.update(dt);

    // ---- compose ----
    const hip = W.hipPos, ads = W.adsPos;
    const pos = a.sample('pos', [0, 0, 0]), rot = a.sample('rot', [0, 0, 0]);
    const sp = this.sprint;
    const crouchDip = p.crouch * 0.01;
    const dr = drawOffset(this.raise, this.drawing);
    this.pivot.position.set(
      lerp(hip[0], ads[0], this.ads) + this.swayX + bobX + pos[0] - sp * 0.04 + ks * 0.003 + dr.x,
      lerp(hip[1], ads[1], this.ads) + this.swayY + bobY + idle + pos[1] - sp * 0.035 - crouchDip + kr * 0.004 + dr.y,
      lerp(hip[2], ads[2], this.ads) + pos[2] + kb * 0.01 + sp * 0.02 + dr.z
    );
    this.pivot.rotation.set(
      rot[0] + kr * 0.06 - sp * 0.45 + this.swayY * 1.5 + dr.rx,
      rot[1] + lerp(0.035, 0, this.ads) + sp * 0.55 + this.swayX * 1.5 + ks * 0.02,
      rot[2] + kroll * 0.02 + this.swayX * 1.2 + sp * 0.15 + dr.rz,
      'YXZ'
    );
    const fov = W.weaponFov * lerp(1, 0.86, this.ads);
    if (Math.abs(this.camera.fov - fov) > 0.01) { this.camera.fov = fov; this.camera.updateProjectionMatrix(); }
  }
}
