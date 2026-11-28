import * as THREE from 'three';
import { canvasTexture } from '../core/util.js';
import { BoxBatch, mergeGeometries } from './build.js';

// VS Undead's map: an abandoned cemetery field at night. No headstones: only dead grass, fresh
// dirt mounds where graves used to be marked, bare trees, a broken iron fence and old lanterns,
// all under a low moon and thick fog. The zombies come out of the fog from every side.

const HALF = 38;              // the field is 76 x 76 m
const FOG = 0x0d1117;

let seed = 1;
const rnd = () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; };
const r = (a, b) => a + rnd() * (b - a);

function groundTexture() {
  return canvasTexture(1024, 1024, (g, w, h) => {
    g.fillStyle = '#34331f'; g.fillRect(0, 0, w, h);
    // patches of bare dirt and darker, damp grass
    for (let i = 0; i < 90; i++) {
      const x = Math.random() * w, y = Math.random() * h, rr = 30 + Math.random() * 140;
      const gr = g.createRadialGradient(x, y, 0, x, y, rr);
      const c = Math.random() < 0.5 ? '46,38,28' : Math.random() < 0.5 ? '28,30,20' : '64,58,36';
      gr.addColorStop(0, `rgba(${c},${0.25 + Math.random() * 0.35})`); gr.addColorStop(1, `rgba(${c},0)`);
      g.fillStyle = gr; g.fillRect(x - rr, y - rr, rr * 2, rr * 2);
    }
    // dry blades
    for (let i = 0; i < 9000; i++) {
      const x = Math.random() * w, y = Math.random() * h, l = 3 + Math.random() * 9, a = Math.random() * Math.PI;
      const v = 60 + Math.random() * 60;
      g.strokeStyle = `rgba(${v + 30},${v + 22},${v * 0.55},${0.18 + Math.random() * 0.3})`;
      g.lineWidth = 1 + Math.random();
      g.beginPath(); g.moveTo(x, y); g.lineTo(x + Math.cos(a) * l, y + Math.sin(a) * l); g.stroke();
    }
    const img = g.getImageData(0, 0, w, h), d = img.data;
    for (let i = 0; i < d.length; i += 4) { const n = (Math.random() - 0.5) * 14; d[i] += n; d[i + 1] += n; d[i + 2] += n; }
    g.putImageData(img, 0, 0);
  }, { repeat: true });
}

function tuftTexture() {
  return canvasTexture(128, 128, (g, w, h) => {
    g.clearRect(0, 0, w, h);
    for (let i = 0; i < 26; i++) {
      const x0 = w * (0.2 + Math.random() * 0.6), lean = (Math.random() - 0.5) * 60, top = h * (0.05 + Math.random() * 0.45);
      const v = 70 + Math.random() * 70;
      g.strokeStyle = `rgb(${v + 35},${v + 24},${v * 0.5})`;
      g.lineWidth = 2 + Math.random() * 2;
      g.beginPath(); g.moveTo(x0, h); g.quadraticCurveTo(x0 + lean * 0.3, (h + top) / 2, x0 + lean, top); g.stroke();
    }
  });
}

function mistTexture() {
  return canvasTexture(256, 256, (g, w, h) => {
    g.clearRect(0, 0, w, h);
    for (let i = 0; i < 40; i++) {
      const x = w * (0.15 + Math.random() * 0.7), y = h * (0.15 + Math.random() * 0.7), rr = 20 + Math.random() * 60;
      const gr = g.createRadialGradient(x, y, 0, x, y, rr);
      gr.addColorStop(0, `rgba(170,185,200,${0.05 + Math.random() * 0.08})`); gr.addColorStop(1, 'rgba(170,185,200,0)');
      g.fillStyle = gr; g.fillRect(0, 0, w, h);
    }
  });
}

