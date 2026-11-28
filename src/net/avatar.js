// The other players: a figure in the same proportions as the ragdolls, but clothed (a jacket and cap
// in the player's colour, dark trousers, boots, gloves and a black visor) so a friend never looks
// like a ragdoll. It walks, sprints, crouches, jumps, looks up and down and holds the item that
// player has out, all with procedural animation.
//
// Cheap to draw: every piece goes through the ragdoll batcher (ragdoll/batcher.js), so all players
// together cost one instanced draw call per kind of piece (about 20), however many there are, and
// far-away players use simpler shapes. The jacket colour is set per instance, so every player's
// jacket is the same draw call too. Only the name tag is its own sprite.
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { batch, fxMaterial } from '../ragdoll/batcher.js';
import { PART_BY_NAME } from '../ragdoll/skeleton.js';
import { clamp } from '../core/util.js';

export const PLAYER_COLORS = ['#3d8bfd', '#ff8a2a', '#2fbf71', '#c35cf5', '#f2c12e', '#22c3d6', '#f06aa8', '#e0414f'];

// what each item looks like in the hands (by tool name)
const HOLD = {
  'Fists': 'fists', 'M1911': 'pistol', 'Remington 870': 'shotgun', 'M24 Sniper': 'sniper', 'Flintlock Musket': 'musket',
  'Grenade': 'grenade', 'Grab': 'gadget', 'Machete': 'machete', 'Medkit': 'medkit', 'Defibrillator': 'defib',
};

const S = 0.965;      // a little smaller than a ragdoll, so the eyes sit at the player's eye height

// ------------------------------------------------------------------ shared geometry and materials
let G = null;
function rbox(w, h, d, r) {
  const g = new RoundedBoxGeometry(w, h, d, 3, r);
  g.userData.lod = new RoundedBoxGeometry(w, h, d, 1, r);
  return g;
}
function capsule(r, len) {
  const g = new THREE.CapsuleGeometry(r, Math.max(0.01, len - 2 * r), 5, 14);
  g.userData.lod = new THREE.CapsuleGeometry(r, Math.max(0.01, len - 2 * r), 2, 7);
  return g;
}
function shared() {
  if (G) return G;
  const P = (n) => PART_BY_NAME[n].size.map((x) => x * S);
  const ch = P('chest'), ab = P('abdomen'), pe = P('pelvis'), ua = P('upperArmL'), la = P('lowerArmL'), hd = P('handL');
  const th = P('thighL'), sh = P('shinL'), ft = P('footL'), head = P('head')[0];
  const sphere = (r, w, h, lw, lh, opts = []) => { const g = new THREE.SphereGeometry(r, w, h, ...opts); g.userData.lod = new THREE.SphereGeometry(r, lw, lh, ...opts); return g; };
  G = {
    geo: {
      chest: rbox(ch[0] + 0.02, ch[1] + 0.02, ch[2] + 0.03, 0.05),
      abdomen: rbox(ab[0] + 0.02, ab[1] + 0.02, ab[2] + 0.03, 0.045),
      pelvis: rbox(pe[0] + 0.01, pe[1], pe[2] + 0.01, 0.04),
      upperArm: capsule(ua[0] / 2 + 0.008, ua[1] + 0.03),
      lowerArm: capsule(la[0] / 2 + 0.006, la[1] + 0.02),
      hand: rbox(hd[0] + 0.012, hd[1], hd[2], 0.015),
      thigh: capsule(th[0] / 2 + 0.004, th[1] + 0.04),
      shin: capsule(sh[0] / 2 + 0.004, sh[1] + 0.02),
      foot: rbox(ft[0] + 0.02, ft[1] + 0.02, ft[2] + 0.04, 0.02),
      head: sphere(head, 22, 16, 10, 8),
      cap: sphere(head * 1.06, 22, 10, 10, 5, [0, Math.PI * 2, 0, Math.PI * 0.45]),
      brim: rbox(head * 1.6, 0.014, head * 0.9, 0.006),
      visor: rbox(head * 1.62, head * 0.36, head * 0.5, 0.02),
      neck: capsule(0.045, 0.12),
      // items
      slide: new THREE.BoxGeometry(0.032, 0.036, 0.2),
      grip: new THREE.BoxGeometry(0.03, 0.1, 0.045),
      barrel: new THREE.CylinderGeometry(0.011, 0.011, 1, 8).rotateX(Math.PI / 2),
      receiver: new THREE.BoxGeometry(0.05, 0.07, 0.24),
      stock: new THREE.BoxGeometry(0.045, 0.09, 0.3),
      scope: new THREE.CylinderGeometry(0.02, 0.02, 0.3, 10).rotateX(Math.PI / 2),
      ball: new THREE.SphereGeometry(0.036, 12, 8),
      box: new THREE.BoxGeometry(1, 1, 1),
      blade: new THREE.BoxGeometry(0.008, 0.05, 0.46),
    },
    mat: {
      cloth: fxMaterial({ roughness: 0.82, metalness: 0 }),        // jacket and cap: colour per instance
      pants: new THREE.MeshStandardMaterial({ color: 0x2a2f37, roughness: 0.9 }),
      boots: new THREE.MeshStandardMaterial({ color: 0x17181b, roughness: 0.7 }),
      gloves: new THREE.MeshStandardMaterial({ color: 0x202226, roughness: 0.75 }),
      skin: new THREE.MeshStandardMaterial({ color: 0x9ba1a8, roughness: 0.65 }),
      visor: new THREE.MeshStandardMaterial({ color: 0x07080a, roughness: 0.18, metalness: 0.6 }),
      metal: new THREE.MeshStandardMaterial({ color: 0x2b2e33, roughness: 0.45, metalness: 0.7 }),
      wood: new THREE.MeshStandardMaterial({ color: 0x5f3f26, roughness: 0.7 }),
      red: new THREE.MeshStandardMaterial({ color: 0xb3262c, roughness: 0.6 }),
      steel: new THREE.MeshStandardMaterial({ color: 0xb9bec4, roughness: 0.3, metalness: 0.85 }),
      glow: new THREE.MeshStandardMaterial({ color: 0x8fd0ff, emissive: 0x4fa3ff, emissiveIntensity: 1.5 }),
    },
  };
  return G;
}

