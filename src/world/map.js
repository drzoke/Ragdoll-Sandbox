import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/RoomEnvironment.js';
import { CONFIG } from '../config.js';
import { canvasTexture } from '../core/util.js';

// Prototype-style concrete grid texture: one texture tile = 4 m x 4 m.
function makeGridTexture(base = '#7f8285', line = 'rgba(40,44,48,0.32)', major = 'rgba(30,33,36,0.55)') {
  return canvasTexture(1024, 1024, (g, w, h) => {
    g.fillStyle = base; g.fillRect(0, 0, w, h);
    // concrete speckle + blotches
    const img = g.getImageData(0, 0, w, h), d = img.data;
    for (let i = 0; i < d.length; i += 4) {
      const n = (Math.random() - 0.5) * 16;
      d[i] += n; d[i + 1] += n; d[i + 2] += n;
    }
    g.putImageData(img, 0, 0);
    for (let i = 0; i < 70; i++) {
      const x = Math.random() * w, y = Math.random() * h, r = 20 + Math.random() * 90;
      const gr = g.createRadialGradient(x, y, 0, x, y, r);
      const a = Math.random() * 0.05;
      gr.addColorStop(0, Math.random() < 0.5 ? `rgba(0,0,0,${a})` : `rgba(255,255,255,${a})`);
      gr.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = gr; g.fillRect(x - r, y - r, r * 2, r * 2);
    }
    // 0.5 m faint, 1 m lines, 4 m border
    const cell = w / 8;
    g.strokeStyle = 'rgba(40,44,48,0.12)'; g.lineWidth = 1;
    for (let i = 1; i < 8; i += 2) { g.beginPath(); g.moveTo(i * cell, 0); g.lineTo(i * cell, h); g.moveTo(0, i * cell); g.lineTo(w, i * cell); g.stroke(); }
    g.strokeStyle = line; g.lineWidth = 3;
    for (let i = 2; i < 8; i += 2) { g.beginPath(); g.moveTo(i * cell, 0); g.lineTo(i * cell, h); g.moveTo(0, i * cell); g.lineTo(w, i * cell); g.stroke(); }
    g.strokeStyle = major; g.lineWidth = 8;
    g.strokeRect(0, 0, w, h);
    g.fillStyle = 'rgba(30,33,36,0.45)';
    g.font = 'bold 34px sans-serif';
    g.fillText('4m', 20, 50);
  }, { repeat: true });
}

export class GameMap {
  constructor(scene, physics, renderer) {
    this.scene = scene;
    this.colliders = [];   // AABBs for the player controller: {min: Vector3, max: Vector3}
    this.solidMeshes = []; // meshes bullets can hit (floor, props)
    const B = CONFIG.map.boundary;

    scene.background = new THREE.Color(CONFIG.map.skyColor);
    scene.fog = new THREE.Fog(CONFIG.map.skyColor, 35, 170);

    const pmrem = new THREE.PMREMGenerator(renderer);
    scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    scene.environmentIntensity = 0.4;

    const hemi = new THREE.HemisphereLight(0xdfe6ee, 0x55585b, 0.85);
    scene.add(hemi);
    const sun = new THREE.DirectionalLight(0xffffff, 1.9);
    sun.position.set(14, 26, 10);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    const sc = sun.shadow.camera; sc.left = -22; sc.right = 22; sc.top = 22; sc.bottom = -22; sc.near = 1; sc.far = 80;
    sun.shadow.bias = -0.0004;
    sun.shadow.normalBias = 0.02;
    scene.add(sun, sun.target);
    this.sun = sun;

    // Floor
    const tex = makeGridTexture();
    const size = CONFIG.map.floorSize;
    tex.repeat.set(size / 4, size / 4);
    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(size, size),
      new THREE.MeshStandardMaterial({ map: tex, roughness: 0.92, metalness: 0 })
    );
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    floor.userData.surface = 'concrete';
    scene.add(floor);
    this.floor = floor;
    this.solidMeshes.push(floor);

    physics.addStaticPlane([0, 1, 0], [0, 0, 0]);
    // Invisible boundary walls (physics for ragdolls/debris; the player clamps in its controller).
    physics.addStaticPlane([1, 0, 0], [-B, 0, 0]);
    physics.addStaticPlane([-1, 0, 0], [B, 0, 0]);
    physics.addStaticPlane([0, 0, 1], [0, 0, -B]);
    physics.addStaticPlane([0, 0, -1], [0, 0, B]);

    // A few prototype blocks for testing movement and ragdoll falls.
    const propTex = makeGridTexture('#a9acaf', 'rgba(40,44,48,0.25)', 'rgba(30,33,36,0.4)');
    const props = [
      // [w, h, d, x, z]
      [4, 1, 4, 12, -8],
      [2, 0.35, 2, 9, -3], [2, 0.7, 2, 9, -5], [2, 1.05, 2, 9, -7],
      [8, 3, 0.4, -12, -10],
      [1, 1, 1, -8, 4], [1, 1, 1, -8.2, 5.1], [1, 1, 1, -8.1, 4.5],
    ];
    for (const [w, h, d, x, z] of props) this.addBlock(w, h, d, x, h / 2, z, propTex, physics);
  }

  addBlock(w, h, d, x, y, z, tex, physics) {
    const t = tex.clone(); t.needsUpdate = true;
    t.repeat.set(Math.max(w, d) / 4, h / 4);
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), new THREE.MeshStandardMaterial({ map: t, roughness: 0.85 }));
    mesh.position.set(x, y, z);
    mesh.castShadow = mesh.receiveShadow = true;
    mesh.userData.surface = 'concrete';
    this.scene.add(mesh);
    this.solidMeshes.push(mesh);
    physics.addStaticBox([w / 2, h / 2, d / 2], [x, y, z]);
    this.addCollider(new THREE.Vector3(x - w / 2, y - h / 2, z - d / 2), new THREE.Vector3(x + w / 2, y + h / 2, z + d / 2));
    return mesh;
  }

  addCollider(min, max) { this.colliders.push({ min, max }); }

  /** Keep the sun's shadow frustum centred on the player. */
  update(focus) {
    this.sun.position.set(focus.x + 14, 26, focus.z + 10);
    this.sun.target.position.set(focus.x, 0, focus.z);
  }
}
