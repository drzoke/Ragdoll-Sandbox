// Jobs that run before every physics step, wherever the physics runs (main thread or worker):
// the ragdoll muscles and the grab beam. Each frame the game hands the physics a list of
// "programs" (plain data: which bodies, which targets, how strong) and these functions apply them
// at every step of that frame. No imports, so the physics worker can load this file as it is.

const KP = 20, KD = 40;
// Torso + head; the share accounts for the limbs hanging off them.
const CORE = ['pelvis', 'abdomen', 'chest', 'head'];
const CORE_SHARE = 1.45;
const CRAWL = [['chest', 1], ['abdomen', 0.8], ['pelvis', 0.6], ['upperArmL', 0.4], ['upperArmR', 0.4]];
const SIDES = ['L', 'R'];

/**
 * onWake(program) is called when a sleeping ragdoll gets pushed; it returns true if the ragdoll
 * woke up right away (main thread) so its muscles work this step too.
 */
export function runProgram(p, h, onWake) {
  if (p.kind === 'muscles') muscles(p, h, onWake);
  else if (p.kind === 'grab') grab(p, h);
}

/**
 * Ragdoll muscles: velocity servos that turn each part towards its target orientation, carry the
 * body's weight while standing, hold the pelvis up, place the feet and drag the chest when
 * crawling. P (built by Ragdoll.physicsProgram):
 *   names  part names, b {name: body or null if blown off}, att {name: still attached}
 *   s      {name: strength after flinching}, sr {name: raw strength}
 *   q      {name: target quaternion}, w {name: feed-forward angular velocity}
 *   gc     gravity compensation; pps/pt/ptv/ppa pelvis servo; fps/ft foot placement;
 *   cps/ct/ctv chest servo (crawling)
 */
function muscles(P, h, onWake) {
  const B = P.b;
  if (P.asleep) {
    // a blast, the defibrillator or the grab tool pushed a sleeping body: everything wakes up
    let pushed = false;
    for (const name of P.names) {
      const b = B[name];
      if (!b) continue;
      const v = b.velocity, w = b.angularVelocity;
      if (v.x || v.y || v.z || w.x || w.y || w.z) { pushed = true; break; }
    }
    if (!pushed || P.wakeAsked) return;
    if (onWake?.(P)) P.asleep = false;
    else { P.wakeAsked = true; return; }
  }
  for (const name of P.names) {
    const b = B[name];
    if (!b) continue;
    // Safety net against solver blow-ups (body pinned against the floor by the grab beam etc.)
    const av = b.angularVelocity, wl = av.x * av.x + av.y * av.y + av.z * av.z;
    if (wl > 1600) { const f = 40 / Math.sqrt(wl); av.x *= f; av.y *= f; av.z *= f; }
    const s = P.s[name] || 0;
    if (s <= 0.001) continue;
    // rotation still needed: target * inverse(current)
    const t = P.q[name], bq = b.quaternion;
    const ax = t.x, ay = t.y, az = t.z, aw = t.w, bx = -bq.x, by = -bq.y, bz = -bq.z, bw = bq.w;
    let qx = ax * bw + aw * bx + ay * bz - az * by;
    let qy = ay * bw + aw * by + az * bx - ax * bz;
    let qz = az * bw + aw * bz + ax * by - ay * bx;
    let qw = aw * bw - ax * bx - ay * by - az * bz;
    if (qw < 0) { qx = -qx; qy = -qy; qz = -qz; qw = -qw; }
    const sinHalf = Math.sqrt(qx * qx + qy * qy + qz * qz);
    const angle = 2 * Math.atan2(sinHalf, qw);
    let vx = 0, vy = 0, vz = 0;
    if (sinHalf > 1e-6) { const f = angle * KP / sinHalf; vx = qx * f; vy = qy * f; vz = qz * f; }
    const ff = P.w[name];
    vx += ff.x; vy += ff.y; vz += ff.z;
    const k = Math.min(1, s * KD * h);
    av.x += (vx - av.x) * k; av.y += (vy - av.y) * k; av.z += (vz - av.z) * k;
  }
  // Gravity compensation: while the legs are supporting the body, its weight is carried by
  // "muscles" so the positional servo only corrects small errors. Only the core: limbs keep their
  // own weight (compensating them makes swinging arms overshoot).
  const gc = P.gc;
  if (gc > 0.001) {
    for (const name of CORE) {
      if (!P.att[name] || !B[name]) continue;
      B[name].velocity.y += 9.81 * h * gc * CORE_SHARE;
    }
  }
  // Pelvis positional servo ("legs holding the body up")
  if (P.pps > 0.001 && B.pelvis) {
    const b = B.pelvis, t = P.pt, a = P.ppa, tv = P.ptv;
    const k = Math.min(1, P.pps * 30 * h);
    const vx = (t.x - b.position.x) * 9 + tv.x;
    const vy = (t.y - b.position.y) * 11 + tv.y;
    const vz = (t.z - b.position.z) * 9 + tv.z;
    b.velocity.x += (vx - b.velocity.x) * k * a.x;
    b.velocity.y += (vy - b.velocity.y) * k * a.y;
    b.velocity.z += (vz - b.velocity.z) * k * a.z;
  }
  // Foot placement while walking: stance foot stays planted, swing foot steps forward.
  if (P.fps > 0.001) {
    for (const s of SIDES) {
      const name = s === 'L' ? 'footL' : 'footR';
      if (!P.att[name] || !B[name]) continue;
      const b = B[name], t = P.ft[s];
      const k = Math.min(1, P.fps * (P.sr[name] || 0) * 40 * h);
      b.velocity.x += ((t.x - b.position.x) * 12 - b.velocity.x) * k;
      b.velocity.y += ((t.y - b.position.y) * 12 - b.velocity.y) * k;
      b.velocity.z += ((t.z - b.position.z) * 12 - b.velocity.z) * k;
    }
  }
  // Crawling: arms drag the upper body along the floor.
  if (P.ct && P.cps > 0.001) {
    const t = P.ct, cv = P.ctv;
    for (const [name, mul] of CRAWL) {
      if (!P.att[name] || !B[name]) continue;
      const b = B[name];
      const k = Math.min(1, P.cps * 90 * h * mul);
      b.velocity.x += (cv.x - b.velocity.x) * k;
      b.velocity.z += (cv.z - b.velocity.z) * k;
      if (name === 'chest') b.velocity.y += ((t.y - b.position.y) * 6 - b.velocity.y) * k * 0.5;
    }
  }
}

/** The grab beam: the anchor glides to its target and the field carries part of the weight. */
function grab(P, h) {
  const a = P.anchor, t = P.target;
  // kinematic anchor: its velocity is integrated by the world
  const vx = (t.x - a.position.x) * 22, vy = (t.y - a.position.y) * 22, vz = (t.z - a.position.z) * 22;
  const sp = Math.hypot(vx, vy, vz), cap = 28;
  const k = sp > cap ? cap / sp : 1;
  a.velocity.set(vx * k, vy * k, vz * k);
  for (const b of P.set) b.velocity.y += 9.81 * h * P.holdComp;
  // light damping of spin on the held part
  const w = P.held.angularVelocity;
  w.x *= 0.995; w.y *= 0.995; w.z *= 0.995;
}
