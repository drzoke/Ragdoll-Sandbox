import * as THREE from 'three';
import { canvasTexture, rand } from '../core/util.js';
import { batch, fxMaterial } from '../ragdoll/batcher.js';

// ---------------------------------------------------------------- textures
function blobTexture(irregular = 1) {
  return canvasTexture(256, 256, (g, w, h) => {
    g.translate(w / 2, h / 2);
    const lobes = 9 + ((Math.random() * 6) | 0);
    const base = w * 0.3;
    // main blob
    g.beginPath();
    for (let i = 0; i <= 64; i++) {
      const a = (i / 64) * Math.PI * 2;
      let r = base;
      for (let k = 1; k <= 3; k++) r += Math.sin(a * (lobes / k) + k * 1.7) * base * 0.07 * irregular;
      const x = Math.cos(a) * r, y = Math.sin(a) * r;
      i ? g.lineTo(x, y) : g.moveTo(x, y);
    }
    const grd = g.createRadialGradient(0, 0, 0, 0, 0, base * 1.2);
    grd.addColorStop(0, 'rgba(255,255,255,1)'); grd.addColorStop(0.85, 'rgba(235,235,235,1)'); grd.addColorStop(1, 'rgba(255,255,255,0.8)');
    g.fillStyle = grd; g.fill();
    // satellite droplets
    for (let i = 0; i < 18 * irregular; i++) {
      const a = Math.random() * Math.PI * 2, d = base * (1.0 + Math.random() * 0.55), r = 2 + Math.random() * 7;
      g.beginPath(); g.arc(Math.cos(a) * d, Math.sin(a) * d, r, 0, Math.PI * 2); g.fill();
    }
  }, { srgb: false });
}

function woundTexture(exit) {
  return canvasTexture(128, 128, (g, w, h) => {
    g.translate(w / 2, h / 2);
    const R = w * 0.46;
    // bruise/blood ring
    let grd = g.createRadialGradient(0, 0, 0, 0, 0, R);
    grd.addColorStop(0, 'rgba(20,20,20,1)'); grd.addColorStop(exit ? 0.35 : 0.22, 'rgba(40,40,40,1)');
    grd.addColorStop(exit ? 0.55 : 0.4, 'rgba(120,120,120,0.95)'); grd.addColorStop(0.8, 'rgba(110,110,110,0.45)'); grd.addColorStop(1, 'rgba(100,100,100,0)');
    g.fillStyle = grd; g.beginPath();
    for (let i = 0; i <= 40; i++) {
      const a = (i / 40) * Math.PI * 2, r = R * (exit ? 0.75 + Math.random() * 0.25 : 0.9 + Math.random() * 0.1);
      i ? g.lineTo(Math.cos(a) * r, Math.sin(a) * r) : g.moveTo(Math.cos(a) * r, Math.sin(a) * r);
    }
    g.fill();
    // hole
    g.fillStyle = '#080808'; g.beginPath(); g.arc(0, 0, exit ? R * 0.28 : R * 0.16, 0, Math.PI * 2); g.fill();
  });
}

function stainTexture() {
  return canvasTexture(128, 256, (g, w, h) => {
    // a run of blood downward from the top-centre
    const grd = g.createLinearGradient(0, 0, 0, h);
    grd.addColorStop(0, 'rgba(110,110,110,0.9)'); grd.addColorStop(0.7, 'rgba(90,90,90,0.6)'); grd.addColorStop(1, 'rgba(90,90,90,0)');
    g.fillStyle = grd;
    for (let i = 0; i < 5; i++) {
      const x = w / 2 + (Math.random() - 0.5) * w * 0.5, ww = 6 + Math.random() * 12, len = h * (0.4 + Math.random() * 0.6);
      g.beginPath(); g.ellipse(x, len / 2, ww / 2, len / 2, 0, 0, Math.PI * 2); g.fill();
    }
    const r = g.createRadialGradient(w / 2, h * 0.12, 0, w / 2, h * 0.12, w * 0.45);
    r.addColorStop(0, 'rgba(110,110,110,0.9)'); r.addColorStop(1, 'rgba(110,110,110,0)');
    g.fillStyle = r; g.fillRect(0, 0, w, h);
  });
}

function holeTexture() {
  return canvasTexture(64, 64, (g, w, h) => {
    const grd = g.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2);
    grd.addColorStop(0, 'rgba(10,10,10,1)'); grd.addColorStop(0.25, 'rgba(25,25,25,1)'); grd.addColorStop(0.45, 'rgba(60,60,60,0.7)'); grd.addColorStop(1, 'rgba(80,80,80,0)');
    g.fillStyle = grd; g.fillRect(0, 0, w, h);
  });
}

