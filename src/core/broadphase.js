import * as CANNON from 'cannon-es';

const CELL = 6;              // metres per grid cell for the static bodies
const MAX_CELLS = 400;       // a static body covering more cells than this is tested against everything
const STATIC = CANNON.Body.STATIC;

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
 * its box touches, and the moving bodies are swept against each other along x.
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
      if (!(n <= MAX_CELLS) || x0 < -500 || x1 > 500 || y0 < -500 || y1 > 500 || z0 < -500 || z1 > 500) { this.global.push(b); continue; }
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
      for (let k = 0; k < this.global.length; k++) this.test(b, this.global[k], p1, p2);
    }

    // moving against moving: sort by the low x of their boxes (nearly sorted already) and sweep
    for (let i = 1; i < moving.length; i++) {
      const b = moving[i], x = b.aabb.lowerBound.x;
      let j = i - 1;
      while (j >= 0 && moving[j].aabb.lowerBound.x > x) { moving[j + 1] = moving[j]; j--; }
      moving[j + 1] = b;
    }
    for (let i = 0; i < moving.length; i++) {
      const a = moving[i], ax = a.aabb.upperBound.x;
      for (let j = i + 1; j < moving.length; j++) {
        const b = moving[j];
        if (b.aabb.lowerBound.x > ax) break;
        this.test(a, b, p1, p2);
      }
    }
  }

  test(a, b, p1, p2) {
    if (!this.needBroadphaseCollision(a, b)) return;
    if (!a.aabb.overlaps(b.aabb)) return;
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
