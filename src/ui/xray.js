import * as THREE from 'three';
import { ANATOMY } from '../ragdoll/anatomy.js';
import { PARTS } from '../ragdoll/skeleton.js';
import { settings } from '../settings.js';
import { clamp, lerp } from '../core/util.js';

export const XRAY_LAYER = 1;

const shellMat = new THREE.ShaderMaterial({
  uniforms: { color: { value: new THREE.Color(0x4fb4ff) } },
  vertexShader: /* glsl */`
    varying float vF;
    void main() {
      vec4 mv = modelViewMatrix * vec4(position, 1.0);
      vec3 n = normalize(normalMatrix * normal);
      vF = 1.0 - abs(dot(n, normalize(-mv.xyz)));
      gl_Position = projectionMatrix * mv;
    }`,
  fragmentShader: /* glsl */`
    uniform vec3 color; varying float vF;
    void main() { gl_FragColor = vec4(color * (0.08 + pow(vF, 2.2) * 0.9), 1.0); }`,
  transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
});

function onLayer(obj) { obj.traverse((o) => o.layers.set(XRAY_LAYER)); return obj; }

function capsuleBetween(a, b, r, mat) {
  const A = new THREE.Vector3(...a), B = new THREE.Vector3(...b);
  const len = A.distanceTo(B);
  const m = new THREE.Mesh(new THREE.CapsuleGeometry(r, Math.max(0.001, len), 4, 10), mat);
  m.position.copy(A).add(B).multiplyScalar(0.5);
  m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), B.clone().sub(A).normalize());
  return m;
}

// Damage colours shared by both x-ray modes.
const C_BONE = new THREE.Color(0xe8f2ff), C_WARN = new THREE.Color(0xffb020), C_BAD = new THREE.Color(0xff2a1a);
function boneColor(bone, flash, out = new THREE.Color()) {
  const k = 1 - bone.integrity / 100;
  out.copy(C_BONE).lerp(C_WARN, clamp(k * 1.8)).lerp(C_BAD, clamp((k - 0.45) * 2));
  if (bone.fractured) out.lerp(C_BAD, flash * 0.6);
  return out;
}
function organColor(organ, base, flash, out = new THREE.Color()) {
  const k = organ.hp / organ.maxHp;
  out.copy(base).multiplyScalar(lerp(0.35, 1, k));
  if (k < 1) out.lerp(new THREE.Color(0xff1010), (1 - k) * (0.4 + 0.5 * flash));
  if (k <= 0) out.setRGB(0.25, 0.05, 0.05).lerp(new THREE.Color(0xff0000), flash * 0.5);
  return out;
}
const css = (c, a = 1) => `rgba(${Math.round(clamp(c.r) * 255)},${Math.round(clamp(c.g) * 255)},${Math.round(clamp(c.b) * 255)},${a})`;

/**
 * Builds x-ray visuals (on a separate render layer) for a ragdoll and keeps their colours in sync
 * with the damage model. Rendered by its own small renderer into the HUD panel.
 */
