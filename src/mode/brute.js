import * as THREE from 'three';
import { mergeGeometries } from '../world/build.js';
import { clamp } from '../core/util.js';

/**
 * The Big Brute: VS Undead's boss, every third wave. A hulking, hunched zombie about three metres
 * tall, with a barrel chest, huge shoulders and arms and a small head. Built from simple shapes on
 * a hierarchy of joints and animated by hand (no physics): it digs itself out of the ground, walks,
 * swipes, roars up minions and falls.
 *
 * This file is only the model and its poses; the boss's behaviour (on the host's game) and its
 * damage live in undead.js. Faces -Z.
 */

const M = {
  skin: new THREE.MeshStandardMaterial({ color: 0x75825f, roughness: 0.82 }),
  skinDark: new THREE.MeshStandardMaterial({ color: 0x56604a, roughness: 0.86 }),
  trousers: new THREE.MeshStandardMaterial({ color: 0x2f2a22, roughness: 0.95 }),
  belt: new THREE.MeshStandardMaterial({ color: 0x3a2617, roughness: 0.7 }),
  iron: new THREE.MeshStandardMaterial({ color: 0x3a3b3f, roughness: 0.45, metalness: 0.75 }),
  wound: new THREE.MeshStandardMaterial({ color: 0x5c100d, roughness: 0.35 }),
  bone: new THREE.MeshStandardMaterial({ color: 0xd6ccae, roughness: 0.6 }),
  mouth: new THREE.MeshStandardMaterial({ color: 0x220405, roughness: 0.6 }),
  eyes: new THREE.MeshStandardMaterial({ color: 0xffd060, emissive: 0xffa020, emissiveIntensity: 3 }),
  hole: new THREE.MeshBasicMaterial({ color: 0x0b0806, transparent: true, opacity: 0, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2 }),
  dirt: new THREE.MeshStandardMaterial({ color: 0x3b3022, roughness: 1 }),
};
export const BRUTE_MATERIALS = M;

const P = (geo, x, y, z, rx = 0, ry = 0, rz = 0, sx = 1, sy = 1, sz = 1) => ({ geo, matrix: new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz)), new THREE.Vector3(sx, sy, sz)) });
const ball = (r, w = 14, h = 10) => new THREE.SphereGeometry(r, w, h);
const box = (w, h, d) => new THREE.BoxGeometry(w, h, d);
const cap = (r, len, s = 12) => new THREE.CapsuleGeometry(r, len, 4, s);
const cone = (r, h, s = 6) => new THREE.ConeGeometry(r, h, s);

/** One mesh per material on a joint (a few draw calls for the whole body). zone: what a hit there counts as. */
function part(parent, byMat, brute, zone) {
  const out = [];
  for (const [mat, geos] of byMat) {
    if (!geos.length) continue;
    const m = new THREE.Mesh(mergeGeometries(geos), mat);
    m.castShadow = true; m.receiveShadow = true;
    m.userData.brute = brute; m.userData.zone = zone;
    parent.add(m); out.push(m);
    brute.meshes.push(m);
  }
  return out;
}
function joint(parent, x, y, z) { const g = new THREE.Group(); g.position.set(x, y, z); parent.add(g); return g; }

const HIP_Y = 1.42;           // hips above the ground, standing
const SHOULDER = 1.12;        // shoulders above the hips (along the spine)
const ARM = 1.45;             // shoulder to fingertips

