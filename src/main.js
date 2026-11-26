import * as THREE from 'three';
import { CONFIG } from './config.js';
import { Input } from './core/input.js';
import { Physics } from './core/physics.js';
import { Audio } from './core/audio.js';
import { GameMap } from './world/map.js';
import { PressButton } from './world/button.js';
import { PlayerController } from './player/controller.js';
import { Pistol } from './weapon/pistol.js';
import { Ballistics } from './weapon/ballistics.js';
import { Gore } from './gore/gore.js';
import { RagdollManager } from './ragdoll/manager.js';
import { HUD } from './ui/hud.js';
import { GrabTool } from './weapon/grab.js';
import { Toolbox } from './weapon/toolbox.js';
import { Graphics } from './graphics.js';
import { settings } from './settings.js';
import { trackMaterials } from './materials.js';
import { GRAY as RAGDOLL_GRAY, BLACK as RAGDOLL_BLACK } from './ragdoll/ragdoll.js';

// ------------------------------------------------------------------ loading screen
const loader = window.__loader || { set() {} };
const frameYield = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
async function stage(p, text) { loader.set(p, text); await frameYield(); }
await stage(0.62, 'Starting renderer');

// ------------------------------------------------------------------ renderer / scene
const canvas = document.getElementById('game');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.setSize(innerWidth, innerHeight, false);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.82;
renderer.autoClear = false;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(CONFIG.player.fov, innerWidth / innerHeight, 0.03, 600);
scene.add(camera);

// ------------------------------------------------------------------ systems
const input = new Input(canvas);
const audio = new Audio();
const physics = new Physics();
await stage(0.68, 'Building the test map');
const map = new GameMap(scene, physics, renderer);
const player = new PlayerController(camera, map, physics);
await stage(0.74, 'Preparing blood & gore');
const gore = new Gore(scene, physics, map, audio);
const ragdolls = new RagdollManager(scene, physics, gore);
const hud = new HUD(scene);
const graphics = new Graphics({ renderer, scene, camera, map, gore });

const buttons = [
  new PressButton({ scene, physics, map, position: [-3, 0, 4], label: 'RESPAWN', sub: 'Press E · new ragdoll', color: 0xd8302a,
    onPress: () => { audio.play('button'); grab.release(); ragdolls.respawn(); pistol.refill(); hud.toast('Ragdoll respawned'); } }),
  new PressButton({ scene, physics, map, position: [-4.2, 0, 4], label: 'CLEAN UP', sub: 'Press E · blood & gibs', color: 0x2a7bd8,
    onPress: () => { audio.play('button'); if (grab.held?.kind === 'gib') grab.release(); gore.clear(); ballistics.clear(); pistol.casings.clear(); hud.toast('Cleaned up'); } }),
];

await stage(0.8, 'Loading weapons');
const ballistics = new Ballistics({ scene, ragdolls, gore, map, buttons, audio, hud });
const pistol = new Pistol({
  mainScene: scene, mainCamera: camera, player, audio, environment: scene.environment,
  onFire: (o, d, muzzle) => ballistics.fire(o, d, muzzle),
});
const grab = new GrabTool({ mainScene: scene, mainCamera: camera, player, audio, environment: scene.environment, physics, ragdolls, gore, hud });
// Materials whose detail follows the graphics preset
trackMaterials(RAGDOLL_GRAY); trackMaterials(RAGDOLL_BLACK, { grime: false });
trackMaterials(pistol.gun.root); trackMaterials(grab.gadget.root);
for (const m of map.solidMeshes) trackMaterials(m);
for (const b of buttons) for (const m of b.meshes) trackMaterials(m, { grime: false });
graphics.apply(settings.get('graphics'));
grab.setQuality(settings.get('graphics'));
const toolbox = new Toolbox([pistol, grab], { audio, onOpenChange: (open) => onToolboxChange(open) });

