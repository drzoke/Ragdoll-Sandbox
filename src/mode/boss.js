import * as THREE from 'three';
import { BruteModel, brutePose, EMERGE, EMERGE_BEATS } from './brute.js';
import { rand, clamp } from '../core/util.js';

/**
 * The boss fight of VS Undead (every third wave): the Big Brute.
 *
 * Every game shows it: the dig-out cutscene, its poses, the health bar, the dust and the sounds.
 * The host's game also runs it: where it goes, who it swipes at, when it roars up its minions,
 * the damage it takes. Friends get its state about ten times a second.
 *
 * Anim codes on the wire: 0 emerge, 1 idle, 2 walk, 3 swipe, 4 roar, 5 die, 6 slam, 7 charge.
 *
 * Its moves: a swipe up close; a ground slam when you're near (a shockwave that throws you up and
 * back); a charge when you keep your distance (it lowers its head and runs you down); and a roar
 * that raises 2 to 4 of the dead around it. Below 40% health it is enraged: faster at everything.
 */
const ANIMS = ['emerge', 'idle', 'walk', 'swipe', 'roar', 'die', 'slam', 'charge'];
const SPEED = 2.6, TURN = 1.8;
const SWIPE_RANGE = 3.3, SWIPE_HIT = 3.8, SWIPE_DMG = 30;
const SLAM_RANGE = 6.5, SLAM_RADIUS = 6, SLAM_DMG = 24;
const CHARGE_MIN = 9, CHARGE_SPEED = 9, CHARGE_DMG = 30, CHARGE_T = 2.2;
const ROAR_FIRST = 5, DIE_T = 6.5;
const RADIUS = 0.95;          // how close you can get (its bulk)
const _v = new THREE.Vector3(), _w = new THREE.Vector3(), _q = new THREE.Quaternion(), _m = new THREE.Matrix4();
const UP = new THREE.Vector3(0, 1, 0);
const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const ss = (u) => u * u * (3 - 2 * u);

export class BossFight {
  constructor(mode) {
    this.mode = mode;
    this.G = mode.G;
    this.model = new BruteModel();
    this.model.fight = this;
    this.G.scene.add(this.model.root, this.model.hole);
    this.active = false;
    this.pos = new THREE.Vector3(); this.shown = new THREE.Vector3();
    this.netPos = new THREE.Vector3();
    this.spawn = new THREE.Vector3();
    this.yaw = 0; this.shownYaw = 0;
    this.hp = 1; this.max = 1;
    this.anim = 'idle'; this.at = 0; this.walkPh = 0; this.speed = 0; this.side = 1;
    this.cine = false; this.cineT = 0;
    this.chunks = [];
    // a cold light on it, so it reads in the dark (brighter while it digs out)
    this.light = new THREE.PointLight(0xa8bce0, 0, 11, 1.4);
    this.G.scene.add(this.light);
    this.buildUi();
    // something the sentries and mines can see (shaped like a ragdoll as far as they care)
    const head = { body: { position: new THREE.Vector3() }, removed: false };
    const chest = { body: { position: new THREE.Vector3() }, removed: false };
    const feet = { body: { position: new THREE.Vector3() }, removed: false };
    this.foe = { brute: true, removed: false, hidden: false, zombie: true, parts: { head, chest, pelvis: feet, footL: feet, footR: feet }, health: { alive: true, parts: { head: { attached: true } } } };
  }

  buildUi() {
    const el = (id, html) => { const e = document.createElement('div'); e.id = id; e.className = 'hidden'; e.innerHTML = html; return e; };
    this.ui = {
      bar: el('vs-boss', '<b>Big Brute</b><div class="vs-bossbar"><u></u><i></i></div>'),
      cine: el('vs-cine', '<div class="bar top"></div><div class="bar bot"></div><div class="vs-cine-title"><b>Big Brute</b><span></span></div><div class="vs-cine-skip"><kbd>Space</kbd> skip</div>'),
    };
    document.getElementById('hud').appendChild(this.ui.bar);
    document.body.appendChild(this.ui.cine);
  }

  get host() { return this.mode.host; }

