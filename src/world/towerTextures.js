import * as THREE from 'three';
import { canvasTexture } from '../core/util.js';
import { noiseTexture } from './build.js';

// Canvas textures for the skyscraper map. Each one is one tile; maps set the tile size in metres.

const rnd = (a, b) => a + Math.random() * (b - a);

export function asphalt() {
  return noiseTexture(512, '#3d3f42', { specks: 0.9, spread: 26, blotches: 40, blotchAlpha: 0.08, lines: (g, w, h) => {
    // small cracks and tar seams
    g.strokeStyle = 'rgba(20,20,22,0.35)'; g.lineWidth = 1.5;
    for (let i = 0; i < 6; i++) {
      let x = rnd(0, w), y = rnd(0, h);
      g.beginPath(); g.moveTo(x, y);
      for (let k = 0; k < 8; k++) { x += rnd(-30, 30); y += rnd(-30, 30); g.lineTo(x, y); }
      g.stroke();
    }
  } });
}

/** Square paving slabs (plaza), 4 x 4 per tile. */
export function paving(base = '#a9a6a0') {
  return noiseTexture(512, base, { specks: 0.8, spread: 14, blotches: 30, blotchAlpha: 0.05, lines: (g, w, h) => {
    const n = 4, s = w / n;
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
      const v = rnd(-10, 10);
      g.fillStyle = v > 0 ? `rgba(255,255,255,${v / 180})` : `rgba(0,0,0,${-v / 180})`;
      g.fillRect(i * s, j * s, s, s);
    }
    g.strokeStyle = 'rgba(60,58,55,0.55)'; g.lineWidth = 3;
    for (let i = 0; i <= n; i++) { g.beginPath(); g.moveTo(i * s, 0); g.lineTo(i * s, h); g.moveTo(0, i * s); g.lineTo(w, i * s); g.stroke(); }
  } });
}

/** Sidewalk concrete with expansion joints. */
export function sidewalk() {
  return noiseTexture(256, '#b3b1ac', { specks: 0.8, spread: 16, blotches: 16, lines: (g, w, h) => {
    g.strokeStyle = 'rgba(70,68,64,0.5)'; g.lineWidth = 2;
    g.beginPath(); g.moveTo(0, 1); g.lineTo(w, 1); g.moveTo(1, 0); g.lineTo(1, h); g.stroke();
  } });
}

/** Office carpet tiles. */
export function carpet() {
  return noiseTexture(256, '#4a525c', { specks: 1, spread: 22, blotches: 10, blotchAlpha: 0.05, lines: (g, w, h) => {
    g.strokeStyle = 'rgba(30,34,40,0.35)'; g.lineWidth = 1.5;
    g.beginPath(); g.moveTo(0, 0.75); g.lineTo(w, 0.75); g.moveTo(0.75, 0); g.lineTo(0.75, h); g.moveTo(0, h / 2); g.lineTo(w, h / 2); g.moveTo(w / 2, 0); g.lineTo(w / 2, h); g.stroke();
  } });
}

/** Suspended ceiling: 2 x 2 tiles per texture tile. */
export function ceilingTiles() {
  return noiseTexture(256, '#d9d8d3', { specks: 0.7, spread: 10, blotches: 6, blotchAlpha: 0.03, lines: (g, w, h) => {
    g.strokeStyle = 'rgba(150,150,148,0.9)'; g.lineWidth = 3;
    g.beginPath(); g.moveTo(0, 1.5); g.lineTo(w, 1.5); g.moveTo(1.5, 0); g.lineTo(1.5, h); g.moveTo(0, h / 2); g.lineTo(w, h / 2); g.moveTo(w / 2, 0); g.lineTo(w / 2, h); g.stroke();
  } });
}

