import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { clamp, lerp, noise1, rand, damp } from '../core/util.js';

const C = CONFIG.ragdoll;
const Y = new THREE.Vector3(0, 1, 0), X = new THREE.Vector3(1, 0, 0);
const _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _v = new THREE.Vector3(), _v2 = new THREE.Vector3();

export function basePose() {
  return {
    relative: false,
    spine: 0, chest: 0, chestRoll: 0, neck: 0, headYaw: 0, headRoll: 0,
    shoulderL: [0.05, 0.08], shoulderR: [0.05, 0.08], elbowL: 0.18, elbowR: 0.18,
    hipL: [0, 0.02], hipR: [0, 0.02], kneeL: 0.06, kneeR: 0.06, ankleL: 0, ankleR: 0,
  };
}

const wrapAngle = (a) => Math.atan2(Math.sin(a), Math.cos(a));

/**
 * Behaviour + motor control for one ragdoll.
 * States: stand (idle / wander / limp) -> fallen -> getup | crawl | squirm | unconscious | dead
 * Each frame it writes a target pose and per-part muscle strengths into the Ragdoll.
 */
export class BrainV2 {
  constructor(ragdoll, home, yaw) {
    this.r = ragdoll;
    this.home = new THREE.Vector3(home.x, 0, home.z);
    this.root = new THREE.Vector3(home.x, 0, home.z);
    this.yaw = yaw;
    this.state = 'stand';
    this.stateTime = 0;
    this.phase = 0;
    this.walkAmt = 0;
    this.speed = 0;
    this.target = null;
    this.idleTimer = rand(1, 3);
    this.stagger = 0;
    this.lastHitDir = new THREE.Vector3(0, 0, 1);
    this.lastHitPart = null;
    this.seed = Math.random() * 100;
    this.time = 0;
    this.getup = null;
    this.crawlYaw = yaw;
    this.nextDecision = 0;
    this.activity = 'Idle';
    // awareness of the player
    this.fear = 0;               // 0..1
    this.cower = 0;              // s left covering the head (gunshot close by, explosion)
    this.mode = 'wander';        // what it does while standing
    this.modeTime = 0;
    this.fleeDir = null;
    this.aimedTime = 0;
    this.fearMul = 1;            // temperament: 0.35 brave, 1 normal, 1.7 timid
  }

  scare(x) { this.fear = Math.min(1, this.fear + x * this.fearMul); }

  /** The player as the ragdoll sees them (set by the manager every frame), or null. */
  get player() { return this.r.env?.player || null; }

  /**
   * Something frightening nearby: a gunshot, an explosion, a scream. amount = fear added at the
   * source; the closer, the more it counts. Gunshots and blasts close by make it cover its head.
   */
  hear(pos, radius, amount, kind) {
    const h = this.h;
    if (!h.alive || h.consciousness < 30) return;
    const p = this.r.bodyPos('chest', _v);
    const d = p.distanceTo(pos);
    if (d > radius) return;
    const k = 1 - d / radius;
    this.scare(amount * k);
    if ((kind === 'shot' && d < 5.5) || (kind === 'blast' && d < 14)) this.cower = Math.max(this.cower, kind === 'blast' ? rand(1.6, 2.6) : rand(0.7, 1.2));
  }

  setState(s) { if (this.state !== s) { this.state = s; this.stateTime = 0; } }

  onHit(partName, dir) {
    this.lastHitDir.copy(dir).setY(0).normalize();
    this.lastHitPart = partName;
    this.scare(0.45);
    this.r.env?.alert(this.r.bodyPos('chest'), 12, 0.3, 'scream', this.r);
    if (this.state === 'stand') {
      this.stagger = 0.45;
      this.root.addScaledVector(this.lastHitDir, 0.18);
      const h = this.r.health;
      const legHit = /thigh|shin|foot/.test(partName);
      if (partName === 'head' || (legHit && Math.min(h.legCap('L'), h.legCap('R')) < 0.55 && Math.random() < 0.7)) this.fall();
    }
  }

  /** Punched: a stagger step back; falls only when knocked down. */
  onPunch(partName, dir, knockdown) {
    this.lastHitDir.copy(dir).setY(0).normalize();
    this.lastHitPart = partName;
    this.scare(0.2);
    if (this.state !== 'stand') return;
    this.stagger = 0.4;
    this.root.addScaledVector(this.lastHitDir, knockdown ? 0.3 : 0.12);
    if (knockdown) this.fall();
  }

  fall() { this.setState('fallen'); this.nextDecision = rand(1.2, 2.2); }