/** Directional spatter: a blob on the left with streaks and droplets thrown towards +X. */
function spatterTexture() {
  return canvasTexture(256, 128, (g, w, h) => {
    g.fillStyle = '#fff';
    const cx = w * 0.3, cy = h / 2, R = h * 0.26;
    g.beginPath();
    for (let i = 0; i <= 48; i++) {
      const a = (i / 48) * Math.PI * 2;
      const r = R * (0.85 + Math.sin(a * 7 + 1.3) * 0.08 + Math.random() * 0.1) * (Math.cos(a) > 0 ? 1 + Math.cos(a) * 0.35 : 1);
      const x = cx + Math.cos(a) * r, y = cy + Math.sin(a) * r * 0.9;
      i ? g.lineTo(x, y) : g.moveTo(x, y);
    }
    g.fill();
    // tapered streaks fanning out to the right
    for (let i = 0; i < 9; i++) {
      const a = (Math.random() - 0.5) * 0.9, len = w * (0.25 + Math.random() * 0.4), wd = 2 + Math.random() * 6;
      const x0 = cx + R * 0.6, y0 = cy + Math.sin(a) * R * 0.6;
      const x1 = x0 + Math.cos(a) * len, y1 = y0 + Math.sin(a) * len;
      g.beginPath(); g.moveTo(x0, y0 - wd); g.quadraticCurveTo((x0 + x1) / 2, (y0 + y1) / 2 - wd * 0.4, x1, y1); g.quadraticCurveTo((x0 + x1) / 2, (y0 + y1) / 2 + wd * 0.4, x0, y0 + wd); g.fill();
      g.beginPath(); g.arc(x1, y1, wd * 0.45, 0, Math.PI * 2); g.fill();
    }
    // droplets in a cone
    for (let i = 0; i < 40; i++) {
      const a = (Math.random() - 0.5) * 1.3, d = R + Math.random() * w * 0.62;
      const r = Math.max(0.8, (1 - d / w) * 5 * Math.random() + 0.6);
      g.beginPath(); g.ellipse(cx + Math.cos(a) * d, cy + Math.sin(a) * d * 0.8, r * 1.6, r, a, 0, Math.PI * 2); g.fill();
    }
    // a few drops behind (back-spatter)
    for (let i = 0; i < 10; i++) {
      const a = Math.PI + (Math.random() - 0.5) * 2, d = R * (1.05 + Math.random() * 0.5);
      g.beginPath(); g.arc(cx + Math.cos(a) * d, cy + Math.sin(a) * d, 1 + Math.random() * 3, 0, Math.PI * 2); g.fill();
    }
  }, { srgb: false });
}

/** Blood running down a wall: a few runs from the top edge, each ending in a bead. */
function dripTexture() {
  return canvasTexture(64, 256, (g, w, h) => {
    g.fillStyle = '#fff';
    for (let i = 0; i < 4; i++) {
      const x = w * (0.2 + Math.random() * 0.6), wd = 2.5 + Math.random() * 5, len = h * (0.35 + Math.random() * 0.6);
      g.beginPath();
      g.moveTo(x - wd, 0);
      g.bezierCurveTo(x - wd * 0.6, len * 0.4, x - wd * 0.4 + (Math.random() - 0.5) * 3, len * 0.8, x, len);
      g.bezierCurveTo(x + wd * 0.4, len * 0.8, x + wd * 0.6, len * 0.4, x + wd, 0);
      g.fill();
      g.beginPath(); g.ellipse(x, len, wd * 0.75, wd * 1.05, 0, 0, Math.PI * 2); g.fill();
    }
    const grd = g.createLinearGradient(0, 0, 0, 30); grd.addColorStop(0, '#fff'); grd.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grd; g.fillRect(w * 0.1, 0, w * 0.8, 30);
  }, { srgb: false });
}

/** Explosion scorch: charred centre, ragged edge and soot rays thrown outwards. */
function scorchTexture() {
  return canvasTexture(256, 256, (g, w, h) => {
    g.fillStyle = '#000'; g.fillRect(0, 0, w, h);
    g.translate(w / 2, h / 2);
    const R = w * 0.3;
    // soot rays
    g.globalCompositeOperation = 'lighter';
    for (let i = 0; i < 70; i++) {
      const a = Math.random() * Math.PI * 2, len = R * (0.9 + Math.random() * 0.75), wd = 2 + Math.random() * 7;
      const grd = g.createLinearGradient(0, 0, Math.cos(a) * len, Math.sin(a) * len);
      grd.addColorStop(0, 'rgba(70,70,70,0.5)'); grd.addColorStop(0.6, 'rgba(45,45,45,0.25)'); grd.addColorStop(1, 'rgba(0,0,0,0)');
      g.strokeStyle = grd; g.lineWidth = wd; g.lineCap = 'round';
      g.beginPath(); g.moveTo(0, 0); g.lineTo(Math.cos(a) * len, Math.sin(a) * len); g.stroke();
    }
    g.globalCompositeOperation = 'source-over';
    // main char with a ragged edge
    const grd = g.createRadialGradient(0, 0, 0, 0, 0, R * 1.05);
    grd.addColorStop(0, 'rgb(250,250,250)'); grd.addColorStop(0.55, 'rgb(235,235,235)'); grd.addColorStop(0.8, 'rgb(170,170,170)'); grd.addColorStop(1, 'rgba(110,110,110,0)');
    g.fillStyle = grd;
    g.beginPath();
    for (let i = 0; i <= 72; i++) {
      const a = (i / 72) * Math.PI * 2;
      const r = R * (0.88 + Math.sin(a * 5 + 0.7) * 0.06 + Math.sin(a * 13) * 0.04 + Math.random() * 0.08);
      i ? g.lineTo(Math.cos(a) * r, Math.sin(a) * r) : g.moveTo(Math.cos(a) * r, Math.sin(a) * r);
    }
    g.fill();
    // soot specks around the edge
    for (let i = 0; i < 160; i++) {
      const a = Math.random() * Math.PI * 2, d = R * (0.8 + Math.random() * 0.9), r = 0.6 + Math.random() * 2.6;
      g.fillStyle = `rgba(200,200,200,${0.25 + Math.random() * 0.5})`;
      g.beginPath(); g.arc(Math.cos(a) * d, Math.sin(a) * d, r, 0, Math.PI * 2); g.fill();
    }
  }, { srgb: false });
}

