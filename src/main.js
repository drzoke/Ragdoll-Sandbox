import * as THREE from 'three';
import { CONFIG } from './config.js';
import { Input } from './core/input.js';
import { Physics } from './core/physics.js';
import { Audio } from './core/audio.js';
import { GameMap } from './world/map.js';
import { MAPS, MAP_BY_ID } from './world/maps.js';
import { PressButton } from './world/button.js';
import { PlayerController } from './player/controller.js';
import { Pistol } from './weapon/pistol.js';
import { Ballistics } from './weapon/ballistics.js';
import { Gore } from './gore/gore.js';
import { RagdollManager } from './ragdoll/manager.js';
import { HUD } from './ui/hud.js';
import { GrabTool } from './weapon/grab.js';
import { Shotgun } from './weapon/shotgun.js';
import { Sniper } from './weapon/sniper.js';
import { Musket } from './weapon/musket.js';
import { Fists } from './weapon/fists.js';
import { Machete } from './weapon/machete.js';
import { Medkit } from './weapon/medkit.js';
import { Defibrillator } from './weapon/defib.js';
import { SpawnMenu } from './ui/spawnmenu.js';
import { FloorPicker } from './ui/floorpicker.js';
import { TitleScene } from './ui/title.js';
import { GrenadeTool } from './weapon/grenade.js';
import { Explosives } from './weapon/explosives.js';
import { ThrowArc } from './weapon/trajectory.js';
import { ARM_MATERIALS } from './weapon/arms.js';
import { Toolbox } from './weapon/toolbox.js';
import { Graphics } from './graphics.js';
import { watchForUpdates } from './ui/update.js';
import { settings } from './settings.js';
import { trackMaterials } from './materials.js';
import { updateBatches, batchStats } from './ragdoll/batcher.js';
import { GRAY as RAGDOLL_GRAY, BLACK as RAGDOLL_BLACK, ZOMBIE_SKIN, ZOMBIE_JOINT, ARMOR_MATERIALS } from './ragdoll/ragdoll.js';
import { IS_TOUCH, IS_IOS, IS_STANDALONE } from './core/device.js';
import { TouchControls } from './ui/touch.js';
import { PlayerVitals } from './player/vitals.js';
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
const startMap = MAP_BY_ID[settings.get('map')] || MAPS[0];
await stage(0.68, `Building the map: ${startMap.name}`);
const map = new GameMap(scene, physics, renderer);
map.load(startMap);
const player = new PlayerController(camera, map, physics);
player.spawnAt(map.playerSpawn.pos, map.playerSpawn.yaw);
await stage(0.74, 'Preparing blood & gore');
const gore = new Gore(scene, physics, map, audio);
const ragdolls = new RagdollManager(scene, physics, gore);
const hud = new HUD(scene);
const graphics = new Graphics({ renderer, scene, camera, map, gore });

// the Respawn and Clean up buttons: rebuilt for each map, at the spots it gives (same array)
const buttons = [];
function makeButtons() {
  buttons.length = 0;
  const [a, b] = map.buttonSpots;
  if (a) buttons.push(new PressButton({ map, position: a.pos, yaw: a.yaw, label: 'RESPAWN', sub: 'Press E · new ragdoll', prompt: 'Respawn ragdoll', color: 0xd8302a,
    onPress: () => { audio.play('button'); grab.release(); ragdolls.respawn(); pistol.refill(); hud.toast('Ragdoll respawned'); } }));
  if (b) buttons.push(new PressButton({ map, position: b.pos, yaw: b.yaw, label: 'CLEAN UP', sub: 'Press E · blood & gibs', prompt: 'Clean up blood', color: 0x2a7bd8,
    onPress: () => { audio.play('button'); cleanUp(); } }));
}
makeButtons();

