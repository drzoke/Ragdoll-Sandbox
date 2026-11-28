import * as THREE from 'three';
import { ANATOMY } from './anatomy.js';
import { PARTS, PART_BY_NAME, descendants } from './skeleton.js';
import { CONFIG } from '../config.js';
import { clamp, rayEllipsoid, segSegDistance } from '../core/util.js';

const PH = CONFIG.physiology;
const TORSO_PARTS = new Set(['chest', 'abdomen', 'pelvis']);

/** Ray (local space) vs the part's collision volume. Returns {tIn, tOut} or null. */
export function rayThroughPart(def, o, d) {
  if (def.shape === 'sphere') {
    const r = def.size[0];
    const hit = rayEllipsoid(o, d, [0, 0, 0], [r, r, r]);
    return hit ? { tIn: Math.max(0, hit[0]), tOut: hit[1] } : null;
  }
  let tIn = -Infinity, tOut = Infinity;
  const h = [def.size[0] / 2, def.size[1] / 2, def.size[2] / 2], oo = [o.x, o.y, o.z], dd = [d.x, d.y, d.z];
  for (let i = 0; i < 3; i++) {
    if (Math.abs(dd[i]) < 1e-9) { if (Math.abs(oo[i]) > h[i] + 0.02) return null; continue; }
    let t1 = (-h[i] - oo[i]) / dd[i], t2 = (h[i] - oo[i]) / dd[i];
    if (t1 > t2) [t1, t2] = [t2, t1];
    tIn = Math.max(tIn, t1); tOut = Math.min(tOut, t2);
  }
  if (tOut < tIn) return null;
  return { tIn: Math.max(0, tIn), tOut };
}

/**
 * Damage + physiology model for one ragdoll. Purely data: no three.js / cannon objects.
 * The Ragdoll class reads the outputs (capabilities, consciousness...) and the gore system
 * reads wounds and events.
 */
export class Health {
  constructor() {
    this.parts = {};
    for (const p of PARTS) {
      const a = ANATOMY[p.name];
      this.parts[p.name] = { name: p.name, label: p.label, tissue: a.tissue, maxTissue: a.tissue, attached: true, opened: false, hits: 0 };
    }
    this.bones = {}; this.organs = {}; this.vessels = {};
    for (const [part, a] of Object.entries(ANATOMY)) {
      for (const b of a.bones) this.bones[b.id] = { ...b, part, integrity: 100, fractured: false };
      for (const o of a.organs) this.organs[o.id] = { ...o, part, hp: o.hp, maxHp: o.hp };
      for (const v of a.vessels) this.vessels[v.id] = { ...v, part, cut: false };
    }
    this.wounds = [];
    this.events = [];            // {t, text, severity}
    this.time = 0;

    // Vitals
    this.maxBlood = PH.bloodVolume;
    this.blood = PH.bloodVolume;
    this.o2 = 98;                // blood O2 saturation %
    this.heartRate = 72;
    this.breathRate = 14;
    this.pain = 0;               // 0..100 felt pain
    this.rawPain = 0;
    this.adrenaline = 0;         // 0..1
    this.shock = 0;              // 0..100
    this.consciousness = 100;
    this.paralyzed = false;
    this.cardiacArrest = false;
    this.noCirculationTime = 0;
    this.brainDeath = 0;         // 0..1 progress
    this.alive = true;
    this.deathCause = '';
    // Zombies (Alpha 0.9): undead bodies don't need blood, a heart or air. Only destroying the
    // brain (or taking the head off) stops them. A zombie bite infects: the infection kills slowly,
    // and the dead body gets back up as a zombie unless the head was destroyed.
    this.undead = false;
    this.infected = false;
    this.infection = 0;          // 0..1, dead at 1
    this.lastHitTime = -99;
    this.lastHitPart = null;

    // Treatment (medkit / defibrillator)
    this.morphine = 0;           // in the blood, 1 = one full dose
    this.transfusing = 0;        // ml of a blood bag still to run in
    this.rosc = 0;               // s since the heart was restarted (it is fragile for a while)
    this.shocks = 0;             // defibrillator shocks during this arrest
    this.pressing = null;        // wound the ragdoll presses on with its own hand
  }

  log(text, severity = 'bad') {
    this.events.unshift({ t: this.time, text, severity });
    if (this.events.length > 12) this.events.length = 12;
  }

  // ---------------------------------------------------------------- Hits
  /**
   * Resolve a bullet passing through one body part.
   * @param partName
   * @param o entry point (local), d direction (local, unit)
   * @param energy 0..1 remaining bullet energy
   * @returns result describing what happened (used for gore and for continuing the bullet)
   */
  /** VS Undead: the body (chest, belly, hips) of a zombie shrugs off part of each hit (bodyResist), the head none. */
  tissueMul(partName) {
    return this.bodyResist && TORSO_PARTS.has(partName) ? this.bodyResist : 1;
  }