  get h() { return this.r.health; }

  update(dt) {
    this.time += dt;
    this.stateTime += dt;
    const h = this.h;
    const r = this.r;
    const pose = basePose();
    const S = r.strength;
    for (const n in r.parts) S[n] = 0;
    r.pelvisPosStrength = 0;
    r.footPosStrength = 0;
    r.gravityComp = 0;
    r.chestPosStrength = 0;
    r.chestTarget = null;
    r.pelvisTargetVel.set(0, 0, 0);
    r.pelvisPosAxes.set(1, 1, 1);

    const capL = h.legCap('L'), capR = h.legCap('R');
    const armL = h.armCap('L'), armR = h.armCap('R');
    const support = Math.min(capL, capR) * 0.45 + (capL + capR) * 0.5 * 0.55;
    const awake = clamp((h.consciousness - 22) / 45);
    const painF = clamp(h.pain / 100);

    // Global transitions
    if (!h.alive) this.setState('dead');
    else if (h.consciousness < 22 && this.state !== 'dead') this.setState('unconscious');

    const pelvisPos = r.bodyPos('pelvis');
    const pelvisUp = Y.clone().applyQuaternion(r.bodyQuat('pelvis', _q));
    this.sense(dt, pelvisPos, awake, painF);
    h.pressing = null;

    if (r.grabbed) {
      // Held by the grab tool: curl up into a fetal ball. Afterwards it lands "fallen" and decides
      // what to do once it has settled.
      if (h.alive && this.state !== 'unconscious') { if (this.state !== 'fallen') this.setState('fallen'); this.nextDecision = this.stateTime + rand(1.2, 2.2); }
      this.updateGrabbed(dt, pose, { awake });
    } else switch (this.state) {
      case 'stand': {
        const mustFall = support < 0.33 || Math.min(capL, capR) < 0.2 || h.consciousness < 42 || h.pain > 90 || h.paralyzed;
        const tipped = pelvisPos.y < 0.62 || pelvisUp.y < 0.5;
        if (mustFall || tipped) { this.fall(); break; }
        this.updateStand(dt, pose, { capL, capR, armL, armR, support, awake, painF });
        break;
      }
      case 'fallen': {
        this.activity = 'Down';
        const tone = 0.06 * awake;
        for (const n in r.parts) S[n] = tone * h.partCap(n);
        pose.relative = true;
        pose.hipL = [0.3, 0.05]; pose.hipR = [0.3, 0.05]; pose.kneeL = 0.5; pose.kneeR = 0.5;
        if (this.aware && this.aimed && awake > 0.4) {
          // lying down with a gun on it: an arm up in front of the face
          this.activity = 'Shielding its face';
          const s = armL >= armR ? 'L' : 'R';
          pose[`shoulder${s}`] = [1.7, -0.15]; pose[`elbow${s}`] = 1.1;
          S[`upperArm${s}`] = 0.35 * awake; S[`lowerArm${s}`] = 0.3 * awake; S.head = 0.2 * awake;
          pose.neck = 0.5;
        } else this.pressWound(pose, { armL, armR, awake, lying: true });
        if (this.stateTime > this.nextDecision) this.decideOnGround({ capL, capR, armL, armR, support });
        break;
      }
      case 'getup': this.updateGetup(dt, pose, { capL, capR, support, awake }); break;
      case 'crawl': this.updateCrawl(dt, pose, { capL, capR, armL, armR, awake, painF }); break;
      case 'squirm': this.updateSquirm(dt, pose, { capL, capR, armL, armR, awake, painF }); break;
      case 'unconscious': {
        this.activity = 'Limp';
        for (const n in r.parts) S[n] = 0.012;
        pose.relative = true;
        if (h.consciousness > 35) { this.setState('fallen'); this.nextDecision = rand(1.5, 3); }
        // Agonal twitching when circulation fails
        if (h.cardiacArrest && Math.random() < dt * 1.2) this.twitch(0.6);
        break;
      }
      case 'dead': {
        this.activity = 'Dead';
        pose.relative = true;
        if (this.stateTime < 6 && Math.random() < dt * 0.8 * (1 - this.stateTime / 6)) this.twitch(0.9);
        break;
      }
    }

    // Shivering from shock
    if (h.alive && h.shock > 25 && h.consciousness > 20) {
      const amp = (h.shock - 25) / 75 * 1.4;
      for (const n of ['upperArmL', 'upperArmR', 'lowerArmL', 'lowerArmR', 'shinL', 'shinR', 'head']) {
        const w = r.parts[n].body.angularVelocity;
        w.x += (Math.random() - 0.5) * amp; w.z += (Math.random() - 0.5) * amp;
      }
    }

    // Severed parts have no muscles
    for (const n in r.parts) if (!h.parts[n].attached) S[n] = 0;

    // Pelvis world orientation
    let pelvisQ;
    if (this.state === 'crawl') pelvisQ = _q2.setFromAxisAngle(Y, this.crawlYaw).multiply(_q.setFromAxisAngle(X, Math.PI / 2 + 0.05));
    else pelvisQ = _q2.setFromAxisAngle(Y, this.yaw).multiply(_q.setFromEuler(new THREE.Euler(pose.pelvisPitch || 0, 0, pose.pelvisRoll || 0)));
    r.setPose(pose, pelvisQ, dt);
  }

