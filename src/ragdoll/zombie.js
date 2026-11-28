import * as THREE from 'three';
import { Brain } from './brain.js';
import { clamp, rand, noise1 } from '../core/util.js';

const SIGHT = 30;          // how far a zombie notices prey (m)
const FLOOR = 2.4;         // prey must be on the same floor (height difference, m)
const REACH = 0.95;        // attack range, pelvis to prey (m)
const BITE_PARTS = ['upperArmL', 'upperArmR', 'lowerArmL', 'lowerArmR', 'chest', 'chest', 'head', 'abdomen'];
const wrapAngle = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const _v = new THREE.Vector3(), _v2 = new THREE.Vector3();

/**
 * Zombie behaviour. It shambles after the nearest living person on its floor (you or a ragdoll),
 * arms out in front, and claws and bites when it gets close. Shots, explosions and screams draw it
 * in. Legs gone: it crawls after you. It never stays down for long and only stops for good when
 * the brain is destroyed or the head comes off (see Health.updateUndead).
 */
export class ZombieBrain extends Brain {
  constructor(ragdoll, home, yaw) {
    super(ragdoll, home, yaw);
    this.zombie = true;
    this.prey = null;              // a player (see RagdollManager.players) or a Ragdoll
    this.preyPos = new THREE.Vector3();
    this.goal = new THREE.Vector3();
    this.seekT = 0;
    this.attackT = -1; this.attackCd = rand(0.4, 0.9);
    this.groanT = rand(1.5, 5);
    this.noise = null;             // { pos, t } last loud noise it heard
    this.chaseMul = rand(1.0, 1.3);
    this.turnRate = 1.9;
    this.lurch = rand(0, 10);
  }

  hear(pos, radius, amount) {
    const pp = this.r.bodyPos('pelvis', _v);
    if (pp.distanceTo(pos) > radius * 1.4 || Math.abs(pos.y - this.gy) > FLOOR * 2) return;
    this.noise = { pos: pos.clone(), t: 8 };
  }
  scare() {}

  /** Bullets make it stagger; only a hit to the legs (or the head knocking it silly) drops it. */
  onHit(partName, dir) {
    this.lastHitDir.copy(dir).setY(0).normalize();
    this.lastHitPart = partName;
    if (this.state !== 'stand') return;
    this.stagger = 0.35;
    this.root.addScaledVector(this.lastHitDir, 0.12);
    const h = this.r.health;
    const legHit = /thigh|shin|foot/.test(partName);
    if (legHit && Math.min(h.legCap('L'), h.legCap('R')) < 0.5 && Math.random() < 0.8) this.fall();
  }

  get env() { return this.r.env; }

  /** Nearest living, non-zombie person on the same floor within sight. */
  findPrey() {
    const env = this.env, pp = this.r.bodyPos('pelvis', _v);
    let best = null, bestD = this.sight || SIGHT;
    // you, and in multiplayer every other player too
    for (const P of env?.players || (env?.player ? [env.player] : [])) {
      if (P.alive === false) continue;
      const d = Math.hypot(P.pos.x - pp.x, P.pos.z - pp.z);
      if (Math.abs(P.pos.y - this.gy) < FLOOR && d < bestD * 1.25) { best = P; bestD = d / 1.25; }
    }
    for (const o of env?.list || []) {
      if (o === this.r || o.zombie || o.hidden || o.removed || !o.health.alive) continue;
      const op = o.parts.pelvis.body.position;
      const d = Math.hypot(op.x - pp.x, op.z - pp.z);
      if (d < bestD && Math.abs(o.brain.gy - this.gy) < FLOOR) { best = o; bestD = d; }
    }
    return best;
  }

  /** Where the prey is now (its feet / pelvis). False if it is gone. */
  updatePreyPos() {
    const p = this.prey;
    if (!p) return false;
    if (p.isPlayer) {
      if (p.alive === false || p.gone) return false;
      this.preyPos.copy(p.pos);
      return true;
    }
    if (p.removed || !p.health.alive || p.zombie) return false;
    const b = p.parts.pelvis.body.position;
    this.preyPos.set(b.x, b.y, b.z);
    return true;
  }

  update(dt) {
    const h = this.h;
    if (h.alive) {
      this.seekT -= dt;
      if (this.seekT <= 0) { this.seekT = rand(0.35, 0.6); const p = this.findPrey(); if (p !== this.prey) { if (p && !this.prey) this.growl(true); this.prey = p; } }
      if (!this.updatePreyPos()) this.prey = null;
      if (this.noise) { this.noise.t -= dt; if (this.noise.t <= 0) this.noise = null; }
      this.attackCd -= dt;
      this.groanT -= dt;
      if (this.groanT <= 0) { this.groanT = this.prey ? rand(2.5, 5) : rand(5, 11); this.growl(false); }
    }
    super.update(dt);
    if (!h.alive) this.activity = 'Put down';
  }

