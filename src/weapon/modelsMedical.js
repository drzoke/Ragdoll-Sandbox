import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { canvasTexture } from '../core/util.js';

// Procedural models for the machete, the medkit and the defibrillator (real-world scale, metres).

/** Blood on a blade: smeared streaks, white = blood (used as an alpha map). */
function bladeBloodTexture() {
  return canvasTexture(64, 256, (g, w, h) => {
    g.fillStyle = '#000'; g.fillRect(0, 0, w, h);
    g.fillStyle = '#fff';
    for (let i = 0; i < 26; i++) {
      const x = Math.random() * w, y = h * (0.2 + Math.random() * 0.8), len = 10 + Math.random() * 50;
      g.globalAlpha = 0.35 + Math.random() * 0.6;
      g.beginPath(); g.ellipse(x, y, 2 + Math.random() * 7, len / 2, (Math.random() - 0.5) * 0.4, 0, Math.PI * 2); g.fill();
    }
    g.globalAlpha = 0.8;
    for (let i = 0; i < 40; i++) { g.beginPath(); g.arc(Math.random() * w, h * (0.3 + Math.random() * 0.7), 1 + Math.random() * 3, 0, Math.PI * 2); g.fill(); }
  }, { srgb: false });
}

/**
 * Machete: black rubber grip, small guard, a 40 cm blade that widens towards the tip.
 * Origin = middle of the grip; the blade points up +Y, the cutting edge faces +X.
 */
export function buildMachete() {
  const steel = new THREE.MeshStandardMaterial({ color: 0xaeb3b8, roughness: 0.32, metalness: 0.9 });
  const edgeMat = new THREE.MeshStandardMaterial({ color: 0xe3e7ea, roughness: 0.18, metalness: 1, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x3a3e43, roughness: 0.5, metalness: 0.7 });
  const rubber = new THREE.MeshStandardMaterial({ color: 0x1b1c1f, roughness: 0.85, metalness: 0 });
  const root = new THREE.Group(); root.name = 'Machete';

  // grip with finger ridges
  const grip = new THREE.Mesh(new RoundedBoxGeometry(0.03, 0.125, 0.024, 3, 0.009), rubber);
  root.add(grip);
  for (let i = 0; i < 4; i++) {
    const ridge = new THREE.Mesh(new THREE.BoxGeometry(0.004, 0.006, 0.026), rubber);
    ridge.position.set(0.016, -0.045 + i * 0.027, 0); root.add(ridge);
  }
  const pommel = new THREE.Mesh(new RoundedBoxGeometry(0.036, 0.016, 0.028, 2, 0.006), rubber);
  pommel.position.y = -0.068; root.add(pommel);
  const guard = new THREE.Mesh(new RoundedBoxGeometry(0.048, 0.009, 0.03, 2, 0.003), dark);
  guard.position.y = 0.066; root.add(guard);
  for (const y of [-0.035, 0.035]) {   // rivets through the tang
    const rv = new THREE.Mesh(new THREE.CylinderGeometry(0.0035, 0.0035, 0.026, 10).rotateX(Math.PI / 2), dark);
    rv.position.y = y; root.add(rv);
  }

  // blade outline (x = width, edge on +x; y = along the blade), extruded thin
  const L = 0.41;
  const sh = new THREE.Shape();
  sh.moveTo(-0.014, 0);
  sh.lineTo(0.02, 0);
  sh.quadraticCurveTo(0.03, L * 0.55, 0.034, L * 0.82);       // belly widens towards the tip
  sh.quadraticCurveTo(0.034, L * 0.98, 0.0, L);                // rounded point
  sh.quadraticCurveTo(-0.012, L * 0.95, -0.016, L * 0.8);       // clipped spine
  sh.lineTo(-0.014, 0);
  const geo = new THREE.ExtrudeGeometry(sh, { depth: 0.0035, bevelEnabled: true, bevelThickness: 0.0012, bevelSize: 0.0016, bevelSegments: 2, curveSegments: 18 });
  geo.translate(0, 0.07, -0.00175);
  const blade = new THREE.Mesh(geo, steel);
  root.add(blade);
  // bright sharpened edge and a darker spine strip
  const edgeShape = new THREE.Shape();
  edgeShape.moveTo(0.012, 0.004);
  edgeShape.lineTo(0.02, 0.004);
  edgeShape.quadraticCurveTo(0.03, L * 0.55, 0.0345, L * 0.82);
  edgeShape.quadraticCurveTo(0.0345, L * 0.97, 0.006, L - 0.004);
  edgeShape.quadraticCurveTo(0.025, L * 0.9, 0.025, L * 0.8);
  edgeShape.quadraticCurveTo(0.021, L * 0.5, 0.012, 0.004);
  for (const z of [0.0031, -0.0031]) {
    const e = new THREE.Mesh(new THREE.ShapeGeometry(edgeShape, 16), edgeMat);
    e.position.set(0, 0.07, z);
    root.add(e);
  }
  // blood that builds up on the blade
  const bloodMat = new THREE.MeshStandardMaterial({ color: 0x5a0606, roughness: 0.25, metalness: 0.1, transparent: true, opacity: 0, alphaMap: bladeBloodTexture(), depthWrite: false });
  const blood = new THREE.Mesh(geo, bloodMat);
  blood.scale.set(1.01, 1, 1.25);
  root.add(blood);
  const tip = new THREE.Object3D(); tip.position.set(0.015, 0.07 + L * 0.85, 0); root.add(tip);
  return { root, blade, bloodMat, tip, steel };
}

