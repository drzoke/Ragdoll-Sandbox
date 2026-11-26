import * as THREE from 'three';
import { canvasTexture } from '../core/util.js';

// Procedural Colt M1911 (.45 ACP), real-world scale in metres.
// Origin: rear face of the slide on the bore axis. Forward = -Z, up = +Y, gun's right = +X.

const RAKE = THREE.MathUtils.degToRad(18); // grip angle

/** Extrude a side profile (u = forward distance, v = height) across the gun's width. */
function profile(points, width, bevel = 0.0009, holes = []) {
  const shape = new THREE.Shape();
  points.forEach(([u, v], i) => (i ? shape.lineTo(u, v) : shape.moveTo(u, v)));
  shape.closePath();
  for (const h of holes) shape.holes.push(h);
  const geo = new THREE.ExtrudeGeometry(shape, {
    depth: width - bevel * 2, bevelEnabled: true, bevelThickness: bevel, bevelSize: bevel, bevelSegments: 2, curveSegments: 8,
  });
  geo.translate(0, 0, -(width - bevel * 2) / 2);
  geo.rotateY(Math.PI / 2); // shape +u -> -Z, extrude axis -> X
  geo.computeVertexNormals();
  return geo;
}

function woodTexture() {
  return canvasTexture(256, 512, (g, w, h) => {
    const grd = g.createLinearGradient(0, 0, w, h);
    grd.addColorStop(0, '#6b3d22'); grd.addColorStop(0.5, '#5a321c'); grd.addColorStop(1, '#6e4126');
    g.fillStyle = grd; g.fillRect(0, 0, w, h);
    for (let i = 0; i < 60; i++) { // grain
      g.strokeStyle = `rgba(30,14,6,${0.08 + Math.random() * 0.12})`; g.lineWidth = 1 + Math.random() * 2;
      g.beginPath(); const x = Math.random() * w; g.moveTo(x, 0);
      for (let y = 0; y <= h; y += 32) g.lineTo(x + Math.sin(y * 0.02 + i) * 8, y);
      g.stroke();
    }
    // double-diamond checkering
    g.strokeStyle = 'rgba(20,8,2,0.55)'; g.lineWidth = 2;
    const step = 11;
    const diamond = (cx, cy) => {
      g.save(); g.beginPath(); g.moveTo(cx, cy - 110); g.lineTo(cx + 85, cy); g.lineTo(cx, cy + 110); g.lineTo(cx - 85, cy); g.closePath(); g.clip();
      for (let k = -h; k < h * 2; k += step) { g.beginPath(); g.moveTo(k, 0); g.lineTo(k + h * 0.75, h); g.stroke(); g.beginPath(); g.moveTo(k, h); g.lineTo(k + h * 0.75, 0); g.stroke(); }
      g.restore();
    };
    diamond(w / 2, h * 0.26); diamond(w / 2, h * 0.74);
    // screw
    for (const y of [h * 0.12, h * 0.88]) { g.fillStyle = '#2a2a2c'; g.beginPath(); g.arc(w / 2, y, 14, 0, Math.PI * 2); g.fill(); g.strokeStyle = '#111'; g.lineWidth = 3; g.beginPath(); g.moveTo(w / 2 - 10, y); g.lineTo(w / 2 + 10, y); g.stroke(); }
  });
}

