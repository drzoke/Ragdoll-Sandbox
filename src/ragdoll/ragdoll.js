import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { PARTS, PART_BY_NAME } from './skeleton.js';
import { Health } from './health.js';
import { Brain } from './brain.js';
import { BrainV2 } from './brainV2.js';
import { ZombieBrain } from './zombie.js';
import { GROUP } from '../core/physics.js';
import { clamp, canvasTexture } from '../core/util.js';

export const GRAY = new THREE.MeshStandardMaterial({ color: 0x7f8286, roughness: 0.7, metalness: 0.0 });
export const BLACK = new THREE.MeshStandardMaterial({ color: 0x111214, roughness: 0.35, metalness: 0.1 });

/** Rotting green skin with dark patches, veins and old blood. */
function zombieSkinTexture() {
  return canvasTexture(256, 256, (g, w, h) => {
    g.fillStyle = '#7a8f66'; g.fillRect(0, 0, w, h);
    const blot = (x, y, r, col) => { const grd = g.createRadialGradient(x, y, 0, x, y, r); grd.addColorStop(0, col); grd.addColorStop(1, 'rgba(0,0,0,0)'); g.fillStyle = grd; g.fillRect(x - r, y - r, r * 2, r * 2); };
    for (let i = 0; i < 40; i++) blot(Math.random() * w, Math.random() * h, 10 + Math.random() * 34, `rgba(${40 + Math.random() * 30},${60 + Math.random() * 30},${30 + Math.random() * 20},${0.25 + Math.random() * 0.3})`);
    for (let i = 0; i < 18; i++) blot(Math.random() * w, Math.random() * h, 8 + Math.random() * 22, `rgba(150,160,110,${0.2 + Math.random() * 0.2})`);
    // veins
    g.strokeStyle = 'rgba(40,52,48,.45)'; g.lineWidth = 1.2;
    for (let i = 0; i < 14; i++) {
      let x = Math.random() * w, y = Math.random() * h; g.beginPath(); g.moveTo(x, y);
      for (let k = 0; k < 6; k++) { x += (Math.random() - 0.5) * 30; y += (Math.random() - 0.5) * 30; g.lineTo(x, y); }
      g.stroke();
    }
    // dried blood: splats with drips
    for (let i = 0; i < 9; i++) {
      const x = Math.random() * w, y = Math.random() * h, r = 6 + Math.random() * 16;
      g.fillStyle = `rgba(${90 + Math.random() * 40},${8 + Math.random() * 10},${6 + Math.random() * 8},${0.75 + Math.random() * 0.2})`;
      g.beginPath(); g.ellipse(x, y, r, r * (0.6 + Math.random() * 0.5), Math.random() * 3, 0, Math.PI * 2); g.fill();
      for (let k = 0; k < 4; k++) { const a = Math.random() * Math.PI * 2, d = r * (1 + Math.random()); g.beginPath(); g.arc(x + Math.cos(a) * d, y + Math.sin(a) * d, 1 + Math.random() * 3, 0, Math.PI * 2); g.fill(); }
      g.fillRect(x - 1.5, y, 3, r * (1 + Math.random() * 2));
    }
  });
}
export const ZOMBIE_SKIN = new THREE.MeshStandardMaterial({ map: zombieSkinTexture(), color: 0xffffff, roughness: 0.8, metalness: 0 });
export const ZOMBIE_JOINT = new THREE.MeshStandardMaterial({ color: 0x2a1a17, roughness: 0.45, metalness: 0.05 });
const ZOMBIE_EYE = new THREE.MeshStandardMaterial({ color: 0xe6e2a0, emissive: 0xc9c25a, emissiveIntensity: 0.35, roughness: 0.3 });
const EYE_GEO = new THREE.SphereGeometry(0.016, 10, 8);
// Armour: an olive ballistic helmet and a dark plate carrier
export const ARMOR_MATERIALS = {
  helmet: new THREE.MeshStandardMaterial({ color: 0x4d5434, roughness: 0.78, metalness: 0.05 }),
  vest: new THREE.MeshStandardMaterial({ color: 0x3c4134, roughness: 0.9, metalness: 0 }),
  plate: new THREE.MeshStandardMaterial({ color: 0x353a2e, roughness: 0.82, metalness: 0.05 }),
  strap: new THREE.MeshStandardMaterial({ color: 0x24271f, roughness: 0.9, metalness: 0 }),
  pouch: new THREE.MeshStandardMaterial({ color: 0x474d3c, roughness: 0.92, metalness: 0 }),
};
export const ARMOR_HP = { helmet: 100, vest: 220 };

