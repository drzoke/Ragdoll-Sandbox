import * as THREE from 'three';
import { AMMO } from '../weapon/ammo.js';
import { WORLD } from '../world/world.js';
import { PowderSmoke } from '../weapon/musket.js';
import { buildMerchant, buildCart, buildCrate } from './props.js';
import { BossFight } from './boss.js';
import { rand, clamp } from '../core/util.js';

/**
 * VS Undead: co-op zombie waves on the Dead Field.
 *
 *  prep  -> a few seconds to get ready
 *  wave  -> zombies come out of the fog from every side; supply crates parachute in now and then
 *  break -> the traveling merchant comes with his cart: spend your points on ammo, guns, heals and gear
 *  over  -> everyone is down
 *
 * Points come from hitting and killing zombies (more for a headshot). In multiplayer the host's game
 * runs the waves, the zombies, the points and the crates; each player keeps their own guns and ammo.
 */

// ---------------------------------------------------------------- the merchant's goods
export const SHOP = [
  { id: 'a_pistol', cat: 'ammo', name: '.45 rounds', desc: '24 rounds for the M1911 and the SMG.', cost: 50, ammo: ['pistol', 24] },
  { id: 'a_shells', cat: 'ammo', name: '12 gauge shells', desc: '8 shells for both shotguns.', cost: 70, ammo: ['shells', 8] },
  { id: 'a_rifle', cat: 'ammo', name: '5.56 rounds', desc: '40 rounds for the assault rifle.', cost: 110, ammo: ['rifle', 40] },
  { id: 'a_sniper', cat: 'ammo', name: '7.62 rounds', desc: '8 rounds for the M24.', cost: 90, ammo: ['sniper', 8] },
  { id: 'a_ball', cat: 'ammo', name: 'Musket balls', desc: '6 paper cartridges for the flintlock.', cost: 40, ammo: ['ball', 6] },
  { id: 'w_shotgun', cat: 'weapons', name: 'Remington 870', desc: 'Pump shotgun. Comes with 8 shells.', cost: 500, tool: 'Remington 870', ammo: ['shells', 8] },
  { id: 'w_smg', cat: 'weapons', name: 'Submachine Gun', desc: 'Very fast full auto on .45 rounds. Comes with 48.', cost: 900, tool: 'Submachine Gun', ammo: ['pistol', 48] },
  { id: 'w_sniper', cat: 'weapons', name: 'M24 Sniper', desc: 'Goes through a whole line of them. Comes with 10 rounds.', cost: 1000, tool: 'M24 Sniper', ammo: ['sniper', 10] },
  { id: 'w_rifle', cat: 'weapons', name: 'Assault Rifle', desc: 'Full auto 5.56 with a red dot. Comes with 60 rounds.', cost: 1400, tool: 'Assault Rifle', ammo: ['rifle', 60] },
  { id: 'w_autoshotgun', cat: 'weapons', name: 'Combat Shotgun', desc: 'Semi-automatic, 8-shell box magazine. Comes with 16 shells.', cost: 2000, tool: 'Combat Shotgun', ammo: ['shells', 16] },
  { id: 'w_musket', cat: 'weapons', name: 'Flintlock Musket', desc: 'Slow, loud and huge. Comes with 6 balls.', cost: 250, tool: 'Flintlock Musket', ammo: ['ball', 6] },
  { id: 'w_machete', cat: 'weapons', name: 'Machete', desc: 'No ammo needed. Takes heads off.', cost: 300, tool: 'Machete' },
  { id: 'h_bandage', cat: 'heal', name: 'Bandages', desc: 'Patch yourself up: 35 health back now.', cost: 100, heal: 35 },
  { id: 'h_kit', cat: 'heal', name: 'First aid kit', desc: 'Back to full health.', cost: 300, heal: 100 },
  { id: 'h_armor', cat: 'heal', name: 'Body armour', desc: '50 armour (up to 100). It takes most of each hit until it is used up.', cost: 400, armor: 50 },
  { id: 'g_grenade', cat: 'gear', name: 'Grenades ×2', desc: 'Two frag grenades.', cost: 250, tool: 'Grenade', ammo: ['grenade', 2], stack: true },
  { id: 'g_mine', cat: 'gear', name: 'Proximity mines ×2', desc: 'Put one down; it goes off when a zombie steps near.', cost: 300, tool: 'Proximity Mine', ammo: ['mine', 2], stack: true },
  { id: 'g_sentry', cat: 'gear', name: 'Sentry gun', desc: 'Set it up and it shoots every zombie it can see (180 rounds).', cost: 1200, tool: 'Sentry Gun', ammo: ['turret', 1], stack: true },
];
const SHOP_BY_ID = Object.fromEntries(SHOP.map((s) => [s.id, s]));
const CATS = [['ammo', 'Ammo'], ['weapons', 'Weapons'], ['heal', 'Healing'], ['gear', 'Gear']];
const START_TOOLS = ['Fists', 'M1911'];
const START_AMMO = { pistol: 28 };
const AMMO_OF = { 'M1911': 'pistol', 'Submachine Gun': 'pistol', 'Remington 870': 'shells', 'Combat Shotgun': 'shells', 'Assault Rifle': 'rifle', 'M24 Sniper': 'sniper', 'Flintlock Musket': 'ball' };
const CRATE_AMMO = { pistol: 16, shells: 5, rifle: 30, sniper: 4, ball: 3 };

// points: a zombie is worth at most 50 (two hits and a headshot kill)
const HIT_PTS = 5, HIT_PTS_MAX = 10, KILL_HEAD = 40, KILL_BODY = 20;
const PREP = 12, BREAK = 45, CRATE_FALL = 3.2, CRATE_LIFE = 110;
const CAP = { minimum: 6, verylow: 7, low: 9, medium: 12, high: 16, ultra: 20 };
const HEAD_CAUSES = ['Head off', 'Head destroyed', 'Brain destroyed'];
const fmt = (n) => Math.round(n).toLocaleString('en-US');
const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const _v = new THREE.Vector3(), _f = new THREE.Frustum(), _pm = new THREE.Matrix4();

function el(tag, id, cls, html = '') { const e = document.createElement(tag); if (id) e.id = id; if (cls) e.className = cls; e.innerHTML = html; return e; }

export class UndeadMode {
  constructor(G) {
    this.G = G;
    this.active = false;
    this.phase = 'off';
    this.wave = 0; this.timer = 0; this.left = 0; this.toSpawn = 0;
    this.pts = {}; this.kills = {}; this.ready = new Set();
    this.crates = [];           // host: { id, x, z, y, landed, t }
    this.views = new Map();     // every game: crate id -> its model
    this.zs = new Set();
    this.gid = 0; this.seenGid = -1;
    this.owned = new Set();
    this.time = 0; this.sendT = 0; this.dirty = false;
    this.shownPts = 0; this.myPts = 0;
    this.buildUi();
  }

