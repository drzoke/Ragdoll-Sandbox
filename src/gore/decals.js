import * as THREE from 'three';
import { canvasTexture, rand } from '../core/util.js';

// ---------------------------------------------------------------- textures
function blobTexture(irregular = 1) {
  return canvasTexture(256, 256, (g, w, h) => {
    g.translate(w / 2, h / 2);
    const lobes = 9 + ((Math.random() * 6) | 0);
    const base = w * 0.3;
    // main blob
    g.beginPath();
    for (let i = 0; i <= 64; i++) {
      const a = (i / 64) * Math.PI * 2;
      let r = base;
      for (let k = 1; k <= 3; k++) r += Math.sin(a * (lobes / k) + k * 1.7) * base * 0.07 * irregular;
      const x = Math.cos(a) * r, y = Math.sin(a) * r;
      i ? g.lineTo(x, y) : g.moveTo(x, y);
    }
    const grd = g.createRadialGradient(0, 0, 0, 0, 0, base * 1.2);
    grd.addColorStop(0, 'rgba(255,255,255,1)'); grd.addColorStop(0.85, 'rgba(235,235,235,1)'); grd.addColorStop(1, 'rgba(255,255,255,0.8)');
    g.fillStyle = grd; g.fill();
    // satellite droplets
    for (let i = 0; i < 18 * irregular; i++) {
      const a = Math.random() * Math.PI * 2, d = base * (1.0 + Math.random() * 0.55), r = 2 + Math.random() * 7;
      g.beginPath(); g.arc(Math.cos(a) * d, Math.sin(a) * d, r, 0, Math.PI * 2); g.fill();
    }
  }, { srgb: false });
}

function woundTexture(exit) {
  return canvasTexture(128, 128, (g, w, h) => {
    g.translate(w / 2, h / 2);
    const R = w * 0.46;
    // bruise/blood ring
    let grd = g.createRadialGradient(0, 0, 0, 0, 0, R);
    grd.addColorStop(0, 'rgba(20,20,20,1)'); grd.addColorStop(exit ? 0.35 : 0.22, 'rgba(40,40,40,1)');
    grd.addColorStop(exit ? 0.55 : 0.4, 'rgba(120,120,120,0.95)'); grd.addColorStop(0.8, 'rgba(110,110,110,0.45)'); grd.addColorStop(1, 'rgba(100,100,100,0)');
    g.fillStyle = grd; g.beginPath();
    for (let i = 0; i <= 40; i++) {
      const a = (i / 40) * Math.PI * 2, r = R * (exit ? 0.75 + Math.random() * 0.25 : 0.9 + Math.random() * 0.1);
      i ? g.lineTo(Math.cos(a) * r, Math.sin(a) * r) : g.moveTo(Math.cos(a) * r, Math.sin(a) * r);
    }
    g.fill();
    // hole
    g.fillStyle = '#080808'; g.beginPath(); g.arc(0, 0, exit ? R * 0.28 : R * 0.16, 0, Math.PI * 2); g.fill();
  });
}

function stainTexture() {
  return canvasTexture(128, 256, (g, w, h) => {
    // a run of blood downward from the top-centre
    const grd = g.createLinearGradient(0, 0, 0, h);
    grd.addColorStop(0, 'rgba(110,110,110,0.9)'); grd.addColorStop(0.7, 'rgba(90,90,90,0.6)'); grd.addColorStop(1, 'rgba(90,90,90,0)');
    g.fillStyle = grd;
    for (let i = 0; i < 5; i++) {
      const x = w / 2 + (Math.random() - 0.5) * w * 0.5, ww = 6 + Math.random() * 12, len = h * (0.4 + Math.random() * 0.6);
      g.beginPath(); g.ellipse(x, len / 2, ww / 2, len / 2, 0, 0, Math.PI * 2); g.fill();
    }
    const r = g.createRadialGradient(w / 2, h * 0.12, 0, w / 2, h * 0.12, w * 0.45);
    r.addColorStop(0, 'rgba(110,110,110,0.9)'); r.addColorStop(1, 'rgba(110,110,110,0)');
    g.fillStyle = r; g.fillRect(0, 0, w, h);
  });
}

function holeTexture() {
  return canvasTexture(64, 64, (g, w, h) => {
    const grd = g.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2);
    grd.addColorStop(0, 'rgba(10,10,10,1)'); grd.addColorStop(0.25, 'rgba(25,25,25,1)'); grd.addColorStop(0.45, 'rgba(60,60,60,0.7)'); grd.addColorStop(1, 'rgba(80,80,80,0)');
    g.fillStyle = grd; g.fillRect(0, 0, w, h);
  });
}

const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _s = new THREE.Vector3(), _p = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0), Zf = new THREE.Vector3(0, 0, 1);

/** Floor pools/splats (instanced) + bullet holes (instanced) + body wound decals. */
export class Decals {
  constructor(scene, maxPools, maxHoles) {
    this.scene = scene;
    // ---- blood pools ----
    this.poolTex = [blobTexture(1), blobTexture(1.6)];
    this.poolMeshes = this.poolTex.map((t) => {
      const m = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({
        color: 0xffffff, alphaMap: t, transparent: true, depthWrite: false, roughness: 0.32, metalness: 0.0, envMapIntensity: 0.5,
        polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
      }), maxPools);
      m.count = 0; m.receiveShadow = true; m.frustumCulled = false;
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      scene.add(m);
      return m;
    });
    this.pools = [];
    this.maxPools = maxPools;
    this.poolDirty = true;

