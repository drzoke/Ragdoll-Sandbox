import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { GROUP } from '../core/physics.js';
import { clamp, damp, rand } from '../core/util.js';
import { VEHICLE_KINDS, buildVehicle } from './models.js';
import { trackMaterials } from '../materials.js';

// Vehicles you spawn from the spawn menu (B, Vehicles) and drive: look at one and press E to get
// in, WASD to drive, Space for the handbrake, C to switch between the chase view and the driver's
// seat, left click for the horn and E to get out.
//
// They drive like arcade cars, worked out here rather than in the physics engine: the wheels
// follow the floor (up kerbs and steps, airborne off edges), the body tilts with the ground, walls
// stop them, and a slide builds up when you turn hard or pull the handbrake. In the physics world
// each one is a moving solid that shoves ragdolls and gibs, and hitting someone at speed hurts them
// like a fall would (broken bones, a knocked head) and throws them.
//
// Multiplayer: whoever drives works out the car's movement and sends it; the host's game does the
// damage. The snapshot carries every vehicle (see net.js).

const G = 22;                     // gravity for the car (a bit heavier than real: it feels planted)
const STEP_UP = 0.55;             // how high a step the wheels can climb (m)
const _v = new THREE.Vector3(), _w = new THREE.Vector3(), _d = new THREE.Vector3(), _e = new THREE.Euler(0, 0, 0, 'YXZ');
const _q = new THREE.Quaternion(), _ray = new THREE.Raycaster();

export class Vehicles {
  constructor({ scene, physics, map, player, camera, audio, hud, ragdolls, gore, vitals }) {
    Object.assign(this, { scene, physics, map, player, camera, audio, hud, ragdolls, gore, vitals });
    this.list = [];
    this.nextId = 1;
    this.driving = null;          // the vehicle you're in
    this.view = 'chase';          // chase | seat
    this.myId = () => 1;          // set by the game (multiplayer player id)
    this.remote = null;           // multiplayer, as a friend: { enter(v), exit(v, state), horn(v) }
    this.isHost = () => true;     // this game does the damage (alone or hosting)
    this.meshCache = null;
    this.hitCd = new WeakMap();
    this.playerHitCd = 0;
    this.el = document.getElementById('drive');
  }

  get mine() { return this.driving; }

  // ------------------------------------------------------------------ spawning
  spawn(kind, pos, yaw = 0, { id = null, color = null } = {}) {
    const k = VEHICLE_KINDS[kind];
    if (!k) return null;
    const paintColor = color ?? k.paints[(Math.random() * k.paints.length) | 0];
    const model = buildVehicle(kind, paintColor);
    this.scene.add(model.root);
    trackMaterials(model.root);
    const body = new CANNON.Body({ mass: 0, type: CANNON.Body.KINEMATIC, collisionFilterGroup: GROUP.PLAYER, collisionFilterMask: GROUP.RAGDOLL | GROUP.DEBRIS });
    for (const [hx, hy, hz, x, y, z] of k.boxes) body.addShape(new CANNON.Box(new CANNON.Vec3(hx, hy, hz)), new CANNON.Vec3(x, y, z));
    this.physics.world.addBody(body);
    const v = {
      id: id ?? this.nextId++, kind, k, color: paintColor, model, body,
      pos: new THREE.Vector3(pos.x ?? pos[0], pos.y ?? pos[1], pos.z ?? pos[2]), yaw,
      pitch: 0, roll: 0, vel: new THREE.Vector3(), vy: 0, speed: 0, steer: 0, yawRate: 0, spin: 0,
      throttle: 0, brake: 0, handbrake: false, air: false, driver: 0, lastCrash: 0,
      hitMeshes: [],
    };
    if (id !== null) this.nextId = Math.max(this.nextId, id + 1);
    v.pos.y = this.groundUnder(v, v.pos.y + 1).h;
    model.root.traverse((o) => { if (o.isMesh) { o.userData.vehicle = v; o.userData.surface = 'metal'; v.hitMeshes.push(o); } });
    // look at it and press E to get in
    v.use = {
      meshes: v.hitMeshes,
      prompt: () => (v.driver ? '' : `Drive the ${k.name.toLowerCase()}`),
      press: () => this.tryEnter(v),
    };
    this.map.interactables.push(v.use);
    this.list.push(v);
    this.meshCache = null;
    this.place(v);
    this.onSpawn?.(v);
    return v;
  }