/**
 * Medkit: a red zipped pouch with a white cross (left hand), a bandage roll, an autoinjector and a
 * blood bag (right hand, one at a time).
 */
export function buildMedkit() {
  const red = new THREE.MeshStandardMaterial({ color: 0xb52020, roughness: 0.8 });
  const redDark = new THREE.MeshStandardMaterial({ color: 0x7c1414, roughness: 0.85 });
  const white = new THREE.MeshStandardMaterial({ color: 0xf2f2ee, roughness: 0.7 });
  const zip = new THREE.MeshStandardMaterial({ color: 0x1c1c1e, roughness: 0.6, metalness: 0.4 });
  const root = new THREE.Group(); root.name = 'Medkit';

  const pouch = new THREE.Group();
  const body = new THREE.Mesh(new RoundedBoxGeometry(0.17, 0.115, 0.065, 3, 0.02), red);
  pouch.add(body);
  const seam = new THREE.Mesh(new RoundedBoxGeometry(0.172, 0.006, 0.067, 2, 0.003), zip);
  seam.position.y = 0.03; pouch.add(seam);
  const pull = new THREE.Mesh(new THREE.BoxGeometry(0.008, 0.02, 0.004), zip);
  pull.position.set(0.07, 0.022, 0.034); pouch.add(pull);
  for (const [w, h] of [[0.05, 0.016], [0.016, 0.05]]) {
    const bar = new THREE.Mesh(new THREE.BoxGeometry(w, h, 0.002), white);
    bar.position.set(0, -0.008, 0.0335); pouch.add(bar);
  }
  const handle = new THREE.Mesh(new THREE.TorusGeometry(0.022, 0.005, 6, 16, Math.PI), redDark);
  handle.position.y = 0.058; pouch.add(handle);
  root.add(pouch);

  // bandage roll
  const bandageMat = new THREE.MeshStandardMaterial({ color: 0xece6d8, roughness: 0.95 });
  const roll = new THREE.Group();
  const cyl = new THREE.Mesh(new THREE.CylinderGeometry(0.026, 0.026, 0.065, 20), bandageMat);
  cyl.rotation.z = Math.PI / 2; roll.add(cyl);
  const tail = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.002, 0.05), bandageMat);
  tail.position.set(0, -0.026, 0.03); tail.rotation.x = 0.5; roll.add(tail);

  // autoinjector (yellow body, green cap)
  const injector = new THREE.Group();
  const pen = new THREE.Mesh(new THREE.CylinderGeometry(0.009, 0.009, 0.13, 14), new THREE.MeshStandardMaterial({ color: 0xd8b52a, roughness: 0.5 }));
  const capM = new THREE.Mesh(new THREE.CylinderGeometry(0.0095, 0.0095, 0.03, 14), new THREE.MeshStandardMaterial({ color: 0x2f8a3a, roughness: 0.5 }));
  capM.position.y = 0.075;
  const tipM = new THREE.Mesh(new THREE.CylinderGeometry(0.006, 0.0085, 0.012, 12), new THREE.MeshStandardMaterial({ color: 0xe36a1d, roughness: 0.5 }));
  tipM.position.y = -0.07;
  injector.add(pen, capM, tipM);

  // blood bag
  const bag = new THREE.Group();
  const bagMat = new THREE.MeshStandardMaterial({ color: 0x8c0d12, roughness: 0.25, metalness: 0.05, transparent: true, opacity: 0.92 });
  const sack = new THREE.Mesh(new RoundedBoxGeometry(0.09, 0.13, 0.025, 3, 0.012), bagMat);
  const label = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.04, 0.001), white);
  label.position.set(0, 0.015, 0.0131);
  const port = new THREE.Mesh(new THREE.CylinderGeometry(0.004, 0.004, 0.03, 8), new THREE.MeshStandardMaterial({ color: 0xdedede, roughness: 0.4 }));
  port.position.y = -0.078;
  bag.add(sack, label, port);

  return { root, pouch, roll, injector, bag };
}