  bulletHit(partName, o, d, energy, { dismember = true } = {}) {
    const def = PART_BY_NAME[partName];
    const part = this.parts[partName];
    const anat = ANATOMY[partName];
    const span = rayThroughPart(def, o, d) || { tIn: 0, tOut: 0.05 };
    const t0 = span.tIn, path = Math.max(0.02, span.tOut - span.tIn);
    let consumed = path * 3.0;
    const res = { partName, organs: [], bones: [], vessels: [], dismember: false, opened: false, exit: false, exitT: span.tOut, energyOut: 0, bleed: 0, pain: 0 };

    // Bones
    for (const b of anat.bones) {
      const bone = this.bones[b.id];
      let hit = false;
      if (b.shell) hit = Math.random() < b.chance;
      else hit = segSegDistance(o, d, t0, span.tOut, b.a, b.b).dist < b.r + 0.006;
      if (!hit) continue;
      consumed += b.shell ? 0.22 : 0.35;
      const dmg = (b.shell ? 40 : 62) * energy * (0.8 + Math.random() * 0.4);
      bone.integrity = Math.max(0, bone.integrity - dmg);
      res.bones.push(bone);
      if (!bone.fractured && bone.integrity < 55) {
        bone.fractured = true;
        this.rawPain += 25;
        this.log(`${bone.name} fractured`);
      } else if (bone.integrity <= 0) this.log(`${bone.name} shattered`);
      if (b.spine && !this.paralyzed && (bone.integrity < 20 || (bone.integrity < 50 && Math.random() < 0.4))) { this.paralyzed = true; this.log('Spinal cord damaged: legs paralysed'); }
    }

    // Organs (only the ones the remaining energy reaches)
    const reach = t0 + Math.min(path, energy / 3.0 + 0.02);
    for (const og of anat.organs) {
      const hit = rayEllipsoid(o, d, og.c, og.r);
      if (!hit || hit[1] < t0 || hit[0] > reach) continue;
      const organ = this.organs[og.id];
      const dmg = 80 * energy * (0.75 + Math.random() * 0.5);
      const was = organ.hp;
      organ.hp = Math.max(0, organ.hp - dmg);
      res.organs.push(organ);
      res.bleed += og.bleed * (organ.hp <= 0 ? 1.4 : 1);
      this.rawPain += 14;
      if (was > 0 && organ.hp <= 0) this.log(`${organ.name} destroyed`);
      else this.log(`${organ.name} hit`, 'warn');
    }

    // Vessels
    for (const v of anat.vessels) {
      const vessel = this.vessels[v.id];
      if (segSegDistance(o, d, t0, reach, v.a, v.b).dist > v.r + 0.01) continue;
      res.vessels.push(vessel);
      if (!vessel.cut) { vessel.cut = true; this.log(`${vessel.name} severed`); }
      res.bleed += v.bleed;
    }

    // Tissue
    const tissueDmg = (20 + path * 60) * energy * (0.85 + Math.random() * 0.3);
    if (part.tissue <= 0) part.overkill = (part.overkill || 0) + tissueDmg; // already destroyed tissue
    part.tissue = Math.max(0, part.tissue - tissueDmg * this.tissueMul(partName));
    part.hits++;
    res.bleed += 0.5 + path * 2;
    res.pain = (def.limb === 'torso' ? 26 : def.limb === 'head' ? 32 : 20) * energy;
    this.rawPain += res.pain;
    this.adrenaline = Math.min(1, this.adrenaline + 0.35);
    this.lastHitTime = this.time;
    this.lastHitPart = partName;

    // Penetration
    res.energyOut = energy - consumed;
    res.exit = res.energyOut > 0.06;

    // Structural outcomes
    const frac = part.tissue / part.maxTissue;
    const isTorso = partName === 'chest' || partName === 'abdomen' || partName === 'pelvis';
    if (isTorso || partName === 'head') {
      const skullBroken = partName !== 'head' || this.bones.skull.fractured;
      if (!part.opened && skullBroken && frac < (partName === 'head' ? 0.55 : 0.45)) {
        part.opened = true; res.opened = true;
        this.log(partName === 'head' ? 'Skull breached' : `${part.label} torn open: organs exposed`);
      }
    }
    const boneGone = anat.bones.some((b) => this.bones[b.id].integrity <= 0);
    if (dismember && !part.exploded) {
      // Head pops once its tissue is gone; torso parts and severed limbs burst after more punishment;
      // attached limbs get severed first.
      if (partName === 'head') { if (part.tissue <= 0 || (boneGone && frac < 0.35)) res.explode = true; }
      else if (isTorso && (part.overkill || 0) > 45) res.explode = true;
      else if (!isTorso && !part.attached && part.tissue <= 0 && (part.overkill || 0) > 15) res.explode = true;
      else if (!isTorso && part.attached && (part.tissue <= 0 || (boneGone && frac < 0.35))) res.dismember = true;
    }

    const wound = { part: partName, pos: o.clone().addScaledVector(d, t0), normal: d.clone().negate(), rate: res.bleed, arterial: res.vessels.length > 0 || res.organs.some((x) => x.id === 'heart'), exit: false, age: 0 };
    this.wounds.push(wound);
    res.wound = wound;
    if (res.exit) {
      const vesselBleed = res.vessels.reduce((a, v) => a + v.bleed, 0);
      const ew = { part: partName, pos: o.clone().addScaledVector(d, span.tOut), normal: d.clone(), rate: 0.7 + path * 2 + vesselBleed * 0.3, arterial: wound.arterial, exit: true, age: 0 };
      this.wounds.push(ew);
      res.exitWound = ew;
    }
    return res;
  }

  /** Detach a limb (and everything below it). Returns the list of parts that came off. */
  sever(partName, silent = false) {
    const list = [partName, ...descendants(partName)];
    for (const n of list) this.parts[n].attached = false;
    const p = this.parts[partName];
    if (!silent) this.log(`${p.label} severed`);
    this.rawPain += partName === 'head' ? 0 : 45;
    const big = partName.startsWith('thigh') ? 26 : partName.startsWith('upperArm') ? 12 : partName === 'head' ? 40 : 6;
    // Stump wound on the parent: heavy arterial bleed.
    this.wounds.push({ part: PART_BY_NAME[partName].parent, pos: null, joint: PART_BY_NAME[partName].joint.name, normal: null, rate: big, arterial: true, stump: true, exit: false, age: 0 });
    if (partName === 'head') { this.decapitated = true; if (!silent) this.log('Decapitated'); }
    return list;
  }

  /** Blow a body part apart. Limbs/head come off and vanish; torso parts are gutted in place. */
  explode(partName) {
    const p = this.parts[partName];
    if (p.exploded) return [];
    p.exploded = true;
    const anat = ANATOMY[partName];
    for (const og of anat.organs) this.organs[og.id].hp = 0;
    for (const b of anat.bones) { const bone = this.bones[b.id]; bone.integrity = 0; bone.fractured = true; }
    for (const v of anat.vessels) this.vessels[v.id].cut = true;
    p.tissue = 0;
    const isTorso = partName === 'chest' || partName === 'abdomen' || partName === 'pelvis';
    let list = [];
    if (isTorso) {
      this.wounds.push({ part: partName, pos: null, burst: true, normal: null, rate: partName === 'pelvis' ? 30 : 45, arterial: true, exit: false, age: 0 });
      if (partName === 'abdomen' || partName === 'chest') { this.paralyzed = true; }
      this.log(`${p.label} blown apart`);
    } else {
      if (p.attached) list = this.sever(partName, true);
      else list = [partName];
      // wounds on the vanished part stop bleeding (the stump carries it)
      for (const w of this.wounds) if (w.part === partName) w.rate = 0;
      this.log(partName === 'head' ? 'Head exploded' : `${p.label} blown apart`);
    }
    this.rawPain += 60;
    return list;
  }