  remove(v) {
    if (!this.list.includes(v)) return;
    if (this.driving === v) this.exit(true);
    this.onRemove?.(v);
    this.scene.remove(v.model.root);
    this.physics.world.removeBody(v.body);
    const i = this.map.interactables.indexOf(v.use);
    if (i >= 0) this.map.interactables.splice(i, 1);
    this.list = this.list.filter((x) => x !== v);
    this.meshCache = null;
  }

  clear() { for (const v of [...this.list]) this.remove(v); }

  /** Put the vehicles' interactables back after the map's list was emptied (map load). */
  relink() { for (const v of this.list) if (!this.map.interactables.includes(v.use)) this.map.interactables.push(v.use); }

  meshes() {
    if (!this.meshCache) this.meshCache = this.list.flatMap((v) => v.hitMeshes);
    return this.meshCache;
  }

  byId(id) { return this.list.find((v) => v.id === id) || null; }

  // ------------------------------------------------------------------ getting in and out
  tryEnter(v) {
    if (v.driver || this.driving) return;
    if (this.remote) { this.remote.enter(v); return; }
    this.enter(v);
  }

  /** You're the driver now. */
  enter(v) {
    if (this.driving) return;
    this.driving = v;
    v.driver = this.myId();
    const p = this.player;
    // look the way the car points, a little down at it
    p.yaw = p.targetYaw = v.yaw + Math.PI;
    p.pitch = p.targetPitch = -0.18;
    p.vel.set(0, 0, 0);
    p.play(() => this.driving !== v);       // walking and gravity are off until you get out
    p.body.position.set(0, -60, 0);
    this.audio.play('door');
    this.el?.classList.remove('hidden');
    document.body.classList.add('driving');
    this.hud.toast(`${v.k.name}: W/S to drive, Space handbrake, C camera, E to get out`);
    this.onEnter?.(v);
  }

  /** Out of the driver's door (or the other side, or onto the roof if both are blocked). */
  exit(silent = false) {
    const v = this.driving;
    if (!v) return;
    this.driving = null;
    v.driver = 0;
    const p = this.player, k = v.k;
    const right = _v.set(-Math.cos(v.yaw), 0, Math.sin(v.yaw));    // the car's right (-X)
    let spot = null;
    for (const side of [-1, 1]) {                                   // the driver's side (+X) first
      const c = v.pos.clone().addScaledVector(right, side * (k.width / 2 + 0.55));
      c.y = this.map.groundAt(c.x, c.z, v.pos.y + 1.2);
      if (this.freeSpot(c)) { spot = c; break; }
    }
    if (!spot) { spot = v.pos.clone(); spot.y = v.pos.y + k.height + 0.05; }
    p.pos.copy(spot);
    p.vel.set(v.vel.x * 0.4, 0, v.vel.z * 0.4);
    p.yaw = p.targetYaw = p.yaw;            // keep looking the same way
    p.pitch = p.targetPitch = clamp(p.pitch, -0.5, 0.5);
    p.fallStart = p.pos.y;
    this.el?.classList.add('hidden');
    document.body.classList.remove('driving');
    if (!silent) this.audio.play('door');
    this.audio.engine?.(0, 1);
    this.remote?.exit(v, this.state(v));
    this.onExit?.(v);
  }

  freeSpot(c) {
    const r = 0.36, b = this.map.bounds;
    if (c.x < b.minX + r || c.x > b.maxX - r || c.z < b.minZ + r || c.z > b.maxZ - r) return false;
    for (const col of this.map.near(c.x - r, c.y + 0.05, c.z - r, c.x + r, c.y + 1.8, c.z + r)) {
      if (col.off) continue;
      if (c.x + r > col.min.x && c.x - r < col.max.x && c.z + r > col.min.z && c.z - r < col.max.z && c.y + 1.8 > col.min.y && c.y + 0.05 < col.max.y) return false;
    }
    for (const o of this.list) if (this.inside(o, c, 0.3, 1.7)) return false;
    return true;
  }

