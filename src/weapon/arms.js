import * as THREE from 'three';

const _h = new THREE.Vector3(), _s = new THREE.Vector3(), _m = new THREE.Matrix4(), _q = new THREE.Quaternion();
const _a = new THREE.Vector3(), _b = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0), ZAX = new THREE.Vector3(0, 0, 1);

/** Materials shared by every arm (and tracked by the material quality system). */
export const ARM_MATERIALS = {
  skin: new THREE.MeshStandardMaterial({ color: 0xe8b98f, roughness: 0.72, metalness: 0 }),
  sleeve: new THREE.MeshStandardMaterial({ color: 0x3c4654, roughness: 0.85, metalness: 0 }),
  cuff: new THREE.MeshStandardMaterial({ color: 0x2a313b, roughness: 0.8, metalness: 0 }),
};

/** One blocky arm: a rectangular hand at the origin, forearm and sleeve running along +Z. */
function buildArm(handSize) {
  const g = new THREE.Group();
  const hand = new THREE.Mesh(new THREE.BoxGeometry(handSize, handSize, handSize * 1.15), ARM_MATERIALS.skin);
  const fore = new THREE.Mesh(new THREE.BoxGeometry(handSize * 0.88, handSize * 0.88, 1).translate(0, 0, 0.5), ARM_MATERIALS.skin);
  const cuff = new THREE.Mesh(new THREE.BoxGeometry(handSize * 1.06, handSize * 1.06, 0.03).translate(0, 0, 0.015), ARM_MATERIALS.cuff);
  const sleeve = new THREE.Mesh(new THREE.BoxGeometry(handSize, handSize, 1).translate(0, 0, 0.5), ARM_MATERIALS.sleeve);
  // things held in this hand (a shotgun shell, a grenade pin) go in here
  const hold = new THREE.Group();
  g.add(hand, fore, cuff, sleeve, hold);
  for (const m of [hand, fore, cuff, sleeve]) m.castShadow = false;
  return { g, hand, fore, cuff, sleeve, hold };
}

const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

/**
 * Sample a hand track: keys = [[time, targetName], ...]. Between two keys the hand eases from one
 * target to the next; targets are looked up live every frame (so a hand follows a moving pump,
 * magazine or grenade pin). targets[name] is a Vector3 or a function returning one.
 */
export function sampleHand(keys, t, targets, out = new THREE.Vector3()) {
  const get = (n, v) => { const x = targets[n]; return v.copy(typeof x === 'function' ? x() : x); };
  if (t <= keys[0][0]) return get(keys[0][1], out);
  for (let i = 1; i < keys.length; i++) {
    if (t <= keys[i][0]) {
      const [t0, n0] = keys[i - 1], [t1, n1] = keys[i];
      if (n0 === n1) return get(n0, out);
      const u = ease((t - t0) / Math.max(1e-6, t1 - t0));
      get(n0, _a); get(n1, _b);
      return out.copy(_a).lerp(_b, u);
    }
  }
  return get(keys[keys.length - 1][1], out);
}

/**
 * Roblox-style rectangular arms for first-person viewmodels. Each frame the hands are placed on
 * anchor points (children of the held item, so they follow every animation) and the arms run
 * back towards shoulders just off-screen.
 */
export class BlockArms {
  constructor(scene, { handSize = 0.066, shoulderRight = [0.27, -0.44, -0.06], shoulderLeft = [-0.27, -0.44, -0.06] } = {}) {
    this.right = buildArm(handSize);
    this.left = buildArm(handSize);
    scene.add(this.right.g, this.left.g);
    // shoulders in camera space (just below / behind the view)
    this.shoulder = { right: new THREE.Vector3(...shoulderRight), left: new THREE.Vector3(...shoulderLeft) };
  }

  /**
   * Place one arm. hand = position in camera space. roll = twist of the hand block around the
   * forearm (rad). fist = slightly bigger, closed hand.
   */
  set(side, hand, { visible = true, roll = 0, fist = false } = {}) {
    const a = this[side];
    a.g.visible = visible;
    if (!visible) return;
    const sh = this.shoulder[side];
    _h.copy(hand);
    a.g.position.copy(_h);
    // +Z of the group points at the shoulder
    _m.lookAt(sh, _h, UP);
    a.g.quaternion.setFromRotationMatrix(_m);
    if (roll) a.g.quaternion.multiply(_q.setFromAxisAngle(ZAX, roll));
    const len = Math.max(0.05, _s.copy(sh).sub(_h).length());
    const foreLen = Math.min(0.2, len * 0.5);
    a.fore.scale.z = foreLen; a.fore.position.z = 0.03;
    a.cuff.position.z = 0.03 + foreLen;
    a.sleeve.position.z = 0.03 + foreLen + 0.02;
    a.sleeve.scale.z = Math.max(0.01, len - foreLen);
    a.hand.scale.setScalar(fist ? 1.1 : 1);
  }

  /** Place an arm on an Object3D anchor (its world position in the viewmodel scene). */
  setOn(side, anchor, opts) {
    anchor.updateWorldMatrix(true, false);
    this.set(side, anchor.getWorldPosition(new THREE.Vector3()), opts);
  }

  hide() { this.right.g.visible = false; this.left.g.visible = false; }
}

/** World (viewmodel scene) position of an anchor object. */
export function anchorPos(obj, out = new THREE.Vector3()) {
  obj.updateWorldMatrix(true, false);
  return obj.getWorldPosition(out);
}
