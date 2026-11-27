import * as THREE from 'three';
import { GROUP } from '../core/physics.js';
import { canvasTexture } from '../core/util.js';
import { elevatorPanel } from './towerTextures.js';

const DOOR_W = 0.6, DOOR_H = 2.2;
const OPEN_T = 1.1, CLOSE_T = 1.3, HOLD_T = 6;

/**
 * The tower's elevator. The car stops at one floor at a time; a ride closes the doors, hums for a
 * few seconds and moves the car (and whoever is in it: you, ragdolls, gibs) to the floor you picked.
 * Every floor's identical, so the car is simply moved there while its doors are shut.
 *
 * opts: levels (count), floorY(i), labels[i], shaft { x0, x1, z0, z1 }, doorZ (landing door
 * plane), metal / steel materials.
 */
export class Elevator {
  constructor(map, { levels, floorY, labels, shaft, doorZ, materials }) {
    this.map = map;
    this.levels = levels; this.floorY = floorY; this.labels = labels; this.shaft = shaft; this.doorZ = doorZ;
    this.level = 0;          // where the car is
    this.target = null;      // where it's going next
    this.state = 'closed';   // closed | opening | open | closing | moving
    this.doorT = 0;          // 0 closed .. 1 open
    this.t = 0;
    this.rideT = 0;
    const M = materials;

    // ---- landing doors (one pair per floor) ----
    const doorGeo = new THREE.BoxGeometry(DOOR_W, DOOR_H, 0.04);
    this.landing = [];
    for (let i = 0; i < levels; i++) {
      const y = floorY(i);
      const L = new THREE.Mesh(doorGeo, M.door), R = new THREE.Mesh(doorGeo, M.door);
      L.position.set(-DOOR_W / 2, y + DOOR_H / 2, doorZ); R.position.set(DOOR_W / 2, y + DOOR_H / 2, doorZ);
      L.castShadow = R.castShadow = true;
      map.add(L); map.add(R);
      const c = map.addCollider(new THREE.Vector3(-DOOR_W, y, doorZ - 0.08), new THREE.Vector3(DOOR_W, y + DOOR_H, doorZ + 0.08));
      const body = map.staticBox([DOOR_W, DOOR_H / 2, 0.08], [0, y + DOOR_H / 2, doorZ]);
      this.landing.push({ L, R, collider: c, body, y });
    }

    // ---- the car ----
    const car = new THREE.Group();
    const { x0, x1, z0, z1 } = shaft;
    const w = x1 - x0 - 0.1, d = z1 - z0 - 0.1, cx = (x0 + x1) / 2, cz = (z0 + z1) / 2, H = 2.6;
    const wall = (ww, hh, dd, x, y, z, mat = M.steel) => { const m = new THREE.Mesh(new THREE.BoxGeometry(ww, hh, dd), mat); m.position.set(x, y, z); m.receiveShadow = true; car.add(m); return m; };
    wall(0.04, H, d, x0 + 0.07, H / 2, cz);
    wall(0.04, H, d, x1 - 0.07, H / 2, cz);
    wall(w, H, 0.04, cx, H / 2, z0 + 0.07);
    wall(w, 0.04, d, cx, H, cz, M.ceiling);
    wall(w, 0.012, d, cx, 0.006, cz, M.carFloor);
    const lamp = wall(w * 0.6, 0.02, d * 0.5, cx, H - 0.03, cz, M.lamp);
    lamp.castShadow = false;
    // handrails
    for (const sx of [x0 + 0.12, x1 - 0.12]) wall(0.04, 0.04, d * 0.7, sx, 0.9, cz, M.rail);
    wall(w * 0.7, 0.04, 0.04, cx, 0.9, z0 + 0.12, M.rail);
    // control panel on the right-hand wall as you walk in
    const panel = new THREE.Mesh(new THREE.PlaneGeometry(0.26, 0.52), new THREE.MeshStandardMaterial({ map: elevatorPanel(), roughness: 0.35, metalness: 0.6 }));
    panel.position.set(x1 - 0.095, 1.2, z1 - 0.45);
    panel.rotation.y = -Math.PI / 2;
    car.add(panel);
    // car doors
    const cdGeo = new THREE.BoxGeometry(DOOR_W, DOOR_H, 0.03);
    this.carL = new THREE.Mesh(cdGeo, M.steel); this.carR = new THREE.Mesh(cdGeo, M.steel);
    this.carL.position.set(-DOOR_W / 2, DOOR_H / 2, z1 - 0.03); this.carR.position.set(DOOR_W / 2, DOOR_H / 2, z1 - 0.03);
    car.add(this.carL, this.carR);
    map.add(car);
    this.car = car;
    this.panel = { meshes: [panel], prompt: () => (this.state === 'moving' ? '' : 'Choose a floor'), press: () => this.openPicker() };
    panel.userData.interact = this.panel;
    map.interactables.push(this.panel);

    // ---- floor indicator over every landing door (one shared screen) ----
    this.screen = canvasTexture(256, 96, () => {});
    this.screenCanvas = this.screen.image;
    const scrMat = new THREE.MeshBasicMaterial({ map: this.screen, toneMapped: false });
    const scrGeo = new THREE.PlaneGeometry(0.5, 0.19);
    // call buttons
    const btnGeo = new THREE.BoxGeometry(0.12, 0.2, 0.03);
    this.calls = [];
    for (let i = 0; i < levels; i++) {
      const y = floorY(i);
      const scr = new THREE.Mesh(scrGeo, scrMat);
      this.landing[i].extra = [scr];
      scr.position.set(0, y + 2.48, doorZ + 0.105);
      map.add(scr, { quality: false });
      const btn = new THREE.Mesh(btnGeo, M.button);
      btn.position.set(0.9, y + 1.12, doorZ + 0.11);
      map.add(btn, { quality: false });
      this.landing[i].extra.push(btn);
      const it = {
        meshes: [btn], level: i,
        prompt: () => this.callPrompt(i),
        press: () => this.call(i),
      };
      btn.userData.interact = it;
      map.interactables.push(it);
      this.calls.push(it);
    }
    this.drawScreen();
    this.place();
    map.updaters.push((dt, focus, ctx) => this.update(dt, ctx));
  }