  // ------------------------------------------------------------------ the frame
  /**
   * Before the physics: drive the one you're in, let the empty ones roll to a stop (where this
   * game runs them), and put every model and physics body in place.
   */
  update(dt, input, active) {
    if (!this.list.length) { this.audio.engine?.(0, 1); return; }
    const me = this.myId();
    for (const v of this.list) {
      if (v === this.driving) this.drive(v, dt, input, active);
      else if (this.simulates(v)) { v.throttle = 0; v.handbrake = false; v.steer *= 1 - damp(4, dt); this.step(v, dt); }
      this.place(v);
    }
    if (this.isHost()) this.hitRagdolls(dt);
    this.hitMe(dt, me);
    this.separate();
    this.sound(dt);
  }

  /** Is this game the one moving it? (A friend's car comes from the network.) */
  simulates(v) { return v === this.driving || (!v.driver && !v.netFollow); }

  drive(v, dt, input, active) {
    const on = active;
    const fwd = on && (input.isDown('KeyW') || input.isDown('ArrowUp')) ? 1 : 0;
    const back = on && (input.isDown('KeyS') || input.isDown('ArrowDown')) ? 1 : 0;
    const left = on && (input.isDown('KeyA') || input.isDown('ArrowLeft')) ? 1 : 0;
    const right = on && (input.isDown('KeyD') || input.isDown('ArrowRight')) ? 1 : 0;
    // touch: the move stick
    const ax = input.axis?.x || 0, ay = input.axis?.y || 0;
    v.throttle = clamp(fwd - back - ay, -1, 1);
    const want = clamp(left - right - ax, -1, 1);
    v.steer += (want - v.steer) * damp(want ? 6 : 8, dt);
    v.handbrake = on && input.isDown('Space');
    if (on && input.wasPressed('KeyC')) { this.view = this.view === 'chase' ? 'seat' : 'chase'; this.audio.play('click'); }
    if (on && input.mousePressed?.[0]) this.horn(v);
    if (on && input.wasPressed('KeyE')) { this.exit(); return; }
    const yaw0 = v.yaw;
    this.step(v, dt);
    // the view turns with the car
    const dy = v.yaw - yaw0;
    this.player.yaw += dy; this.player.targetYaw += dy;
    // you sit in the driver's seat (zombies and friends see you there)
    this.seatWorld(v, this.player.pos);
    this.player.pos.y -= 0.45;
    this.player.crouch = 1;
  }

  horn(v) {
    const now = performance.now();
    if (now - (v.hornT || 0) < 350) return;
    v.hornT = now;
    this.audio.play('horn');
    this.ragdolls.alert(v.pos, 25, 0.25, 'shot');
    this.onHorn?.(v);
  }

  /** One frame of driving. */
  step(v, dt) {
    const n = Math.max(1, Math.ceil(dt / (1 / 90)));
    const h = dt / n;
    for (let i = 0; i < n; i++) this.substep(v, h);
  }

