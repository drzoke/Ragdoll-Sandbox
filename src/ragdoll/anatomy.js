// Anatomy data in each body part's LOCAL space (origin = part centre, +Z = front, +X = ragdoll's left).
//
// organs:   ellipsoids  { id, name, c:[x,y,z], r:[rx,ry,rz], hp, bleed (ml/s when hit), vital, color }
// vessels:  capsules    { id, name, a:[..], b:[..], r, bleed (ml/s arterial) }
// bones:    capsules    { id, name, a, b, r }   (shell:true = rib cage / skull style, hit chance on entry)
//
// Numbers are game-balanced, loosely based on real anatomy.

const side = (s) => (s === 'L' ? 1 : -1);
const sideName = (s) => (s === 'L' ? 'Left' : 'Right');

function arm(s) {
  const x = side(s), n = sideName(s);
  return {
    [`upperArm${s}`]: {
      tissue: 100,
      bones: [{ id: `humerus${s}`, name: `${n} humerus`, a: [0, -0.12, 0], b: [0, 0.12, 0], r: 0.014 }],
      vessels: [{ id: `brachial${s}`, name: `${n} brachial artery`, a: [-0.02 * x, -0.12, 0.012], b: [-0.02 * x, 0.12, 0.012], r: 0.007, bleed: 9 }],
      organs: [],
    },
    [`lowerArm${s}`]: {
      tissue: 90,
      bones: [{ id: `radius${s}`, name: `${n} radius/ulna`, a: [0, -0.11, 0], b: [0, 0.11, 0], r: 0.013 }],
      vessels: [{ id: `radial${s}`, name: `${n} radial artery`, a: [-0.01 * x, -0.11, 0.022], b: [-0.01 * x, 0.11, 0.022], r: 0.005, bleed: 4 }],
      organs: [],
    },
    [`hand${s}`]: {
      tissue: 60,
      bones: [{ id: `hand${s}`, name: `${n} hand bones`, a: [0, -0.05, 0], b: [0, 0.05, 0], r: 0.02 }],
      vessels: [], organs: [],
    },
  };
}

function leg(s) {
  const x = side(s), n = sideName(s);
  return {
    [`thigh${s}`]: {
      tissue: 130,
      bones: [{ id: `femur${s}`, name: `${n} femur`, a: [0, -0.18, 0], b: [0, 0.18, 0], r: 0.019 }],
      vessels: [{ id: `femoral${s}`, name: `${n} femoral artery`, a: [-0.028 * x, -0.15, 0.03], b: [-0.028 * x, 0.18, 0.03], r: 0.009, bleed: 16 }],
      organs: [],
    },
    [`shin${s}`]: {
      tissue: 100,
      bones: [{ id: `tibia${s}`, name: `${n} tibia`, a: [0, -0.17, 0.018], b: [0, 0.17, 0.018], r: 0.017 }],
      vessels: [{ id: `tibial${s}`, name: `${n} tibial artery`, a: [0, -0.16, -0.02], b: [0, 0.16, -0.02], r: 0.005, bleed: 4 }],
      organs: [],
    },
    [`foot${s}`]: {
      tissue: 60,
      bones: [{ id: `foot${s}`, name: `${n} foot bones`, a: [0, 0, -0.08], b: [0, 0, 0.09], r: 0.022 }],
      vessels: [], organs: [],
    },
  };
}

