// Multiplayer: one player hosts a room, friends join it with its code.
//
// The host's game is the real one: its physics, ragdoll brains, health and damage run as usual.
// Friends see a copy of it:
//   - body positions (ragdolls, gibs, grenades) and every player's movement come about 20 times a
//     second over an unreliable channel, and are smoothed by showing the world ~0.1 s behind;
//   - everything else the host's game does that shows (a wound, a blood spray, a severed arm, a
//     gib, a broken window, a grenade going off, a ragdoll spawning or turning into a zombie) is
//     sent as an event and replayed on the friend's copy, in step with the smoothed positions;
//   - each ragdoll's health (vitals, organs, bones, wounds) is sent a few times a second, only the
//     parts that changed, so the X-ray and the bleeding look the same everywhere.
// A friend's shots go to the host, which works out the damage like for its own shots; the friend
// sees their tracer straight away.
//
// Part 1 of multiplayer: friends use the guns; the other items, the elevator and zombies going
// after friends come next.
import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { openRoom, joinRoom, cleanCode, errorText } from './transport.js';
import { encode, decode, registerMaterials, healthSections, applyHealth, woundAt, woundData, Writer, Reader } from './codec.js';
import { Avatar, PLAYER_COLORS } from './avatar.js';
import { PARTS, PART_BY_NAME } from '../ragdoll/skeleton.js';
import { GROUP } from '../core/physics.js';
import { MAT as GORE_MAT } from '../gore/gore.js';
import { CONFIG } from '../config.js';

const NET_VERSION = 1;
const SNAP_HZ = 20;          // host -> friends: positions
const STATE_HZ = 30;         // friend -> host: own movement
const HEALTH_HZ = 5;         // host -> friends: health
const DELAY = 110;           // ms friends see the world behind the host (smooths between updates)
const MAX_PLAYERS = 6;
const GUEST_TOOLS = new Set(['M1911', 'Remington 870', 'M24 Sniper', 'Flintlock Musket']);
const GUN_SOUND = { 'M1911': 'shot', 'Remington 870': 'shotgun', 'M24 Sniper': 'sniper', 'Flintlock Musket': 'musket' };
// what the host's game does that friends see, replayed on their copy (see Gore)
const GORE_CALLS = ['spray', 'dust', 'bulletImpactWorld', 'bloodyImpactWorld', 'pelletSpatter', 'addBruise', 'bulletWound', 'bladeWound',
  'armorHit', 'sparks', 'bandage', 'tourniquet', 'splint', 'paddleMarks', 'onSever', 'openPart', 'explodePart', 'impactBlood'];
const RAGDOLL_CALLS = ['sever', 'makeZombie', 'addArmor', 'removeArmor'];
const NPARTS = PARTS.length;
const SLEEPING = CANNON.Body.SLEEPING;

registerMaterials(GORE_MAT);

const _v = new THREE.Vector3(), _q1 = new THREE.Quaternion(), _q2 = new THREE.Quaternion();
const isRagdoll = (o) => o && typeof o === 'object' && o.parts && o.health && o.root;

/** Remote clock: the best (smallest delay) offset seen, drifting slowly when the delay changes. */
class Clock {
  constructor() { this.offset = null; }
  sample(remote, local = performance.now()) {
    const s = remote - local;
    if (this.offset === null || s > this.offset) this.offset = s;
    else this.offset += (s - this.offset) * 0.004;
  }
  remoteNow(local = performance.now()) { return local + (this.offset ?? 0); }
}

/** Find the two samples around t in a time-sorted list and how far between them t is. */
function bracket(buf, t) {
  if (!buf.length) return null;
  if (t <= buf[0].t) return [buf[0], buf[0], 0];
  for (let i = buf.length - 1; i >= 0; i--) {
    if (buf[i].t <= t) {
      const a = buf[i], b = buf[i + 1];
      if (!b) return [a, a, 0];
      return [a, b, (t - a.t) / Math.max(1e-6, b.t - a.t)];
    }
  }
  return [buf[0], buf[0], 0];
}
const push = (buf, rec, max = 12) => { if (buf.length && rec.t <= buf[buf.length - 1].t) return; buf.push(rec); if (buf.length > max) buf.shift(); };

export class Net {
  constructor(game) {
    this.g = game;
    this.role = 'off';           // off | host | guest
    this.code = null;
    this.peer = null;
    this.me = { id: 0, name: '', color: PLAYER_COLORS[0] };
    this.players = new Map();    // id -> { id, name, color, avatar, buf, link, pusher, ... } (others only)
    this.status = '';
    this.onChange = null;        // (net) => update the menu
    this.depth = 0;              // inside a replicated call (nested calls aren't sent on their own)
    this.out = [];               // events for friends, this frame
    this.seq = 0;
    this.nextRagdoll = 1; this.nextBody = 1;
    this.announced = new Set();
    this.lastSnap = 0; this.lastHp = 0; this.lastState = 0;
    this.hooked = false;
    // friend side
    this.clock = new Clock();
    this.queue = [];             // event batches waiting for their time
    this.ragById = new Map();
    this.bodyById = new Map();
    this.hostTimeScale = 1;
    this.fireOut = [];
    this.reqOut = [];
    this.shotGroups = 0;
    this.stats = { up: 0, down: 0, t: performance.now(), upRate: 0, downRate: 0 };
  }

  get host() { return this.role === 'host'; }
  get guest() { return this.role === 'guest'; }
  get active() { return this.role !== 'off'; }
  get playerCount() { return this.active ? this.players.size + 1 : 1; }
  get ping() { if (!this.guest) return 0; const p = this.players.get(1); return p?.link?.rtt || 0; }

  setStatus(s) { this.status = s; this.onChange?.(this); }

  // ================================================================== hosting
  async hostRoom(name, code = null) {
    if (this.active) return;
    this.setStatus('Opening a room…');
    try {
      const { peer, code: c } = await openRoom((link) => this.onGuestLink(link), code ? cleanCode(code) : null);
      this.peer = peer; this.code = c;
      this.role = 'host';
      this.me = { id: 1, name: name || 'Host', color: PLAYER_COLORS[0] };
      this.nextPlayer = 2;
      this.installHostHooks();
      // everything already in the world gets its network id
      for (const r of this.g.ragdolls.list) this.adopt(r);
      for (const gib of this.g.gore.gibs) if (gib.netId === undefined) gib.netId = this.nextBody++;
      for (const n of this.g.explosives.live) if (n.netId === undefined) n.netId = this.nextBody++;
      this.setStatus('');
      this.g.hud.toast(`Room ${c} is open: friends join with this code`);
    } catch (e) {
      this.setStatus(errorText(e));
      try { this.peer?.destroy(); } catch { /* */ }
      this.peer = null;
    }
  }

