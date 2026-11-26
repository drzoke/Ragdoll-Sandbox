import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { CONFIG } from '../config.js';
import { Particles } from './particles.js';
import { Decals } from './decals.js';
import { PART_BY_NAME } from '../ragdoll/skeleton.js';
import { GROUP } from '../core/physics.js';
import { rand } from '../core/util.js';

const G = CONFIG.gore;
const _v = new THREE.Vector3(), _n = new THREE.Vector3(), _q = new THREE.Quaternion();
const Zf = new THREE.Vector3(0, 0, 1);

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
    this.gibs = [];
    this.woundVisuals = new Map(); // wound object -> {decal, stain}
  }

  // ---------------------------------------------------------------- spray helpers
  spray(pos, dir, count, { speed = 2.5, spread = 0.5, size = 0.018, volume = 1.2, life = 3 } = {}) {
    for (let i = 0; i < count; i++) {
      const s = speed * (0.4 + Math.random() * 0.8);
      const vx = dir.x + (Math.random() - 0.5) * spread * 2, vy = dir.y + (Math.random() - 0.5) * spread * 2, vz = dir.z + (Math.random() - 0.5) * spread * 2;
      const l = Math.hypot(vx, vy, vz) || 1;
      const shade = 0.3 + Math.random() * 0.18;
      this.particles.spawn(pos.x, pos.y, pos.z, (vx / l) * s, (vy / l) * s, (vz / l) * s,
        { size: size * (0.5 + Math.random()), life, color: [shade, 0.01, 0.015], volume });
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
      this.spawnGib(at, dirWorld.clone().multiplyScalar(3), res.organs[0].id === 'brain' ? MAT.brain : MAT.organ);
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

    if (partName === 'chest') {
      for (let i = -2; i <= 2; i++) {
        const rib = new THREE.Mesh(new THREE.CapsuleGeometry(0.0055, 0.1, 3, 6).rotateZ(Math.PI / 2), MAT.bone);
        rib.position.set(0, i * 0.02, -0.004);
        rib.rotation.z = (Math.random() - 0.5) * 0.25;
        if (Math.random() < 0.35) { rib.scale.x = 0.45; rib.position.x = rand(-0.03, 0.03); rib.rotation.y = rand(-0.4, 0.4); }
        g.add(rib);
      }
      const lung = new THREE.Mesh(new THREE.SphereGeometry(0.04, 12, 10), MAT.lung);
      lung.scale.set(1, 1.2, 0.45); lung.position.set(0.02, 0.005, -0.012);
      g.add(lung);
    } else if (partName === 'abdomen' || partName === 'pelvis') {
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
      for (let i = 0; i < 6; i++) {
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
    this.spawnGib(world, wn.clone().multiplyScalar(2.5), partName === 'head' ? MAT.brain : MAT.gut);
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
      if (!part) continue;
      const flow = w.rate * press;            // ml/s
      if (flow < 0.02) continue;
      // world position & outward normal of this wound
      if (w.stump) {
        const child = Object.values(ragdoll.parts).find((p) => p.def.joint?.name === w.joint);
        _v.copy(child.pivotParent);
        _n.set(...child.def.joint.axis);
      } else { _v.copy(w.pos); _n.copy(w.normal); }
      _v.applyQuaternion(part.group.quaternion).add(part.group.position);
      _n.applyQuaternion(part.group.quaternion);

      // Drips/flow: about 1.5 ml per drop
      w.acc = (w.acc || 0) + flow * dt * (w.arterial ? 0.45 : 1);
      while (w.acc > 1.5) {
        w.acc -= 1.5;
        this.particles.spawn(_v.x + rand(-0.01, 0.01), _v.y, _v.z + rand(-0.01, 0.01), _n.x * 0.3 + rand(-0.1, 0.1), _n.y * 0.3, _n.z * 0.3 + rand(-0.1, 0.1),
          { size: 0.012 + Math.min(0.02, flow * 0.002), life: 4, color: [0.36, 0.01, 0.01], volume: 1.5 });
      }
      // Arterial spurts pulse with the heartbeat
      if (w.arterial && pulse && flow > 1.5) {
        w.spurt = (w.spurt || 0) + dt * flow * 0.55;
        const sp = 1.2 + Math.min(3.5, flow * 0.12);
        while (w.spurt > 1) {
          w.spurt -= 1;
          this.particles.spawn(_v.x, _v.y, _v.z, _n.x * sp + rand(-0.25, 0.25), _n.y * sp + 0.4 + rand(-0.2, 0.2), _n.z * sp + rand(-0.25, 0.25),
            { size: 0.016, life: 3, color: [0.48, 0.02, 0.02], volume: 1.6 });
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
    for (const g of this.gibs) {
      g.mesh.position.copy(g.body.position);
      g.mesh.quaternion.copy(g.body.quaternion);
      if (g.bleed > 0) {
        g.bleed -= dt;
        g.acc += dt * 6;
        if (g.acc > 1) { g.acc -= 1; this.particles.spawn(g.body.position.x, g.body.position.y, g.body.position.z, 0, 0, 0, { size: 0.012, life: 2, color: [0.35, 0.01, 0.01], volume: 1.2 }); }
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
