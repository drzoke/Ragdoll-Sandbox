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
import { encode, decode, registerMaterials, healthSections, applyHealth, healthFlat, applyHealthFlat, woundAt, woundData, Writer, Reader } from './codec.js';
import { Avatar, PLAYER_COLORS } from './avatar.js';
import { PARTS, PART_BY_NAME } from '../ragdoll/skeleton.js';
import { GROUP } from '../core/physics.js';
import { MAT as GORE_MAT } from '../gore/gore.js';
import { CONFIG } from '../config.js';
import { WORLD } from '../world/world.js';
import { G as GRAB, connectedSet } from '../weapon/grab.js';

const NET_VERSION = 1;
const SNAP_HZ = 20;          // host -> friends: positions
const STATE_HZ = 30;         // friend -> host: own movement
const HEALTH_HZ = 5;         // host -> friends: health
const DELAY = 110;           // ms friends see the world behind the host (smooths between updates)
const MAX_PLAYERS = 6;
const GUN_SOUND = { 'M1911': 'shot', 'Remington 870': 'shotgun', 'M24 Sniper': 'sniper', 'Flintlock Musket': 'musket', 'Assault Rifle': 'rifle', 'Submachine Gun': 'smg', 'Combat Shotgun': 'autoshotgun' };
// what the host's game does that friends see, replayed on their copy (see Gore)
const GORE_CALLS = ['spray', 'dust', 'bulletImpactWorld', 'bloodyImpactWorld', 'pelletSpatter', 'addBruise', 'bulletWound', 'bladeWound',
  'armorHit', 'sparks', 'bandage', 'tourniquet', 'splint', 'paddleMarks', 'onSever', 'openPart', 'explodePart', 'impactBlood'];
const RAGDOLL_CALLS = ['sever', 'makeZombie', 'addArmor', 'removeArmor'];
const NPARTS = PARTS.length;
const SLEEPING = CANNON.Body.SLEEPING;

registerMaterials(GORE_MAT);

const _v = new THREE.Vector3(), _q1 = new THREE.Quaternion(), _q2 = new THREE.Quaternion();
const isRagdoll = (o) => o && typeof o === 'object' && o.parts && o.health && o.root;

/** Only what Gore reads of a hit result (Health returns a lot more). */
const slimHit = (res) => res && {
  partName: res.partName, wound: res.wound, exitWound: res.exitWound || null, exit: !!res.exit, kind: res.kind, throat: !!res.throat,
  organs: (res.organs || []).map((o) => ({ id: o.id, hp: o.hp })), bones: (res.bones || []).map(() => 1),
};

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

/**
 * Host: a friend's grab beam. The friend's game shows the beam; this one holds the body for real
 * (the same anchor and pull as GrabTool, at the point the friend aims at).
 */
class RemoteGrab {
  constructor(net, p) {
    this.net = net; this.p = p;
    this.physics = net.g.physics;
    this.anchor = new CANNON.Body({ mass: 0, type: CANNON.Body.KINEMATIC, collisionFilterGroup: 0, collisionFilterMask: 0 });
    this.anchor.collisionResponse = false;
    this.physics.world.addBody(this.anchor);
    this.target = new THREE.Vector3();
    this.held = null;
    this.unsub = this.physics.addProgram(this);
  }

  act(name, a) {
    if (name === 'grab') this.grab(a);
    else if (name === 'drop') this.release();
    else if (name === 'aim' && a.target) { this.target.copy(a.target); this.target.y = Math.max(0.3, this.target.y); }
    else if (name === 'throw') this.throw(a.dir);
    else if (name === 'punt') this.punt(a);
  }

  bodyOf(a) {
    if (a.ragdoll) { const part = a.ragdoll.parts[a.part]; return part && !part.removed ? part.body : null; }
    return a.gib?.body || null;
  }