  /** Groan (or snarl when it spots you); quieter the further away you are. */
  growl(snarl) {
    const env = this.env, audio = env?.gore?.audio, P = env?.player;
    if (!audio || !P) return;
    const pp = this.r.bodyPos('pelvis', _v);
    const d = pp.distanceTo(P.pos);
    if (d > 26) return;
    const now = performance.now();
    if (now - (env.lastGroan || 0) < 700) return;   // a crowd shouldn't turn into a wall of noise
    env.lastGroan = now;
    audio.play(snarl ? 'snarl' : 'groan', clamp(1.25 - d / 22, 0.12, 1));
  }

  // ------------------------------------------------------------------ standing: chase and attack
  updateStand(dt, pose, args) {
    const r = this.r, S = r.strength;
    const pp = r.bodyPos('pelvis', _v2);
    let chasing = false, dist = 99;
    if (this.prey) {
      const dx = this.preyPos.x - pp.x, dz = this.preyPos.z - pp.z;
      dist = Math.hypot(dx, dz);
      // stop just short of the prey (bodies would only shove each other)
      const k = dist > 0.6 ? (dist - 0.55) / dist : 0;
      this.goal.set(pp.x + dx * k, 0, pp.z + dz * k);
      this.target = this.goal; this.idleTimer = 0.5;
      chasing = true;
    } else if (this.noise) {
      this.goal.set(this.noise.pos.x, 0, this.noise.pos.z);
      this.target = this.goal; this.idleTimer = 0.5;
      if (Math.hypot(this.goal.x - pp.x, this.goal.z - pp.z) < 1) this.noise = null;
    } else if (this.target === this.goal) this.target = null;
    this.speedMul = chasing ? this.chaseMul : this.noise ? 0.9 : 0.6;
    super.updateStand(dt, pose, args);

    // the attack: lunge, claw / bite at the moment of contact
    if (this.attackT < 0 && chasing && dist < REACH && this.attackCd <= 0) {
      const want = Math.atan2(this.preyPos.x - pp.x, this.preyPos.z - pp.z);
      if (Math.abs(wrapAngle(want - this.yaw)) < 0.9) { this.attackT = 0; this.bitDone = false; }
    }
    let lunge = 0;
    if (this.attackT >= 0) {
      this.attackT += dt;
      const t = this.attackT;
      lunge = t < 0.3 ? t / 0.3 : Math.max(0, 1 - (t - 0.3) / 0.35);
      if (!this.bitDone && t >= 0.3) { this.bitDone = true; this.strike(); }
      if (t > 0.65) { this.attackT = -1; this.attackCd = rand(1.0, 1.5); }
      if (this.prey) {   // face the prey while lunging
        const want = Math.atan2(this.preyPos.x - pp.x, this.preyPos.z - pp.z);
        this.yaw += clamp(wrapAngle(want - this.yaw), -3 * dt, 3 * dt);
      }
    }

    // zombie posture: arms reaching forward, head lolling, a hunched lurch
    const t = this.time, w = this.walkAmt;
    const low = this.prey && !this.prey.isPlayer && this.preyPos.y - this.gy < 0.5 && dist < 2;   // prey on the ground: bend down to it
    for (const s of ['L', 'R']) {
      const ph = s === 'L' ? 0 : 1.7;
      pose[`shoulder${s}`] = [1.3 + 0.12 * Math.sin(t * 2.1 + ph) + lunge * 0.35 + (low ? 0.35 : 0), (s === 'L' ? 1 : -1) * 0.04 + 0.08];
      pose[`elbow${s}`] = 0.25 + 0.15 * Math.max(0, Math.sin(t * 1.7 + ph)) - lunge * 0.2;
    }
    pose.spine = 0.16 + lunge * 0.25 + (low ? 0.75 : 0);
    pose.chest = 0.06 + lunge * 0.1;
    pose.neck = 0.22 + 0.12 * noise1(t * 0.8, this.seed);
    pose.headYaw = 0.25 * noise1(t * 0.5, this.seed + 3);
    pose.headRoll = 0.3 * Math.sin(t * 0.9 + this.lurch) + 0.15;
    pose.pelvisRoll = (pose.pelvisRoll || 0) + 0.05 * Math.sin(this.phase) * w;
    S.upperArmL = Math.max(S.upperArmL, 0.75 * this.h.armCap('L'));
    S.upperArmR = Math.max(S.upperArmR, 0.75 * this.h.armCap('R'));
    if (this.attackT >= 0) this.activity = 'Attacking';
    else this.activity = chasing ? (this.prey.isPlayer && !this.prey.name ? 'Chasing you' : `Chasing ${this.prey.name}`) : this.noise ? 'Heading for a noise' : 'Shambling';
  }

