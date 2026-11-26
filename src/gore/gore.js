import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { CONFIG } from '../config.js';
import { Particles } from './particles.js';
import { Decals } from './decals.js';
import { PART_BY_NAME } from '../ragdoll/skeleton.js';
import { GROUP } from '../core/physics.js';
import { rand } from '../core/util.js';
import { settings } from '../settings.js';

const G = CONFIG.gore;
const _v = new THREE.Vector3(), _n = new THREE.Vector3(), _q = new THREE.Quaternion();
const Zf = new THREE.Vector3(0, 0, 1);
const _w1 = new THREE.Vector3(), _w2 = new THREE.Vector3(), _w3 = new THREE.Vector3();

const MAT = {
  meat: new THREE.MeshStandardMaterial({ color: 0x6e0b0b, roughness: 0.35, metalness: 0.05 }),
  meatDark: new THREE.MeshStandardMaterial({ color: 0x2a0303, roughness: 0.5 }),
  bone: new THREE.MeshStandardMaterial({ color: 0xe8e0cc, roughness: 0.55 }),
  gut: new THREE.MeshStandardMaterial({ color: 0xc77a6e, roughness: 0.25, metalness: 0.05 }),
  lung: new THREE.MeshStandardMaterial({ color: 0xc98a90, roughness: 0.4 }),
  brain: new THREE.MeshStandardMaterial({ color: 0xd59aa0, roughness: 0.4 }),
  organ: new THREE.MeshStandardMaterial({ color: 0x7a1c22, roughness: 0.3 }),
};

/**
 * All blood & gore: droplets, spurts, pools, wound decals, stumps, exposed organs, gibs.
 * Driven by the Health model of each ragdoll (wounds array), plus one-shot events from hits.
 */
export class Gore {
  constructor(scene, physics, map, audio) {
    this.scene = scene; this.physics = physics; this.audio = audio;
    this.particles = new Particles(scene, G.maxParticles, map.colliders);
    this.decals = new Decals(scene, G.maxPools, G.maxDecals);
    this.particles.onLand = (x, y, z, vol, size) => this.decals.addDrop(x, y, z, vol, size);
    this.particles.onWall = (x, y, z, nx, ny, nz, vx, vy, vz, vol, size) =>
      this.decals.addWallSplat(_w1.set(x, y, z), _w2.set(nx, ny, nz), _w3.set(vx, vy, vz), vol, size);
    this.bruises = [];       // { ragdoll, part, mesh, local, sev, age, soot }
    this.gibs = [];
    this.woundVisuals = new Map(); // wound object -> {decal, stain}
    this.applyBloodColor();
    settings.onChange((k) => { if (k === 'bloodColor') this.applyBloodColor(); });
  }

  /** Blood colour setting (red / purple): particles, pools, wound decals, stumps. */
  applyBloodColor() {
    const b = settings.blood;
    this.hue = b.particle;
    this.decals.setBloodTint(b);
    MAT.meat.color.setHex(b.meat);
    MAT.meatDark.color.setHex(b.meatDark);
  }

  /** Blood particle colour at a given brightness. */
  bc(shade) { const h = this.hue; return [h[0] * shade, h[1] * shade, h[2] * shade]; }

  /** Organ material, or plain meat when organs are hidden in the gore settings. */
  organMat(m) { return settings.get('showOrgans') ? m : MAT.meat; }

  // ---------------------------------------------------------------- spray helpers
  spray(pos, dir, count, { speed = 2.5, spread = 0.5, size = 0.018, volume = 1.2, life = 3 } = {}) {
    for (let i = 0; i < count; i++) {
      const s = speed * (0.4 + Math.random() * 0.8);
      const vx = dir.x + (Math.random() - 0.5) * spread * 2, vy = dir.y + (Math.random() - 0.5) * spread * 2, vz = dir.z + (Math.random() - 0.5) * spread * 2;
      const l = Math.hypot(vx, vy, vz) || 1;
      const shade = 0.3 + Math.random() * 0.18;
      this.particles.spawn(pos.x, pos.y, pos.z, (vx / l) * s, (vy / l) * s, (vz / l) * s,
        { size: size * (0.5 + Math.random()), life, color: this.bc(shade), volume });
    }
  }

