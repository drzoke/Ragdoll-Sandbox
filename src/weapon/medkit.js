import * as THREE from 'three';
import { damp, lerp, drawOffset } from '../core/util.js';
import { Clip, ClipPlayer } from './anim.js';
import { BlockArms } from './arms.js';
import { viewmodelScene, Sway } from './viewmodel.js';
import { buildMedkit } from './modelsMedical.js';

const REACH = 2.3;
const TREAT_TIME = 0.95;     // s holding the button
const R_IDLE = [0.15, -0.21, -0.41], L_IDLE = [-0.2, -0.25, -0.46];

const CLIPS = {
  morphine: new Clip('morphine', 0.8, {
    r: [[0, R_IDLE], [0.18, [0.16, -0.14, -0.36]], [0.32, [0.04, -0.13, -0.68]], [0.45, [0.04, -0.13, -0.66]], [0.8, R_IDLE]],
    rr: [[0, 0], [0.18, -1.3], [0.45, -1.4], [0.8, 0]],
  }, [[0.32, 'inject']]),
  blood: new Clip('blood', 1.05, {
    r: [[0, R_IDLE], [0.3, [0.08, 0.02, -0.5]], [0.7, [0.06, 0.04, -0.52]], [1.05, R_IDLE]],
    rr: [[0, 0], [0.3, 0.2], [1.05, 0]],
  }, [[0.15, 'tape'], [0.62, 'blood']]),
};

const _o = new THREE.Vector3(), _d = new THREE.Vector3(), _h = new THREE.Vector3();

/**
 * Medkit. Look at a body part and hold left click to treat it: pressure bandages on its wounds,
 * a tourniquet above a stump, a splint on a broken bone, a dressing on a bad burn. Right click
 * gives morphine (pain relief: a second dose slows the breathing), R hangs a 750 ml blood bag.
 */
export class Medkit {
  constructor({ mainCamera, player, audio, environment, gore, hud, targets, onTarget }) {
    this.name = 'Medkit';
    this.player = player; this.audio = audio; this.mainCamera = mainCamera; this.gore = gore; this.hud = hud;
    this.targets = targets; this.onTarget = onTarget;
    const vm = viewmodelScene(environment);
    this.scene = vm.scene; this.camera = vm.camera;
    this.model = buildMedkit();
    this.left = new THREE.Group(); this.right = new THREE.Group();
    this.scene.add(this.left, this.right);
    this.left.add(this.model.pouch);
    this.model.pouch.rotation.set(0.35, 0.45, 0.1);
    this.model.pouch.position.set(0.02, 0.03, 0);
    this.model.pouch.scale.setScalar(0.72);
    this.right.add(this.model.roll, this.model.injector, this.model.bag);
    this.model.roll.position.set(-0.01, 0.03, -0.02);
    this.model.injector.rotation.x = -Math.PI / 2; this.model.injector.position.set(0, 0.02, -0.06);
    this.model.bag.position.set(0, 0.08, -0.01);
    this.arms = new BlockArms(this.scene, { handSize: 0.064 });
    this.raise = 0; this.drawing = true;
    this.anim = new ClipPlayer();
    this.sway = new Sway(player);
    this.time = 0;
    this.treatT = 0;           // 0..1 progress of the current treatment
    this.msg = null; this.msgT = 0;
    this.target = null;        // { ragdoll, part }
    this.raycaster = new THREE.Raycaster();
  }

  resize(aspect) { this.camera.aspect = aspect; this.camera.updateProjectionMatrix(); }
  refill() {}
  get controls() { return [['Left click (hold)', 'Treat the part you look at'], ['Right click', 'Morphine (pain relief)'], ['R', 'Blood bag (+750 ml)']]; }
  crosshair() { return { gap: 2, dot: true, med: true }; }

  status() {
    if (this.msgT > 0) return { title: 'Medkit', sub: this.msg };
    if (this.treatT > 0) return { title: 'Medkit', sub: `Treating the ${this.target?.label.toLowerCase() || 'wound'}… ${Math.round(this.treatT * 100)}%` };
    const t = this.target;
    if (!t) return { title: 'Medkit', sub: 'Look at a ragdoll up close' };
    const h = t.ragdoll.health;
    if (!h.alive) return { title: 'Medkit', sub: `${t.ragdoll.name} is dead` };
    const can = h.treatable(t.part);
    return { title: 'Medkit', sub: `${t.label}: ${can.length ? can.join(', ') : 'nothing to treat here'}` };
  }

  say(text) { this.msg = text; this.msgT = 2.4; }

  /** The ragdoll part under the crosshair, within arm's reach. */
  pick() {
    const cam = this.mainCamera;
    cam.getWorldPosition(_o); cam.getWorldDirection(_d);
    this.raycaster.set(_o, _d); this.raycaster.far = REACH;
    const hit = this.raycaster.intersectObjects(this.targets(), false)[0];
    const ud = hit?.object.userData;
    if (!ud?.ragdoll) return null;
    const r = ud.ragdoll;
    if (!r.parts[ud.part] || r.parts[ud.part].removed) return null;
    return { ragdoll: r, part: ud.part, label: r.health.parts[ud.part].label, point: hit.point };
  }

