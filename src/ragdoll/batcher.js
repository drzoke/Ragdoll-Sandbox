import * as THREE from 'three';

/**
 * Draws the many small meshes that ride on ragdolls (body parts, joint balls, eyes, wound and
 * bruise decals, burn shells) with one instanced draw call per kind of mesh for all ragdolls
 * together, instead of one draw call per mesh (31 per ragdoll before a single wound, and again
 * for the shadows).
 *
 * The original meshes stay where they are in the scene graph as "holders": bullets, the grab tool
 * and the X-ray still find them, they move with their part, and hiding them (or their part or
 * ragdoll) still hides them. Only their material is swapped for an invisible one; the real one is
 * kept in userData.drawMat. Each frame the holders' world matrices are copied into the instanced
 * meshes.
 *
 * Per-instance looks (bruises fading, burns glowing) come from holder.userData.fx:
 * { color: THREE.Color, opacity, emissive } (see fxMaterial).
 */
export const HIDDEN = new THREE.MeshBasicMaterial({ visible: false });

const kinds = new Map();         // drawMat -> Map(geometry -> kind)
const holders = [];
const roots = new Set();         // ragdoll roots (their matrices are refreshed before copying)
let scene = null;

/** Draw this mesh through the batcher from now on. */
export function batch(mesh, root = null) {
  if (mesh.userData.drawMat) return mesh;
  mesh.userData.drawMat = mesh.material;
  mesh.material = HIDDEN;
  holders.push(mesh);
  if (root) roots.add(root);
  return mesh;
}

/** Change what a batched mesh looks like (e.g. a ragdoll turning into a zombie). */
export function setDrawMaterial(mesh, mat) {
  if (mesh.userData.drawMat) mesh.userData.drawMat = mat; else mesh.material = mat;
}

/** The material a mesh is drawn with (batched or not). */
export const drawMaterial = (mesh) => mesh.userData.drawMat || mesh.material;

function kindFor(geo, mat, castShadow, receiveShadow) {
  let byGeo = kinds.get(mat);
  if (!byGeo) { byGeo = new Map(); kinds.set(mat, byGeo); }
  let k = byGeo.get(geo);
  if (!k) {
    k = { geo, mat, mesh: null, cap: 0, n: 0, fx: !!mat.userData.instanceFx, castShadow, receiveShadow };
    byGeo.set(geo, k);
  }
  return k;
}

function grow(k, need) {
  let cap = Math.max(16, k.cap);
  while (cap < need) cap *= 2;
  if (k.mesh) { k.mesh.parent?.remove(k.mesh); if (k.fx) k.mesh.geometry.dispose(); k.mesh.dispose(); }
  const m = new THREE.InstancedMesh(k.geo, k.mat, cap);
  m.frustumCulled = false;                 // the instances move every frame
  m.castShadow = k.castShadow; m.receiveShadow = k.receiveShadow;
  m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  if (k.fx) {
    m.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3).setUsage(THREE.DynamicDrawUsage);
    k.fxAttr = new THREE.InstancedBufferAttribute(new Float32Array(cap * 2), 2).setUsage(THREE.DynamicDrawUsage);
    // the attribute lives on a copy of the geometry so kinds sharing a geometry don't clash
    m.geometry = k.geo.clone();
    m.geometry.setAttribute('instFx', k.fxAttr);
  }
  m.count = 0;
  scene.add(m);
  k.mesh = m; k.cap = cap;
}

/** Is the holder (and everything above it) visible, and still in the scene? */
function shown(o) {
  for (; o; o = o.parent) {
    if (!o.visible) return false;
    if (o === scene) return true;
  }
  return false;
}
function attached(o) {
  for (; o; o = o.parent) if (o === scene) return true;
  return false;
}

// Level of detail: a holder further than this from the camera is drawn with its geometry's simpler
// version (geometry.userData.lod) if it has one: about a fifth of the triangles for a whole ragdoll.
let lodDist2 = 15 * 15;
export function setLodDistance(d) { lodDist2 = d * d; }

// The instanced meshes can't be frustum culled as a whole (their instances are all over the map),
// so each holder is tested against the view instead, with a margin so bodies just out of view still
// cast their shadows into it.
const CULL_MARGIN = 3;
const _frustum = new THREE.Frustum(), _pv = new THREE.Matrix4(), _sphere = new THREE.Sphere();