  substep(v, dt) {
    const k = v.k;
    const fwd = _v.set(Math.sin(v.yaw), 0, Math.cos(v.yaw));
    const right = _w.set(-Math.cos(v.yaw), 0, Math.sin(v.yaw));
    let vf = v.vel.dot(fwd), vl = v.vel.dot(right);
    const grounded = !v.air;
    if (grounded) {
      // engine and brakes
      const t = v.throttle;
      if (t > 0) vf += (vf < -0.3 ? k.brake : k.accel * (1 - 0.55 * clamp(vf / k.maxSpeed))) * t * dt;
      else if (t < 0) vf += (vf > 0.3 ? -k.brake : -k.accel * 0.7 * (vf < -k.reverse ? 0 : 1)) * -t * dt;
      // rolling resistance and air drag
      const roll = (t === 0 ? 2.2 : 0.4) + k.drag * Math.abs(vf) * 0.08;
      vf -= Math.sign(vf) * Math.min(Math.abs(vf), roll * dt);
      if (v.handbrake) vf -= Math.sign(vf) * Math.min(Math.abs(vf), 7 * dt);
      vf = clamp(vf, -k.reverse, k.maxSpeed);
      // steering (a bicycle model: less lock at speed)
      const lock = k.steer * (1 - 0.62 * clamp(Math.abs(vf) / k.maxSpeed));
      const ang = v.steer * lock;
      const targetRate = vf * Math.tan(ang) / k.wheelbase;
      // the rear steps out under the handbrake
      const turnK = v.handbrake ? 5 : 10;
      v.yawRate += (targetRate * (v.handbrake ? 1.35 : 1) - v.yawRate) * Math.min(1, turnK * dt);
      // tyres bite: sideways speed dies away (slowly with the handbrake on = a slide)
      const grip = v.handbrake ? 1.4 : k.grip * (Math.abs(vl) > 6 ? 0.6 : 1);
      vl *= Math.exp(-grip * dt);
    } else {
      v.yawRate *= Math.exp(-0.5 * dt);
    }
    v.yaw += v.yawRate * dt;
    // velocity in the world from the car's new heading
    const f2 = _d.set(Math.sin(v.yaw), 0, Math.cos(v.yaw));
    const r2x = -Math.cos(v.yaw), r2z = Math.sin(v.yaw);
    v.vel.set(f2.x * vf + r2x * vl, 0, f2.z * vf + r2z * vl);
    v.speed = vf;
    v.pos.x += v.vel.x * dt; v.pos.z += v.vel.z * dt;
    this.collideWorld(v);
    // the floor under the wheels
    const g = this.groundUnder(v, v.pos.y + STEP_UP);
    if (v.pos.y > g.h + 0.04 || v.vy > 0.5) {
      v.air = true;
      v.vy -= G * dt;
      v.pos.y += v.vy * dt;
      if (v.pos.y <= g.h) {
        if (v.vy < -6) this.crash(v, -v.vy * 0.6, 'land');
        v.pos.y = g.h; v.vy = 0; v.air = false;
      }
    } else {
      // up a step: a small hop over it
      const rise = g.h - v.pos.y;
      v.pos.y += rise * Math.min(1, dt * 30);
      v.vy = 0; v.air = false;
    }
    // tilt with the ground (smoothed: the springs)
    const kt = Math.min(1, dt * (v.air ? 1.5 : 10));
    v.pitch += (g.pitch - v.pitch) * kt;
    v.roll += (g.roll - v.roll) * kt;
    // body roll and squat from cornering and braking
    v.leanRoll = (v.leanRoll || 0) + (clamp(-v.yawRate * vf * 0.012, -0.08, 0.08) - (v.leanRoll || 0)) * Math.min(1, dt * 6);
    v.spin += (vf / k.wheelR) * dt;
  }

  /** Heights under the four wheels: the car's height, pitch and roll. */
  groundUnder(v, yMax) {
    const k = v.k, c = Math.cos(v.yaw), s = Math.sin(v.yaw);
    const at = (lx, lz) => this.map.groundAt(v.pos.x + lx * c + lz * s, v.pos.z - lx * s + lz * c, yMax);
    const hw = k.track / 2, hl = k.wheelbase / 2;
    const fl = at(hw, hl), fr = at(-hw, hl), rl = at(hw, -hl), rr = at(-hw, -hl);
    const front = (fl + fr) / 2, rear = (rl + rr) / 2, left = (fl + rl) / 2, rightH = (fr + rr) / 2;
    return {
      h: (front + rear) / 2,
      pitch: -Math.atan2(front - rear, k.wheelbase),
      roll: Math.atan2(left - rightH, k.track),
    };
  }