const flashTex = (() => {
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const g = c.getContext('2d'); const grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grd.addColorStop(0, 'rgba(255,250,220,1)'); grd.addColorStop(0.3, 'rgba(255,190,90,0.8)'); grd.addColorStop(1, 'rgba(255,120,20,0)');
  g.fillStyle = grd; g.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
})();

/** A pivot (joint) with a piece of the body hanging off it. */
function joint(parent, x, y, z) { const g = new THREE.Group(); g.position.set(x, y, z); parent.add(g); return g; }

const AIM_Y = 1.5 * S;                 // the held item turns about this height (shoulders)
const UPPER = (1.55 - 1.265) * S;      // shoulder to elbow
const LOWER = (1.265 - 0.93) * S;      // elbow to the middle of the hand
const _t = new THREE.Vector3(), _d = new THREE.Vector3(), _u = new THREE.Vector3(), _w = new THREE.Vector3(), _x = new THREE.Vector3(), _p = new THREE.Vector3();
const _m = new THREE.Matrix4();
/**
 * Two-bone arm: turn the shoulder and bend the elbow so the hand reaches `target` (in the
 * shoulder's parent's space). The elbow points along `pole` (down and out, like a real arm).
 */
function reach(arm, target, pole) {
  const sh = arm.shoulder.position;
  _d.copy(target).sub(sh);
  const d = clamp(_d.length(), Math.abs(UPPER - LOWER) + 0.01, UPPER + LOWER - 0.005);
  _d.normalize();
  const a = Math.acos(clamp((UPPER * UPPER + d * d - LOWER * LOWER) / (2 * UPPER * d), -1, 1));      // at the shoulder
  const bend = Math.PI - Math.acos(clamp((UPPER * UPPER + LOWER * LOWER - d * d) / (2 * UPPER * LOWER), -1, 1));
  _p.copy(pole).addScaledVector(_d, -pole.dot(_d)).normalize();
  _u.copy(_d).multiplyScalar(Math.cos(a)).addScaledVector(_p, Math.sin(a));      // upper arm direction
  // the shoulder's own axes: -Y along the upper arm, +Z the way the forearm bends (toward the target)
  _w.copy(_d).addScaledVector(_u, -_d.dot(_u)).normalize();
  const y = _t.copy(_u).negate();
  _x.crossVectors(y, _w);
  _m.makeBasis(_x, y, _w);
  arm.shoulder.quaternion.setFromRotationMatrix(_m);
  arm.elbow.rotation.set(-bend, 0, 0);
  arm.wrist.rotation.set(0, 0, 0);
}
const POLE = { L: new THREE.Vector3(0.4, -1, -0.25), R: new THREE.Vector3(-0.4, -1, -0.25) };
const _hand = new THREE.Vector3();

