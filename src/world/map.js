import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { CONFIG } from '../config.js';
import { GROUP } from '../core/physics.js';
import { trackMaterials, untrackMaterials } from '../materials.js';
import { ColliderGrid, ProxyCluster } from './grid.js';
import { makeGridTexture } from './build.js';
import { WORLD } from './world.js';

const UNIT_BOX = new THREE.BoxGeometry(1, 1, 1);
const _cam = new THREE.Vector3();

/**
 * Static boxes are grouped into compound bodies by area as well as by name: a ragdoll part is
 * only tested against the boxes of the bodies whose bounds it touches, so one body per 16 m cell
 * (instead of one per floor or one for the whole street) keeps the collision checks local.
 * Boxes bigger than a cell (slabs, the plaza) go into one body of their own per name.
 */
const CELL = 16;
function cellKey(body, x, y, z, w, h, d) {
  if (Math.max(w, d) > CELL * 1.5 || h > CELL * 1.5) return `${body}|big`;
  return `${body}|${Math.floor(x / CELL)},${Math.floor(y / CELL)},${Math.floor(z / CELL)}`;
}
const PROXY_MAT = new THREE.MeshBasicMaterial({ visible: false });
const TITLE_FOG = [35, 170];

/**
 * The world the game is played in. The sky, sun and the title screen's set stay for the whole
 * session; everything else comes from a map definition (see maps.js) and is swapped by load().
 *
 *  colliders   – boxes the player walks against (and blood lands on). Same array for every map.
 *  solidMeshes – what bullets, the grenade arc and the spawn ray hit. Same array for every map.
 *  grid        – spatial index over the colliders.
 *  interactables – things you look at and press E on (elevators, ladders...).
 */
export class GameMap {
  constructor(scene, physics, renderer) {
    this.scene = scene;
    this.physics = physics;
    this.colliders = [];
    this.solidMeshes = [];
    this.grid = new ColliderGrid(4, 4);
    this.root = new THREE.Group();
    this.root.name = 'map';
    scene.add(this.root);
    this.bodies = [];
    this.updaters = [];
    this.cullers = [];
    this.distanceCulled = [];
    this.farScale = 1;           // distance culling: set per graphics preset
    this.interactables = [];
    this.areas = [];
    this.tracked = [];
    this.disposables = new Set();
    this.def = null;
    this.bounds = { minX: -45, maxX: 45, minZ: -45, maxZ: 45 };
    this.titleMode = false;

    this.sky = new THREE.Color(CONFIG.map.skyColor);
    scene.background = this.sky;
    scene.fog = new THREE.Fog(this.sky, 35, 170);

    const pmrem = new THREE.PMREMGenerator(renderer);
    scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    scene.environmentIntensity = 0.4;

    this.hemi = new THREE.HemisphereLight(0xdfe6ee, 0x55585b, 0.85);
    scene.add(this.hemi);
    const sun = new THREE.DirectionalLight(0xffffff, 1.9);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    const sc = sun.shadow.camera; sc.left = -22; sc.right = 22; sc.top = 22; sc.bottom = -22; sc.near = 1; sc.far = 160;
    sun.shadow.bias = -0.0004;
    sun.shadow.normalBias = 0.02;
    scene.add(sun, sun.target);
    this.sun = sun;
    this.sunOffset = new THREE.Vector3(14, 26, 10).multiplyScalar(2.2);
    // Soft light from straight above for indoor maps (stands in for ceiling lights). Off outdoors.
    this.fill = new THREE.DirectionalLight(0xfff6e8, 0);
    this.fill.position.set(0.2, 1, 0.35);
    scene.add(this.fill);

    // the whole world sits on an endless ground plane at y = 0
    physics.addStaticPlane([0, 1, 0], [0, 0, 0]);
    this.buildTitleSet();
    WORLD.map = this;
  }

