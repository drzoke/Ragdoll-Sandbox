# Ragdoll Sandbox (draft)

**Play:** https://drzoke.github.io/Ragdoll-Sandbox/

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
| C (hold) | Crouch (Ctrl also works in fullscreen on Chrome/Edge) |
| 1 – 5 or Q | Switch item (Fists, M1911, Remington 870, Grenade, Grab) |
| Mouse wheel | Switch item (with Grab: move what you're holding closer or farther) |
| Tab | Open the toolbox |
| Z | Slow time down (down to 0.01×) |
| V | Speed time up (up to 3×) |
| E | Press the button you're looking at |
| X | Toggle the X-ray / vitals panel |
| Shift + X | Switch the X-ray between Dynamic (3D) and Flat |
| H | Hide the tool controls list on the left |
| F3 | Debug overlay |
| Esc | Pause (menu has Settings) |

You see your own blocky, Roblox-style hands holding every item. They follow the item through every animation: the support hand fetches a fresh magazine and racks the slide on the M1911, works the pump and loads shells one by one on the shotgun, and pulls the grenade pin.

**Fists:** left click throws quick jabs (left, right, left…), right click a slower, much harder hook. Punches leave purple bruises, make the ragdoll stagger, and a hook to the head can knock it down or out (and give it a bloody nose).

**M1911:** left click fires, right click (hold) aims down sights, R reloads, F inspects.

**Remington 870:** left click fires 8 pellets and the gun pumps itself (the spent red shell flies out). Right click aims, R loads shells one at a time into the tube (6 plus one in the chamber; fire to stop loading early), F inspects. Pellets that stop inside the body still blow blood out of the far side, so a ragdoll shot with its back to a wall paints the wall behind it.

**Grenade:** left click pulls the pin and throws it overhand, right click lobs it underhand. The spoon flies off and the grenade goes off 3 seconds later (in world time, so slow motion stretches the fuse). Shooting a live grenade sets it off. The explosion has a flash, a fireball, black smoke, a dust ring, sparks and shrapnel, throws ragdolls, breaks bones, bruises and blackens them with soot, can blow off limbs (if dismemberment is on), and leaves black scorch marks on the floor and nearby walls.

**Grab:** right click grabs or drops a body part (or a gib), left click throws what you hold or pushes things in front of you away, and the wheel or R / F pulls it closer or pushes it away. Whatever you hold gets a white outline. The held point trails your aim, and the farther away it is the more it lags. Slamming a ragdoll into the floor or walls breaks bones. A held ragdoll curls up into a fetal position.

Switching items plays a draw animation: the tool comes up from below, rises a little past its resting spot, then settles.

**Toolbox (Tab):** a square window listing every item in a scrolling grid, with categories on the right (All, Weapons, Tools; Fists, M1911, Remington 870 and Grenade are weapons, Grab is a tool). Click an item, or press its number, to equip it. Item previews follow the graphics preset: a picture on Low, a spinning 3D model on Medium, and a spinning model with its own effects (the pistol cycles and flashes, the grab tool pulses) on High and Very High, plus a glossy reflection on Very High.

There are two buttons next to the spawn point: **RESPAWN** (new ragdoll) and **CLEAN UP** (removes blood, scorch marks, gibs, casings, shells and live grenades). Shooting a button also presses it.

## Settings

- **Graphics**
  - **Low**: no shadows, lower resolution, fewer blood drops, flatter materials.
  - **Medium**: sharp sun shadows, full resolution.
  - **High**: soft 4096 shadows, GTAO ambient occlusion, bloom, dirt and wear on models, a brighter grab beam.
  - **Very High**: everything in High, plus screen-space reflections on the floor, normal-mapped surface detail, stronger reflections and a wide glow around the grab beam.
- **Gore**: organs on or off, red or purple blood, dismemberment and exploding body parts on or off.
- **HUD**: show or hide the tool controls list, and pick the X-ray view: **Dynamic** (a 3D x-ray that turns with the ragdoll) or **Flat** (a still front-view picture of the skeleton and organs showing the same damage).

Settings are saved in the browser (localStorage).

| Preset | Minimum GPU | Recommended GPU |
| --- | --- | --- |
| Low | Any graphics chip from the last 10 years (Intel HD 4000, Chromebooks) | Intel UHD 620 |
| Medium | Intel UHD 620 / AMD Radeon Vega 8 | Intel Iris Xe / NVIDIA GTX 1050 |
| High | NVIDIA GTX 1050 Ti / AMD RX 570 | NVIDIA GTX 1660 / AMD RX 5600 XT |
| Very High | NVIDIA GTX 1660 Super / AMD RX 5600 XT | NVIDIA RTX 3060 / AMD RX 6700 XT |

## What's in it

- **Ragdolls**: 16 rigid bodies (gray segments) joined by cone-twist joints (black balls). Knees and elbows act as hinges. "Muscles" are velocity servos that pull each segment towards a target pose. While walking, the hips are held up and the feet step to target positions.
- **Behaviour** (`ragdoll/brain.js`): idle and short wanders around home → limping (one leg hurt) → falls when support is lost → gets back up if it can, otherwise **crawls** (both legs out) or **writhes** on the ground in pain → unconscious → dead. It also hunches and clutches wounds when hurt, and shivers when in shock.
- **Damage** (`ragdoll/health.js` + `ragdoll/anatomy.js`): each hit is ray-traced through the body part in local space against organs (ellipsoids), arteries and bones (capsules), and rib cage/skull/pelvis shells. Bullets can pass through limbs into the next part. Outcomes include fractures, a shattered bone, severed arteries, destroyed organs, spinal injury (paralysis), a torso torn open (exposed organs) and limb loss.
- **Physiology**: blood volume, bleeding with clotting, arterial pressure, heart rate, SpO₂, breathing, pain (adrenaline masks it), hypovolemic shock classes, consciousness, cardiac arrest and brain death. Nothing dies instantly: even a brain hit or decapitation takes seconds.
- **Exploding parts**: keep shooting a destroyed body part and it bursts. Heads and limbs vanish in a spray of blood, bone and flesh chunks (limbs below it fall off), and torso parts are gutted in place.
- **Bullets** (`weapon/ballistics.js`): real projectiles at 260 m/s with drop and penetration, a tracer streak and a glowing slug, so in slow motion you can see them travel and hit.
- **Grab tool** (`weapon/grab.js`): a force-limited joint to a kinematic anchor that trails the aim point, a pulsing white beam drawn as a camera-facing Bézier ribbon, throw, punt and drop. Collisions on every body part feed blunt trauma and bone breaks (`Health.impact`).
- **Blood on walls** (`gore/particles.js`, `gore/decals.js`): blood drops that fly into the side of a wall or block leave splats stretched in the direction they were flying, and once enough blood collects it runs down the wall. Bullets that already passed through someone carry blood to the wall or floor they hit.
- **Bruises** (`Gore.addBruise`): punches, hard landings, slams with the grab tool and blasts leave purple bruises that come up over a second or two, merge when they overlap and darken from red-purple to deep purple. Blasts also leave black soot on the body.
- **Gore** (`gore/`): blood particles that pool on the floor (instanced decals that grow and darken), arterial spurts that pulse with the heartbeat, entry and exit wound decals with blood runs, stumps with bone, exposed intestines, ribs and brain, and physical gibs.
- **Hands** (`weapon/arms.js`): box hands, forearms and sleeves placed on anchor points on each item; animation clips can move a hand between named targets (grip, pump, magazine, loading port, belt pouch).
- **Remington 870** (`weapon/model870.js`, `weapon/shotgun.js`): procedural receiver, barrel, magazine tube, ribbed walnut pump, stock with recoil pad, bead sight and red 12 gauge shells. Pellets are ordinary projectiles with lower energy and a shared shot (four or more pellets in one ragdoll knock it down).
- **Grenades** (`weapon/grenadeModel.js`, `weapon/grenade.js`, `weapon/explosives.js`): physics ball with bounce sounds and a fuse smoke wisp; the explosion handles blast falloff with cover (walls block it), knockback, `Health.blast`, shrapnel through the normal bullet system, scorch decals, and camera shake.
- **Fists** (`weapon/fists.js`): raycast punches with impulse, `Health.punch` (pain, knockouts, nose bleeds, rare fractures) and bruises.
- **M1911** (`weapon/`): procedural model (extruded slide/frame profiles, checkered wood grips, hammer, sights, mag). Recoil uses camera springs plus partial permanent muzzle climb, and the viewmodel kicks and flips around the grip. The slide cycles, the hammer drops and re-cocks, the slide locks back on empty, casings eject, and there's a muzzle flash, a side flame and a light. Reload (tactical and empty) and inspect are keyframed clips in `weapon/anim.js`.
- **X-ray panel** (`ui/xray.js`, `ui/hud.js`): Dynamic mode uses a second renderer to draw the targeted ragdoll's bones, organs, arteries and wounds on their own render layer, colour-coded by damage. Flat mode draws the same anatomy and damage as a still, front-on diagram on a 2D canvas (fractures get a crack mark, severed parts are dashed). The panel also shows vitals bars, an ECG trace, damaged bones and organs, and an event log.
- **Player** (`player/controller.js`): kinematic controller with acceleration and friction, step-up, coyote time, jump buffering, crouch with head clearance, head bob, strafe tilt, landing dip and sprint FOV. A kinematic physics body follows you, so you shove ragdolls.
- **Map** (`world/map.js`): 4 m prototype-grid concrete floor, gray sky and fog, a few test blocks, and invisible walls at ±45 m.

## Layout

```
index.html, css/style.css
lib/                     three.js, cannon-es, three addons (post-processing etc.)
src/main.js              boot + game loop
src/config.js            every tunable number lives here
src/core/                input, physics wrapper (fixed 120 Hz step), procedural audio, utils
src/world/               map, physical buttons
src/player/              first-person controller + camera effects
src/weapon/              items (fists, M1911, Remington 870, grenade, grab tool), their models, hands, animation clips, ballistics, explosives, casings, toolbox
src/settings.js          saved player settings (graphics, gore, HUD)
src/graphics.js          Low / Medium / High / Very High presets and post-processing
src/materials.js         material detail (grime, wear, normal maps) per preset
src/ui/preview.js        spinning item previews for the toolbox
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
