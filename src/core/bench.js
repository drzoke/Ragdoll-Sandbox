// Hardware check at start-up: identifies the graphics chip, runs a short GPU and CPU test, and
// recommends a graphics preset (Low / Medium / High / Very High).
import { IS_TOUCH } from './device.js';

const LEVELS = ['low', 'medium', 'high', 'ultra'];

/** Graphics chip name from WebGL (browsers may hide it; then only the benchmark counts). */
function gpuName(gl) {
  try {
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    const raw = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
    // "ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 (0x00002504) Direct3D11 vs_5_0 ps_5_0, D3D11)" -> "NVIDIA GeForce RTX 3060"
    let n = String(raw || '');
    const m = /^ANGLE \((.*)\)$/.exec(n);
    if (m) {
      const parts = m[1].split(', ');
      n = (parts[1] || parts[0]).replace(/\s*\(0x[0-9a-f]+\)/gi, '').replace(/^ANGLE \w+ Renderer: /, '').replace(/\s+(Direct3D|OpenGL|Vulkan|Metal).*$/i, '');
    }
    return n.replace(/\s+/g, ' ').trim();
  } catch { return ''; }
}

/** Rough tier (0 = Low .. 3 = Very High) from the chip name, or -1 if unknown. */
function tierFromName(n) {
  const s = n.toLowerCase();
  if (!s || /^(webkit webgl|mozilla|apple gpu)$/.test(s)) return -1;
  if (/swiftshader|llvmpipe|softpipe|software|microsoft basic/.test(s)) return 0;
  // laptop versions of desktop cards are a lot slower (power and heat limits)
  const laptop = /laptop|max-q|mobile|\d{3,4}m\b/.test(s) ? 1 : 0;
  // Very High (screen-space reflections) only for fast desktop-class cards
  if (/rtx ?(30[7-9]0|40[6-9]0|50\d0)|rx ?(6[89]\d0|7[7-9]\d0|9\d{3})/.test(s)) return 3 - laptop;
  if (/rtx|gtx ?16\d0|gtx ?10[78]0|rx ?(5[5-7]00|6[0-7]\d0|5[78]0|7600)|apple m[1-5] (max|ultra)|arc a7/.test(s)) return 2 - laptop;
  // Apple M-series: plain M1-M5 and Pro run High well only at a reduced resolution; start at Medium / High
  if (/apple m[1-5] pro/.test(s)) return 2;
  if (/apple m[1-5]|radeon (pro|7[89]0m|8[89]0m)|arc/.test(s)) return 1;
  if (/gtx|iris xe|iris\(r\) xe|radeon|vega|adreno ?(7\d\d|8\d\d)|mali-g(7|9)\d|apple a1[5-9]|nvidia/.test(s)) return 1;
  if (/intel|uhd|hd graphics|adreno|mali|powervr|apple a\d/.test(s)) return 0;
  return -1;
}

/**
 * GPU test: a heavy fragment shader drawn into a small offscreen canvas, timed with a pixel read
 * (which waits for the GPU). The size grows until one round takes long enough to time well.
 * Returns throughput in million pixel-iterations per millisecond.
 */