const _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _qa = new THREE.Quaternion();
const _v = new THREE.Vector3(), _w = new THREE.Vector3();
const X = new THREE.Vector3(1, 0, 0), Y = new THREE.Vector3(0, 1, 0), Z = new THREE.Vector3(0, 0, 1);
// Torso + head; the share accounts for the limbs hanging off them.
const CORE = ['pelvis', 'abdomen', 'chest', 'head'];
const CORE_SHARE = 1.45;
const qx = (a, out = new THREE.Quaternion()) => out.setFromAxisAngle(X, a);
const qz = (a, out = new THREE.Quaternion()) => out.setFromAxisAngle(Z, a);

let geoCache = null;
function partGeometry(def) {
  geoCache ??= new Map();
  if (geoCache.has(def.name.replace(/[LR]$/, ''))) return geoCache.get(def.name.replace(/[LR]$/, ''));
  let g;
  const [sx, sy, sz] = def.size;
  if (def.shape === 'sphere') g = new THREE.SphereGeometry(sx, 28, 20);
  else if (/upperArm|lowerArm|thigh|shin/.test(def.name)) {
    const r = Math.min(sx, sz) / 2;
    g = new THREE.CapsuleGeometry(r, Math.max(0.01, sy - 2 * r), 6, 16);
  } else g = new RoundedBoxGeometry(sx, sy, sz, 3, Math.min(sx, sy, sz) * 0.3);
  geoCache.set(def.name.replace(/[LR]$/, ''), g);
  return g;
}

/**
 * A physically simulated humanoid: one cannon body per segment joined by cone-twist joints,
 * gray segment meshes, black joint balls, and "muscles" (velocity servos) that pull segments
 * towards a target pose supplied by the Brain. Damage and physiology live in Health.
 */