export class Avatar {
  constructor(scene, { name = 'Player', color = PLAYER_COLORS[0] } = {}) {
    const { geo, mat } = shared();
    this.scene = scene;
    this.root = new THREE.Group();
    this.root.name = 'avatar';
    scene.add(this.root);
    this.fx = { color: new THREE.Color(color), opacity: 1, emissive: 0 };
    this.meshes = [];
    const add = (parent, g, m, x = 0, y = 0, z = 0) => {
      const mesh = new THREE.Mesh(g, m);
      mesh.position.set(x, y, z);
      mesh.castShadow = true; mesh.receiveShadow = true;
      if (m === mat.cloth) mesh.userData.fx = this.fx;
      parent.add(mesh);
      batch(mesh, this.root);
      this.meshes.push(mesh);
      return mesh;
    };
    const pv = (n) => PART_BY_NAME[n].joint.pivot.map((v) => v * S);
    const ps = (n) => PART_BY_NAME[n].pos.map((v) => v * S);
    const rel = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];

    // torso: pelvis -> lower spine -> upper spine -> neck -> head
    const pelvisPos = ps('pelvis');
    this.pelvis = joint(this.root, 0, pelvisPos[1], 0);
    add(this.pelvis, geo.pelvis, mat.pants);
    const spineLo = pv('abdomen'), spineHi = pv('chest'), neck = pv('head');
    this.spine = joint(this.pelvis, 0, spineLo[1] - pelvisPos[1], 0);
    add(this.spine, geo.abdomen, mat.cloth, ...rel(ps('abdomen'), spineLo));
    this.chest = joint(this.spine, 0, spineHi[1] - spineLo[1], 0);
    add(this.chest, geo.chest, mat.cloth, ...rel(ps('chest'), spineHi));
    this.neck = joint(this.chest, 0, neck[1] - spineHi[1], 0);
    add(this.neck, geo.neck, mat.skin, 0, 0.04, 0);
    const hc = rel(ps('head'), neck);
    add(this.neck, geo.head, mat.skin, ...hc);
    add(this.neck, geo.cap, mat.cloth, hc[0], hc[1] + 0.012, hc[2] - 0.004);
    add(this.neck, geo.brim, mat.cloth, hc[0], hc[1] + 0.05, hc[2] + 0.085);
    add(this.neck, geo.visor, mat.visor, hc[0], hc[1] + 0.006, hc[2] + 0.052);

    // arms and legs, per side (+X is the figure's left, it faces +Z)
    this.arm = {}; this.leg = {};
    for (const s of ['L', 'R']) {
      const sh = pv(`upperArm${s}`), el = pv(`lowerArm${s}`), wr = pv(`hand${s}`);
      const shoulder = joint(this.chest, sh[0], sh[1] - spineHi[1], 0);
      add(shoulder, geo.upperArm, mat.cloth, ...rel(ps(`upperArm${s}`), sh));
      const elbow = joint(shoulder, 0, el[1] - sh[1], 0);
      add(elbow, geo.lowerArm, mat.cloth, ...rel(ps(`lowerArm${s}`), el));
      const wrist = joint(elbow, 0, wr[1] - el[1], 0);
      add(wrist, geo.hand, mat.gloves, ...rel(ps(`hand${s}`), wr));
      this.arm[s] = { shoulder, elbow, wrist };
      const hp = pv(`thigh${s}`), kn = pv(`shin${s}`), an = pv(`foot${s}`);
      const hip = joint(this.pelvis, hp[0], hp[1] - pelvisPos[1], 0);
      add(hip, geo.thigh, mat.pants, ...rel(ps(`thigh${s}`), hp));
      const knee = joint(hip, 0, kn[1] - hp[1], 0);
      add(knee, geo.shin, mat.pants, ...rel(ps(`shin${s}`), kn));
      const ankle = joint(knee, 0, an[1] - kn[1], 0);
      add(ankle, geo.foot, mat.boots, ...rel(ps(`foot${s}`), an));
      this.leg[s] = { hip, knee, ankle };
    }