  /** Walls, props and the edge of the map stop the car (the body is three circles along its length). */
  collideWorld(v) {
    const k = v.k, r = k.width / 2, fx = Math.sin(v.yaw), fz = Math.cos(v.yaw);
    const reach = k.length / 2 - r;
    const top = v.pos.y + k.height, low = v.pos.y + STEP_UP;
    let hit = 0;
    for (const off of [reach, 0, -reach]) {
      for (let iter = 0; iter < 2; iter++) {
        const cx = v.pos.x + fx * off, cz = v.pos.z + fz * off;
        for (const col of this.map.near(cx - r, low, cz - r, cx + r, top, cz + r)) {
          if (col.off || col.max.y <= low || col.min.y >= top) continue;
          const px = clamp(cx, col.min.x, col.max.x), pz = clamp(cz, col.min.z, col.max.z);
          let dx = cx - px, dz = cz - pz;
          let d = Math.hypot(dx, dz);
          if (d >= r) continue;
          if (d < 1e-4) {
            // the centre is inside the box: out the nearest side
            const ex = [cx - col.min.x, col.max.x - cx, cz - col.min.z, col.max.z - cz];
            const m = Math.min(...ex), i = ex.indexOf(m);
            dx = i === 0 ? -1 : i === 1 ? 1 : 0; dz = i === 2 ? -1 : i === 3 ? 1 : 0; d = 0;
            const push = m + r;
            v.pos.x += dx * push; v.pos.z += dz * push;
          } else {
            dx /= d; dz /= d;
            v.pos.x += dx * (r - d); v.pos.z += dz * (r - d);
          }
          const vn = v.vel.x * dx + v.vel.z * dz;
          if (vn < 0) {
            v.vel.x -= dx * vn * 1.25; v.vel.z -= dz * vn * 1.25;
            hit = Math.max(hit, -vn);
          }
        }
      }
    }
    const b = this.map.bounds, m = k.length / 2;
    for (const [axis, lo, hi] of [['x', b.minX + m * 0.6, b.maxX - m * 0.6], ['z', b.minZ + m * 0.6, b.maxZ - m * 0.6]]) {
      if (v.pos[axis] < lo) { v.pos[axis] = lo; if (v.vel[axis] < 0) { hit = Math.max(hit, -v.vel[axis]); v.vel[axis] *= -0.25; } }
      if (v.pos[axis] > hi) { v.pos[axis] = hi; if (v.vel[axis] > 0) { hit = Math.max(hit, v.vel[axis]); v.vel[axis] *= -0.25; } }
    }
    if (hit > 0) {
      // what's left of the speed along the car
      v.speed = v.vel.x * fx + v.vel.z * fz;
      if (hit > 3.5) this.crash(v, hit, 'wall');
    }
  }

  crash(v, speed, kind) {
    const now = performance.now();
    if (now - v.lastCrash < 250) return;
    v.lastCrash = now;
    const d = this.camera.position.distanceTo(v.pos);
    this.audio.play(kind === 'land' ? 'thud' : 'crash', clamp(speed / 14 * (1.2 - d / 40), 0.1, 1));
    if (v === this.driving) {
      this.player.addShake?.(clamp(speed / 12, 0.1, 1.2));
      // a hard crash hurts whoever is driving
      if (speed > 13) this.vitals?.hurt((speed - 13) * 5, { kind: 'crash' });
    }
  }

  /** Model and physics body where the car is. */
  place(v) {
    const root = v.model.root;
    root.position.copy(v.pos);
    _e.set(v.pitch, v.yaw, v.roll + (v.leanRoll || 0), 'YXZ');
    root.quaternion.setFromEuler(_e);
    for (const w of v.model.wheels) {
      w.wheel.rotation.x = v.spin;
      if (w.front) w.pivot.rotation.y = v.steer * v.k.steer * 0.8;
    }
    const b = v.body;
    b.position.set(v.pos.x, v.pos.y, v.pos.z);
    b.quaternion.set(root.quaternion.x, root.quaternion.y, root.quaternion.z, root.quaternion.w);
    b.velocity.set(v.vel.x, v.vy, v.vel.z);
    b.angularVelocity.set(0, v.yawRate, 0);
  }

  /** The driver's seat (or eye) in the world. */
  seatWorld(v, out, eye = false) {
    const [x, y, z] = v.k.seat;
    out.set(x, eye ? v.k.eye : y, z).applyQuaternion(v.model.root.quaternion).add(v.pos);
    return out;
  }

  // ------------------------------------------------------------------ the camera while driving
  /** After the player update: the chase camera behind the car, or the driver's eyes. */
  updateCamera(dt) {
    const v = this.driving;
    if (!v) return;
    const p = this.player, cam = this.camera, k = v.k;
    p.targetPitch = clamp(p.targetPitch, this.view === 'chase' ? -0.9 : -1.2, this.view === 'chase' ? 0.55 : 1.0);
    p.pitch = clamp(p.pitch, -1.2, 1.0);
    const look = _d.set(-Math.sin(p.yaw) * Math.cos(p.pitch), Math.sin(p.pitch), -Math.cos(p.yaw) * Math.cos(p.pitch));
    if (this.view === 'seat') {
      this.seatWorld(v, cam.position, true);
    } else {
      const target = _v.copy(v.pos).add(_w.set(0, k.camHeight, 0));
      let dist = k.camDist + clamp(Math.abs(v.speed) / k.maxSpeed, 0, 1) * 1.2;
      // walls between the car and the camera pull it in
      _ray.set(target, look.clone().negate()); _ray.far = dist + 0.3;
      const hit = _ray.intersectObjects(this.map.solidMeshes, false)[0];
      if (hit) dist = Math.max(1.2, hit.distance - 0.3);
      cam.position.copy(target).addScaledVector(look, -dist);
      cam.position.y = Math.max(cam.position.y, this.map.groundAt(cam.position.x, cam.position.z, cam.position.y + 0.5) + 0.35);
    }
    cam.rotation.set(p.pitch, p.yaw, 0, 'YXZ');
    const fov = 75 + clamp(Math.abs(v.speed) / k.maxSpeed, 0, 1) * 9;
    if (Math.abs(cam.fov - fov) > 0.05) { cam.fov += (fov - cam.fov) * damp(4, dt); cam.updateProjectionMatrix(); }
    // speed and the keys
    if (this.el) {
      const kmh = Math.round(Math.abs(v.speed) * 3.6);
      const t = `<b>${kmh}</b><small>km/h</small><span>${v.k.name}</span>`;
      if (this.el._t !== t) { this.el._t = t; this.el.innerHTML = t; }
    }
  }

