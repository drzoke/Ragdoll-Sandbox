// The physics worker: runs the real simulation on its own processor core while the main thread
// draws. The main thread keeps a copy of every body (see physicsLink.js); each frame it sends what
// the game changed (new or removed bodies and joints, pushes, teleports, muscle targets) and gets
// back the new positions and speeds, the collisions and the contacts it asked for.
import * as CANNON from '../../lib/cannon-es.js';
import { createWorld, Stepper } from './physicsCore.js';
import { STRIDE, writeState, readState, setProps, buildBody, buildShape, buildConstraint } from './physicsWire.js';

let world, materials, stepper;
const bodies = new Map();        // pid -> body
const constraints = new Map();   // cid -> constraint
let events = [];

function onCollide(e) {
  if (events.length > 4000) return;
  const c = e.contact, self = e.target, other = e.body;
  events.push({
    t: 'collide', self: self._pid, other: other._pid, bi: c.bi._pid, bj: c.bj._pid,
    si: c.bi.shapes.indexOf(c.si), sj: c.bj.shapes.indexOf(c.sj),
    v: c.getImpactVelocityAlongNormal(),
    ri: [c.ri.x, c.ri.y, c.ri.z], rj: [c.rj.x, c.rj.y, c.rj.z], ni: [c.ni.x, c.ni.y, c.ni.z],
  });
}

function flag(b, collide, contacts) {
  if (collide && !b._collide) { b._collide = true; b.addEventListener('collide', onCollide); }
  b._contacts = !!contacts || b._contacts;
}

function apply(cmds) {
  for (const c of cmds) {
    switch (c.op) {
      case 'add': {
        const old = bodies.get(c.d.pid);
        if (old) world.removeBody(old);
        const b = buildBody(c.d, materials);
        flag(b, c.d.collide, c.d.contacts);
        b._sentSleep = -1;
        bodies.set(b._pid, b);
        world.addBody(b);
        break;
      }
      case 'remove': {
        const b = bodies.get(c.pid);
        if (b) { world.removeBody(b); bodies.delete(c.pid); }
        break;
      }
      case 'addC': {
        const A = bodies.get(c.d.a), B = bodies.get(c.d.b);
        if (!A || !B) break;
        const old = constraints.get(c.d.cid);
        if (old) world.removeConstraint(old);
        const k = buildConstraint(c.d, A, B);
        constraints.set(k._cid, k);
        world.addConstraint(k);
        stepper._lastCount = -1;     // new joint: give it the current step's stiffness
        break;
      }
      case 'removeC': {
        const k = constraints.get(c.cid);
        if (k) { world.removeConstraint(k); stepper._lastCount = -1; }
        break;
      }
      case 'shapeAdd': {
        const b = bodies.get(c.pid);
        if (!b) break;
        b.addShape(buildShape(c.s), new CANNON.Vec3(...c.s.off), new CANNON.Quaternion(...c.s.q));
        b.aabbNeedsUpdate = true;
        break;
      }
      case 'shapeRemove': {
        const b = bodies.get(c.pid);
        if (b && b.shapes[c.i]) { b.removeShape(b.shapes[c.i]); b.aabbNeedsUpdate = true; }
        break;
      }
      case 'flag': {
        const b = bodies.get(c.pid);
        if (b) flag(b, c.collide, c.contacts);
        break;
      }
    }
  }
}

/** Bodies the game moved, pushed, put to sleep or woke this frame. */
function override(ov, props) {
  for (let i = 0; i < ov.length; i += STRIDE) {
    const b = bodies.get(ov[i]);
    if (!b) continue;
    const sleep = ov[i + 14];
    if (sleep === CANNON.Body.SLEEPING && b.sleepState !== CANNON.Body.SLEEPING) b.sleep();
    else if (sleep !== CANNON.Body.SLEEPING && b.sleepState === CANNON.Body.SLEEPING) b.wakeUp();
    readState(b, ov, i);
    b.previousPosition.copy(b.position);
    b.interpolatedPosition.copy(b.position);
    b.aabbNeedsUpdate = true;
  }
  for (const p of props) { const b = bodies.get(p.pid); if (b) setProps(b, p.v); }
}

/** Programs arrive with body ids: swap them for the bodies. */
function resolve(progs) {
  const out = [];
  for (const p of progs) {
    if (p.kind === 'muscles') {
      const b = {};
      for (const name of p.names) b[name] = bodies.get(p.b[name]) || null;
      p.b = b;
      out.push(p);
    } else if (p.kind === 'grab') {
      p.anchor = bodies.get(p.anchor); p.held = bodies.get(p.held);
      if (!p.anchor || !p.held) continue;
      p.set = p.set.map((id) => bodies.get(id)).filter(Boolean);
      out.push(p);
    }
  }
  return out;
}

function step(m) {
  apply(m.cmds);
  override(m.ov, m.props);
  stepper.programs = resolve(m.progs);
  stepper.time = m.time;
  const n = stepper.update(m.dt, m.ts);
  // state of every moving body that is awake (or just fell asleep / woke up)
  const list = [];
  for (const b of world.bodies) {
    if (b.type === CANNON.Body.STATIC) continue;
    if (b.sleepState === CANNON.Body.SLEEPING && b._sentSleep === CANNON.Body.SLEEPING) continue;
    b._sentSleep = b.sleepState;
    list.push(b);
  }
  const state = new Float64Array(list.length * STRIDE);
  list.forEach((b, k) => writeState(b, state, k * STRIDE));
  // contacts the game reads (grenades settling on the floor)
  const contacts = [];
  for (const c of world.contacts) {
    if (!c.bi._contacts && !c.bj._contacts) continue;
    contacts.push(c.bi._pid, c.bj._pid, c.ni.x, c.ni.y, c.ni.z);
  }
  const out = {
    type: 'result', seq: m.seq, epoch: m.epoch, state, events, contacts,
    time: stepper.time, steps: n, rate: stepper.rate, rateHz: stepper.rateHz,
    loadMs: stepper.loadMs, load: stepper.load, stepCost: stepper.stepCost,
  };
  events = [];
  postMessage(out, [state.buffer]);
}

self.onmessage = (e) => {
  const m = e.data;
  try {
    if (m.type === 'init') {
      ({ world, materials } = createWorld());
      // with a core to itself the physics may take most of the frame before it counts as heavy
      stepper = new Stepper(world, { share: 0.9, heavy: 0.75, light: 0.35, maxDt: 0.25 });
      stepper.time = m.time;
      stepper.onWake = (p) => { events.push({ t: 'wake', id: p.id }); return false; };
      apply(m.cmds);
      postMessage({ type: 'ready' });
    } else if (m.type === 'step') step(m);
  } catch (err) {
    postMessage({ type: 'error', message: String(err && err.stack || err) });
  }
};
