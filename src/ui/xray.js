import * as THREE from 'three';
import { ANATOMY } from '../ragdoll/anatomy.js';
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
    for (const [id, b] of Object.entries(this.boneMeshes)) {
      const bone = h.bones[id];
      const k = 1 - bone.integrity / 100;
      const c = new THREE.Color(0xe8f2ff).lerp(new THREE.Color(0xffb020), clamp(k * 1.8)).lerp(new THREE.Color(0xff2a1a), clamp((k - 0.45) * 2));
      if (bone.fractured) c.lerp(new THREE.Color(0xff2a1a), flash * 0.6);
      for (const m of b.mat) m.color.copy(c);
    }
    for (const [id, o] of Object.entries(this.organMeshes)) {
      const organ = h.organs[id];
      const k = organ.hp / organ.maxHp;
      const c = o.base.clone().multiplyScalar(lerp(0.35, 1, k));
      if (k < 1) c.lerp(new THREE.Color(0xff1010), (1 - k) * (0.4 + 0.5 * flash));
      if (k <= 0) c.setRGB(0.25, 0.05, 0.05).lerp(new THREE.Color(0xff0000), flash * 0.5);
      o.mat.color.copy(c);
    }
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
    this.camera = new THREE.PerspectiveCamera(30, 1, 0.1, 50);
    this.camera.layers.set(XRAY_LAYER);
    this.camPos = new THREE.Vector3(); this.look = new THREE.Vector3();
    this.first = true;
    this.w = 0; this.h = 0;
  }

  render(ragdoll, viewerPos, dt) {
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