  get ctx() { return this.map.ctx; }

  /** Only draw the doors, buttons and screens (and the car) on the floors the map says can be seen. */
  showLevels(shown) {
    this.landing.forEach((ld, i) => { const v = !!shown[i]; if (ld.L.visible !== v) { ld.L.visible = ld.R.visible = v; for (const m of ld.extra) m.visible = v; } });
    this.car.visible = !!shown[this.level];
  }

  callPrompt(i) {
    if (this.level === i && this.state !== 'moving') return this.state === 'open' || this.state === 'opening' ? 'Hold the doors' : 'Open the elevator';
    if (this.target === i) return 'Elevator on its way';
    return 'Call the elevator';
  }

  call(i) {
    const a = this.ctx?.audio;
    a?.play('button');
    if (this.state === 'moving') { if (this.target !== i) this.queued = i; return; }
    if (this.level === i) { this.open(); return; }
    this.go(i);
  }

  openPicker() {
    const ctx = this.ctx;
    ctx?.audio?.play('click');
    ctx?.pickFloor?.({ labels: this.labels, current: this.level, onPick: (n) => { ctx.audio?.play('button'); if (n === this.level) this.open(); else this.go(n); } });
  }

  open() { if (this.state === 'closed' || this.state === 'closing') { this.state = 'opening'; this.ctx?.audio?.play('liftDoor'); } this.t = 0; }

  go(n) {
    this.target = n;
    if (this.state === 'closed') this.depart();
    else if (this.state !== 'closing') { this.state = 'closing'; this.ctx?.audio?.play('liftDoor'); }
  }

  depart() {
    this.state = 'moving';
    this.rideT = 0;
    this.rideLen = Math.min(6, 2 + 0.2 * Math.abs(this.target - this.level));
    this.ctx?.audio?.play('liftGo');
    this.drawScreen();
  }

  /** Inside the car (at its current floor)? */
  inside(p) {
    const s = this.shaft, y = this.floorY(this.level);
    return p.x > s.x0 - 0.05 && p.x < s.x1 + 0.05 && p.z > s.z0 - 0.05 && p.z < s.z1 + 0.05 && p.y > y - 0.6 && p.y < y + 2.9;
  }

  /** Something standing in the doorway (keeps the doors from closing on it). */
  blocked() {
    const ctx = this.ctx, y = this.floorY(this.level);
    const inDoor = (p) => Math.abs(p.x) < DOOR_W + 0.1 && p.z > this.shaft.z1 - 0.35 && p.z < this.doorZ + 0.35 && p.y > y - 0.3 && p.y < y + DOOR_H;
    if (ctx?.player && inDoor(ctx.player.pos)) return true;
    for (const r of ctx?.ragdolls?.list || []) {
      if (r.hidden) continue;
      for (const n in r.parts) { const part = r.parts[n]; if (!part.removed && inDoor(part.body.position)) return true; }
    }
    return false;
  }