export class XRayRig {
  constructor(ragdoll) {
    this.r = ragdoll;
    this.boneMeshes = {};   // bone id -> [meshes]
    this.organMeshes = {};
    this.vesselMeshes = {};
    this.woundCount = 0;
    this.markers = [];
    for (const [name, p] of Object.entries(ragdoll.parts)) {
      const g = new THREE.Group();
      p.group.add(g);
      p.xray = g;
      const shell = new THREE.Mesh(p.mesh.geometry, shellMat);
      shell.renderOrder = 10;
      g.add(shell);
      if (p.ball) { const b = new THREE.Mesh(p.ball.geometry, shellMat); b.position.copy(p.ball.position); b.renderOrder = 10; g.add(b); }

      const anat = ANATOMY[name];
      for (const bone of anat.bones) {
        const mat = new THREE.MeshBasicMaterial({ color: 0xe8f2ff, transparent: true, opacity: 0.85, fog: false });
        const meshes = [];
        if (!bone.shell) meshes.push(capsuleBetween(bone.a, bone.b, bone.r, mat));
        else if (bone.id === 'skull') {
          const s = new THREE.Mesh(new THREE.SphereGeometry(0.092, 18, 14), mat.clone()); s.material.opacity = 0.32; meshes.push(s);
          const jaw = new THREE.Mesh(new THREE.TorusGeometry(0.05, 0.008, 6, 16, Math.PI), mat); jaw.position.set(0, -0.055, 0.03); jaw.rotation.set(Math.PI / 2 + 0.3, 0, Math.PI); meshes.push(jaw);
          for (const sx of [-1, 1]) { const eye = new THREE.Mesh(new THREE.TorusGeometry(0.016, 0.004, 5, 12), mat); eye.position.set(sx * 0.032, 0.01, 0.085); meshes.push(eye); }
        } else if (bone.id === 'ribs') {
          for (let i = 0; i < 6; i++) {
            const rib = new THREE.Mesh(new THREE.TorusGeometry(0.15 - Math.abs(i - 2) * 0.008, 0.006, 5, 24), mat);
            rib.scale.set(1, 0.62, 1); rib.rotation.x = Math.PI / 2 - 0.25; rib.position.set(0, 0.1 - i * 0.04, -0.01);
            meshes.push(rib);
          }
          const sternum = new THREE.Mesh(new THREE.BoxGeometry(0.025, 0.16, 0.01), mat); sternum.position.set(0, 0.03, 0.09); meshes.push(sternum);
          for (const sx of [-1, 1]) { const cl = capsuleBetween([sx * 0.02, 0.12, 0.07], [sx * 0.17, 0.12, 0.0], 0.007, mat); meshes.push(cl); }
        } else if (bone.id === 'pelvisBone') {
          for (const sx of [-1, 1]) {
            const wing = new THREE.Mesh(new THREE.TorusGeometry(0.06, 0.012, 6, 14, Math.PI * 1.3), mat);
            wing.position.set(sx * 0.07, 0.01, 0); wing.rotation.set(0, sx * 0.6, sx * 0.4 + Math.PI * 0.85);
            meshes.push(wing);
          }
          const sac = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.08, 0.03), mat); sac.position.set(0, 0, -0.07); meshes.push(sac);
        }
        meshes.forEach((m) => g.add(m));
        this.boneMeshes[bone.id] = { meshes, mat: meshes.map((m) => m.material) };
      }
      for (const og of anat.organs) {
        const mat = new THREE.MeshBasicMaterial({ color: og.color, transparent: true, opacity: 0.9, fog: false });
        const m = new THREE.Mesh(new THREE.SphereGeometry(1, 16, 12), mat);
        m.scale.set(...og.r); m.position.set(...og.c);
        g.add(m);
        this.organMeshes[og.id] = { mesh: m, mat, base: new THREE.Color(og.color) };
      }
      for (const v of anat.vessels) {
        const mat = new THREE.MeshBasicMaterial({ color: 0xd03040, transparent: true, opacity: 0.8, fog: false });
        const m = capsuleBetween(v.a, v.b, v.r * 0.6, mat);
        g.add(m);
        this.vesselMeshes[v.id] = { mesh: m, mat };
      }
      onLayer(g);
    }
  }

  update(time) {
    const h = this.r.health;
    const flash = 0.5 + 0.5 * Math.sin(time * 10);
    const c = new THREE.Color();
    for (const [id, b] of Object.entries(this.boneMeshes)) {
      boneColor(h.bones[id], flash, c);
      for (const m of b.mat) m.color.copy(c);
    }
    for (const [id, o] of Object.entries(this.organMeshes)) o.mat.color.copy(organColor(h.organs[id], o.base, flash, c));
    for (const [id, v] of Object.entries(this.vesselMeshes)) {
      const cut = h.vessels[id].cut;
      v.mat.color.setHex(cut ? 0xff2020 : 0xa02838);
      v.mat.opacity = cut ? 0.5 + 0.5 * flash : 0.6;
    }
    // wound markers
    while (this.woundCount < h.wounds.length) {
      const w = h.wounds[this.woundCount++];
      const part = this.r.parts[w.part];
      if (!part) continue;
      const m = new THREE.Mesh(new THREE.SphereGeometry(w.stump ? 0.03 : 0.012, 10, 8), new THREE.MeshBasicMaterial({ color: 0xff3020, fog: false, depthTest: false, transparent: true }));
      m.renderOrder = 20;
      if (w.stump) { const child = Object.values(this.r.parts).find((p) => p.def.joint?.name === w.joint); m.position.copy(child.pivotParent); }
      else if (w.pos) m.position.copy(w.pos);
      else m.scale.setScalar(w.burst ? 4 : 1.5); // burst / blunt trauma: whole part
      m.layers.set(XRAY_LAYER);
      part.group.add(m);
      this.markers.push({ m, w });
    }
    for (const { m, w } of this.markers) m.material.opacity = 0.35 + 0.65 * clamp(w.rate / 3) * flash + 0.2;
  }
}

