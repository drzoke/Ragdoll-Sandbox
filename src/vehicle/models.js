import * as THREE from 'three';
import { BoxBatch, mergeGeometries } from '../world/build.js';

// Vehicles you can spawn and drive (see vehicles.js). Built from boxes and cylinders, one merged
// mesh per material, facing +Z (the driver sits on the +X side, which is the left).
//
// Each kind lists its size, how it drives and the boxes that push ragdolls around (physics).

export const VEHICLE_KINDS = {
  truck: {
    name: 'Pickup truck', short: 'Truck',
    text: 'A full-size pickup. Heavy and planted, it shoves bodies out of the way and carries a couple of them in the bed. Top speed about 90 km/h.',
    length: 5.3, width: 2.0, height: 1.9, wheelbase: 3.2, track: 1.72, wheelR: 0.42, wheelW: 0.3, ride: 0.42,
    maxSpeed: 25, reverse: 7, accel: 7.5, brake: 17, drag: 0.35, grip: 7.5, steer: 0.62,
    seat: [0.42, 1.0, 0.25], eye: 1.42, camDist: 6.3, camHeight: 1.6,
    // physics: [half x, half y, half z, centre x, y, z]
    boxes: [[0.98, 0.32, 2.62, 0, 0.92, 0], [0.92, 0.34, 1.02, 0, 1.55, 0.55]],
    paints: [0x8f2a20, 0x2b4f7a, 0xd8d8d2, 0x3f5b38, 0x9a9ea3, 0xc98f22],
  },
  buggy: {
    name: 'Dune buggy', short: 'Buggy',
    text: 'Light, quick and twitchy, with an open roll cage and big knobbly tyres. Pull the handbrake (Space) to slide it round corners. Top speed about 100 km/h.',
    length: 3.6, width: 1.9, height: 1.6, wheelbase: 2.4, track: 1.66, wheelR: 0.45, wheelW: 0.34, ride: 0.45,
    maxSpeed: 28, reverse: 8, accel: 10.5, brake: 18, drag: 0.4, grip: 8.5, steer: 0.68,
    seat: [0.38, 0.72, -0.15], eye: 1.15, camDist: 5.4, camHeight: 1.35,
    boxes: [[0.82, 0.3, 1.72, 0, 0.78, 0], [0.7, 0.32, 0.8, 0, 1.32, -0.25]],
    paints: [0xd8641c, 0x9cb52a, 0x2a8fb8, 0xb8322a, 0xe0c02a],
  },
};

const mat = (color, o = {}) => new THREE.MeshStandardMaterial({ color, roughness: 0.6, metalness: 0.1, ...o });
const SHARED = {
  dark: mat(0x1c1e21, { roughness: 0.85 }),
  trim: mat(0x6a6e73, { roughness: 0.4, metalness: 0.6 }),
  chrome: mat(0xb8bcc2, { roughness: 0.25, metalness: 0.9 }),
  glass: new THREE.MeshStandardMaterial({ color: 0x1a2630, roughness: 0.08, metalness: 0.3, transparent: true, opacity: 0.72 }),
  tire: mat(0x161616, { roughness: 0.95 }),
  rim: mat(0x8a8f95, { roughness: 0.35, metalness: 0.7 }),
  head: new THREE.MeshStandardMaterial({ color: 0xfff6d8, emissive: 0xfff0c0, emissiveIntensity: 0.9, roughness: 0.2 }),
  tail: new THREE.MeshStandardMaterial({ color: 0x6a0d0a, emissive: 0xc0140e, emissiveIntensity: 0.55, roughness: 0.3 }),
  seat: mat(0x2b2723, { roughness: 0.9 }),
};
export const VEHICLE_MATERIALS = SHARED;
const paintCache = new Map();
function paint(color) {
  if (!paintCache.has(color)) paintCache.set(color, mat(color, { roughness: 0.42, metalness: 0.35 }));
  return paintCache.get(color);
}

const _q = new THREE.Quaternion(), _s = new THREE.Vector3(1, 1, 1), _p = new THREE.Vector3(), _up = new THREE.Vector3(0, 1, 0);
/** A cylinder from a to b (tubes of the roll cage, exhausts). */
function tube(batch, material, a, b, r, seg = 10) {
  const A = new THREE.Vector3(...a), B = new THREE.Vector3(...b);
  const len = A.distanceTo(B);
  const geo = new THREE.CylinderGeometry(r, r, len, seg, 1);
  _q.setFromUnitVectors(_up, B.clone().sub(A).normalize());
  _p.copy(A).add(B).multiplyScalar(0.5);
  batch.addGeo(material, geo, new THREE.Matrix4().compose(_p, _q, _s));
}
/** A box turned around X (a windscreen, a sloped bonnet). */
function tilted(batch, material, x, y, z, w, h, d, pitch) {
  const geo = new THREE.BoxGeometry(w, h, d);
  batch.addGeo(material, geo, new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), pitch), _s));
}