  /** Move the car and everything riding in it from its floor to the target floor. */
  arrive() {
    const ctx = this.ctx, from = this.level, to = this.target;
    const dy = this.floorY(to) - this.floorY(from);
    if (ctx) {
      const held = ctx.grab?.held;
      const carried = new Set();
      if (ctx.player && this.inside(ctx.player.pos)) {
        ctx.player.teleport(0, dy, 0);
        if (held?.kind === 'ragdoll') { held.ragdoll.translate(0, dy, 0); carried.add(held.ragdoll); }
        else if (held?.kind === 'gib') held.body.position.y += dy;
        ctx.player.addShake?.(0.25);
      }
      const tmp = new THREE.Vector3();
      for (const r of ctx.ragdolls?.list || []) {
        if (r.hidden || carried.has(r)) continue;
        if (this.inside(r.bodyPos('pelvis', tmp))) r.translate(0, dy, 0);
      }
      for (const g of ctx.gore?.gibs || []) if (g !== held?.gib && this.inside(g.body.position)) { g.body.position.y += dy; g.body.previousPosition?.copy(g.body.position); }
    }
    this.level = to;
    this.target = null;
    this.place();
    ctx?.audio?.play('ding');
    ctx?.audio?.play('liftStop');
    this.state = 'opening'; this.t = 0;
    ctx?.audio?.play('liftDoor');
    this.drawScreen();
  }

  place() { this.car.position.y = this.floorY(this.level); this.lastK = -1; }

  drawScreen() {
    const c = this.screenCanvas, g = c.getContext('2d');
    g.fillStyle = '#0b0c0e'; g.fillRect(0, 0, c.width, c.height);
    g.fillStyle = '#ff8a2a'; g.font = 'bold 64px monospace'; g.textAlign = 'center'; g.textBaseline = 'middle';
    const arrow = this.state === 'moving' && this.target != null ? (this.target > this.level ? '▲' : '▼') : '';
    g.fillText(`${arrow}${this.labels[this.level]}`, c.width / 2, c.height / 2 + 4);
    this.screen.needsUpdate = true;
  }

  update(dt, ctx) {
    this.t += dt;
    const was = this.doorT;
    switch (this.state) {
      case 'opening':
        this.doorT = Math.min(1, this.doorT + dt / OPEN_T);
        if (this.doorT >= 1) { this.state = 'open'; this.t = 0; }
        break;
      case 'open':
        if (this.target != null && this.target !== this.level) { this.state = 'closing'; ctx?.audio?.play('liftDoor'); }
        else if (this.t > HOLD_T && !this.blocked()) { this.state = 'closing'; ctx?.audio?.play('liftDoor'); }
        break;
      case 'closing':
        if (this.blocked()) { this.state = 'opening'; break; }
        this.doorT = Math.max(0, this.doorT - dt / CLOSE_T);
        if (this.doorT <= 0) {
          this.state = 'closed';
          if (this.target != null && this.target !== this.level) this.depart();
          else this.target = null;
        }
        break;
      case 'moving': {
        this.rideT += dt;
        // a light rumble while you ride
        if (ctx?.player && this.inside(ctx.player.pos) && Math.random() < dt * 6) ctx.player.addShake?.(0.03);
        if (this.rideT >= this.rideLen) {
          this.arrive();
          if (this.queued != null) { const q = this.queued; this.queued = null; if (q !== this.level) this.target = q; }
        }
        break;
      }
    }
    if (this.doorT !== was || this._first !== true) {
      this._first = true;
      const e = this.doorT * this.doorT * (3 - 2 * this.doorT);
      const off = e * (DOOR_W - 0.05);
      const ld = this.landing[this.level];
      ld.L.position.x = -DOOR_W / 2 - off; ld.R.position.x = DOOR_W / 2 + off;
      this.carL.position.x = -DOOR_W / 2 - off; this.carR.position.x = DOOR_W / 2 + off;
      const open = this.doorT > 0.55;
      ld.collider.off = open;
      ld.body.collisionFilterMask = open ? 0 : GROUP.RAGDOLL | GROUP.DEBRIS;
      // every other floor's doors stay shut
      for (const o of this.landing) if (o !== ld && o.L.position.x !== -DOOR_W / 2) { o.L.position.x = -DOOR_W / 2; o.R.position.x = DOOR_W / 2; o.collider.off = false; o.body.collisionFilterMask = GROUP.RAGDOLL | GROUP.DEBRIS; }
    }
  }
}
