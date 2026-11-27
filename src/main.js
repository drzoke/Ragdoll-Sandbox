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
import { Shotgun } from './weapon/shotgun.js';
import { Fists } from './weapon/fists.js';
import { GrenadeTool } from './weapon/grenade.js';
import { Explosives } from './weapon/explosives.js';
import { ThrowArc } from './weapon/trajectory.js';
import { ARM_MATERIALS } from './weapon/arms.js';
import { Toolbox } from './weapon/toolbox.js';
import { Graphics } from './graphics.js';
import { settings } from './settings.js';
import { trackMaterials } from './materials.js';
import { GRAY as RAGDOLL_GRAY, BLACK as RAGDOLL_BLACK } from './ragdoll/ragdoll.js';
import { IS_TOUCH, IS_IOS, IS_STANDALONE } from './core/device.js';
import { TouchControls } from './ui/touch.js';
import { benchmark, LEVEL_NAMES, savePerfCap } from './core/bench.js';

const IS_SAFARI = /^((?!chrome|chromium|crios|fxios|edg|android).)*safari/i.test(navigator.userAgent);
// macOS: full screen moves the window to its own Space with an animation, and browsers drop (or
// refuse) the mouse lock during it. Cmd+W can't be blocked on a Mac anyway, so play in the window.
const IS_MAC = /Macintosh|Mac OS X/.test(navigator.userAgent) && !IS_TOUCH;

// ------------------------------------------------------------------ loading screen
const loader = window.__loader || { set() {} };
const frameYield = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
async function stage(p, text) { loader.set(p, text); await frameYield(); }
// ---- hardware check: test the GPU and CPU, recommend a graphics preset ----
await stage(0.6, 'Testing your GPU and CPU');
const hw = benchmark();
const hwLine = `${hw.gpu} · ${hw.cores} CPU threads${hw.memory ? ` · ${hw.memory} GB` : ''}`;
document.getElementById('ld-hw')?.replaceChildren(`${hwLine}  →  Recommended: ${LEVEL_NAMES[hw.level]}`);
let autoGraphics = false;
if (!settings.get('graphicsChosen') && settings.get('graphics') !== hw.level) { settings.set('graphics', hw.level); autoGraphics = true; }
console.info('[hardware]', JSON.stringify(hw));
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
    onPress: () => { audio.play('button'); if (grab.held?.kind === 'gib') grab.release(); gore.clear(); ballistics.clear(); explosives.clear(); pistol.casings.clear(); shotgun.hulls.clear(); hud.toast('Cleaned up'); } }),
];

await stage(0.8, 'Loading weapons');
const ballistics = new Ballistics({ scene, ragdolls, gore, map, buttons, audio, hud });
const pistol = new Pistol({
  mainScene: scene, mainCamera: camera, player, audio, environment: scene.environment,
  onFire: (o, d, muzzle) => ballistics.fire(o, d, muzzle),
});
const grab = new GrabTool({ mainScene: scene, mainCamera: camera, player, audio, environment: scene.environment, physics, ragdolls, gore, hud });
const shotgun = new Shotgun({
  mainScene: scene, mainCamera: camera, player, audio, environment: scene.environment,
  onFire: (o, d, muzzle, opts) => ballistics.fire(o, d, muzzle, opts),
});
const explosives = new Explosives({ scene, physics, ragdolls, gore, map, audio, player, camera });
explosives.ballistics = ballistics;
ballistics.explosives = explosives;
const fists = new Fists({ mainCamera: camera, player, audio, environment: scene.environment, gore, hud, targets: () => ballistics.targets() });
const throwRay = new THREE.Raycaster();
const throwArc = new ThrowArc(scene, () => [...map.solidMeshes, ...ragdolls.meshes()]);
const grenade = new GrenadeTool({
  mainCamera: camera, player, audio, environment: scene.environment, arc: throwArc,
  onThrow: (pos, vel, spin, { right }) => {
    // never spawn the grenade inside a wall you're standing against
    const eye = camera.getWorldPosition(new THREE.Vector3());
    const to = pos.clone().sub(eye);
    throwRay.set(eye, to.clone().normalize()); throwRay.far = to.length() + 0.08;
    const hit = throwRay.intersectObjects(map.solidMeshes, false)[0];
    if (hit) pos.copy(hit.point).addScaledVector(to.normalize(), -0.1);
    explosives.throwGrenade(pos, vel, spin);
    explosives.spawnSpoon(pos.clone().add(new THREE.Vector3(0, 0.05, 0)), vel.clone().multiplyScalar(0.35).addScaledVector(right, 1.8).add(new THREE.Vector3(0, 2.2, 0)));
  },
});
// Materials whose detail follows the graphics preset
trackMaterials(RAGDOLL_GRAY); trackMaterials(RAGDOLL_BLACK, { grime: false });
trackMaterials(pistol.gun.root); trackMaterials(grab.gadget.root); trackMaterials(shotgun.gun.root); trackMaterials(grenade.model.root);
trackMaterials(explosives.template.root);
trackMaterials(ARM_MATERIALS.skin, { grime: false }); trackMaterials(ARM_MATERIALS.sleeve); trackMaterials(ARM_MATERIALS.cuff);
for (const m of map.solidMeshes) trackMaterials(m);
for (const b of buttons) for (const m of b.meshes) trackMaterials(m, { grime: false });
graphics.apply(settings.get('graphics'));
grab.setQuality(settings.get('graphics'));
const tools = [fists, pistol, shotgun, grenade, grab];
const toolbox = new Toolbox(tools, { audio, start: 1, onOpenChange: (open) => onToolboxChange(open) });

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
  touch.setPlaying(p);
}

