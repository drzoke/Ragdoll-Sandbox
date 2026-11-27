import * as THREE from 'three';
import { lerp, viewmodelToWorld, drawOffset } from '../core/util.js';
import { Clip, ClipPlayer } from './anim.js';
import { BlockArms, sampleHand, anchorPos } from './arms.js';
import { viewmodelScene, Sway } from './viewmodel.js';
import { buildGrenade } from './grenadeModel.js';

const HOLD = [0.15, -0.14, -0.42];
const Z3 = [0, 0, 0];
const READY = [-0.04, 0.03, -0.01], READY_R = [0.1, 0.0, -0.25];

const CLIPS = {
  throw: new Clip('throw', 1.0, {
    pos: [[0, Z3], [0.18, READY], [0.3, READY], [0.52, [0.09, 0.1, 0.12]], [0.6, [0.06, 0.13, 0.02]], [0.68, [-0.04, 0.06, -0.28]], [0.85, [-0.06, -0.15, -0.2]], [1.0, [-0.02, -0.36, -0.1]]],
    rot: [[0, Z3], [0.18, READY_R], [0.3, READY_R], [0.52, [-0.9, 0.1, 0.2]], [0.68, [0.6, 0, 0]], [1.0, [1, 0, 0]]],
  }, [[0.22, 'pin'], [0.34, 'wind'], [0.64, 'release']]),
  lob: new Clip('lob', 1.05, {
    pos: [[0, Z3], [0.18, READY], [0.3, READY], [0.55, [0.04, -0.2, 0.1]], [0.72, [-0.01, 0.0, -0.22]], [0.9, [-0.02, 0.05, -0.3]], [1.05, [0, -0.3, -0.2]]],
    rot: [[0, Z3], [0.18, READY_R], [0.3, READY_R], [0.55, [0.8, 0, 0.1]], [0.72, [-0.4, 0, 0]], [1.05, [-0.2, 0, 0]]],
  }, [[0.22, 'pin'], [0.4, 'wind'], [0.7, 'release']]),
};
CLIPS.throw.lh = [[0, 'idle'], [0.15, 'ring'], [0.22, 'ring'], [0.36, 'pull'], [0.6, 'low']];
CLIPS.lob.lh = [[0, 'idle'], [0.15, 'ring'], [0.22, 'ring'], [0.36, 'pull'], [0.6, 'low']];

const _v = new THREE.Vector3(), _h = new THREE.Vector3(), _q = new THREE.Quaternion();

/**
 * Green ball grenade. Left click: pull the pin and throw overhand (far). Right click: underhand
 * lob (short, gentle). The grenade goes off 3 seconds after it leaves your hand.
 */
export class GrenadeTool {
  constructor({ mainCamera, player, audio, environment, onThrow }) {
    this.name = 'Grenade';
    this.player = player; this.audio = audio; this.mainCamera = mainCamera; this.onThrow = onThrow;
    const vm = viewmodelScene(environment);
    this.scene = vm.scene; this.camera = vm.camera;
    this.pivot = new THREE.Group(); this.scene.add(this.pivot);
    this.model = buildGrenade();
    this.model.root.scale.setScalar(1.1);
    this.model.root.rotation.set(0.15, -0.5, 0.12);
    this.pivot.add(this.model.root);
    this.arms = new BlockArms(this.scene, { handSize: 0.066 });
    const anchor = (x, y, z) => { const o = new THREE.Object3D(); o.position.set(x, y, z); this.model.root.add(o); return o; };
    this.anchors = { palm: anchor(0.016, -0.036, 0.012) };
    this.handTargets = {
      idle: new THREE.Vector3(-0.15, -0.21, -0.42),
      ring: () => anchorPos(this.model.ringPoint, _h).add(_v.set(-0.03, -0.01, 0.01)),
      pull: new THREE.Vector3(-0.2, -0.16, -0.3),
      low: new THREE.Vector3(-0.24, -0.42, -0.16),
    };
    this.raise = 0; this.drawing = true;
    this.anim = new ClipPlayer();
    this.sway = new Sway(player);
    this.pinOut = false;
    this.inHand = true;
    this.kind = 'throw';
  }

  resize(aspect) { this.camera.aspect = aspect; this.camera.updateProjectionMatrix(); }
  refill() {}
  get controls() { return [['Left click', 'Pull pin and throw'], ['Right click', 'Pull pin and lob underhand']]; }
  status() { return { title: 'Grenade', sub: '∞ · 3 second fuse' }; }
  crosshair() { return { gap: 6 }; }

  update(dt, input, active, worldDt) {
    const ready = active && this.raise > 0.9;
    if (ready && !this.anim.playing && !this.player.sprinting) {
      if (input.mousePressed[0]) this.start('throw');
      else if (input.mousePressed[2]) this.start('lob');
    }
    if (!active && this.anim.playing) { this.anim.stop(); this.reset(); }
    this.anim.update(dt);
    this.animate(dt);
  }