  onGuestLink(link) {
    if (!this.host) { link.close(); return; }
    link.onMessage = (m) => this.fromGuest(link, m);
    link.onFast = (buf) => { const p = this.players.get(link.pid); if (p) this.fromGuestFast(p, buf); };
    link.onClose = () => this.dropGuest(link);
  }

  fromGuest(link, m) {
    if (m.t === 'hello') {
      if (m.v !== NET_VERSION || m.game !== this.g.version) { link.send({ t: 'reject', why: 'Your game version is different from the host\'s. Both of you: reload the page to get the newest version.' }); setTimeout(() => link.close(), 500); return; }
      if (this.players.size + 1 >= MAX_PLAYERS) { link.send({ t: 'reject', why: `The room is full (${MAX_PLAYERS} players).` }); setTimeout(() => link.close(), 500); return; }
      const id = this.nextPlayer++;
      const used = new Set([this.me.color, ...[...this.players.values()].map((p) => p.color)]);
      const color = PLAYER_COLORS.find((c) => !used.has(c)) || PLAYER_COLORS[id % PLAYER_COLORS.length];
      const name = String(m.name || 'Player').slice(0, 16);
      const p = { id, name, color, link, buf: [], clock: new Clock(), hp: new Map(), ready: false, groups: new Map() };
      link.pid = id;
      this.players.set(id, p);
      this.addAvatar(p);
      this.addPusher(p);
      link.send({ t: 'welcome', id, color, code: this.code, ...this.worldRecord() });
      p.ready = true;
      this.sendPlayers();
      this.emit({ t: 'toast', s: `${name} joined` });
      this.g.hud.toast(`${name} joined`);
      this.g.audio.play('button');
      this.onChange?.(this);
      return;
    }
    const p = this.players.get(link.pid);
    if (!p) return;
    if (m.t === 'req') for (const r of m.r) this.request(p, r);
  }

  dropGuest(link) {
    const p = this.players.get(link.pid);
    if (!p) return;
    this.players.delete(p.id);
    p.avatar?.dispose();
    if (p.pusher) this.g.physics.world.removeBody(p.pusher);
    if (this.host) {
      this.sendPlayers();
      this.emit({ t: 'toast', s: `${p.name} left` });
      this.g.hud.toast(`${p.name} left`);
    }
    this.onChange?.(this);
  }

  sendPlayers() {
    const list = [this.me, ...[...this.players.values()]].map((p) => ({ id: p.id, name: p.name, color: p.color }));
    for (const p of this.players.values()) if (p.ready) p.link.send({ t: 'players', list });
  }

  /** What a friend asked the host to do. */
  request(p, r) {
    const g = this.g;
    switch (r.t) {
      case 'fire': {
        const tool = g.tools[r.w]?.name;
        let first = true;
        for (const s of r.s) {
          let shot = null;
          if (s.g) {
            shot = p.groups.get(s.g);
            if (!shot) { shot = { hits: new Map() }; p.groups.set(s.g, shot); if (p.groups.size > 20) p.groups.delete(p.groups.keys().next().value); }
          }
          const o = new THREE.Vector3(...s.o), d = new THREE.Vector3(...s.d).normalize();
          const m = p.avatar?.muzzleWorld() || (s.m ? new THREE.Vector3(...s.m) : null);
          g.ballistics.fire(o, d, m, { ...s.x, shot, owner: p.id, tool: first ? r.w : -1 });
          first = false;
        }
        if (tool && GUN_SOUND[tool]) this.playAt(GUN_SOUND[tool], p.avatar?.root.position);
        p.avatar?.fired();
        break;
      }
      case 'press': { const b = g.buttons[r.i]; if (b) b.press(); break; }
      case 'spawn': {
        for (const s of r.list.slice(0, 10)) {
          const rr = g.ragdolls.spawn(s.p, s.y, { armor: s.o?.armor || null, behavior: s.o?.behavior === 'v2' ? 'v2' : 'classic', zombie: !!s.o?.zombie });
          if (s.fm && rr.brain) rr.brain.fearMul = s.fm;
        }
        g.audio.play('button');
        break;
      }
      case 'removeAll': g.removeAll(); break;
      case 'cleanUp': g.cleanUp(); break;
    }
  }

  /** The whole world as it is now, for a friend who just joined. */
  worldRecord() {
    const g = this.g;
    const rags = g.ragdolls.list.filter((r) => !r.hidden && !r.removed).map((r) => { this.adopt(r); this.announced.add(r); return this.ragdollRecord(r, true); });
    const bodies = [];
    for (const gib of g.gore.gibs) { if (gib.netId === undefined) gib.netId = this.nextBody++; bodies.push(this.gibRecord(gib)); }
    for (const n of g.explosives.live) { if (n.netId === undefined) n.netId = this.nextBody++; bodies.push(this.nadeRecord(n)); }
    const glass = g.getMap().glass ? g.getMap().glass.panes.filter((p) => p.broken).map((p) => p.i) : [];
    return { map: g.getMap().def?.id, rags, bodies, glass, ts: g.timeScale() };
  }

  // ================================================================== joining
  async joinRoom(code, name) {
    if (this.active) return;
    code = cleanCode(code);
    if (code.length < 4) { this.setStatus('Type the room code your friend sees in their Multiplayer menu.'); return; }
    this.setStatus('Connecting…');
    try {
      const { peer, link } = await joinRoom(code);
      this.peer = peer;
      this.hostLink = link;
      link.onMessage = (m) => this.fromHost(m);
      link.onFast = (buf) => this.fromHostFast(buf);
      link.onClose = () => { if (this.guest || this.joining) this.leave(this.guest ? 'Lost the connection to the host.' : null); };
      this.joining = true;
      this.me.name = name || 'Player';
      link.send({ t: 'hello', v: NET_VERSION, game: this.g.version, name: this.me.name });
      this.setStatus('Connected, loading the world…');
      setTimeout(() => { if (this.joining) this.leave('The host didn\'t answer.'); }, 12000);
    } catch (e) {
      this.setStatus(errorText(e));
      try { this.peer?.destroy(); } catch { /* */ }
      this.peer = null;
    }
  }

  fromHost(m) {
    if (m.t === 'ev') { this.clock.sample(m.ht); this.queue.push(m); return; }
    if (m.t === 'welcome') { this.joining = false; this.enterGuest(m); return; }
    if (m.t === 'reject') { this.joining = false; this.leave(m.why); return; }
    if (m.t === 'players') { this.setPlayers(m.list); return; }
    if (m.t === 'hit') { this.g.hud.hitMarker(!!m.o); return; }
    if (m.t === 'bye') { this.leave('The host closed the room.'); }
  }