  /** Claw / bite whatever it is attacking, if it is still in reach. */
  strike() {
    const env = this.env, r = this.r;
    if (!this.prey || !this.updatePreyPos()) return;
    const pp = r.bodyPos('pelvis', new THREE.Vector3());
    const dist = Math.hypot(this.preyPos.x - pp.x, this.preyPos.z - pp.z);
    if (dist > REACH + 0.25) { env?.gore?.audio?.play('whoosh', 0.6); return; }
    if (this.prey.isPlayer) {
      env?.hurtPlayer?.(rand(8, 13) * (this.dmgMul || 1), { kind: 'zombie', from: pp.clone(), who: this.prey });
      return;
    }
    this.bite(this.prey);
  }

  /** Bite a ragdoll: a ragged wound on an arm, the chest or the neck, and the infection. */
  bite(o) {
    const env = this.env, gore = env?.gore;
    const head = this.r.bodyPos('head', new THREE.Vector3());
    // the part of the victim closest to the zombie's mouth (from a few likely ones)
    let best = null, bestD = 9;
    for (const n of BITE_PARTS) {
      const part = o.parts[n];
      if (!part || part.removed || !o.health.parts[n].attached) continue;
      const d = part.body.position.distanceTo(head) + Math.random() * 0.25;
      if (d < bestD) { best = n; bestD = d; }
    }
    if (!best) return;
    const part = o.parts[best], g = part.group;
    const bp = part.body.position;
    const centre = new THREE.Vector3(bp.x, bp.y, bp.z);
    const dir = centre.clone().sub(head).normalize();
    const point = centre.clone().addScaledVector(dir, -0.06);
    if (best === 'head') point.y -= 0.06;       // the neck
    const inv = g.quaternion.clone().invert();
    const localEntry = point.clone().sub(g.position).applyQuaternion(inv).addScaledVector(dir.clone().applyQuaternion(inv), -0.1);
    const localDir = dir.clone().applyQuaternion(inv);
    const res = o.health.cut(best, localEntry, localDir, 0.5 + Math.random() * 0.25, 'slash', { dismember: false });
    const along = new THREE.Vector3(-dir.z, 0.3, dir.x).normalize();
    o.hitImpulse(best, point, dir, 3.5);
    gore?.bladeWound(o, res, point, dir, along);
    gore?.audio?.play('bite', 0.8);
    o.health.infected = true;
    o.health.log('Bitten by a zombie: infected', 'warn');
    o.brain.onPunch?.(best, dir, Math.random() < 0.3);
    o.brain.hear?.(this.r.bodyPos('pelvis', new THREE.Vector3()), 12, 0.8, 'zombie');
  }

  // ------------------------------------------------------------------ on the ground
  decideOnGround({ capL, capR, armL, armR, support }) {
    const h = this.h;
    const canStand = support > 0.5 && h.consciousness > 55 && !h.paralyzed;
    if (canStand) { this.startGetup(); return; }
    if (Math.max(armL, armR) > 0.25) { this.setState('crawl'); this.crawlYaw = this.r.heading(); this.nextDecision = rand(3, 5); return; }
    this.setState('squirm'); this.nextDecision = rand(2, 4);
  }

  updateCrawl(dt, pose, args) {
    // crawl towards the prey (the base crawl heads along lastHitDir)
    if (this.prey) {
      const cp = this.r.bodyPos('chest', _v2);
      this.lastHitDir.set(this.preyPos.x - cp.x, 0, this.preyPos.z - cp.z).normalize();
      const d = Math.hypot(this.preyPos.x - cp.x, this.preyPos.z - cp.z);
      if (d < 0.9 && this.attackCd <= 0) { this.attackCd = rand(1, 1.6); this.strike(); }
    } else if (this.noise) this.lastHitDir.set(this.noise.pos.x - this.r.bodyPos('chest', _v2).x, 0, this.noise.pos.z - _v2.z).normalize();
    super.updateCrawl(dt, pose, args);
    this.activity = this.prey ? 'Crawling after ' + (this.prey.isPlayer && !this.prey.name ? 'you' : this.prey.name) : 'Crawling';
  }
}