  dust(pos, normal, count = 10) {
    for (let i = 0; i < count; i++) {
      const s = 0.4 + Math.random() * 1.4;
      this.particles.spawn(pos.x, pos.y + 0.01, pos.z,
        (normal.x + (Math.random() - 0.5)) * s, (normal.y + Math.random() * 0.5) * s, (normal.z + (Math.random() - 0.5)) * s,
        { size: 0.03 + Math.random() * 0.03, life: 0.6 + Math.random() * 0.6, color: [0.55, 0.55, 0.55], kind: 1 });
    }
  }

  // ---------------------------------------------------------------- bullet events
  bulletImpactWorld(point, normal) {
    this.decals.addHole(point, normal);
    this.dust(point, normal, 12);
  }

  /**
   * A bullet that already went through someone hits a wall/floor: it carries blood with it and
   * leaves a spatter around its hole.
   */
  bloodyImpactWorld(point, normal, dir, amount = 1) {
    const tang = _v.copy(dir).addScaledVector(normal, -dir.dot(normal)).multiplyScalar(4);
    if (Math.abs(normal.y) > 0.7) this.decals.addDrop(point.x, point.y + 0.001, point.z, 4 * amount, 0.03 * amount);
    else this.decals.addWallSplat(point, normal, tang, 4 * amount, 0.026 * Math.sqrt(amount));
    // a little spray bouncing off
    const out = _n.copy(normal).multiplyScalar(0.8).addScaledVector(dir, 0.4);
    this.spray(point.clone().addScaledVector(normal, 0.01), out, Math.round(6 * amount), { speed: 1.2, spread: 0.7, size: 0.012, volume: 0.5 });
  }

  /**
   * Shotgun pellets punch a cone of blood out of the far side of the body part even when the
   * pellet stops inside: this is what paints the wall behind someone.
   */
  pelletSpatter(ragdoll, partName, entryWorld, dir) {
    const part = ragdoll.parts[partName];
    const def = part.def;
    const depth = def.shape === 'sphere' ? def.size[0] * 2 : Math.max(def.size[0], def.size[2]);
    const back = _v.copy(entryWorld).addScaledVector(dir, depth * 0.9);
    for (let i = 0; i < 9; i++) {
      const s = rand(3.5, 8);
      const vx = dir.x + rand(-0.32, 0.32), vy = dir.y + rand(-0.25, 0.35), vz = dir.z + rand(-0.32, 0.32);
      const l = Math.hypot(vx, vy, vz) || 1;
      this.particles.spawn(back.x + rand(-0.03, 0.03), back.y + rand(-0.03, 0.03), back.z + rand(-0.03, 0.03),
        (vx / l) * s, (vy / l) * s, (vz / l) * s, { size: rand(0.012, 0.03), life: 2.5, color: this.bc(rand(0.3, 0.48)), volume: 1.6 });
    }
  }

  // ---------------------------------------------------------------- bruises
  /**
   * Purple bruise where something blunt hit (punch, slam, blast). Nearby bruises merge and darken.
   * severity 0..1. soot = black blast residue instead of a bruise.
   */
  addBruise(ragdoll, partName, worldPoint, severity, { soot = false } = {}) {
    const part = ragdoll.parts[partName];
    if (!part || part.removed || severity <= 0.02) return;
    const g = part.group;
    const inv = _q.copy(g.quaternion).invert();
    const local = worldPoint.clone().sub(g.position).applyQuaternion(inv);
    // outward normal from the part's shape (box: the face the point is closest to)
    const def = part.def;
    let n;
    if (def.shape === 'sphere') n = local.lengthSq() > 1e-6 ? local.clone().normalize() : new THREE.Vector3(0, 0, 1);
    else {
      const hx = def.size[0] / 2, hy = def.size[1] / 2, hz = def.size[2] / 2;
      const ax = Math.abs(local.x) / hx, ay = Math.abs(local.y) / hy, az = Math.abs(local.z) / hz;
      n = ax >= ay && ax >= az ? new THREE.Vector3(Math.sign(local.x) || 1, 0, 0) : ay >= az ? new THREE.Vector3(0, Math.sign(local.y) || 1, 0) : new THREE.Vector3(0, 0, Math.sign(local.z) || 1);
    }
    // merge with a bruise close by on the same part
    for (const b of this.bruises) {
      if (b.ragdoll !== ragdoll || b.part !== partName || b.soot !== soot) continue;
      if (b.local.distanceTo(local) < 0.05 + b.size * 0.3) {
        b.sev = Math.min(1.6, b.sev + severity * 0.6);
        b.size = Math.min(0.2, b.size + severity * 0.02);
        b.mesh.scale.setScalar(b.size);
        b.age = Math.min(b.age, 1);
        return;
      }
    }
    const surf = this.surfacePoint(part, local.clone().addScaledVector(n, -0.01), n);
    const size = (soot ? 0.1 : 0.07) + severity * (soot ? 0.12 : 0.09);
    const mesh = this.decals.addBruise(g, surf.point, surf.normal, size, soot);
    const mine = this.bruises.filter((b) => b.ragdoll === ragdoll);
    if (mine.length >= 28) { const old = mine[0]; old.mesh.parent?.remove(old.mesh); old.mesh.material.dispose(); this.bruises.splice(this.bruises.indexOf(old), 1); }
    this.bruises.push({ ragdoll, part: partName, mesh, local: surf.point.clone(), sev: severity, size, age: 0, soot });
  }