function cleanUp(silent = false) {
  if (grab.held?.kind === 'gib') grab.release();
  gore.clear(); ballistics.clear(); explosives.clear(); pistol.casings.clear(); shotgun.hulls.clear(); sniper.casings.clear(); musket.smoke.clear();
  map.onCleanUp?.();   // e.g. broken windows go back in
  if (title) title.dirty = true;   // the title screen's blood went too: rebuild it next time
  if (!silent) hud.toast('Cleaned up');
}
function removeAllRagdolls() {
  grab.release();
  const n = ragdolls.list.filter((r) => !r.hidden).length;
  ragdolls.clear(ragdolls.keep);
  hud.toast(n ? `Removed ${n} ragdoll${n > 1 ? 's' : ''}` : 'No ragdolls to remove');
}

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
const sniper = new Sniper({
  mainScene: scene, mainCamera: camera, player, audio, environment: scene.environment,
  onFire: (o, d, muzzle, opts) => ballistics.fire(o, d, muzzle, opts),
});
const musket = new Musket({
  mainScene: scene, mainCamera: camera, player, audio, environment: scene.environment,
  onFire: (o, d, muzzle, opts) => ballistics.fire(o, d, muzzle, opts),
});
const explosives = new Explosives({ scene, physics, ragdolls, gore, map, audio, player, camera });
explosives.ballistics = ballistics;
ballistics.explosives = explosives;
const fists = new Fists({ mainCamera: camera, player, audio, environment: scene.environment, gore, hud, targets: () => ballistics.targets() });
// close-range tools: they hit the same things bullets do, and show their target in the x-ray
const near = { mainCamera: camera, player, audio, environment: scene.environment, gore, hud, targets: () => ballistics.targets(), onTarget: (r) => { ballistics.lastTarget = r; } };
const machete = new Machete(near);
const medkit = new Medkit(near);
const defib = new Defibrillator({ ...near, mainScene: scene });
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
trackMaterials(RAGDOLL_GRAY); trackMaterials(RAGDOLL_BLACK, { grime: false }); trackMaterials(ZOMBIE_SKIN, { grime: false }); trackMaterials(ZOMBIE_JOINT, { grime: false });
trackMaterials(pistol.gun.root); trackMaterials(grab.gadget.root); trackMaterials(shotgun.gun.root); trackMaterials(sniper.gun.root); trackMaterials(sniper.mag); trackMaterials(musket.gun.root); trackMaterials(grenade.model.root);
trackMaterials(explosives.template.root);
trackMaterials(machete.model.root); trackMaterials(medkit.left); trackMaterials(medkit.right); trackMaterials(defib.pr.root); trackMaterials(defib.pl.root);
for (const m of Object.values(ARMOR_MATERIALS)) trackMaterials(m);
trackMaterials(ARM_MATERIALS.skin, { grime: false }); trackMaterials(ARM_MATERIALS.sleeve); trackMaterials(ARM_MATERIALS.cuff);
graphics.apply(settings.get('graphics'));
grab.setQuality(settings.get('graphics'));
const tools = [fists, pistol, shotgun, sniper, musket, grenade, grab, machete, medkit, defib];
const toolbox = new Toolbox(tools, { audio, start: 0, onOpenChange: (open) => onToolboxChange(open) });

await stage(0.86, 'Spawning ragdoll');
ragdolls.spawn();
const spawnMenu = new SpawnMenu({ ragdolls, camera, map, audio, hud, onOpenChange: (open) => onToolboxChange(open), onRemoveAll: removeAllRagdolls, onCleanUp: cleanUp });
await stage(0.88, 'Setting the scene');
const title = new TitleScene({ scene, ragdolls, gore, ballistics, physics, camera });
title.ensure();
title.setActive(true);
map.setTitleMode(true);
trackMaterials(title.prop.root);

// ---- maps: switching clears the world and starts you at the new map's entrance ----
/** Things a map's moving parts need (elevator rides carry you, ragdolls and gibs along). */
const floorPicker = new FloorPicker({ audio, onOpenChange: (open) => onToolboxChange(open) });
map.ctx = { player, ragdolls, gore, grab, audio, hud, input, camera, get playing() { return playing && !toolboxOpen; },
  pickFloor: (opts) => { toolbox.close(); spawnMenu.close(); floorPicker.open(opts); } };