  // ================================================================ start and end
  /** Every game: the Brute starts digging itself out at (x, z), facing yaw. */
  begin({ x, z, yaw, hp, max, wave }) {
    const m = this.model;
    this.active = true; this.dead = false;
    this.spawn.set(x, 0, z);
    this.pos.copy(this.spawn); this.shown.copy(this.spawn); this.netPos.copy(this.spawn);
    this.yaw = this.shownYaw = this.netYaw = yaw;
    this.hp = hp; this.max = max; this.shownHp = hp;
    this.setAnim('emerge');
    this.fired = new Set();
    m.root.visible = true; m.root.position.copy(this.spawn); m.root.rotation.y = yaw;
    m.hole.visible = true; m.hole.position.copy(this.spawn); m.hole.rotation.y = yaw;
    m.hole.scale.setScalar(0.01);
    m.pit.material.opacity = 0;
    m.root.scale.setScalar(1);
    m.setGlow(3);
    this.foe.health.alive = true; this.foe.removed = false;
    // host: the fight's own timers
    this.roarCd = ROAR_FIRST; this.swipeCd = 0; this.slamCd = 5; this.chargeCd = 8; this.seekT = 0; this.target = null;
    this.hitPts = {}; this.sendT = 0; this.enraged = false;
    this.ui.cine.querySelector('.vs-cine-title span').textContent = `Wave ${wave} boss`;
    this.startCine();
  }

  /** Gone (the mode stopped, or a new game). */
  clear() {
    this.active = false;
    this.model.root.visible = false; this.model.hole.visible = false;
    this.light.intensity = 0;
    this.foe.health.alive = false; this.foe.removed = true;
    this.ui.bar.classList.add('hidden');
    this.ui.bar.classList.remove('dying');
    this.endCine(true);
    for (const c of this.chunks) this.G.scene.remove(c.m);
    this.chunks = [];
  }

  setAnim(a) {
    if (a === this.anim && a !== 'swipe' && a !== 'roar') return;
    this.anim = a; this.at = 0;
    this.onAnim(a);
  }

  /** What every game does when an animation starts: the sounds. */
  onAnim(a) {
    const A = this.G.audio;
    if (a === 'roar') { A.play('roar', this.near(1)); this.G.player.blastShake = Math.max(this.G.player.blastShake || 0, 0.6 * this.near(1)); }
    else if (a === 'swipe') A.play('growl', this.near(0.8));
    else if (a === 'die') { A.play('bossDown', this.near(1)); this.ui.bar.classList.add('dying'); }
    else if (a === 'slam') A.play('growl', this.near(1));
    else if (a === 'charge') { A.play('roar', this.near(0.8)); this.G.player.blastShake = Math.max(this.G.player.blastShake || 0, 0.4 * this.near(1)); }
  }

  /** Volume for something it does: louder close up. */
  near(v) { const d = this.G.player.pos.distanceTo(this.shown); return v * clamp(14 / (d + 6), 0.25, 1.2); }

  // ================================================================ the cutscene (each game its own)
  startCine() {
    this.cine = true; this.cineT = 0;
    this.ui.cine.classList.remove('hidden', 'titled');
    document.body.classList.add('vs-cine');
    this.mode.closeShop();
  }

  endCine(quiet = false) {
    if (!this.cine) return;
    this.cine = false;
    this.ui.cine.classList.add('hidden');
    document.body.classList.remove('vs-cine');
    if (!quiet) this.mode.banner('Bring it down', 'Aim for the head. When it falls, its minions fall with it.', 4);
  }