  /**
   * Blunt trauma from impacts (falls, being thrown or slammed with the grab tool).
   * Returns { fractured } so the caller can play a crack and splat.
   */
  impact(partName, speed) {
    const out = { fractured: false, damage: 0 };
    if (speed < 5) return out;
    const part = this.parts[partName];
    const sev = speed - 5;
    const dmg = sev * sev * 0.9 + sev * 2;
    out.damage = dmg;
    part.tissue = Math.max(0, part.tissue - dmg * 0.35 * this.tissueMul(partName));
    if (part.attached) {
      this.rawPain += Math.min(40, dmg * 0.5);
      this.adrenaline = Math.min(1, this.adrenaline + 0.1);
    }
    // Bones break when the hit is hard enough (chance grows with speed).
    const breakChance = Math.max(0, Math.min(0.95, (speed - 7) / 9));
    for (const b of ANATOMY[partName].bones) {
      if (Math.random() > breakChance * (b.shell ? 0.6 : 1)) continue;
      const bone = this.bones[b.id];
      if (bone.integrity <= 0) continue;
      bone.integrity = Math.max(0, bone.integrity - (35 + sev * 7) * (0.7 + Math.random() * 0.6));
      if (!bone.fractured && bone.integrity < 55) {
        bone.fractured = true; out.fractured = true;
        if (part.attached) this.rawPain += 25;
        this.log(`${bone.name} fractured (impact ${speed.toFixed(0)} m/s)`);
      } else if (bone.integrity <= 0) { out.fractured = true; this.log(`${bone.name} shattered (impact)`); }
      if (b.spine && !this.paralyzed && bone.integrity < 35) { this.paralyzed = true; this.log('Spinal cord damaged: legs paralysed'); }
    }
    if (partName === 'head' && part.attached) {
      this.consciousness = Math.max(0, this.consciousness - sev * 9);
      this.organs.brain.hp = Math.max(0, this.organs.brain.hp - Math.max(0, speed - 9) * 4);
      if (speed > 9) this.log(`Head trauma (${speed.toFixed(0)} m/s)`, 'warn');
    }
    if (dmg > 25 && part.attached) this.wounds.push({ part: partName, pos: null, blunt: true, normal: null, rate: Math.min(3, dmg * 0.03), arterial: false, exit: false, age: 0 });
    return out;
  }

  /**
   * A punch. power ~0.5 (jab) .. 1 (hook). Mostly pain and bruising; head shots can knock the
   * ragdoll out or bloody the nose, and a hard hook can crack a bone.
   * Returns { knockout, fractured, bleed }.
   */
  punch(partName, power) {
    const out = { knockout: false, fractured: false, bleed: false };
    const part = this.parts[partName];
    if (!part.attached && partName !== 'head') { part.tissue = Math.max(0, part.tissue - 6 * power); return out; }
    part.tissue = Math.max(0, part.tissue - 7 * power * this.tissueMul(partName));
    this.rawPain += 7 + 12 * power;
    this.adrenaline = Math.min(1, this.adrenaline + 0.12);
    this.lastHitTime = this.time; this.lastHitPart = partName;
    if (partName === 'head') {
      this.consciousness = Math.max(0, this.consciousness - (8 + 26 * power) * (0.7 + Math.random() * 0.6));
      if (this.consciousness < 30 && !this.knockedOut) { this.knockedOut = true; out.knockout = true; this.log('Knocked out', 'warn'); }
      else this.log(power > 0.8 ? 'Hook to the head' : 'Punched in the face', 'warn');
      if (Math.random() < 0.25 + power * 0.35) {
        out.bleed = true;
        if (!this.noseBleed) {
          this.noseBleed = true;
          this.wounds.push({ part: 'head', pos: new THREE.Vector3(0, -0.02, 0.1), normal: new THREE.Vector3(0, -0.3, 1).normalize(), rate: 0.9, arterial: false, exit: false, age: 0 });
          this.log('Bloody nose', 'warn');
        }
      }
    } else this.log(`Punched (${part.label.toLowerCase()})`, 'info');
    if (power > 0.8 && Math.random() < 0.12) {
      for (const b of ANATOMY[partName].bones) {
        const bone = this.bones[b.id];
        if (bone.fractured || b.spine) continue;
        bone.integrity = Math.max(0, bone.integrity - 50);
        if (bone.integrity < 55) { bone.fractured = true; out.fractured = true; this.rawPain += 20; this.log(`${bone.name} fractured`); }
        break;
      }
    }
    return out;
  }

  /**
   * Explosion blast on one body part. k = 0..1 strength at that part (1 = right on top of it).
   * Returns { fractured, sever, explode } for the caller to act on (if dismemberment is on).
   */
  blast(partName, k, { dismember = true } = {}) {
    const out = { fractured: false, sever: false, explode: false };
    const part = this.parts[partName];
    const anat = ANATOMY[partName];
    const dmg = 95 * k * k + 22 * k;
    part.tissue = Math.max(0, part.tissue - dmg * this.tissueMul(partName));
    if (part.tissue <= 0) part.overkill = (part.overkill || 0) + dmg * 0.5;
    if (part.attached) {
      this.rawPain += 30 * k;
      this.adrenaline = Math.min(1, this.adrenaline + 0.5 * k);
      this.shock = Math.min(100, this.shock + 22 * k);
    }
    for (const b of anat.bones) {
      if (Math.random() > Math.min(0.95, k * 1.5 - 0.15)) continue;
      const bone = this.bones[b.id];
      if (bone.integrity <= 0) continue;
      bone.integrity = Math.max(0, bone.integrity - (40 + 70 * k) * (0.7 + Math.random() * 0.6));
      if (!bone.fractured && bone.integrity < 55) { bone.fractured = true; out.fractured = true; this.log(`${bone.name} fractured (blast)`); }
      if (b.spine && !this.paralyzed && bone.integrity < 35) { this.paralyzed = true; this.log('Spinal cord damaged: legs paralysed'); }
    }
    // the pressure wave hurts air-filled and soft organs most
    for (const og of anat.organs) {
      const organ = this.organs[og.id];
      const mul = /lung/.test(og.id) ? 1.4 : og.id === 'intestines' ? 1.1 : 0.8;
      const was = organ.hp;
      organ.hp = Math.max(0, organ.hp - 85 * k * k * mul * (0.75 + Math.random() * 0.5));
      if (was > 0 && organ.hp <= 0) this.log(`${organ.name} destroyed (blast)`);
      else if (was - organ.hp > 15) this.log(`${organ.name} damaged (blast)`, 'warn');
    }
    if (partName === 'head' && part.attached) {
      this.consciousness = Math.max(0, this.consciousness - 110 * k);
      this.organs.brain.hp = Math.max(0, this.organs.brain.hp - 60 * k * k);
      if (k > 0.18 && !this.eardrums) { this.eardrums = true; this.log('Eardrums ruptured (blast)', 'warn'); }
      if (k > 0.3) this.log('Concussion', 'warn');
    }
    if (k > 0.2 && part.attached) this.wounds.push({ part: partName, pos: null, blunt: true, normal: null, rate: 0.6 + 5 * k * k, arterial: k > 0.65, exit: false, age: 0 });
    if (dismember && !part.exploded) {
      const isTorso = partName === 'chest' || partName === 'abdomen' || partName === 'pelvis';
      const roll = Math.random();
      // limbs closest to the blast are shredded, a little further out they are torn off at the joint
      const light = /hand|foot|lowerArm/.test(partName);
      // k: ~0.85 at 0.5 m, 0.71 at 1 m, 0.59 at 1.5 m, 0.48 at 2 m, 0.29 at 3 m
      if (isTorso) { if (k > 0.84 && roll < 0.7) out.explode = true; }
      else if (partName === 'head') { if (k > 0.76 && roll < 0.75) out.explode = true; }
      else if (k > (light ? 0.68 : 0.78) && roll < 0.75) out.explode = true;
      else if (k > (light ? 0.4 : 0.46) && part.attached && roll < (k - 0.3) * 1.5) out.sever = true;
    }
    return out;
  }