  grab(a) {
    this.release();
    const b = this.bodyOf(a);
    if (!b) { this.p.link.send({ t: 'grabEnd' }); return; }
    _q1.set(b.quaternion.x, b.quaternion.y, b.quaternion.z, b.quaternion.w).invert();
    const local = _v.set(a.point.x - b.position.x, a.point.y - b.position.y, a.point.z - b.position.z).applyQuaternion(_q1);
    this.anchor.position.set(a.point.x, a.point.y, a.point.z);
    this.anchor.velocity.set(0, 0, 0);
    this.target.copy(a.point);
    const joint = new CANNON.PointToPointConstraint(this.anchor, new CANNON.Vec3(0, 0, 0), b, new CANNON.Vec3(local.x, local.y, local.z), GRAB.maxForce);
    joint.collideConnected = true; joint.skipCollide = true;
    this.physics.world.addConstraint(joint);
    this.held = { ragdoll: a.ragdoll || null, part: a.part, gib: a.gib || null, body: b, local: local.clone(), joint, set: a.ragdoll ? connectedSet(a.ragdoll, a.part) : [b] };
    if (a.ragdoll) { a.ragdoll.wake?.(); if (a.ragdoll.health.parts[a.part].attached) a.ragdoll.grabbed = true; }
    for (const body of this.held.set) body.wakeUp?.();
  }

  release() {
    const h = this.held;
    if (!h) return;
    this.physics.world.removeConstraint(h.joint);
    if (h.ragdoll) h.ragdoll.grabbed = false;
    this.held = null;
  }

  throw(dir) {
    const h = this.held;
    if (!h || !dir) return;
    this.release();
    for (const b of h.set) {
      b.velocity.x = b.velocity.x * 0.4 + dir.x * GRAB.throwSpeed;
      b.velocity.y = b.velocity.y * 0.4 + dir.y * GRAB.throwSpeed + 1.5;
      b.velocity.z = b.velocity.z * 0.4 + dir.z * GRAB.throwSpeed;
    }
    h.body.angularVelocity.x += (Math.random() - 0.5) * 8;
    h.body.angularVelocity.z += (Math.random() - 0.5) * 8;
  }

  punt(a) {
    const b = this.bodyOf(a);
    if (!b || !a.dir) return;
    const bodies = a.ragdoll ? connectedSet(a.ragdoll, a.part) : [b];
    const falloff = 1 - 0.5 * ((a.distance || 0) / GRAB.puntRange);
    for (const x of bodies) {
      const k = (x === b ? 1.6 : 1) * GRAB.puntSpeed * falloff;
      x.velocity.x += a.dir.x * k; x.velocity.y += a.dir.y * k + 1.2; x.velocity.z += a.dir.z * k;
      x.wakeUp?.();
    }
    if (a.ragdoll) {
      a.ragdoll.wake?.();
      a.ragdoll.brain.onHit(a.part, a.dir);
      if (a.ragdoll.brain.state === 'stand') a.ragdoll.brain.fall();
    }
  }

  /** Every frame: let go when what's held is gone or got stuck far from the beam. */
  update() {
    const h = this.held;
    if (!h) return;
    const gone = h.ragdoll ? h.ragdoll.removed || h.ragdoll.parts[h.part].removed : !this.net.g.gore.gibs.includes(h.gib);
    let far = false;
    if (!gone) {
      _q1.set(h.body.quaternion.x, h.body.quaternion.y, h.body.quaternion.z, h.body.quaternion.w);
      _v.copy(h.local).applyQuaternion(_q1).add(h.body.position);
      far = _v.distanceTo(this.anchor.position) > 4.5;
    }
    if (gone || far) { this.release(); this.p.link.send({ t: 'grabEnd' }); }
  }

  physicsProgram() {
    const h = this.held;
    if (!h) return null;
    return { kind: 'grab', anchor: this.anchor, target: this.target, set: h.set, held: h.body, holdComp: GRAB.holdComp };
  }

