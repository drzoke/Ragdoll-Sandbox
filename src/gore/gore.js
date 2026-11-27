import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { CONFIG } from '../config.js';
import { Particles } from './particles.js';
import { Decals, bandageTexture } from './decals.js';
import { PART_BY_NAME } from '../ragdoll/skeleton.js';
import { GROUP } from '../core/physics.js';
import { rand } from '../core/util.js';
import { batch } from '../ragdoll/batcher.js';
import { settings } from '../settings.js';

const G = CONFIG.gore;
const _v = new THREE.Vector3(), _n = new THREE.Vector3(), _q = new THREE.Quaternion();
const Zf = new THREE.Vector3(0, 0, 1);
const _w1 = new THREE.Vector3(), _w2 = new THREE.Vector3(), _w3 = new THREE.Vector3();
const _c = new THREE.Color(), _c2 = new THREE.Color();

// Shared geometries (sized with mesh.scale) so gibs, stumps and exposed organs can be drawn in
// batches instead of one draw call each.
const GEO = new Map();
const geo = (key, make) => { let g = GEO.get(key); if (!g) { g = make(); GEO.set(key, g); } return g; };
const lumpy = (detail, i) => geo(`lump${detail}.${i}`, () => {
  const g = new THREE.IcosahedronGeometry(1, detail), pa = g.attributes.position, v = new THREE.Vector3();
  // the same jitter for vertices that share a position, so the lump stays closed
  const seen = new Map();
  for (let k = 0; k < pa.count; k++) {
    v.fromBufferAttribute(pa, k);
    const key = `${v.x.toFixed(3)},${v.y.toFixed(3)},${v.z.toFixed(3)}`;
    let f = seen.get(key); if (f === undefined) { f = rand(0.75, 1.25); seen.set(key, f); }
    v.multiplyScalar(f); pa.setXYZ(k, v.x, v.y, v.z);
  }
  g.computeVertexNormals();
  return g;
});
const LUMPS = 6;
const mm = (r) => Math.round(r * 1000);

const MAT = {
  meat: new THREE.MeshStandardMaterial({ color: 0x6e0b0b, roughness: 0.35, metalness: 0.05 }),
  meatDark: new THREE.MeshStandardMaterial({ color: 0x2a0303, roughness: 0.5 }),
  bone: new THREE.MeshStandardMaterial({ color: 0xe8e0cc, roughness: 0.55 }),
  gut: new THREE.MeshStandardMaterial({ color: 0xc77a6e, roughness: 0.25, metalness: 0.05 }),
  lung: new THREE.MeshStandardMaterial({ color: 0xc98a90, roughness: 0.4 }),
  brain: new THREE.MeshStandardMaterial({ color: 0xd59aa0, roughness: 0.4 }),
  organ: new THREE.MeshStandardMaterial({ color: 0x7a1c22, roughness: 0.3 }),
};
// medical kit on the ragdoll
const MED = {
  bandage: null,   // made on first use (canvas texture)
  splint: new THREE.MeshStandardMaterial({ color: 0xd9782b, roughness: 0.7 }),
  strap: new THREE.MeshStandardMaterial({ color: 0x1d2024, roughness: 0.85 }),
  rod: new THREE.MeshStandardMaterial({ color: 0x2c3036, roughness: 0.5, metalness: 0.4 }),
};

/**
 * All blood & gore: droplets, spurts, pools, wound decals, stumps, exposed organs, gibs.
 * Driven by the Health model of each ragdoll (wounds array), plus one-shot events from hits.
 */