export class BruteModel {
  constructor() {
    this.meshes = [];
    const root = this.root = new THREE.Group();
    const hips = this.hips = joint(root, 0, HIP_Y, 0);
    // ---- hips and legs
    part(hips, [
      [M.trousers, [P(ball(0.5), 0, 0.02, 0.02, 0, 0, 0, 1.05, 0.55, 0.78)]],
      [M.belt, [P(box(1.0, 0.12, 0.72), 0, 0.22, 0.01)]],
      [M.iron, [P(box(0.16, 0.13, 0.04), 0, 0.22, -0.37)]],
    ], this, 'body');
    this.legs = {};
    for (const s of [1, -1]) {
      const hip = joint(hips, 0.3 * s, -0.05, 0.02);
      part(hip, [
        [M.trousers, [P(cap(0.23, 0.38), 0, -0.34, 0, 0, 0, 0, 1.05, 1, 1), P(cap(0.16, 0.12), 0.02 * s, -0.66, -0.04)]],
        [M.wound, s > 0 ? [P(box(0.2, 0.16, 0.04), 0.05, -0.3, -0.22, 0.1)] : []],
      ], this, 'body');
      const knee = joint(hip, 0, -0.7, 0);
      part(knee, [
        [M.trousers, [P(cap(0.19, 0.3), 0, -0.24, 0.02)]],
        [M.skinDark, [P(cap(0.15, 0.16), 0, -0.5, 0.01)]],
      ], this, 'body');
      const ankle = joint(knee, 0, -0.62, 0);
      part(ankle, [
        [M.skinDark, [P(box(0.34, 0.16, 0.56), 0, -0.02, -0.1), P(ball(0.13, 8, 6), 0, 0.02, 0.1)]],
        [M.bone, [P(cone(0.035, 0.12, 5), 0.1, -0.05, -0.4, -Math.PI / 2), P(cone(0.035, 0.12, 5), 0, -0.05, -0.41, -Math.PI / 2), P(cone(0.035, 0.12, 5), -0.1, -0.05, -0.4, -Math.PI / 2)]],
      ], this, 'body');
      this.legs[s > 0 ? 'R' : 'L'] = { hip, knee, ankle };
    }
    // ---- torso: belly, barrel chest, back, the traps that swallow the neck
    const spine = this.spine = joint(hips, 0, 0.18, 0);
    part(spine, [
      [M.skin, [
        P(ball(0.5), 0, 0.28, -0.02, 0, 0, 0, 0.92, 0.72, 0.78),                  // belly
        P(ball(0.62), 0, 0.78, 0.02, 0, 0, 0, 1.18, 0.78, 0.82),                  // chest
        P(ball(0.3), 0.27, 0.86, -0.38, 0.2, 0, 0, 1.05, 0.72, 0.55),            // pecs
        P(ball(0.3), -0.27, 0.86, -0.38, 0.2, 0, 0, 1.05, 0.72, 0.55),
        P(ball(0.42), 0, 1.06, 0.12, 0, 0, 0, 1.3, 0.55, 0.85),                  // traps
        P(ball(0.38), 0, 0.72, 0.34, 0, 0, 0, 1.4, 1.05, 0.6),                   // the hunched back
      ]],
      [M.skinDark, [
        // abs: two rows of blocks
        ...[0.18, 0.36].flatMap((y) => [P(box(0.17, 0.14, 0.08), 0.1, y, -0.37), P(box(0.17, 0.14, 0.08), -0.1, y, -0.37)]),
      ]],
      [M.wound, [P(box(0.32, 0.22, 0.04), -0.25, 0.58, -0.47, 0.25, 0.2, 0.3), P(box(0.18, 0.4, 0.05), 0.46, 0.5, 0.2, 0, 0.9, 0.1), P(box(0.12, 0.3, 0.04), -0.1, 1.04, 0.5, -0.3, 0, 0.5)]],
      // ribs showing through the torn side, and bone spurs along the spine
      [M.bone, [
        ...[0.46, 0.56, 0.66].map((y) => P(box(0.05, 0.03, 0.34), 0.62, y, 0.05, 0, 0.15, 0.1)),
        ...[0.62, 0.84, 1.04].map((y, i) => P(cone(0.05, 0.22 - i * 0.03, 5), 0, y + 0.05, 0.62 - i * 0.05, 0.9)),
      ]],
    ], this, 'body');
    // ---- head (small on that body), heavy brow, glowing eyes, a jaw that drops open
    const neck = this.neck = joint(spine, 0, 1.12, -0.28);
    part(neck, [
      [M.skin, [P(box(0.4, 0.4, 0.42), 0, 0.2, -0.04), P(box(0.44, 0.1, 0.14), 0, 0.32, -0.25)]],
      [M.skinDark, [P(box(0.3, 0.08, 0.2), 0, 0.42, 0.02), P(box(0.1, 0.12, 0.08), 0, 0.2, -0.28)]],
      [M.eyes, [P(box(0.08, 0.04, 0.03), 0.1, 0.25, -0.26), P(box(0.08, 0.04, 0.03), -0.1, 0.25, -0.26)]],
      [M.mouth, [P(box(0.3, 0.1, 0.24), 0, 0.03, -0.12)]],
    ], this, 'head');
    const jaw = this.jaw = joint(neck, 0, 0.06, 0.04);
    part(jaw, [
      [M.skinDark, [P(box(0.38, 0.12, 0.38), 0, -0.04, -0.15)]],
      [M.bone, [P(cone(0.022, 0.07, 4), 0.1, 0.05, -0.31), P(cone(0.022, 0.07, 4), -0.1, 0.05, -0.31), P(cone(0.018, 0.05, 4), 0.03, 0.04, -0.32), P(cone(0.018, 0.05, 4), -0.04, 0.04, -0.32)]],
    ], this, 'head');
    // ---- arms: boulder shoulders, thick upper arms, huge forearms and hands with claws
    this.arms = {};
    for (const s of [1, -1]) {
      const sh = joint(spine, 0.78 * s, SHOULDER - 0.18, 0.02);
      part(sh, [
        [M.skin, [P(ball(0.34), 0.04 * s, 0.05, 0, 0, 0, 0, 1.05, 1, 1), P(cap(0.22, 0.36), 0.02 * s, -0.36, 0, 0, 0, 0, 1.1, 1, 1.05)]],
        [M.wound, s < 0 ? [P(box(0.06, 0.34, 0.2), -0.22, -0.32, -0.04, 0, 0, -0.05)] : []],
        [M.iron, s > 0 ? [P(new THREE.TorusGeometry(0.24, 0.035, 5, 12), 0.02, -0.5, 0, Math.PI / 2)] : []],     // a shackle
      ], this, 'body');
      const elbow = joint(sh, 0.02 * s, -0.68, 0);
      part(elbow, [
        [M.skin, [P(cap(0.2, 0.18), 0, -0.14, 0), P(cap(0.25, 0.22), 0, -0.4, -0.01, 0, 0, 0, 1.05, 1, 1)]],
        [M.skinDark, [P(box(0.05, 0.4, 0.05), 0.15 * s, -0.33, -0.18, 0.05)]],      // a vein
      ], this, 'body');
      const hand = joint(elbow, 0, -0.66, 0);
      part(hand, [
        [M.skinDark, [P(box(0.36, 0.26, 0.3), 0, -0.08, 0), P(box(0.1, 0.18, 0.1), 0.14 * s, -0.04, -0.17)]],
        [M.skin, [-0.12, -0.04, 0.04, 0.12].map((x) => P(box(0.08, 0.2, 0.09), x, -0.29, -0.06, 0.25))],
        [M.bone, [-0.12, -0.04, 0.04, 0.12].map((x) => P(cone(0.03, 0.1, 4), x, -0.43, -0.1, Math.PI + 0.35))],
      ], this, 'body');
      this.arms[s > 0 ? 'R' : 'L'] = { sh, elbow, hand };
    }
    // the hole it digs out of: a dark pit with heaped-up dirt around it
    this.hole = new THREE.Group();
    const pit = new THREE.Mesh(new THREE.CircleGeometry(1.35, 20), M.hole);
    pit.rotation.x = -Math.PI / 2; pit.position.y = 0.025; pit.renderOrder = 1;
    this.pit = pit;
    this.hole.add(pit);
    const clods = [];
    for (let i = 0; i < 16; i++) {
      const a = (i / 16) * Math.PI * 2 + Math.random() * 0.3, r = 1.25 + Math.random() * 0.45, s = 0.22 + Math.random() * 0.25;
      clods.push(P(new THREE.DodecahedronGeometry(s, 0), Math.cos(a) * r, -0.02, Math.sin(a) * r, Math.random() * 3, Math.random() * 3, 0, 1.3, 0.5, 1.1));
    }
    this.mound = new THREE.Mesh(mergeGeometries(clods), M.dirt);
    this.mound.receiveShadow = true;
    this.hole.add(this.mound);
    this.hole.visible = false;
    this.root.visible = false;
    this.flinch = 0;            // a hit jolts the upper body back
    this.walkPh = 0;
  }