  // ---------------------------------------------------------------- the title screen's set
  /**
   * The title screen's corpse lies far outside every map, on its own patch of floor in front of
   * a wall, where nothing in the game can reach it.
   */
  buildTitleSet() {
    const [tx, tz] = CONFIG.map.titleSpot;
    const tex = makeGridTexture();
    tex.repeat.set(100, 100);
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(400, 400), new THREE.MeshStandardMaterial({ map: tex, roughness: 0.92 }));
    floor.rotation.x = -Math.PI / 2;
    floor.position.set(tx, 0, tz);
    floor.receiveShadow = true;
    floor.userData.surface = 'concrete';
    this.scene.add(floor);
    trackMaterials(floor);
    const propTex = makeGridTexture('#a9acaf', 'rgba(40,44,48,0.25)', 'rgba(30,33,36,0.4)');
    propTex.repeat.set(2, 3 / 4);
    const wall = new THREE.Mesh(new THREE.BoxGeometry(8, 3, 0.4), new THREE.MeshStandardMaterial({ map: propTex, roughness: 0.85 }));
    wall.position.set(tx, 1.5, tz);
    wall.castShadow = wall.receiveShadow = true;
    wall.userData.surface = 'concrete';
    this.scene.add(wall);
    trackMaterials(wall);
    this.physics.addStaticBox([4, 1.5, 0.2], [tx, 1.5, tz]);
    this.titleCollider = { min: new THREE.Vector3(tx - 4, 0, tz - 0.2), max: new THREE.Vector3(tx + 4, 3, tz + 0.2), keep: true, walk: true };
    this.titleMeshes = [floor, wall];
    this.titleWall = wall;
  }

  // ---------------------------------------------------------------- loading
  /** Build a map from its definition (maps.js). Removes the one before it. */
  load(def) {
    this.unload();
    this.def = def;
    this.id = def.id;
    const B = def.bounds;
    this.bounds = typeof B === 'number' ? { minX: -B, maxX: B, minZ: -B, maxZ: B } : { ...B };
    this.playerSpawn = def.playerSpawn;
    this.ragdollSpawn = def.ragdollSpawn;
    this.buttonSpots = def.buttons || [];
    this.fill.intensity = def.fill || 0;
    this.hemi.intensity = def.hemi ?? 0.85;
    this.sun.intensity = def.sun ?? 1.9;
    this.sun.color.set(def.sunColor ?? 0xffffff);
    this.hemi.color.set(def.hemiSky ?? 0xdfe6ee); this.hemi.groundColor.set(def.hemiGround ?? 0x55585b);
    this.scene.environmentIntensity = def.env ?? 0.4;
    if (def.sunDir) this.sunOffset.set(...def.sunDir); else this.sunOffset.set(14, 26, 10).multiplyScalar(2.2);
    this.addColliderObj(this.titleCollider);
    for (const m of this.titleMeshes) this.solidMeshes.push(m);
    def.build(this);
    this.boundaryWalls(def.wallHeight || 40);
    this.finishBodies();
    this.root.updateMatrixWorld(true);
    this.setTitleMode(this.titleMode);
    return this;
  }

  unload() {
    for (const b of this.bodies) this.physics.world.removeBody(b);
    this.bodies = [];
    this.compounds = new Map();
    for (const c of [...this.root.children]) this.root.remove(c);
    for (const m of this.tracked) untrackMaterials(m);
    this.tracked = [];
    for (const d of this.disposables) d.dispose?.();
    this.disposables.clear();
    this.colliders.length = 0;
    this.solidMeshes.length = 0;
    this.grid.clear();
    this.updaters = [];
    this.cullers = [];
    this.distanceCulled = [];
    this.view = null;
    this.seen = null; this.glass = null; this.elevator = null;
    this.interactables.length = 0;
    this.areas = [];
    this.floor = null;
    this.onUnload?.();
    this.onUnload = null;
    this.def = null;
  }

  /** Title screen: its own fog, so the set looks the same whatever map is loaded. */
  setTitleMode(on) {
    this.titleMode = on;
    for (const m of this.titleMeshes) m.visible = on;
    const sky = on ? CONFIG.map.skyColor : this.def?.sky ?? CONFIG.map.skyColor;
    const [near, far] = on ? TITLE_FOG : this.def?.fog || TITLE_FOG;
    this.sky.set(sky);
    this.scene.fog.color.set(sky);
    this.scene.fog.near = near; this.scene.fog.far = far;
  }

  // ---------------------------------------------------------------- building blocks for maps
  /** Visible object owned by the map (removed on unload). Tracks its materials for the graphics presets. */
  add(obj, { quality = true, grime = true } = {}) {
    this.root.add(obj);
    if (quality) {
      obj.traverse((o) => { if (o.material) for (const m of [].concat(o.material)) if (!this.tracked.includes(m)) { this.tracked.push(m); trackMaterials(m, { grime }); } });
    }
    obj.traverse((o) => { if (o.geometry) this.disposables.add(o.geometry); });
    return obj;
  }

  /** Player collision box. walk: ragdolls can stand on its top. off: temporarily not there (open doors). */
  addCollider(min, max, opts = {}) {
    return this.addColliderObj({ min, max, walk: false, surface: 'concrete', ...opts });
  }

  addColliderObj(c) { this.colliders.push(c); this.grid.insert(c); return c; }

  removeCollider(c) {
    const i = this.colliders.indexOf(c);
    if (i >= 0) this.colliders.splice(i, 1);
    this.grid.remove(c);
  }

  /** A static physics box (for ragdolls and gibs). Returns the body. */
  staticBox(half, pos) {
    const b = this.physics.addStaticBox(half, pos);
    this.bodies.push(b);
    return b;
  }

  /** A static body made of many boxes (one per floor of a building etc.): far cheaper than one body per box. */
  compound(key) {
    let b = this.compounds.get(key);
    if (!b) {
      b = new CANNON.Body({
        mass: 0, type: CANNON.Body.STATIC, material: this.physics.materials.ground,
        collisionFilterGroup: GROUP.STATIC, collisionFilterMask: GROUP.RAGDOLL | GROUP.DEBRIS,
      });
      b.userData = { key };
      this.compounds.set(key, b);
    }
    return b;
  }

  finishBodies() {
    for (const b of this.compounds.values()) {
      if (!b.shapes.length || b.world) continue;
      this.physics.world.addBody(b);
      this.bodies.push(b);
    }
  }

  /** New invisible ray-target cluster (bullets etc. test its bounds before its boxes). */
  cluster() {
    const c = new ProxyCluster();
    this.solidMeshes.push(c);
    return c;
  }

  /**
   * A solid box with no visible mesh of its own (the visuals are merged separately):
   * player collider, physics shape and an invisible ray target, each optional.
   * centre (x, y, z), size (w, h, d)
   */
  solid(x, y, z, w, h, d, { walk = false, surface = 'concrete', body = 'static', proxy = null, player = true, physics = true, data = null } = {}) {
    const out = {};
    if (player) out.collider = this.addCollider(new THREE.Vector3(x - w / 2, y - h / 2, z - d / 2), new THREE.Vector3(x + w / 2, y + h / 2, z + d / 2), { walk, surface });
    if (physics) {
      const shape = new CANNON.Box(new CANNON.Vec3(w / 2, h / 2, d / 2));
      const b = this.compound(cellKey(body, x, y, z, w, h, d));
      b.addShape(shape, new CANNON.Vec3(x, y, z));
      out.shape = shape; out.body = b;
    }
    if (proxy) {
      const m = new THREE.Mesh(UNIT_BOX, PROXY_MAT);
      m.position.set(x, y, z); m.scale.set(w, h, d);
      m.userData.surface = surface;
      if (data) Object.assign(m.userData, data);
      proxy.push(m);
      out.proxy = m;
    }
    return out;
  }

  /** A visible box: mesh + collider + physics box + bullet target (used by the small test map). */
  block(w, h, d, x, y, z, material, { walk = true, surface = 'concrete' } = {}) {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material);
    mesh.position.set(x, y, z);
    mesh.castShadow = mesh.receiveShadow = true;
    mesh.userData.surface = surface;
    this.add(mesh);
    this.solidMeshes.push(mesh);
    this.staticBox([w / 2, h / 2, d / 2], [x, y, z]);
    this.addCollider(new THREE.Vector3(x - w / 2, y - h / 2, z - d / 2), new THREE.Vector3(x + w / 2, y + h / 2, z + d / 2), { walk, surface });
    return mesh;
  }

  /** Invisible thick walls at the edge of the play area (physics for ragdolls and debris; the player clamps). */
  boundaryWalls(H) {
    const { minX, maxX, minZ, maxZ } = this.bounds, T = 3;
    const cx = (minX + maxX) / 2, cz = (minZ + maxZ) / 2, hx = (maxX - minX) / 2, hz = (maxZ - minZ) / 2;
    this.staticBox([T, H, hz + 2 * T], [minX - T, H, cz]);
    this.staticBox([T, H, hz + 2 * T], [maxX + T, H, cz]);
    this.staticBox([hx + 2 * T, H, T], [cx, H, minZ - T]);
    this.staticBox([hx + 2 * T, H, T], [cx, H, maxZ + T]);
  }

  // ---------------------------------------------------------------- queries
  /** Highest walkable top under (x, z) at or below y (0 = the ground). */
  groundAt(x, z, y = 1e9) {
    let h = 0;
    const list = this.grid.query(x, -1, z, x, Math.min(y, 400), z);
    for (let i = 0; i < list.length; i++) {
      const c = list[i];
      if (!c.walk || c.off || c.max.y > y || c.max.y <= h) continue;
      if (x > c.min.x && x < c.max.x && z > c.min.z && z < c.max.z) h = c.max.y;
    }
    return h;
  }

  /** Top of the surface right under a falling point (any collider), searched up to `band` metres down. */
  surfaceHeight(x, y, z, band = 6) {
    let h = y - band <= 0.05 ? 0 : -Infinity;
    const list = this.grid.query(x, y - band, z, x, y + 0.05, z);
    for (let i = 0; i < list.length; i++) {
      const c = list[i];
      if (c.off || c.max.y <= h) continue;
      if (x > c.min.x && x < c.max.x && z > c.min.z && z < c.max.z && y > c.min.y && y <= c.max.y + 0.05) h = c.max.y;
    }
    return h === -Infinity ? y - band : h;
  }

  /** Colliders near a box (for the player and particles). */
  near(minX, minY, minZ, maxX, maxY, maxZ) { return this.grid.query(minX, minY, minZ, maxX, maxY, maxZ); }

  /** The area a point is in (a building's floor), for keeping wandering ragdolls inside it. */
  areaAt(x, y, z) {
    for (const a of this.areas) if (x >= a.minX && x <= a.maxX && z >= a.minZ && z <= a.maxZ && y >= a.minY && y <= a.maxY) return a;
    return null;
  }

  inBounds(x, z, m = 0) { const b = this.bounds; return x > b.minX + m && x < b.maxX - m && z > b.minZ + m && z < b.maxZ - m; }

  /**
   * Right before drawing: hide what can't be seen from the camera (the map's own rules, e.g. the
   * tower's other floors) and small things that are far away (see cullDistance).
   */
  cull(camera) {
    camera.getWorldPosition(_cam);
    for (const c of this.cullers) c(_cam, this.ctx);
    const far = this.farScale;
    for (const o of this.distanceCulled) {
      const d = o.userData.cullDist * far, c = o.userData.cullCentre;
      const dx = c.x - _cam.x, dy = c.y - _cam.y, dz = c.z - _cam.z;
      const v = dx * dx + dy * dy + dz * dz < d * d;
      if (o.visible !== v) o.visible = v;
    }
  }

  /**
   * Draw a (merged) object only within `dist` metres of the camera (scaled by the graphics preset).
   * Its centre is its bounding sphere's centre.
   */
  cullDistance(obj, dist) {
    obj.updateMatrixWorld(true);
    if (!obj.geometry.boundingSphere) obj.geometry.computeBoundingSphere();
    obj.userData.cullDist = dist + obj.geometry.boundingSphere.radius;
    obj.userData.cullCentre = obj.geometry.boundingSphere.center.clone().applyMatrix4(obj.matrixWorld);
    this.distanceCulled.push(obj);
    return obj;
  }

  /** Keep the sun's shadow box on the player, and run the map's moving parts (elevators...). */
  update(focus, dt = 0, ctx = null) {
    this.sun.position.copy(focus).add(this.sunOffset);
    this.sun.target.position.copy(focus);
    for (const u of this.updaters) u(dt, focus, ctx || this.ctx);
  }
}
