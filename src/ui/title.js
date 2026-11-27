import * as THREE from 'three';
import { basePose } from '../ragdoll/brain.js';
import { buildMachete } from '../weapon/modelsMedical.js';

// The title screen: the real game world, a slow cinematic camera, and a badly hurt dead ragdoll
// slumped against the long wall (shot, cut, burnt, a hand blown off and a forearm missing), its
// helmet knocked off beside it. It lives on a set far away from the play area, so you never
// find it while playing.

import { CONFIG } from '../config.js';

// The set is a wall of its own far outside the play area (Map.titleWall, 8 x 3 x 0.4 m), lost in
// the fog, so the body is never in the game you play.
const [TX, TZ] = CONFIG.map.titleSpot;
const WALL_Z = TZ + 0.2;        // front face of the set's wall
const SPOT = new THREE.Vector3(TX + 0.7, 0, WALL_Z + 0.2);
const _v = new THREE.Vector3(), _f = new THREE.Vector3();

export class TitleScene {
  constructor({ scene, ragdolls, gore, ballistics, physics, camera }) {
    this.scene = scene; this.ragdolls = ragdolls; this.gore = gore; this.ballistics = ballistics; this.physics = physics; this.camera = camera;
    this.corpse = null;
    this.time = Math.random() * 40;
    this.focus = new THREE.Vector3();
    // a machete dropped next to the body (only while the title screen is up)
    this.prop = buildMachete();
    this.prop.root.scale.setScalar(1);
    this.prop.root.rotation.set(-Math.PI / 2, 0, 0.9);
    this.prop.root.position.set(SPOT.x + 0.85, 0.008, SPOT.z + 0.75);
    this.prop.bloodMat.opacity = 0.85;
    this.prop.root.traverse((o) => { if (o.isMesh) o.castShadow = true; });
    this.prop.root.visible = false;
    scene.add(this.prop.root);
  }

  get alive() { return this.corpse && this.ragdolls.list.includes(this.corpse); }

  /** Make sure the corpse and its blood are there; rebuild them if Clean up wiped the blood. */
  ensure() {
    if (this.alive && !this.dirty) return this.corpse;
    if (this.corpse) this.ragdolls.remove(this.corpse);
    this.dirty = false;
    return this.build();
  }

