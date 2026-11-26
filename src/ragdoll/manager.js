import { Ragdoll } from './ragdoll.js';
import { XRayRig } from '../ui/xray.js';
import { CONFIG } from '../config.js';

/** Owns all ragdolls in the level: spawning, respawning, per-frame update, picking. */
export class RagdollManager {
  constructor(scene, physics, gore) {
    this.scene = scene; this.physics = physics; this.gore = gore;
    this.list = [];
    this.counter = 0;
    this.meshCache = null;
  }

  spawn(position = CONFIG.ragdoll.spawn, yaw = Math.PI * 0) {
    const r = new Ragdoll({ scene: this.scene, physics: this.physics, position, yaw, name: `Subject ${String(++this.counter).padStart(2, '0')}` });
    r.xray = new XRayRig(r);
    this.list.push(r);
    this.meshCache = null;
    return r;
  }

  clear() {
    for (const r of this.list) r.dispose();
    this.list = [];
    this.meshCache = null;
  }

  /** Remove every ragdoll and spawn a fresh one at the spawn point, facing the player start. */
  respawn() {
    this.clear();
    return this.spawn(CONFIG.ragdoll.spawn, 0);
  }

  meshes() {
    if (this.list.some((r) => r.meshesDirty)) { this.meshCache = null; for (const r of this.list) r.meshesDirty = false; }
    if (!this.meshCache) this.meshCache = this.list.flatMap((r) => r.meshes());
    return this.meshCache;
  }

  update(dt) {
    for (const r of this.list) {
      r.update(dt);
      this.processImpacts(r);
      this.gore.updateRagdoll(r, dt);
    }
  }

  /** Blunt trauma from collisions queued by the ragdoll during the physics step. */
  processImpacts(r) {
    if (!r.impacts.length) return;
    const audio = this.gore.audio;
    let loudest = 0, cracked = false;
    for (const imp of r.impacts) {
      const res = r.health.impact(imp.part, imp.speed);
      if (res.fractured) {
        cracked = true;
        this.gore.impactBlood(imp.point, imp.speed);
      } else if (res.damage > 25) this.gore.impactBlood(imp.point, imp.speed * 0.5);
      loudest = Math.max(loudest, imp.speed);
    }
    r.impacts.length = 0;
    if (cracked) audio.play('bone');
    if (loudest > 5) audio.play(loudest > 9 ? 'splat' : 'thud');
  }

  /** The ragdoll under the crosshair (within range), if any. */
  pick(raycaster) {
    const hits = raycaster.intersectObjects(this.meshes(), false);
    return hits.length ? hits[0].object.userData.ragdoll : null;
  }
}