await stage(0.86, 'Spawning ragdoll');
ragdolls.spawn();

// ------------------------------------------------------------------ menu / pointer lock
const menu = document.getElementById('menu');
const lockWarn = document.getElementById('lockwarn');
let playing = false;
let freeMouse = false; // fallback when pointer lock is unavailable (e.g. sandboxed iframe)

let toolboxOpen = false;
function setPlaying(p) {
  playing = p;
  input.enabled = p;
  menu.classList.toggle('hidden', p);
  if (!p) { input.clear(); toolbox.close(); }
}

async function lockPointer() {
  try {
    const req = canvas.requestPointerLock();
    if (req && req.then) await req;
    freeMouse = false;
  } catch {
    freeMouse = true;
    lockWarn.classList.remove('hidden');
    setPlaying(true);
  }
}

// The toolbox frees the mouse so cards can be clicked; closing it re-locks.
function onToolboxChange(open) {
  toolboxOpen = open;
  if (open) { input.clear(); if (document.pointerLockElement) document.exitPointerLock(); }
  else {
    input.clear();
    if (playing && !freeMouse && !document.pointerLockElement) {
      // Re-lock straight away (Tab/click count as a user gesture). If the browser refuses, fall
      // back to the pause menu so one click on Play resumes.
      Promise.resolve().then(() => canvas.requestPointerLock()).catch(() => setPlaying(false));
    }
  }
}
addEventListener('keydown', (e) => {
  if (e.code !== 'Tab' || !playing) return;
  e.preventDefault();
  toolbox.toggle();
});

// ---- menu tabs + settings ----
for (const b of menu.querySelectorAll('.tabs button')) {
  b.addEventListener('click', () => {
    for (const x of menu.querySelectorAll('.tabs button')) x.classList.toggle('on', x === b);
    for (const t of menu.querySelectorAll('.tab')) t.classList.toggle('hidden', t.id !== `tab-${b.dataset.tab}`);
  });
}
const GFX_NOTES = {
  low: 'No shadows, lower resolution and fewer blood drops. Runs on almost anything.',
  medium: 'Sharp sun shadows and full resolution.',
  high: 'Adds soft shadows, ambient occlusion (darkening where objects meet), glow on bright lights, and dirt and wear on models.',
  ultra: 'Everything in High, plus reflections on the floor, fine surface detail on models and stronger reflections.',
};
const GFX_GPU = {
  low: ['Any graphics chip from the last 10 years (Intel HD 4000, Chromebooks)', 'Intel UHD 620 or better'],
  medium: ['Intel UHD 620 / AMD Radeon Vega 8', 'Intel Iris Xe / NVIDIA GTX 1050'],
  high: ['NVIDIA GTX 1050 Ti / AMD RX 570', 'NVIDIA GTX 1660 / AMD RX 5600 XT'],
  ultra: ['NVIDIA GTX 1660 Super / AMD RX 5600 XT', 'NVIDIA RTX 3060 / AMD RX 6700 XT or better'],
};
function syncSettingsUI() {
  for (const seg of menu.querySelectorAll('.seg[data-setting]')) {
    for (const b of seg.querySelectorAll('button')) b.classList.toggle('on', b.dataset.v === settings.get(seg.dataset.setting));
  }
  for (const cb of menu.querySelectorAll('input[data-setting]')) cb.checked = !!settings.get(cb.dataset.setting);
  const lvl = settings.get('graphics');
  document.getElementById('gfx-note').textContent = GFX_NOTES[lvl];
  document.getElementById('gfx-gpu').innerHTML = `<div><span>Minimum GPU</span><b>${GFX_GPU[lvl][0]}</b></div><div><span>Recommended GPU</span><b>${GFX_GPU[lvl][1]}</b></div>`;
}
for (const seg of menu.querySelectorAll('.seg[data-setting]')) {
  seg.addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    settings.set(seg.dataset.setting, b.dataset.v); audio.unlock(); audio.play('click');
  });
}
for (const cb of menu.querySelectorAll('input[data-setting]')) cb.addEventListener('change', () => settings.set(cb.dataset.setting, cb.checked));
settings.onChange((k, v) => {
  syncSettingsUI();
  if (k === 'graphics') { graphics.apply(v); grab.setQuality(v); toolbox.setQuality(v); resize(); }
});
syncSettingsUI();

