import * as THREE from 'three';
import { BoxBatch, worldBox, mergeGeometries, boxMatrix } from './build.js';
import * as TX from './towerTextures.js';
import { GlassPanes } from './glass.js';
import { Elevator } from './elevator.js';
import { GROUP } from '../core/physics.js';

// ------------------------------------------------------------------ layout
export const BASE = 0.12;            // plaza / lobby floor height (the street is at 0)
export const FH = 3.6;               // floor to floor
export const LEVELS = 21;            // lobby + floors 1..20
export const ROOF = BASE + LEVELS * FH;   // 75.72
const HX = 16, HZ = 12;              // half footprint
const CEIL = 3.0;                    // suspended ceiling above each floor
const SHAFT = { x0: -1.2, x1: 1.2, z0: -1.4, z1: 1.0 };
const DOOR_Z = 1.1;
const CORE = { x0: -3.5, x1: 3.5, z0: -4.2, z1: 1.2 };
const LADDER = { x: 3.62, z: -2.6 };          // on the core's east face, top floor
const HATCH = { x: 4.45, z: -2.6 };           // roof hatch above it
export const fy = (i) => BASE + i * FH;
export const levelOf = (y) => Math.max(0, Math.min(LEVELS, Math.round((y - BASE) / FH)));
const LABELS = ['L', ...Array.from({ length: LEVELS - 1 }, (_, i) => String(i + 1))];

