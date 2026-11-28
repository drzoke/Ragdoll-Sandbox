// The main thread's side of the physics worker (see physicsWorker.js).
//
// The game keeps using its own cannon-es world exactly as before: it adds and removes bodies and
// joints, reads positions, pushes bodies, teleports them. In worker mode that world isn't stepped
// here; it is a copy kept in step with the worker:
//   - adding/removing bodies, joints and shapes is recorded and sent along,
//   - once per frame (flush, right before drawing) every body is compared with how the worker last
//     left it, and the ones the game changed are sent,
//   - the worker steps while this thread draws, and its results (new positions and speeds,
//     collisions, contacts) are copied back at the start of the next physics update.
// The game sees the physics one frame later than before, in exchange for the simulation and the
// drawing running at the same time.
import * as CANNON from '../../lib/cannon-es.js';
import { STRIDE, PROPS, writeState, readState, bodyData, constraintData, shapeData, propsOf } from './physicsWire.js';

const SLEEPING = CANNON.Body.SLEEPING;

function propsChanged(b) {
  const pr = b._props;
  if (!pr) return true;
  for (let i = 0; i < PROPS.length; i++) {
    const x = b[PROPS[i]];
    if ((typeof x === 'boolean' ? (x ? 1 : 0) : x) !== pr[i]) return true;
  }
  return false;
}

export class PhysicsLink {
  constructor(physics) {
    this.physics = physics;
    this.world = physics.world;
    this.state = 'off';          // off | starting | on
    this.worker = null;
    this.cmds = [];
    this.busy = false;           // a step is out at the worker
    this.inbox = null;           // its result, waiting to be copied in
    this.pendingDt = 0;
    this.ts = 1;
    this.seq = 0;
    this.epoch = 0;
    this.batch = 0;
    this.contacts = [];
    this.stats = { rateHz: 120, loadMs: 0, load: 0, stepCost: 0.5, rate: 0 };
    this.nextPid = 1; this.nextCid = 1;
    this.byPid = new Map();      // the bodies in the world, by id
    this.wrapWorld();
  }

  get on() { return this.state === 'on'; }
  get recording() { return this.state !== 'off'; }

  // ------------------------------------------------------------------ recording world changes
  wrapWorld() {
    const w = this.world, link = this;
    const addBody = w.addBody.bind(w), removeBody = w.removeBody.bind(w);
    const addConstraint = w.addConstraint.bind(w), removeConstraint = w.removeConstraint.bind(w);
    w.addBody = (b) => {
      const was = b.world === w;
      addBody(b);
      link.prepare(b);
      link.byPid.set(b._pid, b);
      if (!was && link.recording) link.cmds.push({ op: 'add', b });
    };
    w.removeBody = (b) => {
      const was = b.world === w;
      removeBody(b);
      if (was) link.byPid.delete(b._pid);
      if (was && link.recording) link.cmds.push({ op: 'remove', pid: b._pid });
    };
    w.addConstraint = (c) => {
      const was = w.constraints.includes(c);
      addConstraint(c);
      if (!c._cid) c._cid = link.nextCid++;
      if (!was && link.recording) link.cmds.push({ op: 'addC', c });
    };
    w.removeConstraint = (c) => {
      const was = w.constraints.includes(c);
      removeConstraint(c);
      if (was && link.recording && c._cid) link.cmds.push({ op: 'removeC', cid: c._cid });
    };
  }

  /** Give a body its id and watch its shape and listener changes. */
  prepare(b) {
    if (b._pid) return;
    b._pid = this.nextPid++;
    const link = this;
    const addShape = b.addShape.bind(b), removeShape = b.removeShape.bind(b), listen = b.addEventListener.bind(b);
    b.addShape = (shape, offset, orientation) => {
      addShape(shape, offset, orientation);
      if (link.recording && b.world) link.cmds.push({ op: 'shapeAdd', b, s: shapeData(shape, offset, orientation) });
      return b;
    };
    b.removeShape = (shape) => {
      const i = b.shapes.indexOf(shape);
      removeShape(shape);
      if (i >= 0 && link.recording && b.world) link.cmds.push({ op: 'shapeRemove', b, i });
      return b;
    };
    b.addEventListener = (type, fn) => {
      if (type === 'collide' && !b._reportCollide) {
        b._reportCollide = true;
        if (link.recording && b.world) link.cmds.push({ op: 'flag', b });
      }
      return listen(type, fn);
    };
    if (b.hasAnyEventListener('collide')) b._reportCollide = true;
  }

