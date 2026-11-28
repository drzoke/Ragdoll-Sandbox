import * as CANNON from 'cannon-es';
import { createWorld, Stepper, GROUP } from './physicsCore.js';
import { PhysicsLink } from './physicsLink.js';

export { GROUP };

/**
 * The game's physics. `world` is a cannon-es world the game uses directly (add bodies and joints,
 * read positions, push things).
 *
 * Two ways to run it:
 *  - here on the main thread: update() steps the world (fixed steps, see Stepper);
 *  - in a worker on another processor core (the default, see physicsLink.js): the world here is a
 *    copy the game reads and writes as before; update() copies in the worker's last result and
 *    flush() (called right before drawing) sends the game's changes and lets the worker step
 *    while this thread draws.
 *
 * Work that must happen before every step (ragdoll muscles, the grab beam) is given as programs:
 * objects with physicsProgram() returning plain data (see programs.js), so it runs wherever the
 * physics does. onStep() callbacks only run when the physics is on this thread.
 */
export class Physics {
  constructor() {
    const { world, materials } = createWorld();
    this.world = world;
    this.materials = materials;
    this.stepper = new Stepper(world);
    this.link = new PhysicsLink(this);
    this.providers = new Map();   // id -> object with physicsProgram() (and wake())
    this.nextProgram = 1;
    this.localDepth = 0;
    this.time = 0;
  }

  get stepCallbacks() { return this.stepper.stepCallbacks; }
  set stepCallbacks(v) { this.stepper.stepCallbacks = v; }
  get remote() { return this.link.on && this.localDepth === 0; }
  get rate() { return this.remote ? this.link.stats.rate : this.stepper.rate; }
  get rateHz() { return this.remote ? this.link.stats.rateHz : this.stepper.rateHz; }
  get loadMs() { return this.remote ? this.link.stats.loadMs : this.stepper.loadMs; }
  get load() { return this.remote ? this.link.stats.load : this.stepper.load; }
  get stepCost() { return this.remote ? this.link.stats.stepCost : this.stepper.stepCost; }

  onStep(fn) { this.stepCallbacks.push(fn); return () => { this.stepCallbacks = this.stepCallbacks.filter((f) => f !== fn); }; }

  /** Run obj.physicsProgram() each frame (before stepping); returns an unsubscribe function. */
  addProgram(obj) {
    const id = this.nextProgram++;
    this.providers.set(id, obj);
    obj._programId = id;
    return () => this.providers.delete(id);
  }

  programs() {
    const out = [];
    for (const [id, obj] of this.providers) {
      const p = obj.physicsProgram();
      if (p) { p.id = id; out.push(p); }
    }
    return out;
  }

  programWake(id) { const obj = this.providers.get(id); obj?.wake?.(); return !!obj; }

  /** Run the physics on another core (true) or on this thread (false). */
  setWorker(on) {
    if (on) return this.link.start();
    this.link.stop();
    return false;
  }

  get workerState() { return this.link.state; }

  onLinkStopped() { this.stepper.time = this.time; }

  addStaticBox(halfExtents, position, quaternion) {
    const body = new CANNON.Body({
      mass: 0, type: CANNON.Body.STATIC, material: this.materials.ground,
      collisionFilterGroup: GROUP.STATIC, collisionFilterMask: GROUP.RAGDOLL | GROUP.DEBRIS,
    });
    body.addShape(new CANNON.Box(new CANNON.Vec3(...halfExtents)));
    body.position.set(...position);
    if (quaternion) body.quaternion.set(quaternion.x, quaternion.y, quaternion.z, quaternion.w);
    this.world.addBody(body);
    return body;
  }

  addStaticPlane(normal, point) {
    const body = new CANNON.Body({
      mass: 0, type: CANNON.Body.STATIC, material: this.materials.ground,
      collisionFilterGroup: GROUP.STATIC, collisionFilterMask: GROUP.RAGDOLL | GROUP.DEBRIS,
    });
    body.addShape(new CANNON.Plane());
    // Plane's normal is +Z in local space; rotate it to the requested normal.
    const from = new CANNON.Vec3(0, 0, 1);
    const to = new CANNON.Vec3(...normal);
    body.quaternion.setFromVectors(from, to);
    body.position.set(...point);
    this.world.addBody(body);
    return body;
  }

  /**
   * Advance the simulation by a frame. In slow motion the step gets smaller instead of rarer, so
   * motion stays smooth at any time scale.
   */
  update(dt, timeScale = 1) {
    if (this.remote) { this.link.update(dt, timeScale); return; }
    const s = this.stepper;
    s.time = this.time;
    s.programs = this.programs();
    s.onWake = (p) => this.programWake(p.id);
    s.update(dt, timeScale);
    this.time = s.time;
  }

  /** End of the frame, right before drawing: in worker mode, send this frame's changes. */
  flush() {
    if (this.remote) this.link.flush(this.programs());
  }

  /**
   * Step on this thread for a while (the title screen settles its scene in one go), even in worker
   * mode; the worker gets the result with the next flush.
   */
  runLocal(fn) {
    if (this.link.on && this.link.inbox) { const m = this.link.inbox; this.link.inbox = null; this.link.applyResult(m); }
    this.localDepth++;
    try { fn(); } finally {
      this.localDepth--;
      if (this.link.recording) this.link.invalidate();
    }
  }

  /** Joint equations keep spook params tuned for one step size; re-tune when it changes. */
  syncConstraintStiffness(h) { this.stepper.syncConstraintStiffness(h); }
}