// Fullscreen + Keyboard Lock (Chrome/Edge): lets the game receive Ctrl, Ctrl+W, Esc etc.
// instead of the browser acting on them. Silently skipped where unsupported (Firefox, iframes).
async function enterFullscreenWithKeyLock() {
  try {
    if (!document.fullscreenElement) await document.documentElement.requestFullscreen({ navigationUI: 'hide' });
    if (navigator.keyboard?.lock) { await navigator.keyboard.lock(); input.keyboardLocked = true; }
  } catch { /* not allowed here */ }
}
document.addEventListener('fullscreenchange', () => {
  if (!document.fullscreenElement) { input.keyboardLocked = false; navigator.keyboard?.unlock?.(); }
});

document.getElementById('play').addEventListener('click', async () => {
  audio.unlock();
  const fs = enterFullscreenWithKeyLock(); // must start inside the click
  await fs;
  await lockPointer();
});
document.addEventListener('pointerlockchange', () => {
  if (document.pointerLockElement === canvas) { setPlaying(true); if (toolboxOpen) toolbox.close(); }
  else if (!freeMouse && !toolboxOpen) setPlaying(false);
});
document.addEventListener('pointerlockerror', () => { freeMouse = true; lockWarn.classList.remove('hidden'); setPlaying(true); });
addEventListener('keydown', (e) => {
  if (!playing) return;
  // With the keyboard locked the browser no longer handles Esc for us.
  if (e.code === 'Escape') {
    if (toolboxOpen) { toolbox.close(); return; }
    if (document.pointerLockElement) document.exitPointerLock();
    else setPlaying(false);
  }
  if (e.ctrlKey || e.metaKey) e.preventDefault();
});
// Safety net: browsers won't let a page block Ctrl+W, but they will ask before closing it.
addEventListener('beforeunload', (e) => { if (playing) { e.preventDefault(); e.returnValue = ''; } });

// ------------------------------------------------------------------ resize
function resize() {
  const w = innerWidth, h = innerHeight;
  graphics.resize();
  camera.aspect = w / h; camera.updateProjectionMatrix();
  pistol.resize(w / h);
  grab.resize(w / h);
}
addEventListener('resize', resize);
resize();

// ------------------------------------------------------------------ interaction
const centerRay = new THREE.Raycaster();
const screenCentre = new THREE.Vector2(0, 0);
let debugOn = false;
const debug = { timeScale: 1 }; // set to 0 from the console to freeze the simulation
let target = null;
let fps = 60;

// ---- time warp: world time scale (the player and weapons stay real-time) ----
const TIME_STEPS = [0.01, 0.02, 0.05, 0.1, 0.25, 0.5, 1, 1.5, 2, 3];
let timeIndex = TIME_STEPS.indexOf(1);
const world = { get timeScale() { return TIME_STEPS[timeIndex]; } };
function setTimeIndex(i) {
  const ni = Math.max(0, Math.min(TIME_STEPS.length - 1, i));
  if (ni === timeIndex) { audio.play('deny'); return; }
  audio.play(ni < timeIndex ? 'timeSlow' : 'timeFast');
  timeIndex = ni;
  hud.setTimeScale(world.timeScale);
}