function rng(seed) {
  return () => { seed |= 0; seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

const tex = (t, rx = 1, ry = rx) => { t.repeat.set(rx, ry); return t; };
const std = (o) => new THREE.MeshStandardMaterial({ roughness: 0.7, ...o });

function materials() {
  const M = {
    carpet: std({ map: TX.carpet(), roughness: 0.95 }),
    ceiling: std({ map: TX.ceilingTiles(), roughness: 0.9, emissive: 0x8c8b86, emissiveIntensity: 0.55 }),
    lamp: std({ color: 0xffffff, emissive: 0xfff1dc, emissiveIntensity: 1.5, roughness: 0.5 }),
    core: std({ map: TX.paint('#cfcac0'), roughness: 0.85 }),
    column: std({ map: TX.paint('#dcd9d2'), roughness: 0.85 }),
    wood: std({ map: TX.wood(), roughness: 0.55 }),
    metal: std({ color: 0x34383d, roughness: 0.45, metalness: 0.6 }),
    alu: std({ color: 0xb5babf, roughness: 0.32, metalness: 0.85 }),
    black: std({ color: 0x16181b, roughness: 0.35, metalness: 0.2 }),
    screen: std({ color: 0x1a2635, emissive: 0x2f5a86, emissiveIntensity: 0.55, roughness: 0.2 }),
    paper: std({ color: 0xf1f0ec, roughness: 0.9 }),
    partition: std({ map: TX.fabric('#66727f'), roughness: 0.95 }),
    chair: std({ map: TX.fabric('#2c3137'), roughness: 0.9 }),
    sofa: std({ map: TX.fabric('#7c5b47'), roughness: 0.95 }),
    sofa2: std({ map: TX.fabric('#3e5566'), roughness: 0.95 }),
    rug: std({ map: TX.fabric('#8b8578'), roughness: 1 }),
    plant: std({ color: 0x3d6a33, roughness: 0.85 }),
    plant2: std({ color: 0x2f5a2a, roughness: 0.85 }),
    pot: std({ color: 0xe6e2da, roughness: 0.6 }),
    soil: std({ color: 0x3b2c20, roughness: 1 }),
    white: std({ color: 0xf4f4f2, roughness: 0.4 }),
    frosted: std({ color: 0xe9eff3, roughness: 0.15, metalness: 0.1, transparent: true, opacity: 0.42, depthWrite: false, side: THREE.DoubleSide }),
    glass: std({ color: 0x6f90a6, roughness: 0.05, metalness: 0.85, transparent: true, opacity: 0.46, envMapIntensity: 2.0, depthWrite: false, side: THREE.DoubleSide }),
    mullion: std({ color: 0x394047, roughness: 0.35, metalness: 0.7 }),
    spandrel: std({ color: 0x2b3136, roughness: 0.4, metalness: 0.5 }),
    stone: std({ map: TX.lobbyStone(), roughness: 0.26, metalness: 0.05 }),
    granite: std({ color: 0x2e2f31, roughness: 0.35, metalness: 0.1 }),
    paving: std({ map: TX.paving(), roughness: 0.9 }),
    asphalt: std({ map: TX.asphalt(), roughness: 0.95 }),
    sidewalk: std({ map: TX.sidewalk(), roughness: 0.92 }),
    curb: std({ color: 0x9c9a95, roughness: 0.9 }),
    paintWhite: std({ color: 0xe8e8e4, roughness: 0.8 }),
    paintYellow: std({ color: 0xd9b434, roughness: 0.8 }),
    roof: std({ map: TX.roofMembrane(), roughness: 0.95 }),
    machine: std({ map: TX.paint('#b9b6ae'), roughness: 0.85 }),
    hvac: std({ color: 0xa6aaad, roughness: 0.5, metalness: 0.6 }),
    red: std({ color: 0xc23a2e, roughness: 0.5 }),
    redLamp: std({ color: 0xff3020, emissive: 0xff2010, emissiveIntensity: 2.5 }),
    amberLamp: std({ color: 0x553300, emissive: 0xffa000, emissiveIntensity: 0.3 }),
    greenLamp: std({ color: 0x0c3, emissive: 0x20ff60, emissiveIntensity: 2 }),
    trunk: std({ color: 0x5a4231, roughness: 0.95 }),
    tire: std({ color: 0x1b1c1e, roughness: 0.9 }),
    carGlass: std({ color: 0x1d262e, roughness: 0.08, metalness: 0.6 }),
    headlight: std({ color: 0xffffff, emissive: 0xfff4d6, emissiveIntensity: 0.6 }),
    taillight: std({ color: 0x701010, emissive: 0xff2020, emissiveIntensity: 0.4 }),
    door: std({ color: 0xa8adb2, roughness: 0.28, metalness: 0.9 }),
    steel: std({ color: 0xc3c7cb, roughness: 0.22, metalness: 0.92 }),
    carFloor: std({ color: 0x3a3c3f, roughness: 0.7 }),
    button: std({ color: 0xdfe3e6, emissive: 0x6ac1ff, emissiveIntensity: 0.35, roughness: 0.3, metalness: 0.5 }),
    rail: std({ color: 0xb5babf, roughness: 0.25, metalness: 0.9 }),
    ground: new THREE.MeshLambertMaterial({ color: 0x5c5e60 }),
    skyRoof: new THREE.MeshLambertMaterial({ color: 0x55595d }),
    facade: [TX.facade('glass', 4, 4), TX.facade('brick', 4, 4), TX.facade('concrete', 4, 4), TX.facade('glass', 4, 4)].map((t, i) => std({ map: t, roughness: i % 2 ? 0.85 : 0.4, metalness: i === 0 || i === 3 ? 0.35 : 0 })),
    shopfront: std({ color: 0x20282e, roughness: 0.15, metalness: 0.6 }),
  };
  M.facade[3].color.set(0xc9d6df);
  M.glass.forceSinglePass = true; M.frosted.forceSinglePass = true;
  M.ceiling.emissiveMap = M.ceiling.map;
  M.carColors = [0xb3262a, 0x1f4f8a, 0xd8d8d4, 0x2d2f33, 0x7b7f84, 0x2f6a45, 0xc99a2a].map((c) => std({ color: c, roughness: 0.3, metalness: 0.55 }));
  M.carColors.forEach((m) => { m.envMapIntensity = 1.2; });
  return M;
}

/** Box without top and bottom faces (building walls), UVs in metres. */
function sideBox(w, h, d, tile) {
  const g = worldBox(w, h, d, tile);
  const idx = g.index.array, keep = [];
  for (const gr of g.groups) if (gr.materialIndex !== 2 && gr.materialIndex !== 3) for (let k = gr.start; k < gr.start + gr.count; k++) keep.push(idx[k]);
  g.setIndex(keep); g.clearGroups();
  return g;
}

/** Visual boxes + collision boxes for furniture, written relative to a floor and reused per floor. */
class Kit {
  constructor() { this.batch = new BoxBatch(); this.solids = []; }
  box(mat, x, y, z, w, h, d, o) { this.batch.add(mat, x, y, z, w, h, d, o); return this; }
  geo(mat, geo, m) { this.batch.addGeo(mat, geo, m); return this; }
  solid(x, y, z, w, h, d, o = {}) { this.solids.push([x, y, z, w, h, d, o]); return this; }
}

const CYL = new THREE.CylinderGeometry(0.5, 0.5, 1, 14);
const CYL8 = new THREE.CylinderGeometry(0.5, 0.5, 1, 8);
const BLOB = new THREE.IcosahedronGeometry(1, 1);
const cyl = (x, y, z, r, h) => boxMatrix(x, y, z, r * 2, h, r * 2);

// ------------------------------------------------------------------ furniture
function chair(k, M, x, z, face) {
  // face: +1 = sits on the +z side looking towards -z
  k.box(M.chair, x, 0.47, z, 0.5, 0.07, 0.5);
  k.box(M.chair, x, 0.83, z + face * 0.24, 0.46, 0.5, 0.06);
  k.box(M.metal, x, 0.27, z, 0.05, 0.36, 0.05);
  k.box(M.metal, x, 0.06, z, 0.62, 0.04, 0.06).box(M.metal, x, 0.06, z, 0.06, 0.04, 0.62);
  k.box(M.metal, x - 0.27, 0.62, z, 0.05, 0.04, 0.3).box(M.metal, x + 0.27, 0.62, z, 0.05, 0.04, 0.3);
  k.solid(x, 0.55, z, 0.55, 1.1, 0.55, { player: false, physics: false, surface: 'fabric' });
}

function desk(k, M, x, z, face, r) {
  k.box(M.wood, x, 0.735, z, 1.6, 0.03, 0.8);
  k.box(M.metal, x - 0.77, 0.36, z, 0.04, 0.72, 0.74).box(M.metal, x + 0.77, 0.36, z, 0.04, 0.72, 0.74);
  k.box(M.metal, x, 0.45, z - face * 0.37, 1.5, 0.4, 0.02);
  const mz = z - face * 0.22;
  k.box(M.black, x, 0.758, mz, 0.24, 0.015, 0.18);
  k.box(M.black, x, 0.92, mz - face * 0.03, 0.04, 0.3, 0.03);
  k.box(M.black, x, 1.08, mz, 0.58, 0.34, 0.025);
  k.box(M.screen, x, 1.08, mz + face * 0.0135, 0.54, 0.3, 0.002);
  k.box(M.black, x - 0.05, 0.757, z + face * 0.13, 0.44, 0.015, 0.14);
  if (r() < 0.6) k.box(M.paper, x + 0.5, 0.755 + r() * 0.03, z + face * 0.05, 0.21, 0.01 + r() * 0.04, 0.3, { yaw: r() * 0.6 - 0.3 });
  if (r() < 0.4) k.geo(M.white, CYL8, cyl(x - 0.55, 0.8, z + face * 0.18, 0.04, 0.1));
  chair(k, M, x + (r() - 0.5) * 0.3, z + face * 0.78, face);
}

function pod(k, M, px, pz, r) {
  desk(k, M, px - 0.8, pz - 0.4, -1, r); desk(k, M, px + 0.8, pz - 0.4, -1, r);
  desk(k, M, px - 0.8, pz + 0.4, 1, r); desk(k, M, px + 0.8, pz + 0.4, 1, r);
  k.box(M.partition, px, 0.63, pz, 3.24, 1.26, 0.05).box(M.alu, px, 1.265, pz, 3.26, 0.015, 0.07);
  k.box(M.partition, px, 0.63, pz, 0.05, 1.26, 1.62).box(M.alu, px, 1.265, pz, 0.07, 0.015, 1.64);
  k.solid(px, 0.375, pz, 3.2, 0.75, 1.6, { surface: 'wood' });
  k.solid(px, 1.0, pz, 3.24, 0.5, 0.06, { surface: 'fabric' });
}

function plant(k, M, x, z, s = 1) {
  k.geo(M.pot, CYL, cyl(x, 0.28 * s, z, 0.26 * s, 0.56 * s));
  k.geo(M.soil, CYL, cyl(x, 0.56 * s, z, 0.23 * s, 0.02));
  k.geo(M.plant, BLOB, boxMatrix(x, 1.05 * s, z, 0.45 * s, 0.55 * s, 0.45 * s));
  k.geo(M.plant2, BLOB, boxMatrix(x + 0.12 * s, 1.35 * s, z - 0.08 * s, 0.3 * s, 0.4 * s, 0.3 * s));
  k.solid(x, 0.28 * s, z, 0.52 * s, 0.56 * s, 0.52 * s, { surface: 'concrete' });
}

/** A sofa along x (faces -z when face = -1). */
function sofa(k, M, mat, x, z, len, face) {
  k.box(mat, x, 0.22, z, len, 0.44, 0.88);
  k.box(mat, x, 0.66, z - face * 0.36, len, 0.48, 0.18);
  k.box(mat, x - len / 2 + 0.09, 0.32, z, 0.18, 0.64, 0.88).box(mat, x + len / 2 - 0.09, 0.32, z, 0.18, 0.64, 0.88);
  k.solid(x, 0.45, z, len, 0.9, 0.9, { surface: 'fabric' });
}
/** A sofa along z (faces -x when face = -1). */
function sofaZ(k, M, mat, x, z, len, face) {
  k.box(mat, x, 0.22, z, 0.88, 0.44, len);
  k.box(mat, x - face * 0.36, 0.66, z, 0.18, 0.48, len);
  k.box(mat, x, 0.32, z - len / 2 + 0.09, 0.88, 0.64, 0.18).box(mat, x, 0.32, z + len / 2 - 0.09, 0.88, 0.64, 0.18);
  k.solid(x, 0.45, z, 0.9, 0.9, len, { surface: 'fabric' });
}
function table(k, M, x, z, w, d, h = 0.42) {
  k.box(M.wood, x, h, z, w, 0.04, d);
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) k.box(M.metal, x + sx * (w / 2 - 0.06), h / 2, z + sz * (d / 2 - 0.06), 0.04, h, 0.04);
  k.solid(x, h / 2, z, w, h, d, { surface: 'wood' });
}

/** Everything inside one office floor (floors 1..20 share it). Positions relative to the floor. */
function officeKit(M) {
  const k = new Kit(), r = rng(7);
  for (const px of [-12.2, -7.4, 7.4, 12.2]) for (const pz of [-8.5, -3.5, 3.5, 8.5]) pod(k, M, px, pz, r);
  // lounge in front of the elevators
  k.box(M.rug, 0, 0.004, 10.1, 4.6, 0.008, 2.9);
  sofa(k, M, M.sofa2, 0, 11.0, 2.5, -1);
  table(k, M, 0, 9.7, 1.2, 0.6);
  sofaZ(k, M, M.sofa2, -2.2, 9.6, 1.0, 1); sofaZ(k, M, M.sofa2, 2.2, 9.6, 1.0, -1);
  plant(k, M, -3.8, 11.3); plant(k, M, 3.8, 11.3);
  // meeting room at the back: frosted glass walls, a long table
  const wallH = CEIL;
  const seg = (x0, x1, z0, z1) => {
    const w = Math.max(0.05, x1 - x0), d = Math.max(0.05, z1 - z0), x = (x0 + x1) / 2, z = (z0 + z1) / 2;
    k.box(M.frosted, x, wallH / 2, z, w, wallH, d);
    k.box(M.alu, x, 0.04, z, w + 0.02, 0.08, d + 0.04).box(M.alu, x, wallH - 0.03, z, w + 0.02, 0.06, d + 0.04);
    k.solid(x, wallH / 2, z, w, wallH, d, { surface: 'glass' });
  };
  seg(-4.6, 1.8, -5.62, -5.58); seg(2.8, 4.6, -5.62, -5.58);
  seg(-4.62, -4.58, -11.9, -5.6); seg(4.58, 4.62, -11.9, -5.6);
  k.box(M.alu, 1.8, wallH / 2, -5.6, 0.06, wallH, 0.08).box(M.alu, 2.8, wallH / 2, -5.6, 0.06, wallH, 0.08);
  k.box(M.wood, 0, 0.74, -8.7, 3.4, 0.05, 1.3);
  k.box(M.metal, -1.1, 0.36, -8.7, 0.3, 0.72, 0.6).box(M.metal, 1.1, 0.36, -8.7, 0.3, 0.72, 0.6);
  k.solid(0, 0.38, -8.7, 3.4, 0.76, 1.3, { surface: 'wood' });
  for (const x of [-1.1, 0, 1.1]) { chair(k, M, x, -7.75, 1); chair(k, M, x, -9.65, -1); }
  k.box(M.white, -4.55, 1.5, -8.7, 0.03, 1.0, 1.9).box(M.alu, -4.55, 0.99, -8.7, 0.06, 0.03, 1.9);
  // printer, water cooler, cabinets, plants by the columns
  k.box(M.metal, -4.25, 0.5, 2.0, 0.55, 1.0, 0.5).box(M.paper, -4.25, 1.01, 2.0, 0.4, 0.02, 0.3);
  k.solid(-4.25, 0.5, 2.0, 0.55, 1.0, 0.5);
  k.box(M.white, 4.15, 0.55, 1.8, 0.32, 1.1, 0.32);
  k.geo(std({ color: 0x6fb8e8, transparent: true, opacity: 0.6, roughness: 0.1 }), CYL, cyl(4.15, 1.3, 1.8, 0.14, 0.4));
  k.solid(4.15, 0.55, 1.8, 0.32, 1.1, 0.32);
  for (const z of [-10.6, -9.9, -9.2]) { k.box(M.metal, -15.55, 0.55, z, 0.6, 1.1, 0.66); k.solid(-15.55, 0.55, z, 0.6, 1.1, 0.66); }
  for (const z of [9.2, 9.9, 10.6]) { k.box(M.metal, 15.55, 0.55, z, 0.6, 1.1, 0.66); k.solid(15.55, 0.55, z, 0.6, 1.1, 0.66); }
  for (const [x, z] of [[-9.7, 6.7], [9.7, 6.7], [-9.7, -6.7], [9.7, -6.7]]) plant(k, M, x, z, 0.9);
  return k;
}

function lobbyKit(M) {
  const k = new Kit(), r = rng(11);
  // reception desk facing the entrance
  k.box(M.wood, 0, 0.56, 6.85, 4.4, 1.12, 0.12).box(M.granite, 0, 1.14, 6.75, 4.6, 0.05, 0.62);
  k.box(M.wood, -2.15, 0.56, 6.35, 0.12, 1.12, 1.0).box(M.wood, 2.15, 0.56, 6.35, 0.12, 1.12, 1.0);
  k.box(M.white, 0, 0.74, 6.3, 4.2, 0.04, 0.6);
  for (const x of [-1, 1]) { k.box(M.black, x, 1.0, 6.35, 0.5, 0.3, 0.025); k.box(M.screen, x, 1.0, 6.337, 0.46, 0.26, 0.002); k.box(M.black, x, 0.8, 6.38, 0.04, 0.12, 0.04); }
  chair(k, M, -1, 5.6, -1); chair(k, M, 1, 5.6, -1);
  k.solid(0, 0.57, 6.4, 4.6, 1.14, 1.1, { surface: 'wood' });
  // waiting areas left and right
  for (const s of [-1, 1]) {
    k.box(M.rug, s * 11.4, 0.004, 1.5, 3.4, 0.008, 4.6);
    sofaZ(k, M, M.sofa, s * 12.6, 1.5, 2.4, s);
    table(k, M, s * 11.1, 1.5, 0.7, 1.3, 0.4);
    sofa(k, M, M.sofa, s * 11.1, -0.6, 1.6, -1);
    sofa(k, M, M.sofa, s * 11.1, 3.6, 1.6, 1);
    plant(k, M, s * 14.9, 10.9, 1.3); plant(k, M, s * 14.9, -10.9, 1.3); plant(k, M, s * 5.2, 10.9, 1.1);
  }
  plant(k, M, -9.7, -6.7, 1.1); plant(k, M, 9.7, -6.7, 1.1);
  // benches along the back wall
  for (const x of [-9, -5, 5, 9]) { k.box(M.wood, x, 0.45, -10.9, 2.0, 0.06, 0.5).box(M.metal, x - 0.8, 0.22, -10.9, 0.06, 0.44, 0.44).box(M.metal, x + 0.8, 0.22, -10.9, 0.06, 0.44, 0.44); k.solid(x, 0.24, -10.9, 2.0, 0.48, 0.5, { surface: 'wood' }); }
  r();
  return k;
}

// ------------------------------------------------------------------ the city around it
function car(k, M, x, z, yaw, colorMat) {
  const c = Math.cos(yaw), s = Math.sin(yaw);
  const at = (ox, oz) => [x + ox * c + oz * s, z - ox * s + oz * c];
  const part = (mat, ox, y, oz, l, h, w) => { const [px, pz] = at(ox, oz); k.box(mat, px, y, pz, l, h, w, { yaw }); };
  part(colorMat, 0, 0.58, 0, 4.3, 0.62, 1.8);
  part(M.carGlass, -0.25, 1.17, 0, 2.3, 0.56, 1.62);
  part(colorMat, -0.25, 1.47, 0, 2.15, 0.06, 1.5);
  part(M.black, 2.16, 0.42, 0, 0.08, 0.22, 1.76); part(M.black, -2.16, 0.42, 0, 0.08, 0.22, 1.76);
  part(M.headlight, 2.13, 0.68, 0.62, 0.06, 0.12, 0.34); part(M.headlight, 2.13, 0.68, -0.62, 0.06, 0.12, 0.34);
  part(M.taillight, -2.13, 0.72, 0.65, 0.06, 0.12, 0.3); part(M.taillight, -2.13, 0.72, -0.65, 0.06, 0.12, 0.3);
  for (const ox of [-1.35, 1.35]) for (const oz of [-0.82, 0.82]) {
    const [px, pz] = at(ox, oz);
    const m = new THREE.Matrix4().compose(new THREE.Vector3(px, 0.33, pz), new THREE.Quaternion().setFromEuler(new THREE.Euler(Math.PI / 2, yaw, 0, 'YXZ')), new THREE.Vector3(0.66, 0.24, 0.66));
    k.geo(M.tire, CYL, m);
  }
  const along = Math.abs(s) > 0.5;
  k.solid(x, 0.75, z, along ? 1.8 : 4.3, 1.5, along ? 4.3 : 1.8, { surface: 'metal', walk: true });
}

function lamp(k, M, x, z, dir) {
  k.geo(M.metal, CYL8, cyl(x, BASE + 3.3, z, 0.07, 6.6));
  k.box(M.metal, x + dir[0] * 0.6, BASE + 6.55, z + dir[1] * 0.6, dir[0] ? 1.2 : 0.08, 0.08, dir[1] ? 1.2 : 0.08);
  k.box(M.metal, x + dir[0] * 1.15, BASE + 6.48, z + dir[1] * 1.15, 0.55, 0.14, 0.3, { yaw: dir[0] ? 0 : Math.PI / 2 });
  k.box(M.headlight, x + dir[0] * 1.15, BASE + 6.405, z + dir[1] * 1.15, 0.45, 0.01, 0.22, { yaw: dir[0] ? 0 : Math.PI / 2 });
  k.solid(x, BASE + 3.3, z, 0.2, 6.6, 0.2, { surface: 'metal' });
}

function tree(k, M, x, z, r) {
  k.box(M.curb, x, BASE + 0.25, z, 1.8, 0.5, 1.8).box(M.soil, x, BASE + 0.505, z, 1.6, 0.01, 1.6);
  k.geo(M.trunk, CYL8, cyl(x, BASE + 2.0, z, 0.14, 3.2));
  const s = 0.8 + r() * 0.4;
  k.geo(M.plant, BLOB, boxMatrix(x, BASE + 4.2 * s, z, 1.7 * s, 1.5 * s, 1.7 * s));
  k.geo(M.plant2, BLOB, boxMatrix(x + 0.5, BASE + 4.9 * s, z - 0.3, 1.1 * s, 1.0 * s, 1.1 * s));
  k.solid(x, BASE + 0.25, z, 1.8, 0.5, 1.8, { surface: 'concrete', walk: true });
  k.solid(x, BASE + 2.0, z, 0.3, 3.2, 0.3, { surface: 'wood' });
}

function bench(k, M, x, z, alongX = true) {
  const [w, d] = alongX ? [1.8, 0.45] : [0.45, 1.8];
  k.box(M.wood, x, BASE + 0.45, z, w, 0.06, d);
  if (alongX) k.box(M.wood, x, BASE + 0.78, z + 0.2, w, 0.36, 0.05); else k.box(M.wood, x + 0.2, BASE + 0.78, z, 0.05, 0.36, d);
  for (const t of [-0.75, 0.75]) k.box(M.metal, x + (alongX ? t : 0), BASE + 0.22, z + (alongX ? 0 : t), alongX ? 0.06 : 0.42, 0.44, alongX ? 0.42 : 0.06);
  k.solid(x, BASE + 0.25, z, w, 0.5, d, { surface: 'wood' });
}

function cityKit(M) {
  const k = new Kit(), r = rng(3);
  // plaza around the tower (one step up from the street)
  k.box(M.paving, 0, BASE / 2, 0, 44, BASE, 36, { tile: 4 });
  k.solid(0, BASE / 2, 0, 44, BASE, 36, { walk: true, surface: 'concrete' });
  // outer sidewalks in front of the buildings around the block
  const walks = [[0, -32, 76, 4], [0, 32, 76, 4], [-36, 0, 4, 60], [36, 0, 4, 60]];
  for (const [x, z, w, d] of walks) {
    k.box(M.sidewalk, x, BASE / 2, z, w, BASE, d, { tile: 1.5 });
    k.solid(x, BASE / 2, z, w, BASE, d, { walk: true, surface: 'concrete' });
  }
  // road markings: dashed centre lines and zebra crossings
  const dash = (x, z, alongX, len) => k.box(M.paintWhite, x, 0.006, z, alongX ? len : 0.14, 0.004, alongX ? 0.14 : len);
  for (let x = -19; x <= 19; x += 6) { dash(x, -24, true, 3); dash(x, 24, true, 3); }
  for (let z = -15; z <= 15; z += 6) { dash(-28, z, false, 3); dash(28, z, false, 3); }
  for (let z = 18.6; z < 30; z += 1.1) k.box(M.paintWhite, 0, 0.006, z, 4, 0.004, 0.55);
  for (let z = -29.4; z < -18; z += 1.1) k.box(M.paintWhite, 0, 0.006, z, 4, 0.004, 0.55);
  for (let x = 22.6; x < 34; x += 1.1) { k.box(M.paintWhite, x, 0.006, 0, 0.55, 0.004, 4); k.box(M.paintWhite, -x, 0.006, 0, 0.55, 0.004, 4); }
  // stop lines + yellow curb paint at the corners
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) k.box(M.paintYellow, sx * 22.02, 0.07, sz * 16.5, 0.05, 0.1, 3);
  // manholes
  for (const [x, z] of [[-10, 26], [14, -25], [29, 7], [-27, -9]]) k.geo(M.metal, CYL, cyl(x, 0.006, z, 0.4, 0.008));
  // street lamps around the plaza
  for (let x = -18; x <= 18; x += 9) { if (Math.abs(x) > 3) lamp(k, M, x, 17.5, [0, 1]); lamp(k, M, x, -17.5, [0, -1]); }
  for (let z = -13.5; z <= 13.5; z += 9) { lamp(k, M, 21.5, z, [1, 0]); lamp(k, M, -21.5, z, [-1, 0]); }
  // trees, benches, bins and bollards on the plaza
  for (const z of [-12, -4, 4, 12]) { tree(k, M, 19, z, r); tree(k, M, -19, z, r); }
  tree(k, M, -11, 15.2, r); tree(k, M, 11, 15.2, r);
  for (const x of [-15, -6.5, 6.5, 15]) bench(k, M, x, 16.6);
  for (const x of [-8.5, 8.5]) { k.geo(M.metal, CYL8, cyl(x, BASE + 0.45, 16.9, 0.25, 0.9)); k.solid(x, BASE + 0.45, 16.9, 0.5, 0.9, 0.5, { surface: 'metal' }); }
  for (let x = -3.5; x <= 3.5; x += 1.75) { k.geo(M.granite, CYL8, cyl(x, BASE + 0.45, 17.6, 0.12, 0.9)); k.solid(x, BASE + 0.45, 17.6, 0.24, 0.9, 0.24, { surface: 'metal' }); }
  // traffic lights at the corners
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    const x = sx * 21.6, z = sz * 17.6;
    k.geo(M.metal, CYL8, cyl(x, BASE + 1.8, z, 0.08, 3.6));
    k.box(M.black, x, BASE + 3.4, z, 0.32, 0.95, 0.32);
    k.box(M.redLamp, x, BASE + 3.7, z + sz * 0.165, 0.18, 0.18, 0.01);
    k.box(M.amberLamp, x, BASE + 3.42, z + sz * 0.165, 0.18, 0.18, 0.01);
    k.box(M.black, x, BASE + 3.14, z + sz * 0.165, 0.18, 0.18, 0.01);
    k.solid(x, BASE + 1.8, z, 0.2, 3.6, 0.2, { surface: 'metal' });
  }
  // fire hydrants
  for (const [x, z] of [[21.3, 9], [-21.3, -9], [8, 31]]) { k.geo(M.red, CYL8, cyl(x, BASE + 0.35, z, 0.13, 0.7)); k.geo(M.red, CYL8, cyl(x, BASE + 0.72, z, 0.09, 0.08)); k.solid(x, BASE + 0.4, z, 0.3, 0.8, 0.3, { surface: 'metal' }); }
  // bus stop on the far sidewalk
  k.box(M.metal, 12, BASE + 1.25, 33.6, 4, 0.06, 0.06).box(M.metal, 10.05, BASE + 1.25, 32.6, 0.08, 2.5, 0.08).box(M.metal, 13.95, BASE + 1.25, 32.6, 0.08, 2.5, 0.08);
  k.box(M.metal, 12, BASE + 2.52, 32.9, 4.2, 0.08, 1.8).box(M.frosted, 12, BASE + 1.4, 33.65, 3.9, 2.2, 0.03);
  bench(k, M, 12, 33.2);
  k.solid(12, BASE + 1.4, 33.65, 4, 2.6, 0.1, { surface: 'glass' });
  // parked cars along the far curbs
  const cars = [[-24, -28.7, 0], [-13, -28.7, 0], [5, -28.7, Math.PI], [17, -28.7, 0], [-19, 28.7, Math.PI], [-7, 28.7, 0], [19, 28.7, Math.PI],
    [32.6, -12, Math.PI / 2], [32.6, 9, -Math.PI / 2], [-32.6, -6, Math.PI / 2], [-32.6, 13, -Math.PI / 2]];
  cars.forEach(([x, z, yaw], i) => car(k, M, x, z, yaw, M.carColors[(i * 3 + 1) % M.carColors.length]));
  return k;
}

