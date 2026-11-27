import * as THREE from 'three';
import { damp, lerp, drawOffset, rand } from '../core/util.js';
import { Clip, ClipPlayer } from './anim.js';
import { BlockArms } from './arms.js';
import { viewmodelScene, Sway } from './viewmodel.js';
import { buildPaddle } from './modelsMedical.js';

const REACH = 2.1;
const CHARGE_TIME = 1.2;
const R_IDLE = [0.16, -0.2, -0.43], L_IDLE = [-0.16, -0.2, -0.43];
const R_CHARGE = [0.11, -0.17, -0.5], L_CHARGE = [-0.11, -0.17, -0.5];

const CLIPS = {
  shock: new Clip('shock', 0.62, {
    r: [[0, R_CHARGE], [0.07, [0.09, -0.15, -0.68]], [0.2, [0.09, -0.15, -0.66]], [0.62, R_IDLE]],
    l: [[0, L_CHARGE], [0.07, [-0.09, -0.15, -0.68]], [0.2, [-0.09, -0.15, -0.66]], [0.62, L_IDLE]],
  }, [[0.07, 'shock']]),
};

const _o = new THREE.Vector3(), _d = new THREE.Vector3(), _h = new THREE.Vector3(), _a = new THREE.Vector3(), _b = new THREE.Vector3();

/** Jagged electric arc between two points (redrawn every frame while it lives). */
class Arc {
  constructor(scene, color = 0x9fd8ff) {
    const n = 12;
    this.n = n;
    this.geo = new THREE.BufferGeometry();
    this.geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
    this.line = new THREE.Line(this.geo, new THREE.LineBasicMaterial({ color, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false }));
    this.line.frustumCulled = false;
    this.line.renderOrder = 10;
    this.line.visible = false;
    scene.add(this.line);
    this.life = 0;
  }
  fire(a, b, life = 0.16, jag = 0.03) { this.a = a.clone(); this.b = b.clone(); this.life = life; this.jag = jag; this.line.visible = true; }
  update(dt) {
    if (this.life <= 0) { this.line.visible = false; return; }
    this.life -= dt;
    const p = this.geo.attributes.position;
    for (let i = 0; i < this.n; i++) {
      const t = i / (this.n - 1), j = i === 0 || i === this.n - 1 ? 0 : this.jag;
      _h.copy(this.a).lerp(this.b, t);
      p.setXYZ(i, _h.x + rand(-j, j), _h.y + rand(-j, j), _h.z + rand(-j, j));
    }
    p.needsUpdate = true;
    this.line.material.opacity = Math.min(1, this.life * 12);
  }
}

/**
 * Defibrillator paddles. Hold left click to charge (about a second), let go to shock what the
 * paddles are on. On the chest of a ragdoll whose heart has stopped it can restart it, if the heart
 * and enough blood are left (a blood bag from the medkit helps). On a beating heart it can stop it.
 */
export class Defibrillator {
  constructor({ mainCamera, mainScene, player, audio, environment, gore, hud, targets, onTarget }) {
    this.name = 'Defibrillator';
    this.short = 'Defib';
    this.player = player; this.audio = audio; this.mainCamera = mainCamera; this.gore = gore; this.hud = hud;
    this.targets = targets; this.onTarget = onTarget;
    const vm = viewmodelScene(environment);
    this.scene = vm.scene; this.camera = vm.camera;
    this.pr = buildPaddle(1); this.pl = buildPaddle(-1);
    this.scene.add(this.pr.root, this.pl.root);
    this.arms = new BlockArms(this.scene, { handSize: 0.064 });
    this.raise = 0; this.drawing = true;
    this.anim = new ClipPlayer();
    this.sway = new Sway(player);
    this.time = 0;
    this.charge = 0;
    this.msg = null; this.msgT = 0;
    this.raycaster = new THREE.Raycaster();
    // effects: arcs in the world (on the body) and between the paddles (in your hands)
    this.worldArcs = [new Arc(mainScene), new Arc(mainScene, 0xd8f0ff)];
    this.vmArc = new Arc(this.scene);
    this.flash = new THREE.PointLight(0x9fd0ff, 0, 4, 2);
    mainScene.add(this.flash);
    this.flashT = 0;
  }