function updateInteraction(dt) {
  centerRay.setFromCamera(screenCentre, camera);
  centerRay.far = CONFIG.player.interactRange;
  const bHits = centerRay.intersectObjects(buttons.flatMap((b) => b.meshes), false);
  const focused = bHits.length ? bHits[0].object.userData.button : null;
  hud.setPrompt(focused ? `<b>E</b>${focused.label === 'RESPAWN' ? 'Respawn ragdoll' : 'Clean up blood'}` : '');
  if (focused && input.wasPressed('KeyE')) focused.press();
  for (const b of buttons) b.update(dt, b === focused);

  centerRay.far = 60;
  const looked = ragdolls.pick(centerRay);
  if (looked) target = looked;
  if (ballistics.lastTarget && !ragdolls.list.includes(ballistics.lastTarget)) ballistics.lastTarget = null;
  if (!looked && ballistics.lastTarget) target = ballistics.lastTarget;
  if (target && !ragdolls.list.includes(target)) target = ragdolls.list[0] || null;
  if (!target) target = ragdolls.list[0] || null;
}

// ------------------------------------------------------------------ loop
let last = performance.now();
function frame() {
  requestAnimationFrame(frame);
  const now = performance.now();
  const dt = Math.min((now - last) / 1000, 1 / 20) * debug.timeScale;
  last = now;
  fps += (1 / Math.max(dt, 1e-4) - fps) * 0.05;

  if (input.wasPressed('KeyX')) hud.toggleXray();
  if (input.wasPressed('F3')) debugOn = !debugOn;
  if (input.wasPressed('KeyZ')) setTimeIndex(timeIndex - 1);
  if (input.wasPressed('KeyV')) setTimeIndex(timeIndex + 1);
  const ts = world.timeScale;
  const wdt = dt * ts;

  player.update(dt, input, playing && !toolboxOpen);
  toolbox.update(dt, input, playing, wdt); // tools aim before the physics step
  physics.update(dt, ts);
  ragdolls.update(wdt);
  ballistics.update(wdt, dt);
  gore.update(wdt, camera, renderer.domElement.height);
  map.update(player.pos);
  updateInteraction(dt);

  const viewerPos = camera.getWorldPosition(new THREE.Vector3());
  const r0 = target;
  hud.update(dt, {
    pistol, tool: toolbox.active, player, target, viewerPos,
    debugText: debugOn ? [
      `fps ${fps.toFixed(0)}`,
      `pos ${player.pos.x.toFixed(2)} ${player.pos.y.toFixed(2)} ${player.pos.z.toFixed(2)}  speed ${player.speed2D.toFixed(2)}`,
      `particles ${gore.particles.alive.size}  pools ${gore.decals.pools.length}  gibs ${gore.gibs.length}`,
      r0 ? `${r0.name}: ${r0.brain.state} / ${r0.brain.activity}  pelvis y ${r0.pelvis.position.y.toFixed(2)}` : '',
      `pistol ${pistol.state}  mag ${pistol.mag}  chamber ${pistol.chambered}  bullets ${ballistics.bullets.length}`,
      `time ${world.timeScale}x  gfx ${graphics.level}  tool ${toolbox.active.name}${grab.held ? ' holding ' + (grab.held.part || 'gib') : ''}`,
    ].join('\n') : null,
  });

  const t = toolbox.active;
  graphics.render(t.scene, t.camera);
  input.endFrame();
}

// ---- finish loading: compile shaders, then hand over to the menu ----
await stage(0.92, 'Compiling shaders');
try { renderer.compile(scene, camera); renderer.compile(pistol.scene, pistol.camera); renderer.compile(grab.scene, grab.camera); } catch { /* optional */ }
await stage(1, 'Ready');
frame();
setTimeout(() => {
  menu.classList.remove('hidden');
  const ld = document.getElementById('loader');
  ld.classList.add('done');
  setTimeout(() => ld.remove(), 600);
}, 250);

// Exposed for debugging from the console and for automated tests.
window.game = { debug, THREE, scene, camera, renderer, physics, player, pistol, grab, toolbox, graphics, settings, world, setTimeIndex, ragdolls, gore, hud, buttons, ballistics, input, setPlaying, CONFIG };
