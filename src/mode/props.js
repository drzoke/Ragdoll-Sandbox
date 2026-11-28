import * as THREE from 'three';
import { mergeGeometries } from '../world/build.js';
import { canvasTexture } from '../core/util.js';

// Models for VS Undead: the traveling merchant with his handcart, and the supply crate that
// comes down on a parachute.

const M = {
  robe: new THREE.MeshStandardMaterial({ color: 0x3d2f45, roughness: 0.95 }),
  robeDark: new THREE.MeshStandardMaterial({ color: 0x241b2a, roughness: 0.95 }),
  skin: new THREE.MeshStandardMaterial({ color: 0x9c7a62, roughness: 0.8 }),
  leather: new THREE.MeshStandardMaterial({ color: 0x5a3b24, roughness: 0.85 }),
  wood: new THREE.MeshStandardMaterial({ color: 0x6b4a2d, roughness: 0.9 }),
  woodDark: new THREE.MeshStandardMaterial({ color: 0x3e2a1a, roughness: 0.9 }),
  iron: new THREE.MeshStandardMaterial({ color: 0x2a2b2e, roughness: 0.5, metalness: 0.7 }),
  cloth: new THREE.MeshStandardMaterial({ color: 0x8c7a58, roughness: 1 }),
  gold: new THREE.MeshStandardMaterial({ color: 0xd8a83a, roughness: 0.35, metalness: 0.8 }),
  glow: new THREE.MeshStandardMaterial({ color: 0xffd090, emissive: 0xffa040, emissiveIntensity: 2.6 }),
  eyes: new THREE.MeshBasicMaterial({ color: 0xffd27a }),
  crate: new THREE.MeshStandardMaterial({ color: 0x55603f, roughness: 0.8 }),
  crateDark: new THREE.MeshStandardMaterial({ color: 0x2f3524, roughness: 0.8 }),
  chute: new THREE.MeshStandardMaterial({ color: 0xd9dccf, roughness: 1, side: THREE.DoubleSide }),
  rope: new THREE.MeshBasicMaterial({ color: 0x888877 }),
  flare: new THREE.MeshStandardMaterial({ color: 0xff3020, emissive: 0xff2010, emissiveIntensity: 3 }),
};
export const PROP_MATERIALS = M;

const P = (geo, x, y, z, rx = 0, ry = 0, rz = 0, sx = 1, sy = 1, sz = 1) => ({ geo, matrix: new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz)), new THREE.Vector3(sx, sy, sz)) });
function merged(parent, byMat) {
  for (const [mat, items] of byMat) {
    if (!items.length) continue;
    const m = new THREE.Mesh(mergeGeometries(items), mat);
    m.castShadow = true; m.receiveShadow = true;
    parent.add(m);
  }
  return parent;
}
const box = (w, h, d) => new THREE.BoxGeometry(w, h, d);
const cyl = (r0, r1, h, s = 10) => new THREE.CylinderGeometry(r0, r1, h, s);

/**
 * The merchant: a stooped figure in a long hooded robe with a huge pack, glowing eyes under the
 * hood and a lantern on a crook. Faces -Z. Returns { root, body, lantern, light }.
 */