  enterGuest(m) {
    const g = this.g;
    this.role = 'guest';
    this.code = m.code;
    this.me.id = m.id; this.me.color = m.color;
    this.hostTimeScale = m.ts || 1;
    g.physics.setWorker(false);
    g.grab.release();
    g.ballistics.ghostAll = true;
    g.ballistics.clear();
    this.installGuestHooks();
    g.spawnMenu.remoteSpawn = (list) => this.requestSpawn(list);
    if (m.map && m.map !== g.getMap().def?.id) g.loadMap(m.map);
    g.ragdolls.clear(g.ragdolls.keep);
    g.cleanUp(true);
    this.ragById.clear(); this.bodyById.clear();
    for (const rec of m.rags) this.spawnCopy(rec);
    for (const b of m.bodies) this.addBody(b);
    const glass = g.getMap().glass;
    if (glass) { const a = glass.audio; glass.audio = null; for (const i of m.glass) { const p = glass.panes[i]; if (p) glass.breakPane(p, null, 0.5); } glass.audio = a; }
    // only the guns for now
    if (!GUEST_TOOLS.has(g.toolbox.active.name)) { const i = g.tools.findIndex((t) => t.name === 'M1911'); if (i >= 0) { g.toolbox.equip(i); g.toolbox.select(i, true); } }
    g.onJoined?.();
    this.setStatus('');
    g.hud.toast(`Joined room ${this.code}`);
    this.onChange?.(this);
  }

  setPlayers(list) {
    const seen = new Set();
    for (const it of list) {
      if (it.id === this.me.id) continue;
      seen.add(it.id);
      let p = this.players.get(it.id);
      if (!p) { p = { id: it.id, name: it.name, color: it.color, buf: [], link: it.id === 1 ? this.hostLink : null }; this.players.set(it.id, p); this.addAvatar(p); }
      p.name = it.name; p.color = it.color;
      p.avatar.set({ name: it.name, color: it.color });
    }
    for (const [id, p] of this.players) if (!seen.has(id)) { p.avatar?.dispose(); this.players.delete(id); }
    // the host's entry keeps the link (for the ping)
    const h = this.players.get(1); if (h) h.link = this.hostLink;
    this.onChange?.(this);
  }

  // ================================================================== leaving
  leave(reason = null) {
    const g = this.g;
    const was = this.role;
    if (was === 'host') {
      for (const p of this.players.values()) { p.link?.send({ t: 'bye' }); }
      setTimeout(() => { for (const p of this.players.values()) p.link?.close(); }, 200);
    }
    const peer = this.peer;
    this.hostLink?.close();
    setTimeout(() => { try { peer?.destroy(); } catch { /* */ } }, 300);
    for (const p of this.players.values()) { p.avatar?.dispose(); if (p.pusher) g.physics.world.removeBody(p.pusher); }
    this.players.clear();
    this.peer = null; this.hostLink = null; this.code = null; this.joining = false;
    this.role = 'off';
    this.queue.length = 0; this.out.length = 0;
    this.announced.clear();
    if (was === 'guest') {
      // back to playing alone: a fresh world of our own
      g.spawnMenu.remoteSpawn = null;
      g.ballistics.ghostAll = false;
      g.ballistics.clear();
      g.ragdolls.clear(g.ragdolls.keep);
      g.cleanUp(true);
      g.ragdolls.respawn();
      g.physics.setWorker(g.settings.get('physicsWorker') !== false);
      this.ragById.clear(); this.bodyById.clear();
      this.hostTimeScale = 1;
      g.onLeft?.();
    }
    this.setStatus(reason || '');
    if (reason) g.hud.toast(reason);
    this.onChange?.(this);
  }

  // ================================================================== host: what the game does
  emit(e) { if (this.host && this.players.size) this.out.push(e); }

  /** Host: tell friends about a ragdoll (once), before anything that happens to it. */
  announce(r) {
    if (this.announced.has(r) || r.hidden || r.removed) return;
    this.adopt(r);
    this.announced.add(r);
    this.emit(this.ragdollRecord(r));
  }

  adopt(r) {
    if (r.netId === undefined) r.netId = this.nextRagdoll++;
    if (r._netHooked) return;
    r._netHooked = true;
    const self = this;
    for (const name of RAGDOLL_CALLS) {
      const orig = r[name];
      r[name] = function (...args) {
        if (!self.host || self.depth > 0) return orig.apply(this, args);
        self.depth++;
        let res;
        try { res = orig.apply(this, args); } finally { self.depth--; }
        if (!r.hidden && !r.removed && self.players.size) { self.announce(r); self.emit({ t: 'rop', id: r.netId, f: name, a: encode(args) }); }
        return res;
      };
    }
    const dispose = r.dispose;
    r.dispose = function (...args) {
      if (self.host && self.announced.has(r)) { self.emit({ t: 'r-', id: r.netId }); self.announced.delete(r); }
      return dispose.apply(this, args);
    };
  }

  ragdollRecord(r, full = false) {
    const pose = [];
    for (const def of PARTS) {
      const b = r.parts[def.name].body;
      pose.push(+b.position.x.toFixed(4), +b.position.y.toFixed(4), +b.position.z.toFixed(4), +b.quaternion.x.toFixed(5), +b.quaternion.y.toFixed(5), +b.quaternion.z.toFixed(5), +b.quaternion.w.toFixed(5));
    }
    const armor = {};
    for (const [k, a] of Object.entries(r.armor || {})) armor[k] = { hp: a.hp, broken: !!a.broken, dropped: !!a.dropped };
    const rec = { t: 'r+', id: r.netId, n: r.name, z: !!r.zombie, b: r.behavior === 'v2' ? 'v2' : 'classic', a: armor, pose };
    if (full) {
      rec.hs = healthSections(r.health);
      rec.hs.x = this.brainRecord(r);
      rec.rem = Object.keys(r.parts).filter((n) => r.parts[n].removed);
    }
    return rec;
  }

  brainRecord(r) { return { s: r.brain?.state, a: r.brain?.activity, n: r.name }; }

  gibRecord(gib) {
    const b = gib.body;
    if (gib.helmetOf) return { t: 'b+', id: gib.netId, k: 'helmet', rid: gib.helmetOf, p: [b.position.x, b.position.y, b.position.z], v: [0, 0, 0] };
    return { t: 'b+', id: gib.netId, k: 'gib', p: [b.position.x, b.position.y, b.position.z], v: [0, 0, 0], m: gib.matName || 'meat', r: gib.r || 0.02, l: gib.lump || 0 };
  }

