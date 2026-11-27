import * as THREE from 'three';
import { canvasTexture } from '../core/util.js';

/** A physical push button on a pedestal. Walk up, look at it and press E (or shoot it). */
export class PressButton {
  constructor({ map, position, yaw = 0, label = 'RESPAWN', sub = 'Press E', prompt = label, color = 0xd8302a, onPress }) {
    this.onPress = onPress;
    this.cooldown = 0;
    this.pressT = 1;
    this.label = label;
    this.prompt = prompt;
    const root = new THREE.Group();
    root.position.set(...position);
    root.rotation.y = yaw;
    this.root = root;

    const metal = new THREE.MeshStandardMaterial({ color: 0x3b3f44, roughness: 0.5, metalness: 0.6 });
    const yellow = new THREE.MeshStandardMaterial({ color: 0xe8b923, roughness: 0.6 });
    const pedestal = new THREE.Mesh(new THREE.BoxGeometry(0.46, 1.0, 0.46), metal);
    pedestal.position.y = 0.5; pedestal.castShadow = pedestal.receiveShadow = true;
    const top = new THREE.Mesh(new THREE.BoxGeometry(0.56, 0.06, 0.56), metal);
    top.position.y = 1.03; top.castShadow = true;
    const ring = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.17, 0.035, 32), yellow);
    ring.position.y = 1.075;
    const housing = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.13, 0.03, 32), new THREE.MeshStandardMaterial({ color: 0x1b1c1e, roughness: 0.4 }));
    housing.position.y = 1.09;
    this.capMat = new THREE.MeshStandardMaterial({ color, roughness: 0.3, emissive: color, emissiveIntensity: 0.15 });
    this.cap = new THREE.Mesh(new THREE.CylinderGeometry(0.105, 0.11, 0.06, 32), this.capMat);
    this.cap.position.y = 1.12; this.cap.castShadow = true;
    this.capRest = 1.12;
    // hazard stripes + label sign
    const sign = new THREE.Mesh(new THREE.PlaneGeometry(0.42, 0.3), new THREE.MeshStandardMaterial({
      map: canvasTexture(256, 184, (g, w, h) => {
        g.fillStyle = '#1d1f22'; g.fillRect(0, 0, w, h);
        g.save(); g.beginPath(); g.rect(0, 0, w, 26); g.clip();
        for (let x = -30; x < w + 30; x += 26) { g.fillStyle = '#e8b923'; g.beginPath(); g.moveTo(x, 0); g.lineTo(x + 13, 0); g.lineTo(x - 13, 26); g.lineTo(x - 26, 26); g.fill(); }
        g.restore();
        g.fillStyle = '#f2f2f2'; g.font = 'bold 40px sans-serif'; g.textAlign = 'center';
        g.fillText(label, w / 2, 92);
        g.fillStyle = '#9aa3ab'; g.font = '22px sans-serif'; g.fillText(sub, w / 2, 136);
      }), roughness: 0.6,
    }));
    sign.position.set(0, 0.78, 0.231);
    root.add(pedestal, top, ring, housing, this.cap, sign);

    for (const m of [this.cap, housing, ring, top, pedestal]) m.userData.button = this;
    this.meshes = [this.cap, housing, ring, top, pedestal];

    // Light that blinks when pressed
    this.light = new THREE.PointLight(color, 0, 3, 2);
    this.light.position.set(0, 1.3, 0);
    root.add(this.light);

    // Colliders: player AABB + physics box for ragdolls (both go away with the map)
    const wp = new THREE.Vector3(...position);
    map.addCollider(new THREE.Vector3(wp.x - 0.28, wp.y, wp.z - 0.28), new THREE.Vector3(wp.x + 0.28, wp.y + 1.06, wp.z + 0.28));
    map.staticBox([0.28, 0.53, 0.28], [wp.x, wp.y + 0.53, wp.z]);
    map.add(root, { quality: true, grime: false });
  }

  press() {
    if (this.cooldown > 0) return false;
    this.cooldown = 0.6;
    this.pressT = 0;
    this.onPress?.();
    return true;
  }

  update(dt, highlighted) {
    this.cooldown -= dt;
    this.pressT = Math.min(1, this.pressT + dt * 3.5);
    const t = this.pressT;
    const depth = t < 0.15 ? t / 0.15 : 1 - (t - 0.15) / 0.85;
    this.cap.position.y = this.capRest - Math.max(0, depth) * 0.035;
    this.light.intensity = Math.max(0, 1 - t) * 6;
    this.capMat.emissiveIntensity = 0.15 + (highlighted ? 0.35 + Math.sin(performance.now() * 0.008) * 0.1 : 0) + Math.max(0, 1 - t) * 1.5;
  }
}