  dispose() {
    this.release();
    this.unsub?.();
    this.physics.world.removeBody(this.anchor);
  }
}

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
      this.notice(`${name} joined`);
      this.g.audio.play('button');
      this.onChange?.(this);
      return;
    }
    const p = this.players.get(link.pid);
    if (!p) return;
    if (m.t === 'req') for (const r of m.r) this.request(p, r);
    else if (m.t === 'chat') this.chatFrom(p, m.s);
  }

  /** Host: something everyone should see (a toast and a line in the chat). */
  notice(text) {
    this.emit({ t: 'toast', s: text });
    this.g.hud.toast(text);
    this.g.onSystem?.(text);
  }

  // ------------------------------------------------------------------ chat
  /** Send a chat message (from the chat line). */
  sendChat(text) {
    if (this.host) this.chatFrom(this.me, text);
    else if (this.guest) this.hostLink?.send({ t: 'chat', s: text });
  }

  /** Host: a message from a player (the host too) goes to everyone. A few per second at most. */
  chatFrom(p, text) {
    text = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 140);
    if (!text) return;
    const now = performance.now();
    p.chatT = (p.chatT || []).filter((t) => now - t < 5000);
    if (p.chatT.length >= 6) return;
    p.chatT.push(now);
    const msg = { t: 'chat', id: p.id, n: p.name, c: p.color, s: text };
    for (const q of this.players.values()) if (q.ready) q.link.send(msg);
    this.g.onChat?.(msg);
  }

  dropGuest(link) {
    const p = this.players.get(link.pid);
    if (!p) return;
    this.players.delete(p.id);
    p.avatar?.dispose();
    if (p.pusher) this.g.physics.world.removeBody(p.pusher);
    p.grab?.dispose();
    if (p.info) p.info.gone = true;
    for (const v of this.g.vehicles?.list || []) if (v.driver === p.id) { v.driver = 0; v.netFollow = false; if (this.host) this.emit({ t: 'vdrv', id: v.id, d: 0 }); }
    if (this.host) {
      this.sendPlayers();
      this.notice(`${p.name} left`);
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
      case 'throw': {
        const v = (x) => new THREE.Vector3(...x);
        if (g.canThrow && !g.canThrow(p)) break;
        g.explosives.throwGrenade(v(r.p), v(r.v), v(r.s), p.id);
        g.explosives.spawnSpoon(v(r.sp), v(r.sv));
        break;
      }
      case 'act': {
        const tool = g.tools[r.w];
        const a = tool && this.actArgs(r.a);
        if (!a) break;
        if (tool === g.grab) { (p.grab ||= new RemoteGrab(this, p)).act(r.n, a); break; }
        WORLD.actor = p.id;
        const res = tool.run?.(r.n, a);
        WORLD.actor = 0;
        if (res?.say) p.link.send({ t: 'say', w: r.w, s: res.say, toast: res.toast || null });
        break;
      }
      case 'vsr': g.onVsRequest?.(p, r.d); break;
      case 'cleanUp': g.cleanUp(); break;
      case 'spawnV': {
        if (g.vehicles.list.length >= 6) break;
        g.vehicles.spawn(r.k, new THREE.Vector3(...r.p), r.y);
        g.audio.play('button');
        break;
      }
      case 'removeV': g.vehicles.clear(); break;
      case 'veh': {
        const v = g.vehicles.byId(r.id);
        if (!v) break;
        if (r.op === 'in' && !v.driver) { v.driver = p.id; v.netFollow = true; v._netBuf = []; this.emit({ t: 'vdrv', id: v.id, d: p.id }); }
        else if (r.op === 'out' && v.driver === p.id) {
          if (r.s) g.vehicles.setState(v, r.s);
          v.driver = 0; v.netFollow = false;
          this.emit({ t: 'vdrv', id: v.id, d: 0, s: r.s || null });
        }
        break;
      }
      case 'horn': { const v = g.vehicles.byId(r.id); if (v) { this.emit({ t: 'horn', id: v.id, p: p.id }); this.playAt('horn', v.pos); g.ragdolls.alert(v.pos, 25, 0.25, 'shot'); } break; }
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
    const vehicles = g.vehicles ? g.vehicles.list.map((v) => g.vehicles.record(v)) : [];
    return { map: g.getMap().def?.id, rags, bodies, glass, vehicles, ts: g.timeScale() };
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
      setTimeout(() => { if (this.joining) this.leave('The host didn\'t answer.'); }, 30000);
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
    if (m.t === 'hurt') { this.g.hurtMe?.(m.d, { kind: m.k, from: m.f ? new THREE.Vector3(...m.f) : null }); return; }
    if (m.t === 'say') { this.g.tools[m.w]?.say?.(m.s); if (m.toast) this.g.hud.toast(m.toast); return; }
    if (m.t === 'grabEnd') { this.g.grab.release(true); return; }
    if (m.t === 'chat') { this.g.onChat?.(m); return; }
    if (m.t === 'vsme') { this.g.onVsMe?.(m); return; }
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
    this.rebuildWorld(m);
    g.vehicles.remote = {
      enter: (v) => this.reqOut.push({ t: 'veh', op: 'in', id: v.id }),
      exit: (v, st) => { v.netFollow = true; v._netBuf = []; this.reqOut.push({ t: 'veh', op: 'out', id: v.id, s: st }); },
      horn: (v) => this.reqOut.push({ t: 'horn', id: v.id }),
    };
    g.vehicles.onHorn = (v) => this.reqOut.push({ t: 'horn', id: v.id });
    g.vehicles.onSpawn = g.vehicles.onRemove = g.vehicles.onEnter = g.vehicles.onExit = null;
    g.spawnMenu.remoteSpawnVehicle = (k, pos, yaw) => this.reqOut.push({ t: 'spawnV', k, p: [pos.x, pos.y, pos.z], y: yaw });
    // only the guns for now
    // every item's effect on the world goes to the host's game (see each tool's act())
    for (const t of g.tools) if (t.act) t.remote = (tool, name, a) => this.toolAct(tool, name, a);
    g.onJoined?.();
    this.setStatus('');
    g.hud.toast(`Joined room ${this.code}`);
    this.onChange?.(this);
  }

  /** Friend: the host's whole world (on joining, and after the host loads a saved scene). */
  rebuildWorld(m) {
    const g = this.g;
    if (m.map && m.map !== g.getMap().def?.id) g.loadMap(m.map);
    g.vehicles.exit(true);
    g.ragdolls.clear(g.ragdolls.keep);
    g.cleanUp(true);
    this.ragById.clear(); this.bodyById.clear();
    for (const rec of m.rags) this.spawnCopy(rec);
    for (const b of m.bodies) this.addBody(b);
    g.vehicles.clear();
    for (const rec of m.vehicles || []) this.addVehicle(rec);
    const glass = g.getMap().glass;
    if (glass) { const a = glass.audio; glass.audio = null; for (const i of m.glass || []) { const p = glass.panes[i]; if (p) glass.breakPane(p, null, 0.5); } glass.audio = a; }
  }

  /** Host: send friends the whole world again (a saved scene was loaded). */
  resync() {
    if (!this.host || !this.players.size) return;
    for (const p of this.players.values()) p.hp.clear();
    this.emit({ t: 'world', ...this.worldRecord() });
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
    for (const p of this.players.values()) { p.avatar?.dispose(); if (p.pusher) g.physics.world.removeBody(p.pusher); p.grab?.dispose(); if (p.info) p.info.gone = true; }
    this.players.clear();
    // cars friends were driving stop where they are
    for (const v of g.vehicles?.list || []) if (v.netFollow || (v.driver && v !== g.vehicles.driving)) { v.driver = 0; v.netFollow = false; }
    this.peer = null; this.hostLink = null; this.code = null; this.joining = false;
    this.role = 'off';
    this.queue.length = 0; this.out.length = 0;
    this.announced.clear();
    if (was === 'guest') {
      // back to playing alone: a fresh world of our own
      g.spawnMenu.remoteSpawn = null;
      g.spawnMenu.remoteSpawnVehicle = null;
      g.vehicles.exit(true);
      g.vehicles.remote = null; g.vehicles.onHorn = null;
      g.vehicles.clear();
      g.grab.release(true);
      for (const t of g.tools) t.remote = null;
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
    const rec = { t: 'r+', id: r.netId, n: r.name, z: !!r.zombie, b: r.behavior === 'v2' ? 'v2' : 'classic', a: armor, pose, yaw: +(r.heading?.() || 0).toFixed(3) };
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
        self.emit({ t: 'g', f: name, a: encode(name === 'bulletWound' || name === 'bladeWound' ? [args[0], slimHit(args[1]), ...args.slice(2)] : args) });
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
        if (!opts.fragment && !opts.bot) {
          if (opts.owner) w = opts.tool ?? -1;
          else if (!opts.shot || !opts.shot.netSent) { w = g.toolbox.index; if (opts.shot) opts.shot.netSent = true; }
        }
        const m = visualFrom ? [visualFrom.x, visualFrom.y, visualFrom.z] : null;
        self.emit({ t: 'shot', p: owner, w, o: [origin.x, origin.y, origin.z], d: [dir.x, dir.y, dir.z], m,
          x: { size: opts.size, glowSize: opts.glowSize, speed: opts.speed, life: opts.life, range: opts.range, fragment: !!opts.fragment, pellet: !!opts.pellet, snd: opts.snd } });
      }
      return res;
    };
    // vehicles
    const vh = g.vehicles;
    if (vh) {
      vh.onSpawn = (v) => { if (self.host) self.emit({ t: 'v+', ...vh.record(v) }); };
      vh.onRemove = (v) => { if (self.host) self.emit({ t: 'v-', id: v.id }); };
      vh.onHorn = (v) => { if (self.host) self.emit({ t: 'horn', id: v.id, p: self.me.id }); };
      vh.onEnter = (v) => { if (self.host) self.emit({ t: 'vdrv', id: v.id, d: self.me.id }); };
      vh.onExit = (v) => { if (self.host) self.emit({ t: 'vdrv', id: v.id, d: 0 }); };
    }
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
  /** VS Undead: a friend asks the host's game for something (buy, open a crate, place a gadget, ready). */
  vsRequest(d) { if (this.guest) this.reqOut.push({ t: 'vsr', d }); }
  /** VS Undead: the host tells one player something (what they bought, their loot). */
  sendTo(id, m) { const p = this.players.get(id); p?.link?.send({ t: 'vsme', ...m }); }
  requestSpawn(list) { this.reqOut.push({ t: 'spawn', list }); }
  requestPress(i) { this.reqOut.push({ t: 'press', i }); }
  requestRemoveAll() { this.reqOut.push({ t: 'removeAll' }); }
  requestCleanUp() { this.reqOut.push({ t: 'cleanUp' }); }
  requestRemoveVehicles() { this.reqOut.push({ t: 'removeV' }); }
  toolAllowed() { return true; }
  requestThrow(pos, vel, spin, spoonPos, spoonVel) {
    const a = (v) => [v.x, v.y, v.z];
    this.reqOut.push({ t: 'throw', p: a(pos), v: a(vel), s: a(spin), sp: a(spoonPos), sv: a(spoonVel) });
  }

  /** Friend: what an item did (a punch, a cut, a bandage, a grab...), for the host's game to do. */
  toolAct(tool, name, a) {
    const w = this.g.tools.indexOf(tool);
    if (w < 0) return undefined;
    const o = {};
    for (const [k, v] of Object.entries(a)) {
      if (v?.isVector3) o[k] = { $v: [v.x, v.y, v.z] };
      else if (isRagdoll(v)) o[k] = { $r: v.netId };
      else if (k === 'gib' || k === 'grenade') o[k] = { $b: v.netId };
      else if (k === 'button') o[k] = { $btn: this.g.buttons.indexOf(v) };
      else o[k] = v;
    }
    this.reqOut.push({ t: 'act', w, n: name, a: o });
    return undefined;
  }

  /** Host: turn a friend's item use back into game objects. Null if what it was about is gone. */
  actArgs(o) {
    const g = this.g, a = {};
    for (const [k, v] of Object.entries(o)) {
      if (v && v.$v) a[k] = new THREE.Vector3(...v.$v);
      else if (v && v.$r !== undefined) { a[k] = g.ragdolls.list.find((r) => r.netId === v.$r && !r.removed); if (!a[k]) return null; }
      else if (v && v.$b !== undefined) { a[k] = g.gore.gibs.find((x) => x.netId === v.$b) || g.explosives.live.find((x) => x.netId === v.$b); if (!a[k]) return null; }
      else if (v && v.$btn !== undefined) { a[k] = g.buttons[v.$btn]; if (!a[k]) return null; }
      else a[k] = v;
    }
    return a;
  }

  /** Host: zombies (and anything else) hurting a friend. */
  hurtFriend(id, dmg, opts = {}) {
    const p = this.players.get(id);
    const f = opts.from;
    p?.link?.send({ t: 'hurt', d: Math.round(dmg * 10) / 10, k: opts.kind || '', f: f ? [f.x, f.y, f.z] : null });
  }

  /** Host: what the zombies know about each friend (where they are, alive or not). */
  friendInfos() {
    const out = [];
    for (const p of this.players.values()) {
      const s = p.buf[p.buf.length - 1];
      if (!s) continue;
      const info = p.info || (p.info = { isPlayer: true, remote: true, id: p.id, pos: new THREE.Vector3(), alive: true });
      info.name = p.name;
      info.pos.set(s.x, s.y, s.z);
      info.alive = !(s.flags & 8);
      out.push(info);
    }
    return out;
  }

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
      this.placeVehicles(T);
      this.updateAvatars(dt, T);
    } else if (this.host) {
      this.updateAvatars(dt, now - DELAY);
      this.placeVehicles(now - DELAY);
      this.updatePushers(now);
      for (const p of this.players.values()) p.grab?.update();
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
      // health: a few times a second, and straight away when a ragdoll dies, wakes or falls
      let urgent = false;
      for (const r of this.announced) {
        const h = r.health, sig = `${h.alive}${h.undead}${r.brain?.state}${r.zombie}`;
        if (r._netSig !== sig) { r._netSig = sig; urgent = true; }
      }
      const hpDue = urgent || now - this.lastHp >= 1000 / HEALTH_HZ;
      if (hpDue) this.lastHp = now;
      const common = this.out;
      this.out = [];
      const secs = hpDue && this.players.size ? this.healthNow() : null;
      for (const p of this.players.values()) {
        if (!p.ready) continue;
        let e = common;
        // a connection that is backed up skips a health update (the next one carries the changes)
        if (secs && p.link.backlog < 96 * 1024) { const hp = this.healthFor(p, secs); if (hp) e = common.concat([hp]); }
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
        const w = new Writer(128);
        w.u8(2); w.u32(++this.seq); w.f64(now);
        this.writePlayer(w, this.myState());
        // the car you drive
        const dv = this.g.vehicles?.driving;
        w.u16(dv ? dv.id : 0);
        if (dv) this.writeVehicle(w, dv);
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
    // vehicles (a friend's own car is skipped by that friend)
    const vl = g.vehicles?.list || [];
    w.u8(vl.length);
    for (const v of vl) { w.u16(v.id); w.u8(v.driver & 255); this.writeVehicle(w, v); }
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
    if (rd.left >= 1) {
      const nv = rd.u8();
      for (let i = 0; i < nv; i++) {
        const id = rd.u16(), d = rd.u8(), st = this.readVehicle(rd);
        st.t = ht;
        const v = this.g.vehicles?.byId(id);
        if (v && v !== this.g.vehicles.driving) push(v._netBuf ||= [], st, 10);
      }
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
    if (rd.left >= 2) {
      const vid = rd.u16();
      if (vid) {
        const st = this.readVehicle(rd);
        const v = this.g.vehicles?.byId(vid);
        if (v && v.driver === p.id) { st.t = s.t; push(v._netBuf ||= [], st, 12); }
      }
    }
  }

  // ------------------------------------------------------------------ vehicles
  writeVehicle(w, v) {
    w.f32(v.pos.x); w.f32(v.pos.y); w.f32(v.pos.z); w.f32(v.yaw);
    w.i16(v.pitch * 10000); w.i16(v.roll * 10000);
    w.f32(v.vel.x); w.f32(v.vel.z); w.i16(v.vy * 100); w.i16(v.speed * 100); w.i8(v.steer * 127); w.i8(v.throttle * 127); w.i16(v.yawRate * 1000);
  }
  readVehicle(rd) {
    return { x: rd.f32(), y: rd.f32(), z: rd.f32(), yaw: rd.f32(), pitch: rd.i16() / 10000, roll: rd.i16() / 10000,
      vx: rd.f32(), vz: rd.f32(), vy: rd.i16() / 100, speed: rd.i16() / 100, steer: rd.i8() / 127, th: rd.i8() / 127, yr: rd.i16() / 1000 };
  }

  /** A copy of one of the host's vehicles (moved by the host's updates). */
  addVehicle(rec) {
    const vh = this.g.vehicles;
    if (vh.byId(rec.id)) return vh.byId(rec.id);
    const v = vh.spawn(rec.k, new THREE.Vector3(...rec.p), rec.y, { id: rec.id, color: rec.c });
    if (!v) return null;
    v.netFollow = true; v._netBuf = []; v.driver = rec.d || 0;
    return v;
  }

  /** Vehicles someone else drives: where they were DELAY ago, smoothed. */
  placeVehicles(T) {
    const vh = this.g.vehicles;
    if (!vh) return;
    for (const v of vh.list) {
      if (!v.netFollow || v === vh.driving || !v._netBuf?.length) continue;
      const br = bracket(v._netBuf, T);
      if (!br) continue;
      const [a, b, k] = br;
      let dy = b.yaw - a.yaw; dy -= Math.round(dy / (Math.PI * 2)) * Math.PI * 2;
      vh.setState(v, {
        x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k, z: a.z + (b.z - a.z) * k, yaw: a.yaw + dy * k,
        pitch: a.pitch + (b.pitch - a.pitch) * k, roll: a.roll + (b.roll - a.roll) * k, vx: a.vx + (b.vx - a.vx) * k, vz: a.vz + (b.vz - a.vz) * k,
        vy: b.vy, speed: a.speed + (b.speed - a.speed) * k, steer: a.steer + (b.steer - a.steer) * k, th: b.th, yr: b.yr,
      });
      v.spin += (v.speed / v.k.wheelR) * (1 / 60);
      vh.place(v);
    }
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
  /** Every announced ragdoll's health in small pieces (with their JSON), once per health tick. */
  healthNow() {
    const out = [];
    for (const r of this.announced) {
      if (r.hidden || r.removed) continue;
      const m = healthFlat(r.health);
      m.set('x', this.brainRecord(r));
      const str = new Map();
      for (const [k, v] of m) str.set(k, JSON.stringify(v));
      out.push({ id: r.netId, m, str });
    }
    return out;
  }

  /** The pieces this friend doesn't have yet (and the ones that went back to unhurt, as null). */
  healthFor(p, secs) {
    const list = [];
    for (const { id, m, str } of secs) {
      let cache = p.hp.get(id);
      if (!cache) { cache = new Map(); p.hp.set(id, cache); }
      let d = null;
      for (const [k, js] of str) if (cache.get(k) !== js) { cache.set(k, js); (d ??= []).push([k, m.get(k)]); }
      if (cache.size > str.size) for (const k of [...cache.keys()]) if (!str.has(k)) { cache.delete(k); (d ??= []).push([k, null]); }
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
          applyHealthFlat(r.health, s);
          const x = s.find((it) => it[0] === 'x')?.[1];
          if (x) { if (r.brain) { r.brain.state = x.s; r.brain.activity = x.a; } if (x.n) r.name = x.n; }
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
        if (e.p === this.me.id && !e.x?.snd) break;       // our own: already shown (a sentry gun's aren't)
        const o = new THREE.Vector3(...e.o), d = new THREE.Vector3(...e.d);
        const p = this.players.get(e.p);
        const m = p?.avatar?.muzzleWorld() || (e.m ? new THREE.Vector3(...e.m) : null);
        g.ballistics.fire(o, d, m, { ...e.x, replay: true, ghost: true });
        if (e.x?.snd) this.playAt(e.x.snd, o);
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
      case 'toast': g.hud.toast(e.s); g.onSystem?.(e.s); break;
      case 'world': this.rebuildWorld(e); break;
      case 'vs': g.onVs?.(e); break;
      case 'v+': this.addVehicle(e); break;
      case 'v-': { const v = g.vehicles.byId(e.id); if (v) g.vehicles.remove(v); break; }
      case 'vdrv': {
        const v = g.vehicles.byId(e.id);
        if (!v) break;
        if (e.d === this.me.id) { if (g.vehicles.driving !== v) { v.netFollow = false; v.driver = 0; g.vehicles.enter(v); } }
        else {
          if (g.vehicles.driving === v) g.vehicles.exit(true);
          v.driver = e.d; v.netFollow = true;
          if (e.s) g.vehicles.setState(v, e.s);
        }
        break;
      }
      case 'horn': { if (e.p === this.me.id) break; const v = g.vehicles.byId(e.id); if (v) this.playAt('horn', v.pos); break; }
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
    const r = this.buildRagdoll(rec, true);
    this.ragById.set(rec.id, r);
    return r;
  }

  /**
   * A ragdoll from a record (ragdollRecord(r, true)): in the same pose, with the same wounds,
   * missing limbs and health. replica: a friend's copy (moved by the host); otherwise a real one
   * (a saved scene being loaded).
   */
  buildRagdoll(rec, replica = false) {
    const g = this.g;
    const P = rec.pose;
    const armor = { helmet: !!rec.a?.helmet, vest: !!rec.a?.vest };
    const y = replica ? 0 : g.getMap().groundAt(P[0], P[2], P[1] + 0.3);
    const r = g.ragdolls.spawn([P[0], y, P[2]], rec.yaw || 0, { armor, behavior: rec.b, zombie: rec.z, name: rec.n });
    if (replica) { r.netId = rec.id; r._netBuf = []; r.replica = true; }
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
    // joined late (or loaded): what has already happened to it
    if (rec.hs) this.restore(r, rec);
    r.sync();
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
