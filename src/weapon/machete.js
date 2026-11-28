import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { damp, lerp, drawOffset } from '../core/util.js';
import { Clip, ClipPlayer } from './anim.js';
import { BlockArms } from './arms.js';
import { viewmodelScene, Sway } from './viewmodel.js';
import { buildMachete } from './modelsMedical.js';
import { settings } from '../settings.js';

const REACH = 1.95;     // m
const STAB_REACH = 1.75;
// Hand position (camera space) and blade orientation: [blade direction xyz, edge direction xyz].
const IDLE_P = [0.17, -0.2, -0.42];
const IDLE_R = [-0.22, 0.88, -0.42, -0.92, 0.05, -0.38];
const GUARD_L = [-0.18, -0.25, -0.42];

const CLIPS = {
  // forehand: from up behind the right shoulder, across to the lower left
  slashA: new Clip('slashA', 0.62, {
    pos: [[0, IDLE_P], [0.13, [0.29, 0.0, -0.3]], [0.21, [0.08, -0.12, -0.6]], [0.3, [-0.2, -0.32, -0.46]], [0.62, IDLE_P]],
    rot: [[0, IDLE_R], [0.13, [0.45, 0.65, 0.6, -0.75, 0.2, -0.65]], [0.21, [-0.6, 0.15, -0.8, -0.8, -0.3, 0.5]], [0.3, [-0.9, -0.3, 0.2, 0.1, -0.95, 0.3]], [0.62, IDLE_R]],
    l: [[0, GUARD_L], [0.13, [-0.2, -0.22, -0.46]], [0.3, [-0.26, -0.36, -0.3]], [0.62, GUARD_L]],
    look: [[0, 0], [0.13, 0.025], [0.24, -0.04], [0.55, 0]],
  }, [[0.11, 'swing'], [0.2, 'hit']]),
  // backhand: from the left, edge leading to the right
  slashB: new Clip('slashB', 0.62, {
    pos: [[0, IDLE_P], [0.13, [-0.12, 0.0, -0.34]], [0.21, [0.03, -0.12, -0.6]], [0.3, [0.26, -0.3, -0.46]], [0.62, IDLE_P]],
    rot: [[0, IDLE_R], [0.13, [-0.55, 0.65, 0.45, 0.7, 0.2, -0.7]], [0.21, [0.6, 0.15, -0.8, 0.8, -0.3, 0.5]], [0.3, [0.9, -0.3, 0.2, -0.1, -0.95, 0.3]], [0.62, IDLE_R]],
    l: [[0, GUARD_L], [0.13, [-0.24, -0.3, -0.34]], [0.62, GUARD_L]],
    look: [[0, 0], [0.13, -0.02], [0.24, 0.035], [0.55, 0]],
  }, [[0.11, 'swing'], [0.2, 'hit']]),
  // thrust straight ahead, edge down
  stab: new Clip('stab', 0.58, {
    pos: [[0, IDLE_P], [0.13, [0.19, -0.15, -0.28]], [0.2, [0.05, -0.12, -0.72]], [0.28, [0.05, -0.12, -0.7]], [0.58, IDLE_P]],
    rot: [[0, IDLE_R], [0.13, [0.02, 0.1, -1, 0, -1, -0.1]], [0.28, [0.0, 0.08, -1, 0, -1, -0.08]], [0.58, IDLE_R]],
    l: [[0, GUARD_L], [0.13, [-0.16, -0.22, -0.44]], [0.58, GUARD_L]],
    look: [[0, 0], [0.13, 0.012], [0.21, -0.02], [0.5, 0]],
  }, [[0.12, 'swing'], [0.19, 'hit']]),
};

const _o = new THREE.Vector3(), _d = new THREE.Vector3(), _h = new THREE.Vector3(), _b = new THREE.Vector3(), _e = new THREE.Vector3(), _z = new THREE.Vector3();
const _m = new THREE.Matrix4();

/**
 * Machete. Left click slashes (forehand, then backhand): long bleeding cuts that get deeper on
 * the same spot, can cut tendons and arteries and, with dismemberment on, chop through limbs and
 * the neck. Right click stabs deep into the body (organs). Blood builds up on the blade.
 */
export class Machete {
  constructor({ mainCamera, player, audio, environment, gore, hud, targets, onTarget }) {
    this.name = 'Machete';
    this.player = player; this.audio = audio; this.mainCamera = mainCamera; this.gore = gore; this.hud = hud;
    this.targets = targets; this.onTarget = onTarget;
    const vm = viewmodelScene(environment);
    this.scene = vm.scene; this.camera = vm.camera;
    this.hand = new THREE.Group(); this.scene.add(this.hand);
    this.model = buildMachete();
    this.model.root.position.y = -0.01;
    this.hand.add(this.model.root);
    this.arms = new BlockArms(this.scene, { handSize: 0.064, shoulderRight: [0.25, -0.42, -0.1], shoulderLeft: [-0.25, -0.42, -0.1] });
    this.raise = 0; this.drawing = true;
    this.anim = new ClipPlayer();
    this.next = 'slashA';
    this.queued = null;
    this.sway = new Sway(player);
    this.time = 0;
    this.blood = 0;
    this.raycaster = new THREE.Raycaster();
  }

