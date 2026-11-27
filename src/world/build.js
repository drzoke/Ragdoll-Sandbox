import * as THREE from 'three';
import { canvasTexture } from '../core/util.js';

// Shared helpers for building maps: textures and a small geometry merger.

/** Prototype-style concrete grid texture: one texture tile = 4 m x 4 m. */
export function makeGridTexture(base = '#7f8285', line = 'rgba(40,44,48,0.32)', major = 'rgba(30,33,36,0.55)') {
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

/** Speckled noise texture (concrete, asphalt, carpet...): base colour plus random specks. */
export function noiseTexture(size, base, { specks = 0.5, spread = 18, blotches = 30, blotchAlpha = 0.06, lines = null } = {}) {
  return canvasTexture(size, size, (g, w, h) => {
    g.fillStyle = base; g.fillRect(0, 0, w, h);
    const img = g.getImageData(0, 0, w, h), d = img.data;
    for (let i = 0; i < d.length; i += 4) {
      if (Math.random() > specks) continue;
      const n = (Math.random() - 0.5) * spread;
      d[i] += n; d[i + 1] += n; d[i + 2] += n;
    }
    g.putImageData(img, 0, 0);
    for (let i = 0; i < blotches; i++) {
      const x = Math.random() * w, y = Math.random() * h, r = w * (0.03 + Math.random() * 0.1);
      const gr = g.createRadialGradient(x, y, 0, x, y, r);
      const a = Math.random() * blotchAlpha;
      gr.addColorStop(0, Math.random() < 0.6 ? `rgba(0,0,0,${a})` : `rgba(255,255,255,${a})`);
      gr.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = gr; g.fillRect(x - r, y - r, r * 2, r * 2);
    }
    lines?.(g, w, h);
  }, { repeat: true });
}

const _m = new THREE.Matrix4(), _n = new THREE.Matrix3(), _v = new THREE.Vector3();

/**
 * Merge many (geometry, matrix) pairs into one BufferGeometry (position, normal, uv), so a pile
 * of static boxes is one draw call. Geometries may be indexed or not.
 */
export function mergeGeometries(items) {
  let vCount = 0, iCount = 0;
  for (const { geo } of items) { vCount += geo.attributes.position.count; iCount += geo.index ? geo.index.count : geo.attributes.position.count; }
  const pos = new Float32Array(vCount * 3), nor = new Float32Array(vCount * 3), uv = new Float32Array(vCount * 2);
  const idx = vCount > 65535 ? new Uint32Array(iCount) : new Uint16Array(iCount);
  let vo = 0, io = 0;
  for (const { geo, matrix, uvScale } of items) {
    const P = geo.attributes.position, N = geo.attributes.normal, U = geo.attributes.uv;
    _m.copy(matrix || _m.identity());
    if (!matrix) _m.identity();
    _n.getNormalMatrix(_m);
    for (let i = 0; i < P.count; i++) {
      _v.fromBufferAttribute(P, i).applyMatrix4(_m);
      pos[(vo + i) * 3] = _v.x; pos[(vo + i) * 3 + 1] = _v.y; pos[(vo + i) * 3 + 2] = _v.z;
      if (N) { _v.fromBufferAttribute(N, i).applyMatrix3(_n).normalize(); nor[(vo + i) * 3] = _v.x; nor[(vo + i) * 3 + 1] = _v.y; nor[(vo + i) * 3 + 2] = _v.z; }
      if (U) { uv[(vo + i) * 2] = U.getX(i) * (uvScale ? uvScale[0] : 1); uv[(vo + i) * 2 + 1] = U.getY(i) * (uvScale ? uvScale[1] : 1); }
    }
    if (geo.index) for (let i = 0; i < geo.index.count; i++) idx[io + i] = geo.index.getX(i) + vo;
    else for (let i = 0; i < P.count; i++) idx[io + i] = i + vo;
    vo += P.count; io += geo.index ? geo.index.count : P.count;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  out.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  out.setIndex(new THREE.BufferAttribute(idx, 1));
  out.computeBoundingSphere(); out.computeBoundingBox();
  return out;
}

/**
 * Box with UVs in metres (u along the box's longest horizontal side, v up), so a tiling texture
 * keeps its scale on boxes of any size. tile = metres per texture repeat.
 */
export function worldBox(w, h, d, tile = 4) {
  const geo = new THREE.BoxGeometry(w, h, d);
  const uv = geo.attributes.uv, n = geo.attributes.normal;
  for (let i = 0; i < uv.count; i++) {
    const nx = Math.abs(n.getX(i)), ny = Math.abs(n.getY(i));
    // face size in metres: X faces are d x h, Y faces are w x d, Z faces are w x h
    const [fu, fv] = nx > 0.5 ? [d, h] : ny > 0.5 ? [w, d] : [w, h];
    uv.setXY(i, uv.getX(i) * fu / tile, uv.getY(i) * fv / tile);
  }
  return geo;
}

/** Matrix for a box of size (w, h, d) centred at (x, y, z), optionally turned by yaw. */
export function boxMatrix(x, y, z, w = 1, h = 1, d = 1, yaw = 0) {
  return new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw), new THREE.Vector3(w, h, d));
}

/**
 * Collects many boxes per material and turns them into one merged mesh per material.
 * add(material, x, y, z, w, h, d) with the box centre and size in metres.
 */
export class BoxBatch {
  constructor() { this.groups = new Map(); }
  add(mat, x, y, z, w, h, d, { yaw = 0, tile = 0, geo = null } = {}) {
    if (!this.groups.has(mat)) this.groups.set(mat, []);
    const g = geo || (tile ? worldBox(w, h, d, tile) : UNIT_BOX);
    const m = geo || tile ? boxMatrix(x, y, z, 1, 1, 1, yaw) : boxMatrix(x, y, z, w, h, d, yaw);
    this.groups.get(mat).push({ geo: g, matrix: m });
    return this;
  }
  addGeo(mat, geo, matrix) { if (!this.groups.has(mat)) this.groups.set(mat, []); this.groups.get(mat).push({ geo, matrix }); return this; }
  /** noShadow: materials of flat things (paint, paving) that would only waste the shadow pass. */
  build({ castShadow = true, receiveShadow = true, noShadow = null } = {}) {
    const meshes = [];
    for (const [mat, items] of this.groups) {
      // split very big batches so the index buffer stays reasonable
      for (let s = 0; s < items.length; s += 4000) {
        const mesh = new THREE.Mesh(mergeGeometries(items.slice(s, s + 4000)), mat);
        mesh.castShadow = castShadow && !noShadow?.includes(mat); mesh.receiveShadow = receiveShadow;
        meshes.push(mesh);
      }
    }
    return meshes;
  }
}
const UNIT_BOX = new THREE.BoxGeometry(1, 1, 1);