function loadMap(id) {
  const def = MAP_BY_ID[id];
  if (!def) return;
  grab.release();
  ragdolls.clear(ragdolls.keep);
  cleanUp(true);
  map.load(def);
  makeButtons();
  player.spawnAt(map.playerSpawn.pos, map.playerSpawn.yaw);
  if (graphics.passes?.ssr) graphics.passes.ssr.selects = [map.floor].filter(Boolean);
  camera.far = def.far || 600; camera.updateProjectionMatrix();
  ragdolls.respawn();
  settings.set('map', id);
  target = null; ballistics.lastTarget = null;
  vitals.reset();
  resetDrs();
}

// ---- your health: zombies, long falls and blasts hurt; at 0 you respawn at the map start ----
const vitals = new PlayerVitals({
  player, audio,
  onDeath: () => { grab.release(); floorPicker.close(); },
  onRespawn: () => { player.spawnAt(map.playerSpawn.pos, map.playerSpawn.yaw); },
});
player.onLand = (speed, height) => { if (height > 4.5 && !player.script && playing && !titleMode) vitals.hurt((height - 4.5) * 7.5, { kind: 'fall' }); };
player.hurt = (dmg, opts) => { if (playing && !titleMode) vitals.hurt(dmg, opts); };
ragdolls.hurtPlayer = (dmg, opts) => { if (playing && !titleMode) vitals.hurt(dmg, opts); };
camera.far = startMap.far || 600; camera.updateProjectionMatrix();

// ------------------------------------------------------------------ menu / pointer lock
const menu = document.getElementById('menu');
const lockWarn = document.getElementById('lockwarn');
let playing = false;
let freeMouse = false; // fallback when pointer lock is unavailable (e.g. sandboxed iframe)

