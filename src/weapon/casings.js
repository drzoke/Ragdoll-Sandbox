import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { buildCasing } from './model1911.js';

// Lightweight ballistic casings (no physics engine needed): gravity, floor bounces, spin.
export class Casings {
  constructor(scene, material, audio) {
    this.scene = scene; this.material = material; this.audio = audio;
    this.list = [];
  }

  spawn(pos, vel) {
    let c;
    if (this.list.length >= CONFIG.gore.maxCasings) { c = this.list.shift(); }
    else { c = { mesh: buildCasing(this.material) }; c.mesh.castShadow = true; this.scene.add(c.mesh); }
    c.mesh.position.copy(pos);
    c.vel = vel.clone();
    c.spin = new THREE.Vector3((Math.random() - 0.5) * 40, (Math.random() - 0.5) * 40, (Math.random() - 0.5) * 40);
    c.resting = false; c.bounces = 0;
    this.list.push(c);
  }

  update(dt) {
    for (const c of this.list) {
      if (c.resting) continue;
      c.vel.y -= 9.81 * dt;
      c.mesh.position.addScaledVector(c.vel, dt);
      c.mesh.rotation.x += c.spin.x * dt; c.mesh.rotation.y += c.spin.y * dt; c.mesh.rotation.z += c.spin.z * dt;
      if (c.mesh.position.y < 0.006) {
        c.mesh.position.y = 0.006;
        if (Math.abs(c.vel.y) > 0.6 && c.bounces < 4) {
          if (c.bounces === 0) this.audio.play('casing');
          c.vel.y = -c.vel.y * 0.35; c.vel.x *= 0.6; c.vel.z *= 0.6; c.spin.multiplyScalar(0.5); c.bounces++;
        } else {
          c.resting = true;
          c.mesh.rotation.set(0, Math.random() * Math.PI * 2, 0);
        }
      }
    }
  }

  clear() { for (const c of this.list) this.scene.remove(c.mesh); this.list = []; }
}