export function buildM1911() {
  const steel = new THREE.MeshStandardMaterial({ color: 0x26282c, metalness: 0.85, roughness: 0.36 });
  const steelDark = new THREE.MeshStandardMaterial({ color: 0x151618, metalness: 0.8, roughness: 0.45 });
  const steelBright = new THREE.MeshStandardMaterial({ color: 0x6d7076, metalness: 0.95, roughness: 0.22 });
  const wood = new THREE.MeshStandardMaterial({ map: woodTexture(), roughness: 0.55, metalness: 0.0 });
  const brass = new THREE.MeshStandardMaterial({ color: 0xc9a04a, metalness: 1, roughness: 0.28 });
  const black = new THREE.MeshBasicMaterial({ color: 0x050505 });
  const white = new THREE.MeshBasicMaterial({ color: 0xf2f2f2 });

  const root = new THREE.Group(); root.name = 'M1911';
  const add = (parent, geo, mat, x = 0, y = 0, z = 0) => { const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); m.castShadow = false; parent.add(m); return m; };

  // ---------------- Frame ----------------
  const frame = new THREE.Group(); root.add(frame);
  add(frame, profile([
    [-0.004, -0.011], [0.165, -0.011], [0.165, -0.0245], [0.032, -0.0245], [0.030, -0.030],
    [-0.0005, -0.118], [-0.047, -0.118], [-0.0165, -0.021], [-0.024, -0.0165], [-0.037, -0.0115],
    [-0.031, -0.0065], [-0.012, -0.0085],
  ], 0.021), steel);
  // trigger guard
  const hole = new THREE.Path();
  hole.moveTo(0.0345, -0.0275); hole.lineTo(0.0745, -0.0275); hole.lineTo(0.0745, -0.045);
  hole.quadraticCurveTo(0.0745, -0.0505, 0.069, -0.0505); hole.lineTo(0.037, -0.0505); hole.lineTo(0.032, -0.040); hole.closePath();
  const tgShape = new THREE.Shape();
  tgShape.moveTo(0.030, -0.024); tgShape.lineTo(0.078, -0.024); tgShape.lineTo(0.078, -0.046);
  tgShape.quadraticCurveTo(0.078, -0.054, 0.070, -0.054); tgShape.lineTo(0.034, -0.054); tgShape.lineTo(0.0275, -0.040); tgShape.closePath();
  tgShape.holes.push(hole);
  const tgGeo = new THREE.ExtrudeGeometry(tgShape, { depth: 0.008, bevelEnabled: true, bevelThickness: 0.0008, bevelSize: 0.0008, bevelSegments: 2, curveSegments: 10 });
  tgGeo.translate(0, 0, -0.004); tgGeo.rotateY(Math.PI / 2);
  add(frame, tgGeo, steel);
  // rails visible under the slide + dust cover recoil-spring plug
  const plug = add(frame, new THREE.CylinderGeometry(0.0062, 0.0062, 0.006, 20), steelDark, 0, -0.0175, -0.211);
  plug.rotation.x = Math.PI / 2;
  // grip panels (wood, checkered)
  const panelGeo = new THREE.BoxGeometry(0.003, 0.074, 0.037);
  for (const sx of [-1, 1]) {
    const p = add(frame, panelGeo, wood, sx * 0.0118, -0.071, 0.0085);
    p.rotation.x = -RAKE;
  }
  // mainspring housing serrations (back strap)
  for (let i = 0; i < 12; i++) {
    const t = i / 11;
    const s = add(frame, new THREE.BoxGeometry(0.018, 0.0012, 0.0016), steelDark, 0, lerp(-0.048, -0.112, t), lerp(0.026, 0.0465, t) + 0.0008);
    s.rotation.x = -RAKE;
  }
  // thumb safety, slide stop, mag release (left side = -X)
  add(frame, new THREE.BoxGeometry(0.0025, 0.0055, 0.019), steel, -0.0118, -0.0135, -0.004);
  add(frame, new THREE.BoxGeometry(0.0025, 0.005, 0.018), steel, -0.0118, -0.0175, -0.062);
  const ssHead = add(frame, new THREE.CylinderGeometry(0.004, 0.004, 0.003, 14), steel, -0.0122, -0.0175, -0.072);
  ssHead.rotation.z = Math.PI / 2;
  const mr = add(frame, new THREE.CylinderGeometry(0.0042, 0.0042, 0.0028, 16), steelDark, -0.0115, -0.034, -0.026);
  mr.rotation.z = Math.PI / 2;
  // pins
  for (const [y, z] of [[-0.012, -0.040], [-0.016, -0.010]]) {
    const pin = add(frame, new THREE.CylinderGeometry(0.0018, 0.0018, 0.0222, 10), steelBright, 0, y, z);
    pin.rotation.z = Math.PI / 2;
  }

  // ---------------- Trigger ----------------
  const trigger = new THREE.Group(); trigger.position.set(0, -0.027, -0.044); frame.add(trigger);
  add(trigger, new THREE.BoxGeometry(0.006, 0.0175, 0.0045), steelBright, 0, -0.0085, 0);

  // ---------------- Hammer ----------------
  const hammer = new THREE.Group(); hammer.position.set(0, -0.0065, 0.006); frame.add(hammer);
  add(hammer, new THREE.BoxGeometry(0.006, 0.016, 0.006), steel, 0, 0.006, 0.0015);
  const spur = add(hammer, new THREE.TorusGeometry(0.0045, 0.0017, 6, 14), steel, 0, 0.0145, 0.004);
  spur.rotation.y = Math.PI / 2;

  // ---------------- Slide ----------------
  const slide = new THREE.Group(); root.add(slide);
  const SW = 0.0235;
  add(slide, profile([[0, -0.011], [0.209, -0.011], [0.209, 0.0125], [0.205, 0.0168], [0.012, 0.0178], [0, 0.0155]], SW, 0.0012), steel);
  // rear cocking serrations
  for (let i = 0; i < 9; i++) {
    for (const sx of [-1, 1]) {
      const s = add(slide, new THREE.BoxGeometry(0.0008, 0.022, 0.0014), steelDark, sx * (SW / 2 + 0.0001), 0.002, -0.009 - i * 0.0036);
      s.rotation.x = -0.12;
    }
  }
  // ejection port (right side) with barrel hood visible inside
  add(slide, new THREE.BoxGeometry(0.0012, 0.011, 0.044), black, SW / 2 + 0.0001, 0.0075, -0.083);
  add(slide, new THREE.BoxGeometry(0.0016, 0.0085, 0.036), steelBright, SW / 2 - 0.0002, 0.0072, -0.086);
  // sights
  add(slide, new THREE.BoxGeometry(0.0034, 0.0055, 0.006), steel, 0, 0.0205, -0.199);
  add(slide, new THREE.CircleGeometry(0.0009, 10), white, 0, 0.021, -0.1959);
  for (const sx of [-1, 1]) add(slide, new THREE.BoxGeometry(0.0055, 0.006, 0.0065), steel, sx * 0.0045, 0.0205, -0.012);
  for (const sx of [-1, 1]) add(slide, new THREE.CircleGeometry(0.0008, 10), white, sx * 0.0043, 0.0215, -0.0087);
  // barrel bushing, barrel, bore
  const bush = add(slide, new THREE.CylinderGeometry(0.0103, 0.0103, 0.006, 24), steel, 0, 0.0005, -0.212);
  bush.rotation.x = Math.PI / 2;
  const barrel = add(slide, new THREE.CylinderGeometry(0.0074, 0.0074, 0.006, 20), steelBright, 0, 0.0005, -0.216);
  barrel.rotation.x = Math.PI / 2;
  const bore = add(slide, new THREE.CircleGeometry(0.0057, 18), black, 0, 0.0005, -0.2191);
  bore.rotation.y = Math.PI; // face forward (-Z)
  // firing pin stop on slide rear
  add(slide, new THREE.BoxGeometry(0.010, 0.016, 0.0012), steelDark, 0, 0.004, 0.0004);

  // ---------------- Magazine ----------------
  const magDir = new THREE.Vector3(0, -Math.cos(RAKE), Math.sin(RAKE)); // direction it drops out
  const magBasePos = new THREE.Vector3(0, -0.026, -0.0105);
  const mag = new THREE.Group(); mag.position.copy(magBasePos); mag.rotation.x = -RAKE; root.add(mag);
  add(mag, new THREE.BoxGeometry(0.0165, 0.094, 0.031), steelDark, 0, -0.047, 0.003);
  add(mag, new THREE.BoxGeometry(0.0205, 0.0055, 0.037), steel, 0, -0.0945, 0.003);
  const round = new THREE.Group(); mag.add(round);
  const caseGeo = new THREE.CylinderGeometry(0.0059, 0.0059, 0.0228, 14);
  const c1 = add(round, caseGeo, brass, 0, -0.004, 0.0035); c1.rotation.x = Math.PI / 2;
  const tip = add(round, new THREE.SphereGeometry(0.0057, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0xb37a4a, metalness: 0.9, roughness: 0.35 }), 0, -0.004, -0.008);
  tip.rotation.x = -Math.PI / 2;
  mag.userData.round = round;

  // ---------------- Attach points ----------------
  const muzzle = new THREE.Object3D(); muzzle.position.set(0, 0.0005, -0.222); slide.add(muzzle);
  const ejectPort = new THREE.Object3D(); ejectPort.position.set(SW / 2 + 0.004, 0.009, -0.085); root.add(ejectPort);

  root.traverse((o) => { if (o.isMesh) { o.castShadow = false; o.receiveShadow = false; } });
  return { root, frame, slide, hammer, trigger, mag, magDir, magBasePos, muzzle, ejectPort, materials: { brass, steel } };
}

