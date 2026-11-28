import * as THREE from 'three';
import { mergeGeometries } from '../world/build.js';

// Models of the VS Undead guns: an assault rifle, a submachine gun and a semi-automatic combat
// shotgun. Built from boxes and cylinders like the other guns; the barrel points along -Z and the
// origin is where the right hand holds the grip.
//
// Each returns { root, muzzle, gripPoint, supportPoint, mag, magHome, bolt, ejectPort, trigger }.

const M = {
  black: new THREE.MeshStandardMaterial({ color: 0x1d1f22, roughness: 0.55, metalness: 0.25 }),
  metal: new THREE.MeshStandardMaterial({ color: 0x2c2f33, roughness: 0.35, metalness: 0.8 }),
  dark: new THREE.MeshStandardMaterial({ color: 0x121315, roughness: 0.7, metalness: 0.2 }),
  tan: new THREE.MeshStandardMaterial({ color: 0x8a7656, roughness: 0.75, metalness: 0.05 }),
  od: new THREE.MeshStandardMaterial({ color: 0x4b5038, roughness: 0.75, metalness: 0.05 }),
  lens: new THREE.MeshStandardMaterial({ color: 0x2a3d4a, roughness: 0.05, metalness: 0.6, emissive: 0x220000 }),
  dot: new THREE.MeshBasicMaterial({ color: 0xff2a1a }),
  brass: new THREE.MeshStandardMaterial({ color: 0xc8a24a, roughness: 0.3, metalness: 0.9 }),
};
export const AUTO_MATERIALS = M;

const _q = new THREE.Quaternion(), _e = new THREE.Euler(), _s = new THREE.Vector3(1, 1, 1);
/** A part list: merged into one mesh per material. */
class Parts {
  constructor() { this.by = new Map(); }
  box(mat, x, y, z, w, h, d, rx = 0, ry = 0, rz = 0) {
    return this.geo(mat, new THREE.BoxGeometry(w, h, d), x, y, z, rx, ry, rz);
  }
  cyl(mat, x, y, z, r, len, rx = Math.PI / 2, seg = 12) {
    return this.geo(mat, new THREE.CylinderGeometry(r, r, len, seg), x, y, z, rx, 0, 0);
  }
  geo(mat, geo, x, y, z, rx = 0, ry = 0, rz = 0) {
    if (!this.by.has(mat)) this.by.set(mat, []);
    this.by.get(mat).push({ geo, matrix: new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), _q.setFromEuler(_e.set(rx, ry, rz)), _s) });
    return this;
  }
  build(parent) {
    for (const [mat, items] of this.by) {
      const m = new THREE.Mesh(mergeGeometries(items), mat);
      m.castShadow = true;
      parent.add(m);
    }
    return parent;
  }
}

const anchor = (parent, x, y, z) => { const o = new THREE.Object3D(); o.position.set(x, y, z); parent.add(o); return o; };

function finish(root, parts, mag, { muzzle, grip, support, eject, magPos, bolt }) {
  parts.build(root);
  const magHome = new THREE.Vector3(...magPos);
  mag.position.copy(magHome);
  root.add(mag);
  return {
    root, mag, magHome,
    muzzle: anchor(root, ...muzzle),
    gripPoint: anchor(root, ...grip),
    supportPoint: anchor(root, ...support),
    ejectPort: anchor(root, ...eject),
    bolt,
    magPoint: anchor(mag, 0, -0.06, 0),
  };
}

/** Assault rifle: flat-top receiver with a red dot, handguard, collapsible stock, curved 30-round mag. */
export function buildRifle() {
  const root = new THREE.Group(), P = new Parts();
  // receiver (upper + lower)
  P.box(M.black, 0, 0.045, -0.04, 0.05, 0.05, 0.26);
  P.box(M.black, 0, 0.012, -0.02, 0.046, 0.032, 0.2);
  P.box(M.metal, 0, 0.074, -0.06, 0.03, 0.012, 0.32);               // top rail
  for (let i = 0; i < 10; i++) P.box(M.dark, 0, 0.082, -0.2 + i * 0.03, 0.032, 0.006, 0.012);
  // handguard and barrel
  P.box(M.black, 0, 0.04, -0.28, 0.054, 0.056, 0.24);
  for (let i = 0; i < 5; i++) P.box(M.dark, 0.028, 0.04, -0.2 - i * 0.04, 0.004, 0.022, 0.02);
  P.cyl(M.metal, 0, 0.042, -0.47, 0.009, 0.16);
  P.cyl(M.dark, 0, 0.042, -0.56, 0.014, 0.05, Math.PI / 2, 8);       // flash hider
  P.box(M.black, 0, 0.075, -0.39, 0.012, 0.03, 0.012);               // front sight
  // red dot
  P.box(M.black, 0, 0.1, -0.08, 0.034, 0.036, 0.07);
  P.box(M.lens, 0, 0.1, -0.117, 0.026, 0.026, 0.004);
  P.box(M.dot, 0, 0.1, -0.06, 0.003, 0.003, 0.002);
  // pistol grip, trigger guard
  P.box(M.black, 0, -0.035, 0.03, 0.03, 0.085, 0.036, -0.32);
  P.box(M.black, 0, -0.012, -0.022, 0.008, 0.006, 0.06);
  // stock: buffer tube and the stock itself
  P.cyl(M.metal, 0, 0.035, 0.15, 0.014, 0.18);
  P.box(M.black, 0, 0.018, 0.24, 0.04, 0.085, 0.1);
  P.box(M.dark, 0, 0.012, 0.292, 0.042, 0.095, 0.012);
  P.box(M.metal, 0.027, 0.05, 0.02, 0.006, 0.014, 0.05);              // charging handle side
  // magazine: two boxes for the curve
  const mag = new THREE.Group(), MP = new Parts();
  MP.box(M.dark, 0, -0.03, 0, 0.022, 0.07, 0.06, 0.08);
  MP.box(M.dark, 0, -0.09, 0.008, 0.022, 0.06, 0.058, 0.22);
  MP.box(M.brass, 0, 0.007, 0.005, 0.01, 0.006, 0.04);
  MP.build(mag);
  const bolt = new THREE.Mesh(new THREE.BoxGeometry(0.01, 0.012, 0.04), M.metal);
  bolt.position.set(0.026, 0.05, -0.03);
  root.add(bolt);
  return finish(root, P, mag, { muzzle: [0, 0.042, -0.59], grip: [0, -0.03, 0.03], support: [0, 0.008, -0.27], eject: [0.03, 0.05, -0.04], magPos: [0, -0.005, -0.075], bolt });
}