  // ------------------------------------------------------------------ standing / walking
  updateStand(dt, pose, { capL, capR, armL, armR, support, awake, painF }) {
    const r = this.r, h = this.h, S = r.strength;
    const P = this.player;
    const limpSide = capL < capR ? 'L' : 'R';
    const limp = clamp((1 - Math.min(capL, capR)) * 1.6);
    const pp = r.bodyPos('pelvis');

    // ---- what to do: wander, run away, hands up, cover the head or back away from a blade
    const distP = P ? Math.hypot(P.pos.x - pp.x, P.pos.z - pp.z) : Infinity;
    const faceP = P ? Math.atan2(P.pos.x - pp.x, P.pos.z - pp.z) : this.yaw;
    let mode = 'wander';
    if (this.cower > 0 && awake > 0.4) mode = 'cower';
    else if (this.aware && this.fear > 0.62 && support > 0.5 && h.pain < 80 && (this.mode === 'flee' || distP < 16)) mode = 'flee';
    else if (this.aware && this.aimed && distP < 22) mode = 'handsUp';
    else if (this.aware && P?.melee && distP < 2.4 && this.fear > 0.1) mode = 'backAway';
    if (mode !== this.mode) {
      this.mode = mode; this.modeTime = 0;
      if (mode !== 'wander') this.target = null;
      else { this.home.set(pp.x, 0, pp.z); this.idleTimer = rand(1, 3); }   // settle down where it ended up
    }
    this.modeTime += dt;

    let wantSpeed = 0, run = 0, back = false, wantYaw = null;
    if (mode === 'wander') {
      // small loops around home
      if (!this.target) {
        this.idleTimer -= dt;
        if (this.idleTimer <= 0) {
          const a = Math.random() * Math.PI * 2, d = Math.sqrt(Math.random()) * C.wanderRadius;
          this.target = new THREE.Vector3(this.home.x + Math.cos(a) * d, 0, this.home.z + Math.sin(a) * d);
          const B = CONFIG.map.boundary - 2;
          this.target.x = clamp(this.target.x, -B, B); this.target.z = clamp(this.target.z, -B, B);
        }
      }
      if (this.target) {
        const dx = this.target.x - this.root.x, dz = this.target.z - this.root.z;
        const dist = Math.hypot(dx, dz);
        if (dist < 0.25) { this.target = null; this.idleTimer = rand(2, 5); }
        else {
          wantYaw = Math.atan2(dx, dz);
          wantSpeed = C.walkSpeed * (1 - 0.55 * limp) * (1 - 0.4 * painF) * clamp(dist / 0.5, 0.3, 1);
        }
      }
    } else if (mode === 'flee') {
      // run straight away from the player, sliding along the edge of the map when it gets there
      const B = CONFIG.map.boundary - 3;
      let ax = pp.x - P.pos.x, az = pp.z - P.pos.z;
      const l = Math.hypot(ax, az) || 1; ax /= l; az /= l;
      if (Math.abs(pp.x) > B && Math.sign(ax) === Math.sign(pp.x)) ax = 0;
      if (Math.abs(pp.z) > B && Math.sign(az) === Math.sign(pp.z)) az = 0;
      if (!ax && !az) { ax = -Math.sign(pp.x) || 1; az = -Math.sign(pp.z) * 0.4; }   // cornered: run past
      wantYaw = Math.atan2(ax, az);
      run = clamp(1 - limp * 1.3) * (1 - 0.5 * painF);
      wantSpeed = lerp(C.walkSpeed, C.runSpeed, run) * (1 - 0.5 * limp);
      // far enough away: calm down a little faster
      if (distP > 18) this.fear = Math.max(0, this.fear - dt * 0.08);
    } else if (mode === 'handsUp') {
      wantYaw = faceP;
    } else if (mode === 'backAway') {
      wantYaw = faceP; back = true;
      wantSpeed = 0.55 * (1 - 0.6 * limp);
    }
    if (wantYaw !== null) {
      const diff = wrapAngle(wantYaw - this.yaw);
      this.yaw += clamp(diff, -(run ? 2.6 : 1.6) * dt, (run ? 2.6 : 1.6) * dt);
      if (!back && Math.abs(diff) > 0.7) wantSpeed *= 0.25;
    }

    this.walkAmt += ((wantSpeed > 0.05 ? 1 : 0) - this.walkAmt) * damp(4, dt);
    this.run = lerp(this.run || 0, run, damp(3, dt));
    const R = this.run;
    const freq = 5.4 * (0.6 + 0.4 * Math.min(1, wantSpeed / C.walkSpeed)) * (1 - 0.25 * limp) * (1 + 0.45 * R);
    this.phase += dt * freq * this.walkAmt * (back ? -1 : 1);

    // Limp hitch: slow down while the weak leg carries the weight.
    const weakPh = limpSide === 'L' ? this.phase : this.phase + Math.PI;
    const weakStance = Math.cos(weakPh) < 0 ? -Math.cos(weakPh) : 0; // 0..1 while weak leg is planted
    this.speed = wantSpeed * (1 - 0.65 * limp * weakStance);

    const fwd = _v.set(Math.sin(this.yaw), 0, Math.cos(this.yaw));
    if (this.stagger > 0) this.stagger -= dt;
    this.root.addScaledVector(fwd, this.speed * dt * (back ? -1 : 1));
    // Keep the virtual root near the real pelvis (it can't walk through obstacles).
    const off = Math.hypot(this.root.x - pp.x, this.root.z - pp.z);
    if (off > 0.3) { this.root.x = lerp(this.root.x, pp.x, 0.08); this.root.z = lerp(this.root.z, pp.z, 0.08); }

    // Gait (a jog when running away: longer strides, knees higher, arms pumping)
    const w = this.walkAmt;
    for (const s of ['L', 'R']) {
      const ph = s === 'L' ? this.phase : this.phase + Math.PI;
      const weak = s === limpSide ? limp : 0;
      const amp = 0.36 * w * (1 - 0.45 * weak) * (1 + 0.4 * R);
      pose[`hip${s}`] = [Math.sin(ph) * amp + 0.04 + R * 0.08, 0.03];
      pose[`knee${s}`] = 0.07 + Math.max(0, Math.cos(ph)) * 0.75 * w * (1 - 0.6 * weak) * (1 + 0.55 * R) + (s === limpSide ? 0 : limp * 0.15) + R * 0.12;
      pose[`ankle${s}`] = -Math.max(0, Math.cos(ph)) * 0.25 * w;
      const opp = s === 'L' ? this.phase + Math.PI : this.phase;
      pose[`shoulder${s}`] = [Math.sin(opp) * 0.32 * w * (1 + 0.9 * R) + 0.03, 0.09 + limp * 0.12];
      pose[`elbow${s}`] = 0.2 + Math.max(0, Math.sin(opp)) * 0.3 * w + R * 1.1;
    }
    const breath = Math.sin(this.time * (1.6 + this.fear * 2.5)) * (0.015 + this.fear * 0.012);
    pose.spine = 0.03 + painF * 0.35 + limp * 0.12 + R * 0.14;
    pose.chest = breath + painF * 0.15;
    pose.neck = -painF * 0.2 - R * 0.1;
    // looks at the player once it knows they are there, otherwise glances around
    if (this.aware && (this.fear > 0.08 || distP < 7) && !R) pose.headYaw = clamp(wrapAngle(faceP - this.yaw), -1.15, 1.15);
    else pose.headYaw = noise1(this.time * 0.35, this.seed) * 0.7 * (1 - w * 0.6);
    pose.pelvisRoll = (limpSide === 'L' ? 1 : -1) * limp * weakStance * 0.14;
    pose.pelvisPitch = 0.04 + limp * 0.08 + R * 0.06;

    let drop = 0;
    if (mode === 'handsUp') {
      // surrender: both hands up, still, watching the gun; it trembles when it's scared
      const shake = this.fear * 0.06;
      for (const s of ['L', 'R']) {
        if ((s === 'L' ? armL : armR) < 0.25) continue;
        pose[`shoulder${s}`] = [2.7 + noise1(this.time * 7, this.seed + (s === 'L' ? 1 : 2)) * shake, 0.34];
        pose[`elbow${s}`] = 1.2 + noise1(this.time * 6, this.seed + 3) * shake;
      }
      pose.neck = 0.08;
    } else if (mode === 'cower') {
      // flinch: duck and cover the head with both arms
      drop = 0.17;
      for (const s of ['L', 'R']) {
        pose[`hip${s}`] = [0.62, 0.08]; pose[`knee${s}`] = 1.05; pose[`ankle${s}`] = 0.3;
        if ((s === 'L' ? armL : armR) < 0.25) continue;
        pose[`shoulder${s}`] = [2.45, -0.32]; pose[`elbow${s}`] = 2.25;
      }
      pose.spine = 0.38; pose.chest = 0.15; pose.neck = 0.5; pose.headYaw = 0;
    } else if (mode === 'backAway') {
      // hands up in a guard while stepping back
      for (const s of ['L', 'R']) {
        if ((s === 'L' ? armL : armR) < 0.25) continue;
        pose[`shoulder${s}`] = [1.3, -0.14]; pose[`elbow${s}`] = 1.95;
      }
      pose.spine = 0.08; pose.neck = -0.05;
    } else {
      // hold the worst bleeding wound with the other hand
      this.pressWound(pose, { armL, armR, awake, lying: false });
    }

    const height = C.standHeight - limp * weakStance * 0.075 - painF * 0.03 - Math.abs(Math.cos(this.phase)) * 0.015 * w - R * 0.035 - drop;
    r.pelvisTarget.set(this.root.x, height, this.root.z);
    r.pelvisTargetVel.copy(fwd).multiplyScalar(this.speed * (back ? -1 : 1));

    // Foot targets: where each foot should be for this point of the gait cycle.
    const side = _v2.set(Math.cos(this.yaw), 0, -Math.sin(this.yaw)); // ragdoll's left (+X when yaw = 0)
    for (const s of ['L', 'R']) {
      const ph = s === 'L' ? this.phase : this.phase + Math.PI;
      const hip = pose[`hip${s}`][0] - R * 0.08;
      const reach = Math.sin(hip) * 0.86 + 0.045;                      // forward offset from the hip
      const lift = Math.max(0, Math.cos(ph)) * 0.09 * w * (s === limpSide ? 1 - 0.5 * limp : 1) * (1 + R);
      const sx = s === 'L' ? 0.095 : -0.095;
      r.footTarget[s].set(
        this.root.x + fwd.x * reach + side.x * sx,
        0.03 + lift,
        this.root.z + fwd.z * reach + side.z * sx
      );
    }
    r.footPosStrength = mode === 'cower' ? 0 : 0.7 * w;

    const staggerMul = this.stagger > 0 ? 0.65 : 1;
    const sup = clamp((support - 0.25) / 0.6) * awake;
    r.pelvisPosStrength = sup * staggerMul;
    r.gravityComp = 0.92 * sup;
    S.pelvis = 0.9 * sup * staggerMul;
    S.abdomen = 0.85 * awake; S.chest = 0.85 * awake; S.head = 0.6 * awake;
    for (const s of ['L', 'R']) {
      const lc = s === 'L' ? capL : capR, ac = s === 'L' ? armL : armR;
      S[`thigh${s}`] = 0.85 * lc * awake; S[`shin${s}`] = 0.8 * lc * awake; S[`foot${s}`] = 0.6 * lc * awake;
      S[`upperArm${s}`] = 0.65 * ac * awake; S[`lowerArm${s}`] = 0.5 * ac * awake; S[`hand${s}`] = 0.35 * ac * awake;
    }
    this.activity = mode === 'flee' ? (limp > 0.15 ? 'Limping away' : 'Running away')
      : mode === 'handsUp' ? 'Hands up' : mode === 'cower' ? 'Covering its head' : mode === 'backAway' ? 'Backing away'
      : h.pressing ? 'Holding its wound' : !this.target ? (limp > 0.15 ? 'Standing (hurt)' : 'Idle') : limp > 0.15 ? 'Limping' : 'Wandering';
  }