  /** Bruises come up over a second or two, then darken from red-purple to deep purple. */
  updateBruises(dt) {
    const fresh = new THREE.Color(0.36, 0.05, 0.26), deep = new THREE.Color(0.16, 0.03, 0.26), old = new THREE.Color(0.13, 0.05, 0.19);
    for (let i = this.bruises.length - 1; i >= 0; i--) {
      const b = this.bruises[i];
      if (b.ragdoll.removed) { this.bruises.splice(i, 1); continue; }
      b.age += dt;
      const m = b.mesh.material;
      if (b.soot) { m.color.setRGB(0.02, 0.018, 0.016); m.opacity = Math.min(0.92, b.age * 6) * Math.min(1, 0.55 + b.sev * 0.5); continue; }
      const k1 = Math.min(1, b.age / 10), k2 = Math.min(1, Math.max(0, b.age - 20) / 120);
      m.color.copy(fresh).lerp(deep, k1).lerp(old, k2);
      m.opacity = Math.min(1, b.age / 1.6) * Math.min(0.95, 0.35 + b.sev * 0.55);
    }
  }

  /** Called for each body part a bullet passes through. */
  bulletWound(ragdoll, res, entryWorld, dirWorld) {
    const part = ragdoll.parts[res.partName];
    const group = part.group;
    // Back-spatter at the entry, heavy forward spray at the exit.
    this.spray(entryWorld, _n.copy(dirWorld).negate(), 14, { speed: 1.6, spread: 0.6, size: 0.014, volume: 0.6 });
    const addVis = (wound) => {
      // place decal on the visual mesh surface: raycast in local space from outside towards the part centre
      const p = wound.pos.clone(), n = wound.normal.clone();
      const surf = this.surfacePoint(part, p, n);
      this.woundVisuals.set(wound, this.decals.addWound(group, surf.point, surf.normal, wound.exit, wound.exit ? 0.038 : 0.032));
    };
    addVis(res.wound);
    if (res.exitWound) {
      addVis(res.exitWound);
      const exitWorld = res.exitWound.pos.clone().applyQuaternion(group.quaternion).add(group.position);
      this.spray(exitWorld, dirWorld, 34, { speed: 4.5, spread: 0.35, size: 0.02, volume: 1.4 });
    }
    if (res.organs.some((o) => o.hp <= 0) && Math.random() < 0.6) {
      const at = (res.exitWound || res.wound).pos.clone().applyQuaternion(group.quaternion).add(group.position);
      this.spawnGib(at, dirWorld.clone().multiplyScalar(3), this.organMat(res.organs[0].id === 'brain' ? MAT.brain : MAT.organ));
    }
    if (res.bones.length && res.exit && Math.random() < 0.5) {
      const at = res.exitWound.pos.clone().applyQuaternion(group.quaternion).add(group.position);
      this.spawnGib(at, dirWorld.clone().multiplyScalar(3.5), MAT.bone, 0.012);
    }
  }