/** Mottled bruise blotch (white, used with a coloured material). */
function bruiseTexture(soot = false) {
  return canvasTexture(128, 128, (g, w, h) => {
    g.translate(w / 2, h / 2);
    const n = soot ? 30 : 9;
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2, d = Math.random() * w * (soot ? 0.3 : 0.18), r = w * (soot ? 0.05 + Math.random() * 0.1 : 0.16 + Math.random() * 0.16);
      const x = Math.cos(a) * d, y = Math.sin(a) * d;
      const grd = g.createRadialGradient(x, y, 0, x, y, r);
      grd.addColorStop(0, `rgba(255,255,255,${soot ? 0.5 : 0.42})`); grd.addColorStop(0.6, `rgba(255,255,255,${soot ? 0.25 : 0.2})`); grd.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = grd; g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
    }
    if (soot) for (let i = 0; i < 90; i++) {
      const a = Math.random() * Math.PI * 2, d = Math.random() * w * 0.42;
      g.fillStyle = `rgba(255,255,255,${Math.random() * 0.6})`;
      g.beginPath(); g.arc(Math.cos(a) * d, Math.sin(a) * d, 0.5 + Math.random() * 1.5, 0, Math.PI * 2); g.fill();
    }
  }, { srgb: false });
}

/** Burnt skin: charred black centre, blistered brown middle, raw red edge (colour texture). */
function burnTexture() {
  return canvasTexture(128, 128, (g, w, h) => {
    g.translate(w / 2, h / 2);
    const R = w * 0.46;
    const blob = (r0, color, n = 40, jag = 0.18) => {
      g.fillStyle = color; g.beginPath();
      for (let i = 0; i <= n; i++) {
        const a = (i / n) * Math.PI * 2, r = r0 * (1 - jag / 2 + Math.random() * jag);
        i ? g.lineTo(Math.cos(a) * r, Math.sin(a) * r) : g.moveTo(Math.cos(a) * r, Math.sin(a) * r);
      }
      g.fill();
    };
    const edge = g.createRadialGradient(0, 0, R * 0.5, 0, 0, R);
    edge.addColorStop(0, 'rgba(150,40,30,0.9)'); edge.addColorStop(1, 'rgba(170,60,45,0)');
    g.fillStyle = edge; g.fillRect(-R, -R, R * 2, R * 2);
    blob(R * 0.78, 'rgba(110,52,28,0.92)', 48, 0.25);   // blistered / cooked
    blob(R * 0.55, 'rgba(38,22,14,0.97)', 40, 0.35);    // charred
    // blisters + cracked char
    for (let i = 0; i < 14; i++) {
      const a = Math.random() * Math.PI * 2, d = R * (0.5 + Math.random() * 0.25);
      g.fillStyle = 'rgba(205,150,110,0.7)'; g.beginPath(); g.arc(Math.cos(a) * d, Math.sin(a) * d, 1.5 + Math.random() * 3, 0, Math.PI * 2); g.fill();
    }
    g.strokeStyle = 'rgba(8,4,2,0.9)'; g.lineWidth = 1.2;
    for (let i = 0; i < 9; i++) {
      let x = (Math.random() - 0.5) * R * 0.7, y = (Math.random() - 0.5) * R * 0.7;
      g.beginPath(); g.moveTo(x, y);
      for (let k = 0; k < 4; k++) { x += (Math.random() - 0.5) * 14; y += (Math.random() - 0.5) * 14; g.lineTo(x, y); }
      g.stroke();
    }
  });
}

/**
 * Mottled burn coverage for a whole body part (grey-scale, tinted by the material colour): blotchy
 * alpha so the skin underneath shows through in places, with darker cracks and pale blisters.
 */