const drawn = [];   // this frame's shown holders and their kinds
/** Copy every holder into its instanced mesh. Call once per frame, right before rendering. */
export function updateBatches(theScene, camera) {
  scene = theScene;
  if (camera) {
    camera.updateMatrixWorld();
    _frustum.setFromProjectionMatrix(_pv.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
  }
  // zoomed in (aiming, a rifle scope) things look closer: push the switch out by the same factor
  const zoom = camera?.isPerspectiveCamera ? Math.max(1, Math.tan(0.6545) / Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2)) : 1;   // vs a 75° view
  const lod2 = lodDist2 * zoom * zoom;
  const cx = camera ? camera.matrixWorld.elements[12] : 0, cy = camera ? camera.matrixWorld.elements[13] : 0, cz = camera ? camera.matrixWorld.elements[14] : 0;
  for (const r of roots) { if (r.parent) r.updateMatrixWorld(); else roots.delete(r); }
  for (const byGeo of kinds.values()) for (const k of byGeo.values()) k.n = 0;
  // 1. which holders are drawn, and how many of each kind
  let w = 0;
  drawn.length = 0;
  for (let i = 0; i < holders.length; i++) {
    const h = holders[i];
    if (!attached(h)) { h.material = h.userData.drawMat; delete h.userData.drawMat; continue; }   // gone: forget it
    holders[w++] = h;
    if (!shown(h)) continue;
    let geo = h.geometry;
    if (camera) {
      if (!geo.boundingSphere) geo.computeBoundingSphere();
      _sphere.copy(geo.boundingSphere).applyMatrix4(h.matrixWorld);
      _sphere.radius += CULL_MARGIN;
      if (!_frustum.intersectsSphere(_sphere)) continue;
      if (geo.userData.lod) {
        const e = h.matrixWorld.elements, dx = e[12] - cx, dy = e[13] - cy, dz = e[14] - cz;
        if (dx * dx + dy * dy + dz * dz > lod2) geo = geo.userData.lod;
      }
    }
    const k = kindFor(geo, h.userData.drawMat, h.castShadow, h.receiveShadow);
    k.n++;
    drawn.push(h, k);
  }
  holders.length = w;
  // 2. room for them
  for (const byGeo of kinds.values()) for (const k of byGeo.values()) {
    if (k.n > k.cap) grow(k, k.n);
    if (k.mesh) k.mesh.count = k.n;
    k.i = 0;
  }
  // 3. copy
  for (let i = 0; i < drawn.length; i += 2) {
    const h = drawn[i], k = drawn[i + 1], j = k.i++;
    k.mesh.setMatrixAt(j, h.matrixWorld);
    if (k.fx) {
      const fx = h.userData.fx;
      k.mesh.instanceColor.setXYZ(j, fx ? fx.color.r : 1, fx ? fx.color.g : 1, fx ? fx.color.b : 1);
      k.fxAttr.setXY(j, fx ? fx.opacity : 1, fx ? fx.emissive : 0);
    }
  }
  for (const byGeo of kinds.values()) for (const k of byGeo.values()) {
    if (!k.n) continue;
    k.mesh.instanceMatrix.needsUpdate = true;
    if (k.fx) { k.mesh.instanceColor.needsUpdate = true; k.fxAttr.needsUpdate = true; }
  }
  drawn.length = 0;
}

/** Lets tests and the debug view see what the batcher draws. */
export function batchStats() {
  let draws = 0, instances = 0;
  for (const byGeo of kinds.values()) for (const k of byGeo.values()) if (k.mesh && k.mesh.count) { draws++; instances += k.mesh.count; }
  return { draws, instances, holders: holders.length };
}

/**
 * A material whose colour, opacity and emissive strength are set per instance (holder.userData.fx)
 * instead of per material, so every bruise or burn can share one material and one draw call.
 */
export function fxMaterial(params) {
  const m = new THREE.MeshStandardMaterial({ ...params, opacity: 1 });
  m.userData.instanceFx = true;
  m.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec2 instFx;\nvarying vec2 vInstFx;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvInstFx = instFx;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec2 vInstFx;')
      .replace('#include <alphamap_fragment>', '#include <alphamap_fragment>\ndiffuseColor.a *= vInstFx.x;')
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance *= vInstFx.y;');
  };
  m.customProgramCacheKey = () => 'instFx';
  return m;
}