/** One wheel: tyre, rim and hub, spinning around its local X axis. */
function buildWheel(r, w, knobbly) {
  const tireGeo = new THREE.CylinderGeometry(r, r, w, 22, 1).rotateZ(Math.PI / 2);
  const parts = [{ geo: tireGeo }];
  if (knobbly) {
    // tread blocks round the tyre
    for (let i = 0; i < 16; i++) {
      const a = (i / 16) * Math.PI * 2;
      const g = new THREE.BoxGeometry(w * 0.95, 0.05, 0.07);
      parts.push({ geo: g, matrix: new THREE.Matrix4().compose(new THREE.Vector3(0, Math.cos(a) * (r - 0.005), Math.sin(a) * (r - 0.005)), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -a), _s) });
    }
  }
  const tire = new THREE.Mesh(mergeGeometries(parts), SHARED.tire);
  const rimGeo = mergeGeometries([
    { geo: new THREE.CylinderGeometry(r * 0.6, r * 0.6, w + 0.02, 16, 1).rotateZ(Math.PI / 2) },
    // spokes, so you can see it turn
    ...[0, 1, 2, 3, 4].map((i) => ({ geo: new THREE.BoxGeometry(w + 0.04, r * 0.95, 0.05), matrix: new THREE.Matrix4().makeRotationX((i / 5) * Math.PI) })),
  ]);
  const rim = new THREE.Mesh(rimGeo, SHARED.rim);
  const g = new THREE.Group();
  tire.castShadow = rim.castShadow = true;
  g.add(tire, rim);
  return g;
}

/** Wheels: four groups (front ones inside a steering pivot). */
function addWheels(root, k) {
  const wheels = [];
  for (const [sx, sz] of [[1, 1], [-1, 1], [1, -1], [-1, -1]]) {
    const pivot = new THREE.Group();
    pivot.position.set(sx * k.track / 2, k.wheelR, sz * k.wheelbase / 2);
    const w = buildWheel(k.wheelR, k.wheelW, k === VEHICLE_KINDS.buggy);
    pivot.add(w);
    root.add(pivot);
    wheels.push({ pivot, wheel: w, front: sz > 0, x: sx * k.track / 2, z: sz * k.wheelbase / 2 });
  }
  return wheels;
}

function buildTruck(k, color) {
  const B = new BoxBatch(), P = paint(color);
  const L = k.length, hl = L / 2;
  // frame and the lower body round the wheel arches
  B.add(SHARED.dark, 0, 0.55, 0, 1.5, 0.22, L - 0.4);
  B.add(P, 0, 1.06, 0, 2.0, 0.42, L);                      // the body above the wheels
  B.add(P, 0, 0.7, 0, 2.0, 0.34, k.wheelbase - 2 * k.wheelR - 0.25);   // between the wheels
  B.add(P, 0, 0.72, hl - 0.38, 2.0, 0.34, 0.76);           // front overhang
  B.add(P, 0, 0.72, -hl + 0.42, 2.0, 0.34, 0.84);          // rear overhang
  B.add(SHARED.dark, 0.99, 0.52, 0, 0.04, 0.12, k.wheelbase - 2 * k.wheelR - 0.25);   // sills
  B.add(SHARED.dark, -0.99, 0.52, 0, 0.04, 0.12, k.wheelbase - 2 * k.wheelR - 0.25);
  // cab
  B.add(P, 0, 1.6, 0.55, 1.9, 0.6, 1.95);
  B.add(P, 0, 1.9, 0.45, 1.84, 0.06, 1.7);                  // roof
  tilted(B, SHARED.glass, 0, 1.62, 1.55, 1.78, 0.62, 0.05, -0.42);      // windscreen
  tilted(B, SHARED.glass, 0, 1.62, -0.44, 1.7, 0.5, 0.04, 0.12);        // rear window
  for (const s of [1, -1]) {
    B.add(SHARED.glass, s * 0.955, 1.64, 0.95, 0.02, 0.44, 0.85);       // front side windows
    B.add(SHARED.glass, s * 0.955, 1.64, 0.02, 0.02, 0.44, 0.7);        // rear side windows
    B.add(SHARED.dark, s * 0.96, 1.64, 0.49, 0.03, 0.46, 0.08);         // pillar
    B.add(SHARED.dark, s * 1.08, 1.5, 1.42, 0.16, 0.12, 0.05);          // mirror
    B.add(SHARED.trim, s * 1.01, 1.18, 0.55, 0.03, 0.05, 0.22);         // door handle
  }
  // bonnet, grille, lights, bumpers
  tilted(B, P, 0, 1.3, 2.05, 1.96, 0.08, 1.15, 0.06);
  B.add(SHARED.dark, 0, 1.0, hl + 0.005, 1.4, 0.32, 0.04);
  for (const s of [1, -1]) {
    B.add(SHARED.head, s * 0.78, 1.04, hl + 0.01, 0.32, 0.16, 0.04);
    B.add(SHARED.tail, s * 0.9, 1.02, -hl - 0.01, 0.16, 0.3, 0.04);
  }
  B.add(SHARED.chrome, 0, 0.66, hl + 0.06, 2.02, 0.2, 0.16);
  B.add(SHARED.chrome, 0, 0.66, -hl - 0.06, 2.02, 0.18, 0.14);
  // the bed: floor, sides and tailgate
  B.add(SHARED.dark, 0, 1.28, -1.45, 1.8, 0.04, 2.15);
  for (const s of [1, -1]) B.add(P, s * 0.96, 1.48, -1.5, 0.08, 0.42, 2.2);
  B.add(P, 0, 1.48, -hl + 0.06, 1.92, 0.42, 0.08);
  B.add(SHARED.dark, 0, 1.52, -0.52, 1.84, 0.5, 0.06);       // cab back wall
  const root = new THREE.Group();
  const body = new THREE.Group();
  for (const m of B.build()) body.add(m);
  root.add(body);
  return { root, body, wheels: addWheels(root, k) };
}

