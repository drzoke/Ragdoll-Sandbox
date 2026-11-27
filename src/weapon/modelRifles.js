import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { walnutTexture } from './model870.js';

// Procedural bolt-action sniper rifle and flintlock musket, real-world scale in metres.
// Origin: rear of the receiver (rifle) / the lock (musket), on the bore axis. Forward = -Z, up = +Y, right = +X.

const add = (parent, geo, mat, x = 0, y = 0, z = 0) => { const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); parent.add(m); return m; };
const cylZ = (r, len, seg = 20, r2 = r) => new THREE.CylinderGeometry(r2, r, len, seg).rotateX(Math.PI / 2);
const point = (parent, x, y, z) => { const o = new THREE.Object3D(); o.position.set(x, y, z); parent.add(o); return o; };

/** Side profile (u = distance BEHIND the origin, v = height) extruded across the width. */
function profileBack(points, width, bevel = 0.003) {
  const shape = new THREE.Shape();
  points.forEach(([u, v], i) => (i ? shape.lineTo(u, v) : shape.moveTo(u, v)));
  shape.closePath();
  const geo = new THREE.ExtrudeGeometry(shape, { depth: width - bevel * 2, bevelEnabled: true, bevelThickness: bevel, bevelSize: bevel, bevelSegments: 2, curveSegments: 8 });
  geo.translate(0, 0, -(width - bevel * 2) / 2);
  geo.rotateY(-Math.PI / 2);
  geo.computeVertexNormals();
  return geo;
}

/** A .308 cartridge: brass case, bottleneck, copper bullet. Axis = Z (base at +Z). */
export function buildRound() {
  const g = new THREE.Group();
  const brass = new THREE.MeshStandardMaterial({ color: 0xc9a04a, metalness: 1, roughness: 0.25 });
  const copper = new THREE.MeshStandardMaterial({ color: 0xb06a3a, metalness: 1, roughness: 0.3 });
  add(g, cylZ(0.006, 0.039, 14), brass, 0, 0, 0.0);
  add(g, cylZ(0.0045, 0.008, 14, 0.006), brass, 0, 0, -0.0235);
  add(g, cylZ(0.0039, 0.006, 14), brass, 0, 0, -0.0305);
  add(g, cylZ(0.0002, 0.022, 14, 0.0039), copper, 0, 0, -0.0445);
  add(g, cylZ(0.0062, 0.0015, 14), brass, 0, 0, 0.0197);
  g.traverse((o) => { o.castShadow = true; });
  return g;
}

/** Five rounds in a stripper clip: the strip runs up the bases, the rounds lie stacked (pointing -Z). */
export function buildStripperClip() {
  const g = new THREE.Group();
  const steel = new THREE.MeshStandardMaterial({ color: 0x3a3c40, metalness: 0.85, roughness: 0.4 });
  add(g, new THREE.BoxGeometry(0.011, 0.062, 0.003), steel, 0, 0.0236, 0.0212);
  const rounds = [];
  for (let i = 0; i < 5; i++) { const r = buildRound(); r.position.set(0, i * 0.0118, 0); g.add(r); rounds.push(r); }
  g.userData.rounds = rounds;
  return g;
}

