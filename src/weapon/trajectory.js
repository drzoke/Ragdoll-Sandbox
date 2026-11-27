import * as THREE from 'three';
import { CONFIG } from '../config.js';

const MAX_DOTS = 90;
const SPACING = 0.32;       // m between dots along the arc
const STEP = 1 / 90;        // s, simulation step
const MAX_TIME = 4;         // s of flight to simulate

const _p = new THREE.Vector3(), _v = new THREE.Vector3(), _n = new THREE.Vector3(), _d = new THREE.Vector3();
const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _s = new THREE.Vector3(), _cam = new THREE.Vector3();
const Z = new THREE.Vector3(0, 0, 1);

/**
 * Predicted path of a thrown grenade, shown while the throw is held: a dotted arc that follows
 * the same gravity and air drag as the real grenade, up to the first thing it hits, with a marker
 * where it lands.
 */
export class ThrowArc {
  /** targets(): meshes the arc can hit (map + ragdolls). */
  constructor(scene, targets) {
    this.targets = targets;
    this.raycaster = new THREE.Raycaster();
    const mat = new THREE.MeshBasicMaterial({ color: 0xfff4dc, transparent: true, opacity: 0.9, depthWrite: false, toneMapped: false });
    this.dots = new THREE.InstancedMesh(new THREE.SphereGeometry(1, 10, 8), mat, MAX_DOTS);
    this.dots.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.dots.frustumCulled = false;
    this.dots.renderOrder = 5;
    this.dots.visible = false;
    scene.add(this.dots);

    // landing marker: a ring with a dot in the middle, lying on the surface
    this.marker = new THREE.Group();
    const ringMat = new THREE.MeshBasicMaterial({ color: 0xfff4dc, transparent: true, opacity: 0.85, depthWrite: false, side: THREE.DoubleSide, toneMapped: false, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 });
    this.ring = new THREE.Mesh(new THREE.RingGeometry(0.17, 0.215, 40), ringMat);
    this.marker.add(this.ring);
    this.marker.add(new THREE.Mesh(new THREE.CircleGeometry(0.045, 20), ringMat));
    // faint danger zone: inside it, a person is very likely to be hurt badly
    const zoneMat = new THREE.MeshBasicMaterial({ color: 0xff6040, transparent: true, opacity: 0.16, depthWrite: false, side: THREE.DoubleSide, toneMapped: false, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 });
    this.zone = new THREE.Mesh(new THREE.RingGeometry(2.45, 2.6, 64), zoneMat);
    this.marker.add(this.zone);
    this.marker.renderOrder = 5;
    this.marker.visible = false;
    scene.add(this.marker);
    this.t = 0;
  }

  hide() { this.dots.visible = false; this.marker.visible = false; }

  /**
   * pos, vel: the release point and velocity the grenade would get right now.
   * damping: the body's linear damping. camera: for sizing the dots by distance.
   */
  show(pos, vel, damping, camera, dt = 0) {
    this.t += dt;
    const g = CONFIG.physics.gravity;
    const drag = Math.pow(1 - damping, STEP);
    const targets = this.targets();
    camera.getWorldPosition(_cam);
    _p.copy(pos); _v.copy(vel);
    let n = 0, along = 0, nextDot = 0.35 - ((this.t * 1.4) % SPACING); // dots drift along the arc
    let hit = null;
    for (let t = 0; t < MAX_TIME && n < MAX_DOTS; t += STEP) {
      _v.y += g * STEP;
      _v.multiplyScalar(drag);
      _d.copy(_v).multiplyScalar(STEP);
      const len = _d.length();
      if (len < 1e-6) break;
      this.raycaster.set(_p, _d.divideScalar(len));
      this.raycaster.far = len + 0.034;
      const h = this.raycaster.intersectObjects(targets, false)[0];
      const segEnd = h ? h.distance : len;
      // place dots along this segment
      while (nextDot <= along + segEnd && n < MAX_DOTS) {
        const at = nextDot - along;
        const q = _s.copy(_p).addScaledVector(_d, at);
        const dist = q.distanceTo(_cam);
        if (dist > 1.0) {
          const r = Math.max(0.008, dist * 0.0042);   // about the same size on screen near and far
          _m.compose(q, _q.identity(), _n.set(r, r, r));
          this.dots.setMatrixAt(n++, _m);
        }
        nextDot += SPACING;
      }
      if (h) { hit = h; break; }
      _p.addScaledVector(_d, len);
      along += len;
      if (_p.y < -5) break;
    }
    this.dots.count = n;
    this.dots.instanceMatrix.needsUpdate = true;
    this.dots.visible = n > 0;

    if (hit) {
      const nrm = hit.face ? _n.copy(hit.face.normal).transformDirection(hit.object.matrixWorld) : _n.set(0, 1, 0);
      this.marker.position.copy(hit.point).addScaledVector(nrm, 0.01);
      this.marker.quaternion.setFromUnitVectors(Z, nrm);
      // the danger zone only makes sense on the floor (not on a wall or a body)
      this.zone.visible = nrm.y > 0.7 && !hit.object.userData.ragdoll;
      this.ring.scale.setScalar(1 + 0.08 * Math.sin(this.t * 6));
      this.marker.visible = true;
    } else this.marker.visible = false;
  }
}
