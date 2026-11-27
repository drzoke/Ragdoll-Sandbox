import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { CONFIG } from '../config.js';
import { clamp, damp, Spring } from '../core/util.js';
import { GROUP } from '../core/physics.js';

const P = CONFIG.player;
const _v = new THREE.Vector3();

/**
 * First-person character controller.
 * - Custom kinematic movement (feet position + velocity) against the floor and static AABBs,
 *   with step-up, coyote time, jump buffering and crouch with head-clearance checks.
 * - A kinematic cannon body follows the player so ragdolls get shoved when you walk into them.
 * - Camera effects: mouse smoothing, head bob, strafe tilt, landing dip, sprint FOV,
 *   and an external recoil channel (pitch/yaw springs) the weapon writes into.
 */
export class PlayerController {
  constructor(camera, map, physics) {
    this.camera = camera;
    this.map = map;
    this.pos = new THREE.Vector3(...P.spawn);
    this.vel = new THREE.Vector3();
    this.yaw = 0; this.pitch = 0;
    this.targetYaw = 0; this.targetPitch = 0;
    this.onGround = true;
    this.crouch = 0;           // 0 standing .. 1 crouched (smoothed)
    this.wantsCrouch = false;
    this.sprinting = false;
    this.aiming = false;       // set by the weapon
    this.coyote = 0; this.jumpBuf = 0;
    this.bobPhase = 0; this.bobAmount = 0;
    this.tilt = 0;
    this.landSpring = new Spring(160, 16);
    this.recoilPitch = new Spring(90, 13);
    this.recoilYaw = new Spring(90, 13);
    this.shake = 0;
    this.fovKick = 0;
    this.speed2D = 0;

    // Kinematic pusher body
    this.body = new CANNON.Body({
      mass: 0, type: CANNON.Body.KINEMATIC,
      collisionFilterGroup: GROUP.PLAYER, collisionFilterMask: GROUP.RAGDOLL | GROUP.DEBRIS,
    });
    this.body.addShape(new CANNON.Sphere(P.radius), new CANNON.Vec3(0, 0.4, 0));
    this.body.addShape(new CANNON.Sphere(P.radius), new CANNON.Vec3(0, 1.0, 0));
    this.body.addShape(new CANNON.Sphere(P.radius * 0.8), new CANNON.Vec3(0, 1.45, 0));
    physics.world.addBody(this.body);
  }

  get height() { return P.height + (P.crouchHeight - P.height) * this.crouch; }
  get eyeHeight() { return P.eyeHeight + (P.crouchEyeHeight - P.eyeHeight) * this.crouch; }

  lookDir(out = new THREE.Vector3()) { return this.camera.getWorldDirection(out); }

