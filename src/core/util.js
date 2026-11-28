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
    // small steps: one big step at a low frame rate makes a stiff spring blow up
    for (let left = dt; left > 1e-6;) {
      const h = Math.min(left, 1 / 120);
      const a = (this.target - this.x) * this.k - this.v * this.c;
      this.v += a * h;
      this.x += this.v * h;
      left -= h;
    }
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

/**
 * Viewmodel offset for drawing / holstering a tool. raise: 0 = holstered, 1 = ready.
 * Drawing follows: grab (low, tilted down) → pull up → pull up a little past the rest pose →
 * settle down → rest. Holstering just drops the tool out of view.
 */
const DRAW_KEYS = [
  // t,    x,      y,      z,     rx,    rz
  [0.00, 0.03, -0.30, 0.06, -1.00, 0.35],
  [0.30, 0.012, -0.075, 0.02, -0.30, 0.12],   // grab + pull up
  [0.56, 0.0, 0.018, -0.006, 0.10, -0.03],    // pulled up a bit too far
  [0.80, 0.0, -0.006, 0.002, -0.03, 0.01],    // settle down
  [1.00, 0, 0, 0, 0, 0],                       // rest
];
const _draw = { x: 0, y: 0, z: 0, rx: 0, rz: 0 };
export function drawOffset(raise, drawing) {
  const t = Math.max(0, Math.min(1, raise));
  if (!drawing) {
    const k = 1 - t, e = k * k * (3 - 2 * k);
    _draw.x = 0.02 * e; _draw.y = -0.28 * e; _draw.z = 0.04 * e; _draw.rx = -0.9 * e; _draw.rz = 0.2 * e;
    return _draw;
  }
  let i = 0;
  while (i < DRAW_KEYS.length - 2 && t > DRAW_KEYS[i + 1][0]) i++;
  const a = DRAW_KEYS[i], b = DRAW_KEYS[i + 1];
  let u = (t - a[0]) / (b[0] - a[0]);
  u = u * u * (3 - 2 * u);
  _draw.x = a[1] + (b[1] - a[1]) * u; _draw.y = a[2] + (b[2] - a[2]) * u; _draw.z = a[3] + (b[3] - a[3]) * u;
  _draw.rx = a[4] + (b[4] - a[4]) * u; _draw.rz = a[5] + (b[5] - a[5]) * u;
  return _draw;
}