  /**
   * Pose the joints. p: { y (hips above ground), lean (spine forward, rad), aR/aL (arm forward from
   * hanging, rad), rR/rL (arm out to the side), eR/eL (elbow bend), head (up), jaw (open), legs:
   * [thighR, kneeR, thighL, kneeL] }.
   */
  apply(p) {
    this.hips.position.y = p.y;
    this.hips.position.z = -(p.z || 0);   // forward is -Z
    this.hips.rotation.x = -(p.hipLean || 0);
    this.hips.rotation.z = p.sway || 0;
    this.spine.rotation.x = -p.lean + this.flinch * 0.25;
    this.spine.rotation.y = p.twist || 0;
    const A = this.arms;
    A.R.sh.rotation.set(p.aR, 0, p.rR || 0); A.L.sh.rotation.set(p.aL, 0, -(p.rL || 0));
    A.R.elbow.rotation.x = p.eR || 0; A.L.elbow.rotation.x = p.eL || 0;
    A.R.hand.rotation.x = p.wR || 0; A.L.hand.rotation.x = p.wL || 0;
    this.neck.rotation.x = (p.head || 0) - this.flinch * 0.3;
    this.neck.rotation.y = p.headYaw || 0;
    this.jaw.rotation.x = -(p.jaw || 0);
    const [tR, kR, tL, kL] = p.legs || ZERO_LEGS;
    this.legs.R.hip.rotation.x = tR; this.legs.R.knee.rotation.x = -kR; this.legs.R.ankle.rotation.x = kR - tR - (p.hipLean || 0);
    this.legs.L.hip.rotation.x = tL; this.legs.L.knee.rotation.x = -kL; this.legs.L.ankle.rotation.x = kL - tL - (p.hipLean || 0);
  }