export function buildSniper() {
  const steel = new THREE.MeshStandardMaterial({ color: 0x1f2124, metalness: 0.8, roughness: 0.42 });
  const steelDark = new THREE.MeshStandardMaterial({ color: 0x111214, metalness: 0.7, roughness: 0.55 });
  const bright = new THREE.MeshStandardMaterial({ color: 0x8a8d92, metalness: 0.95, roughness: 0.22 });
  const stockMat = new THREE.MeshStandardMaterial({ color: 0x4a5138, roughness: 0.82, metalness: 0.05 });
  const rubber = new THREE.MeshStandardMaterial({ color: 0x101011, roughness: 0.95 });
  const lens = new THREE.MeshStandardMaterial({ color: 0x0b1a26, metalness: 0.9, roughness: 0.05, envMapIntensity: 2 });
  const lensTint = new THREE.MeshBasicMaterial({ color: 0x1d4a66, transparent: true, opacity: 0.5 });

  const root = new THREE.Group(); root.name = 'Sniper rifle';
  // ---- receiver + barrel ----
  add(root, cylZ(0.0172, 0.22, 24), steel, 0, 0, -0.11);
  add(root, new THREE.BoxGeometry(0.03, 0.014, 0.2), steel, 0, -0.012, -0.11);
  add(root, new THREE.BoxGeometry(0.0012, 0.016, 0.07), new THREE.MeshBasicMaterial({ color: 0x050505 }), 0.0172, 0.004, -0.085); // ejection port
  add(root, cylZ(0.0135, 0.06, 22, 0.0155), steel, 0, 0, -0.25);
  add(root, cylZ(0.0108, 0.56, 22, 0.0128), steel, 0, 0, -0.56);
  const brake = add(root, cylZ(0.0145, 0.07, 18), steelDark, 0, 0, -0.875);
  for (const sx of [-1, 1]) for (let i = 0; i < 3; i++) add(root, new THREE.BoxGeometry(0.004, 0.012, 0.008), new THREE.MeshBasicMaterial({ color: 0x050505 }), sx * 0.0135, 0, -0.85 - i * 0.02);
  add(root, new THREE.CircleGeometry(0.0062, 16), new THREE.MeshBasicMaterial({ color: 0x030303 }), 0, 0, -0.9105).rotation.y = Math.PI;
  brake.userData.keep = true;
  // trigger guard + trigger, magazine floorplate
  add(root, new THREE.BoxGeometry(0.012, 0.004, 0.075), steelDark, 0, -0.062, -0.02);
  add(root, new THREE.BoxGeometry(0.012, 0.03, 0.004), steelDark, 0, -0.047, 0.016);
  const trigger = add(root, new THREE.BoxGeometry(0.005, 0.022, 0.005), bright, 0, -0.045, -0.02);
  trigger.rotation.x = 0.25;
  add(root, new THREE.BoxGeometry(0.03, 0.006, 0.08), steelDark, 0, -0.045, -0.1);

  // ---- bolt: body slides inside the receiver, the handle lifts and pulls back ----
  const bolt = new THREE.Group(); root.add(bolt);
  add(bolt, cylZ(0.0098, 0.15, 16), bright, 0, 0, -0.055);
  const handle = new THREE.Group(); handle.position.set(0, 0, 0.012); bolt.add(handle);
  const arm = add(handle, new THREE.CylinderGeometry(0.0045, 0.0045, 0.06, 10).rotateZ(Math.PI / 2), bright, 0.034, 0, 0);
  arm.rotation.y = -0.25;
  add(handle, new THREE.SphereGeometry(0.0105, 14, 10), steel, 0.064, -0.002, 0.008);
  add(bolt, cylZ(0.012, 0.022, 16), steel, 0, 0, 0.022);   // bolt shroud at the back

  // ---- scope ----
  const scope = new THREE.Group(); scope.position.set(0, 0.052, -0.11); root.add(scope);
  add(scope, cylZ(0.0152, 0.25, 22), steel, 0, 0, 0);
  add(scope, cylZ(0.0245, 0.075, 24, 0.0152), steel, 0, 0, -0.16);
  add(scope, cylZ(0.0245, 0.02, 24), steelDark, 0, 0, -0.205);
  add(scope, cylZ(0.0152, 0.06, 22, 0.0205), steel, 0, 0, 0.15);
  add(scope, cylZ(0.0215, 0.05, 22), rubber, 0, 0, 0.2);
  add(scope, new THREE.CylinderGeometry(0.009, 0.009, 0.02, 14), steelDark, 0, 0.022, -0.01);  // elevation turret
  add(scope, new THREE.CylinderGeometry(0.009, 0.009, 0.02, 14).rotateZ(Math.PI / 2), steelDark, 0.022, 0, -0.01);
  const front = add(scope, new THREE.CircleGeometry(0.022, 22), lens, 0, 0, -0.2155); front.rotation.y = Math.PI;
  add(scope, new THREE.CircleGeometry(0.0225, 22), lensTint, 0, 0, -0.2158).rotation.y = Math.PI;
  add(scope, new THREE.CircleGeometry(0.019, 22), lens, 0, 0, 0.2255);
  for (const z of [-0.06, 0.065]) {
    add(root, new THREE.BoxGeometry(0.022, 0.022, 0.016), steelDark, 0, 0.028, z - 0.11);
    add(scope, new THREE.TorusGeometry(0.017, 0.004, 8, 20), steelDark, 0, 0, z);
  }

  // ---- stock (one piece: forend, grip, buttstock with a cheek rest) ----
  const stock = add(root, profileBack([
    [-0.47, -0.012], [-0.05, -0.012], [0.03, -0.012], [0.07, -0.02], [0.1, -0.008], [0.36, 0.0], [0.4, 0.004],
    [0.405, -0.13], [0.37, -0.135], [0.2, -0.085], [0.13, -0.07], [0.1, -0.11], [0.07, -0.118], [0.05, -0.09], [0.035, -0.055],
    [-0.08, -0.06], [-0.44, -0.048], [-0.47, -0.04],
  ], 0.046), stockMat);
  stock.userData.stock = true;
  add(root, new RoundedBoxGeometry(0.046, 0.13, 0.024, 2, 0.006), rubber, 0, -0.064, 0.41);
  // bipod folded under the forend
  for (const sx of [-1, 1]) add(root, cylZ(0.004, 0.2, 8), steelDark, sx * 0.012, -0.066, -0.36);
  add(root, new THREE.BoxGeometry(0.03, 0.012, 0.03), steelDark, 0, -0.062, -0.45);

  const muzzle = point(root, 0, 0, -0.915);
  const ejectPort = point(root, 0.024, 0.006, -0.085);
  const loadPort = point(root, 0, 0.03, -0.08);
  const gripPoint = point(root, 0, -0.062, 0.085);
  const foreHand = point(root, -0.004, -0.07, -0.3);
  const boltKnob = point(handle, 0.064, -0.002, 0.008);
  root.traverse((o) => { if (o.isMesh) { o.castShadow = false; o.receiveShadow = false; } });
  return { root, bolt, handle, trigger, muzzle, ejectPort, loadPort, gripPoint, foreHand, boltKnob, scope, materials: { steel, stockMat } };
}