function charTexture() {
  const tex = canvasTexture(256, 256, (g, w, h) => {
    g.clearRect(0, 0, w, h);
    const spot = (x, y, r, a, v) => {
      for (const ox of [-w, 0, w]) for (const oy of [-h, 0, h]) {   // wrap so it tiles
        const grd = g.createRadialGradient(x + ox, y + oy, 0, x + ox, y + oy, r);
        grd.addColorStop(0, `rgba(${v},${v},${v},${a})`); grd.addColorStop(0.6, `rgba(${v},${v},${v},${a * 0.7})`); grd.addColorStop(1, `rgba(${v},${v},${v},0)`);
        g.fillStyle = grd; g.fillRect(x + ox - r, y + oy - r, r * 2, r * 2);
      }
    };
    for (let i = 0; i < 70; i++) spot(Math.random() * w, Math.random() * h, 18 + Math.random() * 46, 0.6 + Math.random() * 0.35, 170 + Math.floor(Math.random() * 60));
    for (let i = 0; i < 24; i++) spot(Math.random() * w, Math.random() * h, 8 + Math.random() * 24, 0.9, 40 + Math.floor(Math.random() * 50));
    g.strokeStyle = 'rgba(20,20,20,0.85)'; g.lineWidth = 1.4;
    for (let i = 0; i < 26; i++) {
      let x = Math.random() * w, y = Math.random() * h;
      g.beginPath(); g.moveTo(x, y);
      for (let k = 0; k < 5; k++) { x += (Math.random() - 0.5) * 22; y += (Math.random() - 0.5) * 22; g.lineTo(x, y); }
      g.stroke();
    }
    for (let i = 0; i < 30; i++) {
      g.fillStyle = 'rgba(255,235,215,0.55)'; g.beginPath();
      g.arc(Math.random() * w, Math.random() * h, 1.2 + Math.random() * 2.5, 0, Math.PI * 2); g.fill();
    }
  });
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  return tex;
}

/** Glowing ember specks (emissive map for freshly burnt skin). */
function emberTexture() {
  return canvasTexture(128, 128, (g, w, h) => {
    g.fillStyle = '#000'; g.fillRect(0, 0, w, h);
    g.translate(w / 2, h / 2);
    for (let i = 0; i < 70; i++) {
      const a = Math.random() * Math.PI * 2, d = Math.random() * w * 0.3, r = 0.8 + Math.random() * 2.5;
      const grd = g.createRadialGradient(Math.cos(a) * d, Math.sin(a) * d, 0, Math.cos(a) * d, Math.sin(a) * d, r * 2);
      grd.addColorStop(0, 'rgba(255,255,255,1)'); grd.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = grd; g.fillRect(-w / 2, -h / 2, w, h);
    }
  });
}

const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _s = new THREE.Vector3(), _p = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0), Zf = new THREE.Vector3(0, 0, 1);

/** Floor pools/splats (instanced) + bullet holes (instanced) + body wound decals. */

/** A long ragged cut (machete slash): dark centre line, torn edges, grey so the blood tint applies. */
function gashTexture() {
  return canvasTexture(256, 64, (g, w, h) => {
    const cy = h / 2;
    const edge = (sign, spread) => {
      for (let i = 0; i <= 40; i++) {
        const x = 8 + (i / 40) * (w - 16), t = i / 40;
        const half = Math.sin(t * Math.PI) ** 0.7 * spread * (0.8 + Math.random() * 0.4);
        g.lineTo(x, cy + sign * half);
      }
    };
    // bruised, bloody rim
    g.fillStyle = 'rgba(120,120,120,0.55)'; g.beginPath(); g.moveTo(8, cy); edge(-1, h * 0.42); edge(1, h * 0.42); g.fill();
    g.fillStyle = 'rgba(70,70,70,0.95)'; g.beginPath(); g.moveTo(8, cy); edge(-1, h * 0.24); g.lineTo(w - 8, cy); edge(1, h * 0.24); g.fill();
    // the open cut
    g.fillStyle = '#0a0a0a'; g.beginPath(); g.moveTo(10, cy);
    for (let i = 0; i <= 30; i++) { const x = 10 + (i / 30) * (w - 20), t = i / 30; g.lineTo(x, cy - Math.sin(t * Math.PI) * h * 0.09 - Math.random() * 2); }
    for (let i = 30; i >= 0; i--) { const x = 10 + (i / 30) * (w - 20), t = i / 30; g.lineTo(x, cy + Math.sin(t * Math.PI) * h * 0.09 + Math.random() * 2); }
    g.fill();
  }, { srgb: false });
}

/** Bullet strike on armour: a grey smear of lead with a dark dent in the middle. */
function dentTexture() {
  return canvasTexture(64, 64, (g, w, h) => {
    g.translate(w / 2, h / 2);
    const grd = g.createRadialGradient(0, 0, 0, 0, 0, w * 0.48);
    grd.addColorStop(0, 'rgba(25,25,25,1)'); grd.addColorStop(0.25, 'rgba(60,60,58,1)'); grd.addColorStop(0.45, 'rgba(150,150,145,0.9)');
    grd.addColorStop(0.7, 'rgba(110,110,105,0.45)'); grd.addColorStop(1, 'rgba(100,100,100,0)');
    g.fillStyle = grd; g.beginPath(); g.arc(0, 0, w * 0.48, 0, Math.PI * 2); g.fill();
    g.strokeStyle = 'rgba(200,200,195,0.6)'; g.lineWidth = 1.2;
    for (let i = 0; i < 7; i++) { const a = Math.random() * Math.PI * 2; g.beginPath(); g.moveTo(Math.cos(a) * 6, Math.sin(a) * 6); g.lineTo(Math.cos(a) * rand(14, 24), Math.sin(a) * rand(14, 24)); g.stroke(); }
  });
}