  nadeRecord(n) {
    const b = n.body;
    return { t: 'b+', id: n.netId, k: 'nade', p: [b.position.x, b.position.y, b.position.z], v: [b.velocity.x, b.velocity.y, b.velocity.z] };
  }

  /** Wrap the host's game so what friends need to see is sent. Inert unless hosting. */
  installHostHooks() {
    if (this.hooked) return;
    this.hooked = true;
    const self = this, g = this.g;
    // gore: replayed calls (nested ones ride along with the outer call)
    for (const name of GORE_CALLS) {
      const orig = g.gore[name];
      g.gore[name] = function (...args) {
        if (!self.host || self.depth > 0) return orig.apply(this, args);
        self.depth++;
        let res;
        try { res = orig.apply(this, args); } finally { self.depth--; }
        if (!self.players.size) return res;
        if (args.some((a) => isRagdoll(a) && (a.hidden || a.removed))) return res;   // the title screen's body
        for (const a of args) if (isRagdoll(a)) self.announce(a);
        self.emit({ t: 'g', f: name, a: encode(args) });
        return res;
      };
    }
    // gibs and loose helmets are bodies of their own
    const spawnGib = g.gore.spawnGib;
    g.gore.spawnGib = function (pos, vel, material, radius, opts) {
      const res = spawnGib.call(this, pos, vel, material, radius, opts);
      const gib = this.gibs[this.gibs.length - 1];
      if (self.host && gib && gib.netId === undefined) {
        gib.netId = self.nextBody++;
        const b = gib.body;
        self.emit({ t: 'b+', id: gib.netId, k: 'gib', p: [b.position.x, b.position.y, b.position.z], v: [b.velocity.x, b.velocity.y, b.velocity.z], m: gib.matName, r: gib.r, l: gib.lump });
      }
      return res;
    };
    const dropHelmet = g.gore.dropHelmet;
    g.gore.dropHelmet = function (ragdoll, at, vel) {
      const n = this.gibs.length, last = this.gibs[n - 1];
      const res = dropHelmet.call(this, ragdoll, at, vel);
      const gib = this.gibs[this.gibs.length - 1];
      if (self.host && gib && gib !== last && gib.netId === undefined) {
        gib.netId = self.nextBody++;
        gib.helmetOf = ragdoll.netId;
        const b = gib.body;
        self.emit({ t: 'b+', id: gib.netId, k: 'helmet', rid: ragdoll.netId, p: [b.position.x, b.position.y, b.position.z], v: [b.velocity.x, b.velocity.y, b.velocity.z] });
      }
      return res;
    };
    const removeGib = g.gore.removeGib;
    g.gore.removeGib = function (gib) {
      if (self.host && gib.netId !== undefined) self.emit({ t: 'b-', id: gib.netId });
      return removeGib.call(this, gib);
    };
    // ragdolls
    const spawn = g.ragdolls.spawn;
    g.ragdolls.spawn = function (...args) {
      const r = spawn.apply(this, args);
      if (self.host) self.adopt(r);
      return r;
    };
    const processImpacts = g.ragdolls.processImpacts;
    g.ragdolls.processImpacts = function (r) {
      if (self.host && r.impacts.length && !r.hidden) {
        let loudest = 0, at = null;
        for (const imp of r.impacts) if (imp.speed > loudest) { loudest = imp.speed; at = imp.point; }
        if (loudest > 5 && at) self.emit({ t: 'snd', n: loudest > 9 ? 'splat' : 'thud', p: [at.x, at.y, at.z] });
      }
      return processImpacts.call(this, r);
    };
    // grenades
    const ex = g.explosives;
    const throwGrenade = ex.throwGrenade;
    ex.throwGrenade = function (...args) {
      const n = throwGrenade.apply(this, args);
      if (self.host && n) { n.netId = self.nextBody++; self.emit(self.nadeRecord(n)); }
      return n;
    };
    const detonate = ex.detonate;
    ex.detonate = function (n) {
      if (self.host && !n.dead && n.netId !== undefined) { const p = n.body.position; self.emit({ t: 'boom', id: n.netId, p: [p.x, p.y, p.z] }); }
      return detonate.call(this, n);
    };
    const exClear = ex.clear;
    ex.clear = function () {
      if (self.host) for (const n of this.live) if (n.netId !== undefined) self.emit({ t: 'b-', id: n.netId });
      return exClear.call(this);
    };
    const spawnSpoon = ex.spawnSpoon;
    ex.spawnSpoon = function (pos, vel) {
      if (self.host) self.emit({ t: 'spoon', p: [pos.x, pos.y, pos.z], v: [vel.x, vel.y, vel.z] });
      return spawnSpoon.call(this, pos, vel);
    };
    // every bullet's tracer (the friend's own shots come back to everyone else)
    const fire = g.ballistics.fire;
    g.ballistics.fire = function (origin, dir, visualFrom, opts = {}) {
      const res = fire.call(this, origin, dir, visualFrom, opts);
      // shrapnel isn't sent: friends' games show their own (see Explosives.explodeVisual)
      if (self.host && self.players.size && !opts.fragment) {
        const owner = opts.owner || self.me.id;
        let w = -1;
        if (!opts.fragment) {
          if (opts.owner) w = opts.tool ?? -1;
          else if (!opts.shot || !opts.shot.netSent) { w = g.toolbox.index; if (opts.shot) opts.shot.netSent = true; }
        }
        const m = visualFrom ? [visualFrom.x, visualFrom.y, visualFrom.z] : null;
        self.emit({ t: 'shot', p: owner, w, o: [origin.x, origin.y, origin.z], d: [dir.x, dir.y, dir.z], m,
          x: { size: opts.size, glowSize: opts.glowSize, speed: opts.speed, life: opts.life, range: opts.range, fragment: !!opts.fragment, pellet: !!opts.pellet } });
      }
      return res;
    };
    // hit markers for a friend's shots go back to them
    g.ballistics.onRemoteMarker = (owner, organ) => { const p = this.players.get(owner); p?.link?.send({ t: 'hit', o: organ ? 1 : 0 }); };
    this.hookMap();
  }

  /** The map's breakable windows (again after each map change). */
  hookMap() {
    const glass = this.g.getMap().glass;
    if (!glass || glass._netHooked) return;
    glass._netHooked = true;
    const self = this;
    const breakPane = glass.breakPane;
    glass.breakPane = function (pane, dir = null, power = 4) {
      if (self.host && !pane.broken) self.emit({ t: 'glass', i: pane.i, d: dir ? [dir.x, dir.y, dir.z] : null, w: power });
      return breakPane.call(this, pane, dir, power);
    };
    const repair = glass.repair;
    glass.repair = function () {
      if (self.host) self.emit({ t: 'glassFix' });
      return repair.call(this);
    };
  }