export class Ragdoll {
  constructor({ scene, physics, position, yaw = 0, name = 'Subject', armor = null, behavior = 'classic', zombie = false }) {
    this.scene = scene;
    this.physics = physics;
    this.name = name;
    this.health = new Health();
    this.parts = {};            // name -> { def, body, group, mesh, ball, constraint, pivotParent, pivotChild }
    this.root = new THREE.Group();
    scene.add(this.root);
    this.flinch = {};
    this.removed = false;

    const origin = new THREE.Vector3(...position);
    const yq = new THREE.Quaternion().setFromAxisAngle(Y, yaw);
    this.spawnYaw = yaw;

    for (const def of PARTS) {
      const restPos = new THREE.Vector3(...def.pos);
      const wp = restPos.clone().applyQuaternion(yq).add(origin);
      const shape = def.shape === 'sphere' ? new CANNON.Sphere(def.size[0]) : new CANNON.Box(new CANNON.Vec3(def.size[0] / 2, def.size[1] / 2, def.size[2] / 2));
      const body = new CANNON.Body({
        mass: def.mass, material: def.name.startsWith('foot') ? physics.materials.foot : physics.materials.flesh,
        collisionFilterGroup: GROUP.RAGDOLL, collisionFilterMask: GROUP.STATIC | GROUP.RAGDOLL | GROUP.PLAYER | GROUP.DEBRIS,
        linearDamping: 0.05, angularDamping: 0.3,
      });
      body.addShape(shape);
      body.position.set(wp.x, wp.y, wp.z);
      body.quaternion.set(yq.x, yq.y, yq.z, yq.w);
      body.userData = { ragdoll: this, part: def.name };
      physics.world.addBody(body);

      const group = new THREE.Group();
      const mesh = new THREE.Mesh(partGeometry(def), GRAY);
      mesh.castShadow = true; mesh.receiveShadow = true;
      mesh.userData = { ragdoll: this, part: def.name, surface: 'flesh' };
      group.add(mesh);
      this.root.add(group);

      this.parts[def.name] = { def, body, group, mesh, ball: null, constraint: null, restPos };
      this.flinch[def.name] = 0;
    }

    // Joints
    for (const def of PARTS) {
      if (!def.parent) continue;
      const p = this.parts[def.name], parent = this.parts[def.parent];
      const j = def.joint;
      const pivot = new THREE.Vector3(...j.pivot);
      const pivotA = pivot.clone().sub(parent.restPos);
      const pivotB = pivot.clone().sub(p.restPos);
      const axis = new THREE.Vector3(...j.axis);
      const axisA = axis.clone().applyAxisAngle(X, j.coneTilt);
      p.constraint = new CANNON.ConeTwistConstraint(parent.body, p.body, {
        pivotA: new CANNON.Vec3(pivotA.x, pivotA.y, pivotA.z), pivotB: new CANNON.Vec3(pivotB.x, pivotB.y, pivotB.z),
        axisA: new CANNON.Vec3(axisA.x, axisA.y, axisA.z), axisB: new CANNON.Vec3(axis.x, axis.y, axis.z),
        angle: j.angle, twistAngle: j.twist, collideConnected: false, maxForce: 1e5,
      });
      physics.world.addConstraint(p.constraint);
      p.pivotParent = pivotA; p.pivotChild = pivotB;
      const ball = new THREE.Mesh(new THREE.SphereGeometry(j.ball, 18, 12), BLACK);
      ball.position.copy(pivotB);
      ball.castShadow = true;
      ball.userData = { ragdoll: this, part: def.name, surface: 'flesh' };
      p.group.add(ball);
      p.ball = ball;
    }

    // Impact trauma (falls, being thrown or slammed with the grab tool). Collisions are only
    // recorded here (inside the physics step) and processed in update().
    this.impacts = [];         // queued { part, speed, point }
    this.impactCooldown = {};
    for (const def of PARTS) {
      const name = def.name;
      this.impactCooldown[name] = 0;
      this.parts[name].body.addEventListener('collide', (e) => {
        if (this.removed || this.parts[name].removed) return;
        const other = e.body === this.parts[name].body ? e.target : e.body;
        if (other?.userData?.ragdoll === this) return; // own limbs flopping against each other
        // Normal impact speed, capped near the body's own speed so a limb flicked by a muscle
        // doesn't count as a 40 m/s crash.
        const bv = this.parts[name].body.velocity;
        const v = Math.min(Math.abs(e.contact.getImpactVelocityAlongNormal()), Math.hypot(bv.x, bv.y, bv.z) * 1.25 + 2);
        if (v < 4 || this.impactCooldown[name] > 0) return;
        this.impactCooldown[name] = 0.12;
        const c = e.contact, bi = c.bi;
        const point = new THREE.Vector3(bi.position.x + c.ri.x, bi.position.y + c.ri.y, bi.position.z + c.ri.z);
        this.impacts.push({ part: name, speed: v, point, other });
      });
    }
    this.grabbed = false;      // held by the grab tool (Brain curls up)

    // Muscle targets (written by Brain each frame, applied each physics step)
    this.targetQ = {};
    this.prevTargetQ = {};
    this.targetW = {};          // feed-forward angular velocity per part
    for (const def of PARTS) {
      this.targetQ[def.name] = new THREE.Quaternion().copy(yq);
      this.prevTargetQ[def.name] = new THREE.Quaternion().copy(yq);
      this.targetW[def.name] = new THREE.Vector3();
    }
    this.strength = {};        // per part 0..1
    this.pelvisTarget = new THREE.Vector3();
    this.pelvisTargetVel = new THREE.Vector3();
    this.pelvisPosStrength = 0;
    this.gravityComp = 0;      // 0..1 share of body weight carried by muscles (standing)
    this.pelvisPosAxes = new THREE.Vector3(1, 1, 1); // which axes the pelvis positional servo controls
    this.footTarget = { L: new THREE.Vector3(), R: new THREE.Vector3() }; // stepping targets while walking
    this.footPosStrength = 0;
    this.chestTarget = null;   // optional height target for the chest (crawling)
    this.chestTargetVel = new THREE.Vector3();
    this.chestPosStrength = 0;

    this.armor = {};
    if (armor?.helmet) this.addArmor('helmet');
    if (armor?.vest) this.addArmor('vest');

    // Classic behaviour, or the experimental V2 that notices the player (hands up, fleeing...)
    this.behavior = behavior === 'v2' ? 'v2' : 'classic';
    this.zombie = false;
    if (zombie) this.makeZombie(origin, yaw);
    else this.brain = this.behavior === 'v2' ? new BrainV2(this, origin, yaw) : new Brain(this, origin, yaw);
    this._unsub = physics.onStep((h) => this.applyMuscles(h));
    // a settled corpse is put to sleep (see settle()); anything touching one wakes it
    this.asleep = false;
    this.stillTime = 0;
    for (const name in this.parts) this.parts[name].body.addEventListener('wakeup', () => { if (this.asleep) this.wake(); });
    this.sync();
  }