/** Polished stone lobby floor: 2 x 2 big tiles per texture tile. */
export function lobbyStone() {
  return canvasTexture(512, 512, (g, w, h) => {
    g.fillStyle = '#d8d2c8'; g.fillRect(0, 0, w, h);
    for (let i = 0; i < 2; i++) for (let j = 0; j < 2; j++) {
      const x0 = i * w / 2, y0 = j * h / 2;
      const tone = (i + j) % 2 ? '#cfc8bc' : '#ddd7cd';
      g.fillStyle = tone; g.fillRect(x0, y0, w / 2, h / 2);
      // marble veins
      g.strokeStyle = 'rgba(140,130,120,0.25)'; g.lineWidth = 1.2;
      for (let k = 0; k < 5; k++) {
        let x = x0 + rnd(0, w / 2), y = y0 + rnd(0, h / 2);
        g.beginPath(); g.moveTo(x, y);
        for (let s = 0; s < 6; s++) { x += rnd(-25, 25); y += rnd(-25, 25); g.lineTo(x, y); }
        g.stroke();
      }
    }
    g.strokeStyle = 'rgba(120,112,100,0.7)'; g.lineWidth = 2;
    g.strokeRect(1, 1, w / 2 - 2, h / 2 - 2); g.strokeRect(w / 2 + 1, 1, w / 2 - 2, h / 2 - 2);
    g.strokeRect(1, h / 2 + 1, w / 2 - 2, h / 2 - 2); g.strokeRect(w / 2 + 1, h / 2 + 1, w / 2 - 2, h / 2 - 2);
  }, { repeat: true });
}

export function paint(base = '#cfccc4') { return noiseTexture(256, base, { specks: 0.6, spread: 8, blotches: 14, blotchAlpha: 0.04 }); }

export function wood() {
  return canvasTexture(256, 256, (g, w, h) => {
    g.fillStyle = '#b48a5c'; g.fillRect(0, 0, w, h);
    for (let y = 0; y < h; y += 2) {
      g.fillStyle = `rgba(${Math.random() < 0.5 ? '90,60,30' : '210,170,120'},${rnd(0.05, 0.18)})`;
      g.fillRect(0, y + Math.sin(y * 0.05) * 2, w, rnd(1, 3));
    }
  }, { repeat: true });
}

export function fabric(base = '#5d6a78') { return noiseTexture(128, base, { specks: 1, spread: 26, blotches: 0 }); }

export function roofMembrane() {
  return noiseTexture(512, '#77797a', { specks: 1, spread: 30, blotches: 40, blotchAlpha: 0.1, lines: (g, w, h) => {
    g.strokeStyle = 'rgba(40,40,40,0.35)'; g.lineWidth = 3;
    for (let i = 1; i < 4; i++) { g.beginPath(); g.moveTo(0, i * h / 4); g.lineTo(w, i * h / 4); g.stroke(); }
  } });
}

/**
 * Building facade with windows: `cols` x `rows` windows per tile.
 * style: 'glass' (blue office), 'brick' (red brick with punched windows), 'concrete' (grey bands)
 */
export function facade(style = 'glass', cols = 4, rows = 4) {
  return canvasTexture(512, 512, (g, w, h) => {
    const cw = w / cols, rh = h / rows;
    if (style === 'brick') {
      g.fillStyle = '#8a4a36'; g.fillRect(0, 0, w, h);
      for (let y = 0; y < h; y += 8) for (let x = (y / 8) % 2 ? -8 : 0; x < w; x += 16) {
        g.fillStyle = `rgba(${Math.random() < 0.5 ? '60,25,15' : '170,100,80'},${rnd(0.05, 0.25)})`; g.fillRect(x + 1, y + 1, 14, 6);
      }
    } else if (style === 'concrete') {
      g.fillStyle = '#a8a59f'; g.fillRect(0, 0, w, h);
    } else {
      g.fillStyle = '#2f3d48'; g.fillRect(0, 0, w, h);
    }
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      const x = c * cw, y = r * rh;
      const lit = Math.random() < 0.18;
      if (style === 'glass') {
        const gr = g.createLinearGradient(x, y, x + cw, y + rh);
        gr.addColorStop(0, lit ? '#c9d4c8' : '#5f7d92'); gr.addColorStop(1, lit ? '#9fb0a8' : '#3c5466');
        g.fillStyle = gr; g.fillRect(x + 2, y + rh * 0.12, cw - 4, rh * 0.84);
        g.fillStyle = 'rgba(200,215,225,0.6)'; g.fillRect(x, y, cw, rh * 0.1);
      } else {
        g.fillStyle = style === 'brick' ? '#d8d2c4' : '#7d7a74';
        g.fillRect(x + cw * 0.18 - 3, y + rh * 0.25 - 3, cw * 0.64 + 6, rh * 0.55 + 6);
        const gr = g.createLinearGradient(x, y, x, y + rh);
        gr.addColorStop(0, lit ? '#e6dcb8' : '#4b5c68'); gr.addColorStop(1, lit ? '#c8b88a' : '#2c3740');
        g.fillStyle = gr; g.fillRect(x + cw * 0.18, y + rh * 0.25, cw * 0.64, rh * 0.55);
        g.fillStyle = 'rgba(255,255,255,0.15)'; g.fillRect(x + cw * 0.5 - 1, y + rh * 0.25, 2, rh * 0.55);
      }
    }
  }, { repeat: true });
}

