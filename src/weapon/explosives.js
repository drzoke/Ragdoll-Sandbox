import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { GROUP } from '../core/physics.js';
import { canvasTexture, rand, clamp } from '../core/util.js';
import { GRENADE_DAMPING } from './grenade.js';
import { buildGrenade } from './grenadeModel.js';
import { settings } from '../settings.js';

const FUSE = 3.0;        // s (world time: slow motion stretches it)
const RADIUS = 6.5;      // blast radius (m)
const SHRAPNEL = 48;        // random fragments (plus ones that are aimed at nearby bodies)
const BURN_RADIUS = 2.6;    // fireball heat (m)

// ---------------------------------------------------------------- textures
function puffTexture(hot) {
  return canvasTexture(128, 128, (g, w, h) => {
    for (let i = 0; i < (hot ? 7 : 11); i++) {
      const a = Math.random() * Math.PI * 2, d = Math.random() * w * 0.17, r = w * (0.2 + Math.random() * 0.17);
      const x = w / 2 + Math.cos(a) * d, y = h / 2 + Math.sin(a) * d;
      const grd = g.createRadialGradient(x, y, 0, x, y, r);
      if (hot) { grd.addColorStop(0, 'rgba(255,255,240,0.9)'); grd.addColorStop(0.35, 'rgba(255,220,140,0.55)'); grd.addColorStop(1, 'rgba(255,140,40,0)'); }
      else { grd.addColorStop(0, 'rgba(255,255,255,0.5)'); grd.addColorStop(0.55, 'rgba(235,235,235,0.28)'); grd.addColorStop(1, 'rgba(220,220,220,0)'); }
      g.fillStyle = grd; g.fillRect(0, 0, w, h);
    }
  });
}
function flashTexture() {
  return canvasTexture(128, 128, (g, w, h) => {
    const grd = g.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2);
    grd.addColorStop(0, 'rgba(255,255,250,1)'); grd.addColorStop(0.18, 'rgba(255,240,190,0.85)'); grd.addColorStop(0.5, 'rgba(255,170,70,0.25)'); grd.addColorStop(1, 'rgba(255,120,20,0)');
    g.fillStyle = grd; g.fillRect(0, 0, w, h);
  });
}
function ringTexture() {
  return canvasTexture(128, 128, (g, w, h) => {
    const grd = g.createRadialGradient(w / 2, h / 2, w * 0.3, w / 2, h / 2, w / 2);
    grd.addColorStop(0, 'rgba(255,255,255,0)'); grd.addColorStop(0.75, 'rgba(255,255,255,0.55)'); grd.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grd; g.fillRect(0, 0, w, h);
  });
}

const _v = new THREE.Vector3(), _d = new THREE.Vector3(), _q = new THREE.Quaternion();
const UP = new THREE.Vector3(0, 1, 0);

/**
 * Thrown grenades and their explosions: the live grenades (physics balls with a fuse), the
 * flying spoons, and every explosion effect (flash, fireball, smoke, dust, sparks, shock ring,
 * scorch marks), blast damage, knockback and shrapnel.
 */
export class Explosives {
  constructor({ scene, physics, ragdolls, gore, map, audio, player, camera }) {
    Object.assign(this, { scene, physics, ragdolls, gore, map, audio, player, camera });
    this.ballistics = null; // set after construction (shrapnel)
    this.live = [];
    this.spoons = [];
    this.fx = [];           // sprites with an update function
    this.smoulder = [];     // burnt body parts giving off smoke for a few seconds
    this.byBody = new Map(); // physics body -> live grenade
    this.raycaster = new THREE.Raycaster();
    this.tex = { fire: puffTexture(true), smoke: puffTexture(false), flash: flashTexture(), ring: ringTexture() };
    this.template = buildGrenade();
    this.template.pinGroup.visible = false;
    this.template.spoon.visible = false;
    this.light = new THREE.PointLight(0xffa64a, 0, 45, 1.6);
    scene.add(this.light);
    this.lightT = 9;
    // sparks / burning fragments
    this.maxSparks = 400;
    this.sparkPos = new Float32Array(this.maxSparks * 3);
    this.sparkCol = new Float32Array(this.maxSparks * 3);
    this.sparks = [];
    const sg = new THREE.BufferGeometry();
    sg.setAttribute('position', new THREE.BufferAttribute(this.sparkPos, 3).setUsage(THREE.DynamicDrawUsage));
    sg.setAttribute('color', new THREE.BufferAttribute(this.sparkCol, 3).setUsage(THREE.DynamicDrawUsage));
    sg.setDrawRange(0, 0);
    this.sparkPoints = new THREE.Points(sg, new THREE.PointsMaterial({ size: 0.07, map: this.tex.flash, vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false }));
    this.sparkPoints.frustumCulled = false;
    scene.add(this.sparkPoints);
  }