  get pelvis() { return this.parts.pelvis.body; }

  /**
   * Turn into a zombie: green rotting skin, dark joints, pale eyes, undead health and the zombie
   * brain. Used for spawned zombies and for the infected dead getting back up.
   */
  makeZombie(at = null, yaw = null) {
    this.zombie = true;
    this.behavior = 'zombie';
    const h = this.health;
    h.undead = true; h.alive = true; h.infected = false; h.infection = 0;
    h.cardiacArrest = false; h.brainDeath = 0; h.noCirculationTime = 0; h.deathCause = '';
    for (const p of Object.values(this.parts)) {
      p.mesh.material = ZOMBIE_SKIN;
      if (p.ball) p.ball.material = ZOMBIE_JOINT;
    }
    if (!this.eyes) {
      this.eyes = [];
      for (const s of [-1, 1]) {
        const e = new THREE.Mesh(EYE_GEO, ZOMBIE_EYE);
        e.position.set(s * 0.037, 0.018, 0.093);
        e.userData = { ragdoll: this, part: 'head', surface: 'flesh' };
        this.parts.head.group.add(e); this.eyes.push(e);
      }
    }
    const pp = at || this.bodyPos('pelvis');
    this.brain = new ZombieBrain(this, pp, yaw ?? this.heading());
  }

  /**
   * Put on a helmet or a vest. The shells are real hit targets (bullets, blades and fists hit them
   * first); straps and pouches are just for looks.
   */
  addArmor(kind) {
    if (this.armor[kind]) return;
    const M = ARMOR_MATERIALS;
    const hitMeshes = [], all = [];
    const mk = (geo, mat, part, hit = true, parent = null) => {
      const m = new THREE.Mesh(geo, mat);
      all.push(m);
      m.castShadow = true; m.receiveShadow = true;
      m.userData = { ragdoll: this, part, surface: 'armor', armor: kind, disposable: true };
      (parent || this.parts[part].group).add(m);
      if (hit) hitMeshes.push(m);
      return m;
    };
    if (kind === 'helmet') {
      // shell over the top, back and sides (tilted back so the face stays open), with a rim
      const holder = new THREE.Group();
      holder.position.set(0, 0.012, -0.01); holder.rotation.x = -0.32;
      this.parts.head.group.add(holder);
      all.push(holder);
      const R = 0.122, edge = Math.PI * 0.56;
      mk(new THREE.SphereGeometry(R, 28, 14, 0, Math.PI * 2, 0, edge), M.helmet, 'head', true, holder);
      const rim = mk(new THREE.TorusGeometry(Math.sin(edge) * R, 0.0075, 6, 32).rotateX(Math.PI / 2), M.helmet, 'head', false, holder);
      rim.position.y = Math.cos(edge) * R;
      // night-vision mount plate and the chin strap
      const mount = mk(new THREE.BoxGeometry(0.04, 0.03, 0.012), M.strap, 'head', false);
      mount.position.set(0, 0.075, 0.098); mount.rotation.x = 0.62;
      for (const sx of [1, -1]) {
        const strap = mk(new THREE.BoxGeometry(0.008, 0.11, 0.014), M.strap, 'head', false);
        strap.position.set(sx * 0.098, -0.04, 0.028); strap.rotation.set(-0.35, 0, sx * -0.18);
      }
    } else {
      const chest = PART_BY_NAME.chest.size, ab = PART_BY_NAME.abdomen.size;
      const front = mk(new RoundedBoxGeometry(chest[0] + 0.03, chest[1] + 0.02, chest[2] + 0.05, 2, 0.03), M.vest, 'chest');
      front.position.set(0, -0.005, 0.004);
      const low = mk(new RoundedBoxGeometry(ab[0] + 0.035, ab[1] * 0.85, ab[2] + 0.05, 2, 0.03), M.vest, 'abdomen');
      low.position.set(0, 0.012, 0.004);
      // front and back plates
      for (const z of [1, -1]) {
        const plate = mk(new RoundedBoxGeometry(0.25, 0.26, 0.022, 2, 0.008), M.plate, 'chest');
        plate.position.set(0, 0.005, z * (chest[2] / 2 + 0.034));
      }
      // shoulder straps
      for (const sx of [1, -1]) {
        const st = mk(new THREE.BoxGeometry(0.06, 0.03, chest[2] + 0.07), M.strap, 'chest', false);
        st.position.set(sx * 0.1, chest[1] / 2 + 0.012, 0.004);
      }
      // magazine / medical pouches on the belly
      for (let i = -1; i <= 1; i++) {
        const pouch = mk(new RoundedBoxGeometry(0.075, 0.1, 0.04, 2, 0.01), M.pouch, 'abdomen', false);
        pouch.position.set(i * 0.085, 0.01, ab[2] / 2 + 0.042);
        const flap = mk(new THREE.BoxGeometry(0.078, 0.022, 0.044), M.strap, 'abdomen', false);
        flap.position.set(i * 0.085, 0.058, ab[2] / 2 + 0.043);
      }
    }
    this.armor[kind] = { hp: ARMOR_HP[kind], max: ARMOR_HP[kind], meshes: hitMeshes, all, broken: false };
    this.meshesDirty = true;
  }

