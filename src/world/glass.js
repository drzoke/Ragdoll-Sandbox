import * as THREE from 'three';

const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _p = new THREE.Vector3(), _s = new THREE.Vector3();
const _e = new THREE.Euler();
const Y = new THREE.Vector3(0, 1, 0);
const ZERO = new THREE.Matrix4().makeScale(0, 0, 0);

/**
 * Breakable window panes: one instanced mesh for all of them. Each pane has a player collider,
 * a box in a static physics body and an invisible bullet target. Bullets, blasts and ragdolls
 * thrown hard enough break a pane: it falls apart into shards and leaves the frame open.
 */
export class GlassPanes {
  constructor(map, { material, max = 700, audio = null }) {
    this.map = map;
    this.audio = audio;
    this.mesh = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), material, max);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 2;
    map.add(this.mesh, { quality: false });
    this.panes = [];
    this.byShape = new Map();
    this.queue = [];
    this.watched = new Set();
    // shards: thin triangles with their own little physics, resting where they land
    const tri = new THREE.BufferGeometry();
    tri.setAttribute('position', new THREE.Float32BufferAttribute([-0.5, -0.4, 0, 0.5, -0.3, 0, 0.05, 0.6, 0], 3));
    tri.setAttribute('normal', new THREE.Float32BufferAttribute([0, 0, 1, 0, 0, 1, 0, 0, 1], 3));
    this.shardMax = 900;
    this.shardMesh = new THREE.InstancedMesh(tri, new THREE.MeshStandardMaterial({ color: 0xbfd6e0, roughness: 0.05, metalness: 0.3, transparent: true, opacity: 0.55, side: THREE.DoubleSide, depthWrite: false }), this.shardMax);
    this.shardMesh.count = 0;
    this.shardMesh.frustumCulled = false;
    map.add(this.shardMesh, { quality: false });
    this.shards = [];
    this.shardNext = 0;
  }

  /**
   * A pane centred at (x, y, z), w wide and h tall, in the plane facing along `axis` ('x' or 'z').
   * body: compound physics body key, cluster: bullet-target cluster.
   */
  add(x, y, z, w, h, axis, { body, cluster }) {
    const i = this.mesh.count++;
    _q.setFromAxisAngle(Y, axis === 'x' ? Math.PI / 2 : 0);
    const matrix = new THREE.Matrix4().compose(_p.set(x, y, z), _q, _s.set(w, h, 1));
    this.mesh.setMatrixAt(i, matrix);
    const T = 0.1;
    const [bw, bd] = axis === 'x' ? [T, w] : [w, T];
    const pane = { i, x, y, z, w, h, axis, matrix, broken: false };
    const s = this.map.solid(x, y, z, bw, h, bd, { body, proxy: cluster, surface: 'glass', data: { glass: pane } });
    Object.assign(pane, { collider: s.collider, shape: s.shape, body: s.body, proxy: s.proxy, cluster, offset: s.body.shapeOffsets[s.body.shapes.length - 1].clone() });
    this.byShape.set(s.shape, pane);
    this.panes.push(pane);
    if (!this.watched.has(s.body)) {
      this.watched.add(s.body);
      const b = s.body;
      // ragdolls and gibs thrown into the glass: queue it (bodies can't change shape mid-step)
      b.addEventListener('collide', (e) => {
        const c = e.contact;
        const mine = c.bi === b ? c.si : c.sj;
        const p = this.byShape.get(mine);
        if (!p || p.broken || p.queued) return;
        const v = Math.abs(c.getImpactVelocityAlongNormal());
        if (v > 3.4) { p.queued = true; this.queue.push({ pane: p, dir: new THREE.Vector3(e.body.velocity.x, e.body.velocity.y, e.body.velocity.z).normalize(), power: v }); }
      });
    }
    return pane;
  }

  finish() { this.mesh.instanceMatrix.needsUpdate = true; this.mesh.computeBoundingSphere?.(); }

  /** Break a pane. dir: which way the shards fly. */
  breakPane(pane, dir = null, power = 4) {
    if (pane.broken) return;
    pane.broken = true; pane.queued = false;
    this.mesh.setMatrixAt(pane.i, ZERO);
    this.mesh.instanceMatrix.needsUpdate = true;
    pane.collider.off = true;
    if (pane.body.shapes.includes(pane.shape)) pane.body.removeShape(pane.shape);
    const items = pane.cluster.items, k = items.indexOf(pane.proxy);
    if (k >= 0) items.splice(k, 1);
    this.audio?.play('glass');
    // shards: spread over the pane, pushed the way the hit went, falling under gravity
    const n = 26;
    const nx = pane.axis === 'x' ? 1 : 0, nz = pane.axis === 'z' ? 1 : 0;
    const out = dir ? Math.sign(dir.x * nx + dir.z * nz) || 1 : 1;
    for (let s = 0; s < n; s++) {
      const u = Math.random() - 0.5, v = Math.random() - 0.5;
      const p = new THREE.Vector3(pane.x + (nz ? u * pane.w : 0), pane.y + v * pane.h, pane.z + (nx ? u * pane.w : 0));
      const vel = new THREE.Vector3(nx * out * (0.5 + Math.random() * 2) * power * 0.35, Math.random() * 1.2, nz * out * (0.5 + Math.random() * 2) * power * 0.35);
      vel.x += (Math.random() - 0.5) * 1.2; vel.z += (Math.random() - 0.5) * 1.2;
      this.spawnShard(p, vel, 0.06 + Math.random() * 0.16);
    }
  }

  spawnShard(p, v, size) {
    const i = this.shardNext; this.shardNext = (this.shardNext + 1) % this.shardMax;
    this.shards[i] = { p, v, size, rot: new THREE.Euler(Math.random() * 6, Math.random() * 6, Math.random() * 6), spin: new THREE.Vector3((Math.random() - 0.5) * 18, (Math.random() - 0.5) * 18, (Math.random() - 0.5) * 18), rest: false };
    this.shardMesh.count = Math.max(this.shardMesh.count, i + 1);
  }

  /** A bullet went through: break it and let the bullet carry on. */
  shot(pane, dir) { this.breakPane(pane, dir, 3); }

  /** A blast at c: break panes within radius. */
  blast(c, radius = 5) {
    for (const p of this.panes) {
      if (p.broken) continue;
      const dx = Math.max(Math.abs(c.x - p.x) - (p.axis === 'z' ? p.w / 2 : 0.05), 0);
      const dz = Math.max(Math.abs(c.z - p.z) - (p.axis === 'x' ? p.w / 2 : 0.05), 0);
      const dy = Math.max(Math.abs(c.y - p.y) - p.h / 2, 0);
      const d = Math.hypot(dx, dy, dz);
      if (d < radius) this.breakPane(p, new THREE.Vector3(p.x - c.x, 0, p.z - c.z).normalize(), 6 * (1 - d / radius) + 2);
    }
  }

  /** Clean up: every window back in its frame, shards swept away. */
  repair() {
    for (const p of this.panes) {
      if (!p.broken) continue;
      p.broken = false; p.queued = false;
      this.mesh.setMatrixAt(p.i, p.matrix);
      p.collider.off = false;
      if (!p.body.shapes.includes(p.shape)) p.body.addShape(p.shape, p.offset);
      if (!p.cluster.items.includes(p.proxy)) p.cluster.items.push(p.proxy);
    }
    this.queue.length = 0;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.shards = []; this.shardMesh.count = 0; this.shardNext = 0;
  }

  update(dt) {
    while (this.queue.length) { const q = this.queue.shift(); this.breakPane(q.pane, q.dir, q.power); }
    let moved = false;
    for (let i = 0; i < this.shards.length; i++) {
      const s = this.shards[i];
      if (!s || s.rest) continue;
      moved = true;
      s.v.y -= 9.81 * dt;
      s.p.addScaledVector(s.v, dt);
      s.rot.x += s.spin.x * dt; s.rot.y += s.spin.y * dt; s.rot.z += s.spin.z * dt;
      const floor = this.map.surfaceHeight(s.p.x, s.p.y, s.p.z) + 0.004;
      if (s.p.y < floor) {
        s.p.y = floor;
        if (s.v.y < -2.5) { s.v.y *= -0.2; s.v.x *= 0.4; s.v.z *= 0.4; s.spin.multiplyScalar(0.3); }
        else { s.rest = true; s.rot.set(-Math.PI / 2, 0, Math.random() * 6.28); }
      }
      _q.setFromEuler(_e.copy(s.rot));
      _m.compose(s.p, _q, _s.setScalar(s.size));
      this.shardMesh.setMatrixAt(i, _m);
    }
    if (moved) this.shardMesh.instanceMatrix.needsUpdate = true;
  }
}