  /**
   * Burn from the fireball / flash heat. k = 0..1 heat at that part. Burns build up per part:
   * first degree (red, painful), second degree (blisters, very painful, leaks fluid) and third
   * degree (charred: the nerves are gone so it hurts less locally, but the tissue is destroyed).
   * Returns the burn degree reached (0..3).
   */
  burn(partName, k) {
    const p = this.parts[partName];
    if (k <= 0.02) return 0;
    const was = p.burn || 0;
    p.burn = clamp(was + k);
    const deg = p.burn > 0.66 ? 3 : p.burn > 0.3 ? 2 : 1;
    const wasDeg = was > 0.66 ? 3 : was > 0.3 ? 2 : was > 0 ? 1 : 0;
    p.tissue = Math.max(0, p.tissue - 16 * k * (deg >= 3 ? 1.5 : 1));
    if (p.attached) {
      this.rawPain += (deg === 3 ? 18 : deg === 2 ? 34 : 16) * k + 4;
      this.shock = Math.min(100, this.shock + 9 * k * deg);
      this.adrenaline = Math.min(1, this.adrenaline + 0.2 * k);
    }
    // plasma leak grows with the burned area (2nd/3rd degree)
    if (deg >= 2) this.burnArea = (this.burnArea || 0) + k * (/chest|abdomen|pelvis|thigh/.test(partName) ? 1.4 : 0.7);
    if (deg > wasDeg) {
      // one fireball burns many parts at once: merge them into one line per degree
      const name = p.label.toLowerCase(), bl = this._burnLog;
      const text = (parts) => `${['', 'First', 'Second', 'Third'][deg]}-degree burns (${parts.slice(0, 2).join(', ')}${parts.length > 2 ? ` +${parts.length - 2} more` : ''})`;
      if (bl && bl.deg === deg && this.time - bl.t < 0.5 && this.events.includes(bl.ev)) { bl.parts.push(name); bl.ev.text = text(bl.parts); }
      else { this.log(text([name]), deg >= 2 ? 'bad' : 'warn'); this._burnLog = { t: this.time, deg, parts: [name], ev: this.events[0] }; }
    }
    if (partName === 'head' && deg >= 2 && !this.eyesBurned && k > 0.35) { this.eyesBurned = true; this.log('Face and eyes burned'); }
    return deg;
  }