  start(kind) {
    this.kind = kind;
    this.anim.play(CLIPS[kind], (e) => this.onEvent(e));
  }

  onEvent(e) {
    switch (e) {
      case 'pin':
        this.audio.play('pin');
        this.pinOut = true;
        // the pin and ring come away in the left hand
        this.scene.attach(this.model.pinGroup);
        break;
      case 'wind': this.audio.play('whoosh'); break;
      case 'release': this.release(); break;
      case 'end':
        // next grenade: the hand comes back up with a fresh one
        this.reset();
        this.raise = 0; this.drawing = true;
        break;
    }
  }

  reset() {
    this.inHand = true;
    this.model.root.visible = true;
    this.model.spoon.visible = true;
    if (this.pinOut) {
      this.model.root.add(this.model.pinGroup);
      this.model.pinGroup.position.set(0, 0, 0); this.model.pinGroup.quaternion.identity(); this.model.pinGroup.scale.setScalar(1);
      this.pinOut = false;
    }
    this.model.pinGroup.visible = true;
  }

  release() {
    this.inHand = false;
    this.pivot.updateMatrixWorld(true);
    const cam = this.mainCamera;
    const vmPos = this.model.root.getWorldPosition(new THREE.Vector3());
    const pos = viewmodelToWorld(vmPos, this.camera, cam, new THREE.Vector3());
    const dir = cam.getWorldDirection(new THREE.Vector3());
    const up = new THREE.Vector3(0, 1, 0);
    const over = this.kind === 'throw';
    // Aiming at the floor near your feet drops/tosses it there instead of hurling it at the
    // ground (which made it bounce and roll away): the throw gets softer the further down you look.
    const down = Math.min(1, Math.max(0, (-dir.y - 0.2) / 0.7));   // 0 above ~12° down, 1 at ~65°+
    const soft = 1 - down * (over ? 0.78 : 0.6);
    const vel = dir.clone().multiplyScalar((over ? 15 : 6.2) * soft).addScaledVector(up, (over ? 2.4 : 3.2) * (1 - down * 0.85));
    vel.x += this.player.vel.x; vel.z += this.player.vel.z;
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(cam.quaternion);
    const spin = right.clone().multiplyScalar((over ? -14 : 8) * (1 - down * 0.8)).add(new THREE.Vector3((Math.random() - 0.5) * 4, (Math.random() - 0.5) * 4, (Math.random() - 0.5) * 4));
    this.onThrow(pos, vel, spin, { right });
    this.model.root.visible = false;
    this.audio.play('throw');
  }

  animate(dt) {
    const a = this.anim, m = this.model;
    const sw = this.sway.update(dt, { rate: 10 });
    const dr = drawOffset(this.raise, this.drawing);
    const pos = a.sample('pos', Z3), rot = a.sample('rot', Z3);
    const sp = this.player.sprinting && !a.playing ? 1 : 0;
    this.sprint = lerp(this.sprint || 0, sp, 1 - Math.exp(-8 * dt));
    this.pivot.position.set(
      HOLD[0] + pos[0] + sw.x + sw.bobX + dr.x - this.sprint * 0.02,
      HOLD[1] + pos[1] + sw.y + sw.bobY + sw.idle + dr.y - this.sprint * 0.05 - this.player.crouch * 0.01,
      HOLD[2] + pos[2] + dr.z
    );
    this.pivot.rotation.set(rot[0] + sw.y * 1.5 + dr.rx - this.sprint * 0.3, rot[1] + sw.x * 1.5, rot[2] + sw.x + dr.rz, 'YXZ');
    this.pivot.updateMatrixWorld(true);
    this.arms.setOn('right', this.anchors.palm, { roll: 0.3, fist: !this.inHand });
    const left = a.clip?.lh ? sampleHand(a.clip.lh, a.time, this.handTargets, _v) : _v.copy(this.handTargets.idle);
    if (!a.playing) left.add(_h.set(sw.x + sw.bobX + dr.x * 0.6, sw.y + sw.bobY + dr.y, dr.z));
    this.arms.set('left', left, { roll: -0.35, fist: !this.pinOut && !a.playing });
    // the pulled pin hangs from the left hand's fingers
    if (this.pinOut) {
      const pg = m.pinGroup;
      this.arms.left.g.getWorldQuaternion(_q);
      pg.position.copy(left).add(_h.set(0.03, 0.035, -0.03)).sub(m.ring.position.clone().multiplyScalar(1.15));
      pg.quaternion.copy(m.root.getWorldQuaternion(new THREE.Quaternion()));
      pg.scale.setScalar(1.15);
      pg.visible = a.time < 0.62;
    }
    m.spoon.visible = this.inHand;
  }
}