/** Crepe bandage: off-white weave with diagonal wraps (blood seeps through as a separate stain). */
export function bandageTexture() {
  return canvasTexture(128, 128, (g, w, h) => {
    g.fillStyle = '#e9e4d8'; g.fillRect(0, 0, w, h);
    for (let y = 0; y < h; y += 3) { g.fillStyle = `rgba(150,140,120,${0.08 + Math.random() * 0.08})`; g.fillRect(0, y, w, 1); }
    for (let x = 0; x < w; x += 4) { g.fillStyle = 'rgba(255,255,255,0.08)'; g.fillRect(x, 0, 1, h); }
    g.strokeStyle = 'rgba(120,110,95,0.35)'; g.lineWidth = 2;
    for (let i = -4; i < 8; i++) { g.beginPath(); g.moveTo(0, i * 22); g.lineTo(w, i * 22 + 34); g.stroke(); }
  }, { repeat: true });
}

/** Blood soaking through a bandage from the middle. */
function soakTexture() {
  return canvasTexture(128, 128, (g, w, h) => {
    g.translate(w / 2, h / 2);
    g.fillStyle = 'rgba(255,255,255,1)';
    g.beginPath();
    for (let i = 0; i <= 48; i++) {
      const a = (i / 48) * Math.PI * 2, r = w * (0.26 + Math.sin(a * 5 + 1) * 0.04 + Math.random() * 0.05);
      i ? g.lineTo(Math.cos(a) * r, Math.sin(a) * r * 1.3) : g.moveTo(Math.cos(a) * r, Math.sin(a) * r * 1.3);
    }
    g.fill();
  }, { srgb: false });
}

export class Decals {
  constructor(scene, maxPools, maxHoles) {
    this.scene = scene;
    // ---- blood pools ----
    this.poolTex = [blobTexture(1), blobTexture(1.6)];
    this.poolMeshes = this.poolTex.map((t) => {
      const m = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({
        color: 0xffffff, alphaMap: t, transparent: true, depthWrite: false, roughness: 0.32, metalness: 0.0, envMapIntensity: 0.5,
        polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
      }), maxPools);
      m.count = 0; m.receiveShadow = true; m.frustumCulled = false;
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      scene.add(m);
      return m;
    });
    this.pools = [];
    this.maxPools = maxPools;
    this.poolDirty = true;