export class Gore {
  constructor(scene, physics, map, audio) {
    this.scene = scene; this.physics = physics; this.audio = audio;
    this.particles = new Particles(scene, G.maxParticles, map);
    this.decals = new Decals(scene, G.maxPools, G.maxDecals);
    this.particles.onLand = (x, y, z, vol, size) => this.decals.addDrop(x, y, z, vol, size);
    this.particles.onWall = (x, y, z, nx, ny, nz, vx, vy, vz, vol, size) =>
      this.decals.addWallSplat(_w1.set(x, y, z), _w2.set(nx, ny, nz), _w3.set(vx, vy, vz), vol, size);
    this.bruises = [];       // { ragdoll, part, mesh, local, sev, age, soot }
    this.gibs = [];
    this.woundVisuals = new Map(); // wound object -> {decal, stain}
    this.dressings = [];     // bandages that soak up blood: { ragdoll, part, soak, wounds, absorbed }
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
  addBruise(ragdoll, partName, worldPoint, severity, { soot = false, burn = false } = {}) {
    const kind = burn ? 'burn' : soot ? 'soot' : 'bruise';
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
      if (b.ragdoll !== ragdoll || b.part !== partName || b.kind !== kind) continue;
      if (b.local.distanceTo(local) < 0.05 + b.size * 0.3) {
        b.sev = Math.min(1.6, b.sev + severity * 0.6);
        b.size = Math.min(0.2, b.size + severity * 0.02);
        b.mesh.scale.setScalar(b.size);
        b.age = Math.min(b.age, 1);
        if (burn) b.glow = Math.max(b.glow, severity);
        return;
      }
    }
    const surf = this.surfacePoint(part, local.clone().addScaledVector(n, -0.01), n);
    const size = burn ? 0.09 + severity * 0.11 : (soot ? 0.1 : 0.07) + severity * (soot ? 0.12 : 0.09);
    const mesh = this.decals.addBruise(g, surf.point, surf.normal, size, kind);
    const mine = this.bruises.filter((b) => b.ragdoll === ragdoll);
    if (mine.length >= 40) { const old = mine[0]; old.mesh.parent?.remove(old.mesh); this.bruises.splice(this.bruises.indexOf(old), 1); }
    this.bruises.push({ ragdoll, part: partName, mesh, local: surf.point.clone(), sev: severity, size, age: 0, soot, kind, glow: burn ? severity : 0 });
  }