  resize(aspect) { this.camera.aspect = aspect; this.camera.updateProjectionMatrix(); }
  refill() { this.blood = 0; }
  get controls() { return [['Left click', 'Slash (cuts deeper on the same spot)'], ['Right click', 'Stab (deep, into organs)']]; }
  status() { return { title: 'Machete', sub: 'Slash · Stab' }; }
  crosshair() { return { gap: 3, dot: true }; }

  update(dt, input, active) {
    this.time += dt;
    const ready = active && this.raise > 0.9;
    if (ready) {
      if (input.mousePressed[0]) this.queued = 'slash';
      if (input.mousePressed[2]) this.queued = 'stab';
      // holding the button keeps swinging
      if (!this.queued && !this.anim.clip && input.mouseDown[0]) this.queued = 'slash';
    }
    const clip = this.anim.clip;
    const canChain = !clip || this.anim.time > 0.44;
    if (this.queued && canChain && !this.player.sprinting) {
      if (this.queued === 'slash') { this.kind = 'slash'; this.dirSide = this.next === 'slashA' ? -1 : 1; this.anim.play(CLIPS[this.next], (e) => this.onEvent(e)); this.next = this.next === 'slashA' ? 'slashB' : 'slashA'; }
      else { this.kind = 'stab'; this.anim.play(CLIPS.stab, (e) => this.onEvent(e)); this.next = 'slashA'; }
      this.queued = null;
    }
    if (!ready) this.queued = null;
    this.anim.update(dt);
    this.blood = Math.max(0, this.blood - dt * 0.004);
    this.model.bloodMat.opacity = Math.min(0.9, this.blood);
    this.animate(dt);
  }

  onEvent(e) {
    if (e === 'swing') this.audio.play('swing');
    if (e === 'hit') this.strike();
  }

  /** The blade's path: a fan of rays swept across the swing (or one straight ray for a stab). */
  findHit() {
    const cam = this.mainCamera;
    cam.getWorldPosition(_o);
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(cam.quaternion);
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(cam.quaternion);
    const fwd = cam.getWorldDirection(new THREE.Vector3());
    const list = this.targets();
    const tryRay = (dir, far) => {
      this.raycaster.set(_o, dir); this.raycaster.far = far;
      return this.raycaster.intersectObjects(list, false)[0] || null;
    };
    if (this.kind === 'stab') return { hit: tryRay(fwd, STAB_REACH), dir: fwd, along: fwd.clone() };
    // the blade sweeps across the view: what's under the crosshair is hit first, then whatever is
    // closest to it along the swing (so a wide swing still connects with a near miss)
    const along = right.clone().multiplyScalar(this.dirSide).addScaledVector(up, -0.35).normalize();
    const offsets = [0];
    for (let i = 1; i <= 6; i++) offsets.push(i * 0.085, -i * 0.085);
    for (const a of offsets) {
      const dir = fwd.clone().addScaledVector(right, Math.tan(a)).addScaledVector(up, Math.tan(-a * 0.3 * this.dirSide)).normalize();
      const hit = tryRay(dir, REACH);
      if (hit) return { hit, dir, along };
    }
    return { hit: null };
  }

  strike() {
    const { hit, dir, along } = this.findHit();
    const stab = this.kind === 'stab';
    const side = this.dirSide || 1;
    this.player.addRecoil(-0.003, side * 0.004);
    if (!hit) return;
    const ud = hit.object.userData;
    const power = stab ? 0.95 : 0.82 + Math.random() * 0.18;
    if (ud.ragdoll && (!ud.ragdoll.parts[ud.part] || ud.ragdoll.parts[ud.part].removed)) return;
    const n = hit.face ? hit.face.normal.clone().transformDirection(hit.object.matrixWorld) : dir.clone().negate();
    const what = ud.ragdoll ? { ragdoll: ud.ragdoll, part: ud.part, armor: ud.armor || null } : ud.gib ? { gib: ud.gib } : ud.grenade ? { grenade: ud.grenade } : ud.button ? { button: ud.button } : null;
    const res = what ? this.act('cut', { ...what, point: hit.point.clone(), dir: dir.clone(), along: along.clone(), normal: n, power, kind: this.kind }) : null;
    if (ud.armor) {
      // blade on a helmet or plate: it bounces off with a clang
      this.audio.play('clang');
      this.onTarget?.(ud.ragdoll);
      this.recoilKick = 1;
      return;
    }
    if (ud.ragdoll) {
      this.audio.play(stab ? 'stab' : 'slice');
      if (res?.bones.length) this.audio.play('bone');
      this.hud.hitMarker(!!res && (res.organs.length > 0 || res.vessels.length > 0));
      this.onTarget?.(ud.ragdoll);
      this.blood = Math.min(0.95, this.blood + (stab ? 0.35 : 0.25));
      this.player.shake = Math.min(1, (this.player.shake || 0) + 0.18);
      this.recoilKick = 0.6;
    } else if (ud.gib) this.audio.play('slice');
    else if (ud.grenade) this.audio.play('clink');
    else if (ud.button) this.audio.play('clang');
    else {
      // steel on concrete
      const wn = hit.face ? hit.face.normal.clone().transformDirection(hit.object.matrixWorld) : new THREE.Vector3(0, 1, 0);
      this.audio.play('clang');
      this.gore.sparks(hit.point, wn, 10);
      this.gore.dust(hit.point, wn, 5);
      this.recoilKick = 1.2;
    }
  }

