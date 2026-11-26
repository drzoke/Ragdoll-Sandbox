import * as THREE from 'three';

// Procedural "green ball" fragmentation grenade (M67 style), real-world scale in metres.
// Origin = centre of the ball. The fuse points up (+Y), the spoon runs down the +X side and the
// pull ring hangs on the -X side.

export function buildGrenade() {
  const olive = new THREE.MeshStandardMaterial({ color: 0x4d5b2b, roughness: 0.55, metalness: 0.15 });
  const oliveDark = new THREE.MeshStandardMaterial({ color: 0x353f1d, roughness: 0.6, metalness: 0.15 });
  const yellow = new THREE.MeshStandardMaterial({ color: 0xc9a227, roughness: 0.5 });
  const fuseMat = new THREE.MeshStandardMaterial({ color: 0x59604c, roughness: 0.42, metalness: 0.6 });
  const steel = new THREE.MeshStandardMaterial({ color: 0x9a9da2, roughness: 0.28, metalness: 0.95 });

  const root = new THREE.Group(); root.name = 'Grenade';
  const body = new THREE.Mesh(new THREE.SphereGeometry(0.032, 30, 22), olive);
  root.add(body);
  const seam = new THREE.Mesh(new THREE.TorusGeometry(0.0321, 0.0011, 6, 40), oliveDark);
  seam.rotation.x = Math.PI / 2;
  root.add(seam);
  const band = new THREE.Mesh(new THREE.TorusGeometry(0.0232, 0.0016, 6, 36), yellow);
  band.rotation.x = Math.PI / 2; band.position.y = 0.0222;
  root.add(band);
  // fuse assembly
  const collar = new THREE.Mesh(new THREE.CylinderGeometry(0.0118, 0.0125, 0.008, 22), fuseMat);
  collar.position.y = 0.032;
  const fuse = new THREE.Mesh(new THREE.CylinderGeometry(0.0098, 0.0105, 0.018, 22), fuseMat);
  fuse.position.y = 0.044;
  const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.0078, 0.0092, 0.006, 22), fuseMat);
  cap.position.y = 0.056;
  root.add(collar, fuse, cap);

  // spoon (safety lever): flat strip over the fuse and down the +X side
  const spoon = new THREE.Group();
  // follows the fuse and then hugs the ball's surface
  const along = (deg, r = 0.0338) => new THREE.Vector3(Math.sin(deg * Math.PI / 180) * r, Math.cos(deg * Math.PI / 180) * r, 0);
  const curve = new THREE.CatmullRomCurve3([
    new THREE.Vector3(-0.006, 0.0602, 0), new THREE.Vector3(0.006, 0.061, 0), new THREE.Vector3(0.0118, 0.0565, 0),
    new THREE.Vector3(0.0128, 0.046, 0), new THREE.Vector3(0.0142, 0.0365, 0),
    along(30), along(52), along(76), along(100), along(116, 0.0332),
  ]);
  const strip = new THREE.Mesh(new THREE.TubeGeometry(curve, 40, 0.0016, 4, false), olive);
  strip.scale.z = 3.2;
  spoon.add(strip);
  root.add(spoon);

  // safety pin + pull ring (-X side)
  const pinGroup = new THREE.Group();
  const pin = new THREE.Mesh(new THREE.CylinderGeometry(0.0011, 0.0011, 0.03, 8).rotateZ(Math.PI / 2), steel);
  pin.position.set(-0.002, 0.047, 0.0);
  const ring = new THREE.Mesh(new THREE.TorusGeometry(0.0105, 0.00135, 8, 26), steel);
  ring.position.set(-0.026, 0.04, 0.0);
  ring.rotation.set(0, Math.PI / 2 - 0.35, 0.5);
  const ringLink = new THREE.Mesh(new THREE.TorusGeometry(0.0035, 0.001, 6, 14), steel);
  ringLink.position.set(-0.0155, 0.046, 0);
  ringLink.rotation.y = Math.PI / 2;
  pinGroup.add(pin, ring, ringLink);
  root.add(pinGroup);
  // where the left hand's fingers grab the ring
  const ringPoint = new THREE.Object3D(); ringPoint.position.set(-0.034, 0.036, 0.0); root.add(ringPoint);

  root.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = false; } });
  return { root, body, spoon, pinGroup, ring, ringPoint, materials: { olive, fuseMat } };
}