  /** Awareness: where the player is, whether a weapon is pointed at it, and how scared it is. */
  sense(dt, pp, awake, painF) {
    const P = this.player, h = this.h;
    this.cower = Math.max(0, this.cower - dt);
    this.aware = false; this.aimed = false;
    if (!h.alive || awake < 0.25) { this.fear = Math.max(0, this.fear - dt * 0.05); return; }
    if (P) {
      const d = Math.hypot(P.pos.x - pp.x, P.pos.z - pp.z);
      this.aware = d < 40;
      this.aimed = !!P.armed && P.aimedAt === this.r && d < 30;
      if (this.aimed) { this.aimedTime += dt; this.scare(dt * (d < 8 ? 0.1 : 0.04) * (this.aimedTime > 5 ? 1.8 : 1)); }
      else this.aimedTime = Math.max(0, this.aimedTime - dt);
      if (P.melee && d < 2.5) this.scare(dt * 0.1);
    }
    // pain and heavy bleeding keep it scared; otherwise it calms down slowly
    const floor = (painF * 0.5 + (h.bleedRate > 2 ? 0.12 : 0)) * Math.min(1, this.fearMul);
    if (this.fear > floor) this.fear = Math.max(floor, this.fear - dt * 0.035);
  }

  /**
   * Press a hand on the worst bleeding wound it can reach (slows that wound down, see Health).
   * Returns the wound, or null.
   */
  pressWound(pose, { armL, armR, awake, lying }) {
    const h = this.h, S = this.r.strength;
    if (awake < 0.35) return null;
    let best = null;
    for (const w of h.wounds) {
      if (w.stump || w.rate < 0.6 || !h.parts[w.part]?.attached || /hand/.test(w.part)) continue;
      if (!lying && /shin|foot/.test(w.part)) continue;   // can't reach that far down standing up
      if (!best || w.rate > best.rate) best = w;
    }
    if (!best) return null;
    const side = best.part.endsWith('L') ? 'L' : best.part.endsWith('R') ? 'R' : null;
    const arm = side === 'L' ? 'R' : side === 'R' ? 'L' : (armR >= armL ? 'R' : 'L');
    if ((arm === 'L' ? armL : armR) < 0.3) return null;
    const low = /thigh|shin|foot|pelvis/.test(best.part), mid = best.part === 'abdomen', head = best.part === 'head';
    if (lying) {
      pose[`shoulder${arm}`] = [low ? 0.3 : head ? 2.3 : mid ? 0.45 : 0.65, -0.4];
      pose[`elbow${arm}`] = low ? 0.35 : head ? 2.2 : mid ? 1.3 : 1.7;
      S[`upperArm${arm}`] = Math.max(S[`upperArm${arm}`] || 0, 0.3 * awake);
      S[`lowerArm${arm}`] = Math.max(S[`lowerArm${arm}`] || 0, 0.25 * awake);
    } else {
      pose[`shoulder${arm}`] = [low ? 0.35 : mid ? 0.55 : head ? 2.3 : 0.75, -0.28];
      pose[`elbow${arm}`] = low ? 0.6 : head ? 2.2 : mid ? 1.5 : 1.85;
    }
    h.pressing = best;
    return best;
  }