  /** Bruises come up over a second or two, then darken from red-purple to deep purple. */
  updateBruises(dt) {
    const fresh = new THREE.Color(0.24, 0.035, 0.3), deep = new THREE.Color(0.12, 0.025, 0.25), old = new THREE.Color(0.1, 0.035, 0.17);
    for (let i = this.bruises.length - 1; i >= 0; i--) {
      const b = this.bruises[i];
      if (b.ragdoll.removed) { this.bruises.splice(i, 1); continue; }
      b.age += dt;
      const m = b.mesh.userData.fx;      // per-mark colour / opacity / glow (drawn instanced)
      if (b.kind === 'burn') {
        // fresh burns smoulder: embers glow and fade over a few seconds
        m.color.setRGB(1, 1, 1);
        m.opacity = Math.min(0.97, b.age * 5) * Math.min(1, 0.5 + b.sev * 0.6);
        m.emissive = b.glow * 3.2 * Math.max(0, 1 - b.age / 5) * (0.75 + 0.25 * Math.sin(b.age * 13 + b.size * 50));
        continue;
      }
      if (b.soot) { m.color.setRGB(0.02, 0.018, 0.016); m.opacity = Math.min(0.92, b.age * 6) * Math.min(1, 0.55 + b.sev * 0.5); continue; }
      const k1 = Math.min(1, b.age / 6), k2 = Math.min(1, Math.max(0, b.age - 20) / 120);
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


  // ---------------------------------------------------------------- blades
  /**
   * Machete wound visuals. res = Health.cut result, along = the swing direction (world) so the
   * gash lines up with the blade.
   */
  bladeWound(ragdoll, res, entryWorld, dirWorld, alongWorld) {
    const part = ragdoll.parts[res.partName];
    const group = part.group;
    const inv = _q.copy(group.quaternion).invert();
    const w = res.wound;
    const surf = this.surfacePoint(part, w.pos.clone(), w.normal.clone());
    if (res.kind === 'slash') {
      const along = alongWorld.clone().applyQuaternion(inv);
      const len = 0.07 + Math.min(0.06, (ragdoll.health.parts[res.partName].cutDepth || 0) * 0.6);
      this.woundVisuals.set(w, this.decals.addGash(group, surf.point, surf.normal, along, len));
      // blood flicked off along the swing, and a spray out of the cut
      this.spray(entryWorld, alongWorld.clone().multiplyScalar(0.8).add(new THREE.Vector3(0, 0.3, 0)), 22, { speed: 3.2, spread: 0.45, size: 0.014, volume: 0.8 });
      this.spray(entryWorld, _n.copy(dirWorld).negate(), 10, { speed: 1.4, spread: 0.6, size: 0.012, volume: 0.6 });
    } else {
      this.woundVisuals.set(w, this.decals.addWound(group, surf.point, surf.normal, false, 0.028));
      this.spray(entryWorld, _n.copy(dirWorld).negate().add(new THREE.Vector3(0, 0.25, 0)), 18, { speed: 2, spread: 0.5, size: 0.016, volume: 1 });
      if (res.exitWound) {
        const ew = res.exitWound;
        const es = this.surfacePoint(part, ew.pos.clone(), ew.normal.clone());
        this.woundVisuals.set(ew, this.decals.addWound(group, es.point, es.normal, false, 0.024));
        const exitWorld = es.point.clone().applyQuaternion(group.quaternion).add(group.position);
        this.spray(exitWorld, dirWorld, 14, { speed: 2.2, spread: 0.4, size: 0.014, volume: 0.9 });
      }
    }
    if (res.throat || w.arterial) this.spray(entryWorld, _n.copy(dirWorld).negate().add(new THREE.Vector3(0, 0.5, 0)), 30, { speed: 3.5, spread: 0.3, size: 0.018, volume: 1.4 });
    if (res.organs.some((o) => o.hp <= 0) && Math.random() < 0.4) this.spawnGib(entryWorld, _n.copy(dirWorld).negate().multiplyScalar(2), this.organMat(MAT.organ));
  }

  // ---------------------------------------------------------------- armour
  /** A bullet, pellet or blade stopped by armour: dent, lead smear and a few sparks. */
  armorHit(ragdoll, partName, worldPoint, worldNormal, size = 0.03) {
    const part = ragdoll.parts[partName];
    if (!part || part.removed) return;
    const g = part.group;
    const inv = _q.copy(g.quaternion).invert();
    const local = worldPoint.clone().sub(g.position).applyQuaternion(inv);
    const n = worldNormal.clone().applyQuaternion(inv).normalize();
    this.decals.addDent(g, local, n, size);
    this.sparks(worldPoint, worldNormal, 6);
  }

  /** Metal on metal / concrete: a few short-lived bright sparks. */
  sparks(point, normal, count = 8) {
    for (let i = 0; i < count; i++) {
      const s = rand(1.5, 4.5);
      this.particles.spawn(point.x, point.y, point.z, (normal.x + rand(-0.6, 0.6)) * s, (normal.y + rand(-0.2, 0.9)) * s, (normal.z + rand(-0.6, 0.6)) * s,
        { size: rand(0.008, 0.016), life: 0.35, color: [1.6, 1.25, 0.7], kind: 1 });
    }
  }

  /** The helmet comes off (head blown apart): a loose, bouncing shell. */
  dropHelmet(ragdoll, at, vel) {
    const a = ragdoll.armor?.helmet;
    if (!a || a.dropped) return;
    a.dropped = true;
    const src = a.meshes[0];
    const mesh = new THREE.Mesh(src.geometry, src.material);
    mesh.castShadow = true;
    if (this.gibs.length >= G.maxGibs) this.removeGib(this.gibs[0]);
    const body = new CANNON.Body({
      mass: 1.4, material: this.physics.materials.debris, linearDamping: 0.1, angularDamping: 0.4,
      collisionFilterGroup: GROUP.DEBRIS, collisionFilterMask: GROUP.STATIC | GROUP.RAGDOLL | GROUP.PLAYER,
    });
    body.addShape(new CANNON.Sphere(0.1));
    body.position.set(at.x, at.y + 0.05, at.z);
    body.velocity.set(vel.x + rand(-1.5, 1.5), vel.y + rand(2, 4), vel.z + rand(-1.5, 1.5));
    body.angularVelocity.set(rand(-8, 8), rand(-8, 8), rand(-8, 8));
    this.physics.world.addBody(body);
    mesh.userData.surface = 'armor';
    this.scene.add(mesh);
    const gib = { body, mesh, bleed: 0, acc: 0, keepGeometry: true };
    mesh.userData.gib = gib;
    this.gibs.push(gib);
  }

  // ---------------------------------------------------------------- medical
  /** Where to put a band around a part: local y of the wound, clamped to the part. */
  bandAt(part, y) {
    const def = part.def;
    const hy = def.shape === 'sphere' ? 0.03 : def.size[1] / 2 - 0.035;
    return THREE.MathUtils.clamp(y, -hy, hy);
  }

  /** Band geometry that wraps a body part: a short tube for limbs/head, an open box for the torso. */
  bandGeometry(part, height) {
    const def = part.def, sz = def.size;
    if (def.shape === 'sphere') return new THREE.CylinderGeometry(sz[0] * 1.03, sz[0] * 1.03, height, 24, 1, true);
    if (/upperArm|lowerArm|thigh|shin/.test(def.name)) { const r = Math.min(sz[0], sz[2]) / 2 * 1.13; return new THREE.CylinderGeometry(r, r, height, 18, 1, true); }
    return new THREE.BoxGeometry(sz[0] * 1.07, height, sz[2] * 1.12);
  }

  /** Bandages on the treated wounds of a part (one band per spot), with blood soaking through. */
  bandage(ragdoll, partName, wounds) {
    const part = ragdoll.parts[partName];
    if (!part || part.removed) return;
    if (!MED.bandage) {
      const t = bandageTexture(); t.repeat.set(2, 1);
      MED.bandage = new THREE.MeshStandardMaterial({ map: t, roughness: 0.95, side: THREE.DoubleSide });
    }
    part.bands ??= [];
    for (const w of wounds) {
      if (w.stump || !w.pos) {
        if (w.stump) this.tourniquet(ragdoll, partName, w);
        continue;
      }
      const y = this.bandAt(part, w.pos.y);
      let band = part.bands.find((b) => Math.abs(b.y - y) < 0.06);
      if (!band) {
        const h = part.def.shape === 'sphere' ? 0.06 : 0.085;
        const mesh = new THREE.Mesh(this.bandGeometry(part, h), MED.bandage);
        mesh.position.y = y;
        if (partName === 'head') { mesh.position.y = 0.035; mesh.rotation.x = -0.25; }
        mesh.castShadow = true; mesh.userData.decal = true;
        part.group.add(mesh);
        band = { y, mesh, wounds: [] };
        part.bands.push(band);
      }
      band.wounds.push(w);
      // blood soaking through on the side of the wound
      const n = w.normal.clone().setY(0);
      if (n.lengthSq() < 1e-4) n.set(0, 0, 1);
      n.normalize();
      const surf = this.surfacePoint(part, new THREE.Vector3(n.x * 0.01, band.y, n.z * 0.01), n);
      const soak = new THREE.Mesh(this.decals.woundGeo, new THREE.MeshStandardMaterial({
        alphaMap: this.decals.soakTex, color: new THREE.Color(...settings.blood.decal).multiplyScalar(0.55), transparent: true, depthWrite: false, opacity: 0,
        roughness: 0.8, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4,
      }));
      soak.position.copy(surf.point).addScaledVector(n, 0.012);
      soak.quaternion.setFromUnitVectors(Zf, n);
      soak.scale.setScalar(0.025);
      soak.userData.decal = true;
      part.group.add(soak);
      this.dressings.push({ ragdoll, part: partName, soak, wound: w, absorbed: 0 });
      // hide the open wound under the bandage
      const vis = this.woundVisuals.get(w);
      if (vis) { vis.decal.visible = false; vis.stain.visible = false; }
    }
  }

  /** Black strap with a windlass rod, tied just above a stump. */
  tourniquet(ragdoll, partName, w) {
    const part = ragdoll.parts[partName];
    const child = Object.values(ragdoll.parts).find((p) => p.def.joint?.name === w.joint);
    if (!child) return;
    const pos = child.pivotParent.clone();
    const toCentre = pos.clone().multiplyScalar(-1).normalize();
    pos.addScaledVector(toCentre, 0.06);
    const def = part.def;
    const g = new THREE.Group();
    g.position.copy(pos);
    // along the limb: the child's joint axis
    g.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), new THREE.Vector3(...child.def.joint.axis));
    const r = def.shape === 'sphere' ? 0.09 : Math.max(def.size[0], def.size[2]) / 2 * 1.12;
    const strap = new THREE.Mesh(/chest|pelvis|abdomen/.test(partName) ? new THREE.BoxGeometry(def.size[0] * 0.5, 0.035, def.size[2] * 1.1) : new THREE.CylinderGeometry(r, r, 0.035, 18, 1, true), MED.strap);
    strap.material.side = THREE.DoubleSide;
    const rod = new THREE.Mesh(new THREE.CylinderGeometry(0.006, 0.006, 0.1, 8).rotateZ(Math.PI / 2), MED.rod);
    rod.position.set(0, 0.005, r + 0.01);
    g.add(strap, rod);
    for (const m of [strap, rod]) { m.castShadow = true; m.userData.decal = true; }
    part.group.add(g);
  }