  // ------------------------------------------------------------------ start / stop
  start() {
    if (this.state !== 'off') return true;
    let worker;
    try { worker = new Worker(new URL('./physicsWorker.js', import.meta.url), { type: 'module' }); }
    catch (err) { console.warn('Physics worker unavailable, physics stays on the main thread', err); return false; }
    this.worker = worker;
    worker.onmessage = (e) => this.receive(e.data);
    worker.onerror = (e) => { console.warn('Physics worker failed, back to the main thread', e.message || e); this.stop(); };
    // the whole world as it is now
    this.batch++;
    const cmds = [];
    for (const b of this.world.bodies) { this.prepare(b); this.byPid.set(b._pid, b); cmds.push({ op: 'add', d: this.snapshotAdd(b) }); }
    for (const c of this.world.constraints) { if (!c._cid) c._cid = this.nextCid++; cmds.push({ op: 'addC', d: constraintData(c) }); }
    this.cmds = [];
    this.state = 'starting';
    this.busy = true;            // until the worker says it's ready
    this.inbox = null;
    this.pendingDt = 0;
    worker.postMessage({ type: 'init', cmds, time: this.physics.time });
    return true;
  }

  stop() {
    if (this.state === 'off') return;
    if (this.inbox && this.state === 'on') this.applyResult(this.inbox);
    this.worker?.terminate();
    this.worker = null;
    this.state = 'off';
    this.cmds = [];
    this.inbox = null;
    this.busy = false;
    this.world.contacts = [];
    this.physics.onLinkStopped?.();
  }

  receive(m) {
    if (m.type === 'ready') { this.state = 'on'; this.busy = false; return; }
    if (m.type === 'error') { console.warn('Physics worker error, back to the main thread:', m.message); this.stop(); return; }
    if (m.type !== 'result') return;
    this.busy = false;
    if (m.epoch !== this.epoch) return;       // the main thread stepped on its own meanwhile (title screen)
    this.inbox = m;
  }

  /** The main thread is about to step the world itself: results already on their way are stale. */
  invalidate() { this.epoch++; this.inbox = null; }

  // ------------------------------------------------------------------ each frame
  /** Start of the physics update: copy in the worker's last result. */
  update(dt, ts) {
    this.pendingDt = Math.min(0.25, this.pendingDt + dt);
    this.ts = ts;
    if (this.inbox) { const m = this.inbox; this.inbox = null; this.applyResult(m); }
  }

  /** End of the frame: send what the game changed and let the worker step. */
  flush(programs) {
    if (this.state !== 'on' || this.busy) return;
    if (this.inbox) { const m = this.inbox; this.inbox = null; this.applyResult(m); }
    const batch = ++this.batch;
    const cmds = [];
    for (const c of this.cmds) {
      switch (c.op) {
        case 'add':
          if (c.b.world !== this.world || c.b._batch === batch) break;
          cmds.push({ op: 'add', d: this.snapshotAdd(c.b) });
          c.b._batch = batch;
          break;
        case 'remove': case 'removeC':
          cmds.push(c);
          break;
        case 'addC':
          if (!this.world.constraints.includes(c.c)) break;
          cmds.push({ op: 'addC', d: constraintData(c.c) });
          break;
        case 'shapeAdd':
          if (c.b._batch === batch) break;          // sent whole with its shapes above
          cmds.push({ op: 'shapeAdd', pid: c.b._pid, s: c.s });
          break;
        case 'shapeRemove':
          if (c.b._batch === batch) break;
          cmds.push({ op: 'shapeRemove', pid: c.b._pid, i: c.i });
          break;
        case 'flag':
          if (c.b._batch === batch) break;
          cmds.push({ op: 'flag', pid: c.b._pid, collide: !!c.b._reportCollide, contacts: !!c.b.reportContacts });
          break;
      }
    }
    this.cmds = [];
    // bodies the game moved, pushed, slept or woke since the worker last saw them
    const changed = [], props = [];
    for (const b of this.world.bodies) {
      if (b._batch === batch || !b._snap) continue;
      const s = b._snap, p = b.position, q = b.quaternion, v = b.velocity, w = b.angularVelocity;
      if (p.x !== s[1] || p.y !== s[2] || p.z !== s[3] || q.x !== s[4] || q.y !== s[5] || q.z !== s[6] || q.w !== s[7] ||
          v.x !== s[8] || v.y !== s[9] || v.z !== s[10] || w.x !== s[11] || w.y !== s[12] || w.z !== s[13] || b.sleepState !== s[14]) {
        writeState(b, s, 0);
        changed.push(b);
      }
      if (propsChanged(b)) { const now = propsOf(b); b._props = now; props.push({ pid: b._pid, v: now }); }
      if (b.reportContacts && !b._contactsSent) { b._contactsSent = true; cmds.push({ op: 'flag', pid: b._pid, collide: !!b._reportCollide, contacts: true }); }
    }
    const ov = new Float64Array(changed.length * STRIDE);
    changed.forEach((b, k) => ov.set(b._snap, k * STRIDE));
    const progs = programs.map((p) => this.serializeProgram(p)).filter(Boolean);
    const dt = this.pendingDt;
    this.pendingDt = 0;
    this.busy = true;
    this.worker.postMessage({ type: 'step', seq: ++this.seq, epoch: this.epoch, time: this.physics.time, dt, ts: this.ts, cmds, ov, props, progs }, [ov.buffer]);
  }