  setGlow(k) { M.eyes.emissiveIntensity = k; }
}
const ZERO_LEGS = [0, 0, 0, 0];

// ---------------------------------------------------------------- poses
const KEYS = ['y', 'z', 'lean', 'hipLean', 'aR', 'aL', 'rR', 'rL', 'eR', 'eL', 'wR', 'wL', 'head', 'jaw', 'tR', 'kR', 'tL', 'kL', 'twist', 'sway'];
const BASE = { y: HIP_Y, z: 0, lean: 0.22, hipLean: 0, aR: 0.25, aL: 0.25, rR: 0.32, rL: 0.32, eR: 0.45, eL: 0.45, wR: 0, wL: 0, head: 0.18, jaw: 0.12, tR: 0, kR: 0, tL: 0, kL: 0, twist: 0, sway: 0 };

/**
 * Digging out (EMERGE seconds): a hand bursts out of the dirt and claws at the air, slams down on
 * the ground, the other follows, it drags its head and shoulders out, climbs up onto its feet and
 * roars. Arm angles are relative to the leaning torso. t: seconds.
 */
export const EMERGE = 10.2;
const E = [
  [0.0, { y: -3.6, lean: 0.1, aR: 3.0, eR: 0.15, aL: 0.2, rR: 0.05, jaw: 0.3, head: 0.3 }],
  [1.4, { y: -3.15, lean: 0.1, aR: 3.0, eR: 0.15, aL: 0.2, rR: 0.05 }],
  [2.0, { y: -2.25, lean: 0.12, aR: 3.05, eR: 0.05, wR: 0.4, aL: 0.25, rR: 0.08 }],                  // the hand bursts out
  [2.4, { y: -2.1, lean: 0.12, aR: 2.95, eR: 0.3, wR: -0.3, aL: 0.25, rR: 0.15 }],
  [2.8, { y: -2.0, lean: 0.12, aR: 3.05, eR: 0.05, wR: 0.5, aL: 0.25, rR: 0.05 }],
  [3.15, { y: -1.95, lean: 0.15, aR: 3.1, eR: 0.0, wR: 0.2, aL: 0.25, rR: 0.05 }],
  [3.45, { y: -1.3, lean: 0.4, aR: 1.38, eR: 0.08, wR: 0.25, aL: 0.6, rR: 0.12 }],                   // slam
  [4.1, { y: -1.25, lean: 0.4, aR: 1.36, eR: 0.1, wR: 0.25, aL: 2.9, eL: 0.2, rL: 0.08 }],           // the other one comes up
  [4.6, { y: -1.2, lean: 0.42, aR: 1.36, eR: 0.12, wR: 0.25, aL: 2.95, eL: 0.05, rL: 0.08 }],
  [4.9, { y: -1.15, lean: 0.45, aR: 1.33, eR: 0.12, wR: 0.25, aL: 1.33, eL: 0.1, wL: 0.25, rL: 0.12 }], // and slams down
  [6.1, { y: -0.35, z: 0.35, lean: 0.95, aR: 0.4, eR: 0.35, wR: 0.5, aL: 0.4, eL: 0.35, wL: 0.5, rR: 0.25, rL: 0.25, head: 0.65, jaw: 0.35, tR: 0.9, kR: 1.6, tL: 0.4, kL: 0.8 }],  // drags itself up
  [7.0, { y: 0.55, z: 0.7, lean: 0.7, hipLean: 0.3, aR: 0.2, eR: 0.3, aL: 0.5, eL: 0.4, head: 0.55, jaw: 0.25, tR: 1.5, kR: 1.9, tL: 0.2, kL: 0.6, rR: 0.3, rL: 0.3 }],
  [7.8, { y: 1.22, z: 1.0, lean: 0.45, hipLean: 0.1, aR: 0.2, aL: 0.3, eR: 0.5, eL: 0.5, head: 0.3, jaw: 0.15, tR: 0.6, kR: 0.9, tL: 0.05, kL: 0.2, rR: 0.3, rL: 0.3 }],
  [8.3, { y: HIP_Y, z: 1.1, lean: 0.2, aR: 0.25, aL: 0.25, eR: 0.5, eL: 0.5, head: 0.2, jaw: 0.12, rR: 0.32, rL: 0.32 }],
  [8.75, { y: HIP_Y + 0.02, z: 1.1, lean: -0.18, aR: 0.55, aL: 0.55, rR: 1.15, rL: 1.15, eR: 1.4, eL: 1.4, head: 0.5, jaw: 0.75 }],   // ROAR
  [9.7, { y: HIP_Y + 0.02, z: 1.1, lean: -0.2, aR: 0.6, aL: 0.6, rR: 1.2, rL: 1.2, eR: 1.5, eL: 1.5, head: 0.55, jaw: 0.8 }],
  [EMERGE, { y: HIP_Y, z: 1.1, lean: 0.22, aR: 0.25, aL: 0.25, rR: 0.32, rL: 0.32, eR: 0.45, eL: 0.45, head: 0.18, jaw: 0.12 }],
];
// fill each key from the one before, so every frame has every value
for (let i = 0; i < E.length; i++) {
  const prev = i ? E[i - 1][1] : BASE;
  for (const k of KEYS) if (E[i][1][k] === undefined) E[i][1][k] = i ? prev[k] : BASE[k];
}
const ss = (u) => u * u * (3 - 2 * u);
function track(keys, t, out) {
  let i = 0;
  while (i < keys.length - 2 && t > keys[i + 1][0]) i++;
  const [t0, a] = keys[i], [t1, b] = keys[i + 1];
  const u = ss(clamp((t - t0) / Math.max(1e-3, t1 - t0)));
  for (const k of KEYS) out[k] = a[k] + (b[k] - a[k]) * u;
  return out;
}
/** Moments in the dig-out when something hits the ground (for dust, sounds and the camera). */
export const EMERGE_BEATS = { rumble: 0.1, burst: 1.95, slamR: 3.4, burstL: 4.05, slamL: 4.85, out: 6.0, stand: 7.7, roar: 8.6 };