  decideOnGround({ capL, capR, armL, armR, support }) {
    const h = this.h;
    const canStand = support > 0.55 && h.pain < 65 && h.consciousness > 62 && !h.paralyzed;
    if (canStand) { this.startGetup(); return; }
    const armsOk = Math.max(armL, armR) > 0.3;
    if (armsOk && this.fear > 0.6 && h.pain < 85 && Math.random() < 0.7) { this.setState('crawl'); this.crawlYaw = this.r.heading(); this.nextDecision = rand(5, 9); return; }
    if (h.pain > 45 && Math.random() < 0.75) { this.setState('squirm'); this.nextDecision = rand(2.5, 5); return; }
    if (armsOk) { this.setState('crawl'); this.crawlYaw = this.r.heading(); this.nextDecision = rand(4, 8); return; }
    this.setState('squirm'); this.nextDecision = rand(3, 6);
  }

  startGetup() {
    const pp = this.r.bodyPos('pelvis');
    this.getup = { from: pp.clone() };
    this.yaw = this.r.heading();
    this.root.set(pp.x, 0, pp.z);
    this.setState('getup');
  }

  updateGetup(dt, pose, { support, awake }) {
    const r = this.r, S = r.strength;
    this.activity = 'Getting up';
    const T = 1.8, t = clamp(this.stateTime / T);
    const pp = r.bodyPos('pelvis');
    this.root.x = lerp(this.root.x, pp.x, 0.05); this.root.z = lerp(this.root.z, pp.z, 0.05);
    let height, hip, knee;
    if (t < 0.45) { const u = t / 0.45; height = lerp(this.getup.from.y, 0.52, u); hip = 1.3; knee = 2.0; pose.spine = 0.6; }
    else { const u = (t - 0.45) / 0.55; const e = u * u * (3 - 2 * u); height = lerp(0.52, C.standHeight, e); hip = lerp(1.3, 0.02, e); knee = lerp(2.0, 0.06, e); pose.spine = lerp(0.6, 0.05, e); }
    pose.pelvisPitch = -0.2 * (1 - t);
    pose.hipL = [hip, 0.06]; pose.hipR = [hip, 0.06]; pose.kneeL = knee; pose.kneeR = knee;
    pose.shoulderL = [0.5 * (1 - t), 0.2]; pose.shoulderR = [0.5 * (1 - t), 0.2];
    pose.elbowL = 0.6; pose.elbowR = 0.6;
    const ramp = clamp(this.stateTime / 0.5) * awake;
    r.pelvisTarget.set(this.root.x, height, this.root.z);
    r.pelvisPosStrength = ramp * clamp(support + 0.2);
    r.gravityComp = 0.85 * ramp * clamp(support);
    for (const n in r.parts) S[n] = 0.8 * ramp * this.h.partCap(n);
    S.pelvis = ramp;
    if (t >= 1) { this.setState('stand'); this.target = null; this.idleTimer = rand(1, 2); }
    else if (this.stateTime > 0.9 && (r.bodyPos('pelvis').y < 0.3 || support < 0.4)) this.fall();
  }