/** Submachine gun: short boxy receiver, barrel shroud, folding wire stock, straight 30-round mag. */
export function buildSMG() {
  const root = new THREE.Group(), P = new Parts();
  P.box(M.black, 0, 0.04, -0.06, 0.044, 0.058, 0.24);
  P.box(M.metal, 0, 0.073, -0.08, 0.026, 0.01, 0.16);
  P.box(M.black, 0, 0.088, -0.02, 0.012, 0.02, 0.014);               // rear sight
  P.box(M.black, 0, 0.088, -0.17, 0.01, 0.02, 0.012);                // front sight
  P.cyl(M.dark, 0, 0.04, -0.22, 0.016, 0.1);                         // shroud
  P.cyl(M.metal, 0, 0.04, -0.29, 0.008, 0.06);
  P.box(M.black, 0, 0.0, -0.13, 0.034, 0.036, 0.05);                 // fore grip block
  P.box(M.black, 0, -0.035, 0.03, 0.03, 0.08, 0.034, -0.25);
  P.box(M.black, 0, -0.008, -0.01, 0.008, 0.006, 0.05);
  // folding stock (wire)
  P.box(M.metal, 0.018, 0.03, 0.13, 0.006, 0.01, 0.2);
  P.box(M.metal, -0.018, 0.03, 0.13, 0.006, 0.01, 0.2);
  P.box(M.metal, 0, 0.015, 0.23, 0.042, 0.07, 0.01);
  const mag = new THREE.Group(), MP = new Parts();
  MP.box(M.dark, 0, -0.06, 0, 0.022, 0.13, 0.03);
  MP.box(M.brass, 0, 0.008, 0, 0.01, 0.006, 0.022);
  MP.build(mag);
  const bolt = new THREE.Mesh(new THREE.BoxGeometry(0.009, 0.01, 0.03), M.metal);
  bolt.position.set(0.024, 0.055, -0.07);
  root.add(bolt);
  return finish(root, P, mag, { muzzle: [0, 0.04, -0.32], grip: [0, -0.03, 0.03], support: [0, -0.01, -0.13], eject: [0.026, 0.05, -0.06], magPos: [0, 0.0, -0.075], bolt });
}

/** Semi-automatic combat shotgun: big receiver, long barrel over a tube, box magazine, tan furniture. */
export function buildCombatShotgun() {
  const root = new THREE.Group(), P = new Parts();
  P.box(M.black, 0, 0.045, -0.06, 0.056, 0.07, 0.3);
  P.box(M.metal, 0, 0.083, -0.08, 0.03, 0.01, 0.26);
  P.box(M.od, 0, 0.03, -0.33, 0.06, 0.06, 0.24);                     // handguard
  P.cyl(M.metal, 0, 0.055, -0.52, 0.013, 0.32);
  P.cyl(M.dark, 0, 0.018, -0.42, 0.012, 0.18);                       // gas tube
  P.cyl(M.dark, 0, 0.055, -0.68, 0.017, 0.04, Math.PI / 2, 10);
  P.box(M.black, 0, 0.098, -0.02, 0.014, 0.024, 0.02);               // ghost ring sight
  P.box(M.black, 0, 0.078, -0.62, 0.008, 0.024, 0.01);
  P.box(M.od, 0, -0.035, 0.035, 0.032, 0.09, 0.038, -0.3);
  P.box(M.black, 0, -0.012, -0.02, 0.008, 0.006, 0.06);
  P.box(M.od, 0, 0.025, 0.2, 0.048, 0.09, 0.24, 0.06);              // stock
  P.box(M.dark, 0, 0.015, 0.323, 0.05, 0.1, 0.014);
  const mag = new THREE.Group(), MP = new Parts();
  MP.box(M.dark, 0, -0.045, 0, 0.034, 0.09, 0.07, 0.05);
  MP.box(M.tan, 0, 0.004, 0.0, 0.02, 0.008, 0.05);
  MP.build(mag);
  const bolt = new THREE.Mesh(new THREE.BoxGeometry(0.012, 0.014, 0.05), M.metal);
  bolt.position.set(0.032, 0.05, -0.05);
  root.add(bolt);
  return finish(root, P, mag, { muzzle: [0, 0.055, -0.71], grip: [0, -0.03, 0.035], support: [0, 0.0, -0.33], eject: [0.034, 0.055, -0.06], magPos: [0, 0.0, -0.1], bolt });
}

/** A 5.56 / 9 mm brass case (smaller than the .45's). */
export function buildSmallCasing(len = 0.04, r = 0.0048) {
  const g = new THREE.CylinderGeometry(r, r * 1.05, len, 8).rotateX(Math.PI / 2);
  const m = new THREE.Mesh(g, M.brass);
  m.castShadow = true;
  return m;
}