  /** Host: the map changed (friends load it too). */
  mapLoaded(id) {
    this.hookMap();
    if (this.host) this.emit({ t: 'map', id });
  }
  cleanedUp() { if (this.host) this.emit({ t: 'clean' }); }

  // ================================================================== friend side: hooks
  installGuestHooks() {
    if (this.guestHooked) return;
    this.guestHooked = true;
    const self = this, g = this.g;
    // bodies come from the host: the friend's own copy never makes gibs or helmets by itself
    for (const name of ['spawnGib', 'dropHelmet']) {
      const orig = g.gore[name];
      g.gore[name] = function (...args) {
        if (self.guest && !self.allowBodies) return undefined;
        return orig.apply(this, args);
      };
    }
    // shots: a tracer straight away, the shot itself goes to the host
    const fire = g.ballistics.fire;
    g.ballistics.fire = function (origin, dir, visualFrom, opts = {}) {
      if (self.guest && !opts.replay) {
        let gid = 0;
        if (opts.shot) gid = opts.shot.netGroup ??= ++self.shotGroups;
        self.fireOut.push({ o: [origin.x, origin.y, origin.z], d: [dir.x, dir.y, dir.z], m: visualFrom ? [visualFrom.x, visualFrom.y, visualFrom.z] : null, g: gid,
          x: { energy: opts.energy, impulse: opts.impulse, size: opts.size, speed: opts.speed, pellet: !!opts.pellet, range: opts.range, life: opts.life, glowSize: opts.glowSize } });
      }
      return fire.call(this, origin, dir, visualFrom, { ...opts, ghost: self.guest || opts.ghost, mine: self.guest && !opts.replay });
    };
  }

  /** Friend: a spawn from the spawn menu goes to the host. */
  requestSpawn(list) { this.reqOut.push({ t: 'spawn', list }); }
  requestPress(i) { this.reqOut.push({ t: 'press', i }); }
  requestRemoveAll() { this.reqOut.push({ t: 'removeAll' }); }
  requestCleanUp() { this.reqOut.push({ t: 'cleanUp' }); }
  toolAllowed(tool) { return !this.guest || GUEST_TOOLS.has(tool.name); }

  // ================================================================== every frame
  /** Start of the frame (before the physics): smoothed positions, events whose time has come, players. */
  update(dt) {
    if (!this.active) return;
    const now = performance.now();
    if (this.guest) {
      const T = this.clock.remoteNow(now) - DELAY;
      // events in order, once the smoothed world has reached their time
      while (this.queue.length && this.queue[0].ht <= T) this.applyBatch(this.queue.shift().e);
      if (this.queue.length > 400) while (this.queue.length) this.applyBatch(this.queue.shift().e);   // fell far behind (tab was hidden)
      this.placeRagdolls(T);
      this.placeBodies(T);
      this.updateAvatars(dt, T);
    } else if (this.host) {
      this.updateAvatars(dt, now - DELAY);
      this.updatePushers(now);
    }
    // data rates (for the debug view)
    const st = this.stats;
    if (now - st.t > 1000) {
      let up = 0, down = 0;
      const links = this.host ? [...this.players.values()].map((p) => p.link) : [this.hostLink];
      for (const l of links) if (l) { up += l.sentBytes; down += l.recvBytes; }
      st.upRate = (up - st.up) / ((now - st.t) / 1000); st.downRate = (down - st.down) / ((now - st.t) / 1000);
      st.up = up; st.down = down; st.t = now;
    }
  }

  /** End of the frame: send. */
  flush() {
    if (!this.active) return;
    const now = performance.now();
    if (this.host) {
      // ragdolls that appeared this frame (the title screen's hidden one stays out)
      for (const r of this.g.ragdolls.list) this.announce(r);
      const hpDue = now - this.lastHp >= 1000 / HEALTH_HZ;
      if (hpDue) this.lastHp = now;
      const common = this.out;
      this.out = [];
      const secs = hpDue && this.players.size ? this.healthNow() : null;
      for (const p of this.players.values()) {
        if (!p.ready) continue;
        let e = common;
        if (secs) { const hp = this.healthFor(p, secs); if (hp) e = common.concat([hp]); }
        if (e.length) p.link.send({ t: 'ev', ht: now, e });
      }
      if (now - this.lastSnap >= 1000 / SNAP_HZ - 2) {
        this.lastSnap = now;
        const buf = this.snapshot(now);
        for (const p of this.players.values()) if (p.ready) p.link.sendFast(buf);
      }
    } else if (this.guest && this.hostLink) {
      if (this.fireOut.length) { this.reqOut.push({ t: 'fire', w: this.g.toolbox.index, s: this.fireOut }); this.fireOut = []; }
      if (this.reqOut.length) { this.hostLink.send({ t: 'req', r: this.reqOut }); this.reqOut = []; }
      if (now - this.lastState >= 1000 / STATE_HZ - 2) {
        this.lastState = now;
        const w = new Writer(64);
        w.u8(2); w.u32(++this.seq); w.f64(now);
        this.writePlayer(w, this.myState());
        this.hostLink.sendFast(w.done());
      }
    }
  }

  // ------------------------------------------------------------------ players
  myState() {
    const g = this.g, pl = g.player;
    return { id: this.me.id, x: pl.pos.x, y: pl.pos.y, z: pl.pos.z, yaw: pl.yaw, pitch: pl.pitch, crouch: pl.crouch, tool: g.toolbox.index,
      flags: (pl.onGround ? 1 : 0) | (pl.sprinting ? 2 : 0) | (pl.aiming ? 4 : 0) | (g.vitals.dead ? 8 : 0) };
  }
  writePlayer(w, s) {
    w.u8(s.id); w.f32(s.x); w.f32(s.y); w.f32(s.z); w.f32(s.yaw); w.i16(s.pitch * 10000); w.u8(Math.round(Math.min(1, Math.max(0, s.crouch)) * 255)); w.u8(s.tool & 255); w.u8(s.flags);
  }
  readPlayer(rd) {
    return { id: rd.u8(), x: rd.f32(), y: rd.f32(), z: rd.f32(), yaw: rd.f32(), pitch: rd.i16() / 10000, crouch: rd.u8() / 255, tool: rd.u8(), flags: rd.u8() };
  }

  addAvatar(p) {
    p.avatar = new Avatar(this.g.scene, { name: p.name, color: p.color });
    p.avatar.root.visible = false;
  }