export function buildMerchant() {
  const root = new THREE.Group();
  const body = new THREE.Group(); root.add(body);
  merged(body, [
    [M.robe, [P(cyl(0.2, 0.42, 1.25, 12), 0, 0.62, 0), P(cyl(0.17, 0.22, 0.4, 10), 0, 1.38, 0.03, 0.15), P(new THREE.SphereGeometry(0.2, 12, 8, 0, Math.PI * 2, 0, Math.PI * 0.62), 0, 1.6, 0.06, -0.35),
      P(cyl(0.06, 0.08, 0.6, 8), 0.27, 1.2, -0.12, 0.9, 0, 0.25), P(cyl(0.06, 0.08, 0.55, 8), -0.26, 1.18, -0.1, 0.7, 0, -0.2)]],
    [M.robeDark, [P(cyl(0.43, 0.44, 0.06, 12), 0, 0.03, 0), P(cyl(0.14, 0.14, 0.02, 10), 0, 1.53, -0.12, Math.PI / 2 - 0.3)]],
    [M.skin, [P(new THREE.SphereGeometry(0.05, 8, 6), 0.33, 0.98, -0.36), P(new THREE.SphereGeometry(0.05, 8, 6), -0.3, 0.98, -0.32)]],
    // the pack: a tall bundle with pots, a rolled blanket and a lamp hanging off it
    [M.leather, [P(box(0.52, 0.72, 0.34), 0, 1.25, 0.36, 0.1), P(box(0.56, 0.06, 0.06), 0, 1.45, 0.16, 0.1), P(box(0.06, 0.6, 0.04), 0.2, 1.3, 0.18), P(box(0.06, 0.6, 0.04), -0.2, 1.3, 0.18)]],
    [M.cloth, [P(cyl(0.12, 0.12, 0.62, 10), 0, 1.68, 0.4, 0, 0, Math.PI / 2), P(box(0.4, 0.3, 0.26), 0.02, 0.86, 0.42)]],
    [M.iron, [P(cyl(0.09, 0.07, 0.12, 10), 0.3, 1.0, 0.5), P(cyl(0.07, 0.07, 0.1, 10), -0.3, 1.2, 0.5)]],
    [M.gold, [P(new THREE.TorusGeometry(0.035, 0.008, 4, 10), 0.1, 1.05, -0.24, 0.3), P(new THREE.TorusGeometry(0.035, 0.008, 4, 10), -0.06, 1.02, -0.24, 0.3)]],
  ]);
  const eyes = new THREE.Mesh(mergeGeometries([P(new THREE.SphereGeometry(0.014, 6, 4), 0.045, 1.56, -0.12), P(new THREE.SphereGeometry(0.014, 6, 4), -0.045, 1.56, -0.12)]), M.eyes);
  body.add(eyes);
  // the crook with the lantern, in his right hand
  const crook = new THREE.Group(); crook.position.set(0.34, 0, -0.38); body.add(crook);
  merged(crook, [[M.woodDark, [P(cyl(0.022, 0.026, 2.1, 6), 0, 1.05, 0), P(new THREE.TorusGeometry(0.12, 0.022, 5, 10, Math.PI), -0.12, 2.1, 0)]]]);
  const lantern = new THREE.Group(); lantern.position.set(-0.24, 2.06, 0); crook.add(lantern);
  merged(lantern, [[M.iron, [P(box(0.14, 0.02, 0.14), 0, -0.1, 0), P(box(0.14, 0.02, 0.14), 0, -0.32, 0), P(cyl(0.004, 0.004, 0.1, 4), 0, -0.05, 0)]], [M.glow, [P(box(0.1, 0.2, 0.1), 0, -0.21, 0)]]]);
  const light = new THREE.PointLight(0xffa850, 0, 11, 1.5);
  light.position.set(0, -0.2, 0);
  lantern.add(light);
  return { root, body, lantern, light, crook };
}

/** A two-wheeled handcart piled with crates, sacks and a weapon rack. Faces -Z (the handles at +Z). */
export function buildCart() {
  const root = new THREE.Group();
  const wheel = () => {
    const g = new THREE.Group();
    merged(g, [[M.woodDark, [P(new THREE.TorusGeometry(0.42, 0.045, 6, 16), 0, 0, 0, 0, Math.PI / 2), ...Array.from({ length: 6 }, (_, i) => P(box(0.03, 0.8, 0.04), 0, 0, 0, (i / 6) * Math.PI, 0, 0))]], [M.iron, [P(cyl(0.06, 0.06, 0.12, 8), 0, 0, 0, 0, 0, Math.PI / 2)]]]);
    return g;
  };
  const wl = wheel(); wl.position.set(-0.78, 0.44, 0); root.add(wl);
  const wr = wheel(); wr.position.set(0.78, 0.44, 0); root.add(wr);
  merged(root, [
    [M.wood, [P(box(1.4, 0.06, 1.9), 0, 0.62, 0), P(box(1.4, 0.32, 0.05), 0, 0.8, -0.93), P(box(0.05, 0.32, 1.9), 0.68, 0.8, 0), P(box(0.05, 0.32, 1.9), -0.68, 0.8, 0),
      P(box(0.07, 0.07, 1.4), 0.5, 0.58, 1.5, 0.12), P(box(0.07, 0.07, 1.4), -0.5, 0.58, 1.5, 0.12), P(box(1.1, 0.05, 0.05), 0, 0.5, 2.15)]],
    [M.woodDark, [P(box(0.06, 0.6, 0.06), 0.5, 0.3, 1.0), P(box(0.06, 0.6, 0.06), -0.5, 0.3, 1.0), P(cyl(0.035, 0.035, 1.7, 6), 0, 0.44, 0, 0, 0, Math.PI / 2)]],
    // cargo
    [M.crate, [P(box(0.6, 0.45, 0.5), -0.3, 0.88, -0.5), P(box(0.5, 0.38, 0.45), 0.32, 0.85, -0.55, 0, 0.2), P(box(0.45, 0.35, 0.4), 0.05, 1.28, -0.5, 0, -0.15)]],
    [M.cloth, [P(new THREE.SphereGeometry(0.26, 10, 8), 0.35, 0.86, 0.35, 0, 0, 0, 1, 0.8, 1.2), P(new THREE.SphereGeometry(0.22, 10, 8), -0.32, 0.84, 0.45, 0, 0, 0, 1.1, 0.8, 1)]],
    [M.iron, [P(box(0.04, 0.9, 0.04), 0.62, 1.1, 0.1), P(box(0.04, 0.9, 0.04), 0.62, 1.1, 0.7), P(box(0.04, 0.04, 0.64), 0.62, 1.5, 0.4)]],
    [M.leather, [P(box(0.05, 0.75, 0.08), 0.6, 1.05, 0.25, 0, 0, 0.12), P(box(0.05, 0.7, 0.08), 0.6, 1.05, 0.52, 0, 0, 0.08)]],
  ]);
  // a lantern on a post at the front
  merged(root, [[M.woodDark, [P(box(0.05, 1.2, 0.05), -0.62, 1.2, -0.88)]], [M.iron, [P(box(0.14, 0.02, 0.14), -0.62, 1.8, -0.88)]], [M.glow, [P(box(0.1, 0.16, 0.1), -0.62, 1.7, -0.88)]]]);
  const light = new THREE.PointLight(0xffa04a, 0, 14, 1.4);
  light.position.set(-0.62, 1.7, -0.88);
  root.add(light);
  return { root, wheels: [wl, wr], light };
}

