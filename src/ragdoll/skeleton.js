// Humanoid ragdoll layout. Built standing, facing +Z, feet at y = 0.
// The ragdoll's LEFT side is +X (it faces +Z), so side = +1 for left, -1 for right.
//
// size: full box extents [x, y, z] (sphere: [r]).  pos: centre in rest pose.
// joint: pivot (world, rest pose) to the parent; axis = rest direction from pivot towards the child;
// coneTilt rotates the allowed cone (pitch about X) so knees/elbows bend one way.
// twist: cannon measures it between the joint X axes, so a small value also blocks sideways
// bending; that is what turns knees/elbows into hinges.

const L = 1, R = -1;

function limbs(side) {
  const s = side === L ? 'L' : 'R';
  const x = 0.245 * side, hx = 0.095 * side;
  return [
    { name: `upperArm${s}`, label: `${side === L ? 'Left' : 'Right'} upper arm`, shape: 'box', size: [0.085, 0.27, 0.085], pos: [x, 1.405, 0], mass: 2.2, parent: 'chest',
      joint: { name: `shoulder${s}`, pivot: [x, 1.55, 0], axis: [0, -1, 0], coneTilt: -0.35, angle: 1.45, twist: 0.9, ball: 0.058 }, limb: `arm${s}`, side },
    { name: `lowerArm${s}`, label: `${side === L ? 'Left' : 'Right'} forearm`, shape: 'box', size: [0.075, 0.245, 0.075], pos: [x, 1.135, 0], mass: 1.5, parent: `upperArm${s}`,
      joint: { name: `elbow${s}`, pivot: [x, 1.265, 0], axis: [0, -1, 0], coneTilt: -1.05, angle: 1.12, twist: 0.2, ball: 0.047 }, limb: `arm${s}`, side },
    { name: `hand${s}`, label: `${side === L ? 'Left' : 'Right'} hand`, shape: 'box', size: [0.035, 0.12, 0.075], pos: [x, 0.93, 0], mass: 0.5, parent: `lowerArm${s}`,
      joint: { name: `wrist${s}`, pivot: [x, 0.998, 0], axis: [0, -1, 0], coneTilt: 0, angle: 0.75, twist: 0.6, ball: 0.034 }, limb: `arm${s}`, side },
    { name: `thigh${s}`, label: `${side === L ? 'Left' : 'Right'} thigh`, shape: 'box', size: [0.13, 0.39, 0.13], pos: [hx, 0.69, 0], mass: 8, parent: 'pelvis',
      joint: { name: `hip${s}`, pivot: [hx, 0.9, 0], axis: [0, -1, 0], coneTilt: -0.55, angle: 1.15, twist: 0.5, ball: 0.066 }, limb: `leg${s}`, side },
    { name: `shin${s}`, label: `${side === L ? 'Left' : 'Right'} shin`, shape: 'box', size: [0.1, 0.375, 0.1], pos: [hx, 0.27, 0], mass: 4, parent: `thigh${s}`,
      joint: { name: `knee${s}`, pivot: [hx, 0.475, 0], axis: [0, -1, 0], coneTilt: 1.0, angle: 1.06, twist: 0.2, ball: 0.056 }, limb: `leg${s}`, side },
    { name: `foot${s}`, label: `${side === L ? 'Left' : 'Right'} foot`, shape: 'box', size: [0.09, 0.06, 0.22], pos: [hx, 0.03, 0.045], mass: 1.2, parent: `shin${s}`,
      joint: { name: `ankle${s}`, pivot: [hx, 0.072, 0], axis: [0, -1, 0], coneTilt: 0, angle: 0.45, twist: 0.25, ball: 0.044 }, limb: `leg${s}`, side },
  ];
}

export const PARTS = [
  { name: 'pelvis', label: 'Pelvis', shape: 'box', size: [0.3, 0.16, 0.19], pos: [0, 0.98, 0], mass: 10, parent: null, limb: 'torso', side: 0 },
  { name: 'abdomen', label: 'Abdomen', shape: 'box', size: [0.28, 0.2, 0.17], pos: [0, 1.17, 0], mass: 9, parent: 'pelvis',
    joint: { name: 'lowerSpine', pivot: [0, 1.065, 0], axis: [0, 1, 0], coneTilt: 0, angle: 0.4, twist: 0.35, ball: 0.07 }, limb: 'torso', side: 0 },
  { name: 'chest', label: 'Chest', shape: 'box', size: [0.36, 0.28, 0.21], pos: [0, 1.43, 0], mass: 14, parent: 'abdomen',
    joint: { name: 'upperSpine', pivot: [0, 1.28, 0], axis: [0, 1, 0], coneTilt: 0, angle: 0.35, twist: 0.3, ball: 0.075 }, limb: 'torso', side: 0 },
  { name: 'head', label: 'Head', shape: 'sphere', size: [0.105], pos: [0, 1.73, 0.005], mass: 5, parent: 'chest',
    joint: { name: 'neck', pivot: [0, 1.6, 0], axis: [0, 1, 0], coneTilt: 0, angle: 0.65, twist: 0.8, ball: 0.055 }, limb: 'head', side: 0 },
  ...limbs(L),
  ...limbs(R),
];

export const PART_BY_NAME = Object.fromEntries(PARTS.map((p) => [p.name, p]));

/** Child lists, used to work out what comes off with a severed limb. */
export function descendants(name) {
  const out = [];
  const walk = (n) => { for (const p of PARTS) if (p.parent === n) { out.push(p.name); walk(p.name); } };
  walk(name);
  return out;
}