function gpuTest(gl, budgetMs = 160) {
  const vs = 'attribute vec2 p; void main(){ gl_Position = vec4(p, 0.0, 1.0); }';
  const fs = `precision highp float; uniform float t;
    void main(){ vec2 u = gl_FragCoord.xy * 0.01; float a = t;
      for (int i = 0; i < 128; i++) { u = vec2(sin(u.y * 1.3 + a), cos(u.x * 1.7 - a)) + fract(u * 1.1); a += u.x * 0.01; }
      gl_FragColor = vec4(fract(u), a, 1.0); }`;
  const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); return s; };
  const pr = gl.createProgram();
  gl.attachShader(pr, sh(gl.VERTEX_SHADER, vs)); gl.attachShader(pr, sh(gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(pr);
  if (!gl.getProgramParameter(pr, gl.LINK_STATUS)) return 0;
  gl.useProgram(pr);
  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(pr, 'p');
  gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  const tl = gl.getUniformLocation(pr, 't');
  const px = new Uint8Array(4);
  const round = (size, draws) => {
    gl.viewport(0, 0, size, size);
    const t0 = performance.now();
    for (let i = 0; i < draws; i++) { gl.uniform1f(tl, i * 0.1); gl.drawArrays(gl.TRIANGLES, 0, 3); }
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    return performance.now() - t0;
  };
  round(32, 1); // warm-up (shader compile)
  const start = performance.now();
  let size = 64, draws = 1, best = 0;
  while (performance.now() - start < budgetMs) {
    const ms = round(size, draws);
    if (ms > 6) best = Math.max(best, (size * size * draws * 128) / 1e6 / ms);
    if (ms > 40) break;
    if (size < 1024) size *= 2; else draws *= 2;
  }
  return best;
}

/** CPU test: a small physics-like float loop for ~40 ms. Returns million steps per ms (fast desktop ~0.4-0.8, phone ~0.1-0.25). */
function cpuTest(ms = 40) {
  const n = 2048, x = new Float32Array(n), v = new Float32Array(n);
  for (let i = 0; i < n; i++) { x[i] = Math.random(); v[i] = Math.random() - 0.5; }
  const step = () => { for (let i = 0; i < n; i++) { v[i] = v[i] * 0.99 - x[i] * 0.01; x[i] += v[i] * 0.016; if (x[i] < 0) { x[i] = -x[i]; v[i] = -v[i] * 0.5; } } };
  const w0 = performance.now(); while (performance.now() - w0 < 12) step(); // let the JIT warm up
  const t0 = performance.now();
  let steps = 0;
  while (performance.now() - t0 < ms) {
    step();
    steps += n;
  }
  return steps / 1e6 / (performance.now() - t0);
}

/**
 * Runs the checks (about a quarter of a second). Returns
 * { level, gpu, gpuScore, cpuScore, cores, memory, reason }.
 */
export function benchmark() {
  const cores = navigator.hardwareConcurrency || 4;
  const memory = navigator.deviceMemory || null;
  let gpu = '', gpuScore = 0, nameTier = -1;
  try {
    const cv = document.createElement('canvas');
    cv.width = cv.height = 1024;
    const gl = cv.getContext('webgl', { antialias: false, depth: false, powerPreference: 'high-performance', preserveDrawingBuffer: false });
    if (gl) {
      gpu = gpuName(gl);
      nameTier = tierFromName(gpu);
      gpuScore = gpuTest(gl);
      gl.getExtension('WEBGL_lose_context')?.loseContext();
    }
  } catch { /* no WebGL here */ }
  const cpuScore = cpuTest();

  // How many pixels the game will draw in full screen (capped like Graphics.pixelRatio does),
  // relative to a 1080p screen: a Retina laptop or 4K monitor needs a faster GPU for the same preset.
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const screenPx = (screen.width || innerWidth) * (screen.height || innerHeight) * dpr * dpr;
  const load = Math.min(2, Math.max(0.6, Math.min(screenPx, 3.5e6) / 2.07e6));
  // GPU throughput -> tier (rough: integrated ~10-40, mid-range ~60-150, fast cards 200+)
  const benchTier = gpuScore > 260 * load ? 3 : gpuScore > 90 * load ? 2 : gpuScore > 22 * load ? 1 : 0;
  // Known chip: trust the name, but drop a level if it tested much slower (battery saver, wrong GPU)
  let tier = nameTier >= 0 ? Math.min(nameTier, benchTier + 1) : benchTier;
  const notes = [];
  // CPU: physics and the ragdolls run on it
  if (cores <= 2 || cpuScore < 0.08) { tier = Math.min(tier, 1); notes.push('slow CPU'); }
  else if (cores <= 4 || cpuScore < 0.18) { tier = Math.min(tier, 2); }
  if (memory && memory <= 2) { tier = Math.min(tier, 0); notes.push('low memory'); }
  if (IS_TOUCH) tier = Math.min(tier, 1); // phones and tablets: keep them smooth and cool
  // the game lowered the graphics on this device before because it ran too slowly: remember that
  const cap = perfCap(gpu || 'Unknown GPU');
  if (cap >= 0 && cap < tier) { tier = cap; notes.push('lowered after a slow test run'); }
  return { level: LEVELS[Math.max(0, tier)], gpu: gpu || 'Unknown GPU', gpuScore, cpuScore, cores, memory, notes, load };
}

const CAP_KEY = 'ragdoll-sandbox-perfcap';
function perfCap(gpu) {
  try { const c = JSON.parse(localStorage.getItem(CAP_KEY) || 'null'); return c && c.gpu === gpu ? c.tier : -1; } catch { return -1; }
}
/** Remember that this device needed a lower preset (the FPS check lowered it). */
export function savePerfCap(gpu, level) {
  try { localStorage.setItem(CAP_KEY, JSON.stringify({ gpu, tier: LEVELS.indexOf(level) })); } catch { /* ignore */ }
}

export const LEVEL_NAMES = { verylow: 'Very Low', low: 'Low', medium: 'Medium', high: 'High', ultra: 'Very High' };