function stencil() {
  return canvasTexture(256, 128, (g, w, h) => {
    g.fillStyle = '#55603f'; g.fillRect(0, 0, w, h);
    g.strokeStyle = 'rgba(0,0,0,.35)'; g.lineWidth = 6; g.strokeRect(6, 6, w - 12, h - 12);
    g.fillStyle = 'rgba(235,230,200,.85)'; g.font = 'bold 40px sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText('SUPPLY', w / 2, h / 2 - 4);
    g.font = 'bold 18px sans-serif'; g.fillText('▲ THIS SIDE UP ▲', w / 2, h - 24);
  });
}
let stencilTex = null;

/** The supply crate with its parachute (on a separate group so it can fold away) and a red flare. */
export function buildCrate() {
  const root = new THREE.Group();
  stencilTex ||= stencil();
  const side = new THREE.MeshStandardMaterial({ map: stencilTex, roughness: 0.8 });
  const body = new THREE.Mesh(box(0.9, 0.62, 0.62), [M.crate, M.crate, M.crate, M.crate, side, side]);
  body.position.y = 0.31; body.castShadow = true; body.receiveShadow = true;
  root.add(body);
  const lid = new THREE.Group(); lid.position.set(0, 0.62, -0.31); root.add(lid);
  merged(lid, [[M.crateDark, [P(box(0.94, 0.06, 0.66), 0, 0.03, 0.31)]]]);
  merged(root, [[M.crateDark, [P(box(0.94, 0.05, 0.05), 0, 0.05, 0.3), P(box(0.94, 0.05, 0.05), 0, 0.05, -0.3), P(box(0.05, 0.6, 0.05), 0.44, 0.3, 0.3), P(box(0.05, 0.6, 0.05), -0.44, 0.3, 0.3), P(box(0.05, 0.6, 0.05), 0.44, 0.3, -0.3), P(box(0.05, 0.6, 0.05), -0.44, 0.3, -0.3)]]]);
  const flare = new THREE.Mesh(cyl(0.025, 0.025, 0.16, 6), M.flare);
  flare.position.set(0.38, 0.7, 0.22); root.add(flare);
  const chute = new THREE.Group(); root.add(chute);
  const canopy = new THREE.Mesh(new THREE.SphereGeometry(2.2, 14, 6, 0, Math.PI * 2, 0, Math.PI * 0.42), M.chute);
  canopy.position.y = 3.2; canopy.scale.y = 0.55; chute.add(canopy);
  const ropes = [];
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2, top = new THREE.Vector3(Math.cos(a) * 1.65, 3.25, Math.sin(a) * 1.65), bot = new THREE.Vector3(Math.sign(Math.cos(a)) * 0.4, 0.62, Math.sign(Math.sin(a)) * 0.28);
    const len = top.distanceTo(bot);
    const g = new THREE.CylinderGeometry(0.006, 0.006, len, 3).translate(0, len / 2, 0);
    ropes.push({ geo: g, matrix: new THREE.Matrix4().compose(bot, new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), top.clone().sub(bot).normalize()), new THREE.Vector3(1, 1, 1)) });
  }
  chute.add(new THREE.Mesh(mergeGeometries(ropes), M.rope));
  return { root, body, lid, chute, flare };
}