let toolboxOpen = false;       // toolbox or spawn menu open (the mouse is free)
// Title screen (cinematic camera on the corpse scene) until you press Play; after that Esc opens
// the pause menu, which has a Main menu button back to the title screen.
let titleMode = true;
const playLabel = document.querySelector('#play span');
function setMenuMode(mode) {
  menu.classList.toggle('title', mode === 'title');
  menu.classList.toggle('pause', mode === 'pause');
  document.body.classList.toggle('title', mode === 'title');
  playLabel.textContent = mode === 'title' ? 'Play' : 'Resume';
}
function setPlaying(p) {
  playing = p;
  input.enabled = p;
  menu.classList.toggle('hidden', p);
  if (p) {
    if (titleMode) { titleMode = false; title.setActive(false); map.setTitleMode(false); setMenuMode("pause"); vitals.reset(); }
    closePanel();
  } else { input.clear(); toolbox.close(); spawnMenu.close(); floorPicker.close(); }
  touch.setPlaying(p);
}
function showTitle() {
  titleMode = true;
  vitals.reset();
  if (document.pointerLockElement) document.exitPointerLock();
  setPlaying(false);
  title.ensure();
  title.setActive(true);
  map.setTitleMode(true);
  setMenuMode('title');
  closePanel();
}
// side panels: Settings, Controls, What's new
const panel = document.getElementById('m-panel');
const PANEL_TITLES = { maps: 'Maps', settings: 'Settings', keys: 'Controls', news: "What's new" };
// map picker: a card per map (picture, name, what's there); picking one loads it and starts playing
const MAP_ART = {
  range: '<svg viewBox="0 0 160 90"><rect width="160" height="90" fill="#8d949b"/><path d="M0 52h160v38H0z" fill="#6f767d"/><g stroke="#5f666d" stroke-width="1"><path d="M0 60h160M0 70h160M0 82h160M20 52L-10 90M50 52l-15 38M80 52v38M110 52l15 38M140 52l30 38"/></g><rect x="22" y="40" width="22" height="16" fill="#c9ccd0"/><rect x="104" y="34" width="34" height="22" fill="#b8bcc1"/><path d="M60 56h14v-5h12v-5h12v10" fill="#d6d9dc"/><circle cx="78" cy="38" r="4" fill="#7f8286"/><rect x="74" y="42" width="8" height="12" rx="2" fill="#7f8286"/></svg>',
  tower: '<svg viewBox="0 0 160 90"><defs><linearGradient id="mt-sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#9fb7c9"/><stop offset="1" stop-color="#d4dde3"/></linearGradient></defs><rect width="160" height="90" fill="url(#mt-sky)"/><g fill="#8a96a1"><rect x="4" y="44" width="18" height="40"/><rect x="24" y="52" width="14" height="32"/><rect x="118" y="40" width="16" height="44"/><rect x="136" y="50" width="20" height="34"/></g><rect x="56" y="8" width="44" height="76" fill="#3e5566"/><g fill="#7fa3bb" opacity=".8">' + Array.from({ length: 18 }, (_, i) => `<rect x="59" y="${11 + i * 4}" width="38" height="2.4"/>`).join('') + '</g><rect x="76" y="2" width="2" height="7" fill="#5a6670"/><circle cx="77" cy="2" r="1.4" fill="#e0414f"/><rect x="40" y="62" width="14" height="22" fill="#9aa4ad"/><rect x="102" y="58" width="14" height="26" fill="#9aa4ad"/><rect y="84" width="160" height="6" fill="#4b5157"/></svg>',
};
function renderMaps() {
  const cur = map.def?.id;
  document.getElementById('map-list').innerHTML = MAPS.map((m) => `<button class="map-card${m.id === cur ? ' on' : ''}" data-map="${m.id}">
    <div class="art">${MAP_ART[m.id] || ''}</div><div class="txt"><b>${m.name}${m.id === cur ? ' <span class="cur">current</span>' : ''}</b><p>${m.desc}</p></div></button>`).join('');
}
document.getElementById('map-list').addEventListener('click', (e) => {
  const b = e.target.closest('[data-map]');
  if (!b) return;
  audio.unlock(); audio.play('click');
  if (b.dataset.map !== map.def?.id) { loadMap(b.dataset.map); hud.toast(`Loaded ${MAP_BY_ID[b.dataset.map].name}`); }
  renderMaps();
  closePanel();
  document.getElementById('play').click();
});
let panelName = null;
function openPanel(name) {
  if (panelName === name) { closePanel(); return; }
  panelName = name;
  if (name === 'maps') renderMaps();
  panel.classList.remove('hidden');
  document.getElementById('m-panel-title').textContent = PANEL_TITLES[name];
  for (const t of panel.querySelectorAll('.tab')) t.classList.toggle('hidden', t.id !== `tab-${name}`);
  for (const b of menu.querySelectorAll('.m-btn[data-panel]')) b.classList.toggle('on', b.dataset.panel === name);
  panel.querySelector('.m-panel-body').scrollTop = 0;
}
function closePanel() {
  panelName = null;
  panel.classList.add('hidden');
  for (const b of menu.querySelectorAll('.m-btn[data-panel]')) b.classList.remove('on');
}
for (const b of menu.querySelectorAll('.m-btn[data-panel]')) b.addEventListener('click', () => { audio.unlock(); audio.play('click'); openPanel(b.dataset.panel); });
document.getElementById('m-panel-close').addEventListener('click', () => closePanel());
document.getElementById('to-title').addEventListener('click', () => { audio.play('click'); showTitle(); });
setMenuMode('title');

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
  onPause: () => setPlaying(false), onXray: cycleXray, onSpawn: () => { toolbox.close(); spawnMenu.toggle(); }, onToolbox: () => { spawnMenu.close(); toolbox.toggle(); },
  onEditDone: () => menu.classList.remove('hidden'),
});
sniper.isTouch = () => touch.active;
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
      // (skipped if another overlay opened in the meantime, e.g. Tab -> B)
      Promise.resolve().then(() => { if (!toolboxOpen && playing) return canvas.requestPointerLock(); }).catch(() => setPlaying(false));
    }
  }
}
addEventListener('keydown', (e) => {
  if (!playing || e.repeat) return;
  if (e.code === 'Tab') { e.preventDefault(); if (spawnMenu.isOpen) spawnMenu.close(); toolbox.toggle(); }
  if (e.code === 'KeyB') { if (toolbox.isOpen) toolbox.close(); spawnMenu.toggle(); }
});

