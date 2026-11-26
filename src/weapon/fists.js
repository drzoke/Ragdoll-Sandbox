import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { damp, lerp, drawOffset } from '../core/util.js';
import { Clip, ClipPlayer } from './anim.js';
import { BlockArms } from './arms.js';
import { viewmodelScene, Sway } from './viewmodel.js';

// Guard: both fists up in front of the face. Positions are camera space.
const GUARD_R = [0.125, -0.135, -0.43], GUARD_L = [-0.12, -0.12, -0.46];
const REACH = 1.6; // m

const jab = (side) => {
  const g = side === 'r' ? GUARD_R : GUARD_L, s = side === 'r' ? 1 : -1;
  const out = [0.035 * s, -0.065, -0.68], other = side === 'r' ? GUARD_L : GUARD_R;
  const tuck = [other[0] * 0.92, other[1] + 0.01, other[2] + 0.03];
  return new Clip(`jab${side}`, 0.34, {
    [side]: [[0, g], [0.03, [g[0], g[1] + 0.005, g[2] + 0.025]], [0.09, out], [0.13, out], [0.32, g]],
    [`${side}roll`]: [[0, 0], [0.09, -1.35 * s], [0.13, -1.35 * s], [0.32, 0]],
    [side === 'r' ? 'l' : 'r']: [[0, other], [0.09, tuck], [0.3, other]],
    look: [[0, 0], [0.09, 0.012 * s], [0.3, 0]],
  }, [[0.02, 'whoosh'], [0.085, 'hit']]);
};

const CLIPS = {
  jabL: jab('l'),
  jabR: jab('r'),
  // right hook: wind back, swing across the screen, follow through
  hook: new Clip('hook', 0.56, {
    r: [[0, GUARD_R], [0.13, [0.25, -0.1, -0.33]], [0.2, [0.15, -0.06, -0.58]], [0.25, [0.0, -0.06, -0.64]], [0.31, [-0.1, -0.09, -0.55]], [0.54, GUARD_R]],
    rroll: [[0, 0], [0.13, 0.4], [0.25, -1.6], [0.31, -1.75], [0.54, 0]],
    l: [[0, GUARD_L], [0.13, [GUARD_L[0] + 0.02, GUARD_L[1] + 0.02, GUARD_L[2] + 0.02]], [0.3, [GUARD_L[0] - 0.04, GUARD_L[1] - 0.01, GUARD_L[2] + 0.05]], [0.54, GUARD_L]],
    look: [[0, 0], [0.13, 0.02], [0.27, -0.045], [0.5, 0]],
  }, [[0.13, 'whoosh'], [0.23, 'hit']]),
};

const _o = new THREE.Vector3(), _d = new THREE.Vector3(), _h = new THREE.Vector3();

/**
 * Bare fists. Left click throws fast jabs (alternating hands), right click a slower, much harder
 * hook. Punches bruise, stagger and can knock the ragdoll down or out.
 */
export class Fists {
  constructor({ mainCamera, player, audio, environment, gore, hud, targets }) {
    this.name = 'Fists';
    this.player = player; this.audio = audio; this.mainCamera = mainCamera; this.gore = gore; this.hud = hud;
    this.targets = targets;
    const vm = viewmodelScene(environment);
    this.scene = vm.scene; this.camera = vm.camera;
    this.arms = new BlockArms(this.scene, { handSize: 0.064, shoulderRight: [0.25, -0.42, -0.1], shoulderLeft: [-0.25, -0.42, -0.1] });
    this.raise = 0; this.drawing = true;
    this.anim = new ClipPlayer();
    this.nextHand = 'l';
    this.queued = null;
    this.sway = new Sway(player);
    this.time = 0;
    this.raycaster = new THREE.Raycaster();
  }

  resize(aspect) { this.camera.aspect = aspect; this.camera.updateProjectionMatrix(); }
  refill() {}
  get controls() { return [['Left click', 'Jab (left, right)'], ['Right click', 'Hook (hits hard)']]; }
  status() { return { title: 'Fists', sub: 'Jab · Hook' }; }
  crosshair() { return { gap: 4, dot: true }; }

  update(dt, input, active) {
    this.time += dt;
    const ready = active && this.raise > 0.9;
    if (ready) {
      if (input.mousePressed[0]) this.queued = 'jab';
      if (input.mousePressed[2]) this.queued = 'hook';
    }
    // a punch can be queued during the last part of the previous one
    const clip = this.anim.clip;
    const canChain = !clip || (clip.name !== 'hook' ? this.anim.time > 0.2 : this.anim.time > 0.42);
    if (this.queued && canChain && !this.player.sprinting) {
      if (this.queued === 'jab') { this.anim.play(this.nextHand === 'l' ? CLIPS.jabL : CLIPS.jabR, (e) => this.onEvent(e)); this.power = 0.5; this.hand = this.nextHand; this.nextHand = this.nextHand === 'l' ? 'r' : 'l'; }
      else { this.anim.play(CLIPS.hook, (e) => this.onEvent(e)); this.power = 1; this.hand = 'r'; this.nextHand = 'l'; }
      this.queued = null;
    }
    if (!ready) this.queued = null;
    this.anim.update(dt);
    this.animate(dt);
  }