  // ---------------------------------------------------------------- Blades
  /**
   * Machete hit. kind 'slash': a long cut across the surface that gets deeper with every hit on
   * the same spot (enough of them chop through a limb or the neck), can cut tendons and vessels
   * near the surface. kind 'stab': a deep, narrow wound along the blade into organs.
   * o = entry point (local), d = direction into the body (local, unit), power 0..1.
   */
  cut(partName, o, d, power, kind = 'slash', { dismember = true } = {}) {
    const def = PART_BY_NAME[partName];
    const part = this.parts[partName];
    const anat = ANATOMY[partName];
    const res = { partName, kind, organs: [], bones: [], vessels: [], dismember: false, opened: false, explode: false, tendon: null, throat: false, exit: false, bleed: 0, pain: 0 };
    const isTorso = partName === 'chest' || partName === 'abdomen' || partName === 'pelvis';
    const span = rayThroughPart(def, o, d) || { tIn: 0, tOut: 0.06 };
    const t0 = span.tIn, path = Math.max(0.02, span.tOut - span.tIn);
    const entry = o.clone().addScaledVector(d, t0);
    let depth = kind === 'stab' ? 0.11 + 0.09 * power : 0.032 + 0.034 * power;
    const throat = partName === 'head' && entry.y < -0.035;
    if (kind === 'slash') {
      part.cutDepth = (part.cutDepth || 0) + depth * (0.75 + Math.random() * 0.5);
      depth = Math.min(part.cutDepth, path);
    }
    const reach = t0 + Math.min(depth, path);

    // Bones stop a stab; a slash nicks or chops them once it is deep enough
    for (const b of anat.bones) {
      const bone = this.bones[b.id];
      let hit;
      if (b.shell) hit = kind === 'stab' ? Math.random() < b.chance * 0.8 : (part.cutDepth || 0) > 0.05 && Math.random() < 0.5;
      else hit = segSegDistance(o, d, t0, reach, b.a, b.b).dist < b.r + 0.008;
      if (!hit) continue;
      const dmg = (kind === 'stab' ? 28 : 34) * power * (0.8 + Math.random() * 0.4);
      bone.integrity = Math.max(0, bone.integrity - dmg);
      res.bones.push(bone);
      if (!bone.fractured && bone.integrity < 55) { bone.fractured = true; this.rawPain += 22; this.log(`${bone.name} ${kind === 'stab' ? 'cracked' : 'chopped'}`); }
      if (b.spine && !this.paralyzed && bone.integrity < 30) { this.paralyzed = true; this.log('Spinal cord cut: legs paralysed'); }
      if (kind === 'stab' && !(b.shell && bone.fractured)) depth *= 0.6; // the blade glances off
    }
    const reach2 = t0 + Math.min(depth, path);

    // Organs the blade reaches
    for (const og of anat.organs) {
      const hit = rayEllipsoid(o, d, og.c, og.r);
      if (!hit || hit[1] < t0 || hit[0] > reach2) continue;
      if (partName === 'head' && !this.bones.skull.fractured) continue;
      const organ = this.organs[og.id];
      const dmg = (kind === 'stab' ? 75 : 40) * power * (0.75 + Math.random() * 0.5);
      const was = organ.hp;
      organ.hp = Math.max(0, organ.hp - dmg);
      res.organs.push(organ);
      res.bleed += og.bleed * (kind === 'stab' ? 1.1 : 0.7);
      this.rawPain += 12;
      if (was > 0 && organ.hp <= 0) this.log(`${organ.name} destroyed`);
      else this.log(`${organ.name} ${kind === 'stab' ? 'stabbed' : 'cut'}`, 'warn');
    }
    // Vessels: a slash cuts the ones close to the surface it crosses, a stab the ones on its line
    for (const v of anat.vessels) {
      const vessel = this.vessels[v.id];
      const near = segSegDistance(o, d, t0, reach2, v.a, v.b).dist < v.r + (kind === 'slash' ? 0.03 : 0.012);
      if (!near) continue;
      res.vessels.push(vessel);
      if (!vessel.cut) { vessel.cut = true; this.log(`${vessel.name} severed`); }
      res.bleed += v.bleed;
    }
    if (throat) {
      res.throat = true;
      if (!this.throatCut) { this.throatCut = true; this.log('Throat cut'); }
      res.bleed += 4;
    }

    // Tendons: wrist / Achilles / hamstring cuts take away the use of the limb below
    if (!isTorso && kind === 'slash' && !part.tendon) {
      const back = entry.z < -0.01;
      let tendon = null;
      if (/lowerArm|hand/.test(partName)) tendon = partName.startsWith('hand') ? 'lowerArm' + partName.slice(-1) : partName;
      else if (/shin|foot/.test(partName) && back) tendon = 'shin' + partName.slice(-1);
      else if (/thigh/.test(partName) && back) tendon = partName;
      if (tendon && Math.random() < 0.45 + power * 0.4) {
        this.parts[tendon].tendon = true;
        res.tendon = tendon;
        const nm = /lowerArm/.test(tendon) ? 'wrist' : /shin/.test(tendon) ? 'Achilles' : 'hamstring';
        this.log(`${nm === 'Achilles' ? 'Achilles' : nm[0].toUpperCase() + nm.slice(1)} tendons cut (${tendon.endsWith('L') ? 'left' : 'right'})`);
      }
    }

    // Tissue, pain, bleeding
    const tissueDmg = (kind === 'stab' ? 22 + 30 * power : 14 + 18 * power) * (0.85 + Math.random() * 0.3);
    if (part.tissue <= 0) part.overkill = (part.overkill || 0) + tissueDmg * 0.5;
    part.tissue = Math.max(0, part.tissue - tissueDmg * this.tissueMul(partName));
    part.hits++;
    res.bleed += kind === 'stab' ? 1.6 + depth * 8 : 1.4 + (part.cutDepth || 0) * 22;
    res.pain = (kind === 'stab' ? 28 : 20) * (0.6 + power * 0.6) * (partName === 'head' ? 1.2 : 1);
    this.rawPain += res.pain;
    this.adrenaline = Math.min(1, this.adrenaline + 0.3);
    this.shock = Math.min(100, this.shock + (kind === 'stab' ? 6 : 3));
    this.lastHitTime = this.time; this.lastHitPart = partName;

    // Through-and-through stab on a thin part
    if (kind === 'stab' && depth > path + 0.01) res.exit = true;

    // Chopped through: limbs come off; the neck after a few deep cuts; the belly opens up
    if (dismember && kind === 'slash') {
      const thick = def.shape === 'sphere' ? 0.13 : Math.min(def.size[0], def.size[2]) * (partName.startsWith('thigh') ? 1.35 : 1.15);
      if (!isTorso && part.attached && (part.cutDepth || 0) >= thick && (partName !== 'head' || throat)) res.dismember = true;
      if (partName === 'abdomen' && !part.opened && (part.cutDepth || 0) > 0.11) { part.opened = true; res.opened = true; this.log('Abdomen cut open: intestines exposed'); }
      if (partName === 'chest' && !part.opened && (part.cutDepth || 0) > 0.16 && this.bones.ribs.fractured) { part.opened = true; res.opened = true; this.log('Chest hacked open'); }
    }
    if (dismember && kind === 'stab' && isTorso && !part.opened && part.hits > 5 && part.tissue / part.maxTissue < 0.3) { part.opened = true; res.opened = true; this.log(`${part.label} torn open`); }

    const n = d.clone().negate();
    const wound = { part: partName, pos: entry.clone(), normal: n, rate: res.bleed, arterial: res.vessels.length > 0 || res.throat || res.organs.some((x) => x.id === 'heart'), exit: false, age: 0, cut: kind };
    this.wounds.push(wound);
    res.wound = wound;
    if (res.exit) {
      const ew = { part: partName, pos: o.clone().addScaledVector(d, span.tOut), normal: d.clone(), rate: 0.6 + res.bleed * 0.3, arterial: wound.arterial, exit: true, age: 0, cut: 'stab' };
      this.wounds.push(ew);
      res.exitWound = ew;
    }
    return res;
  }

  /**
   * A hit that armour stopped: the plate or helmet takes the bullet, the body takes the blow
   * (bruise, pain, sometimes a cracked rib; a helmet hit rings the head). k = 0..1 hit strength.
   */
  blunt(partName, k, { helmet = false } = {}) {
    const out = { fractured: false };
    const part = this.parts[partName];
    part.tissue = Math.max(0, part.tissue - 5 * k * this.tissueMul(partName));
    if (part.attached) { this.rawPain += 6 + 16 * k; this.adrenaline = Math.min(1, this.adrenaline + 0.2); }
    this.lastHitTime = this.time; this.lastHitPart = partName;
    if (helmet) {
      this.consciousness = Math.max(0, this.consciousness - (10 + 30 * k) * (0.7 + Math.random() * 0.6));
      if (k > 0.5) this.log('Helmet hit: dazed', 'warn');
    } else if (Math.random() < k * 0.22) {
      const ribs = this.bones.ribs;
      if (partName === 'chest' && !ribs.fractured) { ribs.integrity = Math.max(0, ribs.integrity - 50); if (ribs.integrity < 55) { ribs.fractured = true; out.fractured = true; this.rawPain += 18; this.log('Rib cracked behind the vest'); } }
    }
    return out;
  }