    // ---- bullet holes ----
    this.holes = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({
      map: holeTexture(), transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4,
    }), maxHoles);
    this.holes.count = 0; this.holes.frustumCulled = false;
    scene.add(this.holes);
    this.holeIndex = 0; this.maxHoles = maxHoles;

    // ---- body wounds ----
    this.woundMat = [woundTexture(false), woundTexture(true)].map((t) => new THREE.MeshStandardMaterial({
      map: t, transparent: true, depthWrite: false, roughness: 0.3, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4,
    }));
    this.stainMat = new THREE.MeshStandardMaterial({ map: stainTexture(), transparent: true, depthWrite: false, roughness: 0.35, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 });
    this.poolHue = [1, 0.03, 0.03];

    // ---- blood on walls and the sides of props: splats + runs that ooze downwards ----
    const wallMat = (tex, offset) => new THREE.MeshStandardMaterial({
      color: 0xffffff, alphaMap: tex, transparent: true, depthWrite: false, roughness: 0.3, metalness: 0, envMapIntensity: 0.5,
      polygonOffset: true, polygonOffsetFactor: offset, polygonOffsetUnits: offset,
    });
    const instanced = (geo, mat, n) => {
      const m = new THREE.InstancedMesh(geo, mat, n);
      m.count = 0; m.frustumCulled = false; m.receiveShadow = true;
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      scene.add(m);
      return m;
    };
    this.maxWall = 320;
    this.wallMeshes = [blobTexture(1.3), spatterTexture()].map((t) => instanced(new THREE.PlaneGeometry(1, 1), wallMat(t, -2), this.maxWall));
    this.walls = [];
    this.maxDrips = 90;
    this.dripMesh = instanced(new THREE.PlaneGeometry(1, 1).translate(0, -0.5, 0), wallMat(dripTexture(), -2.5), this.maxDrips);
    this.drips = [];
    this.wallDirty = false;

    // ---- explosion scorch marks (floor + walls), drawn under the blood ----
    this.maxScorch = 48;
    this.scorchMesh = instanced(new THREE.PlaneGeometry(1, 1), new THREE.MeshStandardMaterial({
      color: 0xffffff, alphaMap: scorchTexture(), transparent: true, depthWrite: false, roughness: 0.95, metalness: 0,
      polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1,
    }), this.maxScorch);
    this.scorchMesh.renderOrder = -1;
    this.scorchIndex = 0;

    // ---- bruises / soot on the ragdoll (one small material per mark so each can age) ----
    this.bruiseTex = bruiseTexture(false);
    this.sootTex = bruiseTexture(true);
    this.burnTex = burnTexture();
    this.emberTex = emberTexture();
    this.charTex = charTexture();
    this.bruiseGeo = new THREE.PlaneGeometry(1, 1);
    // one material per kind of mark: each mark's colour, opacity and glow are per instance
    // (holder.userData.fx), so all the marks on all the bodies draw in three calls
    this.bruiseMats = {
      bruise: fxMaterial({ map: this.bruiseTex, transparent: true, depthWrite: false, roughness: 0.6, polygonOffset: true, polygonOffsetFactor: -3.5, polygonOffsetUnits: -3.5 }),
      soot: fxMaterial({ map: this.sootTex, transparent: true, depthWrite: false, roughness: 0.95, polygonOffset: true, polygonOffsetFactor: -3.5, polygonOffsetUnits: -3.5 }),
      burn: fxMaterial({ map: this.burnTex, transparent: true, depthWrite: false, roughness: 0.95, polygonOffset: true, polygonOffsetFactor: -3.8, polygonOffsetUnits: -3.8, emissive: 0xff5a10, emissiveMap: this.emberTex, emissiveIntensity: 1 }),
    };
    this.shellMat = fxMaterial({
      map: this.charTex, transparent: true, depthWrite: false, roughness: 0.95,
      emissive: 0xff5a10, emissiveMap: this.emberTex, emissiveIntensity: 1,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
    });

    this.gashMat = new THREE.MeshStandardMaterial({ map: gashTexture(), transparent: true, depthWrite: false, roughness: 0.3, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 });
    this.dentMat = new THREE.MeshStandardMaterial({ map: dentTexture(), transparent: true, depthWrite: false, roughness: 0.4, metalness: 0.5, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 });
    this.soakTex = soakTexture();
    this.woundGeo = new THREE.PlaneGeometry(1, 1);
    this.stainGeo = new THREE.PlaneGeometry(1, 2).translate(0, -0.8, 0);
  }

  // ---------------------------------------------------------------- pools
  addDrop(x, y, z, volume, size) {
    // merge into a nearby pool if there is one
    let best = null, bestD = Infinity;
    for (const p of this.pools) {
      if (Math.abs(p.y - y) > 0.05) continue;
      const d = Math.hypot(p.x - x, p.z - z);
      if (d < p.r * 0.85 + 0.05 && d < bestD) { best = p; bestD = d; }
    }
    if (best && best.r < 1.4) {
      best.volume += volume;
      best.target = Math.min(1.6, 0.06 * Math.sqrt(best.volume));
      // pool drifts slightly towards new drops
      best.x += (x - best.x) * 0.02; best.z += (z - best.z) * 0.02;
      this.poolDirty = true;
      return;
    }
    const r = Math.max(0.025, size * (1.5 + Math.random() * 1.5));
    const pool = { x, y: y + 0.0015 + Math.random() * 0.001, z, r: r * 0.4, target: r, volume: Math.max(volume, (r / 0.06) ** 2), rot: Math.random() * Math.PI * 2, sx: rand(0.8, 1.25), age: 0, type: Math.random() < 0.6 ? 0 : 1 };
    if (this.pools.length >= this.maxPools) this.pools.shift();
    this.pools.push(pool);
    this.poolDirty = true;
  }

  updatePools(dt) {
    let growing = false;
    for (const p of this.pools) {
      p.age += dt;
      if (p.r < p.target) { p.r = Math.min(p.target, p.r + dt * (0.05 + (p.target - p.r) * 2.5)); growing = true; }
    }
    if (!growing && !this.poolDirty) return;
    this.poolDirty = false;
    const counts = [0, 0];
    const color = new THREE.Color();
    for (const p of this.pools) {
      const mesh = this.poolMeshes[p.type];
      const i = counts[p.type]++;
      _q.setFromAxisAngle(UP, p.rot);
      _s.set(p.r * 2 * p.sx, 1, p.r * 2 / p.sx);
      _m.compose(_p.set(p.x, p.y, p.z), _q, _s);
      mesh.setMatrixAt(i, _m);
      // fresh blood bright red, older pools darker
      const k = Math.min(1, p.age / 90);
      const v = 0.2 - 0.1 * k, hue = this.poolHue;
      color.setRGB(v * hue[0], v * hue[1], v * hue[2]);
      mesh.setColorAt(i, color);
    }
    this.poolMeshes.forEach((m, t) => { m.count = counts[t]; m.instanceMatrix.needsUpdate = true; if (m.instanceColor) m.instanceColor.needsUpdate = true; });
  }

  /** Blood colour setting: decal hue multiplies the grayscale wound/stain textures. */
  setBloodTint(blood) {
    this.poolHue = blood.pool;
    for (const m of [...this.woundMat, this.stainMat, this.gashMat]) m.color.setRGB(...blood.decal);
    this.poolDirty = true; this.wallDirty = true;
  }

  // ---------------------------------------------------------------- walls
  /**
   * Blood hitting a vertical (or overhanging) surface. n = surface normal, vel = droplet velocity
   * (the splat stretches along the direction it was travelling).
   */
  addWallSplat(point, n, vel, volume, size) {
    // merge into a splat already on this face
    for (let i = this.walls.length - 1; i >= Math.max(0, this.walls.length - 60); i--) {
      const w = this.walls[i];
      if (w.n.dot(n) < 0.97) continue;
      const d = w.p.distanceTo(point);
      if (d < w.r * 0.55) {
        w.vol += volume;
        w.r = Math.min(0.32, Math.max(w.r, 0.035 * Math.sqrt(w.vol)));
        w.age = Math.min(w.age, 4);
        this.maybeDrip(w);
        this.wallDirty = true;
        return;
      }
    }
    const tang = _p.copy(vel).addScaledVector(n, -vel.dot(n));
    const speed = tang.length();
    const type = speed > 1.6 ? 1 : 0;
    const r = Math.max(0.02, size * (1.6 + Math.random() * 1.4)) * (type ? 1.5 : 1);
    // orientation: plane faces n, texture +X along the travel direction
    const z = n.clone();
    const x = speed > 1e-3 ? tang.clone().normalize() : new THREE.Vector3().crossVectors(UP, z).normalize();
    if (x.lengthSq() < 0.5) x.set(1, 0, 0);
    const y = new THREE.Vector3().crossVectors(z, x);
    const q = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, z));
    if (!type) q.multiply(_q.setFromAxisAngle(Zf, Math.random() * Math.PI * 2));
    const stretch = type ? Math.min(2.4, 1 + speed * 0.25) : rand(0.85, 1.2);
    const w = { p: point.clone().addScaledVector(n, 0.002 + Math.random() * 0.001), n: n.clone(), q, r, stretch, vol: volume, age: 0, type, dripped: 0 };
    // the spatter texture's blob sits left of centre: shift so the blob lands on the hit point
    if (type) w.p.addScaledVector(x, r * 2 * stretch * 1.4 * 0.2);
    if (this.walls.length >= this.maxWall) this.walls.shift();
    this.walls.push(w);
    this.maybeDrip(w);
    this.wallDirty = true;
  }

  /** Enough blood on a vertical face starts to run down it. */
  maybeDrip(w) {
    if (Math.abs(w.n.y) > 0.5) return;
    const want = Math.floor(w.vol / 9);
    if (want <= w.dripped || w.dripped >= 3) return;
    w.dripped++;
    const z = w.n.clone();
    const y = UP.clone().addScaledVector(z, -z.y).normalize();
    const x = new THREE.Vector3().crossVectors(y, z);
    const q = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, z));
    const p = w.p.clone().add(x.clone().multiplyScalar((Math.random() - 0.5) * w.r)).addScaledVector(z, 0.0005);
    const width = Math.min(0.12, w.r * rand(0.8, 1.3));
    const d = { p, q, width, len: 0.01, target: Math.min(p.y - 0.01, rand(0.25, 0.75) * Math.sqrt(w.vol / 9)), age: 0 };
    if (this.drips.length >= this.maxDrips) this.drips.shift();
    this.drips.push(d);
  }

  updateWalls(dt) {
    let moving = this.wallDirty;
    for (const d of this.drips) {
      d.age += dt;
      if (d.len < d.target) { d.len = Math.min(d.target, d.len + dt * (0.02 + (d.target - d.len) * 0.6)); moving = true; }
    }
    for (const w of this.walls) w.age += dt;
    // colour darkens slowly as it dries
    this.wallTimer = (this.wallTimer || 0) + dt;
    if (this.wallTimer > 1) { this.wallTimer = 0; moving = true; }
    if (!moving) return;
    this.wallDirty = false;
    const color = new THREE.Color(), hue = this.poolHue;
    const counts = [0, 0];
    for (const w of this.walls) {
      const mesh = this.wallMeshes[w.type];
      const i = counts[w.type]++;
      const ax = w.type ? 1.4 : 1, ay = w.type ? 0.7 : 1; // spatter texture is 2:1
      _m.compose(w.p, w.q, _s.set(w.r * 2 * w.stretch * ax, w.r * 2 / Math.sqrt(w.stretch) * ay, 1));
      mesh.setMatrixAt(i, _m);
      const v = 0.21 - 0.1 * Math.min(1, w.age / 90);
      mesh.setColorAt(i, color.setRGB(v * hue[0], v * hue[1], v * hue[2]));
    }
    this.wallMeshes.forEach((m, t) => { m.count = counts[t]; m.instanceMatrix.needsUpdate = true; if (m.instanceColor) m.instanceColor.needsUpdate = true; });
    this.drips.forEach((d, i) => {
      _m.compose(d.p, d.q, _s.set(d.width, d.len, 1));
      this.dripMesh.setMatrixAt(i, _m);
      const v = 0.19 - 0.09 * Math.min(1, d.age / 90);
      this.dripMesh.setColorAt(i, color.setRGB(v * hue[0], v * hue[1], v * hue[2]));
    });
    this.dripMesh.count = this.drips.length;
    this.dripMesh.instanceMatrix.needsUpdate = true;
    if (this.dripMesh.instanceColor) this.dripMesh.instanceColor.needsUpdate = true;
  }

  // ---------------------------------------------------------------- scorch
  /** Black explosion residue on a surface (point on the surface, n = its normal). */
  addScorch(point, n, radius, darkness = 1) {
    const i = this.scorchIndex++ % this.maxScorch;
    _q.setFromUnitVectors(Zf, n).multiply(new THREE.Quaternion().setFromAxisAngle(Zf, Math.random() * Math.PI * 2));
    _m.compose(_p.copy(point).addScaledVector(n, 0.0015 + (i % 8) * 0.0002), _q, _s.set(radius * 2, radius * 2 * rand(0.85, 1.15), 1));
    this.scorchMesh.setMatrixAt(i, _m);
    const v = 0.012 + (1 - darkness) * 0.03;
    this.scorchMesh.setColorAt(i, new THREE.Color(v, v * 0.95, v * 0.9));
    this.scorchMesh.count = Math.min(this.maxScorch, Math.max(this.scorchMesh.count, i + 1));
    this.scorchMesh.instanceMatrix.needsUpdate = true;
    this.scorchMesh.instanceColor.needsUpdate = true;
  }

  // ---------------------------------------------------------------- bruises
  /** A bruise (or soot mark) on a body-part group, in that part's local space. */
  addBruise(group, localPoint, localNormal, size, kind = 'bruise') {
    const m = new THREE.Mesh(this.bruiseGeo, this.bruiseMats[kind] || this.bruiseMats.bruise);
    m.userData.fx = { color: new THREE.Color(1, 1, 1), opacity: 0, emissive: 0 };
    m.position.copy(localPoint).addScaledVector(localNormal, 0.0012);
    m.quaternion.setFromUnitVectors(Zf, localNormal);
    m.rotateZ(Math.random() * Math.PI * 2);
    m.scale.setScalar(size);
    m.userData.decal = true;
    group.add(m);
    return batch(m);
  }

  /**
   * A thin shell over a whole body part that shows how badly it is burnt: a red flush (1st degree),
   * blistered brown (2nd), charred black (3rd), with embers glowing while it is fresh.
   */
  burnShell(mesh) {
    const m = new THREE.Mesh(mesh.geometry, this.shellMat);
    m.userData.fx = { color: new THREE.Color(0xb03020), opacity: 0, emissive: 0 };
    m.position.copy(mesh.position); m.quaternion.copy(mesh.quaternion); m.scale.copy(mesh.scale).multiplyScalar(1.004);
    m.userData.decal = true;
    return m;      // batched by the caller once it is on its part
  }

  // ---------------------------------------------------------------- bullet holes
  addHole(point, normal) {
    const i = this.holeIndex++ % this.maxHoles;
    _q.setFromUnitVectors(Zf, normal);
    const s = 0.035 + Math.random() * 0.015;
    _m.compose(_p.copy(point).addScaledVector(normal, 0.002), _q, _s.set(s, s, s));
    this.holes.setMatrixAt(i, _m);
    this.holes.count = Math.min(this.maxHoles, this.holes.count + 1);
    this.holes.instanceMatrix.needsUpdate = true;
  }

  // ---------------------------------------------------------------- body wounds
  /** Adds a wound decal to a body-part group, in that part's local space. Returns the decal. */
  addWound(group, localPoint, localNormal, exit, size = 0.03) {
    const m = new THREE.Mesh(this.woundGeo, this.woundMat[exit ? 1 : 0]);
    m.position.copy(localPoint).addScaledVector(localNormal, 0.0015);
    m.quaternion.setFromUnitVectors(Zf, localNormal);
    m.rotateZ(Math.random() * Math.PI * 2);
    m.scale.setScalar(size * (exit ? 1.6 : 1));
    m.userData.decal = true;
    group.add(m);
    // blood run stain (grows as the wound bleeds)
    const st = new THREE.Mesh(this.stainGeo, this.stainMat);
    st.position.copy(m.position).addScaledVector(localNormal, 0.0005);
    st.quaternion.setFromUnitVectors(Zf, localNormal);
    st.scale.setScalar(0.001);
    st.userData.decal = true;
    group.add(st);
    return { decal: batch(m), stain: batch(st), stainSize: 0 };
  }

  /**
   * A machete slash on a body-part group (local space): a long gash along `along` (local,
   * perpendicular to the normal), plus the usual blood run stain. Returns { decal, stain, stainSize }.
   */
  addGash(group, localPoint, localNormal, along, length) {
    const m = new THREE.Mesh(this.woundGeo, this.gashMat);
    m.position.copy(localPoint).addScaledVector(localNormal, 0.0015);
    // plane X axis along the cut, Z out of the surface
    const z = localNormal.clone().normalize();
    const x = along.clone().addScaledVector(z, -along.dot(z));
    if (x.lengthSq() < 1e-6) x.set(1, 0, 0).addScaledVector(z, -z.x);
    x.normalize();
    const y = new THREE.Vector3().crossVectors(z, x);
    m.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, z));
    m.scale.set(length, length * 0.25, 1);
    m.userData.decal = true;
    group.add(m);
    const st = new THREE.Mesh(this.stainGeo, this.stainMat);
    st.position.copy(m.position).addScaledVector(localNormal, 0.0005);
    st.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), localNormal);
    st.scale.setScalar(0.001);
    st.userData.decal = true;
    group.add(st);
    return { decal: batch(m), stain: batch(st), stainSize: 0 };
  }

  /** A bullet stopped by armour: a dent / lead smear on the armour, in the group's local space. */
  addDent(group, localPoint, localNormal, size = 0.03) {
    const m = new THREE.Mesh(this.woundGeo, this.dentMat);
    m.position.copy(localPoint).addScaledVector(localNormal, 0.002);
    m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), localNormal);
    m.rotateZ(Math.random() * Math.PI * 2);
    m.scale.setScalar(size);
    m.userData.decal = true;
    group.add(m);
    return batch(m);
  }

  clear() {
    this.pools = []; this.poolDirty = true;
    this.updatePools(0);
    this.holes.count = 0; this.holeIndex = 0;
    this.walls = []; this.drips = []; this.wallDirty = true;
    this.updateWalls(0);
    this.scorchMesh.count = 0; this.scorchIndex = 0;
  }
}