  /** Take a piece of armour off (it is gone from the body; see Gore.dropHelmet for a loose one). */
  removeArmor(kind) {
    const a = this.armor[kind];
    if (!a) return;
    for (const m of a.all) m.parent?.remove(m);
    delete this.armor[kind];
    this.meshesDirty = true;
  }

  /**
   * Place every body part straight into a pose (forward kinematics from the pelvis), e.g. to
   * start the title-screen corpse sitting against a wall. pelvisQ = world orientation.
   */
  placeInPose(pose, pelvisPos, pelvisQ) {
    this.wake();
    this.setPose({ ...pose, relative: false }, pelvisQ);
    const wp = {}, wq = {};
    for (const def of PARTS) {
      const p = this.parts[def.name], q = this.targetQ[def.name];
      let pos;
      if (!def.parent) pos = pelvisPos.clone();
      else {
        const pivot = p.pivotParent.clone().applyQuaternion(wq[def.parent]).add(wp[def.parent]);
        pos = pivot.sub(p.pivotChild.clone().applyQuaternion(q));
      }
      wp[def.name] = pos; wq[def.name] = q.clone();
      const b = p.body;
      b.position.set(pos.x, pos.y, pos.z);
      b.quaternion.set(q.x, q.y, q.z, q.w);
      b.velocity.set(0, 0, 0); b.angularVelocity.set(0, 0, 0);
      b.previousPosition?.copy(b.position);
    }
    this.sync();
  }

  bodyQuat(name, out = new THREE.Quaternion()) { const q = this.parts[name].body.quaternion; return out.set(q.x, q.y, q.z, q.w); }
  bodyPos(name, out = new THREE.Vector3()) { const p = this.parts[name].body.position; return out.set(p.x, p.y, p.z); }

  /** Move the whole ragdoll by an offset (elevator rides, carried up a ladder). */
  translate(dx, dy, dz) {
    for (const n in this.parts) {
      const b = this.parts[n].body;
      if (!b) continue;
      b.position.x += dx; b.position.y += dy; b.position.z += dz;
      b.previousPosition?.copy(b.position);
      b.interpolatedPosition?.copy(b.position);
      b.aabbNeedsUpdate = true;    // a sleeping body doesn't refresh its box by itself
    }
    const br = this.brain;
    for (const v of [br.root, br.home]) { v.x += dx; v.z += dz; }
    br.target = null;
    br.gy += dy;
    this.sync();
  }

  /** World-space position of a joint pivot (on the child side). */
  jointWorld(partName, out = new THREE.Vector3()) {
    const p = this.parts[partName];
    return out.copy(p.pivotChild).applyQuaternion(this.bodyQuat(partName, _qa)).add(this.bodyPos(partName, _w));
  }

  centre(out = new THREE.Vector3()) {
    out.set(0, 0, 0); let n = 0;
    for (const name of ['pelvis', 'abdomen', 'chest']) { out.add(this.bodyPos(name, _v)); n++; }
    return out.multiplyScalar(1 / n);
  }

  /** Heading (yaw) of the torso projected on the floor plane. */
  heading() {
    const f = new THREE.Vector3(0, 0, 1).applyQuaternion(this.bodyQuat('pelvis', _q));
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(_q);
    // When lying down, "forward" is roughly where the head points.
    const dir = Math.abs(f.y) > 0.7 ? up : f;
    return Math.atan2(dir.x, dir.z);
  }

