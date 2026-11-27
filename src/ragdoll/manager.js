import { Ragdoll } from './ragdoll.js';
import { XRayRig } from '../ui/xray.js';
import { CONFIG } from '../config.js';
import { WORLD } from '../world/world.js';
import { rand } from '../core/util.js';

/** Owns all ragdolls in the level: spawning, respawning, per-frame update, picking. */
export class RagdollManager {
  constructor(scene, physics, gore) {
    this.scene = scene; this.physics = physics; this.gore = gore;
    this.list = [];
    this.counter = 0;
    this.zombieCounter = 0;
    this.hurtPlayer = null;   // (damage, { kind, from }) set by the game: zombies attacking you
    this.meshCache = null;
    // What the ragdolls know about the player (set every frame by the game):
    // { pos, armed (gun or blade out), melee (blade or fists out), aimedAt (ragdoll under the crosshair) }
    this.player = null;
  }

  spawn(position = WORLD.map?.ragdollSpawn?.pos || CONFIG.ragdoll.spawn, yaw = WORLD.map?.ragdollSpawn?.yaw ?? 0, { armor = null, name = null, behavior = 'classic', zombie = false } = {}) {
    const n = String(zombie ? ++this.zombieCounter : ++this.counter).padStart(2, '0');
    const r = new Ragdoll({ scene: this.scene, physics: this.physics, position, yaw, armor, behavior, zombie, name: name || (zombie ? `Zombie ${n}` : `Subject ${n}`) });
    r.env = this;
    r.xray = new XRayRig(r);
    this.list.push(r);
    this.meshCache = null;
    return r;
  }

  clear(keep = null) {
    for (const r of this.list) if (r !== keep) r.dispose();
    this.list = keep && this.list.includes(keep) ? [keep] : [];
    this.meshCache = null;
  }

  remove(r) {
    if (!this.list.includes(r)) return;
    r.dispose();
    this.list = this.list.filter((x) => x !== r);
    this.meshCache = null;
  }

  /** A gunshot, explosion or scream at pos: every ragdoll in earshot gets scared (except `from`). */
  alert(pos, radius, amount, kind, from = null) {
    for (const r of this.list) if (r !== from) r.brain.hear(pos, radius, amount, kind);
  }

  /** Remove every ragdoll and spawn a fresh one at the spawn point, facing the player start. */
  respawn() {
    this.clear(this.keep);
    const sp = WORLD.map?.ragdollSpawn;
    return this.spawn(sp ? sp.pos : CONFIG.ragdoll.spawn, sp ? sp.yaw : 0);
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
      // the bitten dead get back up (unless the head was destroyed)
      if (r.health.infected && !r.health.alive && !r.zombie && !r.hidden) {
        r.riseT ??= rand(7, 10);
        r.riseT -= dt;
        if (r.riseT <= 0) { if (r.health.headIntact && !r.grabbed) this.reanimate(r); else r.riseT = 1; }
      }
    }
  }

  /** An infected body rises as a zombie. */
  reanimate(r) {
    r.health.log('Came back as a zombie', 'warn');
    r.health.consciousness = 30;
    r.makeZombie();
    r.brain.setState('fallen'); r.brain.nextDecision = rand(0.6, 1.4);
    r.name = r.name.replace(/^Subject/, 'Zombie');
    r.xray?.refresh?.();
    this.zombieCounter++;
    const P = this.player;
    if (P) { const d = P.pos.distanceTo(r.parts.pelvis.body.position); if (d < 30) this.gore.audio?.play('snarl', Math.max(0.15, 1.2 - d / 25)); }
  }

  get zombies() { return this.list.filter((r) => r.zombie && !r.hidden); }

  /** Blunt trauma from collisions queued by the ragdoll during the physics step. */
  processImpacts(r) {
    if (!r.impacts.length) return;
    const audio = this.gore.audio;
    let loudest = 0, cracked = false;
    for (const imp of r.impacts) {
      const res = r.health.impact(imp.part, imp.speed);
      if (imp.speed > 5) this.gore.addBruise(r, imp.part, imp.point, Math.min(1, (imp.speed - 4.5) / 9));
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

