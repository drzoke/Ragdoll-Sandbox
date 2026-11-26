import * as THREE from 'three';

export const clamp = (v, a = 0, b = 1) => (v < a ? a : v > b ? b : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const smooth = (t) => t * t * (3 - 2 * t);
export const rand = (a = 0, b = 1) => a + Math.random() * (b - a);
export const randSign = () => (Math.random() < 0.5 ? -1 : 1);
/** Frame-rate independent exponential approach factor. */
export const damp = (rate, dt) => 1 - Math.exp(-rate * dt);

/** Critically-damped-ish spring for scalar values (used for recoil, bob, etc). */
export class Spring {
  constructor(stiffness = 120, damping = 14) { this.k = stiffness; this.c = damping; this.x = 0; this.v = 0; this.target = 0; }
  update(dt) {
    const a = (this.target - this.x) * this.k - this.v * this.c;
    this.v += a * dt;
    this.x += this.v * dt;
    return this.x;
  }
  kick(v) { this.v += v; }
}

/** Cheap 1D value noise for organic motion. */
export function noise1(x, seed = 0) {
  const i = Math.floor(x), f = x - i;
  const h = (n) => { const s = Math.sin((n + seed * 57.13) * 127.1) * 43758.5453; return s - Math.floor(s); };
  const u = f * f * (3 - 2 * f);
  return lerp(h(i), h(i + 1), u) * 2 - 1;
}

const _e = new THREE.Euler();
export function quatFromEuler(x, y, z, order = 'XYZ', out = new THREE.Quaternion()) {
  _e.set(x, y, z, order);
  return out.setFromEuler(_e);
}

/** Ray vs. axis-aligned ellipsoid centred at c with radii r (all local space). Returns [tIn, tOut] or null. */
export function rayEllipsoid(o, d, c, r) {
  const ox = (o.x - c[0]) / r[0], oy = (o.y - c[1]) / r[1], oz = (o.z - c[2]) / r[2];
  const dx = d.x / r[0], dy = d.y / r[1], dz = d.z / r[2];
  const a = dx * dx + dy * dy + dz * dz;
  const b = 2 * (ox * dx + oy * dy + oz * dz);
  const cc = ox * ox + oy * oy + oz * oz - 1;
  const disc = b * b - 4 * a * cc;
  if (disc < 0) return null;
  const s = Math.sqrt(disc);
  return [(-b - s) / (2 * a), (-b + s) / (2 * a)];
}

/** Minimum distance between a ray segment [o + d*t0, o + d*t1] and a segment p-q. */
export function segSegDistance(o, d, t0, t1, p, q) {
  const A0 = o.clone().addScaledVector(d, t0), A1 = o.clone().addScaledVector(d, t1);
  const B0 = new THREE.Vector3(...p), B1 = new THREE.Vector3(...q);
  const u = A1.clone().sub(A0), v = B1.clone().sub(B0), w = A0.clone().sub(B0);
  const a = u.dot(u), b = u.dot(v), c = v.dot(v), dd = u.dot(w), e = v.dot(w);
  const D = a * c - b * b;
  let sc, tc;
  if (D < 1e-8) { sc = 0; tc = b > c ? dd / b : e / c; } else { sc = (b * e - c * dd) / D; tc = (a * e - b * dd) / D; }
  sc = clamp(sc); tc = clamp(tc);
  const P = A0.clone().addScaledVector(u, sc), Q = B0.clone().addScaledVector(v, tc);
  return { dist: P.distanceTo(Q), t: t0 + (t1 - t0) * sc };
}

export function canvasTexture(w, h, draw, { repeat = false, srgb = true } = {}) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 8;
  return t;
}

/**
 * Viewmodels are drawn by their own camera (different FOV) on top of the world. This maps a point
 * from viewmodel space to the world position that appears at the same spot on screen.
 */
const _ndc = new THREE.Vector3(), _cp = new THREE.Vector3(), _fw = new THREE.Vector3();
export function viewmodelToWorld(local, vmCamera, mainCamera, out = new THREE.Vector3()) {
  const depth = -local.z;
  _ndc.copy(local).project(vmCamera);
  mainCamera.getWorldPosition(_cp);
  mainCamera.getWorldDirection(_fw);
  out.set(_ndc.x, _ndc.y, 0.5).unproject(mainCamera).sub(_cp).normalize();
  const t = depth / Math.max(0.05, out.dot(_fw));
  return out.multiplyScalar(t).add(_cp);
}