  onEvent(e) {
    if (e === 'whoosh') this.audio.play('whoosh');
    if (e === 'hit') this.strike();
  }

  strike() {
    const cam = this.mainCamera;
    cam.getWorldPosition(_o); cam.getWorldDirection(_d);
    // aim a touch towards the punching hand
    const side = this.hand === 'r' ? 1 : -1;
    _d.addScaledVector(new THREE.Vector3(1, 0, 0).applyQuaternion(cam.quaternion), side * 0.02).normalize();
    this.raycaster.set(_o, _d); this.raycaster.far = REACH;
    const hit = this.raycaster.intersectObjects(this.targets(), false)[0];
    const power = this.power;
    this.player.addRecoil(-0.004 * power, -side * 0.006 * power);
    if (!hit) return;
    const ud = hit.object.userData;
    if (ud.ragdoll) {
      const r = ud.ragdoll, part = r.parts[ud.part];
      if (!part || part.removed) return;
      const res = r.health.punch(ud.part, power);
      const imp = (power > 0.8 ? 19 : 9) * (ud.part === 'head' ? 0.75 : 1);
      const b = part.body;
      b.applyImpulse(new CANNON.Vec3(_d.x * imp, _d.y * imp + imp * 0.12, _d.z * imp), new CANNON.Vec3(hit.point.x - b.position.x, hit.point.y - b.position.y, hit.point.z - b.position.z));
      r.flinch[ud.part] = 0.35;
      const knock = res.knockout || (ud.part === 'head' && power > 0.8 && Math.random() < 0.55) || (power > 0.8 && Math.random() < 0.15);
      r.brain.onPunch(ud.part, _d, knock);
      this.gore.addBruise(r, ud.part, hit.point, power * 0.75);
      if (res.bleed) this.gore.spray(hit.point, _d.clone().negate().add(new THREE.Vector3(0, 0.4, 0)), 8 + power * 10, { speed: 1.4, spread: 0.6, size: 0.012, volume: 0.6 });
      if (res.fractured) this.audio.play('bone');
      this.audio.play(power > 0.8 ? 'punchHard' : 'punch');
      this.hud.hitMarker(false);
      this.player.shake = Math.min(1, (this.player.shake || 0) + 0.25 * power);
      this.impactKick = 1;
    } else if (ud.gib) {
      ud.gib.body.applyImpulse(new CANNON.Vec3(_d.x * 1.5, _d.y * 1.5 + 0.6, _d.z * 1.5));
      this.audio.play('punch');
    } else if (ud.grenade) {
      ud.grenade.body.applyImpulse(new CANNON.Vec3(_d.x * 1.6 * power, 0.8 * power, _d.z * 1.6 * power));
      this.audio.play('clink');
    } else if (ud.button) { ud.button.press(); this.audio.play('punch'); }
    else {
      // knuckles on concrete
      this.audio.play('thud');
      const n = hit.face ? hit.face.normal.clone().transformDirection(hit.object.matrixWorld) : new THREE.Vector3(0, 1, 0);
      this.gore.dust(hit.point, n, 6);
      this.impactKick = 1.3;
    }
  }

  animate(dt) {
    const a = this.anim;
    const sw = this.sway.update(dt, { rate: 9 });
    const dr = drawOffset(this.raise, this.drawing);
    this.impactKick = Math.max(0, (this.impactKick || 0) - dt * 8);
    const sp = this.player.sprinting ? 1 : 0;
    this.sprint = lerp(this.sprint || 0, sp, damp(8, dt));
    // guard bob: fists bounce a little, like a boxer's stance
    const bounce = Math.sin(this.time * 4.2) * 0.004 * (1 - this.sprint);
    const place = (side, base) => {
      const p = a.sample(side, base);
      _h.set(
        p[0] + sw.x + sw.bobX + dr.x * (side === 'r' ? 1 : -0.6),
        p[1] + sw.y + sw.bobY + sw.idle + bounce * (side === 'r' ? 1 : 0.7) + dr.y - this.sprint * 0.09 - this.player.crouch * 0.01,
        p[2] + dr.z + this.sprint * 0.06 + (a.clip && a.clip.tracks[side] && a.time > 0.08 && a.time < 0.16 ? this.impactKick * 0.02 : 0)
      );
      const roll = a.sample(`${side}roll`, 0) + (side === 'r' ? -0.25 : 0.25) + dr.rz;
      this.arms.set(side === 'r' ? 'right' : 'left', _h, { fist: true, roll });
    };
    place('r', GUARD_R);
    place('l', GUARD_L);
  }
}
