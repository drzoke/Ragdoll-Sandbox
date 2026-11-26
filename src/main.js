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

// ------------------------------------------------------------------ renderer / scene
const canvas = document.getElementById('game');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
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
const map = new GameMap(scene, physics, renderer);
const player = new PlayerController(camera, map, physics);
const gore = new Gore(scene, physics, map, audio);
const ragdolls = new RagdollManager(scene, physics, gore);
const hud = new HUD(scene);

const buttons = [
  new PressButton({ scene, physics, map, position: [-3, 0, 4], label: 'RESPAWN', sub: 'Press E · new ragdoll', color: 0xd8302a,
    onPress: () => { audio.play('button'); ragdolls.respawn(); pistol.refill(); hud.toast('Ragdoll respawned'); } }),
  new PressButton({ scene, physics, map, position: [-4.2, 0, 4], label: 'CLEAN UP', sub: 'Press E · blood & gibs', color: 0x2a7bd8,
    onPress: () => { audio.play('button'); gore.clear(); pistol.casings.clear(); hud.toast('Cleaned up'); } }),
];

const ballistics = new Ballistics({ ragdolls, gore, map, buttons, audio, hud });
const pistol = new Pistol({
  mainScene: scene, mainCamera: camera, player, audio, environment: scene.environment,
  onFire: (o, d) => ballistics.fire(o, d),
});

ragdolls.spawn();

// ------------------------------------------------------------------ menu / pointer lock
const menu = document.getElementById('menu');
const lockWarn = document.getElementById('lockwarn');
let playing = false;
let freeMouse = false; // fallback when pointer lock is unavailable (e.g. sandboxed iframe)

function setPlaying(p) {
  playing = p;
  input.enabled = p;
  menu.classList.toggle('hidden', p);
  if (!p) input.clear();
}

document.getElementById('play').addEventListener('click', async () => {
  audio.unlock();
  try {
    const req = canvas.requestPointerLock();
    if (req && req.then) await req;
    freeMouse = false;
  } catch {
    freeMouse = true;
    lockWarn.classList.remove('hidden');
    setPlaying(true);
  }
});
document.addEventListener('pointerlockchange', () => {
  if (document.pointerLockElement === canvas) setPlaying(true);
  else if (!freeMouse) setPlaying(false);
});
document.addEventListener('pointerlockerror', () => { freeMouse = true; lockWarn.classList.remove('hidden'); setPlaying(true); });
addEventListener('keydown', (e) => {
  if (e.code === 'Escape' && freeMouse && playing) setPlaying(false);
});
// Safety net: browsers won't let a page block Ctrl+W, but they will ask before closing it.
addEventListener('beforeunload', (e) => { if (playing) { e.preventDefault(); e.returnValue = ''; } });

// ------------------------------------------------------------------ resize
function resize() {
  const w = innerWidth, h = innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h; camera.updateProjectionMatrix();
  pistol.resize(w / h);
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

  player.update(dt, input, playing);
  physics.update(dt);
  ragdolls.update(dt);
  pistol.update(dt, input, playing);
  gore.update(dt, camera, renderer.domElement.height);
  map.update(player.pos);
  updateInteraction(dt);

  const viewerPos = camera.getWorldPosition(new THREE.Vector3());
  const r0 = target;
  hud.update(dt, {
    pistol, player, target, viewerPos,
    debugText: debugOn ? [
      `fps ${fps.toFixed(0)}`,
      `pos ${player.pos.x.toFixed(2)} ${player.pos.y.toFixed(2)} ${player.pos.z.toFixed(2)}  speed ${player.speed2D.toFixed(2)}`,
      `particles ${gore.particles.alive.size}  pools ${gore.decals.pools.length}  gibs ${gore.gibs.length}`,
      r0 ? `${r0.name}: ${r0.brain.state} / ${r0.brain.activity}  pelvis y ${r0.pelvis.position.y.toFixed(2)}` : '',
      `pistol ${pistol.state}  mag ${pistol.mag}  chamber ${pistol.chambered}`,
    ].join('\n') : null,
  });

  renderer.clear();
  renderer.render(scene, camera);
  renderer.clearDepth();
  renderer.render(pistol.scene, pistol.camera);
  input.endFrame();
}
frame();

// Exposed for debugging from the console and for automated tests.
window.game = { debug, THREE, scene, camera, renderer, physics, player, pistol, ragdolls, gore, hud, buttons, ballistics, input, setPlaying, CONFIG };