  update(dt, input, active) {
    // ---------- Look ----------
    if (active) {
      const [dx, dy] = input.consumeMouse();
      // a rifle scope zooms in a lot: turn slower to match (aimFov = the scope's FOV multiplier)
      const sens = P.mouseSensitivity * (this.aiming ? 0.7 * Math.min(1, (this.aimFov ?? 1) / 0.82) : 1);
      this.targetYaw -= dx * sens;
      this.targetPitch -= dy * sens;
      this.targetPitch = clamp(this.targetPitch, -1.53, 1.53);
    }
    const s = P.lookSmoothing > 0 ? damp(30 * (1 - P.lookSmoothing) + 4, dt) : 1;
    this.yaw += (this.targetYaw - this.yaw) * s;
    this.pitch += (this.targetPitch - this.pitch) * s;

    if (this.script) { this.runScript(dt); this.updateCamera(dt, 0); return; }

    // ---------- Wish direction ----------
    let fx = 0, fz = 0;
    if (active) {
      if (input.isDown('KeyW')) fz -= 1;
      if (input.isDown('KeyS')) fz += 1;
      if (input.isDown('KeyA')) fx -= 1;
      if (input.isDown('KeyD')) fx += 1;
    }
    // touch stick: analogue (a light push walks slowly), keys win if both are used
    let analog = 1;
    if (active && !fx && !fz && input.axis && Math.hypot(input.axis.x, input.axis.y) > 0.08) {
      fx = input.axis.x; fz = input.axis.y;
      analog = clamp(Math.hypot(fx, fz) * 1.15, 0.3, 1);
    }
    const len = Math.hypot(fx, fz) || 1;
    fx /= len; fz /= len;
    const sin = Math.sin(this.yaw), cos = Math.cos(this.yaw);
    const wishX = fx * cos + fz * sin;
    const wishZ = -fx * sin + fz * cos;
    const moving = fx !== 0 || fz !== 0;

    // Ctrl only crouches when the keyboard is locked (fullscreen in Chrome/Edge); otherwise
    // Ctrl+W would close the tab, so C is the always-safe crouch key.
    this.wantsCrouch = active && (input.isDown('KeyC') || (input.keyboardLocked && input.isDown('ControlLeft')));
    this.sprinting = active && moving && input.isDown('ShiftLeft') && fz < -0.5 && !this.aiming && this.crouch < 0.5;
    let speed = this.sprinting ? P.sprintSpeed : P.walkSpeed * analog;
    if (this.crouch > 0.5) speed = P.crouchSpeed;
    if (this.aiming) speed *= P.adsSpeedMul;

    // ---------- Acceleration / friction ----------
    const accel = this.onGround ? P.groundAccel : P.airAccel;
    const tx = moving ? wishX * speed : 0, tz = moving ? wishZ * speed : 0;
    if (this.onGround || moving) {
      let ax = tx - this.vel.x, az = tz - this.vel.z;
      const al = Math.hypot(ax, az);
      const maxA = (moving ? accel : P.friction * Math.max(1, Math.hypot(this.vel.x, this.vel.z))) * dt;
      if (al > maxA) { ax *= maxA / al; az *= maxA / al; }
      this.vel.x += ax; this.vel.z += az;
    }

    // ---------- Jump ----------
    this.coyote = this.onGround ? P.coyoteTime : this.coyote - dt;
    this.jumpBuf = active && input.wasPressed('Space') ? P.jumpBuffer : this.jumpBuf - dt;
    if (this.jumpBuf > 0 && this.coyote > 0 && this.crouch < 0.6) {
      this.vel.y = P.jumpSpeed;
      this.onGround = false; this.coyote = 0; this.jumpBuf = 0;
    }
    this.vel.y -= P.gravity * dt;

    // ---------- Collide & move ----------
    const wasGround = this.onGround;
    const fallSpeed = this.vel.y;
    this.moveAxis('x', this.vel.x * dt);
    this.moveAxis('z', this.vel.z * dt);
    this.onGround = false;
    this.moveAxis('y', this.vel.y * dt);
    if (!wasGround && this.onGround && fallSpeed < -3) this.landSpring.kick(fallSpeed * 0.06);
    // fall height: from the highest point since last standing (for fall damage)
    if (!wasGround && this.onGround) this.onLand?.(-fallSpeed, (this.fallStart ?? this.pos.y) - this.pos.y);
    this.fallStart = this.onGround ? this.pos.y : Math.max(this.fallStart ?? this.pos.y, this.pos.y);

    const b = this.map.bounds, R = P.radius;
    this.pos.x = clamp(this.pos.x, b.minX + R, b.maxX - R);
    this.pos.z = clamp(this.pos.z, b.minZ + R, b.maxZ - R);

    // ---------- Crouch (with head clearance) ----------
    let crouchTarget = this.wantsCrouch ? 1 : 0;
    if (!this.wantsCrouch && this.crouch > 0.01 && this.blockedAbove(P.height)) crouchTarget = 1;
    this.crouch += (crouchTarget - this.crouch) * damp(12, dt);

    // ---------- Kinematic pusher ----------
    this.body.position.set(this.pos.x, this.pos.y - (1 - this.height / P.height) * 0.4, this.pos.z);
    this.body.velocity.set(this.vel.x, this.vel.y, this.vel.z);

    this.updateCamera(dt, fx);
  }