  meshes() { return this.live.flatMap((g) => g.mesh.children.filter((o) => o.isMesh && o.visible)); }

  // ---------------------------------------------------------------- grenades
  throwGrenade(pos, vel, spin) {
    const mesh = this.template.root.clone(true);
    mesh.traverse((o) => { o.userData = {}; });
    const body = new CANNON.Body({
      mass: 0.4, material: this.physics.materials.grenade, linearDamping: GRENADE_DAMPING, angularDamping: 0.35,
      collisionFilterGroup: GROUP.DEBRIS, collisionFilterMask: GROUP.STATIC | GROUP.RAGDOLL | GROUP.DEBRIS,
    });
    body.addShape(new CANNON.Sphere(0.034));
    body.position.set(pos.x, pos.y, pos.z);
    body.velocity.set(vel.x, vel.y, vel.z);
    body.angularVelocity.set(spin.x, spin.y, spin.z);
    this.physics.world.addBody(body);
    const g = { mesh, body, fuse: FUSE, lastClink: 0, smokeT: 0 };
    this.byBody.set(body, g);
    // the ball mesh is what bullets / fists / the grab tool find
    mesh.traverse((o) => { if (o.isMesh) o.userData.grenade = g; });
    body.addEventListener('collide', (e) => {
      const v = Math.abs(e.contact.getImpactVelocityAlongNormal());
      const now = performance.now();
      if (v > 1 && now - g.lastClink > 90) { g.lastClink = now; this.audio.play(v > 3 ? 'clink' : 'thud'); }
    });
    this.scene.add(mesh);
    this.live.push(g);
    return g;
  }

  /** The spoon flies off when the grenade leaves the hand. */
  spawnSpoon(pos, vel) {
    const m = this.template.spoon.clone(true);
    m.visible = true;
    m.position.copy(pos);
    this.scene.add(m);
    this.spoons.push({ mesh: m, vel: vel.clone(), spin: new THREE.Vector3(rand(-20, 20), rand(-20, 20), rand(-20, 20)), rest: false, age: 0 });
    if (this.spoons.length > 12) { const s = this.spoons.shift(); this.scene.remove(s.mesh); }
    this.audio.play('spoon');
  }

  // ---------------------------------------------------------------- explosion
  detonate(g) {
    if (g.dead) return;
    g.dead = true;
    const p = new THREE.Vector3(g.body.position.x, g.body.position.y, g.body.position.z);
    this.physics.world.removeBody(g.body);
    this.byBody.delete(g.body);
    this.scene.remove(g.mesh);
    this.live = this.live.filter((x) => x !== g);
    this.explode(p);
  }