  // ------------------------------------------------------------------ ground behaviours
  updateCrawl(dt, pose, { capL, capR, armL, armR, awake, painF }) {
    const r = this.r, S = r.strength;
    this.activity = 'Crawling';
    if (this.stateTime > this.nextDecision) { this.decideOnGround({ capL, capR, armL, armR, support: Math.min(capL, capR) * 0.45 + (capL + capR) * 0.275 }); return; }
    // Crawl head-first; steer slowly away from where the shots came from.
    const heading = r.heading();
    this.crawlYaw = heading;
    // away from the player if it knows where they are, otherwise away from where the shots came from
    const P = this.player;
    const cp0 = r.bodyPos('chest', _v2);
    const away = P && this.aware ? Math.atan2(cp0.x - P.pos.x, cp0.z - P.pos.z) : Math.atan2(this.lastHitDir.x, this.lastHitDir.z);
    this.activity = P && this.aware && this.fear > 0.3 ? 'Crawling away' : 'Crawling';
    const steer = clamp(wrapAngle(away - heading), -1, 1) * 0.6 * awake;
    for (const n of ['chest', 'abdomen', 'pelvis']) r.parts[n].body.angularVelocity.y += (steer - r.parts[n].body.angularVelocity.y) * 0.1;
    const armPower = Math.max(armL, armR);
    this.phase += dt * 3.2 * (0.5 + 0.5 * armPower);
    for (const s of ['L', 'R']) {
      const ph = s === 'L' ? this.phase : this.phase + Math.PI;
      const ac = s === 'L' ? armL : armR;
      pose[`shoulder${s}`] = [1.15 + 0.55 * Math.sin(ph), 0.3];
      pose[`elbow${s}`] = 0.5 + 0.8 * Math.max(0, -Math.cos(ph));
      S[`upperArm${s}`] = 0.6 * ac * awake; S[`lowerArm${s}`] = 0.5 * ac * awake; S[`hand${s}`] = 0.2 * ac * awake;
      const lc = s === 'L' ? capL : capR;
      if (lc > 0.4) {   // a working leg pushes
        pose[`hip${s}`] = [0.55 + 0.45 * Math.sin(ph + Math.PI), 0.25];
        pose[`knee${s}`] = 1.0 + 0.6 * Math.sin(ph + Math.PI);
      } else { pose[`hip${s}`] = [0.08, 0.06]; pose[`knee${s}`] = 0.25; }
      S[`thigh${s}`] = 0.35 * lc * awake + 0.03; S[`shin${s}`] = 0.3 * lc * awake + 0.03;
    }
    pose.neck = -0.55; pose.spine = -0.08; pose.chest = -0.1;
    S.pelvis = 0.25 * awake; S.abdomen = 0.4 * awake; S.chest = 0.45 * awake; S.head = 0.4 * awake;
    const cp = r.bodyPos('chest');
    // Each arm pull gives a surge forward.
    const speed = 0.6 * armPower * (1 - 0.4 * painF) * (0.25 + 0.75 * Math.max(0, -Math.cos(this.phase * 2)));
    const fwd = _v.set(Math.sin(this.crawlYaw), 0, Math.cos(this.crawlYaw));
    r.chestTarget = new THREE.Vector3(cp.x, 0.2, cp.z);
    r.chestTargetVel.copy(fwd).multiplyScalar(speed);
    r.chestPosStrength = 0.6 * armPower * awake;
  }

