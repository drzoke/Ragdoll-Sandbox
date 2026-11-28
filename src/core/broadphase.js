import * as CANNON from '../../lib/cannon-es.js';   // a relative path: the physics worker has no import map

const CELL = 6;              // metres per grid cell for the static bodies
const MAX_CELLS = 400;       // a static body covering more cells than this is tested against everything
const STATIC = CANNON.Body.STATIC;
const _c = new CANNON.Vec3();
const MCELL = 2;             // metres per column for the moving bodies

/**
 * Broadphase for maps with lots of static geometry and a few hundred moving bodies.
 *
 * cannon-es's sweep-and-prune measures bodies by their bounding spheres around the body's origin.
 * The maps' static bodies are compounds of many boxes placed around the world origin, so their
 * spheres are tens of metres wide: every ragdoll part was paired with almost every static body,
 * and the sweep walked every static-static pair on each step.
 *
 * Here the static bodies sit in a uniform grid by their real boxes (rebuilt only when a body is
 * added or removed, or a static body's shapes change), each moving body looks up only the cells
 * its box touches, and the moving bodies are sorted into 2 m columns and only tested against bodies
 * in the same column. Pairs joined by a joint that doesn't collide are dropped here too, and an
 * infinite ground plane is only paired with bodies that reach down to it.
 */
export class MapBroadphase extends CANNON.Broadphase {
  constructor(world) {
    super(world);
    this.useBoundingBoxes = true;
    this.cells = new Map();
    this.global = [];          // huge statics (the ground plane, boundary walls)
    this.statics = [];
    this.moving = [];
    this.stamp = 0;
    this.staticDirty = true;
    this.cols = new Map();     // moving bodies by 2 m column, reused between steps
    this.used = [];
    this.big = [];
    this.skip = new Set();     // body pairs joined by a joint that doesn't collide (see collisionPairs)
    const mark = () => { this.staticDirty = true; };
    world.addEventListener('addBody', mark);
    world.addEventListener('removeBody', mark);
  }

  key(ix, iy, iz) { return (ix + 512) * 1048576 + (iy + 512) * 1024 + (iz + 512); }

  rebuildStatics(bodies) {
    this.cells.clear();
    this.global.length = 0;
    this.statics.length = 0;
    for (let i = 0; i < bodies.length; i++) {
      const b = bodies[i];
      if (b.type !== STATIC) continue;
      this.statics.push(b);
      if (b.aabbNeedsUpdate) b.updateAABB();
      const lo = b.aabb.lowerBound, hi = b.aabb.upperBound;
      const x0 = Math.floor(lo.x / CELL), x1 = Math.floor(hi.x / CELL);
      const y0 = Math.floor(lo.y / CELL), y1 = Math.floor(hi.y / CELL);
      const z0 = Math.floor(lo.z / CELL), z1 = Math.floor(hi.z / CELL);
      const n = (x1 - x0 + 1) * (y1 - y0 + 1) * (z1 - z0 + 1);
      if (!(n <= MAX_CELLS) || x0 < -500 || x1 > 500 || y0 < -500 || y1 > 500 || z0 < -500 || z1 > 500) {
        // an infinite plane (the ground) has an infinite box: keep its real height so only bodies
        // that reach down to it get paired with it
        b._plane = null;
        if (b.shapes.length === 1 && b.shapes[0].type === CANNON.Shape.types.PLANE) {
          const nrm = b.quaternion.vmult(new CANNON.Vec3(0, 0, 1));
          b._plane = { n: nrm, d: nrm.dot(b.position) };
        }
        this.global.push(b);
        continue;
      }
      for (let ix = x0; ix <= x1; ix++) for (let iy = y0; iy <= y1; iy++) for (let iz = z0; iz <= z1; iz++) {
        const k = this.key(ix, iy, iz);
        let list = this.cells.get(k);
        if (!list) { list = []; this.cells.set(k, list); }
        list.push(b);
      }
    }
    this.staticDirty = false;
  }

