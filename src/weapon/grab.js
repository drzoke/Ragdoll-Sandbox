import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { BlockArms, anchorPos } from './arms.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { CONFIG } from '../config.js';
import { clamp, damp, lerp, Spring, viewmodelToWorld, drawOffset } from '../core/util.js';
import { PARTS } from '../ragdoll/skeleton.js';

const W = CONFIG.weapon;
const G = {
  range: 15,          // max grab distance (m)
  minDist: 1.1,
  maxDist: 15,
  maxForce: 2600,     // N the beam can pull with
  holdComp: 0.55,     // share of the held body's weight carried by the beam field
  throwSpeed: 19,     // m/s added on throw
  puntSpeed: 12,
  puntRange: 9,
};
const _v = new THREE.Vector3(), _v2 = new THREE.Vector3(), _q = new THREE.Quaternion();

// ------------------------------------------------------------------ energy beam
// A camera-facing ribbon along a quadratic Bézier: from the emitter, bending towards where the
// player aims, ending on the held point. Thin white core + soft glow, with pulses running along it.
const beamMat = new THREE.ShaderMaterial({
  uniforms: { time: { value: 0 }, intensity: { value: 1 }, glow: { value: 0 } },
  vertexShader: /* glsl */`
    attribute float side; attribute float t;
    varying float vSide; varying float vT;
    void main() { vSide = side; vT = t; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: /* glsl */`
    uniform float time; uniform float intensity; uniform float glow;
    varying float vSide; varying float vT;
    void main() {
      float d = abs(vSide);
      float core = smoothstep(1.0, 0.0, d);
      core = mix(pow(core, 6.0), pow(core, 2.0), glow);
      float pulse = 0.55 + 0.45 * sin(vT * 38.0 - time * 26.0);
      float bursts = smoothstep(0.82, 1.0, sin(vT * 9.0 - time * 11.0));
      float fadeEnds = smoothstep(0.0, 0.04, vT) * (0.6 + 0.4 * smoothstep(1.0, 0.9, vT));
      float a = core * (0.55 + 0.45 * pulse + bursts * 0.8) * fadeEnds * intensity;
      vec3 col = mix(vec3(0.75, 0.88, 1.0), vec3(1.0), core);
      gl_FragColor = vec4(col * a * (glow > 0.5 ? 0.45 : 1.3), a);
    }`,
  transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, fog: false,
});

// White outline around whatever is held: back faces pushed out along the normals.
const outlineMat = new THREE.ShaderMaterial({
  uniforms: { thickness: { value: 0.011 }, time: { value: 0 }, bright: { value: 1 } },
  vertexShader: /* glsl */`
    uniform float thickness;
    void main() { gl_Position = projectionMatrix * modelViewMatrix * vec4(position + normalize(normal) * thickness, 1.0); }`,
  fragmentShader: /* glsl */`
    uniform float time; uniform float bright;
    void main() { float p = 0.85 + 0.15 * sin(time * 9.0); gl_FragColor = vec4(vec3(bright * p), 1.0); }`,
  side: THREE.BackSide, fog: false,
});

class Beam {
  constructor(scene, segments = 48, width = 0.008, glow = false) {
    this.n = segments;
    this.width = width;
    const pos = new Float32Array((segments + 1) * 2 * 3);
    const side = new Float32Array((segments + 1) * 2), t = new Float32Array((segments + 1) * 2);
    const idx = [];
    for (let i = 0; i <= segments; i++) {
      side[i * 2] = -1; side[i * 2 + 1] = 1;
      t[i * 2] = t[i * 2 + 1] = i / segments;
      if (i < segments) { const a = i * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('side', new THREE.BufferAttribute(side, 1));
    g.setAttribute('t', new THREE.BufferAttribute(t, 1));
    g.setIndex(idx);
    this.mat = beamMat.clone();
    this.mat.uniforms.glow.value = glow ? 1 : 0;
    this.mesh = new THREE.Mesh(g, this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 5;
    this.mesh.visible = false;
    scene.add(this.mesh);
    this.pos = pos;
    this.geo = g;
  }

  /** p0 → p2 with control point p1; jitter makes the beam crackle. */
  set(p0, p1, p2, camPos, time, jitter = 0) {
    const n = this.n, P = this.pos;
    const pt = new THREE.Vector3(), tan = new THREE.Vector3(), toCam = new THREE.Vector3(), sideV = new THREE.Vector3();
    for (let i = 0; i <= n; i++) {
      const u = i / n, iu = 1 - u;
      pt.set(0, 0, 0).addScaledVector(p0, iu * iu).addScaledVector(p1, 2 * iu * u).addScaledVector(p2, u * u);
      tan.set(0, 0, 0).addScaledVector(p0, -2 * iu).addScaledVector(p1, 2 * (iu - u)).addScaledVector(p2, 2 * u).normalize();
      if (jitter > 0) {
        const w = Math.sin(u * Math.PI);
        pt.x += Math.sin(u * 31 + time * 47) * jitter * w;
        pt.y += Math.sin(u * 23 - time * 39) * jitter * w;
        pt.z += Math.cos(u * 27 + time * 43) * jitter * w;
      }
      toCam.copy(camPos).sub(pt);
      sideV.crossVectors(tan, toCam).normalize();
      // thinner near the emitter (perspective already makes it look thick there)
      const wdt = this.width * (0.35 + 0.65 * Math.min(1, u * 4));
      P[i * 6] = pt.x - sideV.x * wdt; P[i * 6 + 1] = pt.y - sideV.y * wdt; P[i * 6 + 2] = pt.z - sideV.z * wdt;
      P[i * 6 + 3] = pt.x + sideV.x * wdt; P[i * 6 + 4] = pt.y + sideV.y * wdt; P[i * 6 + 5] = pt.z + sideV.z * wdt;
    }
    this.geo.attributes.position.needsUpdate = true;
    this.mat.uniforms.time.value = time;
  }
}

// ------------------------------------------------------------------ viewmodel
function buildGadget() {
  const white = new THREE.MeshStandardMaterial({ color: 0xd9dde2, roughness: 0.38, metalness: 0.05 });
  const gray = new THREE.MeshStandardMaterial({ color: 0x5b6067, roughness: 0.5, metalness: 0.4 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x1d2024, roughness: 0.45, metalness: 0.6 });
  const glowMat = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xdff0ff, emissiveIntensity: 1.5, roughness: 0.2 });
  const coilMat = new THREE.MeshStandardMaterial({ color: 0x8fb8d8, emissive: 0x9fd4ff, emissiveIntensity: 0.4, roughness: 0.3, metalness: 0.3 });

  // Big, chunky "physics gun" proportions: heavy base, wide emitter and long claws.
  const root = new THREE.Group();
  const body = new THREE.Mesh(new RoundedBoxGeometry(0.1, 0.105, 0.28, 3, 0.024), white);
  body.position.set(0, 0, -0.05);
  root.add(body);
  const rear = new THREE.Mesh(new RoundedBoxGeometry(0.088, 0.092, 0.06, 3, 0.02), gray);
  rear.position.set(0, 0, 0.11);
  root.add(rear);
  const top = new THREE.Mesh(new RoundedBoxGeometry(0.062, 0.03, 0.2, 2, 0.01), gray);
  top.position.set(0, 0.064, -0.04);
  root.add(top);
  for (const sx of [1, -1]) {
    const panel = new THREE.Mesh(new RoundedBoxGeometry(0.008, 0.06, 0.17, 2, 0.003), dark);
    panel.position.set(sx * 0.051, -0.008, -0.05);
    root.add(panel);
  }
  const grip = new THREE.Mesh(new RoundedBoxGeometry(0.05, 0.13, 0.065, 2, 0.014), dark);
  grip.position.set(0, -0.1, 0.045); grip.rotation.x = 0.28;
  root.add(grip);
  const trigGuard = new THREE.Mesh(new THREE.TorusGeometry(0.028, 0.005, 6, 14, Math.PI), dark);
  trigGuard.position.set(0, -0.055, -0.01); trigGuard.rotation.set(0, Math.PI / 2, Math.PI);
  root.add(trigGuard);
  // barrel + coils
  const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.034, 0.04, 0.12, 22).rotateX(Math.PI / 2), gray);
  barrel.position.set(0, 0, -0.245);
  root.add(barrel);
  const coils = [];
  for (let i = 0; i < 3; i++) {
    const c = new THREE.Mesh(new THREE.TorusGeometry(0.043, 0.007, 8, 26), coilMat.clone());
    c.position.set(0, 0, -0.205 - i * 0.034);
    root.add(c); coils.push(c);
  }
  const emitterRing = new THREE.Mesh(new THREE.TorusGeometry(0.047, 0.009, 10, 28), dark);
  emitterRing.position.set(0, 0, -0.31);
  root.add(emitterRing);
  // three big claws that open while grabbing
  const prongs = [];
  for (let i = 0; i < 3; i++) {
    const hinge = new THREE.Group();
    const a = (i / 3) * Math.PI * 2 + Math.PI / 2;
    hinge.position.set(Math.cos(a) * 0.05, Math.sin(a) * 0.05, -0.305);
    hinge.rotation.z = a - Math.PI / 2;
    const prong = new THREE.Mesh(new RoundedBoxGeometry(0.034, 0.024, 0.17, 2, 0.007), white);
    prong.position.set(0, 0.008, -0.075);
    const knuckle = new THREE.Mesh(new THREE.CylinderGeometry(0.015, 0.015, 0.04, 12).rotateZ(Math.PI / 2), gray);
    knuckle.position.set(0, -0.004, 0.075);
    prong.add(knuckle);
    const tip = new THREE.Mesh(new RoundedBoxGeometry(0.034, 0.046, 0.028, 2, 0.006), dark);
    tip.position.set(0, -0.018, -0.084);
    prong.add(tip);
    hinge.add(prong);
    root.add(hinge); prongs.push(hinge);
  }
  const core = new THREE.Mesh(new THREE.SphereGeometry(0.022, 18, 14), glowMat);
  core.position.set(0, 0, -0.31);
  root.add(core);
  // display strip
  const strip = new THREE.Mesh(new THREE.BoxGeometry(0.004, 0.014, 0.12), coilMat.clone());
  strip.position.set(0.056, 0.02, -0.05);
  root.add(strip);
  const muzzle = new THREE.Object3D();
  muzzle.position.set(0, 0, -0.33);
  root.add(muzzle);
  root.traverse((o) => { if (o.isMesh) o.castShadow = false; });
  return { root, prongs, core, coils, strip, muzzle, glowMat };
}

/**
 * Gravity-gun style manipulator. Right click grabs (or drops) a body part or gib; left click throws
 * what you hold, or punts things in front of you. The held point is pulled by a force-limited
 * joint to an anchor that trails behind your aim; the further away, the more it lags.
 */
export { buildGadget };

export class GrabTool {
  constructor({ mainScene, mainCamera, player, audio, environment, physics, ragdolls, gore, hud }) {
    this.name = 'Grab';
    this.player = player; this.audio = audio; this.mainCamera = mainCamera;
    this.physics = physics; this.ragdolls = ragdolls; this.gore = gore; this.hud = hud;

    this.scene = new THREE.Scene();
    this.scene.environment = environment;
    this.scene.environmentIntensity = 0.9;
    this.camera = new THREE.PerspectiveCamera(W.weaponFov, 1, 0.01, 10);
    this.scene.add(new THREE.HemisphereLight(0xe8eef5, 0x55575a, 1.4));
    const key = new THREE.DirectionalLight(0xffffff, 2.2); key.position.set(0.6, 1, 0.4); this.scene.add(key);
    const rim = new THREE.DirectionalLight(0xbcd4ff, 0.9); rim.position.set(-1, 0.3, -0.6); this.scene.add(rim);
    this.pivot = new THREE.Group(); this.scene.add(this.pivot);
    this.gadget = buildGadget();
    this.gadget.root.scale.setScalar(0.5);
    this.gadget.root.position.set(0, 0, 0.04);
    this.pivot.add(this.gadget.root);
    // blocky hands: right on the grip, left under the front of the body
    this.arms = new BlockArms(this.scene);
    const anchor = (x, y, z) => { const o = new THREE.Object3D(); o.position.set(x, y, z); this.gadget.root.add(o); return o; };
    this.anchors = { grip: anchor(0, -0.112, 0.05), front: anchor(-0.05, -0.085, -0.14) };
    this.vmLight = new THREE.PointLight(0xcfe6ff, 0, 0.6, 2);
    this.vmLight.position.set(0, 0, -0.3);
    this.gadget.root.add(this.vmLight);
    // world glow at the held point
    this.worldLight = new THREE.PointLight(0xd8ecff, 0, 3, 2);
    mainScene.add(this.worldLight);

    this.beam = new Beam(mainScene, 48, 0.0055, false);
    this.glow = new Beam(mainScene, 48, 0.035, true);
    this.halo = new Beam(mainScene, 32, 0.1, true);   // wide soft glow (Very High)
    this.outlines = [];
    this.quality = 'medium';

    // anchor: kinematic body the held point is jointed to
    this.anchor = new CANNON.Body({ mass: 0, type: CANNON.Body.KINEMATIC, collisionFilterGroup: 0, collisionFilterMask: 0 });
    this.anchor.collisionResponse = false;
    physics.world.addBody(this.anchor);
    this.anchorTarget = new THREE.Vector3();
    this.held = null;     // { kind:'ragdoll'|'gib', ragdoll, part, body, local, joint, set }
    this.dist = 4;
    this.raycaster = new THREE.Raycaster();
    this.raise = 0;       // 0 = holstered, 1 = up (set by the toolbox)
    this.pulse = 0;       // beam flash for punts
    this.puntDir = new THREE.Vector3();
    this.puntEnd = new THREE.Vector3();
    this.cooldown = 0;
    this.time = 0;
    this.open = 0;        // prong opening
    this.kick = new Spring(260, 16);
    this.swayX = 0; this.swayY = 0;
    this.lastYaw = player.yaw; this.lastPitch = player.pitch;
    this._unsub = physics.onStep((h) => this.step(h));
  }

  resize(aspect) { this.camera.aspect = aspect; this.camera.updateProjectionMatrix(); }

  /** Beam glow and outline strength follow the graphics preset. */
  setQuality(level) {
    this.quality = level;
    this.glow.width = level === 'ultra' ? 0.06 : level === 'high' ? 0.05 : 0.035;
    outlineMat.uniforms.bright.value = level === 'ultra' ? 1.5 : level === 'high' ? 1.3 : 1.0;
    outlineMat.uniforms.thickness.value = level === 'low' || level === 'verylow' ? 0.008 : 0.011;
  }

  addOutlines(held) {
    const add = (src, parent) => {
      if (!src || !src.visible) return;
      const o = new THREE.Mesh(src.geometry, outlineMat);
      o.position.copy(src.position); o.quaternion.copy(src.quaternion); o.scale.copy(src.scale);
      o.renderOrder = -1;
      o.userData.outline = true;
      o.raycast = () => {};
      parent.add(o);
      this.outlines.push(o);
    };
    if (held.kind === 'ragdoll') {
      for (const b of held.set) {
        const part = held.ragdoll.parts[b.userData.part];
        if (!part) continue;
        add(part.mesh, part.group);
        if (part.ball?.visible) add(part.ball, part.group);
      }
    } else add({ geometry: held.gib.mesh.geometry, position: new THREE.Vector3(), quaternion: new THREE.Quaternion(), scale: new THREE.Vector3(1, 1, 1), visible: true }, held.gib.mesh);
  }

  removeOutlines() {
    for (const o of this.outlines) o.parent?.remove(o);
    this.outlines = [];
  }

  get ads() { return 0; }
  get busy() { return false; }

  /** Controls shown in the left panel. */
  get controls() {
    return [
      ['Right click', this.held ? 'Drop' : 'Grab'],
      ['Left click', this.held ? 'Throw' : 'Push away'],
      ['Wheel or R / F', 'Pull closer / push away'],
    ];
  }

  status() {
    if (!this.held) return { title: 'GRAB', sub: 'Nothing held' };
    const h = this.held;
    const label = h.kind === 'gib' ? 'Chunk' : `${h.ragdoll.name} · ${h.ragdoll.health.parts[h.part].label}`;
    return { title: `${this.dist.toFixed(1)} m`, sub: label };
  }

  // ---------------------------------------------------------------- targeting
  aim() {
    const cam = this.mainCamera;
    const origin = cam.getWorldPosition(new THREE.Vector3());
    const dir = cam.getWorldDirection(new THREE.Vector3());
    return { origin, dir };
  }

  pickTarget(range) {
    const { origin, dir } = this.aim();
    this.raycaster.set(origin, dir);
    this.raycaster.far = range;
    const objs = [...this.ragdolls.meshes(), ...this.gore.gibs.map((g) => g.mesh)];
    const hit = this.raycaster.intersectObjects(objs, false)[0];
    if (!hit) return null;
    const ud = hit.object.userData;
    if (ud.ragdoll) {
      const r = ud.ragdoll, part = r.parts[ud.part];
      if (!part || part.removed || r.removed) return null;
      return { kind: 'ragdoll', ragdoll: r, part: ud.part, body: part.body, point: hit.point, distance: hit.distance };
    }
    if (ud.gib) return { kind: 'gib', gib: ud.gib, body: ud.gib.body, point: hit.point, distance: hit.distance };
    return null;
  }

  /** All bodies still jointed to the given ragdoll part. */
  connectedSet(r, partName) {
    const set = new Set([partName]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const def of PARTS) {
        const p = r.parts[def.name];
        if (!def.parent || !p.constraint || p.removed || r.parts[def.parent].removed) continue;
        const a = set.has(def.name), b = set.has(def.parent);
        if (a !== b) { set.add(def.name); set.add(def.parent); grew = true; }
      }
    }
    return [...set].map((n) => r.parts[n].body);
  }

  grab(t) {
    const b = t.body;
    _q.set(b.quaternion.x, b.quaternion.y, b.quaternion.z, b.quaternion.w).invert();
    const local = _v.set(t.point.x - b.position.x, t.point.y - b.position.y, t.point.z - b.position.z).applyQuaternion(_q);
    this.anchor.position.set(t.point.x, t.point.y, t.point.z);
    this.anchor.velocity.set(0, 0, 0);
    this.anchorTarget.copy(t.point);
    const joint = new CANNON.PointToPointConstraint(this.anchor, new CANNON.Vec3(0, 0, 0), b, new CANNON.Vec3(local.x, local.y, local.z), G.maxForce);
    joint.collideConnected = false;
    this.physics.world.addConstraint(joint);
    this.held = { ...t, local: local.clone(), joint };
    this.held.set = t.kind === 'ragdoll' ? this.connectedSet(t.ragdoll, t.part) : [b];
    this.dist = clamp(t.distance, G.minDist, G.maxDist);
    if (t.kind === 'ragdoll' && t.ragdoll.health.parts[t.part].attached) t.ragdoll.grabbed = true;
    for (const body of this.held.set) body.wakeUp?.();
    this.addOutlines(this.held);
    this.audio.play('grab');
    this.kick.kick(-4);
  }

  release() {
    const h = this.held;
    if (!h) return;
    this.physics.world.removeConstraint(h.joint);
    this.removeOutlines();
    if (h.kind === 'ragdoll') h.ragdoll.grabbed = false;
    this.held = null;
  }

  drop() { if (!this.held) return; this.release(); this.audio.play('drop'); }

  throw() {
    const h = this.held;
    if (!h) return;
    const { dir } = this.aim();
    this.release();
    for (const b of h.set) {
      b.velocity.x = b.velocity.x * 0.4 + dir.x * G.throwSpeed;
      b.velocity.y = b.velocity.y * 0.4 + dir.y * G.throwSpeed + 1.5;
      b.velocity.z = b.velocity.z * 0.4 + dir.z * G.throwSpeed;
    }
    h.body.angularVelocity.x += (Math.random() - 0.5) * 8;
    h.body.angularVelocity.z += (Math.random() - 0.5) * 8;
    this.audio.play('throw');
    this.flashBeam(h.body.position);
    this.kick.kick(14);
    this.player.addRecoil(0.02, 0);
  }

  punt() {
    const t = this.pickTarget(G.puntRange);
    const { origin, dir } = this.aim();
    if (!t) {
      this.audio.play('deny');
      this.flashBeam(origin.clone().addScaledVector(dir, 3));
      this.kick.kick(5);
      return;
    }
    const bodies = t.kind === 'ragdoll' ? this.connectedSet(t.ragdoll, t.part) : [t.body];
    const falloff = 1 - 0.5 * (t.distance / G.puntRange);
    for (const b of bodies) {
      const k = (b === t.body ? 1.6 : 1) * G.puntSpeed * falloff;
      b.velocity.x += dir.x * k; b.velocity.y += dir.y * k + 1.2; b.velocity.z += dir.z * k;
    }
    if (t.kind === 'ragdoll') {
      t.ragdoll.brain.onHit(t.part, dir);
      if (t.ragdoll.brain.state === 'stand') t.ragdoll.brain.fall();
    }
    this.audio.play('throw');
    this.flashBeam(t.point);
    this.kick.kick(10);
  }

  flashBeam(end) { this.pulse = 1; this.puntEnd.copy(end); }

  // ---------------------------------------------------------------- per physics step
  step(h) {
    const held = this.held;
    if (!held) return;
    // Anchor glides toward its target (kinematic: velocity is integrated by the world).
    const a = this.anchor;
    const t = this.anchorTarget;
    const vx = (t.x - a.position.x) * 22, vy = (t.y - a.position.y) * 22, vz = (t.z - a.position.z) * 22;
    const sp = Math.hypot(vx, vy, vz), cap = 28;
    const k = sp > cap ? cap / sp : 1;
    a.velocity.set(vx * k, vy * k, vz * k);
    // The field carries part of the held body's weight so joints don't stretch from one hand.
    for (const b of held.set) b.velocity.y += 9.81 * h * G.holdComp;
    // light damping of spin on the held part
    const w = held.body.angularVelocity;
    w.x *= 0.995; w.y *= 0.995; w.z *= 0.995;
  }

  // ---------------------------------------------------------------- frame update
  update(dt, input, active) {
    this.time += dt;
    this.cooldown -= dt;
    const held = this.held;
    // validate what we hold
    if (held) {
      const gone = held.kind === 'ragdoll'
        ? (held.ragdoll.removed || held.ragdoll.parts[held.part].removed)
        : !this.gore.gibs.includes(held.gib);
      if (gone) this.release();
    }

    const ready = active && this.raise > 0.9;
    if (ready) {
      if (input.mousePressed[2]) {
        if (this.held) this.drop();
        else {
          const t = this.pickTarget(G.range);
          if (t) this.grab(t); else { this.audio.play('deny'); this.kick.kick(3); }
        }
      }
      if (input.mousePressed[0] && this.cooldown <= 0) {
        this.cooldown = 0.35;
        if (this.held) this.throw(); else this.punt();
      }
      if (this.held) {
        if (input.wheel) this.dist = clamp(this.dist - input.wheel * 0.6, G.minDist, G.maxDist);
        if (input.isDown('KeyR')) this.dist = clamp(this.dist - dt * 6, G.minDist, G.maxDist);
        if (input.isDown('KeyF')) this.dist = clamp(this.dist + dt * 6, G.minDist, G.maxDist);
      }
    } else if (!active && this.held) this.drop();

    // Anchor target trails the aim point; lag grows with distance.
    const { origin, dir } = this.aim();
    if (this.held) {
      const want = _v.copy(origin).addScaledVector(dir, this.dist);
      const lagRate = lerp(18, 2.4, clamp((this.dist - G.minDist) / (G.maxDist - G.minDist)));
      this.anchorTarget.lerp(want, damp(lagRate, dt));
      // never let the anchor sink into the floor
      this.anchorTarget.y = Math.max(0.3, this.anchorTarget.y);
      // auto drop if the body got stuck far from the beam
      const hp = this.heldPoint(_v2);
      if (hp.distanceTo(this.anchor.position) > 4.5) this.drop();
    }

    this.open += ((this.held ? 1 : 0) - this.open) * damp(12, dt);
    this.pulse = Math.max(0, this.pulse - dt * 5);
    this.animate(dt);
    this.updateBeam(dt, origin, dir);
  }

  heldPoint(out = new THREE.Vector3()) {
    const b = this.held.body;
    _q.set(b.quaternion.x, b.quaternion.y, b.quaternion.z, b.quaternion.w);
    return out.copy(this.held.local).applyQuaternion(_q).add(b.position);
  }

  /** Emitter position in the world (viewmodel space → main camera space). */
  emitterWorld(out = new THREE.Vector3()) {
    this.pivot.updateMatrixWorld(true);
    return viewmodelToWorld(this.gadget.muzzle.getWorldPosition(_v2), this.camera, this.mainCamera, out);
  }

  updateBeam(dt, origin, dir) {
    const on = this.held || this.pulse > 0;
    const vis = !!(on && this.raise > 0.5);
    const q = this.quality;
    outlineMat.uniforms.time.value = this.time;
    this.beam.mesh.visible = vis;
    this.glow.mesh.visible = vis && q !== 'low' && q !== 'verylow';
    this.halo.mesh.visible = vis && q === 'ultra';
    this.worldLight.intensity = 0;
    this.audio.hum(this.held && this.raise > 0.5 ? 1 : 0, this.held ? 1 + Math.min(1, this.held.body.velocity.length() / 12) * 0.8 : 1);
    if (!vis) return;
    const p0 = this.emitterWorld(new THREE.Vector3());
    let p2, len;
    if (this.held) {
      p2 = this.heldPoint(new THREE.Vector3());
      len = p0.distanceTo(p2);
    } else {
      p2 = this.puntEnd.clone();
      len = p0.distanceTo(p2);
    }
    // control point: straight out of the emitter along the aim, so the beam bends when the
    // held object lags behind.
    const p1 = p0.clone().addScaledVector(dir, len * 0.55);
    const camPos = origin;
    const inten = this.held ? 0.9 + 0.1 * Math.sin(this.time * 30) : this.pulse;
    const boost = q === 'ultra' ? 1.8 : q === 'high' ? 1.5 : 1;
    this.beam.mat.uniforms.intensity.value = inten * boost;
    this.glow.mat.uniforms.intensity.value = inten * 0.55 * boost;
    this.halo.mat.uniforms.intensity.value = inten * 0.35;
    const jit = this.held ? 0.004 + Math.min(0.03, this.held.body.velocity.length() * 0.0015) : 0.01;
    this.beam.set(p0, p1, p2, camPos, this.time, jit);
    this.glow.set(p0, p1, p2, camPos, this.time, jit * 0.5);
    if (this.halo.mesh.visible) this.halo.set(p0, p1, p2, camPos, this.time, 0);
    this.worldLight.position.copy(p2);
    this.worldLight.intensity = inten * (q === 'ultra' ? 3 : q === 'high' ? 2.2 : 1.6);
  }

  animate(dt) {
    const g = this.gadget, p = this.player;
    for (const pr of g.prongs) pr.children[0].rotation.x = 0;
    g.prongs.forEach((h, i) => { h.rotation.x = 0; h.children[0].rotation.x = -0.45 * this.open - 0.05 * Math.sin(this.time * 20 + i) * this.open; });
    const glowK = 0.6 + this.open * 1.8 + this.pulse * 3 + Math.sin(this.time * 9) * 0.15;
    g.glowMat.emissiveIntensity = glowK;
    g.core.scale.setScalar(1 + this.open * 0.35 + this.pulse * 0.6);
    g.coils.forEach((c, i) => { c.material.emissiveIntensity = 0.3 + (this.open + this.pulse) * (0.8 + 0.6 * Math.sin(this.time * 18 - i * 1.4)); });
    g.strip.material.emissiveIntensity = 0.3 + this.open * 1.2;
    this.vmLight.intensity = (this.open + this.pulse) * 0.6;

    const dYaw = p.yaw - this.lastYaw, dPitch = p.pitch - this.lastPitch;
    this.lastYaw = p.yaw; this.lastPitch = p.pitch;
    // heavier sway when holding something far away
    const heavy = this.held ? 1 + this.dist / 8 : 1;
    this.swayX += (clamp(-dYaw * 1.6 * heavy, -0.08, 0.08) - this.swayX) * damp(this.held ? 6 : 10, dt);
    this.swayY += (clamp(dPitch * 1.6 * heavy, -0.08, 0.08) - this.swayY) * damp(this.held ? 6 : 10, dt);
    const bobA = p.bobAmount;
    const bobX = Math.cos(p.bobPhase) * 0.009 * bobA;
    const bobY = -Math.abs(Math.sin(p.bobPhase)) * 0.011 * bobA;
    const idle = Math.sin(this.time * 1.3) * 0.0015;
    const k = this.kick.update(dt);
    const dr = drawOffset(this.raise, this.drawing);
    const strain = this.held ? Math.sin(this.time * 31) * 0.0008 * (1 + this.dist / 6) : 0;
    this.pivot.position.set(0.16 + this.swayX + bobX + strain + dr.x, -0.165 + this.swayY + bobY + idle + dr.y - p.crouch * 0.01, -0.44 + k * 0.004 + dr.z);
    this.pivot.rotation.set(-k * 0.01 + this.swayY * 1.5 + dr.rx, 0.05 + this.swayX * 1.5, this.swayX * 1.2 + dr.rz, 'YXZ');
    this.pivot.updateMatrixWorld(true);
    this.arms.setOn('right', this.anchors.grip, { roll: 0.15 });
    // the support hand squeezes a little harder while holding something heavy
    this.arms.setOn('left', this.anchors.front, { roll: -0.3, fist: !!this.held });
  }

  dispose() { this.release(); }
}