  // ------------------------------------------------------------------ hitting things
  /** Is point p inside vehicle v's box (grown by pad, from the floor up to height h above p)? */
  inside(v, p, pad = 0, h = 0) {
    const k = v.k, dx = p.x - v.pos.x, dz = p.z - v.pos.z;
    const c = Math.cos(v.yaw), s = Math.sin(v.yaw);
    const lz = dx * s + dz * c, lx = dx * c - dz * s;
    if (Math.abs(lx) > k.width / 2 + pad || Math.abs(lz) > k.length / 2 + pad) return false;
    return p.y + h > v.pos.y - 0.1 && p.y < v.pos.y + k.height + pad;
  }

  /** Host (or alone): ragdolls in the way of a moving car get hit. */
  hitRagdolls() {
    const now = performance.now();
    for (const v of this.list) {
      const sp = Math.hypot(v.vel.x, v.vel.z);
      if (sp < 3.5) continue;
      const reach = v.k.length / 2 + 1.5;
      for (const r of this.ragdolls.list) {
        if (r.hidden || r.removed) continue;
        const pb = r.parts.pelvis.body.position;
        if (Math.abs(pb.x - v.pos.x) > reach || Math.abs(pb.z - v.pos.z) > reach) continue;
        if (now - (this.hitCd.get(r) || 0) < 600) continue;
        const hits = [];
        let rel = 0;
        for (const [name, part] of Object.entries(r.parts)) {
          if (part.removed) continue;
          const b = part.body.position;
          _v.set(b.x, b.y, b.z);
          if (!this.inside(v, _v, 0.22)) continue;
          // only what the car is driving into (not someone standing on the bonnet)
          _w.set(b.x - v.pos.x, 0, b.z - v.pos.z);
          if (_w.dot(v.vel) <= 0 && _w.lengthSq() > 0.3) continue;
          const bv = part.body.velocity;
          rel = Math.max(rel, Math.hypot(v.vel.x - bv.x, v.vel.z - bv.z));
          hits.push(name);
        }
        if (!hits.length || rel < 3.5) continue;
        this.hitCd.set(r, now);
        this.runOver(v, r, hits, rel);
      }
    }
  }

