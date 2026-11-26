import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { canvasTexture } from '../core/util.js';

// Procedural Remington 870 pump-action shotgun (12 gauge), real-world scale in metres.
// Origin: rear face of the receiver on the bore axis. Forward = -Z, up = +Y, gun's right = +X.

/** Side profile (u = distance BEHIND the receiver, v = height) extruded across the gun's width. */
function profileBack(points, width, bevel = 0.002) {
  const shape = new THREE.Shape();
  points.forEach(([u, v], i) => (i ? shape.lineTo(u, v) : shape.moveTo(u, v)));
  shape.closePath();
  const geo = new THREE.ExtrudeGeometry(shape, { depth: width - bevel * 2, bevelEnabled: true, bevelThickness: bevel, bevelSize: bevel, bevelSegments: 3, curveSegments: 10 });
  geo.translate(0, 0, -(width - bevel * 2) / 2);
  geo.rotateY(-Math.PI / 2); // shape +u -> +Z (backwards), extrude axis -> X
  geo.computeVertexNormals();
  return geo;
}

let walnut = null;
/** Oiled walnut: long grain lines and a few darker figure streaks. */
export function walnutTexture() {
  if (walnut) return walnut;
  walnut = canvasTexture(256, 512, (g, w, h) => {
    const grd = g.createLinearGradient(0, 0, w, 0);
    grd.addColorStop(0, '#5b2f17'); grd.addColorStop(0.5, '#6d3b1d'); grd.addColorStop(1, '#58301a');
    g.fillStyle = grd; g.fillRect(0, 0, w, h);
    for (let i = 0; i < 110; i++) {
      g.strokeStyle = `rgba(${Math.random() < 0.3 ? '120,70,35' : '28,12,5'},${0.06 + Math.random() * 0.14})`;
      g.lineWidth = 0.6 + Math.random() * 2.2;
      g.beginPath(); const x = Math.random() * w; g.moveTo(x, 0);
      for (let y = 0; y <= h; y += 24) g.lineTo(x + Math.sin(y * 0.012 + i) * 10 + Math.sin(y * 0.05 + i * 2) * 2, y);
      g.stroke();
    }
    for (let i = 0; i < 6; i++) { // dark figure
      const x = Math.random() * w, y = Math.random() * h;
      const r = g.createRadialGradient(x, y, 0, x, y, 60); r.addColorStop(0, 'rgba(20,8,2,0.25)'); r.addColorStop(1, 'rgba(20,8,2,0)');
      g.fillStyle = r; g.fillRect(x - 60, y - 60, 120, 120);
    }
  }, { repeat: true });
  return walnut;
}

/** A 12 gauge shell: red plastic hull, brass head, crimped end. Axis = Z (base at +Z). */
export function buildShell(scale = 1) {
  const g = new THREE.Group();
  const hullMat = new THREE.MeshStandardMaterial({ color: 0xb3161b, roughness: 0.42, metalness: 0.05 });
  const brass = new THREE.MeshStandardMaterial({ color: 0xc9a04a, metalness: 1, roughness: 0.25 });
  const crimp = new THREE.MeshStandardMaterial({ color: 0x7a0c10, roughness: 0.6 });
  const hull = new THREE.Mesh(new THREE.CylinderGeometry(0.0102, 0.0102, 0.056, 16).rotateX(Math.PI / 2), hullMat);
  hull.position.z = -0.012;
  const head = new THREE.Mesh(new THREE.CylinderGeometry(0.0106, 0.0106, 0.015, 16).rotateX(Math.PI / 2), brass);
  head.position.z = 0.0225;
  const rim = new THREE.Mesh(new THREE.CylinderGeometry(0.0114, 0.0114, 0.0018, 18).rotateX(Math.PI / 2), brass);
  rim.position.z = 0.0296;
  const primer = new THREE.Mesh(new THREE.CircleGeometry(0.0028, 12), new THREE.MeshStandardMaterial({ color: 0xd8c690, metalness: 1, roughness: 0.3 }));
  primer.position.z = 0.0306;
  const cap = new THREE.Mesh(new THREE.CircleGeometry(0.0098, 16), crimp);
  cap.position.z = -0.0401; cap.rotation.y = Math.PI;
  // crimp folds
  for (let i = 0; i < 6; i++) {
    const f = new THREE.Mesh(new THREE.BoxGeometry(0.0012, 0.0085, 0.0008), crimp);
    f.position.z = -0.0404; f.rotation.z = (i / 6) * Math.PI; g.add(f);
  }
  g.add(hull, head, rim, primer, cap);
  g.scale.setScalar(scale);
  g.userData.materials = { hullMat, brass };
  return g;
}