  updateSquirm(dt, pose, { capL, capR, armL, armR, awake, painF }) {
    const r = this.r, S = r.strength, h = this.h, t = this.time;
    this.activity = 'Writhing in pain';
    if (this.stateTime > this.nextDecision) { this.decideOnGround({ capL, capR, armL, armR, support: Math.min(capL, capR) * 0.45 + (capL + capR) * 0.275 }); return; }
    pose.relative = true;
    const sd = this.seed, f = 0.9 + painF * 1.4;
    const n = (k, s) => noise1(t * f * k, sd + s);
    pose.spine = 0.25 + 0.3 * n(1, 1);
    pose.chest = 0.15 + 0.25 * n(1.1, 2);
    pose.chestRoll = 0.3 * n(0.8, 3);
    pose.neck = 0.2 + 0.4 * n(1.3, 4);
    pose.headYaw = 0.7 * n(0.9, 5);
    pose.hipL = [0.8 + 0.7 * n(1.2, 6), 0.2 * n(1, 7)];
    pose.hipR = [0.8 + 0.7 * n(1.15, 8), 0.2 * n(1, 9)];
    pose.kneeL = 1.2 + 0.8 * n(1.4, 10);
    pose.kneeR = 1.2 + 0.8 * n(1.35, 11);
    // Hands clutch the wound / flail
    pose.shoulderL = [0.7 + 0.6 * n(1.5, 12), -0.25 + 0.4 * n(1, 13)];
    pose.shoulderR = [0.7 + 0.6 * n(1.45, 14), -0.25 + 0.4 * n(1, 15)];
    pose.elbowL = 1.5 + 0.5 * n(1.6, 16);
    pose.elbowR = 1.5 + 0.5 * n(1.6, 17);
    const st = (0.18 + 0.4 * painF) * awake;
    for (const name in r.parts) S[name] = st * h.partCap(name);
    S.pelvis = 0;
    // between the thrashing, hold the worst wound
    if (noise1(t * 0.3, sd + 40) > -0.2) this.pressWound(pose, { armL, armR, awake, lying: true });
    // Occasional roll / thrash
    if (Math.random() < dt * (0.4 + painF)) {
      const axis = Y.clone().applyQuaternion(r.bodyQuat('chest', _q)).multiplyScalar((Math.random() - 0.5) * 6 * st);
      for (const name of ['chest', 'abdomen', 'pelvis']) {
        const w = r.parts[name].body.angularVelocity; w.x += axis.x; w.y += axis.y; w.z += axis.z;
      }
    }
  }

