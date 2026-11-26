import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { clamp, damp, lerp } from '../core/util.js';

const W = CONFIG.weapon;

/** Scene + camera + lights shared by every first-person viewmodel. */
export function viewmodelScene(environment) {
  const scene = new THREE.Scene();
  scene.environment = environment;
  scene.environmentIntensity = 0.9;
  const camera = new THREE.PerspectiveCamera(W.weaponFov, 1, 0.01, 10);
  scene.add(new THREE.HemisphereLight(0xe8eef5, 0x55575a, 1.4));
  const key = new THREE.DirectionalLight(0xffffff, 2.2); key.position.set(0.6, 1, 0.4); scene.add(key);
  const rim = new THREE.DirectionalLight(0xbcd4ff, 0.9); rim.position.set(-1, 0.3, -0.6); scene.add(rim);
  return { scene, camera };
}

/** Mouse-look sway (the item lags behind the view) + walk bob + idle breathing. */
export class Sway {
  constructor(player) { this.p = player; this.x = 0; this.y = 0; this.lastYaw = player.yaw; this.lastPitch = player.pitch; this.time = 0; }
  update(dt, { ads = 0, heavy = 1, rate = 10 } = {}) {
    const p = this.p;
    this.time += dt;
    const dYaw = p.yaw - this.lastYaw, dPitch = p.pitch - this.lastPitch;
    this.lastYaw = p.yaw; this.lastPitch = p.pitch;
    const mul = lerp(1, 0.2, ads) * heavy;
    this.x += (clamp(-dYaw * 1.6 * mul, -0.07, 0.07) - this.x) * damp(rate, dt);
    this.y += (clamp(dPitch * 1.6 * mul, -0.07, 0.07) - this.y) * damp(rate, dt);
    const bobA = p.bobAmount * lerp(1, 0.15, ads);
    this.bobX = Math.cos(p.bobPhase) * 0.009 * bobA;
    this.bobY = -Math.abs(Math.sin(p.bobPhase)) * 0.011 * bobA;
    this.idle = Math.sin(this.time * 1.3) * 0.0015 * (1 - ads * 0.8);
    return this;
  }
}
