import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { makeGridTexture } from './build.js';

/** The original open test map: a big concrete grid with a few blocks and steps. */
export const RANGE = {
  id: 'range',
  name: 'Test Range',
  desc: 'The open concrete test floor with a few blocks and steps.',
  sky: CONFIG.map.skyColor,
  fog: [35, 170],
  bounds: CONFIG.map.boundary,
  playerSpawn: { pos: [0, 0, 7], yaw: 0 },
  ragdollSpawn: { pos: [0, 0, -2], yaw: 0 },
  buttons: [{ pos: [-3, 0, 4], yaw: 0 }, { pos: [-4.2, 0, 4], yaw: 0 }],

  build(map) {
    const tex = makeGridTexture();
    const size = CONFIG.map.floorSize;
    tex.repeat.set(size / 4, size / 4);
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(size, size), new THREE.MeshStandardMaterial({ map: tex, roughness: 0.92, metalness: 0 }));
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    floor.userData.surface = 'concrete';
    map.add(floor);
    map.floor = floor;
    map.solidMeshes.push(floor);

    // a few prototype blocks for testing movement and ragdoll falls
    const propTex = makeGridTexture('#a9acaf', 'rgba(40,44,48,0.25)', 'rgba(30,33,36,0.4)');
    const props = [
      // [w, h, d, x, z]
      [4, 1, 4, 12, -8],
      [2, 0.35, 2, 9, -3], [2, 0.7, 2, 9, -5], [2, 1.05, 2, 9, -7],
      [8, 3, 0.4, -12, -10],
      [1, 1, 1, -8, 4], [1, 1, 1, -8.2, 5.1], [1, 1, 1, -8.1, 4.5],
    ];
    for (const [w, h, d, x, z] of props) {
      const t = propTex.clone(); t.needsUpdate = true;
      t.repeat.set(Math.max(w, d) / 4, h / 4);
      map.block(w, h, d, x, h / 2, z, new THREE.MeshStandardMaterial({ map: t, roughness: 0.85 }), { walk: h < 2 });
    }
  },
};