// ---- touch controls (phones and tablets, played sideways) ----
/** X-ray button on touch screens: off -> 3D -> flat -> off. */
// X (or the touch X-ray button) cycles: open (in the last used view) -> the other view -> closed.
let xraySwitched = false;
function cycleXray() {
  if (!hud.xrayOpen) { xraySwitched = false; hud.toggleXray(); }
  else if (!xraySwitched) { xraySwitched = true; settings.set('xrayMode', settings.get('xrayMode') === 'flat' ? 'dynamic' : 'flat'); }
  else hud.toggleXray();
}
const touch = new TouchControls({
  input, toolbox, mouseSensitivity: CONFIG.player.mouseSensitivity, isAiming: () => player.aiming,
  onPause: () => setPlaying(false), onXray: cycleXray,
  onEditDone: () => menu.classList.remove('hidden'),
});
// Auto: start from the device check, then follow the input actually used (a finger on the
// screen turns touch controls on; keys or a real mouse turn them off).
let autoTouch = IS_TOUCH;
// earlier versions could switch touch controls on for computers by mistake: undo that once
if (!settings.get('touchFixed1')) { if (!IS_TOUCH && settings.get('touchControls') === 'on') settings.set('touchControls', 'auto'); settings.set('touchFixed1', true); }
const touchWanted = () => settings.get('touchControls') === 'on' || (settings.get('touchControls') === 'auto' && autoTouch);
function setAutoTouch(v) {
  if (autoTouch === v || settings.get('touchControls') !== 'auto' || touch.editing) return;
  autoTouch = v;
  // switching controls mid-game: pause, so Play starts the right way (mouse lock or touch)
  if (playing) { if (document.pointerLockElement) document.exitPointerLock(); setPlaying(false); }
  applyTouchMode();
}
addEventListener('pointerdown', (e) => { if (e.pointerType === 'touch') setAutoTouch(true); else if (e.pointerType === 'mouse') setAutoTouch(false); }, true);
addEventListener('pointermove', (e) => { if (e.pointerType === 'mouse' && (Math.abs(e.movementX) + Math.abs(e.movementY) > 2)) setAutoTouch(false); }, true);
addEventListener('keydown', (e) => { if (!e.repeat && e.key !== 'Unidentified') setAutoTouch(false); }, true);
function applyTouchMode() {
  touch.setActive(touchWanted());
  document.getElementById('play').textContent = touch.active ? 'Tap to play' : 'Click to play';
  document.getElementById('play-note').textContent = !touch.active
    ? (IS_MAC || IS_SAFARI
      ? 'The mouse is locked to the game while you play, so it can\'t slide onto another screen. Press Esc to get it back.'
      : "The game plays in fullscreen so keys like Ctrl+W can't close it by accident. Hold Esc to leave fullscreen.")
    : IS_IOS && !IS_STANDALONE
      ? 'Play with your phone sideways. For true full screen on iPhone, tap Share, then Add to Home Screen, and play from the icon.'
      : 'Play with your phone sideways. The game goes full screen when you tap Play. The pause button is at the top left.';
}
applyTouchMode();
document.getElementById('hotbar').addEventListener('click', (e) => {
  const s = e.target.closest('.slot');
  if (s && playing && !toolboxOpen) toolbox.select(Number(s.dataset.i));
});
document.getElementById('tb-close').addEventListener('click', () => toolbox.close());
document.getElementById('touch-edit').addEventListener('click', () => {
  audio.unlock();
  if (!touch.active) settings.set('touchControls', 'on');
  menu.classList.add('hidden');
  touch.startEdit();
});