  updateGrabbed(dt, pose, { awake }) {
    const r = this.r, S = r.strength, h = this.h, t = this.time;
    this.activity = h.alive ? (awake > 0.2 ? 'Grabbed: curled up' : 'Grabbed (limp)') : 'Grabbed (dead)';
    pose.relative = true;
    const n = (k, s) => noise1(t * k, this.seed + s);
    const struggle = h.alive ? 0.12 * awake : 0;
    pose.spine = 0.7 + struggle * n(2, 1);
    pose.chest = 0.6 + struggle * n(2.2, 2);
    pose.neck = 0.65 + struggle * n(1.7, 3);
    pose.hipL = [1.75 + struggle * n(2.5, 4), 0.12];
    pose.hipR = [1.75 + struggle * n(2.4, 5), 0.12];
    pose.kneeL = 2.25; pose.kneeR = 2.25;
    pose.ankleL = 0.4; pose.ankleR = 0.4;
    // arms hug the knees
    pose.shoulderL = [1.05 + struggle * n(3, 6), -0.35];
    pose.shoulderR = [1.05 + struggle * n(3.1, 7), -0.35];
    pose.elbowL = 1.9; pose.elbowR = 1.9;
    const st = !h.alive ? 0.14 : h.consciousness < 22 ? 0.25 : 0.45 + 0.35 * awake;
    for (const name in r.parts) S[name] = st * Math.max(0.35, h.partCap(name));
    S.pelvis = 0;
  }

  twitch(amount) {
    const names = Object.keys(this.r.parts);
    for (let i = 0; i < 3; i++) {
      const n = names[(Math.random() * names.length) | 0];
      if (!this.h.parts[n].attached) continue;
      const w = this.r.parts[n].body.angularVelocity;
      w.x += (Math.random() - 0.5) * 8 * amount; w.y += (Math.random() - 0.5) * 4 * amount; w.z += (Math.random() - 0.5) * 8 * amount;
    }
  }
}