/** Number signs for the floors: cell i shows label i (L, 1..20). 6 x 4 grid. */
export function floorSignAtlas(labels) {
  return canvasTexture(1024, 512, (g, w, h) => {
    const cw = w / 6, ch = h / 4;
    labels.forEach((lab, i) => {
      const x = (i % 6) * cw, y = Math.floor(i / 6) * ch;
      g.fillStyle = '#23272c'; g.fillRect(x + 4, y + 4, cw - 8, ch - 8);
      g.fillStyle = '#e8b923'; g.fillRect(x + 4, y + 4, cw - 8, 10);
      g.fillStyle = '#f2f2f2'; g.textAlign = 'center'; g.textBaseline = 'middle';
      g.font = `bold ${lab.length > 2 ? 44 : 64}px sans-serif`;
      g.fillText(lab, x + cw / 2, y + ch * 0.48);
      g.font = '18px sans-serif'; g.fillStyle = '#9aa3ab';
      g.fillText(lab === 'L' ? 'LOBBY' : lab === 'R' ? 'ROOF' : 'FLOOR', x + cw / 2, y + ch * 0.84);
    });
  });
}

/** Simple sign with text (roof access, company name...). */
export function textSign(w, h, lines, { bg = '#1d1f22', fg = '#f2f2f2', stripe = '#e8b923', font = 'bold 54px sans-serif' } = {}) {
  return canvasTexture(w, h, (g) => {
    g.fillStyle = bg; g.fillRect(0, 0, w, h);
    if (stripe) { g.fillStyle = stripe; g.fillRect(0, 0, w, Math.max(6, h * 0.08)); }
    g.fillStyle = fg; g.textAlign = 'center'; g.textBaseline = 'middle';
    lines.forEach((l, i) => { g.font = i === 0 ? font : '28px sans-serif'; g.fillText(l, w / 2, h * (0.45 + i * 0.3) - (lines.length - 1) * h * 0.1); });
  });
}

/** Helipad marking: yellow circle and H on dark grey. */
export function helipad() {
  return canvasTexture(512, 512, (g, w, h) => {
    g.fillStyle = '#4c4f52'; g.fillRect(0, 0, w, h);
    g.strokeStyle = '#e8c33a'; g.lineWidth = 22;
    g.beginPath(); g.arc(w / 2, h / 2, w * 0.4, 0, Math.PI * 2); g.stroke();
    g.fillStyle = '#f2f2f2';
    g.fillRect(w * 0.33, h * 0.28, w * 0.08, h * 0.44); g.fillRect(w * 0.59, h * 0.28, w * 0.08, h * 0.44); g.fillRect(w * 0.33, h * 0.46, w * 0.34, h * 0.08);
  });
}

/** Elevator panel inside the car (decorative; the floor picker does the work). */
export function elevatorPanel() {
  return canvasTexture(256, 512, (g, w, h) => {
    const gr = g.createLinearGradient(0, 0, w, 0); gr.addColorStop(0, '#9aa0a6'); gr.addColorStop(0.5, '#c8ccd0'); gr.addColorStop(1, '#8d9399');
    g.fillStyle = gr; g.fillRect(0, 0, w, h);
    g.fillStyle = '#101214'; g.fillRect(40, 30, w - 80, 60);
    g.fillStyle = '#ff7a2a'; g.font = 'bold 40px monospace'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText('▲▼', w / 2, 60);
    const labels = ['R', ...Array.from({ length: 20 }, (_, i) => String(20 - i)), 'L'];
    labels.forEach((l, i) => {
      const col = i % 3, row = Math.floor(i / 3);
      const x = 60 + col * 68, y = 130 + row * 46;
      g.fillStyle = '#2a2d31'; g.beginPath(); g.arc(x, y, 17, 0, Math.PI * 2); g.fill();
      g.strokeStyle = '#e6e8ea'; g.lineWidth = 2; g.stroke();
      g.fillStyle = l === 'R' ? '#777' : '#f0f0f0'; g.font = 'bold 15px sans-serif'; g.fillText(l, x, y + 1);
    });
  });
}

export const color = (hex, opts = {}) => new THREE.MeshStandardMaterial({ color: hex, roughness: 0.7, ...opts });