  // ---------------------------------------------------------------- Treatment
  /**
   * Medkit on one body part: pressure bandage on its wounds, a tourniquet above a stump on it, a
   * splint on its broken bones and a dressing on its burns. Returns what was done.
   */
  treat(partName) {
    const p = this.parts[partName];
    const out = { bandaged: 0, tourniquet: 0, splinted: 0, dressed: false, any: false };
    if (!p.attached && partName !== 'head') return out;
    for (const w of this.wounds) {
      if (w.part !== partName || w.rate < 0.04) continue;
      if (w.stump) { w.rate *= 0.04; w.tourniquet = true; out.tourniquet++; }
      else if (!w.bandaged) { w.rate *= w.arterial ? 0.12 : 0.05; w.bandaged = true; out.bandaged++; }
      else { w.rate *= 0.4; out.bandaged++; }
    }
    for (const b of ANATOMY[partName].bones) {
      const bone = this.bones[b.id];
      if (bone.fractured && !bone.splinted && !b.shell && !b.spine) { bone.splinted = true; out.splinted++; this.rawPain = Math.max(0, this.rawPain - 10); }
    }
    if ((p.burn || 0) > 0.3 && !p.dressed) {
      p.dressed = true; out.dressed = true;
      this.burnArea = Math.max(0, (this.burnArea || 0) - p.burn * (/chest|abdomen|pelvis|thigh/.test(partName) ? 1.4 : 0.7) * 0.6);
    }
    out.any = out.bandaged + out.tourniquet + out.splinted > 0 || out.dressed;
    const name = p.label.toLowerCase();
    if (out.tourniquet) {
      const w = this.wounds.find((x) => x.part === partName && x.tourniquet);
      const child = PARTS.find((d) => d.joint?.name === w?.joint);
      this.log(`Tourniquet above the ${child ? child.label.toLowerCase() : name} stump`, 'good');
    }
    if (out.bandaged) this.log(`Bandaged ${out.bandaged > 1 ? `${out.bandaged} wounds` : 'the wound'} (${name})`, 'good');
    if (out.splinted) this.log(`Splinted the ${name}`, 'good');
    if (out.dressed) this.log(`Burn dressing (${name})`, 'good');
    return out;
  }

  /** What the medkit could do for a part (for the HUD). */
  treatable(partName) {
    const p = this.parts[partName];
    if (!p.attached && partName !== 'head') return [];
    const out = [];
    const ws = this.wounds.filter((w) => w.part === partName && w.rate >= 0.04);
    if (ws.some((w) => w.stump)) out.push('Tourniquet');
    if (ws.some((w) => !w.stump)) out.push('Bandage');
    if (ANATOMY[partName].bones.some((b) => this.bones[b.id].fractured && !this.bones[b.id].splinted && !b.shell && !b.spine)) out.push('Splint');
    if ((p.burn || 0) > 0.3 && !p.dressed) out.push('Burn dressing');
    return out;
  }

  giveMorphine() {
    const was = this.morphine;
    this.morphine = Math.min(2.2, this.morphine + 1);
    if (!this.alive) return;
    this.log(was > 0.6 ? 'Morphine again: too much, breathing slows' : 'Morphine given: pain fades', was > 0.6 ? 'warn' : 'good');
  }

  giveBlood(ml = 750) {
    this.transfusing += ml;
    this.log(`Blood bag (${ml} ml) running in`, 'good');
  }

  /**
   * Defibrillator shock. On a heart that has stopped it can bring the rhythm back if there is
   * enough heart and blood left to pump; on a beating heart it can stop it. Returns
   * { result: 'restarted' | 'failed' | 'arrest' | 'shock' | 'dead', text }.
   */
  defibrillate(partName = 'chest') {
    const onChest = partName === 'chest';
    if (!this.alive || this.decapitated) { this.log('Shock: no response (dead)', 'info'); return { result: 'dead', text: 'No response' }; }
    this.rawPain += this.consciousness > 30 ? 30 : 8;
    this.adrenaline = Math.min(1, this.adrenaline + 0.4);
    this.burn(partName, 0.05);
    if (!onChest) { this.log('Electric shock', 'warn'); return { result: 'shock', text: 'Shock (put the paddles on the chest)' }; }
    if (this.cardiacArrest) {
      this.shocks++;
      const heart = this.organs.heart.hp / 100;
      if (heart < 0.08) { this.log('Shock: no rhythm (heart destroyed)'); return { result: 'failed', text: 'No rhythm: the heart is destroyed' }; }
      if (this.bloodFrac < 0.56) { this.log('Shock: no rhythm (too little blood)'); return { result: 'failed', text: 'No rhythm: too much blood lost. Give a blood bag first' }; }
      const chance = clamp((0.45 + 0.12 * this.shocks) * (1 - this.brainDeath * 0.8) * (heart > 0.5 ? 1 : 0.6), 0.05, 0.92);
      if (Math.random() < chance) {
        this.cardiacArrest = false;
        this.heartRate = 48;
        this.rosc = 0.001;
        this.shocks = 0;
        this.noCirculationTime *= 0.5;
        this.log('Heart restarted (defibrillator)', 'good');
        return { result: 'restarted', text: 'Heart restarted' };
      }
      this.log('Shock delivered: no rhythm yet', 'warn');
      return { result: 'failed', text: 'No rhythm yet. Charge and shock again' };
    }
    // shocking a heart that is still beating can throw it into fibrillation
    this.consciousness = Math.max(0, this.consciousness - 35);
    if (Math.random() < 0.45) {
      this.cardiacArrest = true;
      this.log('Shocked a beating heart: cardiac arrest');
      return { result: 'arrest', text: 'The heart was beating: now it has stopped' };
    }
    this.log('Electric shock to the chest', 'warn');
    return { result: 'shock', text: 'The heart was already beating' };
  }