export function buildMusket() {
  const iron = new THREE.MeshStandardMaterial({ color: 0x3b3d40, metalness: 0.8, roughness: 0.5 });
  const ironDark = new THREE.MeshStandardMaterial({ color: 0x1d1e20, metalness: 0.7, roughness: 0.6 });
  const brass = new THREE.MeshStandardMaterial({ color: 0xb08a3e, metalness: 0.95, roughness: 0.35 });
  const wood = new THREE.MeshStandardMaterial({ map: walnutTexture(), color: 0xc49a76, roughness: 0.55 });
  const flintMat = new THREE.MeshStandardMaterial({ color: 0x5a5148, roughness: 0.5 });
  const black = new THREE.MeshBasicMaterial({ color: 0x030303 });

  const root = new THREE.Group(); root.name = 'Flintlock musket';
  // ---- barrel (1.07 m), held in a full-length stock ----
  add(root, cylZ(0.0118, 1.07, 20, 0.0142), iron, 0, 0, -0.5);
  add(root, new THREE.CircleGeometry(0.0095, 18), black, 0, 0, -1.0355).rotation.y = Math.PI;
  add(root, new THREE.BoxGeometry(0.003, 0.009, 0.012), iron, 0, 0.0145, -0.99);     // front sight (bayonet lug)
  for (const z of [-0.36, -0.62, -0.86]) add(root, cylZ(0.0155, 0.012, 16), iron, 0, -0.004, z);   // barrel bands
  // ramrod under the barrel
  const ramrod = new THREE.Group(); root.add(ramrod);
  add(ramrod, cylZ(0.0045, 1.0, 10), iron, 0, -0.026, -0.52);
  add(ramrod, cylZ(0.0065, 0.022, 10), iron, 0, -0.026, -1.02);
  const ramTip = point(ramrod, 0, -0.026, -1.02);
  // stock: forestock along the barrel + wrist + butt
  add(root, new RoundedBoxGeometry(0.032, 0.03, 0.88, 2, 0.009), wood, 0, -0.022, -0.48);
  const butt = add(root, profileBack([
    [-0.06, 0.0], [0.02, 0.002], [0.08, -0.016], [0.16, -0.048], [0.44, -0.078], [0.47, -0.08],
    [0.475, -0.222], [0.44, -0.222], [0.2, -0.13], [0.12, -0.09], [0.07, -0.072], [0.02, -0.045], [-0.06, -0.034],
  ], 0.044, 0.004), wood);
  butt.userData.wood = true;
  add(root, new THREE.BoxGeometry(0.046, 0.15, 0.006), brass, 0, -0.151, 0.475);    // butt plate
  // trigger guard (brass), trigger
  add(root, new THREE.BoxGeometry(0.012, 0.004, 0.11), brass, 0, -0.06, 0.04);
  add(root, new THREE.BoxGeometry(0.012, 0.028, 0.004), brass, 0, -0.047, 0.095);
  const trigger = add(root, new THREE.BoxGeometry(0.005, 0.022, 0.005), iron, 0, -0.045, 0.045);
  trigger.rotation.x = 0.3;
  add(root, new THREE.BoxGeometry(0.03, 0.012, 0.024), brass, 0, -0.03, -0.92);    // nose cap

  // ---- the lock on the right side: plate, pan, frizzen, cock with its flint ----
  const lock = new THREE.Group(); lock.position.set(0.019, -0.006, 0.01); root.add(lock);
  add(lock, new RoundedBoxGeometry(0.004, 0.03, 0.14, 2, 0.0015), iron, 0, -0.004, 0.0);
  const pan = add(lock, new THREE.BoxGeometry(0.014, 0.004, 0.016), iron, 0.006, 0.01, -0.03);
  const frizzen = new THREE.Group(); frizzen.position.set(0.007, 0.012, -0.038); lock.add(frizzen);
  add(frizzen, new THREE.BoxGeometry(0.012, 0.03, 0.004), ironDark, 0, 0.015, 0);
  add(frizzen, new THREE.BoxGeometry(0.012, 0.003, 0.016), ironDark, 0, 0.0005, 0.008);
  const cock = new THREE.Group(); cock.position.set(0.006, 0.0, 0.02); lock.add(cock);   // pivots on its screw
  add(cock, new THREE.BoxGeometry(0.006, 0.042, 0.009), iron, 0, 0.021, 0).rotation.x = -0.35;
  add(cock, new THREE.BoxGeometry(0.007, 0.006, 0.02), iron, 0, 0.04, -0.01);
  const flint = add(cock, new THREE.BoxGeometry(0.009, 0.006, 0.014), flintMat, 0, 0.04, -0.022);
  flint.rotation.x = 0.3;
  const panPoint = point(lock, 0.008, 0.016, -0.03);

  const muzzle = point(root, 0, 0, -1.04);
  const gripPoint = point(root, 0, -0.06, 0.12);
  const foreHand = point(root, -0.004, -0.05, -0.42);
  root.traverse((o) => { if (o.isMesh) { o.castShadow = false; o.receiveShadow = false; } });
  return { root, ramrod, ramTip, cock, frizzen, pan, panPoint, trigger, muzzle, gripPoint, foreHand, materials: { iron, wood } };
}