  overlaps(min, max) {
    const r = P.radius, p = this.pos, h = this.height;
    return p.x + r > min.x && p.x - r < max.x && p.z + r > min.z && p.z - r < max.z && p.y + h > min.y && p.y < max.y;
  }

  /** Colliders around the player (copied: the grid's own result array is reused by other queries). */
  nearby(pad = 0) {
    const r = P.radius + pad + 0.1, p = this.pos;
    const src = this.map.near(p.x - r, p.y - 0.6 - pad, p.z - r, p.x + r, p.y + P.height + 0.6 + pad, p.z + r);
    const out = this._near || (this._near = []);
    out.length = 0;
    for (let i = 0; i < src.length; i++) if (!src[i].off) out.push(src[i]);
    return out;
  }

  blockedAbove(h) {
    const r = P.radius, p = this.pos;
    for (const c of this.nearby()) {
      if (p.x + r > c.min.x && p.x - r < c.max.x && p.z + r > c.min.z && p.z - r < c.max.z && p.y + h > c.min.y && p.y < c.max.y) return true;
    }
    return false;
  }

  moveAxis(axis, delta) {
    if (delta === 0 && axis !== 'y') return;
    this.pos[axis] += delta;
    if (axis === 'y' && this.pos.y <= 0) { this.pos.y = 0; this.vel.y = Math.max(0, this.vel.y); this.onGround = true; }
    const list = this.nearby(Math.abs(delta)).slice();
    for (const c of list) {
      if (!this.overlaps(c.min, c.max)) continue;
      if (axis === 'y') {
        if (delta <= 0) { this.pos.y = c.max.y; this.onGround = true; this.vel.y = 0; }
        else { this.pos.y = c.min.y - this.height; this.vel.y = Math.min(0, this.vel.y); }
        continue;
      }
      // Step up small ledges
      const stepH = c.max.y - this.pos.y;
      if (stepH > 0 && stepH <= P.stepHeight && (this.onGround || this.coyote > 0)) {
        const oldY = this.pos.y;
        this.pos.y = c.max.y + 0.001;
        if (!this.anyOverlap(list)) { this.landSpring.kick(-stepH * 1.2); continue; }
        this.pos.y = oldY;
      }
      const r = P.radius;
      if (delta > 0) this.pos[axis] = c.min[axis] - r - 1e-4; else this.pos[axis] = c.max[axis] + r + 1e-4;
      this.vel[axis] = 0;
    }
  }

  anyOverlap(list = this.nearby()) { return list.some((c) => !c.off && this.overlaps(c.min, c.max)); }

  /** Put the player somewhere (map spawn, after dying). */
  spawnAt(pos, yaw = 0) {
    this.pos.set(pos[0], pos[1], pos[2]);
    this.vel.set(0, 0, 0);
    this.yaw = this.targetYaw = yaw;
    this.pitch = this.targetPitch = 0;
    this.onGround = true;
    this.fallStart = this.pos.y;
  }

  /** Move by an offset (elevator rides, ladders), keeping velocity and view. */
  teleport(dx, dy, dz) {
    this.pos.x += dx; this.pos.y += dy; this.pos.z += dz;
    this.fallStart = this.pos.y;
    this.body.position.x += dx; this.body.position.y += dy; this.body.position.z += dz;
  }

  /**
   * Scripted movement (climbing a ladder): fn(t, dt) moves this.pos itself and returns true when
   * done. Looking around still works; walking, jumping and gravity are off meanwhile.
   */
  play(fn) { this.script = { fn, t: 0 }; this.vel.set(0, 0, 0); }

  runScript(dt) {
    const s = this.script;
    s.t += dt;
    if (s.fn(s.t, dt)) { this.script = null; this.vel.set(0, 0, 0); this.fallStart = this.pos.y; this.onGround = true; }
    this.body.position.set(this.pos.x, this.pos.y, this.pos.z);
    this.body.velocity.set(0, 0, 0);
  }

