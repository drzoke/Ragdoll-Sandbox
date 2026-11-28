// The physics world and its fixed-step driver, shared by the main thread and the physics worker
// (see physics.js and physicsWorker.js). Imports use relative paths: workers have no import map.
import * as CANNON from '../../lib/cannon-es.js';
import { CONFIG } from '../config.js';
import { MapBroadphase, PairSet } from './broadphase.js';
import { runProgram } from './programs.js';

export const GROUP = { STATIC: 1, RAGDOLL: 2, PLAYER: 4, DEBRIS: 8 };

/** The world with the game's broadphase, solver settings, materials and contact materials. */
export function createWorld() {
  const world = new CANNON.World({ gravity: new CANNON.Vec3(0, CONFIG.physics.gravity, 0) });
  // static bodies in a grid, moving bodies looked up by their boxes (see broadphase.js)
  world.broadphase = new MapBroadphase(world);
  world.collisionMatrix = new PairSet();
  world.collisionMatrixPrevious = new PairSet();
  world.allowSleep = false;
  world.solver.iterations = CONFIG.physics.solverIterations;
  world.solver.tolerance = 1e-4;

  const materials = {
    ground: new CANNON.Material('ground'),
    flesh: new CANNON.Material('flesh'),
    foot: new CANNON.Material('foot'),
    debris: new CANNON.Material('debris'),
    grenade: new CANNON.Material('grenade'),
  };
  const m = materials;
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
  return { world, materials };
}

// step sizes, finest first, with the solver iterations used at each (fewer under heavy load: the
// joints stretch a few millimetres more, which the joint balls hide)
const RATES = [CONFIG.physics.step, 1 / 90, 1 / 60];
const ITERATIONS = [CONFIG.physics.solverIterations, 8, 10];
const MIN_BUDGET = 12;      // ms of physics always allowed per frame

/**
 * Fixed-step driver with a load governor. Each update runs as many steps as real time needs, as
 * long as they fit in a share of the frame time; when the physics takes too much of real time it
 * steps at 90 and then 60 Hz instead of 120 Hz and goes back up when the load drops.
 *
 * On the main thread the physics shares the frame with drawing (share 0.7, heavy above 30% of
 * real time); in the worker it has a core to itself (share 0.9, heavy above 75%).
 */
export class Stepper {
  constructor(world, { share = 0.7, heavy = 0.3, light = 0.1, maxDt = 0.1 } = {}) {
    this.world = world;
    this.share = share; this.heavy = heavy; this.light = light;
    this.maxDt = maxDt;         // longest stretch of time one update catches up on
    this.accumulator = 0;
    this.time = 0;
    this.rate = 0;              // index into RATES
    this.rateHold = 0;
    this.stepCost = 0.5;        // ms per step, smoothed
    this.loadMs = 0;            // physics ms per update, smoothed
    this.load = 0;              // share of real time spent on physics, smoothed
    this.programs = [];         // per-step jobs for this update (ragdoll muscles, the grab beam)
    this.onWake = null;         // (program) => a sleeping ragdoll was pushed
    this.stepCallbacks = [];
  }

  get rateHz() { return 1 / RATES[this.rate]; }

  /** Advance by dt seconds of game time (times the slow-motion factor). Returns the steps run. */
  update(dt, timeScale = 1) {
    const h = RATES[this.rate] * Math.min(1, timeScale);
    this.syncConstraintStiffness(h);
    // (the worker can be handed two frames at once when a step took longer than a frame)
    const span = Math.min(dt, this.maxDt);
    this.accumulator += span * timeScale;
    // A slow frame from drawing gets the steps it needs, so the bodies keep real speed; only when
    // the physics itself can't keep up does the game fall behind real time (slow motion) instead
    // of each frame getting slower than the last.
    const budget = Math.max(MIN_BUDGET, this.share * dt * 1000);
    const fit = Math.max(1, Math.floor(budget / Math.max(0.05, this.stepCost)));
    const max = Math.min(Math.ceil(CONFIG.physics.maxSubSteps * Math.max(1, timeScale) * Math.max(1, span / 0.1)), fit);
    let n = 0;
    const t0 = performance.now();
    while (this.accumulator >= h && n < max) {
      for (const fn of this.stepCallbacks) fn(h);
      for (const p of this.programs) runProgram(p, h, this.onWake);
      this.world.step(h);
      this.accumulator -= h;
      this.time += h;
      n++;
    }
    if (n === max) this.accumulator = Math.min(this.accumulator, h);
    const ms = performance.now() - t0;
    if (n) this.stepCost += (ms / n - this.stepCost) * 0.1;
    this.govern(ms, dt);
    return n;
  }

  govern(ms, dt) {
    if (!(dt > 0)) return;
    const k = Math.min(1, dt * 2);                       // smoothed over ~0.5 s
    this.loadMs += (ms - this.loadMs) * k;
    this.load += (Math.min(2, ms / (dt * 1000)) - this.load) * k;
    this.rateHold -= dt;
    if (this.rateHold > 0) return;
    const was = this.rate;
    if (this.load > this.heavy && this.rate < RATES.length - 1) { this.rate++; this.rateHold = 3; }
    else if (this.load < this.light && this.rate > 0) { this.rate--; this.rateHold = 6; }
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