  update(dt, input, active) {
    this.time += dt;
    this.msgT = Math.max(0, this.msgT - dt);
    const ready = active && this.raise > 0.9;
    this.target = ready ? this.pick() : null;
    if (this.target) this.onTarget?.(this.target.ragdoll);
    const busy = !!this.anim.clip;

    // hold to treat
    const t = this.target;
    if (ready && !busy && input.mouseDown[0] && t) {
      const can = t.ragdoll.health.treatable(t.part);
      if (!can.length && this.treatT === 0) { if (input.mousePressed[0]) { this.audio.play('deny'); this.say(`${t.label}: nothing to treat here`); } }
      else {
        if (this.treatT === 0) { this.audio.play('tape'); this.treating = t; }
        if (this.treating && (this.treating.ragdoll !== t.ragdoll || this.treating.part !== t.part)) { this.treatT = 0; this.treating = null; }
        else {
          this.treatT = Math.min(1, this.treatT + dt / TREAT_TIME);
          if (this.treatT >= 1) { this.finishTreat(t); this.treatT = 0; this.treating = null; }
        }
      }
    } else {
      if (ready && input.mousePressed[0] && !t) { this.audio.play('deny'); this.say('Look at a ragdoll up close'); }
      this.treatT = 0; this.treating = null;
    }
    if (ready && !busy && input.mousePressed[2]) {
      if (t) { this.anim.play(CLIPS.morphine, (e) => this.onEvent(e)); this.useOn = t; }
      else { this.audio.play('deny'); this.say('Look at a ragdoll up close'); }
    }
    if (ready && !busy && input.wasPressed('KeyR')) {
      if (t) { this.anim.play(CLIPS.blood, (e) => this.onEvent(e)); this.useOn = t; }
      else { this.audio.play('deny'); this.say('Look at a ragdoll up close'); }
    }
    this.hud.setProgress?.(this.treatT);
    this.anim.update(dt);
    this.animate(dt);
  }

  finishTreat(t) {
    const r = t.ragdoll, h = r.health;
    const before = h.wounds.filter((w) => w.part === t.part && w.rate >= 0.04 && !w.bandaged && !w.tourniquet);
    const burnBefore = h.parts[t.part].dressed;
    const res = h.treat(t.part);
    if (!res.any) { this.audio.play('deny'); return; }
    const done = before.filter((w) => w.bandaged || w.tourniquet);
    if (res.dressed && !burnBefore) done.push({ part: t.part, pos: new THREE.Vector3(0, 0, 0), normal: new THREE.Vector3(0, 0, 1), rate: 0 });
    this.gore.bandage(r, t.part, done);
    if (res.splinted) this.gore.splint(r, t.part);
    this.audio.play('zip');
    const bits = [];
    if (res.tourniquet) bits.push('tourniquet on');
    if (res.bandaged) bits.push(`${res.bandaged} wound${res.bandaged > 1 ? 's' : ''} bandaged`);
    if (res.splinted) bits.push('splinted');
    if (res.dressed) bits.push('burn dressed');
    const s = bits.join(', ');
    this.say(`${t.label}: ${s}`);
  }

  onEvent(e) {
    const t = this.useOn;
    if (e === 'tape') this.audio.play('tape');
    if (!t || t.ragdoll.removed) return;
    const h = t.ragdoll.health;
    if (e === 'inject') {
      this.audio.play('inject');
      if (!h.alive) { this.say(`${t.ragdoll.name} is dead`); return; }
      h.giveMorphine();
      this.say(h.morphine > 1.6 ? 'Morphine: that is too much, its breathing slows' : 'Morphine given: the pain fades');
    }
    if (e === 'blood') {
      if (!h.alive) { this.say(`${t.ragdoll.name} is dead`); return; }
      h.giveBlood(750);
      this.audio.play('zip');
      this.say('Blood bag running in (+750 ml)');
    }
  }

  animate(dt) {
    const a = this.anim;
    const sw = this.sway.update(dt, { rate: 9 });
    const dr = drawOffset(this.raise, this.drawing);
    this.sprint = lerp(this.sprint || 0, this.player.sprinting ? 1 : 0, damp(8, dt));
    const breathe = Math.sin(this.time * 1.6) * 0.003;
    // treating: the right hand reaches out and wraps round and round
    this.wrap = lerp(this.wrap || 0, this.treatT > 0 ? 1 : 0, damp(10, dt));
    const W = this.wrap, ang = this.time * 13;
    const rp = a.sample('r', R_IDLE);
    _h.set(
      lerp(rp[0], 0.05 + Math.cos(ang) * 0.045, W) + sw.x + sw.bobX + dr.x,
      lerp(rp[1], -0.16 + Math.sin(ang) * 0.035, W) + sw.y + sw.bobY + sw.idle + breathe + dr.y - this.sprint * 0.09,
      lerp(rp[2], -0.6, W) + dr.z
    );
    this.right.position.copy(_h);
    this.right.rotation.set(dr.rx * 0.6 + a.sample('rr', 0) * 0.3, -0.25, dr.rz + Math.sin(ang) * 0.4 * W);
    this.arms.set('right', _h, { roll: a.sample('rr', 0) });
    const showInj = a.clip?.name === 'morphine', showBag = a.clip?.name === 'blood';
    this.model.roll.visible = !showInj && !showBag;
    this.model.injector.visible = showInj;
    this.model.bag.visible = showBag;
    _h.set(L_IDLE[0] + sw.x * 0.7 + sw.bobX, L_IDLE[1] + sw.y + sw.bobY + breathe * 0.8 + dr.y - this.sprint * 0.1 + W * 0.02, L_IDLE[2] + dr.z + W * -0.05);
    this.left.position.copy(_h);
    this.left.rotation.set(dr.rx * 0.6, 0, -dr.rz);
    this.arms.set('left', _h, { roll: 0.2 });
  }
}