export function buildRemington870() {
  const steel = new THREE.MeshStandardMaterial({ color: 0x202226, metalness: 0.82, roughness: 0.4 });
  const steelDark = new THREE.MeshStandardMaterial({ color: 0x121315, metalness: 0.75, roughness: 0.5 });
  const steelBright = new THREE.MeshStandardMaterial({ color: 0x6a6d72, metalness: 0.95, roughness: 0.25 });
  const wood = new THREE.MeshStandardMaterial({ map: walnutTexture(), roughness: 0.42, metalness: 0.0 });
  const rubber = new THREE.MeshStandardMaterial({ color: 0x0d0d0e, roughness: 0.9 });
  const black = new THREE.MeshBasicMaterial({ color: 0x040404 });
  const bead = new THREE.MeshStandardMaterial({ color: 0xe8e2cf, metalness: 0.6, roughness: 0.25 });

  const root = new THREE.Group(); root.name = 'Remington 870';
  const add = (parent, geo, mat, x = 0, y = 0, z = 0) => { const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); parent.add(m); return m; };
  const cylZ = (r, len, seg = 20) => new THREE.CylinderGeometry(r, r, len, seg).rotateX(Math.PI / 2);

  // ---------------- receiver ----------------
  add(root, new RoundedBoxGeometry(0.031, 0.06, 0.21, 2, 0.005), steel, 0, -0.0125, -0.105);
  add(root, new RoundedBoxGeometry(0.016, 0.006, 0.2, 2, 0.002), steel, 0, 0.0185, -0.105);          // top rib
  add(root, new THREE.BoxGeometry(0.0012, 0.021, 0.062), black, 0.0157, 0.0005, -0.078);              // ejection port
  add(root, new THREE.BoxGeometry(0.001, 0.016, 0.054), steelBright, 0.0152, 0.0005, -0.08);          // bolt face showing
  add(root, new THREE.BoxGeometry(0.021, 0.0012, 0.066), black, 0, -0.0427, -0.098);                  // loading port
  add(root, new THREE.BoxGeometry(0.017, 0.001, 0.05), steelBright, 0, -0.0418, -0.098);              // shell carrier
  // engraved roll mark plate (left side)
  add(root, new THREE.BoxGeometry(0.0006, 0.012, 0.07), steelDark, -0.0157, -0.016, -0.1);
  // trigger guard + trigger + safety
  const tg = new THREE.Shape();
  tg.moveTo(0.0, 0); tg.lineTo(0.075, 0); tg.lineTo(0.075, -0.012); tg.quadraticCurveTo(0.072, -0.036, 0.05, -0.037); tg.lineTo(0.02, -0.037); tg.quadraticCurveTo(0.002, -0.034, 0, -0.012); tg.closePath();
  const tgHole = new THREE.Path();
  tgHole.moveTo(0.008, -0.004); tgHole.lineTo(0.066, -0.004); tgHole.lineTo(0.066, -0.013); tgHole.quadraticCurveTo(0.063, -0.031, 0.048, -0.031); tgHole.lineTo(0.022, -0.031); tgHole.quadraticCurveTo(0.009, -0.029, 0.008, -0.013); tgHole.closePath();
  tg.holes.push(tgHole);
  const tgGeo = new THREE.ExtrudeGeometry(tg, { depth: 0.012, bevelEnabled: true, bevelThickness: 0.001, bevelSize: 0.001, bevelSegments: 1, curveSegments: 8 });
  tgGeo.translate(0, 0, -0.006); tgGeo.rotateY(Math.PI / 2);
  add(root, tgGeo, steelDark, 0, -0.042, -0.012);
  const trigger = add(root, new THREE.BoxGeometry(0.006, 0.02, 0.005), steelBright, 0, -0.054, -0.045);
  trigger.rotation.x = 0.25;
  const safety = add(root, cylZ(0.0035, 0.034, 12), steelBright, 0, -0.036, -0.012); safety.rotation.y = Math.PI / 2;
  add(root, new THREE.BoxGeometry(0.004, 0.006, 0.012), steelBright, -0.0165, -0.038, -0.088);        // action release

  // ---------------- barrel, magazine tube ----------------
  add(root, cylZ(0.0128, 0.05, 24), steel, 0, 0, -0.232);                                              // barrel shank
  add(root, cylZ(0.0114, 0.46, 24), steel, 0, 0, -0.45);
  const muzzleRing = add(root, cylZ(0.0118, 0.008, 24), steelDark, 0, 0, -0.676);
  muzzleRing.userData.keep = true;
  add(root, new THREE.CircleGeometry(0.0093, 20), black, 0, 0, -0.6805).rotation.y = Math.PI;
  add(root, new THREE.SphereGeometry(0.0023, 10, 8), bead, 0, 0.0128, -0.668);
  add(root, cylZ(0.0105, 0.39, 20), steel, 0, -0.0272, -0.405);                                        // mag tube
  const cap = add(root, cylZ(0.0124, 0.036, 22), steelDark, 0, -0.0272, -0.618);
  for (let i = 0; i < 6; i++) add(root, cylZ(0.0128, 0.002, 22), steelDark, 0, -0.0272, -0.604 - i * 0.005);
  cap.userData.keep = true;
  add(root, new THREE.BoxGeometry(0.012, 0.026, 0.02), steel, 0, -0.014, -0.585);                       // barrel lug

  // ---------------- pump (fore-end) ----------------
  const pump = new THREE.Group(); root.add(pump);
  add(pump, new RoundedBoxGeometry(0.046, 0.047, 0.165, 3, 0.014), wood, 0, -0.03, -0.382);
  for (let i = 0; i < 9; i++) add(pump, new RoundedBoxGeometry(0.0468, 0.0478, 0.0035, 2, 0.0015), new THREE.MeshStandardMaterial({ color: 0x2a1408, roughness: 0.7 }), 0, -0.03, -0.32 - i * 0.0128);
  add(pump, new THREE.BoxGeometry(0.03, 0.03, 0.012), steelDark, 0, -0.028, -0.296);                     // fore-end tube nut
  for (const sx of [-1, 1]) add(pump, new THREE.BoxGeometry(0.0028, 0.005, 0.12), steelBright, sx * 0.0125, -0.024, -0.24); // action bars

  // ---------------- stock ----------------
  const stock = add(root, profileBack([
    // real stocks drop away below the line of the receiver (drop at comb / heel)
    [0.0, 0.013], [0.035, 0.002], [0.12, -0.022], [0.335, -0.046], [0.343, -0.05], [0.352, -0.182],
    [0.33, -0.185], [0.16, -0.118], [0.09, -0.088], [0.055, -0.072], [0.03, -0.056], [0.0, -0.043],
  ], 0.036), wood);
  stock.userData.wood = true;
  const pad = add(root, new RoundedBoxGeometry(0.038, 0.138, 0.022, 2, 0.006), rubber, 0, -0.116, 0.358);
  pad.rotation.x = 0.1;
  add(root, new THREE.BoxGeometry(0.039, 0.14, 0.003), new THREE.MeshStandardMaterial({ color: 0xece6d8, roughness: 0.6 }), 0, -0.116, 0.346).rotation.x = 0.1; // white spacer
  add(root, cylZ(0.004, 0.012, 10), steelBright, 0, -0.152, 0.25).rotation.x = Math.PI / 2;              // sling swivel stud

  // ---------------- attach points ----------------
  const point = (parent, x, y, z) => { const o = new THREE.Object3D(); o.position.set(x, y, z); parent.add(o); return o; };
  const muzzle = point(root, 0, 0, -0.684);
  const ejectPort = point(root, 0.022, 0.0, -0.078);
  const loadPort = point(root, 0, -0.045, -0.1);
  const gripPoint = point(root, 0.0, -0.048, 0.055);
  const pumpHand = point(pump, -0.004, -0.066, -0.39);
  root.traverse((o) => { if (o.isMesh) { o.castShadow = false; o.receiveShadow = false; } });
  return { root, pump, trigger, muzzle, ejectPort, loadPort, gripPoint, pumpHand, materials: { steel, wood } };
}