/** Buildings around the block (solid to bullets) and the skyline beyond (scenery only). */
function buildings(map, M, cluster) {
  const r = rng(5);
  // the ring around the block (can shade the street) and the far skyline (never near the shadow
  // box around you: no shadows cast or received, which also makes it cheaper to draw)
  const faces = M.facade.map(() => new BoxBatch()), farFaces = M.facade.map(() => new BoxBatch());
  const roofs = new BoxBatch(), farRoofs = new BoxBatch(), shops = new BoxBatch();
  const put = (x0, x1, z0, z1, h, style, solid, shop) => {
    const w = x1 - x0, d = z1 - z0, x = (x0 + x1) / 2, z = (z0 + z1) / 2;
    (solid ? faces : farFaces)[style].addGeo(M.facade[style], sideBox(w, h, d, 12), boxMatrix(x, h / 2, z));
    (solid ? roofs : farRoofs).add(M.skyRoof, x, h + 0.05, z, w, 0.1, d);
    if (shop) {
      const [sx, sz, sw, sd] = shop === 'n' ? [x, z1 + 0.04, w - 1, 0.1] : shop === 's' ? [x, z0 - 0.04, w - 1, 0.1] : shop === 'e' ? [x1 + 0.04, z, 0.1, d - 1] : [x0 - 0.04, z, 0.1, d - 1];
      shops.add(M.shopfront, sx, 1.9, sz, sw, 3.6, sd);
      shops.add(M.granite, sx, 3.95, sz, sw + 0.4, 0.5, sd + (shop === 'n' || shop === 's' ? 0.6 : 0)) ;
    }
    if (solid) map.solid(x, h / 2, z, w, h, d, { proxy: cluster, physics: false, player: false, surface: 'concrete' });
  };
  // the ring of buildings facing the block
  const row = (from, to, place) => { let a = from; while (a < to) { const w = 12 + r() * 14; place(a, Math.min(to, a + w), 16 + r() * 55, Math.floor(r() * 4)); a += w + 0.4; } };
  row(-84, 84, (a, b, h, st) => put(a, b, -34 - 16 - r() * 14, -34, h, st, true, 'n'));
  row(-84, 84, (a, b, h, st) => put(a, b, 34, 34 + 16 + r() * 14, h, st, true, 's'));
  row(-34, 34, (a, b, h, st) => put(-38 - 16 - r() * 14, -38, a, b, h, st, true, 'e'));
  row(-34, 34, (a, b, h, st) => put(38, 38 + 16 + r() * 14, a, b, h, st, true, 'w'));
  // skyline: scenery out to the fog
  for (let i = 0; i < 170; i++) {
    const a = r() * Math.PI * 2, d = 105 + r() * 380;
    const x = Math.cos(a) * d, z = Math.sin(a) * d;
    const w = 14 + r() * 26, dd = 14 + r() * 26;
    const tall = r() < 0.15;
    put(x - w / 2, x + w / 2, z - dd / 2, z + dd / 2, tall ? 90 + r() * 120 : 18 + r() * 70, Math.floor(r() * 4), false, null);
  }
  for (const b of [...faces, roofs, shops]) for (const m of b.build({ castShadow: true, receiveShadow: true })) map.add(m);
  for (const b of [...farFaces, farRoofs]) for (const m of b.build({ castShadow: false, receiveShadow: false })) map.add(m);
}