/**
 * Flat x-ray: a still, front-on diagram of the skeleton and organs (like an x-ray film), drawn
 * on a 2D canvas from the anatomy data. Shows the same damage as the 3D view.
 */
export class FlatXRay {
  constructor(container) {
    this.canvas = document.createElement('canvas');
    this.canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;display:none;';
    container.prepend(this.canvas);
    this.ctx = this.canvas.getContext('2d');
    this.timer = 0;
    this.base = {};
    for (const a of Object.values(ANATOMY)) for (const o of a.organs) this.base[o.id] = new THREE.Color(o.color);
  }

  show(on) { this.canvas.style.display = on ? 'block' : 'none'; }

  draw(ragdoll, dt) {
    this.timer -= dt;
    if (this.timer > 0) return;
    this.timer = 0.1; // ~10 redraws a second is plenty for a still diagram
    const cv = this.canvas, dpr = Math.min(devicePixelRatio, 2);
    const W = Math.max(1, Math.round(cv.clientWidth * dpr)), H = Math.max(1, Math.round(cv.clientHeight * dpr));
    if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; }
    const g = this.ctx;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, W, H);
    // film background + grid
    const bg = g.createRadialGradient(W / 2, H * 0.45, 0, W / 2, H * 0.45, Math.max(W, H) * 0.7);
    bg.addColorStop(0, 'rgba(18,40,64,0.92)'); bg.addColorStop(1, 'rgba(4,10,18,0.92)');
    g.fillStyle = bg; g.fillRect(0, 0, W, H);
    g.strokeStyle = 'rgba(90,170,255,0.07)'; g.lineWidth = 1;
    const step = 16 * dpr;
    for (let x = (W / 2) % step; x < W; x += step) { g.beginPath(); g.moveTo(x, 0); g.lineTo(x, H); g.stroke(); }
    for (let y = H % step; y < H; y += step) { g.beginPath(); g.moveTo(0, y); g.lineTo(W, y); g.stroke(); }
    g.fillStyle = 'rgba(150,200,255,0.55)'; g.font = `${10 * dpr}px system-ui, sans-serif`;
    g.textAlign = 'left'; g.fillText('FLAT · FRONT', 8 * dpr, 14 * dpr);
    if (!ragdoll) { g.textAlign = 'center'; g.fillText('No target', W / 2, H / 2); return; }
    g.textAlign = 'center';
    g.fillText('R', W * 0.1, H * 0.5); g.fillText('L', W * 0.9, H * 0.5); // the ragdoll's own right / left

    const h = ragdoll.health;
    const time = performance.now() / 1000;
    const flash = 0.5 + 0.5 * Math.sin(time * 10);
    // fit 1.9 m of body into the panel (the ECG strip covers the bottom)
    const s = Math.min(H * 0.8 / 1.9, W * 0.92 / 1.1);
    const cx = W / 2, floor = H * 0.86;
    const X = (x) => cx + x * s, Y = (y) => floor - y * s;
    const col = new THREE.Color();

    // silhouette (tinted by tissue damage), severed parts dashed
    for (const def of PARTS) {
      const hp = h.parts[def.name];
      const gone = !hp.attached || ragdoll.parts[def.name].removed;
      const k = hp.tissue / hp.maxTissue;
      col.setRGB(0.31, 0.7, 1).lerp(new THREE.Color(1, 0.55, 0.15), clamp((1 - k) * 1.5)).lerp(new THREE.Color(1, 0.15, 0.1), clamp((0.4 - k) * 2.5));
      g.setLineDash(gone ? [4 * dpr, 4 * dpr] : []);
      g.strokeStyle = gone ? 'rgba(255,90,80,0.55)' : css(col, 0.75);
      g.fillStyle = gone ? 'rgba(255,60,50,0.05)' : css(col, 0.09);
      g.lineWidth = 1.3 * dpr;
      g.beginPath();
      if (def.shape === 'sphere') g.arc(X(def.pos[0]), Y(def.pos[1]), def.size[0] * s, 0, Math.PI * 2);
      else roundRect(g, X(def.pos[0] - def.size[0] / 2), Y(def.pos[1] + def.size[1] / 2), def.size[0] * s, def.size[1] * s, Math.min(def.size[0], def.size[1]) * s * 0.3);
      g.fill(); g.stroke();
      if (hp.exploded) {
        g.setLineDash([]); g.strokeStyle = 'rgba(255,80,60,0.8)'; g.lineWidth = 2 * dpr;
        const r = (def.shape === 'sphere' ? def.size[0] : Math.min(def.size[0], def.size[1]) / 2) * s * 0.7;
        g.beginPath(); g.moveTo(X(def.pos[0]) - r, Y(def.pos[1]) - r); g.lineTo(X(def.pos[0]) + r, Y(def.pos[1]) + r);
        g.moveTo(X(def.pos[0]) + r, Y(def.pos[1]) - r); g.lineTo(X(def.pos[0]) - r, Y(def.pos[1]) + r); g.stroke();
      }
    }
    g.setLineDash([]);

    // organs (behind the bones)
    for (const def of PARTS) {
      const a = ANATOMY[def.name], gone = !h.parts[def.name].attached;
      for (const og of a.organs) {
        const organ = h.organs[og.id];
        organColor(organ, this.base[og.id], flash, col);
        g.fillStyle = css(col, gone ? 0.25 : 0.85);
        g.beginPath();
        g.ellipse(X(def.pos[0] + og.c[0]), Y(def.pos[1] + og.c[1]), og.r[0] * s, og.r[1] * s, 0, 0, Math.PI * 2);
        g.fill();
      }
    }
    // vessels
    g.lineCap = 'round';
    for (const def of PARTS) {
      for (const v of ANATOMY[def.name].vessels) {
        const cut = h.vessels[v.id].cut;
        g.strokeStyle = cut ? `rgba(255,40,40,${0.5 + 0.5 * flash})` : 'rgba(170,40,60,0.75)';
        g.lineWidth = Math.max(1, v.r * 1.4 * s);
        g.beginPath(); g.moveTo(X(def.pos[0] + v.a[0]), Y(def.pos[1] + v.a[1])); g.lineTo(X(def.pos[0] + v.b[0]), Y(def.pos[1] + v.b[1])); g.stroke();
      }
    }
    // bones
    for (const def of PARTS) {
      const px = def.pos[0], py = def.pos[1], gone = !h.parts[def.name].attached;
      for (const b of ANATOMY[def.name].bones) {
        const bone = h.bones[b.id];
        boneColor(bone, flash, col);
        const alpha = gone ? 0.35 : 0.92;
        g.strokeStyle = css(col, alpha); g.fillStyle = css(col, alpha * 0.35);
        if (!b.shell) {
          g.lineWidth = Math.max(1.5, b.r * 2 * s);
          // foot bones run front-to-back: from the front they show as a short block
          const ax = px + b.a[0], ay = py + (b.a[1] || 0), bx = px + b.b[0], by = py + (b.b[1] || 0);
          if (Math.abs(ay - by) < 1e-3 && Math.abs(ax - bx) < 1e-3) { g.beginPath(); g.ellipse(X(ax), Y(ay), b.r * s * 1.6, b.r * s, 0, 0, Math.PI * 2); g.fill(); g.stroke(); }
          else { g.beginPath(); g.moveTo(X(ax), Y(ay)); g.lineTo(X(bx), Y(by)); g.stroke(); }
          if (bone.fractured) crack(g, X((ax + bx) / 2), Y((ay + by) / 2), b.r * s * 2.4, flash, dpr);
        } else if (b.id === 'skull') {
          g.lineWidth = 2 * dpr;
          g.beginPath(); g.ellipse(X(px), Y(py + 0.01), 0.088 * s, 0.1 * s, 0, 0, Math.PI * 2); g.fill(); g.stroke();
          for (const sx of [-1, 1]) { g.beginPath(); g.ellipse(X(px + sx * 0.032), Y(py + 0.012), 0.019 * s, 0.016 * s, 0, 0, Math.PI * 2); g.stroke(); }
          g.beginPath(); g.moveTo(X(px), Y(py - 0.005)); g.lineTo(X(px - 0.008), Y(py - 0.025)); g.lineTo(X(px + 0.008), Y(py - 0.025)); g.closePath(); g.stroke();
          g.beginPath(); g.ellipse(X(px), Y(py - 0.06), 0.05 * s, 0.032 * s, 0, 0, Math.PI); g.stroke();
          if (bone.fractured) crack(g, X(px + 0.04), Y(py + 0.05), 0.05 * s, flash, dpr);
        } else if (b.id === 'ribs') {
          g.lineWidth = Math.max(1.2, 0.012 * s);
          g.beginPath(); g.moveTo(X(px), Y(py + 0.12)); g.lineTo(X(px), Y(py - 0.05)); g.stroke(); // sternum
          for (let i = 0; i < 6; i++) {
            const w = 0.15 - Math.abs(i - 2) * 0.008, y = py + 0.1 - i * 0.04;
            for (const sx of [-1, 1]) {
              g.beginPath(); g.moveTo(X(px + sx * 0.012), Y(y));
              g.bezierCurveTo(X(px + sx * w * 0.7), Y(y + 0.02), X(px + sx * w * 1.05), Y(y - 0.01), X(px + sx * w * 0.95), Y(y - 0.045));
              g.stroke();
            }
          }
          for (const sx of [-1, 1]) { g.beginPath(); g.moveTo(X(px + sx * 0.02), Y(py + 0.125)); g.lineTo(X(px + sx * 0.17), Y(py + 0.13)); g.stroke(); } // clavicles
          if (bone.fractured) crack(g, X(px - 0.1), Y(py + 0.02), 0.06 * s, flash, dpr);
        } else if (b.id === 'pelvisBone') {
          g.lineWidth = Math.max(1.5, 0.016 * s);
          for (const sx of [-1, 1]) {
            g.beginPath(); g.moveTo(X(px + sx * 0.02), Y(py - 0.05));
            g.bezierCurveTo(X(px + sx * 0.06), Y(py + 0.09), X(px + sx * 0.15), Y(py + 0.07), X(px + sx * 0.13), Y(py - 0.01));
            g.lineTo(X(px + sx * 0.08), Y(py - 0.07)); g.stroke();
          }
          g.beginPath(); g.ellipse(X(px), Y(py), 0.025 * s, 0.04 * s, 0, 0, Math.PI * 2); g.fill(); g.stroke();
          if (bone.fractured) crack(g, X(px + 0.09), Y(py + 0.03), 0.05 * s, flash, dpr);
        }
      }
    }
    // wound markers
    for (const w of h.wounds) {
      const def = PARTS.find((p) => p.name === w.part);
      if (!def || w.rate <= 0.001 && !w.stump) continue;
      let x = def.pos[0], y = def.pos[1], r = 3.2 * dpr;
      if (w.stump) { const child = PARTS.find((p) => p.joint?.name === w.joint); x = child.joint.pivot[0]; y = child.joint.pivot[1]; r = 6 * dpr; }
      else if (w.pos) { x += w.pos.x; y += w.pos.y; }
      else r = (w.burst ? 0.09 : 0.05) * s;
      g.fillStyle = `rgba(255,50,30,${0.35 + 0.65 * clamp(w.rate / 3) * flash + 0.2})`;
      g.strokeStyle = 'rgba(255,90,60,0.9)'; g.lineWidth = 1 * dpr;
      g.beginPath(); g.arc(X(x), Y(y), r, 0, Math.PI * 2);
      if (w.pos || w.stump) g.fill(); else g.stroke();
    }
  }
}