  build() {
    const rd = this.ragdolls;
    const r = rd.spawn([SPOT.x, 0, SPOT.z], 0, { armor: { vest: true, helmet: true }, name: 'Unknown subject' });
    this.corpse = r;
    r.hidden = true;            // not counted as one of your ragdolls, kept by Remove all
    rd.keep = r;
    // Sitting on the floor, back against the wall, head dropped, one knee up.
    const pose = basePose();
    Object.assign(pose, {
      spine: 0.22, chest: 0.18, neck: 0.62, headYaw: 0.42, headRoll: 0.28,
      hipL: [1.25, 0.18], kneeL: 0.12, ankleL: 0.2,
      hipR: [1.55, 0.05], kneeR: 1.55, ankleR: -0.2,
      shoulderL: [0.08, 0.35], elbowL: 0.25,
      shoulderR: [0.55, -0.15], elbowR: 0.95,
    });
    const pelvisQ = new THREE.Quaternion().setFromEuler(new THREE.Euler(-0.38, 0, 0.06, 'YXZ'));
    r.placeInPose(pose, new THREE.Vector3(SPOT.x, 0.17, SPOT.z + 0.04), pelvisQ);

    // dead: no muscle tone, no twitching
    const h = r.health;
    h.alive = false; h.cardiacArrest = true; h.heartRate = 0; h.breathRate = 0; h.o2 = 18; h.consciousness = 0;
    h.brainDeath = 1; h.deathCause = 'Unknown';
    r.brain.setState('dead'); r.brain.stateTime = 99;

    const bal = this.ballistics, gore = this.gore;
    const lastTarget = bal.lastTarget;
    bal.silent = true;
    // gunshots from someone standing in front: two stopped by the vest, the rest went in
    const at = (part, off = [0, 0, 0]) => r.bodyPos(part).add(new THREE.Vector3(...off));
    const shoot = (from, part, off, opts) => {
      const o = new THREE.Vector3(...from), t = at(part, off);
      bal.fire(o, t.sub(o).normalize(), null, opts);
      for (let i = 0; i < 6; i++) bal.update(1 / 120, 1 / 120);
    };
    shoot([SPOT.x - 0.4, 1.5, SPOT.z + 3], 'chest', [0.06, 0.03, 0]);
    shoot([SPOT.x + 0.3, 1.5, SPOT.z + 3], 'chest', [-0.08, -0.05, 0]);
    shoot([SPOT.x + 0.5, 1.2, SPOT.z + 3.5], 'thighR', [0, 0.05, 0]);
    shoot([SPOT.x - 0.6, 1.2, SPOT.z + 3.2], 'thighL', [0.02, -0.05, 0]);
    shoot([SPOT.x + 0.2, 1.6, SPOT.z + 3], 'upperArmR', [0, 0, 0]);
    shoot([SPOT.x - 0.2, 1.6, SPOT.z + 2.5], 'shinL', [0, 0, 0]);
    // the helmet took a round and came off
    gore.dropHelmet(r, at('head').add(new THREE.Vector3(0, 0.15, 0)), new THREE.Vector3(1.2, 0, 1.8));
    r.removeArmor('helmet');
    // then a bullet in the face
    shoot([SPOT.x + 0.1, 1.45, SPOT.z + 2.2], 'head', [0.03, 0.02, 0]);

    // machete: throat cut, and the left forearm hacked off; the right hand blown away
    const cutAt = (part, local, dirLocal, kind = 'slash', along = new THREE.Vector3(1, -0.3, 0)) => {
      const res = h.cut(part, local, dirLocal, 1, kind, { dismember: false });
      const p = r.parts[part];
      const world = local.clone().applyQuaternion(p.group.quaternion).add(p.group.position);
      const dirW = dirLocal.clone().applyQuaternion(p.group.quaternion);
      gore.bladeWound(r, res, world, dirW, along.clone().applyQuaternion(p.group.quaternion).normalize());
      return res;
    };
    cutAt('head', new THREE.Vector3(0, -0.07, 0.09), new THREE.Vector3(0, 0.2, -1).normalize());
    cutAt('chest', new THREE.Vector3(0.05, 0.08, 0.14), new THREE.Vector3(0, 0, -1), 'slash', new THREE.Vector3(1, 0.5, 0));
    cutAt('thighL', new THREE.Vector3(0, 0.05, 0.07), new THREE.Vector3(0, 0, -1));
    cutAt('upperArmL', new THREE.Vector3(0.04, -0.03, 0.02), new THREE.Vector3(-1, 0, 0), 'slash', new THREE.Vector3(0, 0, 1));
    if (r.sever('lowerArmL').length) gore.onSever(r, 'lowerArmL');
    const fore = r.parts.lowerArmL.body;
    fore.position.set(SPOT.x + 1.05, 0.06, SPOT.z + 0.55); fore.quaternion.setFromEuler(Math.PI / 2, 0.4, 0.3);
    r.parts.handL.body.position.set(SPOT.x + 1.05, 0.05, SPOT.z + 0.8);
    gore.explodePart(r, 'handR', new THREE.Vector3(0.3, 0, -1).normalize());

    // burns from a grenade that went off to the right
    for (const [part, k] of [['shinR', 0.75], ['thighR', 0.45], ['footR', 0.8], ['upperArmR', 0.35], ['abdomen', 0.25]]) {
      h.burn(part, k);
      gore.addBruise(r, part, at(part, [0.04, 0, 0.04]), 0.8, { burn: true });
      gore.addBruise(r, part, at(part, [0.04, 0.04, 0.03]), 0.6, { soot: true });
    }
    for (const [part, off, s] of [['head', [-0.05, 0.02, 0.08], 0.9], ['head', [0.06, -0.03, 0.07], 0.6], ['abdomen', [-0.08, 0, 0.1], 0.8], ['upperArmL', [0, 0.05, 0.04], 0.7]]) gore.addBruise(r, part, at(part, off), s);
    gore.decals.addScorch(new THREE.Vector3(SPOT.x + 2.3, 0, SPOT.z + 1.4), new THREE.Vector3(0, 1, 0), 1.7, 0.95);
    gore.decals.addScorch(new THREE.Vector3(SPOT.x + 2.3, 0.6, WALL_Z + 0.001), new THREE.Vector3(0, 0, 1), 1.2, 0.7);

    // blood: a pool under it, a smear down the wall behind it, holes where rounds missed
    for (let i = 0; i < 12; i++) {
      const a = Math.random() * Math.PI * 2, d = Math.sqrt(Math.random()) * 0.32;
      gore.decals.addDrop(SPOT.x + 0.1 + Math.cos(a) * d, 0.001, SPOT.z + 0.3 + Math.sin(a) * d * 0.8, 12, 0.1);
    }
    for (let i = 0; i < 7; i++) gore.decals.addDrop(SPOT.x + 0.55 + i * 0.11, 0.001, SPOT.z + 0.45 + Math.random() * 0.15, 3, 0.035);
    const wallN = new THREE.Vector3(0, 0, 1);
    for (let i = 0; i < 4; i++) {
      const p = new THREE.Vector3(SPOT.x + (Math.random() - 0.5) * 0.3, 0.6 + Math.random() * 0.35, WALL_Z + 0.001);
      gore.decals.addWallSplat(p, wallN, new THREE.Vector3((Math.random() - 0.5) * 0.6, -1.2, -1), 4, 0.05);
    }
    for (const [x, y] of [[-0.7, 1.35], [0.55, 1.1], [0.9, 1.6], [-0.35, 0.95]]) gore.decals.addHole(new THREE.Vector3(SPOT.x + x, y, WALL_Z + 0.001), wallN);

    // let it settle, the blood land and the pools spread
    for (let i = 0; i < 200; i++) {
      this.physics.update(1 / 60, 1);
      rd.update(1 / 60);
      bal.update(1 / 60, 1 / 60);
      gore.update(1 / 60, this.camera, 720);
    }
    bal.silent = false;
    bal.lastTarget = lastTarget;
    // the scream / gunfire scared the other ragdolls during the set-up: calm them down again
    for (const o of rd.list) if (o !== r) { o.brain.fear = 0; o.brain.cower = 0; }
    return r;
  }

