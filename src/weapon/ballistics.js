import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { CONFIG } from '../config.js';

const W = CONFIG.weapon;

/**
 * Resolves a fired bullet: hits ragdoll parts (with penetration through several parts),
 * world geometry, buttons and gibs. All the consequences (damage, gore, impulses) are applied here.
 */
export class Ballistics {
  constructor({ ragdolls, gore, map, buttons, audio, hud }) {
    this.ragdolls = ragdolls; this.gore = gore; this.map = map; this.buttons = buttons; this.audio = audio; this.hud = hud;
    this.raycaster = new THREE.Raycaster();
    this.lastTarget = null;
  }

  targets() {
    return [
      ...this.ragdolls.meshes(),
      ...this.map.solidMeshes,
      ...this.buttons.flatMap((b) => b.meshes),
      ...this.gore.gibs.map((g) => g.mesh),
    ];
  }

  fire(origin, dir) {
    let energy = 1;
    let from = origin.clone();
    const skip = new Set();
    let travelled = 0;
    for (let pass = 0; pass < 5 && energy > 0.05; pass++) {
      this.raycaster.set(from, dir);
      this.raycaster.far = W.range - travelled;
      const hits = this.raycaster.intersectObjects(this.targets(), false).filter((h) => !skip.has(h.object));
      if (!hits.length) return;
      const hit = hits[0];
      const obj = hit.object;
      travelled += hit.distance;
      const ud = obj.userData;

      if (ud.ragdoll) {
        const r = ud.ragdoll;
        const partName = ud.part;
        if (!r.parts[partName]) return;
        const part = r.parts[partName];
        const inv = part.group.quaternion.clone().invert();
        const localEntry = hit.point.clone().sub(part.group.position).applyQuaternion(inv);
        const localDir = dir.clone().applyQuaternion(inv);
        const res = r.health.bulletHit(partName, localEntry, localDir, energy);
        r.hitImpulse(partName, hit.point, dir, W.impulse * energy);
        this.gore.bulletWound(r, res, hit.point, dir);
        this.audio.play(res.bones.length ? 'bone' : 'flesh');
        this.hud.hitMarker(res.organs.length > 0 || res.vessels.length > 0);
        if (res.opened) this.gore.openPart(r, partName, res.wound);
        if (res.dismember) {
          if (r.sever(partName).length) {
            this.gore.onSever(r, partName);
            part.body.applyImpulse(new CANNON.Vec3(dir.x * 6, dir.y * 6 + 2, dir.z * 6));
          }
        }
        this.lastTarget = r;
        if (!res.exit) return;
        energy = res.energyOut;
        // continue from the exit point of this part
        const exitLocal = localEntry.clone().addScaledVector(localDir, res.exitT + 0.005);
        from = exitLocal.applyQuaternion(part.group.quaternion).add(part.group.position);
        skip.add(part.mesh); if (part.ball) skip.add(part.ball);
        continue;
      }
      if (ud.button) { ud.button.press(); this.audio.play('concrete'); return; }
      if (ud.gib) {
        const b = ud.gib.body;
        b.applyImpulse(new CANNON.Vec3(dir.x * 1.5, dir.y * 1.5 + 0.5, dir.z * 1.5));
        this.gore.spray(hit.point, dir, 10, { speed: 2 });
        return;
      }
      // world geometry
      const n = hit.face ? hit.face.normal.clone().transformDirection(obj.matrixWorld) : new THREE.Vector3(0, 1, 0);
      this.gore.bulletImpactWorld(hit.point, n);
      this.audio.play('concrete');
      return;
    }
  }
}