  /** Two orange splint boards strapped along a broken limb. */
  splint(ragdoll, partName) {
    const part = ragdoll.parts[partName];
    if (!part || part.removed || part.splinted) return;
    part.splinted = true;
    const def = part.def, sz = def.size;
    const len = (def.shape === 'sphere' ? 0.1 : sz[1]) * 0.9;
    const g = new THREE.Group();
    const half = def.shape === 'sphere' ? sz[0] : Math.min(sz[0], sz[2]) / 2 * 1.15;
    for (const sx of [1, -1]) {
      const board = new THREE.Mesh(new THREE.BoxGeometry(0.008, len, 0.034), MED.splint);
      board.position.x = sx * (half + 0.005);
      g.add(board);
    }
    for (const y of [-len * 0.32, len * 0.32]) {
      const strap = new THREE.Mesh(new THREE.CylinderGeometry(half + 0.012, half + 0.012, 0.022, 16, 1, true), MED.strap);
      strap.material.side = THREE.DoubleSide;
      strap.position.y = y;
      g.add(strap);
    }
    g.traverse((m) => { if (m.isMesh) { m.castShadow = true; m.userData.decal = true; } });
    part.group.add(g);
  }

  /** Paddle burns: two red marks on the chest where the defibrillator touched. */
  paddleMarks(ragdoll) {
    const part = ragdoll.parts.chest;
    if (!part || part.removed) return;
    const g = part.group;
    for (const [x, y] of [[-0.09, 0.07], [0.1, -0.07]]) {
      const local = new THREE.Vector3(x, y, part.def.size[2] / 2);
      const world = local.applyQuaternion(g.quaternion).add(g.position);
      this.addBruise(ragdoll, 'chest', world, 0.35, { burn: true });
    }
  }

