# Ragdoll Sandbox (draft)

**Play:** https://drzoke.github.io/ragdoll-sandbox/

![screenshot](screenshot.png)

A first-person physics sandbox: humanoid ragdolls, an M1911 pistol, and a dynamic damage / gore / physiology model.
Built with **three.js r187** and **cannon-es 0.20**. Both are bundled locally in `lib/`, so it needs no internet.

## Running it

ES modules don't load from `file://`, so serve the folder with any static server:

```bash
cd ragdoll-sandbox
python3 -m http.server 8000      # or: npx serve .
# open http://localhost:8000
```

## Controls

| Key | Action |
| --- | --- |
| WASD | Move |
| Mouse | Look |
| Shift | Sprint |
| Space | Jump |
| C (hold) | Crouch |
| Left click | Fire |
| Right click (hold) | Aim down sights |
| R | Reload (tactical, or slide-lock reload when empty) |
| F | Inspect pistol |
| E | Press the button you're looking at |
| X | Toggle the X-ray / vitals panel |
| F3 | Debug overlay |
| Esc | Pause |

There are two buttons next to the spawn point: **RESPAWN** (new ragdoll) and **CLEAN UP** (removes blood, gibs and casings). Shooting a button also presses it.

## What's in it

- **Ragdolls**: 16 rigid bodies (gray segments) joined by cone-twist joints (black balls). Knees and elbows act as hinges. "Muscles" are velocity servos that pull each segment towards a target pose. While walking, the hips are held up and the feet step to target positions.
- **Behaviour** (`ragdoll/brain.js`): idle and short wanders around home → limping (one leg hurt) → falls when support is lost → gets back up if it can, otherwise **crawls** (both legs out) or **writhes** on the ground in pain → unconscious → dead. It also hunches and clutches wounds when hurt, and shivers when in shock.
- **Damage** (`ragdoll/health.js` + `ragdoll/anatomy.js`): each hit is ray-traced through the body part in local space against organs (ellipsoids), arteries and bones (capsules), and rib cage/skull/pelvis shells. Bullets can pass through limbs into the next part. Outcomes include fractures, a shattered bone, severed arteries, destroyed organs, spinal injury (paralysis), a torso torn open (exposed organs) and limb loss.
- **Physiology**: blood volume, bleeding with clotting, arterial pressure, heart rate, SpO₂, breathing, pain (adrenaline masks it), hypovolemic shock classes, consciousness, cardiac arrest and brain death. Nothing dies instantly: even a brain hit or decapitation takes seconds.
- **Gore** (`gore/`): blood particles that pool on the floor (instanced decals that grow and darken), arterial spurts that pulse with the heartbeat, entry and exit wound decals with blood runs, stumps with bone, exposed intestines, ribs and brain, and physical gibs.
- **M1911** (`weapon/`): procedural model (extruded slide/frame profiles, checkered wood grips, hammer, sights, mag). Recoil uses camera springs plus partial permanent muzzle climb, and the viewmodel kicks and flips around the grip. The slide cycles, the hammer drops and re-cocks, the slide locks back on empty, casings eject, and there's a muzzle flash and light. Reload (tactical and empty) and inspect are keyframed clips in `weapon/anim.js`.
- **X-ray panel** (`ui/xray.js`, `ui/hud.js`): a second renderer draws the targeted ragdoll's bones, organs, arteries and wounds on their own render layer, colour-coded by damage. The panel also shows vitals bars, an ECG trace, damaged bones and organs, and an event log.
- **Player** (`player/controller.js`): kinematic controller with acceleration and friction, step-up, coyote time, jump buffering, crouch with head clearance, head bob, strafe tilt, landing dip and sprint FOV. A kinematic physics body follows you, so you shove ragdolls.
- **Map** (`world/map.js`): 4 m prototype-grid concrete floor, gray sky and fog, a few test blocks, and invisible walls at ±45 m.

## Layout

```
index.html, css/style.css
lib/                     three.js, cannon-es, two three addons
src/main.js              boot + game loop
src/config.js            every tunable number lives here
src/core/                input, physics wrapper (fixed 120 Hz step), procedural audio, utils
src/world/               map, physical buttons
src/player/              first-person controller + camera effects
src/weapon/              M1911 model, animation clips, weapon logic, ballistics, casings
src/ragdoll/             skeleton layout, anatomy data, health/physiology, brain/AI, ragdoll body, manager
src/gore/                particles, decals/pools, gore orchestration (stumps, organs, gibs, bleeding)
src/ui/                  HUD + X-ray
```

## Extending

- **More ragdolls**: `ragdolls.spawn([x, 0, z], yaw)` in `main.js`. The respawn button resets to one.
- **New weapon**: copy `weapon/pistol.js`, give it a model and clips, and point `onFire` at `Ballistics.fire`. Damage scales with the `energy` argument passed to `Health.bulletHit`.
- **New organ or bone**: add it to `ragdoll/anatomy.js` (local coordinates). Hit testing, the X-ray and the HUD lists pick it up automatically.
- **Tuning**: `config.js` (movement, recoil, blood limits, physiology timings). Muscle gains are `KP`/`KD` in `Ragdoll.applyMuscles`, and gait shapes are in `Brain.updateStand`.
- **Debugging**: `window.game` exposes every system, and `game.debug.timeScale = 0` freezes the simulation.

## Known limits of this draft

- Walking is an "active ragdoll puppet" (hips held up, feet stepped to targets), not a balance controller. It looks right at walking speed, but a big shove makes it fall rather than catch itself.
- Wound decals are flat quads, so on very curved spots they can sit slightly off the surface.
- Sounds are synthesized placeholders.
- No hands or arms on the viewmodel yet.