function roundRect(g, x, y, w, h, r) {
  g.moveTo(x + r, y); g.lineTo(x + w - r, y); g.quadraticCurveTo(x + w, y, x + w, y + r); g.lineTo(x + w, y + h - r);
  g.quadraticCurveTo(x + w, y + h, x + w - r, y + h); g.lineTo(x + r, y + h); g.quadraticCurveTo(x, y + h, x, y + h - r);
  g.lineTo(x, y + r); g.quadraticCurveTo(x, y, x + r, y); g.closePath();
}

/** Zig-zag fracture mark across a bone. */
function crack(g, x, y, size, flash, dpr) {
  g.save();
  g.strokeStyle = `rgba(255,${60 + 80 * flash},40,0.95)`; g.lineWidth = 1.6 * dpr;
  g.beginPath(); g.moveTo(x - size * 0.6, y - size * 0.3); g.lineTo(x - size * 0.15, y + size * 0.15); g.lineTo(x + size * 0.1, y - size * 0.2); g.lineTo(x + size * 0.6, y + size * 0.3);
  g.stroke(); g.restore();
}

/** Small dedicated renderer drawing the targeted ragdoll's x-ray into the HUD panel. */
export class XRayView {
  constructor(container, scene) {
    this.container = container;
    this.scene = scene;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.domElement.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;';
    container.prepend(this.renderer.domElement);
    this.flat = new FlatXRay(container);
    this.mode = '';
    this.camera = new THREE.PerspectiveCamera(30, 1, 0.1, 50);
    this.camera.layers.set(XRAY_LAYER);
    this.camPos = new THREE.Vector3(); this.look = new THREE.Vector3();
    this.first = true;
    this.w = 0; this.h = 0;
  }