  explode(c) {
    const dist = this.camera.position.distanceTo(c);
    this.audio.boom(dist);
    this.effects(c);
    this.scorch(c);
    this.blast(c);
    // shrapnel: the casing breaks into hundreds of fragments. Fire a spread of random ones, plus
    // the share of the cloud that would land on each nearby body part (more the closer it is).
    if (this.ballistics) {
      const frag = (d) => this.ballistics.fire(c.clone().addScaledVector(d, 0.05), d, null,
        { energy: rand(0.4, 0.72), impulse: 3.2, size: 0.4, glowSize: 0.03, speed: rand(260, 420), range: 40, life: 0.45, fragment: true });
      for (let i = 0; i < SHRAPNEL; i++) frag(new THREE.Vector3(rand(-1, 1), rand(-0.45, 0.9), rand(-1, 1)).normalize());
      for (const r of this.ragdolls.list) {
        for (const part of Object.values(r.parts)) {
          if (part.removed) continue;
          const b = part.body;
          const d = _v.set(b.position.x, b.position.y, b.position.z).distanceTo(c);
          if (d > 10) continue;
          const sz = part.def.shape === 'sphere' ? 1 : part.def.size[0] * part.def.size[1] * 22;
          const expected = Math.min(5, 1.6 * sz / Math.max(0.25, d * d));
          const n = Math.floor(expected + Math.random());
          for (let i = 0; i < n; i++) {
            const t = new THREE.Vector3(b.position.x + rand(-0.05, 0.05), b.position.y + rand(-0.08, 0.08), b.position.z + rand(-0.05, 0.05));
            frag(t.sub(c).normalize());
          }
        }
      }
    }
    // camera shake + a shove if you're close
    const k = clamp(1 - dist / 40);
    this.player.addShake?.(k * k * 2 + 0.1);
    if (dist < 4.5) {
      _d.copy(this.player.pos).sub(c).setY(0).normalize();
      const push = (4.5 - dist) * 2.2;
      this.player.vel.x += _d.x * push; this.player.vel.z += _d.z * push;
      this.player.vel.y = Math.max(this.player.vel.y, push * 0.5);
    }
  }