  resize(aspect) { this.camera.aspect = aspect; this.camera.updateProjectionMatrix(); }
  refill() {}
  get controls() { return [['Left click (hold)', 'Charge, let go to shock'], ['Aim', 'At the chest: restarts a stopped heart']]; }
  crosshair() { return { gap: 2, dot: true }; }
  status() {
    if (this.msgT > 0) return { title: 'Defibrillator', sub: this.msg };
    if (this.charge > 0 && this.charge < 1) return { title: 'Defibrillator', sub: `Charging… ${Math.round(this.charge * 100)}%` };
    if (this.charge >= 1) return { title: 'Defibrillator', sub: 'Charged: let go to shock' };
    const t = this.target;
    if (!t) return { title: 'Defibrillator', sub: 'Put the paddles on a chest' };
    const h = t.ragdoll.health;
    const heart = !h.alive ? 'dead' : h.cardiacArrest ? 'heart stopped' : `heart ${Math.round(h.heartRate)} bpm`;
    return { title: 'Defibrillator', sub: `${t.part === 'chest' ? 'Chest' : t.label} · ${heart}` };
  }
  say(text) { this.msg = text; this.msgT = 2.8; }

  pick() {
    const cam = this.mainCamera;
    cam.getWorldPosition(_o); cam.getWorldDirection(_d);
    this.raycaster.set(_o, _d); this.raycaster.far = REACH;
    const hit = this.raycaster.intersectObjects(this.targets(), false)[0];
    const ud = hit?.object.userData;
    if (!ud?.ragdoll || !ud.ragdoll.parts[ud.part] || ud.ragdoll.parts[ud.part].removed) return null;
    // the vest's chest piece counts as the chest (the paddles go on under it), and so does an arm
    // or the upper belly lying right over it: the paddles get pressed through to the ribs
    let part = ud.part;
    const chest = ud.ragdoll.parts.chest;
    if (part !== 'chest' && /upperArm|lowerArm|hand|abdomen/.test(part) && chest && !chest.removed) {
      const c = chest.body.position;
      if (Math.hypot(c.x - hit.point.x, c.y - hit.point.y, c.z - hit.point.z) < 0.3) part = 'chest';
    }
    return { ragdoll: ud.ragdoll, part, label: ud.ragdoll.health.parts[part].label, point: hit.point, dir: _d.clone() };
  }

  update(dt, input, active) {
    this.time += dt;
    this.msgT = Math.max(0, this.msgT - dt);
    const ready = active && this.raise > 0.9;
    this.target = ready ? this.pick() : null;
    if (this.target) this.onTarget?.(this.target.ragdoll);
    const busy = !!this.anim.clip;
    if (ready && !busy && input.mouseDown[0]) {
      if (this.charge === 0) { this.stopCharge = this.audio.charge(CHARGE_TIME); }
      const was = this.charge;
      this.charge = Math.min(1, this.charge + dt / CHARGE_TIME);
      if (this.charge >= 1 && was < 1) { this.stopCharge?.(); this.audio.play('beep'); this.beepT = 0; }
      if (this.charge >= 1) { this.beepT += dt; if (this.beepT > 0.45) { this.beepT = 0; this.audio.play('beep'); } }
    } else if (this.charge > 0) {
      this.stopCharge?.();
      if (this.charge >= 1 && ready) this.anim.play(CLIPS.shock, (e) => this.onEvent(e));
      else this.say('Not charged: hold the button until it beeps');
      this.charge = 0;
    }
    if (!ready && this.charge > 0) { this.stopCharge?.(); this.charge = 0; }
    this.anim.update(dt);
    for (const a of this.worldArcs) a.update(dt);
    this.vmArc.update(dt);
    this.flashT = Math.max(0, this.flashT - dt);
    this.flash.intensity = this.flashT > 0 ? 40 * (this.flashT / 0.14) : 0;
    this.animate(dt);
  }