  /** Called by the weapon on each shot. */
  addRecoil(pitch, yaw) {
    this.recoilPitch.kick(pitch * 22);
    this.recoilYaw.kick(yaw * 22);
    // The part the shooter does not fully recover becomes permanent aim drift (like real muzzle climb).
    this.targetPitch += pitch * (1 - CONFIG.weapon.recoil.recover);
    this.targetYaw += yaw * (1 - CONFIG.weapon.recoil.recover);
    this.shake = Math.min(1, this.shake + 0.35);
  }

  /** Big screen shake (explosions). amount ~0..2 */
  addShake(amount) { this.blastShake = Math.min(2.2, (this.blastShake || 0) + amount); }

  updateCamera(dt, strafe) {
    const hs = Math.hypot(this.vel.x, this.vel.z);
    this.speed2D = hs;
    const bobTarget = this.onGround ? clamp(hs / P.walkSpeed, 0, 1.6) : 0;
    this.bobAmount += (bobTarget - this.bobAmount) * damp(8, dt);
    this.bobPhase += dt * hs * P.bob.walkFreq * (this.sprinting ? 0.85 : 1) * (this.crouch > 0.5 ? 1.4 : 1);
    const adsDamp = this.aiming ? 0.25 : 1;
    const bobY = Math.abs(Math.sin(this.bobPhase)) * P.bob.amp * this.bobAmount * adsDamp - P.bob.amp * 0.5 * this.bobAmount * adsDamp;
    const bobX = Math.cos(this.bobPhase) * P.bob.sideAmp * this.bobAmount * adsDamp;
    const bobRoll = Math.cos(this.bobPhase) * P.bob.roll * this.bobAmount * adsDamp;
    this.tilt += (-strafe * P.strafeTilt * clamp(hs / P.walkSpeed) - this.tilt) * damp(8, dt);

    const land = this.landSpring.update(dt);
    const rp = this.recoilPitch.update(dt);
    const ry = this.recoilYaw.update(dt);
    this.shake = Math.max(0, this.shake - dt * 4);
    const sh = this.shake * this.shake * 0.004;
    this.blastShake = Math.max(0, (this.blastShake || 0) - dt * 1.6);
    const bs = this.blastShake * this.blastShake * 0.02;
    this.shakeT = (this.shakeT || 0) + dt;
    const bsx = (Math.sin(this.shakeT * 61) + Math.sin(this.shakeT * 37.7)) * bs, bsy = (Math.sin(this.shakeT * 53.3 + 1) + Math.sin(this.shakeT * 29.1)) * bs;

    const cam = this.camera;
    _v.set(bobX, 0, 0).applyAxisAngle(new THREE.Vector3(0, 1, 0), this.yaw);
    // dead: the view drops to the floor and rolls over
    const dn = this.down || 0, de = dn * dn * (3 - 2 * dn);
    cam.position.set(this.pos.x + _v.x, this.pos.y + (this.eyeHeight - 0.3) * (1 - de) + 0.3 + bobY + land, this.pos.z + _v.z);
    cam.rotation.set(
      this.pitch * (1 - de * 0.7) + rp + (Math.random() - 0.5) * sh + bsx + de * 0.15,
      this.yaw + ry + (Math.random() - 0.5) * sh + bsy,
      this.tilt + bobRoll + bsx * 0.6 + de * 1.25, 'YXZ'
    );

    const fovTarget = P.fov + (this.sprinting ? P.sprintFovBoost : 0);
    const fov = (this.aiming ? fovTarget * (this.aimFov ?? CONFIG.weapon.adsFovMul) : fovTarget) + this.fovKick;
    this.fovKick *= 1 - damp(10, dt);
    if (Math.abs(cam.fov - fov) > 0.01) { cam.fov += (fov - cam.fov) * damp(this.aimFov ? 22 : 10, dt); cam.updateProjectionMatrix(); }
  }
}