/**
 * Defibrillator paddles: grey handle, flat metal electrode, a coiled cable. One per hand.
 * Origin = handle grip; the electrode faces -Z (forward).
 */
export function buildPaddle(side = 1) {
  const shell = new THREE.MeshStandardMaterial({ color: 0x2f3338, roughness: 0.55 });
  const grey = new THREE.MeshStandardMaterial({ color: 0x8b9096, roughness: 0.6 });
  const metal = new THREE.MeshStandardMaterial({ color: 0xc9ccd0, roughness: 0.25, metalness: 0.95 });
  const orange = new THREE.MeshStandardMaterial({ color: side > 0 ? 0xe0702a : 0xe8c02a, roughness: 0.5, emissive: 0x000000 });
  const root = new THREE.Group(); root.name = 'Paddle';
  const handle = new THREE.Mesh(new RoundedBoxGeometry(0.032, 0.1, 0.035, 3, 0.012), grey);
  root.add(handle);
  const head = new THREE.Mesh(new RoundedBoxGeometry(0.075, 0.06, 0.03, 3, 0.01), shell);
  head.position.set(0, 0.045, -0.03); root.add(head);
  const plate = new THREE.Mesh(new RoundedBoxGeometry(0.085, 0.072, 0.008, 2, 0.003), metal);
  plate.position.set(0, 0.045, -0.049); root.add(plate);
  const button = new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.008, 0.006, 14).rotateX(Math.PI / 2), orange);
  button.position.set(0, 0.07, -0.012); root.add(button);
  // cable leaving the bottom of the handle, curling away
  const pts = [];
  for (let i = 0; i <= 14; i++) { const t = i / 14; pts.push(new THREE.Vector3(side * 0.02 * Math.sin(t * 9) + side * t * 0.12, -0.05 - t * 0.35, 0.02 * Math.cos(t * 9) + t * 0.15)); }
  const cable = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 60, 0.0045, 6, false), new THREE.MeshStandardMaterial({ color: 0x18191b, roughness: 0.6 }));
  root.add(cable);
  const face = new THREE.Object3D(); face.position.set(0, 0.045, -0.056); root.add(face);
  return { root, plate, button, buttonMat: orange, face };
}

/** Small AED unit (for the toolbox picture): yellow case with a screen and a lightning symbol. */
export function buildAED() {
  const root = new THREE.Group();
  const yellow = new THREE.MeshStandardMaterial({ color: 0xe8b526, roughness: 0.5 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x222428, roughness: 0.5 });
  const screen = new THREE.MeshStandardMaterial({ color: 0x0f2a1a, emissive: 0x1d8a4a, emissiveIntensity: 0.7, roughness: 0.2 });
  const body = new THREE.Mesh(new RoundedBoxGeometry(0.24, 0.2, 0.08, 3, 0.025), yellow);
  root.add(body);
  const face = new THREE.Mesh(new RoundedBoxGeometry(0.2, 0.16, 0.01, 2, 0.01), dark);
  face.position.z = 0.04; root.add(face);
  const scr = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.05, 0.004), screen);
  scr.position.set(-0.04, 0.035, 0.046); root.add(scr);
  const bolt = new THREE.Shape();
  bolt.moveTo(0.004, 0.03); bolt.lineTo(-0.012, -0.002); bolt.lineTo(0.001, -0.002); bolt.lineTo(-0.006, -0.03); bolt.lineTo(0.014, 0.006); bolt.lineTo(0.001, 0.006); bolt.lineTo(0.008, 0.03);
  const b = new THREE.Mesh(new THREE.ShapeGeometry(bolt), new THREE.MeshStandardMaterial({ color: 0xffd23a, emissive: 0xffb000, emissiveIntensity: 0.6 }));
  b.position.set(0.05, 0.03, 0.046); b.scale.setScalar(1.3); root.add(b);
  const btn = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.018, 0.008, 20).rotateX(Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0xd02a20, emissive: 0x500000, roughness: 0.4 }));
  btn.position.set(0, -0.04, 0.047); root.add(btn);
  const handle = new THREE.Mesh(new THREE.TorusGeometry(0.04, 0.008, 6, 16, Math.PI), dark);
  handle.position.y = 0.1; root.add(handle);
  return { root, screen: screen, button: btn };
}