export const ANATOMY = {
  head: {
    tissue: 120,
    bones: [{ id: 'skull', name: 'Skull', shell: true, chance: 0.95 }],
    vessels: [
      { id: 'carotidL', name: 'Left carotid artery', a: [0.035, -0.1, 0.03], b: [0.035, -0.06, 0.03], r: 0.011, bleed: 18 },
      { id: 'carotidR', name: 'Right carotid artery', a: [-0.035, -0.1, 0.03], b: [-0.035, -0.06, 0.03], r: 0.011, bleed: 18 },
    ],
    organs: [
      { id: 'brain', name: 'Brain', c: [0, 0.02, -0.005], r: [0.075, 0.06, 0.085], hp: 100, bleed: 2.5, vital: true, color: 0xff9db0 },
    ],
  },
  chest: {
    tissue: 160,
    bones: [
      { id: 'ribs', name: 'Rib cage', shell: true, chance: 0.55 },
      { id: 'tspine', name: 'Thoracic spine', a: [0, -0.13, -0.08], b: [0, 0.13, -0.08], r: 0.022, spine: true },
    ],
    vessels: [{ id: 'aorta', name: 'Aorta', a: [0.01, -0.13, -0.035], b: [0.01, 0.1, -0.02], r: 0.013, bleed: 45 }],
    organs: [
      { id: 'heart', name: 'Heart', c: [0.03, -0.015, 0.025], r: [0.045, 0.055, 0.045], hp: 100, bleed: 35, vital: true, color: 0xff3b4e },
      { id: 'lungL', name: 'Left lung', c: [0.09, 0.02, -0.005], r: [0.06, 0.1, 0.07], hp: 100, bleed: 3.5, vital: true, color: 0xffb0c0 },
      { id: 'lungR', name: 'Right lung', c: [-0.085, 0.02, -0.005], r: [0.065, 0.1, 0.07], hp: 100, bleed: 3.5, vital: true, color: 0xffb0c0 },
    ],
  },
  abdomen: {
    tissue: 140,
    bones: [{ id: 'lspine', name: 'Lumbar spine', a: [0, -0.1, -0.065], b: [0, 0.1, -0.065], r: 0.022, spine: true }],
    vessels: [{ id: 'abAorta', name: 'Abdominal aorta', a: [0.008, -0.1, -0.035], b: [0.008, 0.1, -0.035], r: 0.011, bleed: 35 }],
    organs: [
      { id: 'liver', name: 'Liver', c: [-0.06, 0.05, 0.012], r: [0.08, 0.045, 0.062], hp: 100, bleed: 7, vital: true, color: 0x9b2d2d },
      { id: 'stomach', name: 'Stomach', c: [0.06, 0.04, 0.025], r: [0.05, 0.04, 0.045], hp: 100, bleed: 2.5, color: 0xe8a0a0 },
      { id: 'spleen', name: 'Spleen', c: [0.095, 0.055, -0.03], r: [0.028, 0.035, 0.03], hp: 100, bleed: 6, color: 0x8c3a6a },
      { id: 'kidneyL', name: 'Left kidney', c: [0.065, 0.0, -0.05], r: [0.026, 0.042, 0.022], hp: 100, bleed: 4.5, color: 0xb04848 },
      { id: 'kidneyR', name: 'Right kidney', c: [-0.065, -0.005, -0.05], r: [0.026, 0.042, 0.022], hp: 100, bleed: 4.5, color: 0xb04848 },
      { id: 'intestines', name: 'Intestines', c: [0, -0.045, 0.03], r: [0.11, 0.055, 0.05], hp: 100, bleed: 2, color: 0xf0b2a0 },
    ],
  },
  pelvis: {
    tissue: 150,
    bones: [{ id: 'pelvisBone', name: 'Pelvis', shell: true, chance: 0.6 }],
    vessels: [
      { id: 'iliacL', name: 'Left iliac artery', a: [0.06, 0.06, 0.0], b: [0.09, -0.07, 0.03], r: 0.009, bleed: 18 },
      { id: 'iliacR', name: 'Right iliac artery', a: [-0.06, 0.06, 0.0], b: [-0.09, -0.07, 0.03], r: 0.009, bleed: 18 },
    ],
    organs: [
      { id: 'bladder', name: 'Bladder', c: [0, -0.02, 0.045], r: [0.04, 0.035, 0.035], hp: 100, bleed: 1.5, color: 0xe8d090 },
    ],
  },
  ...arm('L'), ...arm('R'), ...leg('L'), ...leg('R'),
};

/** Flat list of all bones across the body with their part, for UI. */
export function allBones() {
  const out = [];
  for (const [part, a] of Object.entries(ANATOMY)) for (const b of a.bones) out.push({ ...b, part });
  return out;
}
export function allOrgans() {
  const out = [];
  for (const [part, a] of Object.entries(ANATOMY)) for (const o of a.organs) out.push({ ...o, part });
  return out;
}