  runOver(v, r, hits, speed) {
    r.wake?.();
    const h = r.health;
    let cracked = false;
    const s = speed * 0.9 + 1.5;
    for (const name of hits) {
      const res = h.impact(name, s);
      if (res.fractured) cracked = true;
      const b = r.parts[name].body.position;
      if (speed > 7) this.gore.impactBlood(new THREE.Vector3(b.x, b.y, b.z), speed * 0.7);
      if (speed > 6) this.gore.addBruise(r, name, new THREE.Vector3(b.x, b.y, b.z), clamp((speed - 5) / 12, 0.2, 1));
    }
    h.log(`Hit by a ${v.k.name.toLowerCase()} at ${Math.round(speed * 3.6)} km/h`);
    // thrown along with the car, up and to the side
    const dirx = v.vel.x / Math.max(0.1, Math.hypot(v.vel.x, v.vel.z)), dirz = v.vel.z / Math.max(0.1, Math.hypot(v.vel.x, v.vel.z));
    for (const part of Object.values(r.parts)) {
      if (part.removed) continue;
      const b = part.body;
      const side = (b.position.x - v.pos.x) * -dirz + (b.position.z - v.pos.z) * dirx;
      b.velocity.x = v.vel.x * 1.08 + -dirz * Math.sign(side) * speed * 0.12 + rand(-0.6, 0.6);
      b.velocity.z = v.vel.z * 1.08 + dirx * Math.sign(side) * speed * 0.12 + rand(-0.6, 0.6);
      b.velocity.y = Math.max(b.velocity.y, 1.2 + speed * 0.22 + rand(0, 1));
      b.angularVelocity.x += rand(-1, 1) * speed * 0.6; b.angularVelocity.z += rand(-1, 1) * speed * 0.6;
      b.wakeUp?.();
    }
    if (r.brain?.state === 'stand' || r.brain?.state === 'walk') r.brain.fall?.();
    else r.brain?.fall?.();
    this.audio.play(speed > 9 ? 'punchHard' : 'punch');
    if (cracked) this.audio.play('bone');
    this.ragdolls.alert(v.pos, 14, 0.5, 'scream', r);
    // the car loses some speed
    v.vel.multiplyScalar(speed > 12 ? 0.9 : 0.82);
    this.onRunOver?.(v, r, speed);
  }

  /** A car driven by someone else hits you. */
  hitMe(dt, me) {
    this.playerHitCd -= dt;
    if (this.driving || this.playerHitCd > 0 || this.vitals?.dead) return;
    const p = this.player;
    for (const v of this.list) {
      if (v.driver === me) continue;
      const sp = Math.hypot(v.vel.x, v.vel.z);
      if (sp < 4 || !this.inside(v, p.pos, 0.35, 1.7)) continue;
      _w.set(p.pos.x - v.pos.x, 0, p.pos.z - v.pos.z);
      if (_w.dot(v.vel) <= 0) continue;
      const rel = Math.hypot(v.vel.x - p.vel.x, v.vel.z - p.vel.z);
      if (rel < 4) continue;
      this.playerHitCd = 0.8;
      p.vel.x = v.vel.x * 1.15; p.vel.z = v.vel.z * 1.15; p.vel.y = 3 + rel * 0.18;
      p.onGround = false;
      p.addShake?.(0.8);
      this.vitals?.hurt(Math.min(95, (rel - 3) * 6), { kind: 'car' });
      this.audio.play('punchHard');
      break;
    }
  }

  /**
   * Walking into a car: you're pushed out of its box, or stand on its roof or in the bed. Called
   * right after the player moved. Returns true if it moved you.
   */
  collidePlayer() {
    if (this.driving || !this.list.length) return false;
    const p = this.player, R = 0.32;
    let moved = false;
    for (const v of this.list) {
      const k = v.k, dx = p.pos.x - v.pos.x, dz = p.pos.z - v.pos.z;
      if (Math.abs(dx) > k.length && Math.abs(dz) > k.length) continue;
      const c = Math.cos(v.yaw), s = Math.sin(v.yaw);
      const lz = dx * s + dz * c, lx = dx * c - dz * s;
      const hx = k.width / 2 + R, hz = k.length / 2 + R;
      if (Math.abs(lx) >= hx || Math.abs(lz) >= hz) continue;
      const top = v.pos.y + this.topAt(v, lz);
      if (p.pos.y >= top - 0.35 && p.vel.y <= 0.5) {
        // on top
        if (p.pos.y < top) { p.pos.y = top; p.vel.y = 0; p.onGround = true; p.fallStart = p.pos.y; moved = true; }
        continue;
      }
      if (p.pos.y + 1.7 < v.pos.y) continue;
      // out along the shortest way
      const ox = hx - Math.abs(lx), oz = hz - Math.abs(lz);
      let nlx = 0, nlz = 0;
      if (ox < oz) nlx = Math.sign(lx) * ox; else nlz = Math.sign(lz) * oz;
      // back to the world
      const wx = nlx * c + nlz * s, wz = -nlx * s + nlz * c;
      p.pos.x += wx; p.pos.z += wz;
      const len = Math.hypot(wx, wz) || 1, nx = wx / len, nz = wz / len;
      const vn = p.vel.x * nx + p.vel.z * nz;
      if (vn < 0) { p.vel.x -= nx * vn; p.vel.z -= nz * vn; }
      moved = true;
    }
    return moved;
  }