  addPusher(p) {
    // like the local player's: friends shove ragdolls when they walk into them
    const P = CONFIG.player;
    const body = new CANNON.Body({ mass: 0, type: CANNON.Body.KINEMATIC, collisionFilterGroup: GROUP.PLAYER, collisionFilterMask: GROUP.RAGDOLL | GROUP.DEBRIS });
    body.addShape(new CANNON.Sphere(P.radius), new CANNON.Vec3(0, 0.4, 0));
    body.addShape(new CANNON.Sphere(P.radius), new CANNON.Vec3(0, 1.0, 0));
    body.addShape(new CANNON.Sphere(P.radius * 0.8), new CANNON.Vec3(0, 1.45, 0));
    body.position.set(0, -50, 0);
    this.g.physics.world.addBody(body);
    p.pusher = body;
  }

  updatePushers(now) {
    for (const p of this.players.values()) {
      const b = p.pusher, s = p.buf[p.buf.length - 1];
      if (!b || !s) continue;
      const prev = p.buf[p.buf.length - 2];
      const dead = s.flags & 8;
      b.position.set(s.x, dead ? -50 : s.y - s.crouch * 0.25, s.z);
      if (prev && s.t > prev.t) {
        const k = 1000 / (s.t - prev.t);
        b.velocity.set((s.x - prev.x) * k, (s.y - prev.y) * k, (s.z - prev.z) * k);
        if (b.velocity.length() > 15 || now - s.t > 300) b.velocity.set(0, 0, 0);
      }
    }
  }

  updateAvatars(dt, T) {
    const g = this.g, seen = g.getMap().seen;
    for (const p of this.players.values()) {
      const av = p.avatar;
      if (!av) continue;
      const br = bracket(p.buf, T);
      if (!br) { av.root.visible = false; continue; }
      const [a, b, k] = br;
      const s = p._s || (p._s = { pos: new THREE.Vector3() });
      s.pos.set(a.x + (b.x - a.x) * k, a.y + (b.y - a.y) * k, a.z + (b.z - a.z) * k);
      let dy = b.yaw - a.yaw; dy -= Math.round(dy / (Math.PI * 2)) * Math.PI * 2;
      s.yaw = a.yaw + dy * k;
      s.pitch = a.pitch + (b.pitch - a.pitch) * k;
      s.crouch = a.crouch + (b.crouch - a.crouch) * k;
      s.tool = g.tools[b.tool]?.name;
      s.onGround = !!(b.flags & 1); s.sprinting = !!(b.flags & 2); s.aiming = !!(b.flags & 4); s.dead = !!(b.flags & 8);
      av.update(dt, s, g.camera, seen ? seen(s.pos) : true);
    }
  }

  // ------------------------------------------------------------------ snapshots
  snapshot(now) {
    const g = this.g;
    const w = new Writer(8192);
    w.u8(1); w.u32(++this.seq); w.f64(now); w.f32(g.timeScale());
    const others = [...this.players.values()].filter((p) => p.buf.length);
    w.u8(1 + others.length);
    this.writePlayer(w, this.myState());
    for (const p of others) this.writePlayer(w, { ...p.buf[p.buf.length - 1], id: p.id });
    // ragdolls: moving ones every time, resting ones about once a second
    const rags = [];
    for (const r of g.ragdolls.list) {
      if (!this.announced.has(r) || r.hidden || r.removed) continue;
      if (r.asleep && now - (r._netSent || 0) < 1000) continue;
      r._netSent = now;
      rags.push(r);
    }
    w.u16(rags.length);
    for (const r of rags) {
      let mask = 0;
      for (let i = 0; i < NPARTS; i++) if (!r.parts[PARTS[i].name].removed) mask |= 1 << i;
      const o = r.parts.pelvis.body.position;
      let far = false;
      for (let i = 0; i < NPARTS; i++) {
        if (!(mask & (1 << i))) continue;
        const p = r.parts[PARTS[i].name].body.position;
        if (Math.abs(p.x - o.x) > 32 || Math.abs(p.y - o.y) > 32 || Math.abs(p.z - o.z) > 32) { far = true; break; }
      }
      const unit = far ? 100 : 1000;      // cm or mm
      w.u16(r.netId); w.u16(mask); w.u8(far ? 1 : 0); w.f32(o.x); w.f32(o.y); w.f32(o.z);
      for (let i = 0; i < NPARTS; i++) {
        if (!(mask & (1 << i))) continue;
        const b = r.parts[PARTS[i].name].body;
        w.i16((b.position.x - o.x) * unit); w.i16((b.position.y - o.y) * unit); w.i16((b.position.z - o.z) * unit);
        w.quat(b.quaternion);
      }
    }
    // gibs, loose helmets and grenades
    const bodies = [];
    for (const gib of g.gore.gibs) {
      if (gib.netId === undefined) continue;
      if (gib.body.sleepState === SLEEPING && now - (gib._netSent || 0) < 1000) continue;
      gib._netSent = now;
      bodies.push(gib);
    }
    for (const n of g.explosives.live) if (n.netId !== undefined) bodies.push(n);
    w.u16(bodies.length);
    for (const x of bodies) { const b = x.body; w.u16(x.netId); w.f32(b.position.x); w.f32(b.position.y); w.f32(b.position.z); w.quat(b.quaternion); }
    return w.done();
  }

  fromHostFast(buf) {
    const rd = new Reader(buf);
    if (rd.u8() !== 1) return;
    const seq = rd.u32(), ht = rd.f64();
    if (seq <= (this.lastSeq || 0) && this.lastSeq - seq < 1e6) return;   // late or repeated
    this.lastSeq = seq;
    this.clock.sample(ht);
    this.hostTimeScale = rd.f32();
    const np = rd.u8();
    for (let i = 0; i < np; i++) {
      const s = this.readPlayer(rd);
      s.t = ht;
      if (s.id === this.me.id) continue;
      const p = this.players.get(s.id);
      if (p) push(p.buf, s);
    }
    const nr = rd.u16();
    for (let i = 0; i < nr; i++) {
      const id = rd.u16(), mask = rd.u16(), far = rd.u8(), ox = rd.f32(), oy = rd.f32(), oz = rd.f32();
      const unit = far ? 0.01 : 0.001;
      const data = new Float32Array(NPARTS * 7);
      for (let k = 0; k < NPARTS; k++) {
        if (!(mask & (1 << k))) continue;
        data[k * 7] = ox + rd.i16() * unit; data[k * 7 + 1] = oy + rd.i16() * unit; data[k * 7 + 2] = oz + rd.i16() * unit;
        rd.quat(data, k * 7 + 3);
      }
      const r = this.ragById.get(id);
      if (r) push(r._netBuf, { t: ht, mask, data }, 8);
    }
    const nb = rd.u16();
    for (let i = 0; i < nb; i++) {
      const id = rd.u16();
      const data = new Float32Array(7);
      data[0] = rd.f32(); data[1] = rd.f32(); data[2] = rd.f32();
      rd.quat(data, 3);
      const x = this.bodyById.get(id);
      if (x) push(x._netBuf, { t: ht, data }, 8);
    }
  }