  render(ragdoll, viewerPos, dt) {
    const mode = settings.get('xrayMode') === 'flat' ? 'flat' : 'dynamic';
    if (mode !== this.mode) {
      this.mode = mode;
      this.flat.show(mode === 'flat');
      this.renderer.domElement.style.display = mode === 'flat' ? 'none' : 'block';
      this.flat.timer = 0; this.first = true;
    }
    if (mode === 'flat') { this.flat.draw(ragdoll, dt); return; }
    const w = this.container.clientWidth, h = this.container.clientHeight;
    if (w !== this.w || h !== this.h) { this.w = w; this.h = h; this.renderer.setSize(w, h, false); this.camera.aspect = w / h; this.camera.updateProjectionMatrix(); }
    if (!ragdoll) { this.renderer.clear(); return; }
    // Frame all attached parts
    const box = new THREE.Box3();
    for (const [n, p] of Object.entries(ragdoll.parts)) if (ragdoll.health.parts[n].attached) box.expandByPoint(p.group.position);
    const centre = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const upY = new THREE.Vector3(0, 1, 0).applyQuaternion(ragdoll.parts.pelvis.group.quaternion).y;
    const elev = THREE.MathUtils.degToRad(lerp(65, 6, clamp(upY)));
    const toViewer = viewerPos.clone().sub(centre).setY(0);
    if (toViewer.lengthSq() < 1e-4) toViewer.set(0, 0, 1);
    toViewer.normalize();
    const radius = Math.max(size.x, size.y, size.z) * 0.5 + 0.25;
    const dist = radius / Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2)) * 0.95;
    const want = centre.clone().addScaledVector(toViewer, Math.cos(elev) * dist).add(new THREE.Vector3(0, Math.sin(elev) * dist, 0));
    const k = this.first ? 1 : 1 - Math.exp(-dt * 6);
    this.first = false;
    this.camPos.lerp(want, k); this.look.lerp(centre, k);
    this.camera.position.copy(this.camPos);
    this.camera.lookAt(this.look);
    const bg = this.scene.background, fog = this.scene.fog;
    this.scene.background = null; this.scene.fog = null;
    this.renderer.render(this.scene, this.camera);
    this.scene.background = bg; this.scene.fog = fog;
  }
}