  /** Slow orbit in front of the body, with the body on the right third of the screen. */
  update(dt) {
    this.time += dt;
    const t = this.time;
    if (this.alive) this.focus.lerp(this.corpse.bodyPos('chest', _v), this.focus.lengthSq() ? 0.05 : 1);
    else this.focus.set(SPOT.x, 0.55, SPOT.z);
    const f = _f.copy(this.focus);
    f.y = Math.max(0.45, f.y - 0.05);
    const ang = Math.sin(t * 0.07) * 0.55 + 0.22;
    const R = 3.05 + Math.sin(t * 0.11) * 0.4;
    const cam = this.camera;
    cam.position.set(f.x + Math.sin(ang) * R, 1.2 + Math.sin(t * 0.09) * 0.3, f.z + Math.cos(ang) * R);
    // look a little to the left of the body so it sits on the right, clear of the menu
    const right = new THREE.Vector3(Math.cos(ang), 0, -Math.sin(ang));
    cam.lookAt(f.clone().addScaledVector(right, -0.95 * (cam.aspect > 1.2 ? 1 : 0.2)).add(new THREE.Vector3(0, 0.05, 0)));
    if (Math.abs(cam.fov - 48) > 0.01) { cam.fov = 48; cam.updateProjectionMatrix(); }
  }

  /** The set (corpse, machete) is only drawn on the title screen: while you play it's far away. */
  setActive(on) {
    this.prop.root.visible = on;
    if (this.corpse) this.corpse.root.visible = on;
  }
}