  /** What a hit does to the world. Multiplayer, as a friend: `remote` sends it to the host's game, which runs it. */
  act(name, a) { return this.remote ? this.remote(this, name, a) : this.run(name, a); }

  run(name, a) {
    if (name !== 'cut') return null;
    const { dir, along, power } = a, stab = a.kind === 'stab';
    if (a.ragdoll && a.armor) {
      const r = a.ragdoll, ar = r.armor[a.armor];
      if (ar) ar.hp = Math.max(0, ar.hp - 4);
      r.health.blunt(a.part, 0.3, { helmet: a.armor === 'helmet' });
      const b = r.parts[a.part].body;
      b.applyImpulse(new CANNON.Vec3(dir.x * 6, dir.y * 6, dir.z * 6), new CANNON.Vec3(a.point.x - b.position.x, a.point.y - b.position.y, a.point.z - b.position.z));
      r.brain.onPunch(a.part, dir, false);
      this.gore.armorHit(r, a.part, a.point, a.normal, 0.02);
      return null;
    }
    if (a.ragdoll) {
      const r = a.ragdoll, part = r.parts[a.part];
      if (!part || part.removed) return null;
      const g = part.group;
      const inv = g.quaternion.clone().invert();
      const localEntry = a.point.clone().sub(g.position).applyQuaternion(inv);
      const localDir = dir.clone().applyQuaternion(inv);
      const res = r.health.cut(a.part, localEntry, localDir, power, a.kind, { dismember: settings.get('dismemberment') });
      const push = stab ? dir.clone() : along.clone().multiplyScalar(0.75).addScaledVector(dir, 0.5).normalize();
      r.hitImpulse(a.part, a.point, push, stab ? 7 : 5.5);
      this.gore.bladeWound(r, res, a.point, dir, along);
      if (res.opened) this.gore.openPart(r, a.part, res.wound);
      if (res.dismember && r.sever(a.part).length) {
        this.gore.onSever(r, a.part);
        part.body.applyImpulse(new CANNON.Vec3(along.x * 3, along.y * 3 + 1.5, along.z * 3));
      }
      // a cut Achilles tendon or hamstring drops it
      if (res.tendon && /shin|thigh/.test(res.tendon) && r.brain.state === 'stand') r.brain.fall();
      return res;
    }
    if (a.gib) a.gib.body.applyImpulse(new CANNON.Vec3(dir.x * 1.5, dir.y * 1.5 + 0.5, dir.z * 1.5));
    else if (a.grenade) a.grenade.body.applyImpulse(new CANNON.Vec3(dir.x * 1.4, 0.6, dir.z * 1.4));
    else if (a.button) a.button.press();
    return null;
  }

  animate(dt) {
    const a = this.anim;
    const sw = this.sway.update(dt, { rate: 9 });
    const dr = drawOffset(this.raise, this.drawing);
    this.recoilKick = Math.max(0, (this.recoilKick || 0) - dt * 7);
    this.sprint = lerp(this.sprint || 0, this.player.sprinting ? 1 : 0, damp(8, dt));
    const breathe = Math.sin(this.time * 1.7) * 0.003;
    // right hand + blade
    const p = a.sample('pos', IDLE_P), q = a.sample('rot', IDLE_R);
    // a blade stopped by something hard is knocked back a little
    const kick = this.recoilKick * 0.04;
    this.hand.position.set(
      p[0] + sw.x + sw.bobX + dr.x,
      p[1] + sw.y + sw.bobY + sw.idle + breathe + dr.y - this.sprint * 0.08 - this.player.crouch * 0.01,
      p[2] + dr.z + kick + this.sprint * 0.05
    );
    _b.set(q[0], q[1], q[2]).normalize();
    _e.set(q[3], q[4], q[5]);
    _e.addScaledVector(_b, -_e.dot(_b)).normalize();
    _z.crossVectors(_e, _b);
    _m.makeBasis(_e, _b, _z);
    this.hand.quaternion.setFromRotationMatrix(_m);
    // holster / draw tips the blade down out of view; sprinting carries it low
    this.hand.rotateX(dr.rx * 0.8 - this.sprint * 0.5);
    this.hand.rotateZ(dr.rz);
    this.arms.set('right', this.hand.position, { fist: true, roll: 0.3 });
    const l = a.sample('l', GUARD_L);
    _h.set(l[0] + sw.x * 0.6 + sw.bobX, l[1] + sw.y + sw.bobY + breathe * 0.7 + dr.y - this.sprint * 0.12, l[2] + dr.z);
    this.arms.set('left', _h, { fist: true, roll: 0.25 });
  }
}