  get host() { return !this.G.net.guest; }
  me() { return this.G.net.active ? this.G.net.me.id : 1; }
  players() { const n = this.G.net; return n.active ? [n.me.id, ...n.players.keys()] : [1]; }

  // ================================================================ UI
  buildUi() {
    const hud = document.getElementById('hud');
    this.ui = {};
    this.ui.hud = el('div', 'vs-hud', 'hidden', '<div class="vs-wave">Wave <b>1</b></div><div class="vs-sub"></div>');
    this.ui.pts = el('div', 'vs-pts', 'hidden', '<b>0</b><span>points</span>');
    this.ui.banner = el('div', 'vs-banner', 'hidden', '<b></b><span></span>');
    this.ui.pops = el('div', 'vs-pops');
    hud.append(this.ui.hud, this.ui.pts, this.ui.banner, this.ui.pops);
    this.ui.shop = el('div', 'vs-shop', 'hidden', `<div class="vs-panel"><header><div><h2>Traveling merchant</h2><p>"Ammunition, iron, bandages. Points only, friend."</p></div><div class="vs-wallet"><b>0</b><span>points</span></div><button class="vs-x" aria-label="Close">✕</button></header>
      <nav>${CATS.map(([id, n]) => `<button data-cat="${id}">${n}</button>`).join('')}</nav><div class="vs-items"></div><footer><span class="vs-left"></span><span><kbd>Esc</kbd> close · <kbd>G</kbd> ready for the next wave</span></footer></div>`);
    this.ui.over = el('div', 'vs-over', 'hidden', '<div class="vs-panel"><h2>The dead took the field</h2><p class="vs-sum"></p><ul class="vs-board"></ul><div class="vs-acts"><button class="mp-btn primary" data-act="again">Try again</button><button class="mp-btn" data-act="menu">Main menu</button></div><p class="note vs-wait hidden">Waiting for the host to start again.</p></div>');
    document.body.append(this.ui.shop, this.ui.over);
    this.cat = 'ammo';
    this.ui.shop.querySelector('nav').addEventListener('click', (e) => { const b = e.target.closest('button[data-cat]'); if (b) { this.cat = b.dataset.cat; this.G.audio.play('click'); this.renderShop(); } });
    this.ui.shop.querySelector('.vs-items').addEventListener('click', (e) => { const b = e.target.closest('button[data-buy]'); if (b && !b.disabled) this.buy(b.dataset.buy); });
    this.ui.shop.querySelector('.vs-x').addEventListener('click', () => this.closeShop());
    this.ui.shop.addEventListener('keydown', (e) => { if (e.code === 'Escape') this.closeShop(); });
    this.ui.over.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-act]');
      if (!b) return;
      this.G.audio.play('click');
      this.ui.over.classList.add('hidden');
      if (this.overOpen) { this.overOpen = false; this.G.setOverlay(false); }
      if (b.dataset.act === 'again') this.start();
      else this.G.exitToTitle();
    });
    addEventListener('keydown', (e) => {
      if (!this.shopOpen) return;
      if (e.code === 'Escape' || e.code === 'Tab' || e.code === 'KeyE') { e.preventDefault(); this.closeShop(); }
      else if (e.code === 'KeyG') this.sayReady();
    });
  }

  banner(big, small = '', t = 3.2) {
    const b = this.ui.banner;
    b.querySelector('b').textContent = big; b.querySelector('span').textContent = small;
    b.classList.remove('hidden', 'go'); void b.offsetWidth; b.classList.add('go');
    clearTimeout(this.bannerT);
    this.bannerT = setTimeout(() => b.classList.add('hidden'), t * 1000);
  }

  pop(text, kind = '') {
    const p = el('div', null, `vs-pop ${kind}`, esc(text));
    this.ui.pops.appendChild(p);
    while (this.ui.pops.children.length > 6) this.ui.pops.firstChild.remove();
    setTimeout(() => p.remove(), 1400);
  }

  renderHud() {
    const u = this.ui;
    u.hud.querySelector('b').textContent = this.wave || 1;
    u.hud.classList.toggle('boss', this.phase === 'boss');
    let sub = '';
    if (this.phase === 'prep') sub = `Get ready: the dead come in ${Math.ceil(this.timer)} s`;
    else if (this.phase === 'wave') sub = `${this.left} zombie${this.left === 1 ? '' : 's'} left`;
    else if (this.phase === 'boss') { const n = this.minionCount ?? 0; sub = this.left ? (n ? `${n} minion${n === 1 ? '' : 's'} up` : 'Boss wave') : 'The Big Brute is down'; }
    else if (this.phase === 'break') {
      const n = this.players().length;
      sub = `Merchant leaves in ${Math.ceil(this.timer)} s · <kbd>G</kbd> ready${n > 1 ? ` (${this.ready.size}/${n})` : ''}`;
    } else if (this.phase === 'over') sub = 'Everyone is down';
    const sv = u.hud.querySelector('.vs-sub');
    if (sv.innerHTML !== sub) sv.innerHTML = sub;
    const want = this.myPts;
    this.shownPts += (want - this.shownPts) * 0.25;
    if (Math.abs(want - this.shownPts) < 1) this.shownPts = want;
    const t = fmt(this.shownPts);
    if (u.pts.firstChild.textContent !== t) u.pts.firstChild.textContent = t;
  }

  // ================================================================ start / stop
  /** Host (or alone): a new game on the Dead Field. */
  start() {
    const G = this.G;
    if (G.net.guest) return;
    this.fromHost = false;
    if (!this.active) this.enter();
    G.loadMap('cemetery');
    this.gid++; this.seenGid = this.gid;
    this.resetLoadout();
    this.wave = 0; this.timer = PREP; this.left = 0; this.toSpawn = 0;
    this.pts = {}; this.kills = {}; this.ready.clear();
    this.crates = []; this.zs.clear(); this.nextCrate = 25; this.crateId = 1;
    this.boss?.clear(); this.bossInfo = null; this.bossEndT = -1;
    this.setPhase('prep');
    this.dirty = true;
  }

  /** Into the mode (host and friends): the HUD, finite ammo, your loadout. */
  enter() {
    const G = this.G;
    if (this.active) return;
    this.active = true;
    document.body.classList.add('vs');
    this.ui.hud.classList.remove('hidden'); this.ui.pts.classList.remove('hidden');
    G.vitals.regen = 3;
    this.flash = new THREE.SpotLight(0xdfe8ff, 0, 44, 0.7, 0.5, 1.2);
    this.flash.position.set(0, 0, 0);
    this.flashTarget = new THREE.Object3D();
    this.flash.target = this.flashTarget;
    G.scene.add(this.flash, this.flashTarget);
    this.smoke = new PowderSmoke(G.scene, 60);
    this.crateLights = [0, 1].map(() => { const L = new THREE.PointLight(0xff3018, 0, 9, 1.6); G.scene.add(L); return L; });
    this.merchant = buildMerchant(); this.cart = buildCart();
    this.merchant.root.visible = false; this.cart.root.visible = false;
    G.scene.add(this.merchant.root, this.cart.root);
    this.mState = 'away'; this.mT = 0;
    this.boss ??= new BossFight(this);
    // shotguns: weaker pellets that lose power sooner, and it takes more of them to blow a head apart
    Object.assign(G.ballistics, { pelletRange: 16, pelletMul: 0.8, pointBlankN: 6, pointBlankRange: 3 });
    this.resetLoadout();
    this.hookZombieHits();
  }

  /** Back to the sandbox: unlimited ammo and every item again. */
  stop() {
    const G = this.G;
    if (!this.active) return;
    this.active = false;
    this.phase = 'off';
    this.closeShop();
    document.body.classList.remove('vs');
    for (const k of ['hud', 'pts', 'banner', 'over']) this.ui[k].classList.add('hidden');
    Object.assign(G.ballistics, { pelletRange: 30, pelletMul: 1, pointBlankN: 4, pointBlankRange: 4.5 });
    G.vitals.regen = 7; G.vitals.lockRespawn = ''; G.vitals.hideDeathScreen = false; G.vitals.armor = 0;
    AMMO.reset(false);
    G.toolbox.setAllowed(null);
    for (const t of G.tools) t.refill?.();
    G.gadgets.clear();
    for (const v of this.views.values()) this.dropView(v);
    this.views.clear();
    G.scene.remove(this.flash, this.flashTarget, this.merchant.root, this.cart.root, ...this.crateLights);
    this.smoke.clear();
    for (const s of this.smoke.pool) G.scene.remove(s);
    this.removeMerchantInteract();
    this.boss?.clear();
    this.zs.clear(); this.crates = [];
  }

  resetLoadout() {
    const G = this.G;
    AMMO.reset(true, START_AMMO);
    this.owned = new Set(START_TOOLS);
    for (const t of G.tools) if (t.name === 'M1911') t.refill?.();
    G.pistol.mag = 7; G.pistol.chambered = true; G.pistol.slideLocked = false;
    for (const t of G.tools) { if (t.mag !== undefined && t.S?.mag) t.refill(); }
    G.toolbox.setAllowed((t) => this.owned.has(t.name));
    G.toolbox.setBar(START_TOOLS, 'M1911');
    G.vitals.armor = 0;
    G.gadgets.clear();
  }

  // ================================================================ phases
  setPhase(p) {
    const prev = this.phase;
    this.phase = p;
    this.onPhase(prev, p);
  }

  /** What every game does when the phase changes (the host's own, and a friend's from the state). */
  onPhase(prev, p) {
    const G = this.G;
    const coop = this.players().length > 1;
    G.vitals.lockRespawn = coop ? 'You\'ll get back up when this wave is cleared.' : '';
    G.vitals.hideDeathScreen = !coop || p === 'over';
    if (p !== 'over') { this.ui.over.classList.add('hidden'); if (this.overOpen) { this.overOpen = false; G.setOverlay(false); } }
    if (p !== 'boss' && p !== 'break' && p !== 'over') this.boss?.clear();
    if (p === 'prep') {
      this.revive();
      this.banner('VS Undead', 'Hold the field. Headshots put them down for good.', 4);
      G.audio.play('snarl', 0.5);
    } else if (p === 'wave') {
      this.revive(prev === 'over');
      this.banner(`Wave ${this.wave}`, this.wave === 1 ? 'They\'re coming out of the fog' : '', 3);
      G.audio.play('bell');
      this.closeShop();
    } else if (p === 'boss') {
      this.revive(prev === 'over');
      this.closeShop();
      G.audio.play('bell');
      if (this.bossInfo) this.boss.begin(this.bossInfo);
    } else if (p === 'break') {
      this.revive();
      this.banner(`Wave ${this.wave} cleared`, 'The traveling merchant is here: press E on him to trade', 4);
      G.audio.play('button');
    } else if (p === 'over') {
      this.closeShop();
      G.vitals.deathEl.classList.add('hidden');
      setTimeout(() => this.showOver(), 1600);
    }
  }

  revive(force = false) {
    const V = this.G.vitals;
    if (V.dead) { V.respawn(true); this.G.hud.toast('You\'re back up'); }
    else if (force) V.reset();
  }

  showOver() {
    if (this.phase !== 'over') return;
    const G = this.G, u = this.ui.over;
    const me = this.me();
    u.querySelector('.vs-sum').textContent = `You held out for ${Math.max(0, this.wave - 1)} wave${this.wave - 1 === 1 ? '' : 's'}${this.wave ? ` and fell on wave ${this.wave}` : ''}. Your kills: ${this.kills[me] || 0}.`;
    const names = this.names();
    u.querySelector('.vs-board').innerHTML = this.players().length > 1
      ? this.players().map((id) => `<li><span>${esc(names[id] || 'Player')}</span><b>${this.kills[id] || 0} kills</b><em>${fmt(this.pts[id] || 0)} pts</em></li>`).join('') : '';
    u.querySelector('[data-act="again"]').classList.toggle('hidden', !this.host);
    u.querySelector('.vs-wait').classList.toggle('hidden', this.host);
    u.classList.remove('hidden');
    G.setOverlay(true);
    this.overOpen = true;
  }

  names() {
    const n = this.G.net, out = { [this.me()]: n.active ? n.me.name : 'You' };
    if (n.active) for (const [id, p] of n.players) out[id] = p.name;
    return out;
  }

  // ================================================================ host: the waves
  /** Zombies in a wave: 2 on the first, 2 more each wave after (half as many again per extra player). */
  waveSize(w) {
    const n = this.players().length;
    return Math.round(2 * w * (1 + 0.5 * (n - 1)));
  }

  startWave(w) {
    if (w % 3 === 0) { this.startBoss(w); return; }
    this.wave = w;
    this.toSpawn = this.waveSize(w);
    this.left = this.toSpawn;
    this.spawnT = 1.5;
    this.ready.clear();
    this.nextCrate = w === 1 ? 30 : rand(35, 60);
    this.setPhase('wave');
    this.dirty = true;
  }

  endWave() {
    const bonus = 40 + 10 * this.wave;
    for (const id of this.players()) this.addPts(id, bonus, `Wave cleared +${bonus}`);
    this.timer = BREAK; this.left = 0;
    this.ready.clear();
    this.setPhase('break');
    this.dirty = true;
  }

  // ---------------------------------------------------------------- every third wave: the Big Brute
  startBoss(w) {
    const G = this.G, bd = G.map.bounds;
    this.wave = w;
    this.toSpawn = 0; this.left = 1;
    this.ready.clear();
    this.nextCrate = rand(20, 30);
    this.bossEndT = -1;
    // it comes up a little way off, facing the players
    const people = this.peoplePos();
    const c = new THREE.Vector3();
    for (const p of people) c.add(p);
    if (people.length) c.multiplyScalar(1 / people.length);
    let spot = null;
    for (let i = 0; i < 24 && !spot; i++) {
      const a = Math.random() * Math.PI * 2, R = rand(11, 15);
      const x = clamp(c.x + Math.cos(a) * R, bd.minX + 6, bd.maxX - 6), z = clamp(c.z + Math.sin(a) * R, bd.minZ + 6, bd.maxZ - 6);
      if (people.some((p) => Math.hypot(p.x - x, p.z - z) < 8)) continue;
      if (this.blocked(x, z, 2.5)) continue;
      spot = { x, z };
    }
    spot ||= { x: clamp(c.x + 12, bd.minX + 6, bd.maxX - 6), z: c.z };
    const n = this.players().length, k = w / 3;
    const max = Math.round(1600 * (1 + 0.6 * (n - 1)) * (1 + 0.5 * (k - 1)));
    this.bossInfo = { x: +spot.x.toFixed(2), z: +spot.z.toFixed(2), yaw: +Math.atan2(-(c.x - spot.x), -(c.z - spot.z)).toFixed(3), hp: max, max, wave: w };
    this.setPhase('boss');
    this.dirty = true;
  }

  /** Something solid (a tree, the fence, a crate) within r of (x, z)? The ground doesn't count. */
  blocked(x, z, r) {
    return this.G.map.near(x - r, 0.1, z - r, x + r, 2, z + r).some((c) => !c.off && c.max.y > 0.15 && x > c.min.x - r && x < c.max.x + r && z > c.min.z - r && z < c.max.z + r);
  }

  minionsAlive() { let n = 0; for (const z of this.zs) if (z.vs.minion && z.health.alive && !z.removed) n++; return n; }

  /** Host: the Brute roars and 2 to 4 of the dead claw their way up around it. */
  summonMinions(boss) {
    const G = this.G, bd = G.map.bounds;
    const n = 2 + Math.floor(Math.random() * 3);
    const people = this.peoplePos(), spots = [];
    for (let i = 0, tries = 0; i < n && tries < 40; tries++) {
      const a = Math.random() * Math.PI * 2, R = rand(2.5, 6);
      const x = clamp(boss.pos.x + Math.cos(a) * R, bd.minX + 2, bd.maxX - 2), z = clamp(boss.pos.z + Math.sin(a) * R, bd.minZ + 2, bd.maxZ - 2);
      if (people.some((p) => Math.hypot(p.x - x, p.z - z) < 3.5)) continue;
      if (this.blocked(x, z, 0.6)) continue;
      if (this.spawnZombie({ at: new THREE.Vector3(x, 0, z), minion: true })) { spots.push([+x.toFixed(2), +z.toFixed(2)]); i++; }
    }
    if (!spots.length) return;
    this.riseFx(spots);
    if (G.net.host) G.net.emit({ t: 'vs', fx: 'rise', p: spots });
    for (const id of this.players()) this.sendPop(id, `The Brute raised ${spots.length} of the dead`, 'info');
  }

  /** Dirt thrown up where a minion comes out of the ground (every game). */
  riseFx(spots) {
    for (const [x, z] of spots) this.boss?.burst(new THREE.Vector3(x, 0.05, z), 10, 0.8);
    this.G.audio.play('groan', 0.8);
  }

  /** Host: the Brute is down. Its minions drop with it; points for everyone. */
  bossDown(boss, killer) {
    for (const z of this.zs) if (z.vs.minion && z.health.alive) { z.vs.noPts = true; z.health.alive = false; z.health.deathCause = 'Its master fell'; z.health.consciousness = 0; }
    const bonus = 150 + 50 * (this.wave / 3);
    for (const id of this.players()) this.addPts(id, bonus, `Big Brute down +${bonus}`);
    this.addPts(killer, 50, 'Killing blow +50');
    this.kills[killer] = (this.kills[killer] || 0) + 1;
    this.left = 0;
    this.bossEndT = 4.5;
    this.dirty = true;
  }

  aliveCap() {
    const G = this.G;
    const base = CAP[G.settings.get('graphics')] || 12;
    // the physics can't keep up: fewer at once (they keep coming, just not all together)
    const ph = G.physics;
    this.capAdj ??= 0; this.capT ??= 0;
    this.capT += 1;
    if (this.capT > 90) {
      this.capT = 0;
      if (ph.rateHz < 52 || ph.loadMs > 11) this.capAdj = Math.max(-base + 5, this.capAdj - 1);
      else if (ph.loadMs < 6 && this.capAdj < 0) this.capAdj++;
    }
    return base + this.capAdj;
  }

  spawnZombie({ at = null, minion = false } = {}) {
    const G = this.G, b = G.map.bounds, w = this.wave;
    const people = this.peoplePos();
    let pos = at;
    for (let i = 0; i < 16 && !pos; i++) {
      const a = Math.random() * Math.PI * 2, R = rand(22, 32);
      const x = clamp(Math.cos(a) * R, b.minX + 2, b.maxX - 2), z = clamp(Math.sin(a) * R, b.minZ + 2, b.maxZ - 2);
      if (people.some((p) => Math.hypot(p.x - x, p.z - z) < 15)) continue;
      if (G.map.near(x - 0.6, 0.1, z - 0.6, x + 0.6, 1.5, z + 0.6).some((c) => x > c.min.x - 0.5 && x < c.max.x + 0.5 && z > c.min.z - 0.5 && z < c.max.z + 0.5)) continue;
      pos = new THREE.Vector3(x, 0, z);
    }
    if (!pos) return false;
    // they get worse every wave: more runners, more helmets and vests, faster, harder hitting, tougher
    const runner = w >= 2 && Math.random() < Math.min(0.55, 0.1 * (w - 1)) * (minion ? 0.6 : 1);
    const helmet = w >= 3 && Math.random() < Math.min(0.55, 0.09 * (w - 2));
    const vest = w >= 3 && Math.random() < Math.min(0.65, 0.11 * (w - 2));
    const yaw = Math.atan2(-pos.x, -pos.z);
    const r = G.ragdolls.spawn([pos.x, 0, pos.z], yaw, { zombie: true, armor: { helmet, vest } });
    const br = r.brain;
    br.sight = 400;
    br.chaseMul = runner ? rand(2.6, 3.0) + Math.min(0.4, 0.04 * w) : rand(1.5, 1.8) + Math.min(0.7, 0.06 * w);
    br.dmgMul = Math.min(2.6, 1.15 + 0.11 * (w - 1));
    br.cdMul = Math.max(0.55, 1 - 0.04 * (w - 1));          // and attack more often
    // headshots are the way to put them down; the body takes a lot more punishment, more each wave
    r.health.bodyDeath = Math.min(560, 260 + 30 * (w - 1));
    r.health.bodyResist = 0.5;
    r.vs = { born: this.time, runner, hitPts: 0, minion };
    if (runner) r.name = r.name.replace('Zombie', 'Runner');
    this.wrapHealth(r);
    this.zs.add(r);
    return true;
  }

  /** Melee, blunt hits and blasts: remember who did it (for the kill). */
  wrapHealth(r) {
    const h = r.health;
    for (const f of ['punch', 'blunt', 'cut']) {
      const orig = h[f];
      if (typeof orig !== 'function') continue;
      h[f] = function (...a) { r.lastBy = WORLD.actor || 0; return orig.apply(this, a); };
    }
  }

  hookZombieHits() {
    if (this.hooked) return;
    this.hooked = true;
    const B = this.G.ballistics;
    const prev = B.onRagdollHit;
    B.onRagdollHit = (r, b, res, partName) => {
      prev?.(r, b, res, partName);
      if (!this.active || !this.host || !r.vs || !r.health.alive || (this.phase !== 'wave' && this.phase !== 'boss')) return;
      if (r.vs.hitPts >= HIT_PTS_MAX) return;
      r.vs.hitPts += HIT_PTS;
      this.addPts(b.owner || this.me(), HIT_PTS);
    };
  }

  addPts(id, n, popText = null) {
    this.pts[id] = (this.pts[id] || 0) + n;
    this.dirty = true;
    if (popText) this.sendPop(id, popText, n >= 40 ? 'big' : '');
  }

  sendPop(id, text, kind = '') {
    if (id === this.me()) this.pop(text, kind);
    else this.G.net.sendTo(id, { pop: text, k: kind });
  }

  peoplePos() {
    const G = this.G, out = [];
    if (!G.vitals.dead) out.push(G.player.pos);
    for (const f of G.net.friendInfos()) if (f.alive) out.push(f.pos);
    return out;
  }

  everyoneDown() {
    const G = this.G;
    if (!G.vitals.dead) return false;
    return G.net.friendInfos().every((f) => !f.alive);
  }

  updateHost(dt) {
    const G = this.G;
    if (this.phase === 'prep') {
      this.timer -= dt;
      if (this.timer <= 0) this.startWave(1);
    } else if (this.phase === 'wave') {
      // spawning (a few at a time, never more than the cap at once)
      let alive = 0;
      for (const z of this.zs) if (z.health.alive && !z.removed) alive++;
      this.spawnT -= dt;
      if (this.toSpawn > 0 && this.spawnT <= 0 && alive < this.aliveCap()) {
        if (this.spawnZombie()) { this.toSpawn--; alive++; }
        this.spawnT = rand(0.5, 1.1) * (alive < 4 ? 0.6 : 1);
      }
      this.checkZombies(dt);
      // supply drops
      this.nextCrate -= dt;
      if (this.nextCrate <= 0) { this.nextCrate = rand(55, 85); this.dropCrate(); }
      if (this.toSpawn === 0 && ![...this.zs].some((z) => z.health.alive && !z.removed)) this.endWave();
      else if (this.everyoneDown()) { this.setPhase('over'); this.dirty = true; }
    } else if (this.phase === 'boss') {
      this.checkZombies(dt);
      this.nextCrate -= dt;
      if (this.nextCrate <= 0) { this.nextCrate = rand(30, 45); this.dropCrate(); }
      if (this.bossEndT >= 0) { this.bossEndT -= dt; if (this.bossEndT < 0) this.endWave(); }
      else if (this.everyoneDown()) { this.setPhase('over'); this.dirty = true; }
    } else if (this.phase === 'break') {
      this.timer -= dt;
      this.checkZombies(dt);
      const ids = this.players();
      if (ids.every((id) => this.ready.has(id))) this.timer = Math.min(this.timer, 3);
      if (this.timer <= 0) this.startWave(this.wave + 1);
    }
    // crates fall, land and expire
    for (const c of [...this.crates]) {
      if (!c.landed) { c.y = Math.max(0, c.y - CRATE_FALL * dt); if (c.y <= 0) { c.landed = true; c.t = 0; this.dirty = true; } }
      else { c.t += dt; if (c.t > CRATE_LIFE) { this.crates = this.crates.filter((x) => x !== c); this.dirty = true; } }
    }
    this.sendT -= dt;
    if (this.dirty || this.sendT <= 0) { this.broadcast(); this.dirty = false; this.sendT = 1; }
  }

  /** Kills (and who gets them), and clearing away the bodies so the field stays fast. */
  checkZombies() {
    const G = this.G, me = this.me();
    const cam = G.camera;
    _pm.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    _f.setFromProjectionMatrix(_pm);
    const dead = [];
    for (const z of [...this.zs]) {
      if (z.removed || !G.ragdolls.list.includes(z)) { this.zs.delete(z); continue; }
      if (z.health.alive) {
        // lost: stuck far away from everyone for a long time, or fell out of the world
        const p = z.parts.pelvis.body.position;
        if (p.y < -5 || (this.time - z.vs.born > 100 && !this.peoplePos().some((q) => Math.hypot(q.x - p.x, q.z - p.z) < 30))) {
          G.ragdolls.remove(z); this.zs.delete(z);
          if (this.phase === 'wave') this.toSpawn++;
        }
        continue;
      }
      if (!z.vs.dead) {
        z.vs.dead = this.time;
        if (!z.vs.noPts) {
          const by = z.lastBy || me;
          const head = HEAD_CAUSES.includes(z.health.deathCause);
          const n = head ? KILL_HEAD : KILL_BODY;
          this.kills[by] = (this.kills[by] || 0) + 1;
          this.addPts(by, n, head ? `Headshot +${n}` : `Kill +${n}`);
        }
        if (!z.vs.minion) this.left = Math.max(0, this.left - 1);
        this.dirty = true;
      }
      dead.push(z);
    }
    // bodies: gone once nobody's looking (or after a while anyway); never more than 6 lying around
    dead.sort((a, b) => a.vs.dead - b.vs.dead);
    for (let i = 0; i < dead.length; i++) {
      const z = dead[i], age = this.time - z.vs.dead;
      const p = z.parts.pelvis.body.position;
      const seen = _f.containsPoint(_v.set(p.x, p.y, p.z)) && _v.distanceTo(G.player.pos) < 40;
      if ((age > 9 && !seen) || age > 24 || dead.length - i > 6) { G.ragdolls.remove(z); this.zs.delete(z); }
    }
  }

  dropCrate() {
    const G = this.G, b = G.map.bounds;
    const people = this.peoplePos();
    if (!people.length) return;
    const near = people[Math.floor(Math.random() * people.length)];
    const a = Math.random() * Math.PI * 2, d = rand(7, 16);
    const x = clamp(near.x + Math.cos(a) * d, b.minX + 3, b.maxX - 3), z = clamp(near.z + Math.sin(a) * d, b.minZ + 3, b.maxZ - 3);
    this.crates.push({ id: this.crateId++, x, z, y: 30, landed: false, t: 0, yaw: rand(0, Math.PI) });
    for (const id of this.players()) this.sendPop(id, 'Supply drop incoming', 'info');
    this.dirty = true;
  }

  /** Someone opened a crate: points, or a roll on their own loot table. */
  openCrate(pid, id) {
    const c = this.crates.find((x) => x.id === id);
    if (!c || !c.landed) return;
    this.crates = this.crates.filter((x) => x !== c);
    this.dirty = true;
    if (Math.random() < 0.15) { this.addPts(pid, 100, 'Supply crate: +100 points'); return; }
    if (pid === this.me()) this.loot(); else this.G.net.sendTo(pid, { crate: 1 });
  }

  broadcast() {
    if (!this.G.net.host) return;
    this.G.net.emit({ t: 'vs', s: this.state() });
  }

  state() {
    return {
      gid: this.gid, ph: this.phase, w: this.wave, tm: +this.timer.toFixed(1), l: this.left,
      pts: this.pts, k: this.kills, rd: [...this.ready],
      cr: this.crates.map((c) => [c.id, +c.x.toFixed(2), +c.z.toFixed(2), +c.y.toFixed(2), c.landed ? 1 : 0, +c.yaw.toFixed(2)]),
      gd: this.G.gadgets.list.map((g) => this.G.gadgets.record(g)),
      bs: this.phase === 'boss' ? this.bossInfo : null, mn: this.minionsAlive(),
    };
  }

  // ================================================================ friends: the host's state
  /** A friend's game: the host's VS state (and now and then the whole thing again). */
  onState(s) {
    const G = this.G;
    if (!this.active) { this.enter(); this.onFriendEnter?.(); }
    this.fromHost = true;
    if (s.gid !== this.seenGid) { this.seenGid = s.gid; this.resetLoadout(); }
    this.wave = s.w; this.timer = s.tm; this.left = s.l;
    this.pts = s.pts || {}; this.kills = s.k || {}; this.ready = new Set(s.rd || []);
    this.bossInfo = s.bs || this.bossInfo; this.minionCount = s.mn || 0;
    this.crates = (s.cr || []).map(([id, x, z, y, landed, yaw]) => ({ id, x, z, y, landed: !!landed, yaw }));
    // gadgets: add the ones we don't have, drop the ones that are gone
    const gd = s.gd || [];
    const have = new Set(gd.map((g) => g.id));
    for (const g of [...G.gadgets.list]) if (!have.has(g.id)) G.gadgets.remove(g);
    for (const r of gd) if (!G.gadgets.byId(r.id)) G.gadgets.place(r.k, new THREE.Vector3(...r.p), r.y, { id: r.id, owner: r.o, ammo: r.a });
    if (s.ph !== this.phase) this.setPhase(s.ph);
  }

  /** Every 'vs' event from the host: the state, the boss's moves, effects. */
  onVs(e) {
    if (e.s) this.onState(e.s);
    else if (e.b) this.boss?.onNet(e.b);
    else if (e.fx === 'rise' && this.active) this.riseFx(e.p || []);
    else if (e.fx === 'slam' && this.active) this.boss?.slamFx(new THREE.Vector3(e.p[0], 0, e.p[1]));
  }

  /** The host's message to us alone. */
  onMine(m) {
    if (m.pop) this.pop(m.pop, m.k || '');
    if (m.give) this.give(SHOP_BY_ID[m.give]);
    if (m.crate) this.loot();
    if (m.deny) { this.G.audio.play('deny'); this.G.hud.toast(m.deny); }
    if (m.kb) this.boss?.knock(m.kb);
  }

  /** Host: what a friend asked for. */
  onRequest(p, d) {
    if (!this.active) return;
    if (d.buy) {
      const it = SHOP_BY_ID[d.buy];
      if (!it || this.phase !== 'break') return;
      if ((this.pts[p.id] || 0) < it.cost) { this.G.net.sendTo(p.id, { deny: 'Not enough points' }); return; }
      this.pts[p.id] -= it.cost; this.dirty = true;
      this.G.net.sendTo(p.id, { give: it.id });
    } else if (d.open) this.openCrate(p.id, d.open);
    else if (d.bm) { if (this.boss?.alive) this.boss.damage(clamp(+d.bm.a || 0, 0, 60), d.bm.z === 'head' ? 'head' : 'body', p.id); }
    else if (d.ready) { if (this.phase === 'break') { this.ready.add(p.id); this.dirty = true; } }
    else if (d.place) {
      const v = new THREE.Vector3(...d.place.p);
      if (d.place.k === 'mine' || d.place.k === 'sentry') this.G.gadgets.place(d.place.k, v, d.place.y, { owner: p.id });
      this.dirty = true;
    }
  }

  // ================================================================ buying and loot (each player's own)
  buy(id) {
    const it = SHOP_BY_ID[id];
    if (!it || this.phase !== 'break') return;
    if (it.tool && !it.stack && this.owned.has(it.tool)) return;
    const pts = this.pts[this.me()] || 0;
    if (pts < it.cost) { this.G.audio.play('deny'); return; }
    if (this.host) { this.pts[this.me()] = pts - it.cost; this.dirty = true; this.give(it); }
    else { this.G.net.vsRequest({ buy: id }); this.pts[this.me()] = pts - it.cost; }   // shown at once; the host's state confirms it
    this.G.audio.play('buy');
    this.renderShop();
  }

  give(it) {
    if (!it) return;
    const G = this.G, V = G.vitals;
    if (it.ammo) AMMO.give(it.ammo[0], it.ammo[1]);
    if (it.tool && !this.owned.has(it.tool)) {
      this.owned.add(it.tool);
      G.toolbox.refreshAllowed();
      G.toolbox.addToBar(it.tool);
    }
    if (it.heal) { if (!V.dead) { V.hp = Math.min(V.max, V.hp + it.heal); V.lagHp = V.hp; } G.audio.play('bandage'); }
    if (it.armor) { V.armor = Math.min(100, V.armor + it.armor); G.audio.play('clink'); }
    this.renderShop();
  }

  /** What's in a crate for me: mostly ammo for what I carry, sometimes a grenade, armour or a gun. */
  loot() {
    const G = this.G, V = G.vitals;
    const types = [...new Set([...this.owned].map((t) => AMMO_OF[t]).filter(Boolean))];
    const got = [];
    const r = Math.random();
    if (r < 0.06) {
      const guns = ['w_smg', 'w_rifle', 'w_autoshotgun', 'w_shotgun', 'w_sniper'].map((i) => SHOP_BY_ID[i]).filter((i) => !this.owned.has(i.tool));
      if (guns.length) { const g = guns[Math.floor(Math.random() * guns.length)]; this.give(g); got.push(g.name); }
    } else if (r < 0.3) { V.armor = Math.min(100, V.armor + 40); got.push('armour +40'); }
    else if (r < 0.45) { this.give(SHOP_BY_ID.g_grenade); got.push('2 grenades'); }
    else if (r < 0.55) { this.give({ ...SHOP_BY_ID.g_mine, ammo: ['mine', 1] }); got.push('a mine'); }
    else if (r < 0.7) { if (!V.dead) V.hp = Math.min(V.max, V.hp + 40); got.push('bandages +40'); }
    // and ammo, always
    const pick = types.sort(() => Math.random() - 0.5).slice(0, 2);
    for (const t of pick) { const n = CRATE_AMMO[t]; AMMO.give(t, n); got.push(`${n} ${t === 'pistol' ? '.45' : t === 'rifle' ? '5.56' : t === 'sniper' ? '7.62' : t === 'shells' ? 'shells' : 'balls'}`); }
    G.audio.play('magIn');
    this.pop(`Crate: ${got.join(', ')}`, 'info');
  }

  sayReady() {
    if (this.phase !== 'break') return;
    const me = this.me();
    if (this.ready.has(me)) return;
    this.ready.add(me);
    if (this.host) this.dirty = true; else this.G.net.vsRequest({ ready: 1 });
    this.G.audio.play('click');
    this.pop(this.players().length > 1 ? 'Ready: waiting for the others' : 'Ready', 'info');
    this.closeShop();
  }

  // ================================================================ the shop
  openShop() {
    if (this.shopOpen || this.phase !== 'break') return;
    this.shopOpen = true;
    this.ui.shop.classList.remove('hidden');
    this.renderShop();
    this.G.setOverlay(true);
    this.G.audio.play('click');
  }

  closeShop() {
    if (!this.shopOpen) return;
    this.shopOpen = false;
    this.ui.shop.classList.add('hidden');
    this.G.setOverlay(false);
  }

  renderShop() {
    if (!this.shopOpen) return;
    const u = this.ui.shop, pts = this.pts[this.me()] || 0;
    u.querySelector('.vs-wallet b').textContent = fmt(pts);
    for (const b of u.querySelectorAll('nav button')) b.classList.toggle('on', b.dataset.cat === this.cat);
    u.querySelector('.vs-items').innerHTML = SHOP.filter((i) => i.cat === this.cat).map((i) => {
      const owned = i.tool && !i.stack && this.owned.has(i.tool);
      const have = i.ammo ? ` <em>you have ${AMMO.count(i.ammo[0])}</em>` : i.armor ? ` <em>armour ${Math.round(this.G.vitals.armor)}</em>` : i.heal ? ` <em>health ${Math.ceil(this.G.vitals.hp)}</em>` : '';
      const label = owned ? 'Owned' : pts < i.cost ? 'Not enough' : 'Buy';
      return `<div class="vs-item${owned ? ' owned' : ''}"><div><b>${esc(i.name)}</b><p>${esc(i.desc)}${have}</p></div><button data-buy="${i.id}" ${owned || pts < i.cost ? 'disabled' : ''}><span>${fmt(i.cost)}</span>${label}</button></div>`;
    }).join('');
    u.querySelector('.vs-left').textContent = `Leaves in ${Math.ceil(this.timer)} s`;
  }

  // ================================================================ every frame, every game
  update(dt) {
    if (!this.active) return;
    const G = this.G;
    this.time += dt;
    if (this.host && this.phase !== 'off') this.updateHost(dt);
    else if (this.phase === 'prep' || this.phase === 'break') this.timer = Math.max(0, this.timer - dt);
    this.myPts = this.pts[this.me()] || 0;
    if (this.phase === 'break' && G.input.wasPressed('KeyG') && !this.shopOpen) this.sayReady();
    if (this.host) this.minionCount = this.phase === 'boss' ? this.minionsAlive() : 0;
    this.boss?.update(dt);
    this.updateMerchant(dt);
    this.updateCrates(dt);
    this.smoke.update(dt);
    // your flashlight (it's dark out here)
    const cam = G.camera;
    this.flash.intensity = G.vitals.dead || G.titleMode() ? 0 : 38;
    this.flash.position.copy(cam.position).add(_v.set(0.15, -0.12, 0).applyQuaternion(cam.quaternion));
    this.flashTarget.position.copy(cam.position).add(_v.set(0, 0, -10).applyQuaternion(cam.quaternion));
    if (this.shopOpen && (this.shopT = (this.shopT || 0) + dt) > 0.5) { this.shopT = 0; this.renderShop(); }
    this.renderHud();
  }

  // ---------------------------------------------------------------- the merchant
  updateMerchant(dt) {
    const G = this.G, m = this.merchant, cart = this.cart;
    const spot = G.map.def?.merchantSpot;
    if (!spot) return;
    const here = this.phase === 'break';
    // he walks in from the fog pushing his cart, and back out when the next wave starts
    const from = new THREE.Vector3(-30, 0, -26), to = new THREE.Vector3(...spot.pos);
    const prev = this.mState;
    if (here && (prev === 'away' || prev === 'leaving')) { this.mState = 'arriving'; this.mT = prev === 'leaving' ? 1 - Math.min(1, this.mT) : 0; m.root.visible = cart.root.visible = true; }
    if (!here && (prev === 'arriving' || prev === 'here')) { this.mState = 'leaving'; this.mT = prev === 'arriving' ? 1 - Math.min(1, this.mT) : 0; this.closeShop(); this.removeMerchantInteract(); }
    if (this.mState === 'away') return;
    let u = 1;
    if (this.mState === 'arriving') { this.mT += dt / 7; u = Math.min(1, this.mT); if (u >= 1) { this.mState = 'here'; this.addMerchantInteract(); } }
    else if (this.mState === 'leaving') { this.mT += dt / 7; u = 1 - Math.min(1, this.mT); if (this.mT >= 1) { this.mState = 'away'; m.root.visible = cart.root.visible = false; return; } }
    const walking = this.mState === 'arriving' || this.mState === 'leaving';
    const pos = from.clone().lerp(to, u * u * (3 - 2 * u));
    const dir = to.clone().sub(from).normalize();
    const go = this.mState === 'leaving' ? dir.clone().negate() : dir;     // the way he walks
    const face = (d) => Math.atan2(-d.x, -d.z);                             // the models face -Z
    if (walking || !this.cartSet) {
      cart.root.position.copy(pos).addScaledVector(go, 2.1);
      cart.root.rotation.y = face(go);
      this.cartSet = !walking;
    }
    // once there he steps out beside the cart and turns to whoever is closest
    const side = _v.set(-dir.z, 0, dir.x);
    const mp = walking ? pos : pos.clone().addScaledVector(dir, 1.2).addScaledVector(side, 1.2);
    let stepping = false;
    if (walking) m.root.position.copy(mp);
    else {
      const d = _v.copy(mp).sub(m.root.position).setY(0), len = d.length();
      if (len > 0.03) { stepping = true; m.root.position.addScaledVector(d, Math.min(1, (1.1 * dt) / len)); }
    }
    const P = G.player.pos;
    const want = walking ? face(go) : stepping ? face(_v.copy(mp).sub(m.root.position)) : face(_v.set(P.x - m.root.position.x, 0, P.z - m.root.position.z));
    m.root.rotation.y += Math.atan2(Math.sin(want - m.root.rotation.y), Math.cos(want - m.root.rotation.y)) * Math.min(1, dt * 4);
    const t = this.time;
    const moving = walking || stepping;
    m.body.position.y = moving ? Math.abs(Math.sin(t * 6)) * 0.04 : Math.sin(t * 1.5) * 0.008;
    m.body.rotation.z = moving ? Math.sin(t * 6) * 0.03 : 0;
    m.lantern.rotation.z = Math.sin(t * (moving ? 6 : 1.3)) * (moving ? 0.25 : 0.06);
    for (const w of cart.wheels) w.rotation.x -= (walking ? 1 : 0) * dt * 2.2;
    const glow = this.mState === 'away' ? 0 : 1;
    m.light.intensity = 5 * glow * (0.9 + 0.1 * Math.sin(t * 11));
    cart.light.intensity = 6 * glow;
  }

  addMerchantInteract() {
    const G = this.G;
    if (this.mInteract) return;
    const meshes = [];
    this.merchant.root.traverse((o) => { if (o.isMesh) meshes.push(o); });
    this.cart.root.traverse((o) => { if (o.isMesh) meshes.push(o); });
    this.mInteract = {
      meshes,
      prompt: () => (this.phase === 'break' ? 'Trade with the merchant' : ''),
      press: () => this.openShop(),
    };
    for (const m of meshes) m.userData.interact = this.mInteract;
    G.map.interactables.push(this.mInteract);
  }

  removeMerchantInteract() {
    if (!this.mInteract) return;
    const list = this.G.map.interactables, i = list.indexOf(this.mInteract);
    if (i >= 0) list.splice(i, 1);
    for (const m of this.mInteract.meshes) delete m.userData.interact;
    this.mInteract = null;
  }

  // ---------------------------------------------------------------- the supply crates
  updateCrates(dt) {
    const G = this.G;
    const ids = new Set(this.crates.map((c) => c.id));
    for (const [id, v] of this.views) {
      if (!ids.has(id) && !v.opening) {
        // opened (or gone): the lid flips up, then it fades out
        v.opening = 0;
        this.removeCrateBits(v);
        G.audio.play('door');
      }
    }
    for (const c of this.crates) {
      let v = this.views.get(c.id);
      if (!v) v = this.makeView(c);
      // friends: keep falling between the host's updates
      if (!this.host && !c.landed) c.y = Math.max(0.02, c.y - CRATE_FALL * dt);
      v.y += (c.y - v.y) * Math.min(1, dt * (this.host ? 30 : 4));
      if (!this.host && !c.landed) v.y = Math.min(v.y, c.y + 0.5);
      v.model.root.position.set(c.x, v.y, c.z);
      v.model.root.rotation.y = c.yaw;
      const sway = c.landed ? 0 : Math.sin(this.time * 1.3 + c.id) * 0.08;
      v.model.root.rotation.z = sway;
      if (c.landed && !v.landed) this.land(v, c);
      if (v.landed) {
        // the parachute folds down beside it, the flare smokes
        v.fold = Math.min(1, (v.fold || 0) + dt / 1.4);
        const ch = v.model.chute, f = v.fold * v.fold;
        // the canopy loses its air and crumples down beside the crate
        ch.scale.setScalar(Math.max(0.01, 1 - f));
        ch.position.set(v.fold * 1.2, 0, 0);
        ch.rotation.z = -v.fold * 1.2;
        if (v.fold >= 1) ch.visible = false;
        v.smokeT = (v.smokeT || 0) - dt;
        if (v.smokeT <= 0) {
          v.smokeT = 0.12;
          const fp = v.model.flare.getWorldPosition(_v);
          this.smoke.puff(fp, new THREE.Vector3(rand(-0.2, 0.2), rand(0.6, 1.1), rand(-0.2, 0.2)), { size: 0.25, grow: 2.4, life: 4.5, opacity: 0.4, color: 0xb83a2c });
        }
      }
    }
    for (const [id, v] of this.views) {
      if (v.opening === undefined) continue;
      v.opening += dt;
      v.model.lid.rotation.x = -Math.min(1.9, v.opening * 5);
      if (v.opening > 1.4) { this.dropView(v); this.views.delete(id); }
    }
    // the flare lights: the two newest landed crates
    const lit = [...this.views.values()].filter((v) => v.landed && v.opening === undefined).slice(-2);
    this.crateLights.forEach((L, i) => {
      const v = lit[i];
      L.intensity = v ? 7 * (0.8 + 0.2 * Math.sin(this.time * 17 + i)) : 0;
      if (v) L.position.copy(v.model.flare.getWorldPosition(_v)).y += 0.25;
    });
  }

  makeView(c) {
    const model = buildCrate();
    this.G.scene.add(model.root);
    const v = { id: c.id, model, y: c.y, landed: false };
    for (const m of [model.body]) { m.userData.surface = 'wood'; }
    this.views.set(c.id, v);
    return v;
  }

  land(v, c) {
    const G = this.G;
    v.landed = true;
    v.y = 0;
    G.audio.play('thud');
    G.gore.dust?.(new THREE.Vector3(c.x, 0.05, c.z), new THREE.Vector3(0, 1, 0), 14);
    // you bump into it, and press E on it
    v.collider = G.map.addCollider(new THREE.Vector3(c.x - 0.5, 0, c.z - 0.5), new THREE.Vector3(c.x + 0.5, 0.68, c.z + 0.5), { walk: true, surface: 'wood' });
    const meshes = [];
    v.model.root.traverse((o) => { if (o.isMesh && o.parent !== v.model.chute) meshes.push(o); });
    v.interact = {
      meshes,
      prompt: () => 'Open the supply crate',
      press: () => { if (this.host) this.openCrate(this.me(), c.id); else this.G.net.vsRequest({ open: c.id }); v.interact.enabled = false; },
    };
    for (const m of meshes) m.userData.interact = v.interact;
    G.map.interactables.push(v.interact);
  }

  removeCrateBits(v) {
    const G = this.G;
    if (v.collider) { G.map.removeCollider(v.collider); v.collider = null; }
    if (v.interact) {
      const i = G.map.interactables.indexOf(v.interact);
      if (i >= 0) G.map.interactables.splice(i, 1);
      v.interact = null;
    }
  }

  dropView(v) {
    this.removeCrateBits(v);
    this.G.scene.remove(v.model.root);
  }

  // ---------------------------------------------------------------- gadgets
  /** A mine or a sentry gun put down by you. */
  placeGadget(kind, pos, yaw) {
    const k = kind === 'mine' ? 'mine' : 'sentry';
    if (this.host) { this.G.gadgets.place(k, pos, yaw, { owner: 0 }); this.dirty = true; }
    else this.G.net.vsRequest({ place: { k, p: [pos.x, pos.y, pos.z], y: yaw } });
  }

  /** The map was loaded again (by the host's game): the crates and gadgets went with it. */
  onMapLoaded(id) {
    if (!this.active) return;
    if (id !== 'cemetery') { if (this.host) this.stop(); else this.onFriendLeave?.(); return; }
    for (const v of this.views.values()) this.dropView(v);
    this.views.clear();
    this.mInteract = null;
    this.mState = 'away'; this.cartSet = false; this.merchant.root.visible = this.cart.root.visible = false;
  }
}