  /** Host: a friend's movement. */
  fromGuestFast(p, buf) {
    const rd = new Reader(buf);
    if (rd.u8() !== 2) return;
    const seq = rd.u32(), t = rd.f64();
    if (seq <= (p.lastSeq || 0)) return;
    p.lastSeq = seq;
    p.clock.sample(t);
    const s = this.readPlayer(rd);
    s.t = t - p.clock.offset;          // in the host's time
    s.id = p.id;
    push(p.buf, s, 16);
  }

  placeRagdolls(T) {
    for (const r of this.ragById.values()) {
      const br = bracket(r._netBuf, T);
      if (!br) continue;
      const [a, b, k] = br;
      for (let i = 0; i < NPARTS; i++) {
        const bit = 1 << i;
        if (!(a.mask & bit)) continue;
        const part = r.parts[PARTS[i].name];
        if (part.removed) continue;
        const body = part.body, j = i * 7;
        const B = b.mask & bit ? b.data : a.data;
        const A = a.data;
        body.position.set(A[j] + (B[j] - A[j]) * k, A[j + 1] + (B[j + 1] - A[j + 1]) * k, A[j + 2] + (B[j + 2] - A[j + 2]) * k);
        _q1.set(A[j + 3], A[j + 4], A[j + 5], A[j + 6]);
        if (k > 0) _q1.slerp(_q2.set(B[j + 3], B[j + 4], B[j + 5], B[j + 6]), k);
        body.quaternion.set(_q1.x, _q1.y, _q1.z, _q1.w);
      }
    }
  }

  placeBodies(T) {
    for (const x of this.bodyById.values()) {
      const br = bracket(x._netBuf, T);
      if (!br) continue;
      const [a, b, k] = br, A = a.data, B = b.data;
      x.body.position.set(A[0] + (B[0] - A[0]) * k, A[1] + (B[1] - A[1]) * k, A[2] + (B[2] - A[2]) * k);
      _q1.set(A[3], A[4], A[5], A[6]);
      if (k > 0) _q1.slerp(_q2.set(B[3], B[4], B[5], B[6]), k);
      x.body.quaternion.set(_q1.x, _q1.y, _q1.z, _q1.w);
    }
  }

  // ------------------------------------------------------------------ health
  /** Every announced ragdoll's health as sections (JSON), once per health tick. */
  healthNow() {
    const out = [];
    for (const r of this.announced) {
      if (r.hidden || r.removed) continue;
      const s = healthSections(r.health);
      s.x = this.brainRecord(r);
      const str = {};
      for (const k of Object.keys(s)) str[k] = JSON.stringify(s[k]);
      out.push({ id: r.netId, s, str });
    }
    return out;
  }

  /** The sections this friend hasn't got yet. */
  healthFor(p, secs) {
    const list = [];
    for (const { id, s, str } of secs) {
      let cache = p.hp.get(id);
      if (!cache) { cache = {}; p.hp.set(id, cache); }
      let d = null;
      for (const k of Object.keys(s)) if (cache[k] !== str[k]) { cache[k] = str[k]; (d ??= {})[k] = s[k]; }
      if (d) list.push([id, d]);
    }
    if (p.hp.size > secs.length + 50) { const live = new Set(secs.map((x) => x.id)); for (const id of p.hp.keys()) if (!live.has(id)) p.hp.delete(id); }
    return list.length ? { t: 'hp', r: list } : null;
  }

  // ================================================================== friend side: events
  applyBatch(events) {
    for (const e of events) {
      try { this.apply(e); } catch (err) { console.warn('[net] event', e.t, e.f || '', err); }
    }
  }

  apply(e) {
    const g = this.g;
    const byId = (id) => this.ragById.get(id);
    switch (e.t) {
      case 'r+': this.spawnCopy(e); break;
      case 'r-': { const r = this.ragById.get(e.id); if (r) { this.ragById.delete(e.id); g.ragdolls.remove(r); } break; }
      case 'rop': { const r = this.ragById.get(e.id); if (r && typeof r[e.f] === 'function') r[e.f](...decode(e.a, byId)); break; }
      case 'g': {
        if (!GORE_CALLS.includes(e.f)) break;
        const args = decode(e.a, byId);
        if (e.a.some((a) => a && a.$r !== undefined && !this.ragById.get(a.$r))) break;   // about a ragdoll we don't have
        g.gore[e.f](...args);
        break;
      }
      case 'hp': {
        for (const [id, s] of e.r) {
          const r = this.ragById.get(id);
          if (!r) continue;
          applyHealth(r.health, s);
          if (s.x) { if (r.brain) { r.brain.state = s.x.s; r.brain.activity = s.x.a; } if (s.x.n) r.name = s.x.n; }
        }
        break;
      }
      case 'b+': this.addBody(e); break;
      case 'b-': this.removeBody(e.id); break;
      case 'boom': {
        this.removeBody(e.id);
        g.explosives.explodeVisual(new THREE.Vector3(...e.p), true);
        break;
      }
      case 'spoon': g.explosives.spawnSpoon(new THREE.Vector3(...e.p), new THREE.Vector3(...e.v)); break;
      case 'shot': {
        if (e.p === this.me.id) break;       // our own: already shown
        const o = new THREE.Vector3(...e.o), d = new THREE.Vector3(...e.d);
        const p = this.players.get(e.p);
        const m = p?.avatar?.muzzleWorld() || (e.m ? new THREE.Vector3(...e.m) : null);
        g.ballistics.fire(o, d, m, { ...e.x, replay: true, ghost: true });
        if (e.w >= 0) {
          const tool = g.tools[e.w]?.name, snd = tool && GUN_SOUND[tool];
          if (snd) this.playAt(snd, p?.avatar?.root.position || o);
          p?.avatar?.fired();
        }
        break;
      }
      case 'glass': {
        const glass = g.getMap().glass, p = glass?.panes[e.i];
        if (p) glass.breakPane(p, e.d ? new THREE.Vector3(...e.d) : null, e.w);
        break;
      }
      case 'glassFix': g.getMap().glass?.repair(); break;
      case 'snd': this.playAt(e.n, new THREE.Vector3(...e.p)); break;
      case 'clean': g.cleanUp(true); for (const [id, x] of this.bodyById) if (!g.gore.gibs.includes(x) && !g.explosives.live.includes(x)) this.bodyById.delete(id); break;
      case 'map': if (e.id !== g.getMap().def?.id) { g.loadMap(e.id); } this.ragById.clear(); this.bodyById.clear(); break;
      case 'toast': g.hud.toast(e.s); break;
    }
  }