  collisionPairs(world, p1, p2) {
    const bodies = world.bodies;
    // Joined body pairs that shouldn't collide (ragdoll joints) are dropped here. cannon-es would
    // otherwise drop them after the broadphase by checking every joint against every pair, which
    // grows with the square of the ragdoll count; those joints are marked skipCollide (and
    // collideConnected, so cannon-es leaves them alone).
    const skip = this.skip;
    skip.clear();
    const cons = world.constraints;
    for (let i = 0; i < cons.length; i++) {
      const c = cons[i];
      if (c.skipCollide) skip.add(this.pairKey(c.bodyA, c.bodyB));
    }
    // a static body whose shapes changed (a pane of glass breaking) gets a new box: re-grid
    if (!this.staticDirty) for (let i = 0; i < this.statics.length; i++) if (this.statics[i].aabbNeedsUpdate) { this.staticDirty = true; break; }
    if (this.staticDirty) this.rebuildStatics(bodies);

    const moving = this.moving;
    moving.length = 0;
    for (let i = 0; i < bodies.length; i++) {
      const b = bodies[i];
      if (b.type === STATIC) continue;
      if (b.aabbNeedsUpdate) b.updateAABB();
      moving.push(b);
    }

    // moving against static: the grid cells each moving box touches
    for (let i = 0; i < moving.length; i++) {
      const b = moving[i];
      if (b.collisionFilterMask === 0 || b.collisionFilterGroup === 0) continue;
      const stamp = ++this.stamp;
      const lo = b.aabb.lowerBound, hi = b.aabb.upperBound;
      const x0 = Math.floor(lo.x / CELL), x1 = Math.floor(hi.x / CELL);
      const y0 = Math.floor(lo.y / CELL), y1 = Math.floor(hi.y / CELL);
      const z0 = Math.floor(lo.z / CELL), z1 = Math.floor(hi.z / CELL);
      if ((x1 - x0 + 1) * (y1 - y0 + 1) * (z1 - z0 + 1) > 64) {
        // a very fast or very big moving body: test it against every static body
        for (let k = 0; k < this.statics.length; k++) this.test(b, this.statics[k], p1, p2);
        continue;
      }
      for (let ix = x0; ix <= x1; ix++) for (let iy = y0; iy <= y1; iy++) for (let iz = z0; iz <= z1; iz++) {
        const list = this.cells.get(this.key(ix, iy, iz));
        if (!list) continue;
        for (let k = 0; k < list.length; k++) {
          const s = list[k];
          if (s._bpStamp === stamp) continue;
          s._bpStamp = stamp;
          this.test(b, s, p1, p2);
        }
      }
      for (let k = 0; k < this.global.length; k++) {
        const s = this.global[k], pl = s._plane;
        if (pl) {
          // lowest point of the moving box along the plane's normal, against the plane
          const c = _c.set((lo.x + hi.x) / 2, (lo.y + hi.y) / 2, (lo.z + hi.z) / 2), n = pl.n;
          const reach = Math.abs(n.x) * (hi.x - lo.x) / 2 + Math.abs(n.y) * (hi.y - lo.y) / 2 + Math.abs(n.z) * (hi.z - lo.z) / 2;
          if (n.dot(c) - reach - pl.d > 0.02) continue;
        }
        this.test(b, s, p1, p2);
      }
    }

    // moving against moving: a grid of 2 m columns (x, z). Each body goes in the columns its box
    // touches and is only tested against bodies sharing one (a sweep along x tested every ragdoll
    // standing in a line with each other, part by part).
    const cols = this.cols, used = this.used, big = this.big;
    for (let i = 0; i < used.length; i++) used[i].list.length = 0;
    used.length = 0; big.length = 0;
    for (let i = 0; i < moving.length; i++) {
      const b = moving[i];
      if (b.collisionFilterMask === 0 || b.collisionFilterGroup === 0) continue;
      const lo = b.aabb.lowerBound, hi = b.aabb.upperBound;
      const x0 = Math.floor(lo.x / MCELL), x1 = Math.floor(hi.x / MCELL);
      const z0 = Math.floor(lo.z / MCELL), z1 = Math.floor(hi.z / MCELL);
      b._mx0 = x0; b._mz0 = z0;
      if ((x1 - x0 + 1) * (z1 - z0 + 1) > 16 || x0 < -30000 || x1 > 30000 || z0 < -30000 || z1 > 30000) { big.push(b); continue; }
      for (let ix = x0; ix <= x1; ix++) for (let iz = z0; iz <= z1; iz++) {
        const key = (ix + 32768) * 65536 + (iz + 32768);
        let c = cols.get(key);
        if (!c) { c = { x: ix, z: iz, list: [] }; cols.set(key, c); }
        if (!c.list.length) used.push(c);
        c.list.push(b);
      }
    }
    for (let u = 0; u < used.length; u++) {
      const c = used[u], list = c.list;
      for (let i = 0; i < list.length; i++) {
        const a = list[i];
        for (let j = i + 1; j < list.length; j++) {
          const b = list[j];
          // a pair sharing several columns is tested only in the first one they share
          if ((a._mx0 > b._mx0 ? a._mx0 : b._mx0) !== c.x || (a._mz0 > b._mz0 ? a._mz0 : b._mz0) !== c.z) continue;
          this.test(a, b, p1, p2);
        }
      }
    }
    // very big or very fast bodies: against every other moving body (each pair of them once)
    if (big.length) {
      const mark = ++this.stamp;
      for (let i = 0; i < big.length; i++) big[i]._bigMark = mark;
      for (let i = 0; i < big.length; i++) {
        const a = big[i];
        for (let j = 0; j < moving.length; j++) { const b = moving[j]; if (b._bigMark !== mark) this.test(a, b, p1, p2); }
        for (let j = i + 1; j < big.length; j++) this.test(a, big[j], p1, p2);
      }
    }
    if (cols.size > 4096) cols.clear();    // forget columns nobody has been in for a while
  }

  pairKey(a, b) { return a.id > b.id ? a.id * 4194304 + b.id : b.id * 4194304 + a.id; }

  test(a, b, p1, p2) {
    if (!this.needBroadphaseCollision(a, b)) return;
    if (!a.aabb.overlaps(b.aabb)) return;
    if (this.skip.size && this.skip.has(this.pairKey(a, b))) return;
    p1.push(a); p2.push(b);
  }

  aabbQuery(world, aabb, result = []) {
    for (const b of world.bodies) {
      if (b.aabbNeedsUpdate) b.updateAABB();
      if (b.aabb.overlaps(aabb)) result.push(b);
    }
    return result;
  }
}

/**
 * Which body pairs touched this step (cannon-es keeps one for this step and one for the last).
 * The default matrix has a slot for every possible pair and clears all of them each step, which
 * grows with the square of the body count; this keeps only the pairs that touch.
 */
export class PairSet {
  constructor() { this.set_ = new Set(); }
  k(bi, bj) { const a = bi.id, b = bj.id; return a > b ? a * 4194304 + b : b * 4194304 + a; }
  get(bi, bj) { return this.set_.has(this.k(bi, bj)); }
  set(bi, bj, value) { if (value) this.set_.add(this.k(bi, bj)); else this.set_.delete(this.k(bi, bj)); }
  reset() { this.set_.clear(); }
  setNumObjects() {}
}