  updateDressings(dt) {
    for (let i = this.dressings.length - 1; i >= 0; i--) {
      const d = this.dressings[i];
      if (d.ragdoll.removed) { this.dressings.splice(i, 1); continue; }
      const flow = d.wound.rate * d.ragdoll.health.pressure();
      d.absorbed += flow * dt;
      const m = d.soak.material;
      m.opacity = Math.min(0.92, 0.25 + d.absorbed * 0.02);
      d.soak.scale.setScalar(0.025 + Math.min(0.065, d.absorbed * 0.0012));
    }
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
    const k = mm(r);
    const cap = new THREE.Mesh(geo(`cap${k}`, () => new THREE.CircleGeometry(r * 1.08, 18)), MAT.meat);
    cap.position.z = 0.004;
    const ring = new THREE.Mesh(geo(`ring${k}`, () => new THREE.TorusGeometry(r * 0.95, r * 0.22, 6, 18)), MAT.meatDark);
    const bone = new THREE.Mesh(geo(`bone${k}`, () => new THREE.CylinderGeometry(r * 0.28, r * 0.33, 0.035, 10).rotateX(Math.PI / 2)), MAT.bone);
    bone.position.z = 0.012;
    for (const m of [cap, ring, bone]) { m.castShadow = true; g.add(m); }
    // a few ragged meat chunks
    for (let i = 0; i < 4; i++) {
      const c = new THREE.Mesh(lumpy(0, i % LUMPS), MAT.meat);
      c.scale.setScalar(r * rand(0.2, 0.35));
      const a = Math.random() * Math.PI * 2;
      c.position.set(Math.cos(a) * r * 0.75, Math.sin(a) * r * 0.75, 0.006);
      g.add(c);
    }
    group.add(g);
    g.traverse((m) => m.isMesh && batch(m));
  }