function lerp(a, b, t) { return a + (b - a) * t; }

/** A loose .45 ACP case for ejection. */
export function buildCasing(material) {
  const g = new THREE.CylinderGeometry(0.0059, 0.0059, 0.0228, 10);
  g.rotateX(Math.PI / 2);
  return new THREE.Mesh(g, material);
}

/** Muzzle flash sprite texture (cached). */
let flashTex = null;
export function muzzleFlashTexture() {
  if (flashTex) return flashTex;
  flashTex = canvasTexture(128, 128, (g, w, h) => {
    const grd = g.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2);
    grd.addColorStop(0, 'rgba(255,250,220,1)'); grd.addColorStop(0.2, 'rgba(255,200,90,0.9)'); grd.addColorStop(0.5, 'rgba(255,120,30,0.35)'); grd.addColorStop(1, 'rgba(255,80,0,0)');
    g.fillStyle = grd; g.fillRect(0, 0, w, h);
    g.globalCompositeOperation = 'lighter';
    g.translate(w / 2, h / 2);
    for (let i = 0; i < 7; i++) {
      g.rotate((Math.PI * 2) / 7 + Math.random() * 0.3);
      const l = 30 + Math.random() * 30;
      const gg = g.createLinearGradient(0, 0, l, 0); gg.addColorStop(0, 'rgba(255,230,150,0.9)'); gg.addColorStop(1, 'rgba(255,120,20,0)');
      g.fillStyle = gg; g.beginPath(); g.moveTo(0, -4); g.lineTo(l, 0); g.lineTo(0, 4); g.fill();
    }
  });
  return flashTex;
}

