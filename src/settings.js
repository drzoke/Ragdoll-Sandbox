// Player-facing settings, persisted in localStorage. Systems subscribe with onChange().
const KEY = 'ragdoll-sandbox-settings-v1';

const DEFAULTS = {
  graphics: 'medium',      // 'verylow' | 'low' | 'medium' | 'high' | 'ultra'
  dynamicRes: true,        // lower the resolution a little while the frame rate is low
  vsync: true,             // false: run frames as fast as possible (above the refresh rate)
  showOrgans: true,        // exposed organs + organ gibs
  bloodColor: 'red',       // 'red' | 'purple'
  dismemberment: true,     // severing + exploding body parts
  showControls: true,      // weapon controls panel on the left
  xrayMode: 'dynamic',     // 'dynamic' (3D) | 'flat' (still front-view diagram)
  // touch (phones / tablets)
  touchControls: 'auto',   // 'auto' (on for phones and tablets) | 'on' | 'off'
  touchLayout: 'optimal',  // 'optimal' | 'classic' | 'lefty' | 'custom'
  touchCustom: null,       // custom layout: { base, pos: { id: [x, y] } } (fractions of the screen)
  touchSens: 1,            // look sensitivity multiplier (0.3 .. 3)
  touchAimSens: 0.6,       // extra multiplier while aiming down sights
  touchButtonSize: 'medium', // 'small' | 'medium' | 'large'
  touchAim: 'toggle',      // 'toggle' | 'hold' (aim button)
  touchAutoSprint: true,   // push the stick all the way forward to sprint
  touchOpacity: 0.55,      // button opacity
  // spawn menu (remembered choices)
  spawnCount: 1,
  spawnHelmet: false,
  spawnVest: false,
  spawnWhere: 'look',      // 'look' | 'front' | 'spawn'
  spawnTemper: 'normal',   // 'brave' | 'normal' | 'timid' (V2 behaviour only)
  spawnBehavior: 'classic', // 'classic' | 'v2' (experimental: reacts to the player)
  spawnKind: 'ragdoll',    // 'ragdoll' | 'zombie' (spawn menu card)
  map: 'range',            // 'range' | 'tower'
};

// Hues (multiplied by a brightness): particle = shader colour, pool/decal/meat = linear material colours.
export const BLOOD_COLORS = {
  red: { particle: [1, 0.03, 0.035], pool: [1, 0.03, 0.03], decal: [1, 0.013, 0.013], meat: 0x6e0b0b, meatDark: 0x2a0303 },
  purple: { particle: [0.62, 0.12, 1.0], pool: [0.5, 0.06, 1.0], decal: [0.42, 0.03, 1.0], meat: 0x4a1270, meatDark: 0x1c0530 },
};

class Settings {
  constructor() {
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem(KEY) || '{}'); } catch { /* storage unavailable */ }
    this.values = { ...DEFAULTS, ...saved };
    this.listeners = [];
  }
  get(k) { return this.values[k]; }
  set(k, v) {
    if (this.values[k] === v) return;
    this.values[k] = v;
    try { localStorage.setItem(KEY, JSON.stringify(this.values)); } catch { /* ignore */ }
    for (const fn of this.listeners) fn(k, v);
  }
  onChange(fn) { this.listeners.push(fn); }
  get blood() { return BLOOD_COLORS[this.values.bloodColor] || BLOOD_COLORS.red; }
}

export const settings = new Settings();