function moonTexture() {
  return canvasTexture(256, 256, (g, w, h) => {
    const gr = g.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2);
    gr.addColorStop(0, 'rgba(235,240,255,1)'); gr.addColorStop(0.16, 'rgba(220,228,245,1)'); gr.addColorStop(0.2, 'rgba(150,170,210,0.35)');
    gr.addColorStop(0.5, 'rgba(90,110,150,0.08)'); gr.addColorStop(1, 'rgba(60,80,120,0)');
    g.fillStyle = gr; g.fillRect(0, 0, w, h);
    g.fillStyle = 'rgba(160,170,190,0.35)';
    for (const [x, y, rr] of [[118, 120, 9], [138, 136, 6], [126, 142, 4], [140, 116, 5]]) { g.beginPath(); g.arc(x, y, rr, 0, Math.PI * 2); g.fill(); }
  });
}

/** A bare tree: a leaning trunk that forks into crooked branches (one merged mesh). */
function treeGeometry(h, rad) {
  const items = [];
  const up = new THREE.Vector3(0, 1, 0);
  const limb = (from, dir, len, r0, depth) => {
    const geo = new THREE.CylinderGeometry(r0 * 0.62, r0, len, 6, 1);
    geo.translate(0, len / 2, 0);
    const q = new THREE.Quaternion().setFromUnitVectors(up, dir.clone().normalize());
    items.push({ geo, matrix: new THREE.Matrix4().compose(from, q, new THREE.Vector3(1, 1, 1)) });
    if (depth <= 0) return;
    const end = from.clone().addScaledVector(dir.clone().normalize(), len);
    const n = depth === 2 ? 3 + Math.floor(rnd() * 2) : 2;
    for (let i = 0; i < n; i++) {
      const d = dir.clone().normalize().add(new THREE.Vector3(r(-1, 1), r(-0.1, 0.5), r(-1, 1)).multiplyScalar(0.9)).normalize();
      const at = depth === 2 ? from.clone().lerp(end, r(0.55, 1)) : end;
      limb(at, d, len * r(0.45, 0.7), r0 * 0.55, depth - 1);
    }
  };
  limb(new THREE.Vector3(0, -0.2, 0), new THREE.Vector3(r(-0.12, 0.12), 1, r(-0.12, 0.12)), h, rad, 2);
  return mergeGeometries(items);
}