  /** Builds target orientations from a pose description. See Brain for the pose fields. */
  setPose(pose, pelvisWorldQ, dt = 1 / 60) {
    const T = this.targetQ;
    for (const n in T) this.prevTargetQ[n].copy(T[n]);
    T.pelvis.copy(pelvisWorldQ);
    const rel = (name, local) => {
      const parentName = PART_BY_NAME[name].parent;
      // Children are posed relative to the parent's CURRENT orientation so the ragdoll can
      // hold a pose (e.g. curl up) whichever way it is lying.
      const base = pose.relative ? this.bodyQuat(parentName, _q2) : T[parentName];
      T[name].copy(base).multiply(local);
    };
    rel('abdomen', qx(pose.spine));
    rel('chest', qx(pose.chest).multiply(qz(pose.chestRoll || 0, _q)));
    rel('head', new THREE.Quaternion().setFromEuler(new THREE.Euler(pose.neck, pose.headYaw || 0, pose.headRoll || 0, 'YXZ')));
    for (const s of ['L', 'R']) {
      const side = s === 'L' ? 1 : -1;
      const sh = pose[`shoulder${s}`], hp = pose[`hip${s}`];
      rel(`upperArm${s}`, qx(-sh[0]).multiply(qz(side * sh[1], _q)));
      rel(`lowerArm${s}`, qx(-pose[`elbow${s}`]));
      rel(`hand${s}`, qx(0));
      rel(`thigh${s}`, qx(-hp[0]).multiply(qz(side * hp[1], _q)));
      rel(`shin${s}`, qx(pose[`knee${s}`]));
      rel(`foot${s}`, qx(pose[`ankle${s}`] || 0));
    }
    // Feed-forward angular velocity of the moving targets (removes most of the servo lag).
    for (const n in T) {
      _q.copy(T[n]).multiply(_qa.copy(this.prevTargetQ[n]).invert());
      if (_q.w < 0) { _q.x *= -1; _q.y *= -1; _q.z *= -1; _q.w *= -1; }
      const sh = Math.sqrt(_q.x * _q.x + _q.y * _q.y + _q.z * _q.z);
      const ang = 2 * Math.atan2(sh, _q.w);
      const ff = this.targetW[n];
      if (sh > 1e-6 && dt > 0) ff.set(_q.x / sh, _q.y / sh, _q.z / sh).multiplyScalar(Math.min(12, ang / dt));
      else ff.set(0, 0, 0);
      if (pose.relative) ff.multiplyScalar(0.3);
    }
  }