  /** A sound from somewhere in the world: quieter the further away it is. */
  playAt(name, pos) {
    const cam = this.g.camera.position;
    const d = pos ? cam.distanceTo(pos) : 0;
    const vol = Math.max(0.08, Math.min(1, 1.15 - d / 40));
    this.g.audio.play(name, vol);
  }

  /** A friend's copy of one of the host's ragdolls. */
  spawnCopy(rec) {
    const g = this.g;
    if (this.ragById.has(rec.id)) { const old = this.ragById.get(rec.id); this.ragById.delete(rec.id); g.ragdolls.remove(old); }
    const P = rec.pose;
    const armor = { helmet: !!rec.a?.helmet, vest: !!rec.a?.vest };
    const r = g.ragdolls.spawn([P[0], 0, P[2]], 0, { armor, behavior: rec.b, zombie: rec.z, name: rec.n });
    r.netId = rec.id;
    r._netBuf = [];
    r.replica = true;
    for (let i = 0; i < NPARTS; i++) {
      const b = r.parts[PARTS[i].name].body, j = i * 7;
      b.position.set(P[j], P[j + 1], P[j + 2]);
      b.quaternion.set(P[j + 3], P[j + 4], P[j + 5], P[j + 6]);
      b.velocity.set(0, 0, 0); b.angularVelocity.set(0, 0, 0);
    }
    for (const [k, a] of Object.entries(rec.a || {})) {
      const mine = r.armor?.[k];
      if (!mine) continue;
      mine.hp = a.hp; mine.broken = a.broken;
      if (a.dropped) { mine.dropped = true; for (const m of mine.all) m.visible = false; }
    }
    // joined late: what has already happened to it
    if (rec.hs) this.restore(r, rec);
    r.sync();
    this.ragById.set(rec.id, r);
    return r;
  }

  /** Rebuild a ragdoll's wounds, missing limbs and stumps from its health (joining a game in progress). */
  restore(r, rec) {
    const g = this.g, gore = g.gore, h = r.health;
    const hp = rec.hs.p || {};
    const severedTop = [];
    for (const def of PARTS) {
      const s = hp[def.name];
      if (!s || s.attached !== false || !def.parent) continue;
      const parentGone = hp[def.parent]?.attached === false;
      if (!parentGone) severedTop.push(def.name);
    }
    this.allowBodies = false;
    for (const name of rec.rem || []) {
      if (/chest|abdomen|pelvis/.test(name)) continue;
      const out = r.explodePart(name);
      const def = PART_BY_NAME[name], part = r.parts[name];
      if (out.wasAttached && def.parent) gore.addStump(r.parts[def.parent].group, part.pivotParent, new THREE.Vector3(...def.joint.axis), def.shape === 'sphere' ? 0.05 : Math.min(def.size[0], def.size[2]) * 0.5);
    }
    for (const name of severedTop) {
      if (r.parts[name].removed) continue;
      r.sever(name);
      const def = PART_BY_NAME[name], child = r.parts[name], parent = r.parts[def.parent];
      const rr = def.shape === 'sphere' ? 0.05 : Math.min(def.size[0], def.size[2]) * 0.5;
      const axis = new THREE.Vector3(...def.joint.axis);
      gore.addStump(parent.group, child.pivotParent, axis, rr);
      gore.addStump(child.group, child.pivotChild, axis.clone().negate(), rr);
    }
    applyHealth(h, rec.hs);
    if (rec.hs.x?.n) r.name = rec.hs.x.n;
    if (r.brain && rec.hs.x) { r.brain.state = rec.hs.x.s; r.brain.activity = rec.hs.x.a; }
    // wound marks
    for (const w of h.wounds) {
      if (!w.pos || !w.normal || w.stump) continue;
      const part = r.parts[w.part];
      if (!part || part.removed) continue;
      const surf = gore.surfacePoint(part, w.pos.clone(), w.normal.clone());
      gore.woundVisuals.set(w, gore.decals.addWound(part.group, surf.point, surf.normal, !!w.exit, w.exit ? 0.038 : 0.032));
    }
    for (const def of PARTS) {
      if (!hp[def.name]?.opened || r.parts[def.name].removed) continue;
      const w = h.wounds.find((x) => x.part === def.name && x.pos) || { pos: new THREE.Vector3(0, 0, def.size[2] / 2 || 0.1), normal: new THREE.Vector3(0, 0, 1) };
      gore.openPart(r, def.name, w);
    }
  }

  /** A gib, loose helmet or grenade the host's game made. */
  addBody(e) {
    const g = this.g;
    if (this.bodyById.has(e.id)) return;
    let x = null;
    const pos = new THREE.Vector3(...e.p), vel = new THREE.Vector3(...(e.v || [0, 0, 0]));
    this.allowBodies = true;
    try {
      if (e.k === 'gib') {
        const before = g.gore.gibs.length;
        g.gore.spawnGib(pos, vel, GORE_MAT[e.m] || GORE_MAT.meat, e.r || 0.02, { lump: e.l || 0 });
        if (g.gore.gibs.length > before || g.gore.gibs.length) x = g.gore.gibs[g.gore.gibs.length - 1];
      } else if (e.k === 'helmet') {
        const r = this.ragById.get(e.rid);
        if (r?.armor?.helmet) r.armor.helmet.dropped = false;
        if (r) { const last = g.gore.gibs[g.gore.gibs.length - 1]; g.gore.dropHelmet(r, pos, vel); const n = g.gore.gibs[g.gore.gibs.length - 1]; if (n !== last) x = n; }
      } else if (e.k === 'nade') {
        x = g.explosives.throwGrenade(pos, vel, new THREE.Vector3());
        if (x) x.remote = true;
      }
    } finally { this.allowBodies = false; }
    if (!x) return;
    x.netId = e.id;
    x._netBuf = [];
    x.body.position.copy(pos);
    x.body.velocity.set(0, 0, 0); x.body.angularVelocity.set(0, 0, 0);
    this.bodyById.set(e.id, x);
  }

  removeBody(id) {
    const g = this.g, x = this.bodyById.get(id);
    if (!x) return;
    this.bodyById.delete(id);
    if (g.gore.gibs.includes(x)) g.gore.removeGib(x);
    else if (g.explosives.live.includes(x)) g.explosives.removeGrenade(x);
  }
}

export { woundAt, woundData };
