import * as CANNON from 'cannon-es';
import { CONFIG } from '../config.js';
import { MapBroadphase, PairSet } from './broadphase.js';

export const GROUP = { STATIC: 1, RAGDOLL: 2, PLAYER: 4, DEBRIS: 8 };

// step sizes, finest first, with the solver iterations used at each (fewer under heavy load: the
// joints stretch a few millimetres more, which the joint balls hide)
const RATES = [CONFIG.physics.step, 1 / 90, 1 / 60];
const ITERATIONS = [CONFIG.physics.solverIterations, 14, 10];
const FRAME_BUDGET = 12;    // ms of physics allowed per frame
const HEAVY = 6;            // ms of physics per frame that counts as heavy

// Wraps the cannon-es world with a fixed-step accumulator. Systems that need to run
// in lock-step with the solver (ragdoll muscles) register with onStep().
export class Physics {
  constructor() {
    const world = new CANNON.World({ gravity: new CANNON.Vec3(0, CONFIG.physics.gravity, 0) });
    // static bodies in a grid, moving bodies looked up by their boxes (see broadphase.js)
    world.broadphase = new MapBroadphase(world);
    world.collisionMatrix = new PairSet();
    world.collisionMatrixPrevious = new PairSet();
    world.allowSleep = false;
    world.solver.iterations = CONFIG.physics.solverIterations;
    world.solver.tolerance = 1e-4;
    this.world = world;

    this.materials = {
      ground: new CANNON.Material('ground'),
      flesh: new CANNON.Material('flesh'),
      foot: new CANNON.Material('foot'),
      debris: new CANNON.Material('debris'),
      grenade: new CANNON.Material('grenade'),
    };
    const m = this.materials;
    world.addContactMaterial(new CANNON.ContactMaterial(m.ground, m.flesh, { friction: 0.42, restitution: 0.02 }));
    world.addContactMaterial(new CANNON.ContactMaterial(m.flesh, m.flesh, { friction: 0.4, restitution: 0.0 }));
    // Feet slide a little: the ragdoll's walk is driven from the hips, not by planted IK feet.
    world.addContactMaterial(new CANNON.ContactMaterial(m.ground, m.foot, { friction: 0.12, restitution: 0.0 }));
    world.addContactMaterial(new CANNON.ContactMaterial(m.ground, m.debris, { friction: 0.7, restitution: 0.15 }));
    // grenades: grippy, a small bounce (rolling is damped separately in Explosives)
    world.addContactMaterial(new CANNON.ContactMaterial(m.ground, m.grenade, { friction: 0.9, restitution: 0.1 }));
    world.defaultContactMaterial.friction = 0.5;
    world.defaultContactMaterial.restitution = 0.05;
    // Softer contacts reduce ragdoll jitter.
    world.defaultContactMaterial.contactEquationStiffness = 5e6;
    world.defaultContactMaterial.contactEquationRelaxation = 4;

    this.stepCallbacks = [];
    this.accumulator = 0;
    this.time = 0;
    this.rate = 0;              // index into RATES (see govern())
    this.rateHold = 0;
    this.stepCost = 0.5;        // ms per step, smoothed
    this.loadMs = 0;
  }

  get rateHz() { return 1 / RATES[this.rate]; }

  onStep(fn) { this.stepCallbacks.push(fn); return () => { this.stepCallbacks = this.stepCallbacks.filter((f) => f !== fn); }; }

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
   * Advance the simulation. In slow motion the step gets smaller instead of rarer, so motion
   * stays smooth at any time scale (cost per rendered frame stays about the same).
   */
  update(dt, timeScale = 1) {
    const base = RATES[this.rate];
    const h = base * Math.min(1, timeScale);
    this.syncConstraintStiffness(h);
    this.accumulator += Math.min(dt, 0.1) * timeScale;
    // Steps this frame: as many as the time needs, but never more than fit in the frame budget.
    // A slow frame used to run up to 6 steps, which made the next frame slower still; now a heavy
    // scene runs a little behind real time for a moment instead of the frame rate collapsing.
    const fit = Math.max(1, Math.floor(FRAME_BUDGET / Math.max(0.05, this.stepCost)));
    const max = Math.min(Math.ceil(CONFIG.physics.maxSubSteps * Math.max(1, timeScale)), fit);
    let n = 0;
    const t0 = performance.now();
    while (this.accumulator >= h && n < max) {
      for (const fn of this.stepCallbacks) fn(h);
      this.world.step(h);
      this.accumulator -= h;
      this.time += h;
      n++;
    }
    if (n === max) this.accumulator = Math.min(this.accumulator, h);
    const ms = performance.now() - t0;
    if (n) this.stepCost += (ms / n - this.stepCost) * 0.1;
    this.govern(ms, dt);
  }

  /**
   * Load governor: when the physics takes too much of each frame (lots of ragdolls moving), step
   * at 90 and then 60 Hz instead of 120 Hz (half the work, slightly softer joints); go back up when
   * the load drops. Each level is held for a few seconds so it doesn't flicker between them.
   */
  govern(ms, dt) {
    if (!(dt > 0)) return;
    this.loadMs += (ms - this.loadMs) * Math.min(1, dt * 2);   // physics ms per frame, smoothed over ~0.5 s
    this.rateHold -= dt;
    if (this.rateHold > 0) return;
    const was = this.rate;
    if (this.loadMs > HEAVY && this.rate < RATES.length - 1) { this.rate++; this.rateHold = 3; }
    else if (this.loadMs < HEAVY * 0.35 && this.rate > 0) { this.rate--; this.rateHold = 6; }
    if (this.rate !== was) this.world.solver.iterations = ITERATIONS[this.rate];
  }

  /** Joint equations keep spook params tuned for one step size; re-tune when it changes. */
  syncConstraintStiffness(h) {
    const count = this.world.constraints.length;
    if (h === this._lastH && count === this._lastCount) return;
    this._lastH = h; this._lastCount = count;
    for (const c of this.world.constraints) for (const eq of c.equations) eq.setSpookParams(1e7, 4, h * 2);
  }
}