    // what's in the hands: posed along the aim (it points where the player looks)
    this.aim = joint(this.root, 0, AIM_Y, 0);
    this.items = {};
    const item = (key, build) => { const g = new THREE.Group(); g.visible = false; this.aim.add(g); build(g); this.items[key] = g; return g; };
    const part = (g, gg, m, x, y, z, sx = 1, sy = 1, sz = 1, rx = 0) => { const mm = add(g, gg, m, x, y, z); mm.scale.set(sx, sy, sz); mm.rotation.x = rx; return mm; };
    // hands: where each hand holds it (in the item's own space); the arms reach there
    const hands = (g, R, L = null) => { g.userData.hands = { R: new THREE.Vector3(...R), L: L && new THREE.Vector3(...L) }; };
    item('pistol', (g) => {
      g.position.set(-0.03, -0.1, 0.46); part(g, geo.slide, mat.metal, 0, 0, 0); part(g, geo.grip, mat.metal, 0, -0.06, -0.06, 1, 1, 1, -0.25);
      g.userData.muzzle = new THREE.Vector3(0, 0, 0.11); hands(g, [0, -0.07, -0.07], [0.03, -0.075, -0.05]);
    });
    item('fists', (g) => { g.position.set(0, -0.2, 0.24); hands(g, [-0.11, 0, 0], [0.12, 0.03, 0.03]); });
    item('shotgun', (g) => {
      g.position.set(-0.13, -0.08, 0.02); hands(g, [0, -0.06, 0.1], [0, -0.035, 0.36]);
      part(g, geo.receiver, mat.metal, 0, 0, 0.18); part(g, geo.barrel, mat.metal, 0, 0.018, 0.55, 1, 1, 0.55);
      part(g, geo.barrel, mat.metal, 0, -0.016, 0.46, 1.4, 1.4, 0.36); part(g, geo.stock, mat.metal, 0, -0.025, -0.08);
      g.userData.muzzle = new THREE.Vector3(0, 0.018, 0.83);
    });
    item('sniper', (g) => {
      g.position.set(-0.13, -0.08, 0.02); hands(g, [0, -0.06, 0.1], [0, -0.03, 0.38]);
      part(g, geo.receiver, mat.metal, 0, 0, 0.2); part(g, geo.barrel, mat.metal, 0, 0.01, 0.65, 1, 1, 0.7);
      part(g, geo.scope, mat.metal, 0, 0.07, 0.2); part(g, geo.stock, mat.wood, 0, -0.02, -0.08, 1, 1.1, 1);
      g.userData.muzzle = new THREE.Vector3(0, 0.01, 1.0);
    });
    item('musket', (g) => {
      g.position.set(-0.13, -0.08, 0.02); hands(g, [0, -0.05, 0.12], [0, -0.03, 0.4]);
      part(g, geo.stock, mat.wood, 0, -0.02, 0.2, 0.9, 0.7, 2.2); part(g, geo.barrel, mat.metal, 0, 0.025, 0.72, 1.1, 1.1, 0.95);
      g.userData.muzzle = new THREE.Vector3(0, 0.025, 1.2);
    });
    item('grenade', (g) => { g.position.set(-0.2, -0.3, 0.3); part(g, geo.ball, mat.metal, 0, 0, 0); hands(g, [0, -0.01, -0.02]); });
    item('gadget', (g) => { g.position.set(-0.1, -0.16, 0.4); part(g, geo.box, mat.metal, 0, 0, 0, 0.08, 0.08, 0.3); part(g, geo.ball, mat.glow, 0, 0, 0.17, 0.7, 0.7, 0.7); hands(g, [0, -0.05, -0.06]); });
    item('machete', (g) => { g.position.set(-0.2, -0.3, 0.28); part(g, geo.box, mat.boots, 0, 0, 0, 0.03, 0.035, 0.13); part(g, geo.blade, mat.steel, 0, 0.01, 0.29); hands(g, [0, 0, 0]); });
    item('medkit', (g) => { g.position.set(0, -0.32, 0.34); part(g, geo.box, mat.red, 0, 0, 0, 0.2, 0.14, 0.08); hands(g, [-0.1, 0, 0], [0.1, 0, 0]); });
    item('defib', (g) => { g.position.set(0, -0.3, 0.36); part(g, geo.box, mat.boots, -0.1, 0, 0, 0.07, 0.1, 0.12); part(g, geo.box, mat.boots, 0.1, 0, 0, 0.07, 0.1, 0.12); hands(g, [-0.1, -0.02, 0], [0.1, -0.02, 0]); });
    this.flash = new THREE.Sprite(new THREE.SpriteMaterial({ map: flashTex, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false, opacity: 0 }));
    this.flash.scale.setScalar(0.35);
    this.flash.visible = false;
    this.aim.add(this.flash);
    this.flashT = 0;