// ------------------------------------------------------------------ the tower
export function buildTower(map) {
  const M = materials();
  const city = map.cluster();
  const shell = new BoxBatch();

  // ---- ground: street asphalt + far ground, both bullet targets ----
  const asphalt = new THREE.Mesh(new THREE.PlaneGeometry(84, 76), M.asphalt);
  tex(M.asphalt.map, 84 / 6, 76 / 6);
  asphalt.rotation.x = -Math.PI / 2; asphalt.position.y = 0.003; asphalt.receiveShadow = true;
  asphalt.userData.surface = 'concrete';
  // big ground planes are drawn after everything standing on them, so hidden parts cost nothing
  asphalt.renderOrder = 1;
  map.add(asphalt); map.solidMeshes.push(asphalt);
  const far = new THREE.Mesh(new THREE.PlaneGeometry(1400, 1400), M.ground);
  far.rotation.x = -Math.PI / 2; far.position.y = -0.02; far.userData.surface = 'concrete'; far.renderOrder = 2;
  map.add(far, { quality: false }); map.solidMeshes.push(far);

  const ck = cityKit(M);
  for (const m of ck.batch.build({ noShadow: [M.paving, M.sidewalk, M.paintWhite, M.paintYellow] })) map.add(m);
  for (const [x, y, z, w, h, d, o] of ck.solids) map.solid(x, y, z, w, h, d, { body: 'city', proxy: city, ...o });
  buildings(map, M, city);

  // ---- structure: core, columns, slabs, ceilings, lights (always drawn) ----
  const core = map.cluster();
  const coreTop = ROOF + 3.2;
  const coreBox = (x0, x1, z0, z1, y0 = BASE, y1 = coreTop) => {
    const w = x1 - x0, h = y1 - y0, d = z1 - z0;
    shell.add(M.core, (x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2, w, h, d, { tile: 4 });
    map.solid((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2, w, h, d, { body: 'core', proxy: core });
  };
  coreBox(CORE.x0, SHAFT.x0, CORE.z0, CORE.z1);
  coreBox(SHAFT.x1, CORE.x1, CORE.z0, CORE.z1);
  coreBox(SHAFT.x0, SHAFT.x1, CORE.z0, SHAFT.z0);
  coreBox(SHAFT.x0, -0.6, SHAFT.z1, CORE.z1, BASE, ROOF);
  coreBox(0.6, SHAFT.x1, SHAFT.z1, CORE.z1, BASE, ROOF);
  // Each floor's own surfaces (ceiling, light panels, carpet, door trims) are built twice: per floor,
  // drawn only for the floor you're on while you're inside the tower (the slabs hide the others),
  // and merged for the whole tower, drawn instead while you're outside looking in through the glass.
  const inner = Array.from({ length: LEVELS }, () => ({ shell: new BoxBatch(), lamps: new BoxBatch() }));
  const outer = { shell: new BoxBatch(), lamps: new BoxBatch() };
  const both = (i, kind, fn) => { fn(inner[i][kind]); fn(outer[kind]); };
  for (let i = 0; i < LEVELS; i++) {
    coreBox(-0.6, 0.6, SHAFT.z1, CORE.z1, fy(i) + 2.2, fy(i + 1));
    // door frame trims
    both(i, 'shell', (b) => b.add(M.alu, -0.63, fy(i) + 1.12, CORE.z1 + 0.02, 0.06, 2.24, 0.05).add(M.alu, 0.63, fy(i) + 1.12, CORE.z1 + 0.02, 0.06, 2.24, 0.05).add(M.alu, 0, fy(i) + 2.23, CORE.z1 + 0.02, 1.32, 0.06, 0.05));
  }
  coreBox(SHAFT.x0, SHAFT.x1, SHAFT.z0, CORE.z1, ROOF, coreTop);
  for (const [x, z] of [[-9, -6], [9, -6], [-9, 6], [9, 6]]) {
    const top = ROOF - 0.31;   // stops under the roof (a flush top would show through it)
    shell.add(M.column, x, (BASE + top) / 2, z, 0.6, top - BASE, 0.6, { tile: 4 });
    map.solid(x, (BASE + top) / 2, z, 0.6, top - BASE, 0.6, { body: 'core', proxy: core });
  }
  // ceilings with light panels, slabs with carpet
  const ceilGeo = new THREE.PlaneGeometry(2 * HX, 2 * HZ);
  { const uv = ceilGeo.attributes.uv; for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * 2 * HX / 2.4, uv.getY(i) * 2 * HZ / 2.4); }
  const lampGeo = new THREE.PlaneGeometry(0.6, 1.2);
  const down = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2);
  const one = new THREE.Vector3(1, 1, 1);
  for (let i = 0; i < LEVELS; i++) {
    const cy = fy(i) + CEIL;
    both(i, 'shell', (b) => b.addGeo(M.ceiling, ceilGeo, new THREE.Matrix4().compose(new THREE.Vector3(0, cy, 0), down, one)));
    for (let x = -13.5; x <= 13.5; x += 3) for (let z = -10.5; z <= 10.5; z += 3) {
      if (x > CORE.x0 - 0.8 && x < CORE.x1 + 0.8 && z > CORE.z0 - 0.8 && z < CORE.z1 + 0.8) continue;
      both(i, 'lamps', (b) => b.addGeo(M.lamp, lampGeo, new THREE.Matrix4().compose(new THREE.Vector3(x, cy - 0.004, z), down, one)));
    }
    if (i >= 1) both(i, 'shell', (b) => b.add(M.carpet, 0, fy(i) - 0.15, 0, 2 * HX, 0.3, 2 * HZ, { tile: 2 }));
  }
  // the roof slab
  shell.add(M.roof, 0, ROOF - 0.15, 0, 2 * HX, 0.3, 2 * HZ, { tile: 6 });

  // ---- facade: mullions, spandrel bands, glass ----
  for (let x = -HX; x <= HX + 0.01; x += 4) for (const sz of [-1, 1]) shell.add(M.mullion, x, (BASE + ROOF) / 2, sz * (HZ + 0.06), 0.1, ROOF - BASE, 0.2);
  for (let z = -HZ; z <= HZ + 0.01; z += 4) for (const sx of [-1, 1]) shell.add(M.mullion, sx * (HX + 0.06), (BASE + ROOF) / 2, z, 0.2, ROOF - BASE, 0.1);
  for (let i = 1; i <= LEVELS; i++) {
    const y = fy(i) - 0.3, h = 0.62;
    shell.add(M.spandrel, 0, y, HZ + 0.04, 2 * HX + 0.2, h, 0.06).add(M.spandrel, 0, y, -HZ - 0.04, 2 * HX + 0.2, h, 0.06);
    shell.add(M.spandrel, HX + 0.04, y, 0, 0.06, h, 2 * HZ + 0.2).add(M.spandrel, -HX - 0.04, y, 0, 0.06, h, 2 * HZ + 0.2);
  }
  shell.add(M.granite, 0, 0.3, HZ + 0.05, 2 * HX + 0.3, 0.36, 0.08).add(M.granite, 0, 0.3, -HZ - 0.05, 2 * HX + 0.3, 0.36, 0.08);
  shell.add(M.granite, HX + 0.05, 0.3, 0, 0.08, 0.36, 2 * HZ + 0.3).add(M.granite, -HX - 0.05, 0.3, 0, 0.08, 0.36, 2 * HZ + 0.3);
  const glass = new GlassPanes(map, { material: M.glass, max: LEVELS * 28 + 8 });
  const clusters = [];
  for (let i = 0; i < LEVELS; i++) {
    const cl = map.cluster();
    clusters.push(cl);
    const y = fy(i) + CEIL / 2, opt = { body: `G${i}`, cluster: cl };
    for (let x = -HX + 2; x < HX; x += 4) {
      if (!(i === 0 && Math.abs(x) < 4)) glass.add(x, y, HZ, 3.9, CEIL, 'z', opt);
      glass.add(x, y, -HZ, 3.9, CEIL, 'z', opt);
    }
    for (let z = -HZ + 2; z < HZ; z += 4) { glass.add(HX, y, z, 3.9, CEIL, 'x', opt); glass.add(-HX, y, z, 3.9, CEIL, 'x', opt); }
    // the slab (and the ceiling space under it)
    if (i >= 1) map.solid(0, fy(i) - 0.3, 0, 2 * HX, 0.6, 2 * HZ, { walk: true, body: `L${i}`, proxy: cl });
    map.areas.push({ minX: -HX + 0.4, maxX: HX - 0.4, minZ: -HZ + 0.4, maxZ: HZ - 0.4, minY: fy(i) - 0.3, maxY: fy(i) + CEIL });
  }
  // entrance: fixed glass beside sliding doors, a canopy, the name over it
  glass.add(-3, fy(0) + 1.26, HZ, 1.95, 2.28, 'z', { body: 'G0', cluster: clusters[0] });
  glass.add(3, fy(0) + 1.26, HZ, 1.95, 2.28, 'z', { body: 'G0', cluster: clusters[0] });
  glass.add(0, fy(0) + 2.76, HZ, 7.9, 0.48, 'z', { body: 'G0', cluster: clusters[0] });
  glass.finish();
  shell.add(M.alu, -2.02, BASE + 1.26, HZ + 0.02, 0.08, 2.52, 0.14).add(M.alu, 2.02, BASE + 1.26, HZ + 0.02, 0.08, 2.52, 0.14).add(M.alu, 0, BASE + 2.52, HZ + 0.02, 8.1, 0.08, 0.14);
  shell.add(M.spandrel, 0, BASE + 3.9, HZ + 1.6, 9, 0.24, 3.2).add(M.lamp, 0, BASE + 3.775, HZ + 1.6, 7, 0.01, 0.4);
  map.solid(0, BASE + 3.9, HZ + 1.6, 9, 0.24, 3.2, { body: 'city', proxy: city, surface: 'metal' });
  const nameSign = new THREE.Mesh(new THREE.PlaneGeometry(7, 0.8), new THREE.MeshStandardMaterial({ map: TX.textSign(1024, 118, ['CENTRAL TOWER'], { bg: '#2b3136', stripe: null, font: 'bold 80px sans-serif' }), roughness: 0.5 }));
  nameSign.position.set(0, BASE + 4.42, HZ + 0.12);
  map.add(nameSign);
  const doorGlass = M.glass.clone(); doorGlass.opacity = 0.38;
  const slideL = new THREE.Mesh(new THREE.BoxGeometry(2, 2.4, 0.03), doorGlass), slideR = slideL.clone();
  slideL.position.set(-1, BASE + 1.2, HZ + 0.12); slideR.position.set(1, BASE + 1.2, HZ + 0.12);
  map.add(slideL, { quality: false }); map.add(slideR, { quality: false });
  const edge = new THREE.BoxGeometry(0.05, 2.4, 0.06);
  for (const d of [slideL, slideR]) { const e1 = new THREE.Mesh(edge, M.alu), e2 = new THREE.Mesh(edge, M.alu); e1.position.x = -0.99; e2.position.x = 0.99; d.add(e1, e2); }
  const entrance = {
    t: 0,
    collider: map.addCollider(new THREE.Vector3(-2, BASE, HZ + 0.05), new THREE.Vector3(2, BASE + 2.4, HZ + 0.2)),
    body: map.staticBox([2, 1.2, 0.08], [0, BASE + 1.2, HZ + 0.12]),
  };

  // ---- each floor's furniture (shared geometry, only the floors near you are drawn) ----
  const office = officeKit(M), lobby = lobbyKit(M);
  const officeMeshes = office.batch.build();
  const groups = [];
  for (let i = 0; i < LEVELS; i++) {
    const g = new THREE.Group();
    g.position.y = fy(i);
    const kit = i === 0 ? lobby : office;
    if (i === 0) for (const m of lobby.batch.build()) g.add(m);
    else for (const m of officeMeshes) g.add(m.clone());
    map.add(g);
    groups.push(g);
    for (const [x, y, z, w, h, d, o] of kit.solids) map.solid(x, fy(i) + y, z, w, h, d, { body: `L${i}`, proxy: clusters[i], ...o });
  }
  // lobby floor (polished stone: the reflective floor on Ultra)
  const stoneGeo = new THREE.PlaneGeometry(2 * HX, 2 * HZ);
  { const uv = stoneGeo.attributes.uv; for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * HX, uv.getY(i) * HZ); }
  const lobbyFloor = new THREE.Mesh(stoneGeo, M.stone);
  lobbyFloor.rotation.x = -Math.PI / 2; lobbyFloor.position.y = 0.0025; lobbyFloor.receiveShadow = true;
  map.add(lobbyFloor); groups[0].add(lobbyFloor);
  map.floor = lobbyFloor;
  // lobby signs
  const wallSign = new THREE.Mesh(new THREE.PlaneGeometry(2.1, 0.9), new THREE.MeshStandardMaterial({ map: TX.textSign(512, 220, ['CENTRAL TOWER', 'Lifts to floors 1 - 20'], { bg: '#2b3136' }), roughness: 0.5 }));
  wallSign.position.set(-2.35, 1.9, CORE.z1 + 0.01);
  map.add(wallSign); groups[0].add(wallSign);

  // floor number signs beside every elevator door (one mesh, cells of an atlas)
  const atlas = new THREE.MeshStandardMaterial({ map: TX.floorSignAtlas(LABELS), roughness: 0.5 });
  const signs = [];
  for (let i = 1; i < LEVELS; i++) {
    const g = new THREE.PlaneGeometry(0.8, 0.53);
    const cx = i % 6, cy = Math.floor(i / 6), uv = g.attributes.uv;
    for (let k = 0; k < uv.count; k++) uv.setXY(k, (cx + uv.getX(k)) / 6, 1 - (cy + 1 - uv.getY(k)) / 4);
    signs.push({ geo: g, matrix: boxMatrix(-2.35, fy(i) + 1.75, CORE.z1 + 0.01) });
  }
  const signMesh = new THREE.Mesh(mergeGeometries(signs), atlas);
  map.add(signMesh);

  // ---- roof ----
  const roofCl = map.cluster();
  map.solid(0, ROOF - 0.3, 0, 2 * HX, 0.6, 2 * HZ, { walk: true, body: 'roof', proxy: roofCl });
  map.areas.push({ minX: -HX + 0.6, maxX: HX - 0.6, minZ: -HZ + 0.6, maxZ: HZ - 0.6, minY: ROOF - 0.3, maxY: ROOF + 8 });
  const par = (x, z, w, d) => { shell.add(M.machine, x, ROOF + 0.55, z, w, 1.1, d, { tile: 4 }).add(M.alu, x, ROOF + 1.12, z, w + 0.04, 0.04, d + 0.04); map.solid(x, ROOF + 0.55, z, w, 1.1, d, { body: 'roof', proxy: roofCl }); };
  par(0, -HZ + 0.15, 2 * HX, 0.3); par(0, HZ - 0.15, 2 * HX, 0.3); par(-HX + 0.15, 0, 0.3, 2 * HZ - 0.6); par(HX - 0.15, 0, 0.3, 2 * HZ - 0.6);
  // machine room over the core (its walls are the core), a door, the antenna
  shell.add(M.machine, CORE.x0 - 0.01, ROOF + 1.6, (CORE.z0 + CORE.z1) / 2, 0.02, 3.2, CORE.z1 - CORE.z0, { tile: 4 });
  shell.add(M.metal, 0, ROOF + 1.05, CORE.z1 + 0.02, 0.95, 2.1, 0.05).add(M.alu, 0, coreTop + 0.06, (CORE.z0 + CORE.z1) / 2, 7.1, 0.12, 5.5);
  shell.addGeo(M.metal, CYL8, cyl(2.4, coreTop + 7, -3.3, 0.12, 14)).addGeo(M.metal, CYL8, cyl(-2.4, coreTop + 3, -3.3, 0.05, 6));
  const beacon = new THREE.Mesh(new THREE.SphereGeometry(0.18, 12, 8), M.redLamp);
  beacon.position.set(2.4, coreTop + 14.1, -3.3);
  map.add(beacon, { quality: false });
  // HVAC units
  for (const z of [-8.4, -4.9]) {
    shell.add(M.hvac, 10.5, ROOF + 0.9, z, 3, 1.8, 2.6);
    shell.addGeo(M.black, CYL, cyl(9.8, ROOF + 1.82, z, 0.6, 0.05)).addGeo(M.black, CYL, cyl(11.2, ROOF + 1.82, z, 0.6, 0.05));
    map.solid(10.5, ROOF + 0.9, z, 3, 1.8, 2.6, { body: 'roof', proxy: roofCl, surface: 'metal', walk: true });
  }
  shell.add(M.hvac, 7.5, ROOF + 0.4, -6.65, 3, 0.5, 0.5);
  map.solid(7.5, ROOF + 0.4, -6.65, 3, 0.5, 0.5, { body: 'roof', proxy: roofCl, surface: 'metal', walk: true });
  // helipad
  shell.add(M.granite, -8.5, ROOF + 0.12, 5.5, 10, 0.24, 10);
  map.solid(-8.5, ROOF + 0.12, 5.5, 10, 0.24, 10, { body: 'roof', proxy: roofCl, walk: true });
  const pad = new THREE.Mesh(new THREE.PlaneGeometry(9.4, 9.4), new THREE.MeshStandardMaterial({ map: TX.helipad(), roughness: 0.8 }));
  pad.rotation.x = -Math.PI / 2; pad.position.set(-8.5, ROOF + 0.245, 5.5); pad.receiveShadow = true;
  map.add(pad);
  for (let a = 0; a < 8; a++) { const x = -8.5 + Math.cos(a * Math.PI / 4) * 4.9, z = 5.5 + Math.sin(a * Math.PI / 4) * 4.9; shell.add(M.greenLamp, x, ROOF + 0.28, z, 0.12, 0.06, 0.12); }

  for (const m of shell.build()) map.add(m);
  // the floors' own surfaces: per floor, and all floors merged (see above)
  const group = (b) => {
    const g = new THREE.Group();
    map.add(g);
    for (const m of b.shell.build()) g.add(map.add(m));
    for (const m of b.lamps.build({ castShadow: false, receiveShadow: false })) g.add(map.add(m, { quality: false }));
    return g;
  };
  const interiors = inner.map(group);
  const exterior = group(outer);

  // ---- the elevator ----
  const elevator = new Elevator(map, { levels: LEVELS, floorY: fy, labels: LABELS, shaft: SHAFT, doorZ: DOOR_Z, materials: M });

  // ---- the ladder to the roof (top floor) and the hatch on the roof ----
  const top = LEVELS - 1, ty = fy(top);
  const ladderItems = [];
  for (const dz of [-0.22, 0.22]) ladderItems.push({ geo: new THREE.BoxGeometry(0.05, CEIL, 0.05), matrix: boxMatrix(LADDER.x + 0.05, CEIL / 2, LADDER.z + dz) });
  for (let y = 0.28; y < CEIL - 0.1; y += 0.28) ladderItems.push({ geo: new THREE.BoxGeometry(0.035, 0.035, 0.44), matrix: boxMatrix(LADDER.x + 0.05, y, LADDER.z) });
  const ladder = new THREE.Mesh(mergeGeometries(ladderItems), M.rail);
  ladder.castShadow = true;
  map.add(ladder);
  const hatchIn = new THREE.Mesh(new THREE.BoxGeometry(0.95, 0.04, 0.95), M.metal);
  hatchIn.position.set(LADDER.x + 0.45, CEIL - 0.02, LADDER.z);
  map.add(hatchIn);
  const accessSign = new THREE.Mesh(new THREE.PlaneGeometry(0.7, 0.35), new THREE.MeshStandardMaterial({ map: TX.textSign(256, 128, ['ROOF', 'ACCESS'], { font: 'bold 46px sans-serif' }), roughness: 0.5 }));
  accessSign.position.set(CORE.x1 + 0.01, 1.9, LADDER.z + 0.8); accessSign.rotation.y = Math.PI / 2;
  map.add(accessSign);
  groups[top].add(ladder); groups[top].add(hatchIn); groups[top].add(accessSign);
  map.addCollider(new THREE.Vector3(CORE.x1, ty, LADDER.z - 0.27), new THREE.Vector3(LADDER.x + 0.1, ty + CEIL, LADDER.z + 0.27));
  // roof hatch: a raised box with a lid
  const hatchBox = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.5, 1.2), M.machine);
  hatchBox.position.set(HATCH.x, ROOF + 0.25, HATCH.z);
  const lid = new THREE.Mesh(new THREE.BoxGeometry(1.26, 0.06, 1.26), M.metal);
  lid.position.set(HATCH.x, ROOF + 0.53, HATCH.z);
  hatchBox.castShadow = lid.castShadow = true;
  map.add(hatchBox); map.add(lid);
  const hatchSolid = map.solid(HATCH.x, ROOF + 0.28, HATCH.z, 1.26, 0.56, 1.26, { body: 'roof', proxy: roofCl, surface: 'metal', walk: true });
  // a handle on the lid and a stencilled sign on the side you come out on, so the way down is easy to spot
  const handle = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.05, 0.42), M.rail);
  handle.position.set(HATCH.x + 0.42, ROOF + 0.585, HATCH.z);
  map.add(handle);
  const downSign = new THREE.Mesh(new THREE.PlaneGeometry(0.9, 0.3), new THREE.MeshStandardMaterial({ map: TX.textSign(256, 86, ['LADDER DOWN'], { font: 'bold 34px sans-serif' }), roughness: 0.5 }));
  downSign.position.set(HATCH.x + 0.605, ROOF + 0.27, HATCH.z); downSign.rotation.y = Math.PI / 2;
  map.add(downSign);
  // the rungs have gaps a look ray slips through: an invisible box around the ladder takes the look
  const ladderHit = new THREE.Mesh(new THREE.BoxGeometry(0.14, CEIL, 0.56), new THREE.MeshBasicMaterial({ visible: false }));
  ladderHit.position.set(LADDER.x + 0.06, CEIL / 2, LADDER.z);
  groups[top].add(ladderHit);
  // the hatch's invisible collision box is what the look ray hits first, so it carries the climb down too
  const climber = new LadderClimb(map, { ladder: ladderHit, hatch: [hatchBox, lid, handle, downSign, hatchSolid.proxy], lid, bottomY: ty });
  map.interactables.push(climber.up, climber.down);

  // ---- culling: only draw what can be seen from where the camera is ----
  // Inside the tower the slabs hide every other floor, so only the floor you're on is drawn (its
  // surfaces, furniture, elevator doors and the ragdolls on it). Outside, the floors show through
  // the glass: the merged surfaces of all floors, plus the furniture at your eye height. On the
  // roof nothing inside the tower can be seen.
  const view = { inside: false, roof: false, level: 0 };
  const shown = new Array(LEVELS).fill(null);
  map.view = view;
  const inTower = (p, pad = 0) => Math.abs(p.x) < HX + pad && Math.abs(p.z) < HZ + pad && p.y > BASE - 0.4 && p.y < ROOF - 0.3;
  const levelAt = (y) => Math.max(0, Math.min(LEVELS - 1, Math.floor((y - BASE) / FH)));
  map.cullers.push((cam, ctx) => {
    const inside = inTower(cam, 0.05), roof = !inside && cam.y >= ROOF - 0.3, k = levelAt(cam.y);
    view.inside = inside; view.roof = roof; view.level = k;
    exterior.visible = !inside && !roof;
    for (let i = 0; i < LEVELS; i++) {
      interiors[i].visible = inside && i === k;
      const v = inside ? i === k : !roof && Math.abs(i - k) <= 1;
      if (v !== shown[i]) { shown[i] = v; groups[i].visible = v; }
    }
    elevator.showLevels(shown);
    // ragdolls on other floors of the tower (all of them while the X-ray is open)
    const xray = ctx?.hud?.xrayOpen;
    for (const r of ctx?.ragdolls?.list || []) {
      if (r.hidden || r.removed) continue;
      const p = r.parts.pelvis.body.position;
      let v = true;
      if (!xray && inTower(p)) v = inside ? levelAt(p.y) === k : !roof;
      if (r.root.visible !== v) r.root.visible = v;
    }
  });
  map.onUnload = () => { for (const r of map.ctx?.ragdolls?.list || []) if (!r.hidden) r.root.visible = true; };
  /** Whether something at p shows from where the camera is now (multiplayer: other players on other floors). */
  map.seen = (p) => {
    if (inTower(p)) return view.inside ? levelAt(p.y) === view.level : !view.roof;
    return true;
  };

  // ---- moving parts ----
  map.updaters.push((dt, focus, ctx) => {
    // sliding doors at the entrance open for you and for ragdolls walking up to them
    let want = false;
    if (ctx?.player) { const p = ctx.player.pos; want = Math.abs(p.x) < 3.2 && Math.abs(p.z - HZ) < 2.8 && p.y < BASE + 2; }
    if (!want) for (const r of ctx?.ragdolls?.list || []) { if (r.hidden) continue; const p = r.parts.pelvis.body.position; if (Math.abs(p.x) < 2.6 && Math.abs(p.z - HZ) < 2 && p.y < 3) { want = true; break; } }
    const prev = entrance.t;
    entrance.t = Math.max(0, Math.min(1, entrance.t + (want ? dt : -dt) * 1.6));
    if ((prev === 0 && entrance.t > 0) || (prev === 1 && entrance.t < 1)) ctx?.audio?.play('slideDoor');
    const e = entrance.t * entrance.t * (3 - 2 * entrance.t);
    slideL.position.x = -1 - e * 1.95; slideR.position.x = 1 + e * 1.95;
    const open = entrance.t > 0.6;
    entrance.collider.off = open;
    entrance.body.collisionFilterMask = open ? 0 : GROUP.RAGDOLL | GROUP.DEBRIS;
    glass.update(dt);
  });
  map.glass = glass;
  map.elevator = elevator;
  map.levelOf = levelOf;
  map.onCleanUp = () => glass.repair();
  map.onBlast = (c) => glass.blast(c, 4.5);
}