  /** Find the point on the visual mesh where a local-space ray enters (decals sit on the real surface). */
  surfacePoint(part, localPoint, localNormal) {
    const rc = new THREE.Raycaster();
    rc.set(localPoint.clone().addScaledVector(localNormal, 0.2), localNormal.clone().negate());
    // raycast a transform-free copy so everything stays in the part's local space
    const tmp = new THREE.Mesh(part.mesh.geometry, part.mesh.material);
    tmp.updateMatrixWorld();
    const hits = rc.intersectObject(tmp, false);
    if (hits.length) {
      hits.sort((a, b) => a.distance - b.distance);
      const n = hits[0].face ? hits[0].face.normal.clone() : localNormal.clone();
      return { point: hits[0].point, normal: n.normalize() };
    }
    return { point: localPoint, normal: localNormal };
  }

  // ---------------------------------------------------------------- dismemberment
  onSever(ragdoll, partName) {
    const def = PART_BY_NAME[partName];
    const child = ragdoll.parts[partName], parent = ragdoll.parts[def.parent];
    const r = def.shape === 'sphere' ? 0.05 : Math.min(def.size[0], def.size[2]) * 0.5;
    const axis = new THREE.Vector3(...def.joint.axis);
    this.addStump(parent.group, child.pivotParent, axis, r);
    this.addStump(child.group, child.pivotChild, axis.clone().negate(), r);
    const at = ragdoll.jointWorld(partName);
    this.spray(at, new THREE.Vector3(0, 0.5, 0), 70, { speed: 3, spread: 0.9, size: 0.022, volume: 2 });
    for (let i = 0; i < 2; i++) this.spawnGib(at, new THREE.Vector3(rand(-2, 2), rand(1, 3), rand(-2, 2)), MAT.meat);
    this.audio.play('splat');
  }