  // ---------------------------------------------------------------- exposed organs
  openPart(ragdoll, partName, wound) {
    const part = ragdoll.parts[partName];
    const p = wound.pos.clone(), n = wound.normal.clone();
    const surf = this.surfacePoint(part, p, n);
    const g = new THREE.Group();
    g.position.copy(surf.point);
    g.quaternion.setFromUnitVectors(Zf, surf.normal);
    const hr = partName === 'head' ? 0.045 : 0.07;
    const hole = new THREE.Mesh(geo(`hole${hr}`, () => new THREE.CircleGeometry(hr, 20)), MAT.meatDark);
    hole.scale.set(1, 0.75, 1);
    hole.position.z = 0.002;
    g.add(hole);
    const rim = new THREE.Mesh(geo(`rim${hr}`, () => new THREE.TorusGeometry(hr, 0.012, 6, 22)), MAT.meat);
    rim.scale.set(1, 0.75, 1);
    g.add(rim);

    const organs = settings.get('showOrgans');
    if (partName === 'chest') {
      for (let i = -2; i <= 2; i++) {
        const rib = new THREE.Mesh(geo('rib', () => new THREE.CapsuleGeometry(0.0055, 0.1, 3, 6).rotateZ(Math.PI / 2)), MAT.bone);
        rib.position.set(0, i * 0.02, -0.004);
        rib.rotation.z = (Math.random() - 0.5) * 0.25;
        if (Math.random() < 0.35) { rib.scale.x = 0.45; rib.position.x = rand(-0.03, 0.03); rib.rotation.y = rand(-0.4, 0.4); }
        g.add(rib);
      }
      if (organs) {
        const lung = new THREE.Mesh(geo('lung', () => new THREE.SphereGeometry(0.04, 12, 10)), MAT.lung);
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
        const b = new THREE.Mesh(geo('blob', () => new THREE.SphereGeometry(1, 8, 6)), MAT.brain);
        b.scale.setScalar(rand(0.012, 0.02));
        b.position.set(rand(-0.025, 0.025), rand(-0.018, 0.018), rand(-0.01, 0.004));
        g.add(b);
      }
      for (let i = 0; i < 5; i++) {
        const s = new THREE.Mesh(geo('box', () => new THREE.BoxGeometry(1, 1, 1)), MAT.bone);
        s.scale.set(rand(0.01, 0.02), rand(0.006, 0.012), 0.004);
        const a = Math.random() * Math.PI * 2;
        s.position.set(Math.cos(a) * 0.045, Math.sin(a) * 0.034, 0.003);
        s.rotation.z = a;
        g.add(s);
      }
    }
    part.group.add(g);
    g.traverse((m) => m.isMesh && m.geometry.type !== 'TubeGeometry' && batch(m));
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
    if (partName === 'head' && ragdoll.armor?.helmet) this.dropHelmet(ragdoll, centre, new THREE.Vector3(vel.x, vel.y, vel.z).addScaledVector(dir, 3));
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
    const mesh = new THREE.Mesh(lumpy(1, Math.floor(Math.random() * LUMPS)), material);
    mesh.scale.setScalar(r);
    mesh.castShadow = true;
    mesh.userData.surface = 'gib';
    this.scene.add(mesh);
    batch(mesh, mesh);
    const gib = { body, mesh, bleed: 2.5, acc: 0, keepGeometry: true };
    mesh.userData.gib = gib;
    this.gibs.push(gib);
  }

  removeGib(g) {
    this.physics.world.removeBody(g.body);
    this.scene.remove(g.mesh);
    if (!g.keepGeometry) g.mesh.geometry.dispose();
    this.gibs = this.gibs.filter((x) => x !== g);
  }

  // ---------------------------------------------------------------- continuous bleeding
  updateRagdoll(ragdoll, dt) {
    this.updateBurns(ragdoll, dt);
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

  /** Burnt parts: tint the shell by burn depth and let the embers die down over a few seconds. */
  updateBurns(ragdoll, dt) {
    const h = ragdoll.health;
    for (const [name, part] of Object.entries(ragdoll.parts)) {
      const b = h.parts[name].burn || 0;
      if (b < 0.04 || part.removed) continue;
      let s = part.burnShell;
      if (!s) { s = part.burnShell = this.decals.burnShell(part.mesh); s.userData.age = 0; part.group.add(s); batch(s); }
      const u = s.userData, m = u.fx;
      if (u.k !== b) {
        if (u.k !== undefined && b > u.k + 0.05) u.age = Math.min(u.age, 0.5);   // burnt again: embers flare up
        u.k = b;
        // red flush -> blistered brown -> char
        if (b < 0.3) _c.setRGB(0.5, 0.09, 0.06);
        else if (b < 0.66) _c.setRGB(0.5, 0.09, 0.06).lerp(_c2.setRGB(0.24, 0.08, 0.035), (b - 0.3) / 0.36);
        else _c.setRGB(0.24, 0.08, 0.035).lerp(_c2.setRGB(0.045, 0.032, 0.025), Math.min(1, (b - 0.66) / 0.3));
        m.color.copy(_c);
        u.opacity = Math.min(0.95, 0.3 + b * 0.95);
      }
      u.age += dt;
      m.opacity += (u.opacity - m.opacity) * Math.min(1, dt * 6);
      m.emissive = b > 0.25 ? b * 2.4 * Math.max(0, 1 - u.age / 5) * (0.8 + 0.2 * Math.sin(u.age * 11)) : 0;
    }
  }

  update(dt, camera, viewportHeight) {
    this.particles.update(dt, camera, viewportHeight);
    this.decals.updatePools(dt);
    this.decals.updateWalls(dt);
    this.updateBruises(dt);
    this.updateDressings(dt);
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