/** Climbing the ladder on the top floor up through the hatch, and back down. */
class LadderClimb {
  constructor(map, { ladder, hatch, lid, bottomY }) {
    this.map = map; this.lid = lid; this.bottomY = bottomY;
    this.up = { meshes: [ladder], prompt: 'Climb to the roof', press: () => this.climbUp() };
    this.down = { meshes: hatch, prompt: 'Climb down the ladder', press: () => this.climbDown() };
    ladder.userData.interact = this.up;
    for (const m of hatch) m.userData.interact = this.down;
  }

  /** Move the player (and whatever the grab tool holds) by an offset. */
  carry(ctx, dx, dy, dz) {
    const p = ctx.player;
    p.pos.x += dx; p.pos.y += dy; p.pos.z += dz;
    const held = ctx.grab?.held;
    if (held?.kind === 'ragdoll') held.ragdoll.translate(dx, dy, dz);
    else if (held?.kind === 'gib') { const b = held.body.position; b.x += dx; b.y += dy; b.z += dz; }
  }

  climbUp() {
    const ctx = this.map.ctx; if (!ctx) return;
    const p = ctx.player, y0 = this.bottomY, sx = LADDER.x + 0.5, sz = LADDER.z;
    const from = p.pos.clone();
    let rung = 0;
    p.play((t) => {
      if (t < 0.4) {
        const u = t / 0.4;
        this.carry(ctx, (from.x + (sx - from.x) * u) - p.pos.x, 0, (from.z + (sz - from.z) * u) - p.pos.z);
        p.targetYaw += wrap(Math.PI / 2 - p.targetYaw) * 0.2;   // turn to face the ladder
        return false;
      }
      if (t < 2.2) {
        const u = (t - 0.4) / 1.8;
        this.carry(ctx, 0, y0 + u * 1.3 - p.pos.y, 0);
        if (Math.floor(u * 7) > rung) { rung = Math.floor(u * 7); ctx.audio?.play('ladder'); p.landSpring.kick(-0.012); }
        return false;
      }
      // out through the hatch onto the roof, next to it, facing back towards it once you've stepped out
      ctx.audio?.play('hatch');
      this.carry(ctx, HATCH.x + 1.1 - p.pos.x, ROOF - p.pos.y, HATCH.z - p.pos.z);
      p.landSpring.kick(-0.05);
      if (!this.hinted) { this.hinted = true; ctx.hud?.toast('Look at the hatch and press E to climb back down'); }
      return true;
    });
  }