let flameTex = null;
/** Elongated flame for the side-on muzzle flash (base at the bottom, tip at the top). */
export function flameTexture() {
  if (flameTex) return flameTex;
  flameTex = canvasTexture(64, 192, (g, w, h) => {
    for (let i = 0; i < 3; i++) {
      const cx = w / 2 + (Math.random() - 0.5) * 8;
      const grd = g.createLinearGradient(0, h, 0, 0);
      grd.addColorStop(0, 'rgba(255,250,225,1)'); grd.addColorStop(0.25, 'rgba(255,205,100,0.9)'); grd.addColorStop(0.6, 'rgba(255,130,40,0.45)'); grd.addColorStop(1, 'rgba(255,90,10,0)');
      g.fillStyle = grd;
      g.beginPath();
      g.moveTo(cx - w * 0.28, h);
      g.quadraticCurveTo(cx - w * 0.36, h * 0.55, cx + (Math.random() - 0.5) * 10, h * (0.02 + Math.random() * 0.2));
      g.quadraticCurveTo(cx + w * 0.36, h * 0.55, cx + w * 0.28, h);
      g.fill();
    }
  });
  return flameTex;
}

let smokeTex = null;
export function smokeTexture() {
  if (smokeTex) return smokeTex;
  smokeTex = canvasTexture(64, 64, (g, w, h) => {
    for (let i = 0; i < 8; i++) {
      const x = w / 2 + (Math.random() - 0.5) * 18, y = h / 2 + (Math.random() - 0.5) * 18, r = 12 + Math.random() * 12;
      const grd = g.createRadialGradient(x, y, 0, x, y, r);
      grd.addColorStop(0, 'rgba(255,255,255,0.35)'); grd.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = grd; g.fillRect(0, 0, w, h);
    }
  });
  return smokeTex;
}