  /** The cutscene camera: in front of the Brute, pushing in, then low for the roar. */
  updateCine(dt) {
    this.cineT += dt;
    const t = this.cineT, B = EMERGE_BEATS;
    if (this.G.input.wasPressed('Space') && t > 1) this.endCine();
    if (t >= EMERGE + 0.3 || this.anim !== 'emerge') this.endCine();
    if (!this.cine) return;
    if (t > B.roar && !this.ui.cine.classList.contains('titled')) this.ui.cine.classList.add('titled');
    const cam = this.G.camera, s = this.spawn;
    const f = _v.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));    // the way it faces
    const side = _w.set(-f.z, 0, f.x);
    // keys: [time, distance in front, sideways, height, look-at forward, look-at height]
    const K = [
      [0, 5.2, 1.0, 1.25, -0.2, 0.5], [B.burst + 1, 5.0, 1.2, 1.2, -0.1, 0.7], [B.slamR, 6.4, 1.6, 1.45, 0.8, 0.5], [B.out, 7.6, -1.2, 1.3, 1.0, 1.0],
      [B.stand, 8.6, -1.6, 1.25, 1.1, 1.9], [B.roar, 6.2, -0.8, 0.55, 1.1, 2.9], [EMERGE, 6.0, -0.7, 0.5, 1.1, 2.9],
    ];
    let i = 0;
    while (i < K.length - 2 && t > K[i + 1][0]) i++;
    const a = K[i], b = K[i + 1], u = ss(clamp((t - a[0]) / (b[0] - a[0])));
    const L = (j) => a[j] + (b[j] - a[j]) * u;
    const shake = (this.shake = Math.max(0, (this.shake || 0) - dt * 1.8)) * 0.12;
    cam.position.copy(s).addScaledVector(f, L(1)).addScaledVector(side, L(2)).setY(L(3));
    cam.position.x += (Math.random() - 0.5) * shake; cam.position.y += (Math.random() - 0.5) * shake;
    const look = s.clone().addScaledVector(f, L(4)).setY(L(5));
    _m.lookAt(cam.position, look, UP);
    cam.quaternion.setFromRotationMatrix(_m);
    cam.updateMatrixWorld();
  }

  // ================================================================ every frame, every game
  update(dt) {
    if (!this.active) return;
    const m = this.model;
    this.at += dt;
    if (this.host) this.think(dt);
    else {
      // a friend: glide to where the host says it is
      const k = Math.min(1, dt * 10);
      this.pos.lerp(this.netPos, k);
      this.yaw += wrap(this.netYaw - this.yaw) * k;
      this.walkPh += dt * this.speed * 2.6;
    }
    this.shown.copy(this.pos);
    this.shownYaw = this.yaw;
    if (this.anim === 'emerge') this.emergeFx(dt);
    // the pose
    m.flinch = Math.max(0, m.flinch - dt * 4);
    const p = this.anim === 'emerge' && this.at >= EMERGE ? brutePose('idle', this.at, {}) : brutePose(this.anim, this.at, { walkPh: this.walkPh, speed: this.speed, side: this.side });
    m.apply(p);
    m.root.position.copy(this.shown);
    m.root.rotation.y = this.shownYaw;
    // dying: down on its face, then it sinks back into the dirt
    if (this.anim === 'die') {
      const sink = ss(clamp((this.at - 3.4) / 2.6));
      m.root.position.y = -sink * 1.6;
      m.setGlow(3 * (1 - clamp(this.at / 1.5)));
      m.hole.scale.setScalar(Math.max(0.01, 1 - ss(clamp((this.at - 5) / 1.5))));
      if (this.at > DIE_T) { m.root.visible = false; m.hole.visible = false; }
    } else m.setGlow(this.enraged ? 4.5 + Math.sin(this.at * 9) : 3);
    const f0 = _v.set(-Math.sin(this.shownYaw), 0, -Math.cos(this.shownYaw));
    this.light.position.copy(this.shown).addScaledVector(f0, 2.6).setY(3.4);
    this.light.intensity = !m.root.visible ? 0 : this.cine ? 14 : this.anim === 'die' ? 6 * (1 - clamp(this.at / DIE_T)) : 6;
    // the hole stays where it climbed out
    m.hole.position.copy(this.spawn);
    this.updateChunks(dt);
    // the health bar
    const shownHp = (this.shownHp += (this.hp - this.shownHp) * Math.min(1, dt * 3));
    const showBar = this.anim !== 'emerge' || this.at > EMERGE_BEATS.roar;
    this.ui.bar.classList.toggle('hidden', !showBar || (this.anim === 'die' && this.at > 2.5));
    if (showBar) {
      this.ui.bar.querySelector('i').style.width = `${(100 * clamp(this.hp / this.max)).toFixed(1)}%`;
      this.ui.bar.querySelector('u').style.width = `${(100 * clamp(shownHp / this.max)).toFixed(1)}%`;
      this.ui.bar.classList.toggle('rage', this.enraged);
    }
    // the sentries and mines: where its head, chest and feet are
    const f = this.foe.parts;
    this.model.neck.getWorldPosition(f.head.body.position).y += 0.2;
    this.model.spine.getWorldPosition(f.chest.body.position).y += 0.6;
    f.pelvis.body.position.copy(this.shown).setY(0.3);
    this.foe.health.alive = this.alive;
    // you can't walk through it
    const P = this.G.player.pos;
    if (this.alive && this.anim !== 'emerge') {
      const dx = P.x - this.shown.x, dz = P.z - this.shown.z, d = Math.hypot(dx, dz);
      if (d < RADIUS + 0.35 && d > 1e-3 && P.y < 2.6) { const push = (RADIUS + 0.35 - d) / d; P.x += dx * push; P.z += dz * push; }
    }
    if (this.cine) this.updateCine(dt);
  }

  get alive() { return this.active && this.anim !== 'die'; }

  /** Dust, flying clods and thumps while it digs out (every game, from the same timeline). */
  emergeFx(dt) {
    const t = this.at, B = EMERGE_BEATS, m = this.model, s = this.spawn;
    const once = (k) => { if (t >= B[k] && !this.fired.has(k)) { this.fired.add(k); return true; } return false; };
    const f = _v.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw)).clone();
    const side = new THREE.Vector3(-f.z, 0, f.x);
    // the ground swells and breaks open
    const open = ss(clamp((t - 0.6) / 1.4));
    m.hole.scale.setScalar(Math.max(0.01, open));
    m.pit.material.opacity = 0.92 * open;
    if (t < B.stand) { this.shake = Math.max(this.shake || 0, 0.25 + 0.2 * Math.sin(t * 3)); }
    this.dustT = (this.dustT || 0) - dt;
    if (t > 0.6 && t < B.stand && this.dustT <= 0) {
      this.dustT = 0.12;
      const a = Math.random() * Math.PI * 2;
      this.mode.smoke.puff(s.clone().add(new THREE.Vector3(Math.cos(a) * 1.2, 0.1, Math.sin(a) * 1.2)), new THREE.Vector3(Math.cos(a) * 0.5, rand(0.3, 0.7), Math.sin(a) * 0.5), { size: 0.6, grow: 2.6, life: 3, opacity: 0.35, color: 0x5a4c3a });
    }
    if (once('rumble')) this.G.audio.play('rumble', 1);
    if (once('burst')) this.burst(s.clone().addScaledVector(side, -0.78).addScaledVector(f, 0.3), 14, 1.2);
    if (once('slamR')) { this.burst(s.clone().addScaledVector(f, 1.9).addScaledVector(side, -0.85), 10, 0.8); this.G.audio.play('slam', this.near(1)); this.shake = 1; }
    if (once('burstL')) this.burst(s.clone().addScaledVector(side, 0.78).addScaledVector(f, 0.3), 12, 1.1);
    if (once('slamL')) { this.burst(s.clone().addScaledVector(f, 1.9).addScaledVector(side, 0.85), 10, 0.8); this.G.audio.play('slam', this.near(1)); this.shake = 1; }
    if (once('out')) { this.burst(s.clone().addScaledVector(f, 0.6), 22, 1.6); this.G.audio.play('growl', this.near(1)); }
    if (once('stand')) this.G.audio.play('slam', this.near(0.6));
    if (once('roar')) { this.G.audio.play('roar', this.near(1.1)); this.shake = 1.4; this.G.player.blastShake = 0.8; }
  }

  /** Clods of dirt thrown up at p. */
  burst(p, n, power = 1) {
    const geo = this.chunkGeo || (this.chunkGeo = new THREE.DodecahedronGeometry(1, 0));
    const mat = this.model.mound.material;
    for (let i = 0; i < n; i++) {
      const c = this.chunks.length > 60 ? this.chunks.shift() : { m: new THREE.Mesh(geo, mat) };
      if (!c.m.parent) this.G.scene.add(c.m);
      c.m.visible = true;
      c.m.scale.setScalar(rand(0.04, 0.12));
      c.m.position.copy(p).add(new THREE.Vector3(rand(-0.4, 0.4), 0.1, rand(-0.4, 0.4)));
      c.v = new THREE.Vector3(rand(-2, 2), rand(3, 6.5), rand(-2, 2)).multiplyScalar(power);
      c.spin = new THREE.Vector3(rand(-8, 8), rand(-8, 8), rand(-8, 8));
      c.life = rand(1.8, 2.6);
      this.chunks.push(c);
    }
    for (let i = 0; i < 4; i++) this.mode.smoke.puff(p.clone().add(new THREE.Vector3(rand(-0.4, 0.4), 0.2, rand(-0.4, 0.4))), new THREE.Vector3(rand(-0.6, 0.6), rand(0.6, 1.4), rand(-0.6, 0.6)), { size: 0.5, grow: 2.4, life: 2.6, opacity: 0.45, color: 0x5d4e3b });
  }

  updateChunks(dt) {
    for (let i = this.chunks.length - 1; i >= 0; i--) {
      const c = this.chunks[i];
      c.life -= dt;
      if (c.life <= 0) { this.G.scene.remove(c.m); this.chunks.splice(i, 1); continue; }
      c.v.y -= 9.8 * dt;
      c.m.position.addScaledVector(c.v, dt);
      if (c.m.position.y < 0.03) { c.m.position.y = 0.03; c.v.multiplyScalar(0.3); c.v.y = Math.abs(c.v.y) * 0.3; }
      c.m.rotation.x += c.spin.x * dt; c.m.rotation.y += c.spin.y * dt;
      if (c.life < 0.4) c.m.scale.multiplyScalar(1 - dt * 3);
    }
  }

  // ================================================================ the host: the fight
  people() {
    const G = this.G, out = [];
    if (!G.vitals.dead) out.push({ id: this.mode.me(), pos: G.player.pos, me: true });
    for (const f of G.net.friendInfos()) if (f.alive) out.push({ id: f.id, pos: f.pos });
    return out;
  }

  think(dt) {
    const a = this.anim;
    if (a === 'emerge') {
      if (this.at >= EMERGE) {
        // it's out: from here on it stands where the climb left it
        this.pos.addScaledVector(_v.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw)), 1.1);
        this.setAnim('idle');
        this.send(true);
      } else { this.sendT -= dt; if (this.sendT <= 0) this.send(); }
      return;
    }
    if (a === 'die') { this.sendT -= dt; if (this.sendT <= 0) this.send(); return; }
    this.enraged = this.hp < this.max * 0.4;
    const rage = this.enraged ? 1.2 : 1;
    this.roarCd -= dt; this.swipeCd -= dt; this.slamCd -= dt; this.chargeCd -= dt; this.seekT -= dt;
    const ppl = this.people();
    if (this.seekT <= 0 || (this.target && !ppl.some((p) => p.id === this.target.id))) {
      this.seekT = 1;
      let best = null, bd = 1e9;
      for (const p of ppl) { const d = Math.hypot(p.pos.x - this.pos.x, p.pos.z - this.pos.z); if (d < bd) { bd = d; best = p; } }
      this.target = best;
    }
    const T = this.target && ppl.find((p) => p.id === this.target.id);
    let want = this.yaw, dist = 99;
    if (T) {
      const dx = T.pos.x - this.pos.x, dz = T.pos.z - this.pos.z;
      dist = Math.hypot(dx, dz);
      want = Math.atan2(-dx, -dz);
    }
    const diff = wrap(want - this.yaw);
    let moving = 0;
    if (a === 'swipe') {
      this.yaw += clamp(diff, -0.8 * dt, 0.8 * dt);
      if (this.at > 0.62 && !this.hitDone) { this.hitDone = true; this.swipeHit(); }
      if (this.at > 1.3 / rage) { this.setAnim('walk'); this.swipeCd = rand(0.5, 1.2) / rage; }
    } else if (a === 'roar') {
      if (this.at > 0.9 && !this.summoned) { this.summoned = true; this.mode.summonMinions(this); }
      if (this.at > 2.2) { this.setAnim('walk'); this.roarCd = rand(13, 18) / rage; }
    } else if (a === 'slam') {
      this.yaw += clamp(diff, -0.6 * dt, 0.6 * dt);
      if (this.at > 0.86 && !this.hitDone) { this.hitDone = true; this.slamHit(); }
      if (this.at > 1.7 / rage) { this.setAnim('walk'); this.slamCd = rand(9, 12) / rage; }
    } else if (a === 'charge') {
      // wind up facing them, then run straight; it only turns a little once it's going
      if (this.at < 0.9) this.yaw += clamp(diff, -3 * dt, 3 * dt);
      else {
        this.yaw += clamp(diff, -0.35 * dt, 0.35 * dt);
        moving = CHARGE_SPEED * (this.enraged ? 1.15 : 1);
        if (!this.hitDone) this.chargeHit();
        const blocked = this.chargeBlocked;
        if (this.at > 0.9 + CHARGE_T || blocked) { this.setAnim('walk'); this.chargeCd = rand(12, 16) / rage; this.swipeCd = 0.6; if (blocked) { this.G.audio.play('slam', this.near(0.8)); } }
      }
    } else {
      // idle / walk: turn to the nearest player and stomp after them
      this.yaw += clamp(diff, -TURN * rage * dt, TURN * rage * dt);
      if (T && this.roarCd <= 0 && this.mode.minionsAlive() < 6) { this.summoned = false; this.setAnim('roar'); this.send(true); }
      else if (T && dist > CHARGE_MIN && dist < 26 && this.chargeCd <= 0 && Math.abs(diff) < 1.2) { this.hitDone = false; this.chargeBlocked = false; this.hitIds = new Set(); this.setAnim('charge'); this.send(true); }
      else if (T && dist < SLAM_RANGE && dist > 2 && this.slamCd <= 0 && Math.abs(diff) < 0.9) { this.hitDone = false; this.setAnim('slam'); this.send(true); }
      else if (T && dist < SWIPE_RANGE && this.swipeCd <= 0 && Math.abs(diff) < 0.7) {
        this.side = Math.random() < 0.5 ? 1 : -1; this.hitDone = false;
        this.setAnim('swipe'); this.send(true);
      } else if (T && dist > SWIPE_RANGE - 0.8) {
        moving = SPEED * rage * (this.mode.wave >= 6 ? 1.1 : 1) * clamp(1.2 - Math.abs(diff), 0.2, 1);
        this.setAnim('walk');
      } else this.setAnim('idle');
    }
    // walking: forward, slowed while turning; kept off the trees and inside the field
    this.speed += ((moving ? 1 : 0) - this.speed) * Math.min(1, dt * 4);
    if (moving) {
      this.pos.addScaledVector(_v.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw)), moving * dt);
      this.walkPh += dt * moving * (a === 'charge' ? 1.5 : 2.6);
      const before = this.pos.clone();
      this.collide();
      if (a === 'charge' && before.distanceToSquared(this.pos) > 0.0004) this.chargeBlocked = true;   // ran into a tree or the fence
    }
    this.sendT -= dt;
    if (this.sendT <= 0) this.send();
  }

  collide() {
    const G = this.G, b = G.map.bounds, p = this.pos, r = 0.8;
    p.x = clamp(p.x, b.minX + 1.5, b.maxX - 1.5); p.z = clamp(p.z, b.minZ + 1.5, b.maxZ - 1.5);
    for (const c of G.map.near(p.x - r, 0.2, p.z - r, p.x + r, 2.5, p.z + r)) {
      if (c.off || c.max.y < 0.4) continue;
      const ox = Math.min(p.x + r - c.min.x, c.max.x - (p.x - r)), oz = Math.min(p.z + r - c.min.z, c.max.z - (p.z - r));
      if (ox <= 0 || oz <= 0) continue;
      if (ox < oz) p.x += p.x < (c.min.x + c.max.x) / 2 ? -ox : ox;
      else p.z += p.z < (c.min.z + c.max.z) / 2 ? -oz : oz;
    }
  }

  /** The swipe lands: everyone in front of it and in reach is hit and thrown back. */
  swipeHit() {
    const G = this.G;
    const f = _v.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw)).clone();
    let any = false;
    for (const p of this.people()) {
      const d = _w.set(p.pos.x - this.pos.x, 0, p.pos.z - this.pos.z);
      const dist = d.length();
      if (dist > SWIPE_HIT || dist < 1e-3) continue;
      if (d.normalize().dot(f) < 0.35) continue;
      any = true;
      const dmg = SWIPE_DMG * (this.enraged ? 1.15 : 1);
      const from = this.pos.clone().setY(1.5);
      const kb = [d.x * 9, 4.5, d.z * 9];
      if (p.me) { G.vitals.hurt(dmg, { kind: 'zombie' }); this.knock(kb); }
      else { G.net.hurtFriend(p.id, dmg, { kind: 'zombie', from }); G.net.sendTo(p.id, { kb }); }
    }
    G.audio.play(any ? 'punchHard' : 'swing', this.near(1));
    this.send(true);
  }

  /** The slam lands: a shockwave around it that hurts and throws everyone near (less further out). */
  slamHit() {
    const G = this.G;
    const c = this.pos.clone().addScaledVector(_v.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw)), 1.6);
    for (const p of this.people()) {
      const d = _w.set(p.pos.x - c.x, 0, p.pos.z - c.z);
      const dist = d.length();
      if (dist > SLAM_RADIUS || p.pos.y > 1.2) continue;          // jump it and it misses you
      const k = 1 - dist / SLAM_RADIUS;
      d.normalize();
      const dmg = SLAM_DMG * (0.35 + 0.65 * k) * (this.enraged ? 1.1 : 1);
      const kb = [d.x * 7 * k, 5 + 3 * k, d.z * 7 * k];
      if (p.me) { G.vitals.hurt(dmg, { kind: 'zombie' }); this.knock(kb); }
      else { G.net.hurtFriend(p.id, dmg, { kind: 'zombie', from: c }); G.net.sendTo(p.id, { kb }); }
    }
    if (G.net.host) G.net.emit({ t: 'vs', fx: 'slam', p: [+c.x.toFixed(2), +c.z.toFixed(2)] });
    this.slamFx(c);
  }

  /** Every game: dust and dirt where the fists hit, a boom and a shake. */
  slamFx(c) {
    this.burst(new THREE.Vector3(c.x, 0.05, c.z), 18, 1.3);
    for (let i = 0; i < 10; i++) {
      const a = (i / 10) * Math.PI * 2;
      this.mode.smoke.puff(new THREE.Vector3(c.x + Math.cos(a) * 1.2, 0.15, c.z + Math.sin(a) * 1.2), new THREE.Vector3(Math.cos(a) * 4, 0.4, Math.sin(a) * 4), { size: 0.6, grow: 2.8, life: 2.2, opacity: 0.4, color: 0x5d4e3b });
    }
    this.G.audio.play('slam', this.near(1.2));
    this.G.player.blastShake = Math.max(this.G.player.blastShake || 0, 0.9 * this.near(1));
  }

  /** Charging: anyone in its path gets run down (once each per charge). */
  chargeHit() {
    const G = this.G;
    const f = _v.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw)).clone();
    for (const p of this.people()) {
      if (this.hitIds.has(p.id)) continue;
      const d = _w.set(p.pos.x - this.pos.x, 0, p.pos.z - this.pos.z);
      if (d.length() > 2.1 || d.normalize().dot(f) < 0.2) continue;
      this.hitIds.add(p.id);
      const dmg = CHARGE_DMG * (this.enraged ? 1.1 : 1);
      const side = new THREE.Vector3(-f.z, 0, f.x).multiplyScalar(Math.sign(d.dot(new THREE.Vector3(-f.z, 0, f.x))) || 1);
      const kb = [f.x * 11 + side.x * 5, 6, f.z * 11 + side.z * 5];
      if (p.me) { G.vitals.hurt(dmg, { kind: 'zombie' }); this.knock(kb); }
      else { G.net.hurtFriend(p.id, dmg, { kind: 'zombie', from: this.pos.clone().setY(1.5) }); G.net.sendTo(p.id, { kb }); }
      G.audio.play('punchHard', this.near(1));
    }
  }

  /** Thrown back by a swipe (my own player). */
  knock(kb) {
    const pl = this.G.player;
    pl.vel.x += kb[0]; pl.vel.z += kb[2]; pl.vel.y = Math.max(pl.vel.y, kb[1]);
    pl.onGround = false;
    pl.blastShake = Math.max(pl.blastShake || 0, 0.7);
  }

  // ---------------------------------------------------------------- what hits it (every game)
  /** A bullet into it. ghost: a friend's tracer (the host works out the damage). */
  onBullet(b, hit, dir, zone, ghost = false) {
    if (!this.alive) return;
    const G = this.G;
    G.gore.spray(hit.point, dir.clone().negate().add(_v.set(0, 0.35, 0)), b.pellet ? 4 : 10, { speed: 2.2, spread: 0.6, size: 0.02, volume: 0.8 });
    this.model.flinch = Math.min(1, this.model.flinch + (b.pellet ? 0.06 : 0.18));
    if (ghost || !this.host) return;
    this.damage(14 * b.energy * (b.bot ? 0.4 : 1), zone, b.owner);
  }

  /** A fist or a blade (amount: damage before the head bonus). */
  onMelee(amount, zone, point, dir) {
    if (!this.alive) return;
    this.G.gore.spray(point, dir.clone().negate().add(_v.set(0, 0.3, 0)), 8, { speed: 1.6, spread: 0.6, size: 0.02, volume: 0.7 });
    this.model.flinch = Math.min(1, this.model.flinch + 0.25);
    if (this.host) this.damage(amount, zone, this.mode.me());
    else this.G.net.vsRequest({ bm: { a: Math.min(60, amount), z: zone } });
  }

  /** Host: a grenade or a mine went off at c. */
  onBlast(c, owner) {
    if (!this.alive || !this.host) return;
    const d = c.distanceTo(_v.copy(this.shown).setY(1.6));
    if (d > 6) return;
    const k = Math.pow(1 - d / 6, 1.6);
    this.damage(260 * k, 'body', owner);
    this.model.flinch = 1;
  }

  /** Host: it takes a hit. zone 'head' hurts it most. Returns the damage done. */
  damage(amount, zone, owner) {
    if (!this.alive || this.anim === 'emerge') return 0;
    const dmg = amount * (zone === 'head' ? 2.3 : 1);
    this.hp = Math.max(0, this.hp - dmg);
    this.model.flinch = Math.min(1, this.model.flinch + dmg / 50);
    // points for hurting it (a little, up to a limit per player)
    const id = owner || this.mode.me();
    const got = this.hitPts[id] || 0;
    if (got < 150) { const n = Math.min(150 - got, zone === 'head' ? 4 : 2); this.hitPts[id] = got + n; this.mode.addPts(id, n); }
    if (this.hp <= 0) {
      this.setAnim('die');
      this.mode.bossDown(this, id);
    }
    this.dirtyHp = true;
    return dmg;
  }

  /** Host: its state to the friends (often, small). */
  send(now = false) {
    if (!this.G.net.host) return;
    this.sendT = now ? 0.1 : 0.1;
    this.G.net.emit({ t: 'vs', b: [+this.pos.x.toFixed(2), +this.pos.z.toFixed(2), +this.yaw.toFixed(3), ANIMS.indexOf(this.anim), +this.at.toFixed(2), Math.round(this.hp), Math.round(this.max), this.enraged ? 1 : 0, +this.speed.toFixed(2), this.side] });
  }

  /** A friend: the host's latest. */
  onNet(b) {
    if (!this.active) return;
    const [x, z, yaw, ai, at, hp, max, rage, speed, side] = b;
    this.netPos.set(x, 0, z); this.netYaw = yaw;
    const anim = ANIMS[ai] || 'idle';
    if (anim !== this.anim || (at < this.at - 0.5 && (anim === 'swipe' || anim === 'roar'))) {
      // out of the ground: jump to where it stands now
      if (this.anim === 'emerge') { this.pos.copy(this.netPos); this.yaw = yaw; }
      this.side = side; this.setAnim(anim); this.at = at;
    } else if (anim === 'emerge' && Math.abs(at - this.at) > 0.6) this.at = at;
    if (hp < this.hp) this.model.flinch = Math.min(1, this.model.flinch + (this.hp - hp) / 50);
    this.hp = hp; this.max = max; this.enraged = !!rage; this.speed = speed;
  }
}