  climbDown() {
    const ctx = this.map.ctx; if (!ctx) return;
    const p = ctx.player, y0 = this.bottomY, sx = LADDER.x + 0.5, sz = LADDER.z;
    ctx.audio?.play('hatch');
    this.carry(ctx, sx - p.pos.x, y0 + 1.3 - p.pos.y, sz - p.pos.z);
    p.targetYaw = Math.PI / 2; p.yaw = Math.PI / 2;
    let rung = 0;
    p.play((t) => {
      const u = Math.min(1, t / 1.5);
      this.carry(ctx, 0, y0 + (1 - u) * 1.3 - p.pos.y, 0);
      if (Math.floor(u * 6) > rung) { rung = Math.floor(u * 6); ctx.audio?.play('ladder'); }
      if (u >= 1) { this.carry(ctx, 0.35, 0, 0); return true; }
      return false;
    });
  }
}

const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));

export const TOWER = {
  id: 'tower',
  name: 'Skyscraper',
  desc: 'A city block with a 20-floor office tower. Take the elevator to any floor; the ladder on floor 20 goes up to the roof.',
  sky: 0xaebfcc,
  fog: [70, 520],
  far: 900,
  bounds: { minX: -38, maxX: 38, minZ: -34, maxZ: 34 },
  wallHeight: 130,
  fill: 0.55,
  hemi: 0.75,
  sun: 2.0,
  playerSpawn: { pos: [0, BASE, 16.8], yaw: 0 },
  ragdollSpawn: { pos: [3.6, BASE, 14.6], yaw: 0 },
  buttons: [{ pos: [-4.2, BASE, 15.4], yaw: 0 }, { pos: [-5.4, BASE, 15.4], yaw: 0 }],
  build(map) { buildTower(map); },
};
