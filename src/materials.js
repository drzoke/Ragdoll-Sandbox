import * as THREE from 'three';
import { canvasTexture } from './core/util.js';

/**
 * Material detail that scales with the graphics preset.
 *  low       – flatter look, weaker reflections
 *  medium    – materials as authored
 *  high      – grime / wear (roughness variation, light dirt), stronger environment reflections
 *  ultra     – high + fine surface detail (normal maps) and the strongest reflections
 * Every material passed to track() follows the current preset.
 */
const tracked = new Map(); // material -> original values
let level = 'medium';
let tex = null;

function noiseCanvas(size, draw) { return canvasTexture(size, size, draw, { repeat: true, srgb: false }); }

function makeTextures() {
  const rnd = (a, b) => a + Math.random() * (b - a);
  // light grime: mostly white (no change) with soft darker smudges and specks
  const grime = canvasTexture(256, 256, (g, w, h) => {
    g.fillStyle = '#fff'; g.fillRect(0, 0, w, h);
    for (let i = 0; i < 45; i++) {
      const x = rnd(0, w), y = rnd(0, h), r = rnd(10, 45);
      const grd = g.createRadialGradient(x, y, 0, x, y, r);
      const v = Math.round(rnd(200, 230));
      grd.addColorStop(0, `rgba(${v},${v - 3},${v - 8},0.4)`); grd.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = grd; g.fillRect(x - r, y - r, r * 2, r * 2);
    }
    for (let i = 0; i < 260; i++) { const v = Math.round(rnd(150, 210)); g.fillStyle = `rgba(${v},${v},${v},${rnd(0.1, 0.3)})`; g.fillRect(rnd(0, w), rnd(0, h), rnd(1, 2.5), rnd(1, 2.5)); }
  }, { repeat: true });
  // roughness variation for non-metals (multiplies roughness: 0.75..1)
  const rough = noiseCanvas(256, (g, w, h) => {
    g.fillStyle = 'rgb(225,225,225)'; g.fillRect(0, 0, w, h);
    for (let i = 0; i < 160; i++) {
      const x = rnd(0, w), y = rnd(0, h), r = rnd(6, 34), v = Math.round(rnd(190, 255));
      const grd = g.createRadialGradient(x, y, 0, x, y, r);
      grd.addColorStop(0, `rgba(${v},${v},${v},0.6)`); grd.addColorStop(1, `rgba(${v},${v},${v},0)`);
      g.fillStyle = grd; g.fillRect(x - r, y - r, r * 2, r * 2);
    }
  });
  // worn metal: fine scratches and polished patches (darker = shinier)
  const wear = noiseCanvas(256, (g, w, h) => {
    g.fillStyle = 'rgb(235,235,235)'; g.fillRect(0, 0, w, h);
    for (let i = 0; i < 40; i++) {
      const x = rnd(0, w), y = rnd(0, h), r = rnd(10, 40);
      const grd = g.createRadialGradient(x, y, 0, x, y, r);
      grd.addColorStop(0, 'rgba(150,150,150,0.5)'); grd.addColorStop(1, 'rgba(150,150,150,0)');
      g.fillStyle = grd; g.fillRect(x - r, y - r, r * 2, r * 2);
    }
    g.lineCap = 'round';
    for (let i = 0; i < 260; i++) {
      const x = rnd(0, w), y = rnd(0, h), a = rnd(-0.4, 0.4) + (Math.random() < 0.5 ? 0 : Math.PI / 2), l = rnd(4, 26);
      const v = Math.round(rnd(70, 160));
      g.strokeStyle = `rgba(${v},${v},${v},${rnd(0.3, 0.8)})`; g.lineWidth = rnd(0.5, 1.4);
      g.beginPath(); g.moveTo(x, y); g.lineTo(x + Math.cos(a) * l, y + Math.sin(a) * l); g.stroke();
    }
  });
  // fine surface detail: a height field turned into a tangent-space normal map
  const size = 256, height = new Float32Array(size * size);
  for (let o = 0; o < 4; o++) {
    const cells = 4 << o, amp = 1 / (1 + o * 1.3);
    const grid = Array.from({ length: (cells + 1) * (cells + 1) }, () => Math.random());
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      const gx = (x / size) * cells, gy = (y / size) * cells, ix = gx | 0, iy = gy | 0, fx = gx - ix, fy = gy - iy;
      const at = (i, j) => grid[((j % cells) * (cells + 1)) + (i % cells)];
      const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
      const v = (at(ix, iy) * (1 - sx) + at(ix + 1, iy) * sx) * (1 - sy) + (at(ix, iy + 1) * (1 - sx) + at(ix + 1, iy + 1) * sx) * sy;
      height[y * size + x] += v * amp;
    }
  }
  for (let i = 0; i < height.length; i++) height[i] += (Math.random() - 0.5) * 0.08; // pores
  const normal = noiseCanvas(size, (g) => {
    const img = g.createImageData(size, size);
    const H = (x, y) => height[((y + size) % size) * size + ((x + size) % size)];
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      const dx = (H(x + 1, y) - H(x - 1, y)) * 2.2, dy = (H(x, y + 1) - H(x, y - 1)) * 2.2;
      const l = Math.hypot(dx, dy, 1), i = (y * size + x) * 4;
      img.data[i] = (-dx / l * 0.5 + 0.5) * 255; img.data[i + 1] = (dy / l * 0.5 + 0.5) * 255; img.data[i + 2] = (1 / l * 0.5 + 0.5) * 255; img.data[i + 3] = 255;
    }
    g.putImageData(img, 0, 0);
  });
  for (const t of [grime, rough, wear, normal]) t.repeat.set(2, 2);
  return { grime, rough, wear, normal };
}

/** Track every standard material in an object tree (or a single material). */
export function trackMaterials(target, { grime = true } = {}) {
  const mats = [];
  if (target.isMaterial) mats.push(target);
  else target.traverse((o) => { if (o.material) mats.push(...[].concat(o.material)); });
  for (const m of mats) {
    if (!m.isMeshStandardMaterial || tracked.has(m) || m.userData.noQuality) continue;
    tracked.set(m, { map: m.map, roughnessMap: m.roughnessMap, normalMap: m.normalMap, envMapIntensity: m.envMapIntensity, grime });
    applyTo(m);
  }
}

function applyTo(m) {
  const o = tracked.get(m);
  const metal = m.metalness > 0.5, glowing = m.emissiveIntensity > 0 && m.emissive && m.emissive.getHex() !== 0;
  let map = o.map, rough = o.roughnessMap, normal = o.normalMap, env = o.envMapIntensity;
  if (level === 'low') env = o.envMapIntensity * 0.5;
  if (level === 'high' || level === 'ultra') {
    tex ??= makeTextures();
    rough = rough || (metal ? tex.wear : tex.rough);
    if (!map && o.grime && !glowing && !metal) map = tex.grime;
    env = o.envMapIntensity * (level === 'ultra' ? 1.35 : 1.15);
  }
  if (level === 'ultra') {
    normal = normal || tex.normal;
    m.normalScale.set(metal ? 0.18 : 0.35, metal ? 0.18 : 0.35);
  }
  const changed = m.map !== map || m.roughnessMap !== rough || m.normalMap !== normal;
  m.map = map; m.roughnessMap = rough; m.normalMap = normal; m.envMapIntensity = env;
  if (changed) m.needsUpdate = true;
}

export function setMaterialQuality(l) {
  level = l;
  for (const m of tracked.keys()) applyTo(m);
}