  /** Flash, fireball, black smoke, dust ring, sparks and a shock ring on the ground. */
  effects(c) {
    const T = this.tex;
    const ground = this.gore.particles.surfaceHeight(c.x, c.y + 0.05, c.z);
    const low = c.y - ground < 1.2;
    this.light.position.copy(c).add(new THREE.Vector3(0, 0.4, 0));
    this.lightT = 0;

    const sprite = (map, blending, color, opacity) => {
      const s = new THREE.Sprite(new THREE.SpriteMaterial({ map, blending, color, transparent: true, depthWrite: false, opacity }));
      s.material.rotation = Math.random() * Math.PI * 2;
      this.scene.add(s);
      return s;
    };
    const add = (s, life, fn) => this.fx.push({ s, life, age: 0, fn });

    // white-hot flash
    const fl = sprite(T.flash, THREE.AdditiveBlending, new THREE.Color(1, 0.95, 0.85), 1);
    fl.position.copy(c);
    add(fl, 0.12, (f, k) => { fl.scale.setScalar(3.6 + k * 2.6); fl.material.opacity = 0.85 * (1 - k); });
    // white-hot core: a few small, very fast puffs in the first instant
    for (let i = 0; i < 6; i++) {
      const s = sprite(T.fire, THREE.AdditiveBlending, new THREE.Color(1, 0.95, 0.8), 1);
      const d = new THREE.Vector3(rand(-1, 1), rand(-0.2, 1), rand(-1, 1)).normalize();
      const life = rand(0.12, 0.2);
      s.position.copy(c);
      add(s, life, (f, k, dt) => { s.position.addScaledVector(d, dt * 9 * (1 - k)); s.scale.setScalar(0.8 + k * 2.4); s.material.opacity = 0.9 * (1 - k); });
    }
    // fireball: several hot puffs that swell, rise and cool from yellow to dark red
    for (let i = 0; i < 20; i++) {
      const s = sprite(T.fire, THREE.AdditiveBlending, new THREE.Color(1, 0.8, 0.45), 0.9);
      const off = new THREE.Vector3(rand(-1, 1), rand(-0.3, 1), rand(-1, 1)).normalize().multiplyScalar(rand(0.1, 0.8));
      const vel = off.clone().multiplyScalar(rand(4, 8)).add(new THREE.Vector3(0, rand(0.8, 2.2), 0));
      const size = rand(1.6, 3.0), life = rand(0.4, 0.75);
      s.position.copy(c).add(off);
      add(s, life, (f, k, dt) => {
        s.position.addScaledVector(vel, dt); vel.multiplyScalar(1 - dt * 6);
        s.scale.setScalar(size * (0.35 + 0.65 * Math.sqrt(k)) * 1.3);
        const col = s.material.color;
        col.setRGB(1, lerp(0.85, 0.3, k), lerp(0.5, 0.06, k));
        s.material.opacity = 0.75 * (1 - k) * (1 - k * 0.4);
      });
    }
    // black smoke: billows up and spreads, lingers for a few seconds
    // (TNT / Comp B leaves a dark grey-black cloud, mixed with brown dust when it goes off low)
    for (let i = 0; i < 30; i++) {
      const dusty = low && i % 3 === 0;
      const shade = dusty ? rand(0.22, 0.34) : rand(0.07, 0.2);
      const s = sprite(T.smoke, THREE.NormalBlending, dusty ? new THREE.Color(shade, shade * 0.9, shade * 0.78) : new THREE.Color(shade, shade * 0.97, shade * 0.94), 0);
      const dir = new THREE.Vector3(rand(-1, 1), rand(0, 1), rand(-1, 1)).normalize();
      const vel = dir.clone().multiplyScalar(rand(2, 6)).add(new THREE.Vector3(0, rand(0.8, 2.2), 0));
      const size = rand(2.2, 4.2), life = rand(5, 9), delay = rand(0.03, 0.18);
      s.position.copy(c).addScaledVector(dir, 0.2);
      s.userData.spin = rand(-0.4, 0.4);
      add(s, life, (f, k, dt) => {
        if (f.age < delay) return;
        s.position.addScaledVector(vel, dt); vel.multiplyScalar(1 - dt * 2.2); vel.y += dt * 0.15;
        s.position.y = Math.max(ground + size * 0.25, s.position.y);
        s.material.rotation += s.userData.spin * dt;
        s.scale.setScalar(size * (0.45 + 1.2 * Math.sqrt(k)));
        s.material.opacity = Math.min(1, (f.age - delay) * 8) * 0.85 * (1 - k) * (1 - k);
      });
    }
    // the hot cloud keeps rising: a column of smoke that climbs for a few seconds
    for (let i = 0; i < 8; i++) {
      const shade = rand(0.1, 0.2);
      const s = sprite(T.smoke, THREE.NormalBlending, new THREE.Color(shade, shade * 0.97, shade * 0.94), 0);
      const vel = new THREE.Vector3(rand(-0.4, 0.4), rand(2.2, 4.2), rand(-0.4, 0.4));
      const size = rand(2, 3.4), life = rand(6, 9.5), delay = rand(0.1, 0.45);
      s.position.copy(c).add(new THREE.Vector3(rand(-0.3, 0.3), 0.3, rand(-0.3, 0.3)));
      s.userData.spin = rand(-0.3, 0.3);
      add(s, life, (f, k, dt) => {
        if (f.age < delay) return;
        s.position.addScaledVector(vel, dt); vel.multiplyScalar(1 - dt * 0.45);
        s.material.rotation += s.userData.spin * dt;
        s.scale.setScalar(size * (0.5 + 1.5 * Math.sqrt(k)));
        s.material.opacity = Math.min(1, (f.age - delay) * 5) * 0.6 * (1 - k) * (1 - k);
      });
    }
    // ground dust thrown out in a ring
    if (low) {
      for (let i = 0; i < 18; i++) {
        const a = (i / 18) * Math.PI * 2 + rand(-0.2, 0.2);
        const s = sprite(T.smoke, THREE.NormalBlending, new THREE.Color(0.44, 0.41, 0.36), 0);
        const vel = new THREE.Vector3(Math.cos(a), 0, Math.sin(a)).multiplyScalar(rand(7, 13));
        s.position.set(c.x, ground + 0.3, c.z);
        const size = rand(1.4, 2.6), life = rand(2.2, 3.6);
        add(s, life, (f, k, dt) => {
          s.position.addScaledVector(vel, dt); vel.multiplyScalar(1 - dt * 3.5); s.position.y += dt * 0.25;
          s.scale.setScalar(size * (0.5 + 1.4 * k));
          s.material.opacity = Math.min(1, f.age * 10) * 0.5 * (1 - k);
        });
      }
      // shock ring flat on the ground
      const ring = new THREE.Mesh(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ map: T.ring, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, color: 0xffe2b8 }));
      ring.position.set(c.x, ground + 0.03, c.z);
      this.scene.add(ring);
      add(ring, 0.38, (f, k) => { ring.scale.setScalar(0.5 + k * 17); ring.material.opacity = (1 - k) * 0.6; });
    }
    // sparks / burning bits
    for (let i = 0; i < 150 && this.sparks.length < this.maxSparks; i++) {
      const d = new THREE.Vector3(rand(-1, 1), rand(-0.2, 1.2), rand(-1, 1)).normalize();
      this.sparks.push({ p: c.clone(), v: d.multiplyScalar(rand(6, 24)), life: rand(0.3, 1.5), age: 0 });
    }
    this.gore.dust(c.clone().setY(ground + 0.02), UP, 70);
  }

  /** Black residue on the floor under the blast and on any wall or block face close by. */
  scorch(c) {
    const ground = this.gore.particles.surfaceHeight(c.x, c.y + 0.05, c.z);
    const h = c.y - ground;
    if (h < 1.8) this.gore.decals.addScorch(new THREE.Vector3(c.x, ground, c.z), UP, (1.6 + Math.random() * 0.4) * (1 - h / 2.6), 1 - h / 2);
    for (const col of this.map.colliders) {
      const q = _v.set(clamp(c.x, col.min.x, col.max.x), clamp(c.y, col.min.y, col.max.y), clamp(c.z, col.min.z, col.max.z));
      const d = q.distanceTo(c);
      if (d < 1e-4 || d > 2.4) continue;
      // which face is it: the axis where the centre is furthest outside the box
      const out = [c.x < col.min.x ? col.min.x - c.x : c.x > col.max.x ? c.x - col.max.x : 0,
        c.y < col.min.y ? col.min.y - c.y : c.y > col.max.y ? c.y - col.max.y : 0,
        c.z < col.min.z ? col.min.z - c.z : c.z > col.max.z ? c.z - col.max.z : 0];
      const ax = out.indexOf(Math.max(...out));
      if (ax === 1 && c.y > col.max.y && h < 1.8 && ground >= col.max.y - 0.01) continue; // already the floor scorch
      const n = new THREE.Vector3();
      n.setComponent(ax, (ax === 0 ? c.x : ax === 1 ? c.y : c.z) < col.min.getComponent(ax) ? -1 : 1);
      const k = 1 - d / 2.4;
      const pt = q.clone();
      // on a side face, centre the mark a little above a blast at floor level
      if (ax !== 1) pt.y = clamp(Math.max(pt.y, c.y + 0.3), col.min.y, col.max.y - 0.1);
      // don't let it hang far past the edges of the face (the bottom edge meets the floor, so that one is fine)
      let edge = Infinity;
      for (let a = 0; a < 3; a++) {
        if (a === ax) continue;
        const lo = pt.getComponent(a) - col.min.getComponent(a), hi = col.max.getComponent(a) - pt.getComponent(a);
        edge = Math.min(edge, hi, a === 1 && col.min.y <= 0.01 ? Infinity : lo);
      }
      const radius = Math.min(0.5 + 1.0 * k, edge + 0.22);
      if (radius > 0.15) this.gore.decals.addScorch(pt, n, radius, k);
    }
  }

  /** Damage, bruises, soot and knockback on every ragdoll part in range; pushes gibs and grenades. */
  blast(c) {
    const dismember = settings.get('dismemberment');
    for (const r of [...this.ragdolls.list]) {
      const todo = [];
      let any = false;
      for (const [name, part] of Object.entries(r.parts)) {
        if (part.removed) continue;
        const b = part.body;
        _v.set(b.position.x, b.position.y, b.position.z);
        const d = _v.distanceTo(c);
        if (d > RADIUS) continue;
        // walls and blocks shield from the blast
        _d.copy(_v).sub(c).normalize();
        this.raycaster.set(c, _d); this.raycaster.far = d;
        const blocked = this.raycaster.intersectObjects(this.map.solidMeshes, false).some((hh) => hh.distance < d - 0.12 && hh.distance > 0.05);
        let k = Math.pow(1 - d / RADIUS, 2) * (blocked ? 0.2 : 1);
        if (d < 0.6) k = Math.max(k, 1 - d * 0.15);
        if (k < 0.01) continue;
        any = true;
        // knockback: a velocity kick away from the blast (light limbs and the heavy torso both fly)
        const dir = _d.clone().addScaledVector(UP, 0.35).normalize();
        const dv = Math.min(24, 30 * k);
        b.velocity.x += dir.x * dv; b.velocity.y += dir.y * dv; b.velocity.z += dir.z * dv;
        b.angularVelocity.x += rand(-1, 1) * 18 * k; b.angularVelocity.y += rand(-1, 1) * 18 * k; b.angularVelocity.z += rand(-1, 1) * 18 * k;
        const res = r.health.blast(name, k, { dismember });
        const face = _v.clone().addScaledVector(_d, -0.08);
        this.gore.addBruise(r, name, face, Math.min(1, k * 1.6));
        if (k > 0.22) this.gore.addBruise(r, name, face, k, { soot: true });
        // heat from the fireball: burns on the side facing it, and the part smoulders for a bit
        const heat = blocked ? 0 : Math.pow(clamp(1 - d / BURN_RADIUS), 1.2);
        if (heat > 0.03) {
          r.health.burn(name, heat);
          if (heat > 0.12) this.gore.addBruise(r, name, face.clone().add(new THREE.Vector3(rand(-0.03, 0.03), rand(-0.03, 0.03), rand(-0.03, 0.03))), Math.min(1, heat * 1.3), { burn: true });
          if (heat > 0.3) this.smoulder.push({ r, name, t: 1.5 + heat * 4, acc: 0 });
        }
        if (res.fractured && k > 0.3) this.gore.impactBlood(_v.clone(), 6 + k * 10);
        todo.push({ name, res, dir });
      }
      if (!any) continue;
      r.brain.fall();
      // body parts that are blown off or apart
      let blown = 0;
      for (const { name, res, dir } of todo) {
        const part = r.parts[name];
        if (!part || part.removed) continue;
        if (res.explode && blown < 6) { blown++; this.gore.explodePart(r, name, dir); }
        else if (res.sever && r.sever(name).length) { this.gore.onSever(r, name); part.body.velocity.y += 3; }
      }
    }
    for (const gib of this.gore.gibs) {
      const b = gib.body; _v.set(b.position.x, b.position.y, b.position.z);
      const d = _v.distanceTo(c); if (d > RADIUS) continue;
      _d.copy(_v).sub(c).normalize().addScaledVector(UP, 0.4);
      const dv = 28 * (1 - d / RADIUS) ** 2;
      b.velocity.x += _d.x * dv; b.velocity.y += _d.y * dv; b.velocity.z += _d.z * dv;
    }
    for (const g of [...this.live]) {
      const b = g.body; _v.set(b.position.x, b.position.y, b.position.z);
      const d = _v.distanceTo(c); if (d > RADIUS) continue;
      _d.copy(_v).sub(c).normalize().addScaledVector(UP, 0.4);
      const dv = 14 * (1 - d / RADIUS) ** 2;
      b.velocity.x += _d.x * dv; b.velocity.y += _d.y * dv; b.velocity.z += _d.z * dv;
    }
  }

  // ---------------------------------------------------------------- update
  /** dt = world (time-scaled) seconds. */
  update(dt) {
    // A grenade isn't a smooth ball (lever, fuse head, rough casing) and the floor is rough
    // concrete: once it's resting on something it stops rolling within a short distance
    // instead of sliding away like a marble.
    if (this.live.length) {
      const grounded = new Set();
      for (const c of this.physics.world.contacts) {
        // ni points from bi to bj: the surface pushes the grenade along -ni (if it's bi) or +ni
        const g = this.byBody.get(c.bi) || this.byBody.get(c.bj);
        if (!g) continue;
        const upY = this.byBody.get(c.bi) === g ? -c.ni.y : c.ni.y;
        if (upY > 0.55) grounded.add(g);
      }
      for (const g of grounded) {
        const b = g.body, v = b.velocity, w = b.angularVelocity;
        const k = Math.exp(-5.5 * dt), kw = Math.exp(-7 * dt);
        v.x *= k; v.z *= k;
        w.x *= kw; w.y *= kw; w.z *= kw;
        if (Math.hypot(v.x, v.z) < 0.12 && Math.abs(v.y) < 0.3) { v.x = v.z = 0; w.set(0, 0, 0); }
      }
    }
    for (const g of [...this.live]) {
      g.mesh.position.set(g.body.position.x, g.body.position.y, g.body.position.z);
      g.mesh.quaternion.set(g.body.quaternion.x, g.body.quaternion.y, g.body.quaternion.z, g.body.quaternion.w);
      g.fuse -= dt;
      // thin smoke wisp from the burning fuse
      g.smokeT -= dt;
      if (g.smokeT <= 0) { g.smokeT = 0.07; this.wisp(g.mesh.position); }
      if (g.fuse <= 0) this.detonate(g);
    }
    for (const s of this.spoons) {
      if (s.rest) continue;
      s.age += dt;
      s.vel.y -= 9.81 * dt;
      s.mesh.position.addScaledVector(s.vel, dt);
      s.mesh.rotation.x += s.spin.x * dt; s.mesh.rotation.y += s.spin.y * dt; s.mesh.rotation.z += s.spin.z * dt;
      const floor = this.gore.particles.surfaceHeight(s.mesh.position.x, s.mesh.position.y, s.mesh.position.z) + 0.004;
      if (s.mesh.position.y < floor) {
        s.mesh.position.y = floor;
        if (Math.abs(s.vel.y) > 0.8) { s.vel.y *= -0.3; s.vel.x *= 0.5; s.vel.z *= 0.5; s.spin.multiplyScalar(0.4); this.audio.play('casing'); }
        else { s.rest = true; s.mesh.rotation.set(0, Math.random() * 6.28, Math.PI / 2); }
      }
    }
    for (const sm of this.smoulder) {
      sm.t -= dt; sm.acc += dt;
      const part = sm.r.parts[sm.name];
      if (sm.r.removed || !part || part.removed) { sm.t = 0; continue; }
      if (sm.acc > 0.12) { sm.acc = 0; this.wisp(part.group.position, 0.45); }
    }
    this.smoulder = this.smoulder.filter((sm) => sm.t > 0);
    for (const f of this.fx) {
      f.age += dt;
      const k = Math.min(1, f.age / f.life);
      f.fn(f, k, dt);
      if (f.age >= f.life) { this.scene.remove(f.s); f.s.material.dispose(); f.dead = true; }
    }
    this.fx = this.fx.filter((f) => !f.dead);
    // flash light
    this.lightT += dt;
    this.light.intensity = this.lightT < 0.35 ? 300 * Math.pow(1 - this.lightT / 0.35, 2.2) : 0;
    // sparks
    let n = 0;
    for (const s of this.sparks) {
      s.age += dt;
      if (s.age >= s.life) continue;
      s.v.y -= 9.81 * dt; s.v.multiplyScalar(1 - dt * 1.5);
      s.p.addScaledVector(s.v, dt);
      if (s.p.y < 0.01) { s.p.y = 0.01; s.v.y *= -0.3; s.v.x *= 0.6; s.v.z *= 0.6; }
      const k = 1 - s.age / s.life;
      this.sparkPos[n * 3] = s.p.x; this.sparkPos[n * 3 + 1] = s.p.y; this.sparkPos[n * 3 + 2] = s.p.z;
      this.sparkCol[n * 3] = 1 * k; this.sparkCol[n * 3 + 1] = 0.55 * k * k; this.sparkCol[n * 3 + 2] = 0.15 * k * k * k;
      n++;
    }
    this.sparks = this.sparks.filter((s) => s.age < s.life);
    const sg = this.sparkPoints.geometry;
    sg.setDrawRange(0, n);
    sg.attributes.position.needsUpdate = true; sg.attributes.color.needsUpdate = true;
  }

  wisp(pos, shade = 0.75) {
    const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.tex.smoke, color: new THREE.Color(shade, shade, shade * 0.98), transparent: true, depthWrite: false, opacity: 0 }));
    s.position.copy(pos).add(new THREE.Vector3(0, 0.05, 0));
    this.scene.add(s);
    const vel = new THREE.Vector3(rand(-0.05, 0.05), rand(0.25, 0.45), rand(-0.05, 0.05));
    this.fx.push({ s, life: 1.4, age: 0, fn: (f, k, dt) => { s.position.addScaledVector(vel, dt); s.scale.setScalar(0.06 + k * 0.3); s.material.opacity = 0.35 * (1 - k) * Math.min(1, f.age * 10); } });
  }

  clear() {
    for (const g of this.live) { this.physics.world.removeBody(g.body); this.scene.remove(g.mesh); }
    this.live = [];
    this.byBody.clear();
    for (const s of this.spoons) this.scene.remove(s.mesh);
    this.spoons = [];
    this.smoulder = [];
  }
}

function lerp(a, b, t) { return a + (b - a) * t; }