  // ---------------------------------------------------------------- Capabilities
  partCap(name) {
    const p = this.parts[name];
    if (!p.attached) return 0;
    let c = clamp(0.25 + 0.75 * (p.tissue / p.maxTissue));
    for (const b of ANATOMY[name].bones) {
      const bone = this.bones[b.id];
      // a splint holds a broken bone still: the limb can carry some weight again
      if (bone.fractured) c *= bone.integrity <= 0 ? (bone.splinted ? 0.12 : 0.02) : (bone.splinted ? 0.55 : 0.15);
    }
    if (p.tendon) c *= 0.3;      // cut tendons: the muscle can't pull on the joint below
    return c;
  }
  legCap(s) {
    if (this.paralyzed) return 0;
    const foot = this.parts[`foot${s}`].attached ? 1 : 0.55;
    return Math.min(this.partCap(`thigh${s}`), this.partCap(`shin${s}`)) * foot;
  }
  armCap(s) {
    return Math.min(this.partCap(`upperArm${s}`), this.partCap(`lowerArm${s}`)) * (this.parts[`hand${s}`].attached ? 1 : 0.7);
  }

  get bleedRate() { return this.wounds.reduce((s, w) => s + w.rate * this.pressure(), 0); }
  get bloodFrac() { return this.blood / this.maxBlood; }
  pressure() {
    const vol = clamp(this.blood / this.maxBlood);
    const pump = this.cardiacArrest || !this.alive ? 0.08 : clamp(this.heartRate / 72, 0.4, 1.25);
    return Math.pow(vol, 1.5) * pump;
  }

  // ---------------------------------------------------------------- Simulation
  /** The brain is intact and still on the body (a zombie can stand up again / keep going). */
  get headIntact() {
    const head = this.parts.head;
    return head.attached && !head.exploded && !this.decapitated && this.organs.brain.hp > 0;
  }

  update(dt) {
    if (this.undead) { this.updateUndead(dt); return; }
    this.time += dt;
    const o = this.organs;

    // Bleeding + clotting
    const press = this.pressure();
    let loss = 0;
    for (const w of this.wounds) {
      w.age += dt;
      loss += w.rate * press * dt;
      const tc = w.arterial ? PH.arterialClotTime : PH.clotTime;
      w.rate *= Math.exp(-dt / tc);
    }
    // burns leak plasma (slowly), which counts towards volume loss / shock
    if (this.burnArea > 0) loss += this.burnArea * 0.9 * dt;
    this.blood = Math.max(0, this.blood - loss);
    // blood bag running in (fast, squeezed)
    if (this.transfusing > 0) {
      const give = Math.min(this.transfusing, 70 * dt, Math.max(0, this.maxBlood - this.blood));
      this.blood += give; this.transfusing -= 70 * dt;
      if (this.transfusing <= 0) { this.transfusing = 0; this.log('Blood bag finished', 'good'); }
    }
    // the ragdoll pressing its hand on a wound slows the bleeding
    const pw = this.pressing;
    if (pw && this.alive && this.consciousness > 30 && this.wounds.includes(pw)) {
      pw.rate *= Math.exp(-dt / (pw.arterial ? 22 : 10));
      if (!this.pressLogged && pw.rate > 0.5) { this.pressLogged = true; this.log(`Pressing a hand on the wound (${this.parts[pw.part].label.toLowerCase()})`, 'info'); }
    }
    this.morphine = Math.max(0, this.morphine - dt / 150);
    if (this.rosc > 0) this.rosc += dt;
    const lossFrac = 1 - this.bloodFrac;

    // Lungs / airway
    const lungs = ((o.lungL.hp + o.lungR.hp) / 200);
    const brainHp = o.brain.hp / 100;
    const breathing = this.alive && !this.decapitated && brainHp > 0.05 && this.brainDeath < 1;
    const lungFn = breathing ? clamp(0.15 + 0.85 * lungs, 0, 1) * (lungs < 0.05 ? 0 : 1) : 0;
    const opioid = clamp(this.morphine - 1.1, 0, 1);   // more than one dose slows breathing
    this.breathRate += ((breathing ? (14 + lossFrac * 30 + this.pain * 0.1 - (lungs < 0.5 ? -8 : 0)) * (1 - opioid * 0.7) : 0) - this.breathRate) * clamp(dt * 1.5);

    // Heart
    const heartHp = o.heart.hp / 100;
    if (!this.cardiacArrest && this.alive) {
      if (heartHp <= 0) { this.cardiacArrest = true; this.log('Cardiac arrest: heart destroyed'); }
      else if (lossFrac > 0.45) { this.cardiacArrest = true; this.log('Cardiac arrest: blood loss'); }
      else if (this.o2 < 45 && !(this.rosc > 0 && this.rosc < 14)) { this.cardiacArrest = true; this.log('Cardiac arrest: hypoxia'); }
      else if (this.decapitated && this.time > 0) { /* heart keeps going briefly */ }
    }
    let hrTarget = 0;
    if (!this.cardiacArrest && this.alive) {
      hrTarget = 72 + lossFrac * 220 + this.pain * 0.45 + this.adrenaline * 35 + this.shock * 0.3;
      if (lossFrac > 0.32) hrTarget *= clamp(1 - (lossFrac - 0.32) * 4, 0.35, 1); // decompensation
      hrTarget *= clamp(0.4 + heartHp * 0.6);
      hrTarget = Math.min(hrTarget, 185);
    }
    this.heartRate += (hrTarget - this.heartRate) * clamp(dt * (hrTarget === 0 ? 3 : 0.8));

    // Oxygen
    const circulation = this.cardiacArrest || !this.alive ? 0 : clamp(Math.pow(this.bloodFrac, 1.3) * clamp(this.heartRate / 72, 0.4, 1.2));
    const o2Target = (98 - opioid * 22) * lungFn * (0.35 + 0.65 * circulation) + (1 - lungFn) * 30;
    const o2Rate = o2Target < this.o2 ? (circulation < 0.1 ? 1.6 : 0.6) : 0.5;
    this.o2 += (o2Target - this.o2) * clamp(dt * o2Rate);
    this.o2 = clamp(this.o2, 0, 100);

    // Pain (adrenaline masks it for a while)
    let fracturePain = 0;
    for (const b of Object.values(this.bones)) if (b.fractured && this.parts[b.part].attached) fracturePain += 12;
    this.rawPain = Math.max(0, this.rawPain - dt * (0.7 + this.rawPain * 0.01));
    // damaged tissue keeps hurting
    let tissuePain = 0;
    for (const p of Object.values(this.parts)) if (p.attached) tissuePain += (1 - p.tissue / p.maxTissue) * 22;
    this.adrenaline = Math.max(0, this.adrenaline - dt * 0.03);
    // splinted fractures hurt much less (the bone ends stop grinding)
    let splintRelief = 0;
    for (const b of Object.values(this.bones)) if (b.fractured && b.splinted && this.parts[b.part].attached) splintRelief += 8;
    const felt = (this.rawPain + fracturePain - splintRelief + tissuePain) * (1 - this.adrenaline * 0.4) * (1 - 0.7 * Math.min(1, this.morphine));
    const consciousGate = clamp(this.consciousness / 60);
    this.pain += (clamp(felt, 0, 100) * consciousGate - this.pain) * clamp(dt * 3);

    // Shock (hypovolemic + pain)
    const shockTarget = clamp((lossFrac - 0.12) / 0.3) * 85 + clamp((this.pain - 60) / 40) * 25;
    this.shock += (clamp(shockTarget, 0, 100) - this.shock) * clamp(dt * 0.4);

    // Brain death clock
    const noFlow = circulation < 0.05 || this.decapitated || brainHp <= 0;
    if (noFlow || this.o2 < 40) this.noCirculationTime += dt; else this.noCirculationTime = Math.max(0, this.noCirculationTime - dt * 0.5);
    const deathTime = this.decapitated ? 8 : brainHp <= 0 ? 14 : PH.arrestDeathTime;
    this.brainDeath = clamp(this.noCirculationTime / deathTime);
    if (this.alive && this.brainDeath >= 1) {
      this.alive = false;
      this.cardiacArrest = true;
      this.deathCause = this.decapitated ? 'Decapitation' : brainHp <= 0 ? 'Brain trauma' : lossFrac > 0.4 ? 'Exsanguination' : heartHp <= 0 ? 'Cardiac trauma' : 'Hypoxia';
      this.log(`Dead (${this.deathCause})`);
    }

    // Consciousness
    let cTarget = 100;
    cTarget -= clamp(this.pain - 65, 0, 100) * 1.6;
    cTarget -= clamp(93 - this.o2, 0, 100) * 2.8;
    cTarget -= clamp(lossFrac - 0.2) * 280;
    cTarget -= (1 - brainHp) * 140;
    cTarget -= this.shock * 0.35;
    cTarget -= Math.max(0, this.morphine - 0.6) * 30;   // drowsy on morphine, out cold on too much
    if (this.cardiacArrest || this.decapitated || !this.alive) cTarget = 0;
    if (this.time - this.lastHitTime < 0.4 && this.lastHitPart === 'head') cTarget -= 50;
    cTarget = clamp(cTarget, 0, 100);
    const was = this.consciousness;
    const rate = cTarget < this.consciousness ? 2.2 : 0.12;
    this.consciousness += (cTarget - this.consciousness) * clamp(dt * rate);
    if (was >= 25 && this.consciousness < 25 && this.alive) this.log('Lost consciousness', 'warn');
    if (was < 25 && this.consciousness >= 25 && this.alive) this.log('Regained consciousness', 'info');
    if (this.knockedOut && this.consciousness > 60) this.knockedOut = false;

    // Zombie bite: a fever that takes about a minute, then death (and it rises again)
    if (this.infected && this.alive) {
      const was2 = this.infection;
      this.infection = Math.min(1, this.infection + dt / 55);
      if (was2 < 0.5 && this.infection >= 0.5) this.log('Infection spreading: fever', 'warn');
      if (this.infection > 0.7) this.consciousness = Math.min(this.consciousness, 100 - (this.infection - 0.7) * 260);
      if (this.infection >= 1) {
        this.alive = false; this.cardiacArrest = true; this.brainDeath = 1;
        this.deathCause = 'Infection';
        this.log('Dead (Infection)');
      }
    }
  }