  applyMuscles(h) {
    if (this.removed) return;
    if (this.asleep) {
      // a blast, the defibrillator or the grab tool pushed a sleeping body: everything wakes up
      for (const name in this.parts) {
        const p = this.parts[name];
        if (p.removed) continue;
        const v = p.body.velocity, w = p.body.angularVelocity;
        if (v.x || v.y || v.z || w.x || w.y || w.z) { this.wake(); break; }
      }
      if (this.asleep) return;
    }
    const KP = 20, KD = 40;
    for (const name in this.parts) {
      const p = this.parts[name];
      if (p.removed) continue;
      // Safety net against solver blow-ups (body pinned against the floor by the grab beam etc.)
      const av = p.body.angularVelocity, wl = av.x * av.x + av.y * av.y + av.z * av.z;
      if (wl > 1600) av.scale(40 / Math.sqrt(wl), av);
      let s = this.strength[name] || 0;
      if (this.flinch[name] > 0) s *= 1 - clamp(this.flinch[name] / 0.35) * 0.92;
      if (s <= 0.001) continue;
      const b = p.body;
      _q.set(b.quaternion.x, b.quaternion.y, b.quaternion.z, b.quaternion.w);
      _q2.copy(this.targetQ[name]).multiply(_q.invert());
      if (_q2.w < 0) { _q2.x *= -1; _q2.y *= -1; _q2.z *= -1; _q2.w *= -1; }
      const sinHalf = Math.sqrt(_q2.x * _q2.x + _q2.y * _q2.y + _q2.z * _q2.z);
      const angle = 2 * Math.atan2(sinHalf, _q2.w);
      if (sinHalf > 1e-6) _v.set(_q2.x / sinHalf, _q2.y / sinHalf, _q2.z / sinHalf).multiplyScalar(angle * KP);
      else _v.set(0, 0, 0);
      _v.add(this.targetW[name]);
      const k = Math.min(1, s * KD * h);
      const w = b.angularVelocity;
      w.x += (_v.x - w.x) * k; w.y += (_v.y - w.y) * k; w.z += (_v.z - w.z) * k;
    }
    // Gravity compensation: while the legs are supporting the body, its weight is carried by
    // "muscles" so the positional servo only corrects small errors. Fades out as support is lost.
    const gc = this.gravityComp;
    if (gc > 0.001) {
      // Only the core: limbs keep their own weight (compensating them makes swinging arms
      // overshoot, since nothing pulls them back down).
      for (const name of CORE) {
        if (!this.health.parts[name].attached) continue;
        this.parts[name].body.velocity.y += 9.81 * h * gc * CORE_SHARE;
      }
    }
    // Pelvis positional servo ("legs holding the body up")
    if (this.pelvisPosStrength > 0.001 && this.parts.pelvis) {
      const b = this.pelvis, t = this.pelvisTarget, a = this.pelvisPosAxes;
      const k = Math.min(1, this.pelvisPosStrength * 30 * h);
      const vx = (t.x - b.position.x) * 9 + this.pelvisTargetVel.x;
      const vy = (t.y - b.position.y) * 11 + this.pelvisTargetVel.y;
      const vz = (t.z - b.position.z) * 9 + this.pelvisTargetVel.z;
      b.velocity.x += (vx - b.velocity.x) * k * a.x;
      b.velocity.y += (vy - b.velocity.y) * k * a.y;
      b.velocity.z += (vz - b.velocity.z) * k * a.z;
    }
    // Foot placement while walking: stance foot stays planted, swing foot steps forward.
    if (this.footPosStrength > 0.001) {
      for (const s of ['L', 'R']) {
        const name = `foot${s}`;
        if (!this.health.parts[name].attached) continue;
        const b = this.parts[name].body, t = this.footTarget[s];
        const k = Math.min(1, this.footPosStrength * (this.strength[name] || 0) * 40 * h);
        b.velocity.x += ((t.x - b.position.x) * 12 - b.velocity.x) * k;
        b.velocity.y += ((t.y - b.position.y) * 12 - b.velocity.y) * k;
        b.velocity.z += ((t.z - b.position.z) * 12 - b.velocity.z) * k;
      }
    }
    // Crawling: arms drag the upper body along the floor.
    if (this.chestTarget && this.chestPosStrength > 0.001) {
      const t = this.chestTarget, cv = this.chestTargetVel;
      for (const [name, mul] of [['chest', 1], ['abdomen', 0.8], ['pelvis', 0.6], ['upperArmL', 0.4], ['upperArmR', 0.4]]) {
        if (!this.health.parts[name].attached) continue;
        const b = this.parts[name].body;
        const k = Math.min(1, this.chestPosStrength * 90 * h * mul);
        b.velocity.x += (cv.x - b.velocity.x) * k;
        b.velocity.z += (cv.z - b.velocity.z) * k;
        if (name === 'chest') b.velocity.y += ((t.y - b.position.y) * 6 - b.velocity.y) * k * 0.5;
      }
    }
  }

  /** Bullet impulse + flinch reaction. */
  hitImpulse(partName, worldPoint, dirWorld, impulse) {
    const b = this.parts[partName].body;
    const rel = new CANNON.Vec3(worldPoint.x - b.position.x, worldPoint.y - b.position.y, worldPoint.z - b.position.z);
    b.applyImpulse(new CANNON.Vec3(dirWorld.x * impulse, dirWorld.y * impulse, dirWorld.z * impulse), rel);
    this.flinch[partName] = 0.35;
    const parent = PART_BY_NAME[partName].parent;
    if (parent && parent !== 'pelvis') this.flinch[parent] = Math.max(this.flinch[parent], 0.2);
    this.brain.onHit(partName, dirWorld);
  }

  /** Detach a limb at its joint. Returns the list of parts that came off. */
  sever(partName) {
    const p = this.parts[partName];
    if (!p.constraint || !this.health.parts[partName].attached) return [];
    this.physics.world.removeConstraint(p.constraint);
    p.constraint = null;
    if (p.ball) p.ball.visible = false;
    return this.health.sever(partName);
  }