// ---- settings ----
const GFX_NOTES = {
  verylow: 'For slow computers and older phones: half resolution, no shadows, far fewer blood drops and simpler materials. Looks rougher but runs the fastest.',
  low: 'No shadows, lower resolution and fewer blood drops. Runs on almost anything.',
  medium: 'Sharp sun shadows and full resolution.',
  high: 'Adds soft shadows, ambient occlusion (darkening where objects meet), glow on bright lights, and dirt and wear on models.',
  ultra: 'Everything in High, plus reflections on the floor, fine surface detail on models and stronger reflections.',
};
const GFX_GPU = {
  verylow: ['Any graphics chip that runs WebGL 2', 'Intel HD 4000 or better'],
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
  if (document.pointerLockElement === canvas) { lockFails = 0; lockedAt = performance.now(); lockWarn.classList.add('hidden'); setPlaying(true); if (toolboxOpen) { toolbox.close(); spawnMenu.close(); floorPicker.close(); } }
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
    if (toolboxOpen) { toolbox.close(); spawnMenu.close(); floorPicker.close(); return; }
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
let lookedRagdoll = null;
// what the ragdolls know about you: where you are, whether a weapon is out and what it points at
const playerInfo = { pos: new THREE.Vector3(), armed: false, melee: false, aimedAt: null };
function updatePlayerInfo() {
  if (titleMode || !playing) { ragdolls.player = null; return; }
  const t = toolbox.active, out = t.raise > 0.6;
  playerInfo.pos.copy(player.pos);
  playerInfo.alive = !vitals.dead;
  playerInfo.armed = out && (t === pistol || t === shotgun || t === sniper || t === musket || t === machete || t === grenade);
  playerInfo.melee = out && (t === machete || t === fists);
  playerInfo.aimedAt = lookedRagdoll;
  ragdolls.player = playerInfo;
}

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
  // buttons and the map's own things (elevator, ladder); walls in front of them block the look
  let focused = null, label = '';
  if (!titleMode && !player.script) {
    const meshes = buttons.flatMap((b) => b.meshes);
    for (const it of map.interactables) if (it.enabled !== false) meshes.push(...it.meshes);
    const hit = centerRay.intersectObjects([...meshes, ...map.solidMeshes], false)[0];
    focused = hit ? hit.object.userData.button || hit.object.userData.interact || null : null;
    label = focused ? (typeof focused.prompt === 'function' ? focused.prompt() : focused.prompt) : '';
    if (!label) focused = null;
  }
  hud.setPrompt(focused ? `<b>E</b>${label}` : '');
  if (focused && input.wasPressed('KeyE')) focused.press();
  lastFocused = focused;
  for (const b of buttons) b.update(dt, b === focused);
  for (const it of map.interactables) it.update?.(dt, it === focused);

  centerRay.far = 60;
  // the title screen's corpse (hidden) never shows up in the X-ray or as a target
  let looked = ragdolls.pick(centerRay);
  if (looked?.hidden) looked = null;
  lookedRagdoll = looked;
  const live = ragdolls.list.filter((r) => !r.hidden);
  if (looked) target = looked;
  if (ballistics.lastTarget && !live.includes(ballistics.lastTarget)) ballistics.lastTarget = null;
  if (!looked && ballistics.lastTarget) target = ballistics.lastTarget;
  if (target && !live.includes(target)) target = live[0] || null;
  if (!target) target = live[0] || null;
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
  const lvl = settings.get('graphics'), order = ['verylow', 'low', 'medium', 'high', 'ultra'], i = order.indexOf(lvl);
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

// ---- dynamic resolution: when the frame rate drops, draw fewer pixels (down to 60%) ----
// Steps down 10% at a time while below 48 FPS, and back up after a while above 57. If a step down
// didn't help (the game is held back by something other than drawing pixels, or the screen runs at
// 30 Hz), it goes back up and stops trying until the preset or the map changes.
const drs = { t: 0, frames: 0, warm: 0, good: 0, lastDownFps: 0, stuck: false, wait: 0 };
const resetDrs = () => { Object.assign(drs, { t: 0, frames: 0, warm: 0, good: 0, lastDownFps: 0, stuck: false, wait: 0 }); graphics.setResScale(1); };
settings.onChange((k, v) => { if (k === 'graphics' || (k === 'dynamicRes' && !v)) resetDrs(); });
function watchResolution(now) {
  const dt = drs.last ? Math.min(1, (now - drs.last) / 1000) : 0;
  drs.last = now;
  if (!settings.get('dynamicRes') || !playing || document.hidden || debug.timeScale === 0) { drs.warm = 0; return; }
  drs.warm += dt;
  if (drs.warm < 3) { drs.t = 0; drs.frames = 0; return; }
  drs.t += dt; drs.frames++;
  if (drs.t < 1.5) return;
  const fps = drs.frames / drs.t;
  drs.t = 0; drs.frames = 0;
  if (drs.wait > 0) { drs.wait--; return; }
  const s = graphics.resScale;
  if (fps < 48) {
    drs.good = 0;
    if (drs.stuck || s <= 0.61) return;
    // the game's own work (physics, ragdolls, draw calls) fills the frame: fewer pixels won't help
    if (cpuMs > 0.8 * 1000 / fps) return;
    if (drs.lastDownFps && fps < drs.lastDownFps * 1.04) { drs.stuck = true; graphics.setResScale(s + 0.1); drs.wait = 1; return; }
    drs.lastDownFps = fps;
    graphics.setResScale(s - 0.1);
    drs.wait = 1;               // let it settle for one window before judging the new size
  } else {
    drs.lastDownFps = 0;
    if (fps > 57 && s < 1 && ++drs.good >= 4) { drs.good = 0; graphics.setResScale(s + 0.1); drs.wait = 1; }
  }
}

// ------------------------------------------------------------------ loop
// V-sync on: one frame per screen refresh (requestAnimationFrame). Off: extra frames run between
// refreshes as soon as the last one is done (a message to ourselves is the fastest way to yield to
// the browser), so the game runs above the refresh rate and input and physics are sampled more
// often. The refresh frame still runs right before each paint, so the screen always shows the
// newest frame; if the browser falls behind on its refreshes the extra frames pause until it
// catches up, so they can never starve the page.
const loopChannel = new MessageChannel();
let rafPending = false, msgPending = false, lastRaf = performance.now(), rafGap = 1000 / 60;
loopChannel.port1.onmessage = () => { msgPending = false; frame(); };
function onRaf() {
  rafPending = false;
  const now = performance.now();
  rafGap += (Math.min(34, Math.max(4, now - lastRaf)) - rafGap) * 0.1;
  lastRaf = now;
  frame();
}
function scheduleFrame() {
  if (!rafPending) { rafPending = true; requestAnimationFrame(onRaf); }
  if (settings.get('vsync') === false && !document.hidden && !msgPending && performance.now() - lastRaf < rafGap * 1.5) {
    msgPending = true; loopChannel.port2.postMessage(0);
  }
}
// FPS: frames counted over half a second of real time (the game's dt is capped at 1/20 s, which
// kept the old counter from ever showing less than 20)
const fpsCount = { n: 0, t0: performance.now() };
let cpuMs = 0;              // time spent in frame() itself, smoothed (dynamic resolution reads it)
let drawCalls = 0;          // the whole frame's, counted by hand (see the end of frame())
renderer.info.autoReset = false;
let last = performance.now();
function frame() {
  scheduleFrame();
  const now = performance.now();
  // Frame time, capped at 0.1 s: down to 10 FPS the game still runs at real speed (it used to slow
  // down below 20 FPS); only below that does it go into slow motion instead of jumping ahead.
  const dt = Math.min((now - last) / 1000, 1 / 10) * debug.timeScale;
  last = now;
  fpsCount.n++;
  if (now - fpsCount.t0 >= 500) { fps = fpsCount.n * 1000 / (now - fpsCount.t0); fpsCount.n = 0; fpsCount.t0 = now; }

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
  player.update(dt, input, playing && !toolboxOpen && !touch.portrait && !vitals.dead);
  if (titleMode) title.update(dt);         // cinematic camera on the title screen
  player.aiming = false;                   // the gun in your hands sets it again
  toolbox.update(dt, input, playing && !vitals.dead, wdt); // tools aim before the physics step
  physics.update(dt, ts);
  ragdolls.update(wdt);
  ballistics.update(wdt, dt);
  explosives.update(wdt);
  gore.update(wdt, camera, renderer.domElement.height);
  map.update(titleMode ? title.focus : player.pos, dt);
  updateInteraction(dt);
  updatePlayerInfo();

  const viewerPos = camera.getWorldPosition(new THREE.Vector3());
  const r0 = target;
  hud.update(dt, {
    pistol, tool: toolbox.active, player, target, viewerPos,
    debugText: debugOn ? [
      `fps ${fps.toFixed(0)}  frame ${cpuMs.toFixed(1)} ms  physics ${physics.loadMs.toFixed(1)} ms at ${Math.round(physics.rateHz)} Hz${physics.remote ? ' (own core)' : ''}`,
      `pos ${player.pos.x.toFixed(2)} ${player.pos.y.toFixed(2)} ${player.pos.z.toFixed(2)}  speed ${player.speed2D.toFixed(2)}`,
      `particles ${gore.particles.alive.size}  pools ${gore.decals.pools.length}  gibs ${gore.gibs.length}  draw calls ${drawCalls}  ragdoll batches ${batchStats().draws} (${batchStats().instances})`,
      r0 ? `${r0.name}: ${r0.brain.state} / ${r0.brain.activity}  pelvis y ${r0.pelvis.position.y.toFixed(2)}` : '',
      `pistol ${pistol.state}  mag ${pistol.mag}  chamber ${pistol.chambered}  shotgun ${shotgun.state} ${shotgun.tube}+${shotgun.chamber}  bullets ${ballistics.bullets.length}  grenades ${explosives.live.length}`,
      `time ${world.timeScale}x  gfx ${graphics.level} res ${(graphics.resScale * 100).toFixed(0)}%  tool ${toolbox.active.name}${grab.held ? ' holding ' + (grab.held.part || 'gib') : ''}`,
    ].join('\n') : null,
  });

  watchFps(dt, now);
  watchResolution(now);
  const t = toolbox.active;
  vitals.update(dt, { input, playing: playing && !toolboxOpen, show: !titleMode && ragdolls.list.some((r) => r.zombie && !r.hidden) });
  physics.flush();                  // worker mode: send this frame's changes, it steps while we draw
  map.cull(camera);
  updateBatches(scene, camera);     // ragdoll parts and the marks on them, drawn instanced
  if (titleMode || vitals.dead) graphics.render(null, null);
  else graphics.render(t.scene, t.camera);
  drawCalls = renderer.info.render.calls; renderer.info.reset();   // the whole frame's (shadows and view model included)
  input.endFrame();
  cpuMs += (performance.now() - now - cpuMs) * 0.1;
}

// ---- finish loading: compile shaders, then hand over to the menu ----
await stage(0.92, 'Compiling shaders');
try { renderer.compile(scene, camera); for (const t of tools) renderer.compile(t.scene, t.camera); } catch { /* optional */ }
await stage(1, 'Ready');
// the physics moves to its own processor core (unless switched off in Settings)
physics.setWorker(settings.get('physicsWorker') !== false);
settings.onChange((k, v) => { if (k === 'physicsWorker') physics.setWorker(v !== false); });
frame();
setTimeout(() => {
  menu.classList.remove('hidden');
  const ld = document.getElementById('loader');
  ld.classList.add('done');
  setTimeout(() => ld.remove(), 600);
}, 250);

// Exposed for debugging from the console and for automated tests.
watchForUpdates({ hud });
window.game = { batchStats, vitals, map, loadMap, MAPS, machete, medkit, defib, spawnMenu, title, showTitle, get titleMode() { return titleMode; }, fpsWatch, touch, debug, THREE, scene, camera, renderer, physics, player, pistol, grab, shotgun, sniper, musket, fists, grenade, explosives, tools, toolbox, graphics, settings, world, setTimeIndex, ragdolls, gore, hud, buttons, ballistics, input, setPlaying, CONFIG };