  /** Height of the car's top at lz along it (the cab, the bed, the bonnet), from its floor. */
  topAt(v, lz) {
    if (v.kind === 'truck') return lz > 1.45 ? 1.36 : lz > -0.48 ? 1.95 : 1.3;
    return lz > 1.0 ? 0.9 : lz > -0.7 ? 1.62 : 1.1;
  }

  /** Cars push each other apart (the one this game moves gets pushed). */
  separate() {
    const L = this.list;
    for (let i = 0; i < L.length; i++) {
      for (let j = i + 1; j < L.length; j++) {
        const a = L[i], b = L[j];
        if (Math.abs(a.pos.y - b.pos.y) > 1.5) continue;
        for (const oa of [-1, 0, 1]) for (const ob of [-1, 0, 1]) {
          const ra = a.k.width / 2, rb = b.k.width / 2;
          const ax = a.pos.x + Math.sin(a.yaw) * oa * (a.k.length / 2 - ra), az = a.pos.z + Math.cos(a.yaw) * oa * (a.k.length / 2 - ra);
          const bx = b.pos.x + Math.sin(b.yaw) * ob * (b.k.length / 2 - rb), bz = b.pos.z + Math.cos(b.yaw) * ob * (b.k.length / 2 - rb);
          const dx = bx - ax, dz = bz - az, d = Math.hypot(dx, dz), m = ra + rb;
          if (d >= m || d < 1e-4) continue;
          const nx = dx / d, nz = dz / d, push = (m - d) / 2;
          const sa = this.simulates(a), sb = this.simulates(b);
          if (sa) { a.pos.x -= nx * push * (sb ? 1 : 2); a.pos.z -= nz * push * (sb ? 1 : 2); }
          if (sb) { b.pos.x += nx * push * (sa ? 1 : 2); b.pos.z += nz * push * (sa ? 1 : 2); }
          const rv = (b.vel.x - a.vel.x) * nx + (b.vel.z - a.vel.z) * nz;
          if (rv < 0) {
            const j2 = -rv * 0.6;
            if (sa) { a.vel.x -= nx * j2; a.vel.z -= nz * j2; }
            if (sb) { b.vel.x += nx * j2; b.vel.z += nz * j2; }
            if (-rv > 4) this.crash(sa ? a : b, -rv, 'wall');
          }
        }
      }
    }
  }

  /** Engine note of the car you drive (or the loudest one near you). */
  sound() {
    if (!this.audio.engine) return;
    let best = 0, pitch = 1;
    for (const v of this.list) {
      const mineV = v === this.driving;
      const d = mineV ? 0 : this.camera.position.distanceTo(v.pos);
      const running = mineV || v.driver;
      if (!running || d > 45) continue;
      const rpm = 0.6 + Math.abs(v.speed) / v.k.maxSpeed * 1.4 + Math.abs(v.throttle) * 0.25;
      const lvl = (mineV ? 1 : clamp(1 - d / 45) * 0.7) * (0.45 + 0.4 * Math.abs(v.throttle));
      if (lvl > best) { best = lvl; pitch = rpm * (v.kind === 'buggy' ? 1.25 : 1); }
    }
    this.audio.engine(best, pitch);
  }

  // ------------------------------------------------------------------ saving and the network
  /** What a save or a friend joining needs to rebuild it. */
  record(v) { return { id: v.id, k: v.kind, c: v.color, p: [+v.pos.x.toFixed(3), +v.pos.y.toFixed(3), +v.pos.z.toFixed(3)], y: +v.yaw.toFixed(4), d: v.driver || 0 }; }

  /** Its movement right now (a driving friend sends this to the host 30 times a second). */
  state(v) {
    return { x: v.pos.x, y: v.pos.y, z: v.pos.z, yaw: v.yaw, pitch: v.pitch, roll: v.roll, vx: v.vel.x, vz: v.vel.z, vy: v.vy, speed: v.speed, steer: v.steer, yr: v.yawRate, th: v.throttle };
  }

  /** Take on a state that came from the network. */
  setState(v, s) {
    v.pos.set(s.x, s.y, s.z); v.yaw = s.yaw; v.pitch = s.pitch; v.roll = s.roll;
    v.vel.set(s.vx, 0, s.vz); v.vy = s.vy || 0; v.speed = s.speed; v.steer = s.steer; v.yawRate = s.yr || 0; v.throttle = s.th || 0;
  }
}
