/**
 * The loading screen for going into and out of VS Undead: building the Dead Field and getting its
 * shaders ready takes a moment, so instead of a frozen picture you get a screen with a progress bar
 * and a tip while it happens.
 *
 * run(opts, work): shows the screen, lets it paint, does the work, compiles the shaders for what's
 * now in the scene (without freezing, where the browser can), draws one frame behind the screen,
 * then fades it out.
 */
const TIPS = [
  'Headshots put zombies down fast. Body shots take a lot more.',
  'Every third wave is a boss: the Big Brute.',
  'The Big Brute raises the dead around it. Kill it and they drop too.',
  'Press I for your inventory: armour, ammo, points and items.',
  'The merchant comes after every wave. Press E on him to trade.',
  'Supply crates come down on parachutes. Press E to open one.',
  'Press G when you are ready for the next wave.',
  'A sentry gun aims for heads. Mines go off when the dead walk near.',
  'Zombies get faster and tougher every wave.',
];
const frame = () => new Promise((r) => requestAnimationFrame(() => r()));

export class LoadingScreen {
  constructor({ renderer, scene, camera, tools }) {
    this.renderer = renderer; this.scene = scene; this.camera = camera; this.tools = tools;
    const el = this.el = document.createElement('div');
    el.id = 'vs-load'; el.className = 'hidden';
    el.innerHTML = `<div class="vl-fog"></div><div class="vl-card">
      <div class="vl-title">VS <b>Undead</b></div><div class="vl-sub"></div>
      <div class="vl-bar"><i></i></div><div class="vl-row"><span class="vl-step"></span><span class="vl-pct"></span></div>
      <div class="vl-tip"></div></div>`;
    document.body.appendChild(el);
    this.busy = false;
  }

  set(p, step) {
    this.p = Math.max(this.p || 0, p);
    this.el.querySelector('.vl-bar i').style.width = `${Math.round(this.p * 100)}%`;
    this.el.querySelector('.vl-pct').textContent = `${Math.round(this.p * 100)}%`;
    if (step) this.el.querySelector('.vl-step').textContent = step;
  }

  show({ title = 'VS <b>Undead</b>', sub = '', tip = true } = {}) {
    const el = this.el;
    this.p = 0;
    el.querySelector('.vl-title').innerHTML = title;
    el.querySelector('.vl-sub').textContent = sub;
    el.querySelector('.vl-tip').textContent = tip ? `Tip: ${TIPS[Math.floor(Math.random() * TIPS.length)]}` : '';
    el.classList.remove('hidden', 'out');
    this.set(0.05, 'Starting');
  }

  hide() {
    this.set(1, 'Ready');
    this.el.classList.add('out');
    clearTimeout(this.hideT);
    this.hideT = setTimeout(() => { if (!this.busy) this.el.classList.add('hidden'); }, 450);
  }

  /** Get the shaders for everything in view ready now, rather than in the middle of the first frames. */
  async compile() {
    const r = this.renderer;
    try {
      if (r.compileAsync) await r.compileAsync(this.scene, this.camera);
      else r.compile(this.scene, this.camera);
    } catch { /* optional */ }
  }

  async run(opts, work, steps = []) {
    if (this.busy) { work(); return; }
    this.busy = true;
    this.show(opts);
    try {
      await frame(); await frame();          // let the screen paint before the heavy part
      this.set(0.2, steps[0] || 'Building the map');
      await frame();
      work();
      this.set(0.6, steps[1] || 'Preparing the shaders');
      await frame();
      await this.compile();
      this.set(0.9, steps[2] || 'Almost there');
      await frame(); await frame();          // the first frames of the new scene, drawn behind the screen
    } finally {
      this.busy = false;
      this.hide();
    }
  }

  /** A friend's game: the host already changed the map (that part can't wait); cover the shader compile. */
  async after(opts) {
    if (this.busy) return;
    this.busy = true;
    this.show(opts);
    this.set(0.6, 'Preparing the shaders');
    try { await frame(); await this.compile(); await frame(); } finally { this.busy = false; this.hide(); }
  }
}