    // ---- bullet holes ----
    this.holes = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({
      map: holeTexture(), transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4,
    }), maxHoles);
    this.holes.count = 0; this.holes.frustumCulled = false;
    scene.add(this.holes);
    this.holeIndex = 0; this.maxHoles = maxHoles;

    // ---- body wounds ----
    this.woundMat = [woundTexture(false), woundTexture(true)].map((t) => new THREE.MeshStandardMaterial({
      map: t, transparent: true, depthWrite: false, roughness: 0.3, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4,
    }));
    this.stainMat = new THREE.MeshStandardMaterial({ map: stainTexture(), transparent: true, depthWrite: false, roughness: 0.35, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 });
    this.poolHue = [1, 0.03, 0.03];
    this.woundGeo = new THREE.PlaneGeometry(1, 1);
    this.stainGeo = new THREE.PlaneGeometry(1, 2).translate(0, -0.8, 0);
  }

  // ---------------------------------------------------------------- pools
  addDrop(x, y, z, volume, size) {
    // merge into a nearby pool if there is one
    let best = null, bestD = Infinity;
    for (const p of this.pools) {
      if (Math.abs(p.y - y) > 0.05) continue;
      const d = Math.hypot(p.x - x, p.z - z);
      if (d < p.r * 0.85 + 0.05 && d < bestD) { best = p; bestD = d; }
    }
    if (best && best.r < 1.4) {
      best.volume += volume;
      best.target = Math.min(1.6, 0.06 * Math.sqrt(best.volume));
      // pool drifts slightly towards new drops
      best.x += (x - best.x) * 0.02; best.z += (z - best.z) * 0.02;
      this.poolDirty = true;
      return;
    }
    const r = Math.max(0.025, size * (1.5 + Math.random() * 1.5));
    const pool = { x, y: y + 0.0015 + Math.random() * 0.001, z, r: r * 0.4, target: r, volume: Math.max(volume, (r / 0.06) ** 2), rot: Math.random() * Math.PI * 2, sx: rand(0.8, 1.25), age: 0, type: Math.random() < 0.6 ? 0 : 1 };
    if (this.pools.length >= this.maxPools) this.pools.shift();
    this.pools.push(pool);
    this.poolDirty = true;
  }

  updatePools(dt) {
    let growing = false;
    for (const p of this.pools) {
      p.age += dt;
      if (p.r < p.target) { p.r = Math.min(p.target, p.r + dt * (0.05 + (p.target - p.r) * 2.5)); growing = true; }
    }
    if (!growing && !this.poolDirty) return;
    this.poolDirty = false;
    const counts = [0, 0];
    const color = new THREE.Color();
    for (const p of this.pools) {
      const mesh = this.poolMeshes[p.type];
      const i = counts[p.type]++;
      _q.setFromAxisAngle(UP, p.rot);
      _s.set(p.r * 2 * p.sx, 1, p.r * 2 / p.sx);
      _m.compose(_p.set(p.x, p.y, p.z), _q, _s);
      mesh.setMatrixAt(i, _m);
      // fresh blood bright red, older pools darker
      const k = Math.min(1, p.age / 90);
      const v = 0.2 - 0.1 * k, hue = this.poolHue;
      color.setRGB(v * hue[0], v * hue[1], v * hue[2]);
      mesh.setColorAt(i, color);
    }
    this.poolMeshes.forEach((m, t) => { m.count = counts[t]; m.instanceMatrix.needsUpdate = true; if (m.instanceColor) m.instanceColor.needsUpdate = true; });
  }

  /** Blood colour setting: decal hue multiplies the grayscale wound/stain textures. */
  setBloodTint(blood) {
    this.poolHue = blood.pool;
    for (const m of [...this.woundMat, this.stainMat]) m.color.setRGB(...blood.decal);
    this.poolDirty = true;
  }

  // ---------------------------------------------------------------- bullet holes
  addHole(point, normal) {
    const i = this.holeIndex++ % this.maxHoles;
    _q.setFromUnitVectors(Zf, normal);
    const s = 0.035 + Math.random() * 0.015;
    _m.compose(_p.copy(point).addScaledVector(normal, 0.002), _q, _s.set(s, s, s));
    this.holes.setMatrixAt(i, _m);
    this.holes.count = Math.min(this.maxHoles, this.holes.count + 1);
    this.holes.instanceMatrix.needsUpdate = true;
  }

  // ---------------------------------------------------------------- body wounds
  /** Adds a wound decal to a body-part group, in that part's local space. Returns the decal. */
  addWound(group, localPoint, localNormal, exit, size = 0.03) {
    const m = new THREE.Mesh(this.woundGeo, this.woundMat[exit ? 1 : 0]);
    m.position.copy(localPoint).addScaledVector(localNormal, 0.0015);
    m.quaternion.setFromUnitVectors(Zf, localNormal);
    m.rotateZ(Math.random() * Math.PI * 2);
    m.scale.setScalar(size * (exit ? 1.6 : 1));
    m.userData.decal = true;
    group.add(m);
    // blood run stain (grows as the wound bleeds)
    const st = new THREE.Mesh(this.stainGeo, this.stainMat);
    st.position.copy(m.position).addScaledVector(localNormal, 0.0005);
    st.quaternion.setFromUnitVectors(Zf, localNormal);
    st.scale.setScalar(0.001);
    st.userData.decal = true;
    group.add(st);
    return { decal: m, stain: st, stainSize: 0 };
  }

  clear() {
    this.pools = []; this.poolDirty = true;
    this.updatePools(0);
    this.holes.count = 0; this.holeIndex = 0;
  }
}
