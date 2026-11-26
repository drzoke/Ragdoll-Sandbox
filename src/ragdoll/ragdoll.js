import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { PARTS, PART_BY_NAME } from './skeleton.js';
import { Health } from './health.js';
import { Brain } from './brain.js';
import { GROUP } from '../core/physics.js';
import { clamp } from '../core/util.js';

const GRAY = new THREE.MeshStandardMaterial({ color: 0x7f8286, roughness: 0.7, metalness: 0.0 });
const BLACK = new THREE.MeshStandardMaterial({ color: 0x111214, roughness: 0.35, metalness: 0.1 });

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
  constructor({ scene, physics, position, yaw = 0, name = 'Subject' }) {
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

    this.brain = new Brain(this, origin, yaw);
    this._unsub = physics.onStep((h) => this.applyMuscles(h));
    this.sync();
  }

  get pelvis() { return this.parts.pelvis.body; }

  bodyQuat(name, out = new THREE.Quaternion()) { const q = this.parts[name].body.quaternion; return out.set(q.x, q.y, q.z, q.w); }
  bodyPos(name, out = new THREE.Vector3()) { const p = this.parts[name].body.position; return out.set(p.x, p.y, p.z); }

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
    this.sync();
  }

  sync() {
    for (const name in this.parts) {
      const { body, group, removed } = this.parts[name];
      if (removed) continue;
      group.position.set(body.position.x, body.position.y, body.position.z);
      group.quaternion.set(body.quaternion.x, body.quaternion.y, body.quaternion.z, body.quaternion.w);
    }
  }

  meshes() { return Object.values(this.parts).filter((p) => !p.removed).flatMap((p) => (p.ball && p.ball.visible ? [p.mesh, p.ball] : [p.mesh])); }

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