export const CEMETERY = {
  id: 'cemetery',
  name: 'Dead Field',
  desc: 'An abandoned cemetery field at night, in thick fog.',
  hidden: true,                 // VS Undead only: not in the Maps list
  sky: FOG,
  fog: [5, 46],
  far: 160,
  bounds: HALF,
  wallHeight: 20,
  sun: 0.5, sunColor: 0x8ea4d6, sunDir: [-30, 48, -22],
  hemi: 0.55, hemiSky: 0x40506e, hemiGround: 0x1c1d17, env: 0.1,
  playerSpawn: { pos: [0, 0, 6], yaw: 0 },
  ragdollSpawn: { pos: [0, 0, -30], yaw: 0 },
  merchantSpot: { pos: [0, 0, -5], yaw: 0 },
  noRagdoll: true,
  buttons: [],

  build(map) {
    seed = 7;
    const add = (o) => map.add(o);
    // ground
    const tex = groundTexture();
    tex.repeat.set(200 / 7, 200 / 7);
    const groundMat = new THREE.MeshStandardMaterial({ map: tex, roughness: 1, metalness: 0, color: 0xb4b0a0 });
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(200, 200), groundMat);
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    floor.userData.surface = 'dirt';
    add(floor);
    map.floor = floor;
    map.solidMeshes.push(floor);

    // dry grass tufts (one instanced draw)
    const tuftMat = new THREE.MeshStandardMaterial({ map: tuftTexture(), alphaTest: 0.45, side: THREE.DoubleSide, roughness: 1, color: 0x9c927a });
    const planes = [];
    for (let i = 0; i < 3; i++) planes.push({ geo: new THREE.PlaneGeometry(0.7, 0.5).translate(0, 0.25, 0), matrix: new THREE.Matrix4().makeRotationY((i / 3) * Math.PI) });
    const tuftGeo = mergeGeometries(planes);
    const N = 2600;
    const tufts = new THREE.InstancedMesh(tuftGeo, tuftMat, N);
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3();
    for (let i = 0; i < N; i++) {
      p.set(r(-HALF - 6, HALF + 6), 0, r(-HALF - 6, HALF + 6));
      q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), r(0, Math.PI));
      const k = r(0.6, 1.5);
      s.set(k, k * r(0.7, 1.3), k);
      tufts.setMatrixAt(i, m4.compose(p, q, s));
    }
    tufts.frustumCulled = false;
    add(tufts);

    // fresh dirt mounds where the graves are (no stones: whatever marked them is long gone)
    const dirtMat = new THREE.MeshStandardMaterial({ color: 0x3a2e22, roughness: 1 });
    const mounds = [];
    const moundGeo = new THREE.SphereGeometry(1, 10, 6, 0, Math.PI * 2, 0, Math.PI / 2);
    for (let row = -3; row <= 3; row++) {
      for (let col = -4; col <= 4; col++) {
        if (rnd() < 0.35) continue;
        const x = col * 6.5 + r(-1.2, 1.2), z = row * 8 + r(-1.5, 1.5);
        if (Math.hypot(x, z) < 9) continue;
        const yaw = r(-0.25, 0.25);
        mounds.push({ geo: moundGeo, matrix: new THREE.Matrix4().compose(new THREE.Vector3(x, -0.02, z), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw), new THREE.Vector3(0.55, r(0.18, 0.3), 1.05)) });
      }
    }
    const moundMesh = new THREE.Mesh(mergeGeometries(mounds), dirtMat);
    moundMesh.receiveShadow = true;
    add(moundMesh);

    // bare trees (trunks block you, bullets and bodies)
    const bark = new THREE.MeshStandardMaterial({ color: 0x2b241f, roughness: 0.95 });
    const proxy = map.cluster();
    const trees = [];
    for (let i = 0; i < 18; i++) {
      let x, z, tries = 0;
      do { x = r(-HALF + 3, HALF - 3); z = r(-HALF + 3, HALF - 3); tries++; } while ((Math.hypot(x, z) < 12 || trees.some((t) => Math.hypot(t[0] - x, t[1] - z) < 7)) && tries < 40);
      const h = r(4, 7.5), rad = r(0.2, 0.36);
      trees.push([x, z]);
      const mesh = new THREE.Mesh(treeGeometry(h, rad), bark);
      mesh.position.set(x, 0, z);
      mesh.rotation.y = r(0, Math.PI * 2);
      mesh.castShadow = true; mesh.receiveShadow = true;
      add(mesh);
      map.solid(x, 1.6, z, rad * 1.7, 3.2, rad * 1.7, { proxy, surface: 'wood', body: 'trees' });
    }

    // broken wrought-iron fence round the field, with gaps
    const iron = new THREE.MeshStandardMaterial({ color: 0x1a1b1d, roughness: 0.6, metalness: 0.6 });
    const B = new BoxBatch();
    const side = (ax, fixed, along) => {
      for (let t = -HALF; t < HALF; t += 2.4) {
        if (rnd() < 0.14) continue;              // a section gone
        const sag = rnd() < 0.2 ? r(0.15, 0.4) : 0;
        const at = (u, y, w, h, d) => (along === 'x' ? B.add(iron, u, y, fixed, w, h, d) : B.add(iron, fixed, y, u, d, h, w));
        at(t, 0.9, 0.09, 1.8, 0.09);
        at(t + 1.2, 1.45 - sag, 2.4, 0.04, 0.04);
        at(t + 1.2, 0.35, 2.4, 0.04, 0.04);
        for (let b = 0.2; b < 2.4; b += 0.2) {
          if (rnd() < 0.12) continue;
          const hh = rnd() < 0.15 ? r(0.5, 1.2) : 1.55 - sag * (1 - Math.abs(b - 1.2) / 1.2);
          at(t + b, hh / 2, 0.022, hh, 0.022);
          at(t + b, hh + 0.04, 0.04, 0.08, 0.04);
        }
      }
    };
    side('x', -HALF, 'x'); side('x', HALF, 'x'); side('z', -HALF, 'z'); side('z', HALF, 'z');
    for (const m of B.build()) add(m);

    // old lantern posts (the only warm light out here)
    const wood = new THREE.MeshStandardMaterial({ color: 0x3b2c1e, roughness: 0.9 });
    const glassMat = new THREE.MeshStandardMaterial({ color: 0xffc070, emissive: 0xff9a3a, emissiveIntensity: 2.2, roughness: 0.4 });
    const LB = new BoxBatch();
    const lights = [];
    for (const [x, z] of [[-9, 4], [10, -8], [-6, -16]]) {
      LB.add(wood, x, 1.3, z, 0.12, 2.6, 0.12);
      LB.add(wood, x + 0.25, 2.55, z, 0.55, 0.08, 0.08);
      LB.add(iron, x + 0.48, 2.36, z, 0.16, 0.04, 0.16);
      LB.add(glassMat, x + 0.48, 2.22, z, 0.12, 0.2, 0.12);
      LB.add(iron, x + 0.48, 2.09, z, 0.16, 0.04, 0.16);
      map.solid(x, 1.3, z, 0.2, 2.6, 0.2, { proxy, surface: 'wood', body: 'posts' });
      const L = new THREE.PointLight(0xff9a44, 6, 13, 1.6);
      L.position.set(x + 0.48, 2.2, z);
      L.userData.base = 6; L.userData.ph = rnd() * 10;
      add(L); lights.push(L);
    }
    for (const m of LB.build()) add(m);

    // ground mist: slow, drifting sheets of fog
    const mistTex = mistTexture();
    const mists = [];
    for (let i = 0; i < 9; i++) {
      const mat = new THREE.MeshBasicMaterial({ map: mistTex, transparent: true, depthWrite: false, opacity: 0.55, color: 0x8e9cb0 });
      const m = new THREE.Mesh(new THREE.PlaneGeometry(26, 26), mat);
      m.rotation.x = -Math.PI / 2;
      m.rotation.z = r(0, Math.PI * 2);
      m.position.set(r(-HALF, HALF), r(0.25, 1.1), r(-HALF, HALF));
      m.renderOrder = 3;
      m.userData.v = new THREE.Vector2(r(-0.35, 0.35), r(-0.35, 0.35));
      add(m); mists.push(m);
    }

    // the moon, low over the trees
    const moon = new THREE.Sprite(new THREE.SpriteMaterial({ map: moonTexture(), fog: false, depthWrite: false, transparent: true }));
    moon.scale.setScalar(42);
    moon.renderOrder = -1;
    add(moon);

    let t = 0;
    map.updaters.push((dt, focus) => {
      t += dt;
      for (const L of lights) L.intensity = L.userData.base * (0.85 + 0.15 * Math.sin(t * 9 + L.userData.ph) * Math.sin(t * 3.3 + L.userData.ph * 2));
      for (const m of mists) {
        m.position.x += m.userData.v.x * dt; m.position.z += m.userData.v.y * dt;
        if (m.position.x > HALF + 8) m.position.x = -HALF - 8; else if (m.position.x < -HALF - 8) m.position.x = HALF + 8;
        if (m.position.z > HALF + 8) m.position.z = -HALF - 8; else if (m.position.z < -HALF - 8) m.position.z = HALF + 8;
      }
      if (focus) moon.position.set(focus.x - 70, 46, focus.z - 60);
    });
  },
};