    // name tag (seen through walls, so you can find each other)
    this.tagCanvas = document.createElement('canvas'); this.tagCanvas.width = 256; this.tagCanvas.height = 64;
    this.tagTex = new THREE.CanvasTexture(this.tagCanvas); this.tagTex.colorSpace = THREE.SRGBColorSpace;
    this.tag = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.tagTex, transparent: true, depthTest: false, depthWrite: false }));
    this.tag.renderOrder = 10;
    this.tag.position.set(0, 2.08, 0);
    this.tag.scale.set(0.8, 0.2, 1);
    this.root.add(this.tag);
    this.name = ''; this.color = '';
    this.set({ name, color });

    // animation state
    this.phase = 0;
    this.walk = 0;          // 0 standing .. 1 full stride
    this.air = 0;
    this.crouch = 0;
    this.dead = 0;
    this.holding = null;
    this.lastPos = null;
    this.vel = new THREE.Vector3();
  }

  set({ name, color }) {
    if (color && color !== this.color) { this.color = color; this.fx.color.set(color); }
    if (name !== undefined && name !== this.name) {
      this.name = name;
      const g = this.tagCanvas.getContext('2d');
      g.clearRect(0, 0, 256, 64);
      g.font = '700 30px Inter, system-ui, sans-serif';
      const w = Math.min(244, g.measureText(name).width + 34);
      g.fillStyle = 'rgba(12,14,18,.62)';
      g.beginPath(); g.roundRect?.(128 - w / 2, 10, w, 44, 12); g.fill();
      g.fillStyle = this.color || '#fff'; g.beginPath(); g.arc(128 - w / 2 + 16, 32, 6, 0, Math.PI * 2); g.fill();
      g.fillStyle = '#f2f5f8'; g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText(name, 128 + 7, 33, 210);
      this.tagTex.needsUpdate = true;
    }
  }

  /** An arm hanging at the side, swinging with the walk. */
  hang(sd, swing, ph) {
    const a = this.arm[sd], k = sd === 'L' ? 1 : -1;
    a.shoulder.rotation.set(k * swing * Math.sin(ph), 0, k * 0.08);
    a.elbow.rotation.set(-0.25, 0, 0);
    a.wrist.rotation.set(0, 0, 0);
  }

  /** A shot from this player: a flash at the muzzle. */
  fired() {
    const it = this.holding && this.items[this.holding];
    if (!it || !it.userData.muzzle) return;
    this.flash.position.copy(it.position).add(it.userData.muzzle);
    this.flashT = 0.06;
    this.flash.material.rotation = Math.random() * 6.28;
  }

  /** Where shots leave the gun in their hands (world), or null when they hold no gun. */
  muzzleWorld(out = new THREE.Vector3()) {
    const it = this.holding && this.items[this.holding];
    if (!it || !it.userData.muzzle || !this.root.visible) return null;
    it.updateWorldMatrix(true, false);
    return it.localToWorld(out.copy(it.userData.muzzle));
  }

  /**
   * s: { pos (feet), yaw, pitch, crouch 0..1, tool (name), onGround, sprinting, dead }.
   * visible: false when the map hides where they are (another floor of the tower).
   */
  update(dt, s, camera, visible = true) {
    this.root.visible = visible;
    if (!visible) return;
    const r = this.root;
    // speed from how far they moved (smoothed), in the figure's own frame
    if (this.lastPos && dt > 0) {
      const vx = (s.pos.x - this.lastPos.x) / dt, vz = (s.pos.z - this.lastPos.z) / dt;
      const k = Math.min(1, dt * 10);
      if (Math.hypot(vx, vz) < 20) { this.vel.x += (vx - this.vel.x) * k; this.vel.z += (vz - this.vel.z) * k; }
    }
    this.lastPos = (this.lastPos || new THREE.Vector3()).copy(s.pos);
    r.position.copy(s.pos);
    r.rotation.set(0, s.yaw + Math.PI, 0);
    const fwdX = -Math.sin(s.yaw), fwdZ = -Math.cos(s.yaw);
    const fwd = this.vel.x * fwdX + this.vel.z * fwdZ, side = this.vel.x * -fwdZ + this.vel.z * fwdX;
    const speed = Math.hypot(this.vel.x, this.vel.z);
    const k = (rate) => 1 - Math.exp(-rate * dt);
    this.walk += (clamp(speed / 4.5) - this.walk) * k(8);
    this.air += ((s.onGround ? 0 : 1) - this.air) * k(10);
    this.crouch += ((s.crouch || 0) - this.crouch) * k(12);
    this.dead += ((s.dead ? 1 : 0) - this.dead) * k(5);
    const stride = s.sprinting ? 1.9 : 1.35;
    this.phase += dt * speed / stride * Math.PI * 2 * (fwd < -0.2 ? -1 : 1);
    const ph = this.phase, A = 0.62 * this.walk * (1 - this.air * 0.8), c = this.crouch, air = this.air;
    const sinP = Math.sin(ph), cosP = Math.cos(ph);
    const strafe = speed > 0.3 ? clamp(side / speed, -1, 1) * Math.abs(clamp(side / 3)) : 0;
    const fwdAmt = 1 - Math.abs(strafe) * 0.6;

    // legs
    for (const sd of ['L', 'R']) {
      const sgn = sd === 'L' ? 1 : -1, p = sd === 'L' ? 0 : Math.PI;
      const sw = Math.sin(ph + p), cw = Math.cos(ph + p);
      const L = this.leg[sd];
      const hip = -A * sw * fwdAmt - c * 1.25 - air * 0.55;
      const knee = (0.12 + 0.95 * A) * Math.max(0, cw) * (1 - air) + c * 2.1 + air * 1.0;
      L.hip.rotation.set(hip, 0, strafe * A * sw * 0.6 * sgn);
      L.knee.rotation.set(knee, 0, 0);
      L.ankle.rotation.set(-(hip + knee) * 0.75, 0, 0);
    }
    this.pelvis.position.y = PART_BY_NAME.pelvis.pos[1] * S - c * 0.43 - 0.03 * A * Math.abs(cosP) - air * 0.12;
    this.pelvis.rotation.set(0, 0.12 * A * sinP, 0);
    // torso: leans into a sprint and a crouch, looks up and down a little with the head
    const lean = c * 0.32 + (s.sprinting ? 0.18 : 0.06) * this.walk;
    this.spine.rotation.set(lean * 0.5, -0.1 * A * sinP, 0);
    this.chest.rotation.set(lean * 0.5 - s.pitch * 0.15, 0, 0);
    this.neck.rotation.set(-s.pitch * 0.6 - lean * 0.6 + s.pitch * 0.15, 0, 0);

    // what's in the hands follows the aim
    const hold = s.dead ? 'none' : HOLD[s.tool] || 'none';
    const p = s.pitch;
    if (hold !== this.holding) {
      for (const [key, g] of Object.entries(this.items)) g.visible = key === hold;
      this.holding = hold;
    }
    this.aim.position.y = AIM_Y - c * 0.45 - air * 0.12;
    // fists stay at the chin whatever the aim; everything else turns with it
    this.aim.rotation.set(hold === 'fists' ? -p * 0.3 : -p, 0, 0);
    // arms: the hands go to where the item is held (two-bone reach), or swing while walking
    const it = this.items[hold];
    const grip = it?.userData.hands;
    const swing = A * 0.7;
    if (grip) {
      r.updateMatrixWorld(true);
      this.chest.updateWorldMatrix(false, false);
      for (const sd of ['L', 'R']) {
        const at = grip[sd];
        if (at) reach(this.arm[sd], this.chest.worldToLocal(it.localToWorld(_hand.copy(at))), POLE[sd]);
        else this.hang(sd, swing, ph);
      }
    } else {
      this.hang('L', swing, ph); this.hang('R', swing, ph);
    }
    // dead: on the ground
    if (this.dead > 0.01) {
      r.rotation.x = -this.dead * Math.PI / 2;
      r.position.y += this.dead * 0.12;
    }
    // muzzle flash
    if (this.flashT > 0) { this.flashT -= dt; this.flash.visible = true; this.flash.material.opacity = Math.max(0, this.flashT / 0.06); } else this.flash.visible = false;
    // name tag: smaller up close, readable far away
    if (camera) {
      const d = camera.position.distanceTo(r.position);
      const sc = clamp(0.55 + d * 0.035, 0.6, 2.4);
      this.tag.scale.set(sc * 0.8, sc * 0.2, 1);
      this.tag.material.opacity = d < 1.5 ? 0 : 1;
    }
  }

  dispose() {
    this.scene.remove(this.root);
    this.tagTex.dispose();
    this.tag.material.dispose();
    this.flash.material.dispose();
  }
}

export const holdOf = (toolName) => HOLD[toolName] || 'none';
