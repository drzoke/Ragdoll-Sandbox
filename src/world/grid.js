import * as THREE from 'three';

/**
 * Uniform 3D grid over axis-aligned boxes, so collision code only looks at the boxes near a point
 * instead of every box in the map (a skyscraper has thousands).
 */
export class ColliderGrid {
  constructor(cell = 4, cellY = 4) {
    this.cell = cell; this.cellY = cellY;
    this.cells = new Map();
    this.stamp = 0;
    this.out = [];
  }

  key(ix, iy, iz) { return ((ix + 2048) * 4096 + (iz + 2048)) * 256 + (iy + 64); }

  clear() { this.cells.clear(); }

  insert(c) {
    const s = this.cell, sy = this.cellY;
    const x0 = Math.floor(c.min.x / s), x1 = Math.floor(c.max.x / s);
    const z0 = Math.floor(c.min.z / s), z1 = Math.floor(c.max.z / s);
    const y0 = Math.floor(c.min.y / sy), y1 = Math.floor(c.max.y / sy);
    c._s = 0;
    for (let x = x0; x <= x1; x++) for (let z = z0; z <= z1; z++) for (let y = y0; y <= y1; y++) {
      const k = this.key(x, y, z);
      let list = this.cells.get(k);
      if (!list) this.cells.set(k, list = []);
      list.push(c);
    }
  }

  remove(c) {
    const s = this.cell, sy = this.cellY;
    for (let x = Math.floor(c.min.x / s); x <= Math.floor(c.max.x / s); x++)
      for (let z = Math.floor(c.min.z / s); z <= Math.floor(c.max.z / s); z++)
        for (let y = Math.floor(c.min.y / sy); y <= Math.floor(c.max.y / sy); y++) {
          const list = this.cells.get(this.key(x, y, z));
          const i = list ? list.indexOf(c) : -1;
          if (i >= 0) list.splice(i, 1);
        }
  }

  /** Boxes whose cells touch the query box. Returns a shared array: use it before the next query. */
  query(minX, minY, minZ, maxX, maxY, maxZ) {
    const s = this.cell, sy = this.cellY, out = this.out;
    out.length = 0;
    const st = ++this.stamp;
    const x0 = Math.floor(minX / s), x1 = Math.floor(maxX / s);
    const z0 = Math.floor(minZ / s), z1 = Math.floor(maxZ / s);
    const y0 = Math.floor(minY / sy), y1 = Math.floor(maxY / sy);
    for (let x = x0; x <= x1; x++) for (let z = z0; z <= z1; z++) for (let y = y0; y <= y1; y++) {
      const list = this.cells.get(this.key(x, y, z));
      if (!list) continue;
      for (let i = 0; i < list.length; i++) { const c = list[i]; if (c._s !== st) { c._s = st; out.push(c); } }
    }
    return out;
  }
}

const _box = new THREE.Box3(), _hit = new THREE.Vector3();

/**
 * A cluster of invisible box meshes that bullets, the grenade arc and the spawn ray hit. It tests
 * its bounding box first, so a ray only checks the boxes of the floor or block it actually passes.
 * Hits report the child box (with its userData.surface), like any mesh in solidMeshes.
 */
export class ProxyCluster extends THREE.Object3D {
  constructor() {
    super();
    this.items = [];
    this.bounds = new THREE.Box3();
  }

  push(mesh) {
    mesh.updateMatrixWorld(true);
    if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
    this.bounds.union(_box.copy(mesh.geometry.boundingBox).applyMatrix4(mesh.matrixWorld));
    this.items.push(mesh);
    return mesh;
  }

  raycast(raycaster, intersects) {
    const ray = raycaster.ray;
    if (!this.bounds.containsPoint(ray.origin)) {
      if (!ray.intersectBox(this.bounds, _hit)) return;
      if (_hit.distanceTo(ray.origin) > raycaster.far) return;
    }
    for (const m of this.items) m.raycast(raycaster, intersects);
  }
}