  addStump(group, localPos, outward, r) {
    const g = new THREE.Group();
    g.position.copy(localPos);
    g.quaternion.setFromUnitVectors(Zf, outward);
    const cap = new THREE.Mesh(new THREE.CircleGeometry(r * 1.08, 18), MAT.meat);
    cap.position.z = 0.004;
    const ring = new THREE.Mesh(new THREE.TorusGeometry(r * 0.95, r * 0.22, 6, 18), MAT.meatDark);
    const bone = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.28, r * 0.33, 0.035, 10).rotateX(Math.PI / 2), MAT.bone);
    bone.position.z = 0.012;
    for (const m of [cap, ring, bone]) { m.castShadow = true; g.add(m); }
    // a few ragged meat chunks
    for (let i = 0; i < 4; i++) {
      const c = new THREE.Mesh(new THREE.IcosahedronGeometry(r * rand(0.2, 0.35), 0), MAT.meat);
      const a = Math.random() * Math.PI * 2;
      c.position.set(Math.cos(a) * r * 0.75, Math.sin(a) * r * 0.75, 0.006);
      g.add(c);
    }
    group.add(g);
  }

  // ---------------------------------------------------------------- exposed organs
  openPart(ragdoll, partName, wound) {
    const part = ragdoll.parts[partName];
    const p = wound.pos.clone(), n = wound.normal.clone();
    const surf = this.surfacePoint(part, p, n);
    const g = new THREE.Group();
    g.position.copy(surf.point);
    g.quaternion.setFromUnitVectors(Zf, surf.normal);
    const hole = new THREE.Mesh(new THREE.CircleGeometry(partName === 'head' ? 0.045 : 0.07, 20), MAT.meatDark);
    hole.scale.set(1, 0.75, 1);
    hole.position.z = 0.002;
    g.add(hole);
    const rim = new THREE.Mesh(new THREE.TorusGeometry(partName === 'head' ? 0.045 : 0.07, 0.012, 6, 22), MAT.meat);
    rim.scale.set(1, 0.75, 1);
    g.add(rim);

    const organs = settings.get('showOrgans');
    if (partName === 'chest') {
      for (let i = -2; i <= 2; i++) {
        const rib = new THREE.Mesh(new THREE.CapsuleGeometry(0.0055, 0.1, 3, 6).rotateZ(Math.PI / 2), MAT.bone);
        rib.position.set(0, i * 0.02, -0.004);
        rib.rotation.z = (Math.random() - 0.5) * 0.25;
        if (Math.random() < 0.35) { rib.scale.x = 0.45; rib.position.x = rand(-0.03, 0.03); rib.rotation.y = rand(-0.4, 0.4); }
        g.add(rib);
      }
      if (organs) {
        const lung = new THREE.Mesh(new THREE.SphereGeometry(0.04, 12, 10), MAT.lung);
        lung.scale.set(1, 1.2, 0.45); lung.position.set(0.02, 0.005, -0.012);
        g.add(lung);
      }
    } else if ((partName === 'abdomen' || partName === 'pelvis') && organs) {
      // intestines spilling out
      for (let k = 0; k < 2; k++) {
        const pts = [];
        let x = rand(-0.02, 0.02), y = rand(-0.02, 0.02), z = -0.01;
        for (let i = 0; i < 9; i++) {
          pts.push(new THREE.Vector3(x, y, z));
          x += rand(-0.03, 0.03); y += rand(-0.035, 0.01) - (i > 4 ? 0.02 : 0); z = Math.min(0.07, z + rand(0.0, 0.02));
        }
        const tube = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 40, 0.012, 8, false), MAT.gut);
        tube.castShadow = true;
        g.add(tube);
      }
    } else if (partName === 'head') {
      for (let i = 0; i < (organs ? 6 : 0); i++) {
        const b = new THREE.Mesh(new THREE.SphereGeometry(rand(0.012, 0.02), 8, 6), MAT.brain);
        b.position.set(rand(-0.025, 0.025), rand(-0.018, 0.018), rand(-0.01, 0.004));
        g.add(b);
      }
      for (let i = 0; i < 5; i++) {
        const s = new THREE.Mesh(new THREE.BoxGeometry(rand(0.01, 0.02), rand(0.006, 0.012), 0.004), MAT.bone);
        const a = Math.random() * Math.PI * 2;
        s.position.set(Math.cos(a) * 0.045, Math.sin(a) * 0.034, 0.003);
        s.rotation.z = a;
        g.add(s);
      }
    }
    part.group.add(g);
    const world = surf.point.clone().applyQuaternion(part.group.quaternion).add(part.group.position);
    const wn = surf.normal.clone().applyQuaternion(part.group.quaternion);
    this.spray(world, wn, 40, { speed: 2.5, spread: 0.6, size: 0.022, volume: 1.5 });
    this.spawnGib(world, wn.clone().multiplyScalar(2.5), this.organMat(partName === 'head' ? MAT.brain : MAT.gut));
  }

  // ---------------------------------------------------------------- explosions
  /** A body part is blown apart (shot enough times). */
  explodePart(ragdoll, partName, dir) {
    const part = ragdoll.parts[partName];
    const def = PART_BY_NAME[partName];
    const centre = ragdoll.bodyPos(partName);
    const vel = part.body.velocity;
    const torso = /chest|abdomen|pelvis/.test(partName);
    const out = ragdoll.explodePart(partName);
    const organs = settings.get('showOrgans');
    const scale = partName === 'head' ? 1.2 : torso ? 1.5 : /thigh|upperArm/.test(partName) ? 1 : 0.6;

    // Blood burst: a dense outward cloud biased along the bullet, plus a fine mist.
    _n.copy(dir).multiplyScalar(0.6);
    for (let i = 0; i < 170 * scale; i++) {
      const s = rand(1.5, 6.5);
      const dx = rand(-1, 1), dy = rand(-0.6, 1.2), dz = rand(-1, 1);
      const l = Math.hypot(dx, dy, dz) || 1;
      this.particles.spawn(centre.x + rand(-0.04, 0.04), centre.y + rand(-0.04, 0.04), centre.z + rand(-0.04, 0.04),
        (dx / l + _n.x) * s + vel.x, (dy / l + _n.y) * s + vel.y + 0.6, (dz / l + _n.z) * s + vel.z,
        { size: rand(0.012, 0.04), life: 3.5, color: this.bc(rand(0.3, 0.5)), volume: 2.2 });
    }
    for (let i = 0; i < 60 * scale; i++) {
      const s = rand(0.5, 2.5);
      this.particles.spawn(centre.x, centre.y, centre.z, rand(-1, 1) * s + dir.x * 2, rand(-0.4, 1) * s, rand(-1, 1) * s + dir.z * 2,
        { size: rand(0.006, 0.012), life: 1.5, color: this.bc(0.45), volume: 0.3 });
    }
    // Chunks: meat, bone shards and (if enabled) organ bits.
    const n = Math.round((torso ? 7 : partName === 'head' ? 9 : 5) * Math.min(1.2, scale));
    for (let i = 0; i < n; i++) {
      const v = new THREE.Vector3(rand(-3, 3), rand(1, 4.5), rand(-3, 3)).addScaledVector(dir, 3).add(vel);
      const roll = Math.random();
      let mat = MAT.meat;
      if (roll < 0.3) mat = MAT.bone;
      else if (roll < 0.6 && organs) mat = partName === 'head' ? MAT.brain : torso ? (partName === 'chest' ? MAT.lung : MAT.gut) : MAT.meatDark;
      else if (roll < 0.75) mat = MAT.meatDark;
      this.spawnGib(centre, v, mat, mat === MAT.bone ? rand(0.01, 0.02) : rand(0.018, 0.04));
    }
    this.audio.play('splat'); this.audio.play('bone');

    if (torso) {
      // Gutted in place: big ragged cavities front and back, ribs/guts showing.
      const half = def.size[2] / 2;
      for (const z of [1, -1]) {
        const w = { pos: new THREE.Vector3(rand(-0.03, 0.03), rand(-0.03, 0.03), z * half), normal: new THREE.Vector3(0, 0, z) };
        this.openPart(ragdoll, partName, w);
        const vis = this.decals.addWound(part.group, this.surfacePoint(part, w.pos, w.normal).point, w.normal, true, 0.09);
        vis.stain.scale.setScalar(0.08);
      }
      return;
    }
    // Limb/head gone: ragged stump on the parent, and on any child segment that fell off.
    if (out.wasAttached && def.parent) {
      const r = def.shape === 'sphere' ? 0.05 : Math.min(def.size[0], def.size[2]) * 0.5;
      this.addStump(ragdoll.parts[def.parent].group, part.pivotParent, new THREE.Vector3(...def.joint.axis), r);
    }
    for (const c of out.detached) {
      const cd = PART_BY_NAME[c];
      const r = Math.min(cd.size[0], cd.size[2]) * 0.5;
      this.addStump(ragdoll.parts[c].group, ragdoll.parts[c].pivotChild, new THREE.Vector3(...cd.joint.axis).negate(), r);
    }
  }

  /** Blood from blunt impacts (bone breaks when slammed). */
  impactBlood(point, speed) {
    const n = Math.min(40, Math.round(speed * 3));
    this.spray(point, new THREE.Vector3(0, 0.6, 0), n, { speed: 1 + speed * 0.15, spread: 0.9, size: 0.016, volume: 0.8 });
  }

  // ---------------------------------------------------------------- gibs
  spawnGib(pos, vel, material, radius) {
    const r = radius ?? rand(0.014, 0.03);
    if (this.gibs.length >= G.maxGibs) this.removeGib(this.gibs[0]);
    const body = new CANNON.Body({
      mass: r * 8, material: this.physics.materials.debris, linearDamping: 0.1, angularDamping: 0.4,
      collisionFilterGroup: GROUP.DEBRIS, collisionFilterMask: GROUP.STATIC | GROUP.RAGDOLL | GROUP.PLAYER,
    });
    body.addShape(new CANNON.Sphere(r));
    body.position.set(pos.x, pos.y, pos.z);
    body.velocity.set(vel.x + rand(-1, 1), vel.y + rand(0, 1.5), vel.z + rand(-1, 1));
    body.angularVelocity.set(rand(-10, 10), rand(-10, 10), rand(-10, 10));
    this.physics.world.addBody(body);
    const geo = new THREE.IcosahedronGeometry(r, 1);
    const pa = geo.attributes.position;
    for (let i = 0; i < pa.count; i++) { _v.fromBufferAttribute(pa, i).multiplyScalar(rand(0.75, 1.25)); pa.setXYZ(i, _v.x, _v.y, _v.z); }
    geo.computeVertexNormals();
    const mesh = new THREE.Mesh(geo, material);
    mesh.castShadow = true;
    mesh.userData.surface = 'gib';
    this.scene.add(mesh);
    const gib = { body, mesh, bleed: 2.5, acc: 0 };
    mesh.userData.gib = gib;
    this.gibs.push(gib);
  }

  removeGib(g) {
    this.physics.world.removeBody(g.body);
    this.scene.remove(g.mesh);
    g.mesh.geometry.dispose();
    this.gibs = this.gibs.filter((x) => x !== g);
  }

  // ---------------------------------------------------------------- continuous bleeding
  updateRagdoll(ragdoll, dt) {
    const h = ragdoll.health;
    const press = h.pressure();
    const beat = h.heartRate > 1 ? (h.time * h.heartRate / 60) % 1 : 0.5;
    const pulse = h.heartRate > 1 && beat < 0.18; // systole window
    for (const w of h.wounds) {
      const part = ragdoll.parts[w.part];
      if (!part || part.removed) continue;
      const flow = w.rate * press;            // ml/s
      if (flow < 0.02) continue;
      // world position & outward normal of this wound
      if (w.stump) {
        const child = Object.values(ragdoll.parts).find((p) => p.def.joint?.name === w.joint);
        _v.copy(child.pivotParent);
        _n.set(...child.def.joint.axis);
      } else if (w.pos) { _v.copy(w.pos); _n.copy(w.normal); }
      else {
        // burst (blown-open torso) or blunt trauma: bleeds from all over the part
        const sz = part.def.size, sph = part.def.shape === 'sphere';
        _n.set(rand(-1, 1), rand(-0.3, 1), rand(-1, 1)).normalize();
        if (sph) _v.copy(_n).multiplyScalar(sz[0]);
        else _v.set(_n.x * sz[0] * 0.5, _n.y * sz[1] * 0.45, _n.z * sz[2] * 0.5);
      }
      _v.applyQuaternion(part.group.quaternion).add(part.group.position);
      _n.applyQuaternion(part.group.quaternion);

      // Drips/flow: about 1.5 ml per drop
      w.acc = (w.acc || 0) + flow * dt * (w.arterial ? 0.45 : 1);
      while (w.acc > 1.5) {
        w.acc -= 1.5;
        this.particles.spawn(_v.x + rand(-0.01, 0.01), _v.y, _v.z + rand(-0.01, 0.01), _n.x * 0.3 + rand(-0.1, 0.1), _n.y * 0.3, _n.z * 0.3 + rand(-0.1, 0.1),
          { size: 0.012 + Math.min(0.02, flow * 0.002), life: 4, color: this.bc(0.36), volume: 1.5 });
      }
      // Arterial spurts pulse with the heartbeat
      if (w.arterial && pulse && flow > 1.5) {
        w.spurt = (w.spurt || 0) + dt * flow * 0.55;
        const sp = 1.2 + Math.min(3.5, flow * 0.12);
        while (w.spurt > 1) {
          w.spurt -= 1;
          this.particles.spawn(_v.x, _v.y, _v.z, _n.x * sp + rand(-0.25, 0.25), _n.y * sp + 0.4 + rand(-0.2, 0.2), _n.z * sp + rand(-0.25, 0.25),
            { size: 0.016, life: 3, color: this.bc(0.48), volume: 1.6 });
        }
      }
      // blood run stain on the body grows with flow
      const vis = this.woundVisuals.get(w);
      const maxStain = /chest|abdomen|pelvis/.test(w.part) ? 0.08 : 0.04;
      if (vis && vis.stainSize < maxStain) {
        vis.stainSize = Math.min(maxStain, vis.stainSize + flow * dt * 0.0012);
        vis.stain.scale.setScalar(vis.stainSize);
      }
    }
  }

  update(dt, camera, viewportHeight) {
    this.particles.update(dt, camera, viewportHeight);
    this.decals.updatePools(dt);
    this.decals.updateWalls(dt);
    this.updateBruises(dt);
    for (const g of this.gibs) {
      g.mesh.position.copy(g.body.position);
      g.mesh.quaternion.copy(g.body.quaternion);
      if (g.bleed > 0) {
        g.bleed -= dt;
        g.acc += dt * 6;
        if (g.acc > 1) { g.acc -= 1; this.particles.spawn(g.body.position.x, g.body.position.y, g.body.position.z, 0, 0, 0, { size: 0.012, life: 2, color: this.bc(0.35), volume: 1.2 }); }
      }
    }
  }

  clear() {
    this.particles.clear();
    this.decals.clear();
    for (const g of [...this.gibs]) this.removeGib(g);
    this.woundVisuals.clear();
  }
}