  /**
   * Blow a body part apart. Limbs and the head are removed from the simulation entirely (their
   * children fall off as separate chunks); torso parts stay (they hold the skeleton together) and
   * are gutted visually by Gore. Returns { removed: [names], detached: [names] }.
   */
  explodePart(partName) {
    const p = this.parts[partName];
    const out = { removed: [], detached: [] };
    if (!p || p.removed) return out;
    const wasAttached = this.health.parts[partName].attached;
    const list = this.health.explode(partName);
    if (/chest|abdomen|pelvis/.test(partName)) return out;
    // Remove the part's own joint, and the joints of its direct children.
    if (p.constraint) { this.physics.world.removeConstraint(p.constraint); p.constraint = null; }
    for (const def of PARTS) {
      if (def.parent !== partName) continue;
      const c = this.parts[def.name];
      if (c.constraint) { this.physics.world.removeConstraint(c.constraint); c.constraint = null; }
      if (c.ball) c.ball.visible = false;
      out.detached.push(def.name);
    }
    this.physics.world.removeBody(p.body);
    p.removed = true;
    p.group.visible = false;
    out.removed.push(partName);
    out.wasAttached = wasAttached;
    out.list = list;
    this.meshesDirty = true;
    return out;
  }

  update(dt) {
    for (const n in this.flinch) if (this.flinch[n] > 0) this.flinch[n] -= dt;
    for (const n in this.impactCooldown) if (this.impactCooldown[n] > 0) this.impactCooldown[n] -= dt;
    this.health.update(dt);
    this.brain.update(dt);
    this.settle(dt);
    this.sync();
  }

  /**
   * Performance: a dead body that has stopped moving is taken out of the simulation (its bodies
   * sleep and its joints leave the solver) until something hits, pushes or grabs it. Many corpses
   * lying around then cost almost nothing per physics step.
   */
  settle(dt) {
    const h = this.health;
    if (h.alive || h.undead || this.grabbed || this.removed) {
      this.stillTime = 0;
      if (this.asleep) this.wake();
      return;
    }
    if (this.asleep || dt <= 0) return;
    // "still" = no part has drifted more than 2.5 cm from where it was when the wait started
    // (resting limbs keep jittering a little in place, so their speed never quite reaches zero)
    const anchor = this.stillAnchor || (this.stillAnchor = new Float32Array(PARTS.length * 3));
    let moved = this.stillTime === 0, i = 0;
    for (const name in this.parts) {
      const p = this.parts[name], b = p.body.position;
      if (!p.removed && !moved) {
        const dx = b.x - anchor[i], dy = b.y - anchor[i + 1], dz = b.z - anchor[i + 2];
        if (dx * dx + dy * dy + dz * dz > 0.025 * 0.025) moved = true;
      }
      i += 3;
    }
    if (moved) {
      i = 0;
      for (const name in this.parts) { const b = this.parts[name].body.position; anchor[i] = b.x; anchor[i + 1] = b.y; anchor[i + 2] = b.z; i += 3; }
      this.stillTime = 1e-6;
      return;
    }
    this.stillTime += dt;
    if (this.stillTime > 1.2) this.sleep();
  }

  sleep() {
    if (this.asleep) return;
    this.asleep = true;
    const world = this.physics.world;
    for (const name in this.parts) {
      const p = this.parts[name];
      if (p.removed) continue;
      p.body.sleep();
      if (p.constraint) world.removeConstraint(p.constraint);
    }
  }

  wake() {
    if (!this.asleep) return;
    this.asleep = false;
    this.stillTime = 0;
    const world = this.physics.world;
    for (const name in this.parts) {
      const p = this.parts[name];
      if (p.removed) continue;
      if (p.constraint && !world.constraints.includes(p.constraint)) world.addConstraint(p.constraint);
      p.body.wakeUp();
    }
  }

  sync() {
    for (const name in this.parts) {
      const { body, group, removed } = this.parts[name];
      if (removed) continue;
      group.position.set(body.position.x, body.position.y, body.position.z);
      group.quaternion.set(body.quaternion.x, body.quaternion.y, body.quaternion.z, body.quaternion.w);
    }
  }

  meshes() {
    const list = Object.values(this.parts).filter((p) => !p.removed).flatMap((p) => (p.ball && p.ball.visible ? [p.mesh, p.ball] : [p.mesh]));
    for (const a of Object.values(this.armor || {})) for (const m of a.meshes) if (!this.parts[m.userData.part].removed && m.parent) list.push(m);
    return list;
  }

  dispose() {
    this.removed = true;
    this._unsub();
    for (const p of Object.values(this.parts)) {
      if (p.constraint) this.physics.world.removeConstraint(p.constraint);
      if (!p.removed) this.physics.world.removeBody(p.body);
    }
    this.scene.remove(this.root);
    this.root.traverse((o) => { if (o.userData.disposable) { o.geometry?.dispose(); } });
  }
}