  onEvent(e) {
    if (e !== 'shock') return;
    this.audio.play('zap');
    this.player.shake = Math.min(1, (this.player.shake || 0) + 0.25);
    const t = this.pick();
    if (!t) {
      // nothing between the paddles: it arcs across in your hands
      this.pr.face.updateWorldMatrix(true, false); this.pl.face.updateWorldMatrix(true, false);
      this.vmArc.fire(this.pr.face.getWorldPosition(_a), this.pl.face.getWorldPosition(_b), 0.18, 0.012);
      this.say('Shocked the air: put the paddles on a chest');
      return;
    }
    const r = t.ragdoll, h = r.health;
    this.onTarget?.(r);
    const res = h.defibrillate(t.part === 'chest' ? 'chest' : t.part);
    // arcs and a blue flash where the paddles touch
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(this.mainCamera.quaternion);
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(this.mainCamera.quaternion);
    const pA = t.point.clone().addScaledVector(right, 0.1).addScaledVector(up, 0.06).addScaledVector(t.dir, -0.02);
    const pB = t.point.clone().addScaledVector(right, -0.1).addScaledVector(up, -0.06).addScaledVector(t.dir, -0.02);
    this.worldArcs[0].fire(pA, pB, 0.16, 0.025);
    this.worldArcs[1].fire(pA, t.point, 0.12, 0.02);
    this.flash.position.copy(t.point).addScaledVector(t.dir, -0.15);
    this.flashT = 0.14;
    this.gore.sparks(pA, t.dir.clone().negate(), 5);
    this.gore.sparks(pB, t.dir.clone().negate(), 5);
    if (t.part === 'chest') this.gore.paddleMarks(r);
    // every muscle contracts at once: the body jerks
    for (const [name, p] of Object.entries(r.parts)) {
      if (p.removed || !h.parts[name].attached) continue;
      const b = p.body;
      const torso = /chest|abdomen|pelvis/.test(name);
      b.velocity.y += (torso ? 2.4 : 1.1) * rand(0.7, 1.1);
      b.angularVelocity.x += rand(-7, 7); b.angularVelocity.y += rand(-3, 3); b.angularVelocity.z += rand(-7, 7);
      r.flinch[name] = 0.3;
    }
    if (r.brain.state === 'stand') r.brain.fall();
    r.brain.fear = Math.min(1, r.brain.fear + 0.5);
    this.say(res.text);
    if (res.result === 'restarted') setTimeout(() => this.audio.play('beepGood'), 450);
    this.hud.toast?.(`${r.name}: ${res.text}`);
  }

  animate(dt) {
    const a = this.anim;
    const sw = this.sway.update(dt, { rate: 9 });
    const dr = drawOffset(this.raise, this.drawing);
    this.sprint = lerp(this.sprint || 0, this.player.sprinting ? 1 : 0, damp(8, dt));
    this.ch = lerp(this.ch || 0, this.charge > 0 ? 1 : 0, damp(10, dt));
    const breathe = Math.sin(this.time * 1.6) * 0.003;
    const buzz = this.charge >= 1 ? 0.0015 : 0;
    const place = (paddle, side, idle, charge) => {
      const base = idle.map((v, i) => lerp(v, charge[i], this.ch));
      const p = a.sample(side, base);
      _h.set(
        p[0] + sw.x + sw.bobX + dr.x * (side === 'r' ? 1 : -0.6) + rand(-buzz, buzz),
        p[1] + sw.y + sw.bobY + sw.idle + breathe + dr.y - this.sprint * 0.09 + rand(-buzz, buzz),
        p[2] + dr.z + this.sprint * 0.05
      );
      paddle.root.position.copy(_h);
      paddle.root.rotation.set(dr.rx * 0.6 - 0.1, (side === 'r' ? 0.22 : -0.22) * (1 - this.ch * 0.6), (side === 'r' ? 1 : -1) * dr.rz);
      paddle.buttonMat.emissive.setRGB(1, 0.5, 0.15).multiplyScalar(this.charge >= 1 ? 0.8 + 0.4 * Math.sin(this.time * 20) : this.charge * 0.5);
      this.arms.set(side === 'r' ? 'right' : 'left', _h, { fist: true, roll: side === 'r' ? 0.15 : -0.15 });
    };
    place(this.pr, 'r', R_IDLE, R_CHARGE);
    place(this.pl, 'l', L_IDLE, L_CHARGE);
  }
}