  snapshotAdd(b) {
    const d = bodyData(b);
    b._snap = new Float64Array(d.state);
    b._props = d.props;
    if (b.reportContacts) b._contactsSent = true;
    return d;
  }

  serializeProgram(p) {
    const v = (o) => ({ x: o.x, y: o.y, z: o.z });
    if (p.kind === 'muscles') {
      const b = {}, q = {}, w = {};
      for (const n of p.names) {
        b[n] = p.b[n] ? p.b[n]._pid : 0;
        const t = p.q[n]; q[n] = { x: t.x, y: t.y, z: t.z, w: t.w };
        w[n] = v(p.w[n]);
      }
      return {
        kind: 'muscles', id: p.id, asleep: p.asleep, names: p.names, b, s: p.s, sr: p.sr, q, w, att: p.att,
        gc: p.gc, pps: p.pps, pt: v(p.pt), ptv: v(p.ptv), ppa: v(p.ppa), fps: p.fps, ft: { L: v(p.ft.L), R: v(p.ft.R) },
        cps: p.cps, ct: p.ct ? v(p.ct) : null, ctv: v(p.ctv),
      };
    }
    if (p.kind === 'grab') {
      return { kind: 'grab', anchor: p.anchor._pid, held: p.held._pid, set: p.set.map((b) => b._pid), target: v(p.target), holdComp: p.holdComp };
    }
    return null;
  }

  /** Copy a worker result into the game's bodies, then hand out its collisions. */
  applyResult(m) {
    const st = m.state, byPid = this.byPid;
    for (let i = 0; i < st.length; i += STRIDE) {
      const b = byPid.get(st[i]);
      if (!b || !b._snap) continue;
      const s = b._snap, p = b.position, q = b.quaternion, v = b.velocity, w = b.angularVelocity;
      // changes the game made since the last flush ride on top of the new state
      const dpx = p.x - s[1], dpy = p.y - s[2], dpz = p.z - s[3];
      const dvx = v.x - s[8], dvy = v.y - s[9], dvz = v.z - s[10];
      const dwx = w.x - s[11], dwy = w.y - s[12], dwz = w.z - s[13];
      const keepQ = q.x !== s[4] || q.y !== s[5] || q.z !== s[6] || q.w !== s[7];
      const qx = q.x, qy = q.y, qz = q.z, qw = q.w;
      const keepSleep = b.sleepState !== s[14];
      s.set(st.subarray(i, i + STRIDE));
      readState(b, st, i);
      if (dpx || dpy || dpz) { p.x += dpx; p.y += dpy; p.z += dpz; }
      if (dvx || dvy || dvz) { v.x += dvx; v.y += dvy; v.z += dvz; }
      if (dwx || dwy || dwz) { w.x += dwx; w.y += dwy; w.z += dwz; }
      if (keepQ) q.set(qx, qy, qz, qw);
      if (!keepSleep) {
        const ws = st[i + 14];
        if (b.sleepState === SLEEPING && ws !== SLEEPING) { b.wakeUp(); s[14] = b.sleepState; }   // touched by something awake
        else b.sleepState = ws;
      }
      b.previousPosition.copy(p);
      b.interpolatedPosition.copy(p);
      b.aabbNeedsUpdate = true;
      if (b.type === CANNON.Body.DYNAMIC) b.updateInertiaWorld();
    }
    this.stats = { rateHz: m.rateHz, loadMs: m.loadMs, load: m.load, stepCost: m.stepCost, rate: m.rate };
    this.physics.time = m.time;
    // contacts (only for bodies that asked: grenades)
    const cs = m.contacts, out = this.contacts;
    out.length = 0;
    for (let i = 0; i < cs.length; i += 5) {
      const bi = byPid.get(cs[i]), bj = byPid.get(cs[i + 1]);
      if (bi && bj) out.push({ bi, bj, ni: new CANNON.Vec3(cs[i + 2], cs[i + 3], cs[i + 4]) });
    }
    this.world.contacts = out;
    // collisions and wake-ups, after every body is up to date
    for (const e of m.events) {
      if (e.t === 'collide') {
        const self = byPid.get(e.self), other = byPid.get(e.other), bi = byPid.get(e.bi), bj = byPid.get(e.bj);
        if (!self || !other || !bi || !bj) continue;
        const v = e.v;
        const contact = {
          bi, bj, si: bi.shapes[e.si], sj: bj.shapes[e.sj],
          ri: new CANNON.Vec3(...e.ri), rj: new CANNON.Vec3(...e.rj), ni: new CANNON.Vec3(...e.ni),
          getImpactVelocityAlongNormal: () => v,
        };
        self.dispatchEvent({ type: 'collide', body: other, contact });
      } else if (e.t === 'wake') this.physics.programWake(e.id);
    }
  }
}