const _p = {};
/**
 * The pose for an animation at time t. anim: 'emerge' | 'idle' | 'walk' | 'swipe' | 'roar' | 'die'.
 * walkPh: the walk cycle (radians), speed: 0..1 how hard it walks.
 */
export function brutePose(anim, t, { walkPh = 0, speed = 0, side = 1 } = {}) {
  const p = _p;
  if (anim === 'emerge') return legsOut(track(E, t, p));
  Object.assign(p, BASE);
  const breathe = Math.sin(t * 1.8) * 0.03;
  p.lean += breathe; p.jaw += Math.max(0, Math.sin(t * 0.9)) * 0.1;
  // walking: a heavy, rolling, knuckle-swinging stomp
  const w = speed, s = Math.sin(walkPh), c = Math.cos(walkPh);
  p.tR = s * 0.5 * w; p.tL = -s * 0.5 * w;
  p.kR = Math.max(0, -c) * 0.8 * w + 0.1 * w; p.kL = Math.max(0, c) * 0.8 * w + 0.1 * w;
  p.y = HIP_Y - Math.abs(c) * 0.06 * w - 0.04 * w;
  p.sway = s * 0.06 * w;
  p.twist = -s * 0.12 * w;
  p.aR = 0.25 - s * 0.45 * w; p.aL = 0.25 + s * 0.45 * w;
  p.lean += 0.12 * w;
  if (anim === 'swipe') {
    // wind up (0 .. 0.55), strike (.. 0.8), recover (.. 1.3); side 1: the right arm
    const wind = ss(clamp(t / 0.55)), hit = ss(clamp((t - 0.55) / 0.22)), back = ss(clamp((t - 0.85) / 0.45));
    const k = wind * (1 - back);
    const arm = side > 0 ? 'R' : 'L';
    const up = 2.7 * wind - 1.3 * hit, out = 0.9 * wind - 0.75 * hit;
    p['a' + arm] = p['a' + arm] * (1 - k) + (up + 0.6 * hit) * k;
    p['r' + arm] = p['r' + arm] * (1 - k) + out * k;
    p['e' + arm] = p['e' + arm] * (1 - k) + (1.2 * wind - 0.9 * hit) * k;
    p.twist += side * (0.4 * wind - 0.8 * hit) * (1 - back);
    p.lean += (-0.1 * wind + 0.35 * hit) * (1 - back);
    p.jaw += 0.4 * k;
  } else if (anim === 'roar') {
    // up on its toes, arms thrown wide, head back: the ground answers with zombies (2.2 s)
    const k = ss(clamp(t / 0.4)) * (1 - ss(clamp((t - 1.8) / 0.4)));
    const shake = Math.sin(t * 40) * 0.03 * k;
    Object.assign(p, mix(p, { lean: -0.2, aR: 0.6, aL: 0.6, rR: 1.2, rL: 1.2, eR: 1.45, eL: 1.45, head: 0.55 + shake, jaw: 0.8 }, k));
  } else if (anim === 'slam') {
    // both fists up over its head (0 .. 0.7), down into the ground (.. 0.9), and back up (.. 1.7)
    const up = ss(clamp(t / 0.7)), down = ss(clamp((t - 0.7) / 0.18)), back = ss(clamp((t - 1.05) / 0.6));
    const k = up * (1 - back);
    const raise = { lean: -0.25, aR: 2.9, aL: 2.9, rR: 0.15, rL: 0.15, eR: 0.35, eL: 0.35, head: 0.4, jaw: 0.6, y: HIP_Y + 0.05 };
    const smash = { lean: 0.85, aR: 1.0, aL: 1.0, rR: 0.1, rL: 0.1, eR: 0.15, eL: 0.15, head: -0.1, jaw: 0.7, y: HIP_Y - 0.35, tR: 0.5, kR: 0.9, tL: 0.5, kL: 0.9 };
    Object.assign(p, mix(p, raise, k * (1 - down)));
    if (down > 0) Object.assign(p, mix(p, smash, down * (1 - back)));
  } else if (anim === 'charge') {
    // a crouch and a bellow (0 .. 0.9), then a head-down, arms-back sprint
    const w2 = ss(clamp(t / 0.5)), run = ss(clamp((t - 0.85) / 0.25));
    Object.assign(p, mix(p, { lean: 0.55, aR: -0.2, aL: -0.2, rR: 0.5, rL: 0.5, eR: 1.0, eL: 1.0, jaw: 0.8, head: 0.35, y: HIP_Y - 0.2, tR: 0.4, kR: 0.8, tL: 0.4, kL: 0.8 }, w2 * (1 - run)));
    if (run > 0) {
      const s2 = Math.sin(walkPh), c2 = Math.cos(walkPh);
      Object.assign(p, mix(p, { lean: 0.75, head: 0.55, jaw: 0.5, aR: -0.5 - s2 * 0.5, aL: -0.5 + s2 * 0.5, rR: 0.35, rL: 0.35, eR: 1.1, eL: 1.1, tR: s2 * 0.9, tL: -s2 * 0.9, kR: Math.max(0, -c2) * 1.3 + 0.2, kL: Math.max(0, c2) * 1.3 + 0.2, y: HIP_Y - 0.1 - Math.abs(c2) * 0.1 }, run));
    }
  } else if (anim === 'die') {
    // knees give, it sags forward onto its hands, then down onto its face (3 s)
    const a = ss(clamp(t / 0.9)), b = ss(clamp((t - 0.9) / 0.9));
    Object.assign(p, mix(p, { y: 0.75, lean: 0.6, hipLean: 0.3, aR: 0.8, aL: 0.8, eR: 0.3, eL: 0.3, head: -0.2, jaw: 0.5, tR: 1.6, kR: 2.3, tL: 1.5, kL: 2.3 }, a));
    if (b > 0) Object.assign(p, mix(p, { y: 0.42, z: -0.9, lean: 1.45, hipLean: 0.9, aR: 2.3, aL: 2.1, rR: 0.6, rL: 0.7, eR: 0.2, eL: 0.4, head: 0.5, jaw: 0.3, tR: 0.7, kR: 0.4, tL: 0.6, kL: 0.6 }, b));
  }
  return legsOut(p);
}
function mix(a, b, k) { const o = {}; for (const key in b) o[key] = a[key] + (b[key] - a[key]) * k; return o; }
const _legs = [0, 0, 0, 0];
function legsOut(p) { _legs[0] = p.tR; _legs[1] = p.kR; _legs[2] = p.tL; _legs[3] = p.kL; p.legs = _legs; return p; }
