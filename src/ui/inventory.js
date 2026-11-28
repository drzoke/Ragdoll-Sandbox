import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { Avatar, PLAYER_COLORS } from '../net/avatar.js';
import { AMMO, AMMO_NAMES } from '../weapon/ammo.js';
import { ICONS } from '../weapon/toolbox.js';

/**
 * The inventory (I): your character as others see it (with your armour on and what you hold), your
 * health and armour, every round of ammo you carry, your points and kills in VS Undead, and every
 * item you have, in slots. Drag the figure to turn it.
 */
const W = 300, H = 380;
const AMMO_ROWS = [
  ['pistol', '.45 ACP', 'M1911, SMG'], ['shells', '12 gauge', 'Shotguns'], ['rifle', '5.56 mm', 'Assault rifle'],
  ['sniper', '7.62 mm', 'M24'], ['ball', 'Musket balls', 'Flintlock'], ['grenade', 'Grenades', ''], ['mine', 'Mines', ''], ['turret', 'Sentry guns', ''],
];
const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export class Inventory {
  constructor(G) {
    this.G = G;
    this.isOpen = false;
    this.spin = 0.5; this.drag = null;
    const el = this.el = document.createElement('div');
    el.id = 'inv'; el.className = 'hidden';
    el.innerHTML = `<div class="inv-panel">
      <header><h2>Inventory</h2><span class="inv-hint"><kbd>I</kbd> or <kbd>Esc</kbd> close</span><button class="inv-x" aria-label="Close">✕</button></header>
      <div class="inv-body">
        <section class="inv-me">
          <div class="inv-view"><canvas width="${W}" height="${H}"></canvas><div class="inv-name"></div><div class="inv-drag">drag to turn</div></div>
          <div class="inv-bars">
            <div class="inv-bar hp"><span>Health</span><div><i></i></div><b></b></div>
            <div class="inv-bar arm"><span>Armour</span><div><i></i></div><b></b></div>
          </div>
          <div class="inv-gear"></div>
        </section>
        <section class="inv-side">
          <div class="inv-stats"></div>
          <h3>Ammo</h3><div class="inv-ammo"></div>
          <h3>Items</h3><div class="inv-grid"></div>
          <h3>Hotbar</h3><div class="inv-grid inv-hot"></div>
        </section>
      </div></div>`;
    document.body.appendChild(el);
    this.canvas = el.querySelector('canvas');
    el.querySelector('.inv-x').addEventListener('click', () => this.close());
    el.addEventListener('mousedown', (e) => { if (e.target === el) this.close(); });
    this.canvas.addEventListener('pointerdown', (e) => { this.drag = { x: e.clientX, s: this.spin }; this.canvas.setPointerCapture(e.pointerId); });
    this.canvas.addEventListener('pointermove', (e) => { if (this.drag) this.spin = this.drag.s + (e.clientX - this.drag.x) * 0.012; });
    this.canvas.addEventListener('pointerup', () => { this.drag = null; });
    addEventListener('keydown', (e) => {
      if (!this.isOpen) return;
      if (e.code === 'Escape' || (e.code === 'KeyI' && !e.repeat) || e.code === 'Tab') { e.preventDefault(); e.stopImmediatePropagation(); this.close(); }
    }, true);
  }

  toggle() { if (this.isOpen) this.close(); else this.open(); }

  open() {
    if (this.isOpen) return;
    this.isOpen = true;
    this.build3d();
    this.el.classList.remove('hidden');
    this.render();
    this.G.setOverlay(true);
    this.G.audio.play('click');
    this.loop();
  }

  close() {
    if (!this.isOpen) return;
    this.isOpen = false;
    this.el.classList.add('hidden');
    cancelAnimationFrame(this.raf);
    this.G.setOverlay(false);
  }

  // ---------------------------------------------------------------- the figure
  build3d() {
    if (this.renderer) return;
    const r = this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true, alpha: true });
    r.setPixelRatio(Math.min(devicePixelRatio, 2));
    r.setSize(W, H, false);
    r.setClearColor(0x000000, 0);
    r.toneMapping = THREE.ACESFilmicToneMapping;
    const scene = this.scene = new THREE.Scene();
    const pm = new THREE.PMREMGenerator(r);
    scene.environment = pm.fromScene(new RoomEnvironment(), 0.04).texture;
    scene.environmentIntensity = 0.55;
    scene.add(new THREE.HemisphereLight(0xe8eef6, 0x3a3d42, 1.1));
    const key = new THREE.DirectionalLight(0xffffff, 2.2); key.position.set(1.5, 3, 2.5); scene.add(key);
    const rim = new THREE.DirectionalLight(0x9fc4ff, 1.4); rim.position.set(-2, 1.5, -2); scene.add(rim);
    this.camera = new THREE.PerspectiveCamera(28, W / H, 0.1, 30);
    this.camera.position.set(0, 1.0, 4.1);
    this.camera.lookAt(0, 0.92, 0);
    // a soft shadow on a round pad under the feet
    const sc = document.createElement('canvas'); sc.width = sc.height = 64;
    const g = sc.getContext('2d'), grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    grd.addColorStop(0, 'rgba(0,0,0,.55)'); grd.addColorStop(1, 'rgba(0,0,0,0)'); g.fillStyle = grd; g.fillRect(0, 0, 64, 64);
    const pad = new THREE.Mesh(new THREE.CircleGeometry(0.7, 32).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(sc), transparent: true, depthWrite: false }));
    scene.add(pad);
    // the figure: the same one other players see in a room, drawn here on its own
    const av = this.avatar = new Avatar(scene, { name: '', color: PLAYER_COLORS[0] });
    av.tag.visible = false;
    this.cloth = new THREE.MeshStandardMaterial({ color: PLAYER_COLORS[0], roughness: 0.8 });
    for (const m of av.meshes) {
      // drawn on its own here, not through the ragdoll batcher (which lets go of it, keeping this material)
      const mat = m.userData.drawMat || m.material;
      m.material = m.userData.drawMat = mat.userData?.instanceFx ? this.cloth : mat;
    }
    // armour: a plate carrier and a helmet, shown when you have armour
    const vestMat = this.vestMat = new THREE.MeshStandardMaterial({ color: 0x4a5236, roughness: 0.75 });
    const plateMat = new THREE.MeshStandardMaterial({ color: 0x353b28, roughness: 0.6 });
    const strap = new THREE.MeshStandardMaterial({ color: 0x23261b, roughness: 0.8 });
    const vest = this.vest = new THREE.Group();
    const bx = (w, h, d, m, x, y, z) => { const o = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m); o.position.set(x, y, z); vest.add(o); return o; };
    bx(0.36, 0.34, 0.07, vestMat, 0, 0.02, 0.12); bx(0.36, 0.34, 0.07, vestMat, 0, 0.02, -0.12);       // front and back
    bx(0.07, 0.28, 0.2, vestMat, 0.19, 0, 0); bx(0.07, 0.28, 0.2, vestMat, -0.19, 0, 0);              // sides
    bx(0.07, 0.04, 0.3, strap, 0.11, 0.2, 0); bx(0.07, 0.04, 0.3, strap, -0.11, 0.2, 0);              // shoulder straps
    for (const x of [-0.11, 0, 0.11]) bx(0.09, 0.11, 0.05, plateMat, x, -0.07, 0.17);                    // pouches
    av.chest.add(vest);
    vest.position.set(0, 0.08, 0.0);
    // the helmet sits where the cap is (the cap and its brim come off while it's on)
    const capMesh = av.meshes[5], brim = av.meshes[6];
    this.capBits = [capMesh, brim];
    const helmet = this.helmet = new THREE.Group();
    const shell = new THREE.Mesh(new THREE.SphereGeometry(0.125, 20, 10, 0, Math.PI * 2, 0, Math.PI * 0.56), vestMat);
    shell.scale.set(1.0, 0.95, 1.08);
    const rimRing = new THREE.Mesh(new THREE.TorusGeometry(0.122, 0.012, 6, 24).rotateX(Math.PI / 2), strap);
    rimRing.position.y = 0.006; rimRing.scale.set(1, 1, 1.08);
    helmet.add(shell, rimRing);
    capMesh.parent.add(helmet);
    helmet.position.copy(capMesh.position).add(new THREE.Vector3(0, -0.03, 0));
    this.state = { pos: new THREE.Vector3(), yaw: 0, pitch: 0.05, crouch: 0, tool: 'M1911', onGround: true, sprinting: false, dead: false };
  }

  loop() {
    if (!this.isOpen) return;
    this.raf = requestAnimationFrame(() => this.loop());
    if (!this.drag) this.spin += 0.006;
    const G = this.G, s = this.state;
    s.tool = G.toolbox.active?.name || 'Fists';
    s.yaw = this.spin + Math.PI;
    this.avatar.update(1 / 60, s, null);
    const color = G.net.active ? G.net.me.color : PLAYER_COLORS[0];
    this.cloth.color.set(color);
    const a = G.vitals.armor || 0;
    this.vest.visible = a > 0; this.helmet.visible = a >= 40;
    for (const m of this.capBits) m.visible = !this.helmet.visible;
    this.vestMat.color.setHex(a > 60 ? 0x4a5236 : a > 25 ? 0x5a5a3a : 0x6a5a40);
    this.renderer.render(this.scene, this.camera);
    if ((this.tick = (this.tick || 0) + 1) % 15 === 0) this.render();
  }

  // ---------------------------------------------------------------- the lists
  render() {
    const G = this.G, V = G.vitals, el = this.el, U = G.undead;
    const vs = !!U?.active;
    const name = G.net.active ? G.net.me.name : (G.settings.get('mpName') || 'You');
    el.querySelector('.inv-name').textContent = name;
    const hp = Math.max(0, Math.ceil(V.hp)), arm = Math.round(V.armor || 0);
    el.querySelector('.inv-bar.hp i').style.width = `${(100 * hp / V.max).toFixed(0)}%`;
    el.querySelector('.inv-bar.hp b').textContent = V.dead ? 'Down' : `${hp} / ${V.max}`;
    el.querySelector('.inv-bar.arm i').style.width = `${Math.min(100, arm)}%`;
    el.querySelector('.inv-bar.arm b').textContent = arm ? `${arm} / 100` : 'None';
    const gear = [];
    if (arm > 0) gear.push(`<li><b>Body armour</b> takes 65% of each hit until it's used up</li>`);
    if (arm >= 40) gear.push('<li><b>Helmet</b> comes with armour over 40</li>');
    if (!arm) gear.push(vs ? '<li class="dim">No armour. The merchant sells it, and supply crates sometimes have some.</li>' : '<li class="dim">No armour (armour is part of VS Undead).</li>');
    el.querySelector('.inv-gear').innerHTML = `<ul>${gear.join('')}</ul>`;
    // stats
    const me = U?.me?.() ?? 1;
    const stats = vs
      ? [['Points', (U.pts[me] || 0).toLocaleString('en-US'), 'gold'], ['Wave', U.wave || 1, ''], ['Kills', U.kills[me] || 0, ''], ['Health', V.dead ? 'Down' : hp, '']]
      : [['Mode', 'Sandbox', ''], ['Health', V.dead ? 'Down' : hp, ''], ['Ammo', 'Unlimited', ''], ['Items', G.tools.length, '']];
    el.querySelector('.inv-stats').innerHTML = stats.map(([k, v, c]) => `<div class="inv-stat ${c}"><span>${k}</span><b>${esc(v)}</b></div>`).join('');
    // ammo: what you carry, plus what's in the gun in your hands
    const t = G.toolbox.active;
    const inGun = t && typeof t.mag === 'number' ? `${t.name}: ${t.mag}${t.chambered ? ' +1' : ''} loaded` : '';
    el.querySelector('.inv-ammo').innerHTML = AMMO_ROWS.map(([k, n, f]) => {
      const c = AMMO.count(k);
      const label = c === Infinity ? '∞' : c;
      return `<div class="inv-am${c === 0 ? ' empty' : ''}"><b>${label}</b><span>${esc(n)}</span><em>${esc(f || AMMO_NAMES[k] || '')}</em></div>`;
    }).join('') + (inGun ? `<div class="inv-am wide"><span>${esc(inGun)}</span></div>` : '');
    // items: every one you can use (VS Undead: the ones you own), Minecraft-style slots
    const tb = G.toolbox;
    const owned = G.tools.map((x, i) => ({ x, i })).filter(({ i }) => tb.allowed(i));
    const slots = owned.map(({ x }) => this.slot(x, x === t));
    const cols = 9, total = Math.max(cols, Math.ceil(slots.length / cols) * cols);
    while (slots.length < total) slots.push('<div class="inv-slot empty"></div>');
    el.querySelector('.inv-grid:not(.inv-hot)').innerHTML = slots.join('');
    const hot = tb.bar.map((i, n) => this.slot(G.tools[i], G.tools[i] === t, n + 1));
    while (hot.length < 9) hot.push('<div class="inv-slot empty"></div>');
    el.querySelector('.inv-hot').innerHTML = hot.join('');
  }

  slot(tool, active, key = 0) {
    const cnt = this.countFor(tool);
    return `<div class="inv-slot${active ? ' on' : ''}" title="${esc(tool.name)}">${key ? `<i>${key}</i>` : ''}${ICONS[tool.name] || ''}<span>${esc(tool.short || tool.name)}</span>${cnt !== '' ? `<b>${cnt}</b>` : ''}</div>`;
  }

  /** The number in a slot's corner: loaded + spare for guns, how many for throwables. */
  countFor(tool) {
    const pool = { Grenade: 'grenade', 'Proximity Mine': 'mine', 'Sentry Gun': 'turret' }[tool.name];
    if (pool) return AMMO.finite ? AMMO.count(pool) : '';
    if (typeof tool.mag === 'number') return tool.mag + (tool.chambered ? 1 : 0);
    return '';
  }
}