// Mouse lock. It has to be requested straight from the click (no waiting first: Safari and some
// Chrome versions refuse it once the click's "user gesture" has been used up by going full screen).
// If the browser refuses, the menu stays up and the next click tries again; only a page inside a
// frame that can never lock the mouse falls back to playing with a free cursor.
const IN_FRAME = (() => { try { return window.top !== window; } catch { return true; } })();
let lockedAt = 0;
let lockFails = 0;
function lockPointer() {
  freeMouse = false;
  try {
    const req = canvas.requestPointerLock();
    if (req && req.catch) req.catch((e) => onLockFailed(e));
  } catch (e) { onLockFailed(e); }
}
function onLockFailed(err) {
  if (err) console.warn('[pointer lock]', err?.name, err?.message);
  if (touch.active || document.pointerLockElement === canvas) return;
  lockFails++;
  if (IN_FRAME && lockFails >= 2) {
    // embedded page that can't lock the mouse: play with a free cursor
    freeMouse = true;
    lockWarn.textContent = "This page can't lock the mouse. Open the game in its own browser tab to look around properly.";
    lockWarn.classList.remove('hidden');
    setPlaying(true);
    return;
  }
  lockWarn.textContent = `The browser didn't lock the mouse that time${err?.name ? ` (${err.name})` : ''}. Click Play again, inside the game window.`;
  lockWarn.classList.remove('hidden');
  setPlaying(false);
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
  for (const cb of menu.querySelectorAll('input[type=checkbox][data-setting]')) cb.checked = !!settings.get(cb.dataset.setting);
  for (const rg of menu.querySelectorAll('input[type=range][data-setting]')) {
    rg.value = settings.get(rg.dataset.setting);
    const out = rg.parentElement.querySelector('output');
    if (out) out.textContent = `${Number(rg.value).toFixed(2).replace(/0$/, '')}${rg.dataset.unit ?? '×'}`;
  }
  const hasCustom = !!settings.get('touchCustom');
  menu.querySelector('[data-setting="touchLayout"] [data-v="custom"]').classList.toggle('hidden', !hasCustom);
  const lvl = settings.get('graphics');
  document.getElementById('gfx-note').textContent = GFX_NOTES[lvl];
  document.getElementById('gfx-gpu').innerHTML = `<div><span>Minimum GPU</span><b>${GFX_GPU[lvl][0]}</b></div><div><span>Recommended GPU</span><b>${GFX_GPU[lvl][1]}</b></div>`;
  // what the hardware check found
  for (const b of menu.querySelectorAll('.seg[data-setting="graphics"] button')) b.classList.toggle('rec', b.dataset.v === hw.level);
  document.getElementById('gfx-rec').innerHTML = `<div><span>This device</span><b>${hwLine.replace(/[<>&]/g, '')}</b></div>
    <div class="rec-row"><span>Recommended: <b>${LEVEL_NAMES[hw.level]}</b>${hw.notes.length ? ` (${hw.notes.join(', ')})` : ''}</span>${lvl !== hw.level ? '<button id="gfx-use-rec">Use recommended</button>' : '<em>In use</em>'}</div>`;
  document.getElementById('gfx-use-rec')?.addEventListener('click', () => { settings.set('graphics', hw.level); settings.set('graphicsChosen', false); });
}
for (const seg of menu.querySelectorAll('.seg[data-setting]')) {
  seg.addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    if (seg.dataset.setting === 'graphics') settings.set('graphicsChosen', true);
    settings.set(seg.dataset.setting, b.dataset.v); audio.unlock(); audio.play('click');
  });
}
for (const cb of menu.querySelectorAll('input[type=checkbox][data-setting]')) cb.addEventListener('change', () => settings.set(cb.dataset.setting, cb.checked));
for (const rg of menu.querySelectorAll('input[type=range][data-setting]')) rg.addEventListener('input', () => settings.set(rg.dataset.setting, Number(rg.value)));
settings.onChange((k, v) => {
  syncSettingsUI();
if (autoGraphics) setTimeout(() => hud.toast(`Graphics set to ${LEVEL_NAMES[hw.level]} for this device (change it in Settings)`), 1200);
  if (k === 'graphics') { graphics.apply(v); grab.setQuality(v); toolbox.setQuality(v); resize(); }
  if (k === 'touchControls') applyTouchMode();
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

/** Phones: full screen (where the browser allows it) and lock the screen sideways. */
async function enterMobileFullscreen() {
  try {
    if (!document.fullscreenElement) await (document.documentElement.requestFullscreen?.({ navigationUI: 'hide' }) || document.documentElement.webkitRequestFullscreen?.());
  } catch { /* iPhone Safari: no fullscreen API (Add to Home Screen instead) */ }
  try { await screen.orientation?.lock?.('landscape'); } catch { /* not supported / not fullscreen */ }
}

document.getElementById('play').addEventListener('click', async () => {
  audio.unlock();
  if (touch.active) {
    freeMouse = true;
    setPlaying(true);
    enterMobileFullscreen();
    return;
  }
  // Both start inside the click. Safari drops the mouse lock when it switches to full screen,
  // so it plays in the window (Cmd+W can't be blocked on a Mac anyway).
  lockPointer();
  if (!IS_SAFARI && !IS_MAC) enterFullscreenWithKeyLock();
});
// Clicking the game while it's paused because the lock was lost locks it again.
canvas.addEventListener('mousedown', () => { if (!touch.active && playing && !freeMouse && document.pointerLockElement !== canvas) lockPointer(); });
document.addEventListener('pointerlockchange', () => {
  if (touch.active) return;
  if (document.pointerLockElement === canvas) { lockFails = 0; lockedAt = performance.now(); lockWarn.classList.add('hidden'); setPlaying(true); if (toolboxOpen) toolbox.close(); }
  else if (!freeMouse && !toolboxOpen) {
    setPlaying(false);
    // lost straight away (not by Esc): the browser or the OS took it back, e.g. while switching
    // to full screen. One more click on Play locks it for good.
    if (performance.now() - lockedAt < 1500) {
      lockWarn.textContent = 'The mouse lock was released by the browser. Click Play once more to lock it.';
      lockWarn.classList.remove('hidden');
    }
  }
});
document.addEventListener('pointerlockerror', () => onLockFailed());
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
  for (const t of tools) t.resize(w / h);
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
let lastFocused = null;

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
  lastFocused = focused;
  for (const b of buttons) b.update(dt, b === focused);

  centerRay.far = 60;
  const looked = ragdolls.pick(centerRay);
  if (looked) target = looked;
  if (ballistics.lastTarget && !ragdolls.list.includes(ballistics.lastTarget)) ballistics.lastTarget = null;
  if (!looked && ballistics.lastTarget) target = ballistics.lastTarget;
  if (target && !ragdolls.list.includes(target)) target = ragdolls.list[0] || null;
  if (!target) target = ragdolls.list[0] || null;
}

// ---- FPS check: if the game runs too slowly while you play, step the graphics down ----
// (only while it's on the recommended preset; if you picked one yourself it just suggests it)
const fpsWatch = { t: 0, frames: 0, warm: 0, steps: 0, hinted: false };
settings.onChange((k) => { if (k === 'graphics') { fpsWatch.warm = 0; fpsWatch.t = 0; fpsWatch.frames = 0; } });
function watchFps(_dt, now) {
  // real time between frames (the game's dt is capped, which would hide a very slow frame rate)
  const dt = fpsWatch.last ? Math.min(1, (now - fpsWatch.last) / 1000) : 0;
  fpsWatch.last = now;
  if (!playing || document.hidden || debug.timeScale === 0) { fpsWatch.warm = 0; return; }
  fpsWatch.warm += dt;
  if (fpsWatch.warm < 4) { fpsWatch.t = 0; fpsWatch.frames = 0; return; }   // skip loading hitches
  fpsWatch.t += dt; fpsWatch.frames++;
  if (fpsWatch.t < 6) return;
  const avg = fpsWatch.frames / fpsWatch.t;
  fpsWatch.t = 0; fpsWatch.frames = 0;
  const lvl = settings.get('graphics'), order = ['low', 'medium', 'high', 'ultra'], i = order.indexOf(lvl);
  if (avg >= 40 || i <= 0) return;
  if (!settings.get('graphicsChosen') && fpsWatch.steps < 2) {
    fpsWatch.steps++;
    const next = order[i - 1];
    settings.set('graphics', next);
    savePerfCap(hw.gpu, next);
    hud.toast(`Running at ${avg.toFixed(0)} FPS: graphics lowered to ${LEVEL_NAMES[next]}`);
  } else if (!fpsWatch.hinted) {
    fpsWatch.hinted = true;
    hud.toast(`Running at ${avg.toFixed(0)} FPS. A lower graphics preset in Settings will be smoother.`);
  }
}

// ------------------------------------------------------------------ loop
let last = performance.now();
function frame() {
  requestAnimationFrame(frame);
  const now = performance.now();
  const dt = Math.min((now - last) / 1000, 1 / 20) * debug.timeScale;
  last = now;
  fps += (1 / Math.max(dt, 1e-4) - fps) * 0.05;

  if (input.wasPressed('KeyX')) {
    // Shift+X switches the x-ray between the 3D view and the flat diagram
    if (input.isDown('ShiftLeft') || input.isDown('ShiftRight')) {
      const m = settings.get('xrayMode') === 'flat' ? 'dynamic' : 'flat';
      settings.set('xrayMode', m);
      if (!hud.xrayOpen) hud.toggleXray();
    } else cycleXray();
  }
  if (input.wasPressed('F3')) debugOn = !debugOn;
  if (input.wasPressed('KeyZ')) setTimeIndex(timeIndex - 1);
  if (input.wasPressed('KeyV')) setTimeIndex(timeIndex + 1);
  const ts = world.timeScale;
  const wdt = dt * ts;

  touch.update(dt, { tool: toolbox.active, useVisible: !!lastFocused, xrayMode: hud.xrayOpen ? settings.get('xrayMode') : 'off' });
  player.update(dt, input, playing && !toolboxOpen && !touch.portrait);
  player.aiming = false;                   // the gun in your hands sets it again
  toolbox.update(dt, input, playing, wdt); // tools aim before the physics step
  physics.update(dt, ts);
  ragdolls.update(wdt);
  ballistics.update(wdt, dt);
  explosives.update(wdt);
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
      `pistol ${pistol.state}  mag ${pistol.mag}  chamber ${pistol.chambered}  shotgun ${shotgun.state} ${shotgun.tube}+${shotgun.chamber}  bullets ${ballistics.bullets.length}  grenades ${explosives.live.length}`,
      `time ${world.timeScale}x  gfx ${graphics.level}  tool ${toolbox.active.name}${grab.held ? ' holding ' + (grab.held.part || 'gib') : ''}`,
    ].join('\n') : null,
  });

  watchFps(dt, now);
  const t = toolbox.active;
  graphics.render(t.scene, t.camera);
  input.endFrame();
}

// ---- finish loading: compile shaders, then hand over to the menu ----
await stage(0.92, 'Compiling shaders');
try { renderer.compile(scene, camera); for (const t of tools) renderer.compile(t.scene, t.camera); } catch { /* optional */ }
await stage(1, 'Ready');
frame();
setTimeout(() => {
  menu.classList.remove('hidden');
  const ld = document.getElementById('loader');
  ld.classList.add('done');
  setTimeout(() => ld.remove(), 600);
}, 250);

// Exposed for debugging from the console and for automated tests.
window.game = { fpsWatch, touch, debug, THREE, scene, camera, renderer, physics, player, pistol, grab, shotgun, fists, grenade, explosives, tools, toolbox, graphics, settings, world, setTimeIndex, ragdolls, gore, hud, buttons, ballistics, input, setPlaying, CONFIG };