function buildBuggy(k, color) {
  const B = new BoxBatch(), P = paint(color);
  const hl = k.length / 2;
  // floor pan, nose and tail
  B.add(SHARED.dark, 0, 0.52, -0.05, 1.42, 0.12, 2.9);
  tilted(B, P, 0, 0.82, 1.32, 1.3, 0.12, 1.05, 0.32);             // nose panel
  B.add(P, 0, 0.66, 1.58, 1.34, 0.3, 0.5);
  for (const s of [1, -1]) B.add(P, s * 0.73, 0.75, 0.05, 0.08, 0.38, 1.7);   // side panels
  // seats
  for (const s of [1, -1]) {
    B.add(SHARED.seat, s * 0.38, 0.72, -0.25, 0.5, 0.16, 0.55);
    tilted(B, SHARED.seat, s * 0.38, 1.05, -0.56, 0.5, 0.62, 0.12, -0.18);
  }
  // engine and exhausts at the back
  B.add(SHARED.trim, 0, 0.82, -1.38, 0.9, 0.5, 0.62);
  B.add(SHARED.dark, 0, 0.82, -1.38, 0.95, 0.12, 0.66);
  for (const s of [1, -1]) tube(B, SHARED.chrome, [s * 0.32, 0.75, -1.6], [s * 0.36, 1.05, -hl - 0.05], 0.045);
  // roll cage
  const C = P, r = 0.04, top = 1.58;
  for (const s of [1, -1]) {
    tube(B, C, [s * 0.68, 0.6, 0.62], [s * 0.6, top, 0.05], r);         // front pillar
    tube(B, C, [s * 0.68, 0.6, -0.78], [s * 0.6, top, -0.62], r);       // rear pillar
    tube(B, C, [s * 0.6, top, 0.05], [s * 0.6, top, -0.62], r);         // roof rail
    tube(B, C, [s * 0.68, 0.6, 0.62], [s * 0.66, 0.66, 1.65], r);       // to the nose
    tube(B, C, [s * 0.68, 0.6, -0.78], [s * 0.55, 0.9, -1.7], r);       // to the tail
    tube(B, SHARED.dark, [s * 0.6, 0.55, 1.0], [s * k.track / 2 - 0.1, k.wheelR, k.wheelbase / 2], 0.03);   // suspension arms
    tube(B, SHARED.dark, [s * 0.6, 0.55, -1.0], [s * k.track / 2 - 0.1, k.wheelR, -k.wheelbase / 2], 0.03);
  }
  tube(B, C, [0.6, top, 0.05], [-0.6, top, 0.05], r);
  tube(B, C, [0.6, top, -0.62], [-0.6, top, -0.62], r);
  tube(B, C, [0.6, top, 0.05], [-0.6, top, -0.62], r * 0.8);              // cross brace
  tube(B, SHARED.chrome, [-0.7, 0.62, 1.85], [0.7, 0.62, 1.85], 0.05);    // front bumper bar
  for (const s of [1, -1]) {
    B.add(SHARED.head, s * 0.42, 0.78, 1.84, 0.2, 0.12, 0.04);
    B.add(SHARED.tail, s * 0.5, 0.9, -1.7, 0.12, 0.08, 0.04);
  }
  // steering wheel
  tube(B, SHARED.dark, [0.38, 0.85, 0.55], [0.38, 1.02, 0.28], 0.02);
  B.addGeo(SHARED.dark, new THREE.TorusGeometry(0.15, 0.018, 6, 16), new THREE.Matrix4().compose(new THREE.Vector3(0.38, 1.04, 0.26), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -0.9), _s));
  const root = new THREE.Group();
  const body = new THREE.Group();
  for (const m of B.build()) body.add(m);
  root.add(body);
  return { root, body, wheels: addWheels(root, k) };
}

/** The model of a vehicle kind in a paint colour. Returns { root, body, wheels }. */
export function buildVehicle(kind, color) {
  const k = VEHICLE_KINDS[kind];
  const out = kind === 'buggy' ? buildBuggy(k, color) : buildTruck(k, color);
  out.root.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  return out;
}