  /** A zombie: no circulation, no pain. It only stops when the brain is destroyed or the head comes off. */
  updateUndead(dt) {
    this.time += dt;
    for (const w of this.wounds) { w.age += dt; w.rate *= Math.exp(-dt / 5); }   // thick, slow ooze
    this.heartRate = 0; this.breathRate = 0; this.o2 = 0;
    this.pain = 0; this.rawPain = 0; this.shock = 0; this.adrenaline = 0;
    this.cardiacArrest = false;
    if (this.alive && !this.headIntact) {
      this.alive = false;
      this.deathCause = this.decapitated || !this.parts.head.attached ? 'Head off' : this.parts.head.exploded ? 'Head destroyed' : 'Brain destroyed';
      this.consciousness = 0;
      this.log(`Put down (${this.deathCause.toLowerCase()})`);
      return;
    }
    // VS Undead: enough damage to the body (bullets, blasts, blades) also puts one down
    // (bodyDeath: how much torso damage it takes, counting the tissue lost and the punishment
    // taken after a part's tissue was already gone)
    if (this.alive && this.bodyDeath) {
      const P = this.parts;
      let dmg = 0;
      for (const n of ['chest', 'abdomen', 'pelvis']) if (P[n]) dmg += (P[n].attached ? P[n].maxTissue - P[n].tissue : P[n].maxTissue) + (P[n].overkill || 0) * (this.bodyResist || 1);
      if (dmg >= this.bodyDeath) {
        this.alive = false;
        this.deathCause = 'Torn apart';
        this.consciousness = 0;
        this.log('Put down (torn apart)');
        return;
      }
    }
    if (!this.alive) { this.consciousness = 0; return; }
    // knocked silly by a big hit, then back on its feet
    this.consciousness += (100 - this.consciousness) * clamp(dt * 0.45);
  }

  // ---------------------------------------------------------------- Readouts
  get stateLabel() {
    if (this.undead) return this.alive ? 'Undead' : 'Put down';
    if (!this.alive) return 'Dead';
    if (this.infected && this.infection > 0.6) return 'Infected (turning)';
    if (this.cardiacArrest) return 'Cardiac arrest';
    if (this.consciousness < 25) return 'Unconscious';
    if (this.consciousness < 55) return 'Semi-conscious';
    if (this.shock > 50) return 'In shock';
    if (this.pain > 65) return 'Severe pain';
    return 'Conscious';
  }
  get shockLabel() {
    const s = this.shock;
    return s < 15 ? 'None' : s < 35 ? 'Class I' : s < 55 ? 'Class II' : s < 75 ? 'Class III' : 'Class IV';
  }
}
