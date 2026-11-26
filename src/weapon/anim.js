// Tiny keyframe animation system for procedural viewmodel animations.
// A Clip has named tracks: [[time, value], ...] where value is a number or [x, y, z],
// plus events: [[time, 'name'], ...] fired once when playback crosses them.

const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2); // easeInOutCubic

export class Clip {
  constructor(name, duration, tracks, events = []) {
    this.name = name; this.duration = duration; this.tracks = tracks; this.events = events;
  }

  sample(track, t, fallback = 0) {
    const keys = this.tracks[track];
    if (!keys || !keys.length) return fallback;
    if (t <= keys[0][0]) return keys[0][1];
    for (let i = 1; i < keys.length; i++) {
      if (t <= keys[i][0]) {
        const [t0, a] = keys[i - 1], [t1, b] = keys[i];
        const u = ease((t - t0) / Math.max(1e-6, t1 - t0));
        if (Array.isArray(a)) return a.map((v, k) => v + (b[k] - v) * u);
        return a + (b - a) * u;
      }
    }
    return keys[keys.length - 1][1];
  }
}

export class ClipPlayer {
  constructor() { this.clip = null; this.time = 0; this.onEvent = null; }
  play(clip, onEvent) { this.clip = clip; this.time = 0; this.onEvent = onEvent; }
  get playing() { return !!this.clip; }
  stop() { this.clip = null; }
  update(dt) {
    if (!this.clip) return;
    const prev = this.time;
    this.time += dt;
    for (const [et, name] of this.clip.events) if (et > prev && et <= this.time) this.onEvent?.(name);
    if (this.time >= this.clip.duration) { const done = this.clip; this.clip = null; this.onEvent?.('end', done); }
  }
  sample(track, fallback) { return this.clip ? this.clip.sample(track, this.time, fallback) : fallback; }
}

const Z3 = [0, 0, 0];
// Reload pose: gun raised, rolled so the magazine well faces the camera.
const R_POS = [-0.07, 0.095, 0.02], R_BUMP = [-0.07, 0.108, 0.02];
const R_ROT = [0.22, 0.18, -0.55], R_ROTB = [0.28, 0.18, -0.58];

export const CLIPS = {
  reload: new Clip('reload', 1.7, {
    pos: [[0, Z3], [0.22, R_POS], [1.12, R_POS], [1.18, R_BUMP], [1.3, R_POS], [1.62, Z3]],
    rot: [[0, Z3], [0.22, R_ROT], [1.12, R_ROT], [1.18, R_ROTB], [1.3, R_ROT], [1.62, Z3]],
    mag: [[0, 0], [0.3, 0], [0.44, 1.4], [0.45, 3.6], [0.6, 3.6], [0.75, 2.6], [1.05, 0.3], [1.15, 0]],
  }, [[0.3, 'magOut'], [1.15, 'magIn'], [1.55, 'done']]),

  reloadEmpty: new Clip('reloadEmpty', 2.05, {
    pos: [[0, Z3], [0.22, R_POS], [1.12, R_POS], [1.18, R_BUMP], [1.3, [-0.04, 0.05, 0.02]],
      [1.45, [-0.03, 0.04, 0.02]], [1.52, [-0.03, 0.055, 0.035]], [1.95, Z3]],
    rot: [[0, Z3], [0.22, R_ROT], [1.12, R_ROT], [1.18, R_ROTB], [1.3, [0.15, 0.1, -0.3]],
      [1.45, [0.1, 0.08, -0.2]], [1.52, [0.25, 0.08, -0.22]], [1.95, Z3]],
    mag: [[0, 0], [0.3, 0], [0.44, 1.4], [0.45, 3.6], [0.6, 3.6], [0.75, 2.6], [1.05, 0.3], [1.15, 0]],
    slide: [[0, 1], [1.46, 1], [1.5, 0]],
  }, [[0.3, 'magOut'], [1.15, 'magIn'], [1.47, 'slideRelease'], [1.9, 'done']]),

  inspect: new Clip('inspect', 3.5, {
    pos: [[0, Z3], [0.5, [-0.11, 0.055, 0.07]], [1.4, [-0.105, 0.06, 0.07]], [1.95, [-0.1, 0.07, 0.03]], [2.95, [-0.1, 0.075, 0.03]], [3.45, Z3]],
    rot: [[0, Z3], [0.5, [0.12, 0.95, 0.35]], [1.4, [0.2, 1.05, 0.28]], [1.95, [-0.05, -0.95, -0.12]], [2.95, [0.0, -0.88, -0.1]], [3.45, Z3]],
    slide: [[0, 0], [2.25, 0], [2.4, 0.38], [2.7, 0.38], [2.8, 0]],
  }, [[2.26, 'slideBack'], [2.8, 'click']]),
};

// Left-hand tracks (named targets, see arms.js sampleHand): the support hand lets go, fetches a
// fresh magazine from the belt, pushes it home and racks or releases the slide.
CLIPS.reload.lh = [[0, 'support'], [0.24, 'support'], [0.5, 'pouch'], [0.74, 'mag'], [1.16, 'mag'], [1.45, 'support']];
CLIPS.reloadEmpty.lh = [[0, 'support'], [0.24, 'support'], [0.5, 'pouch'], [0.74, 'mag'], [1.16, 'mag'], [1.32, 'slide'], [1.5, 'slide'], [1.85, 'support']];
CLIPS.inspect.lh = [[0, 'support'], [0.3, 'support'], [0.62, 'low'], [1.9, 'low'], [2.18, 'slide'], [2.82, 'slide'], [3.45, 'support']];
