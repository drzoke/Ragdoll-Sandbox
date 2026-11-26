import { ANATOMY } from './anatomy.js';
import { PARTS, PART_BY_NAME, descendants } from './skeleton.js';
import { CONFIG } from '../config.js';
import { clamp, rayEllipsoid, segSegDistance } from '../core/util.js';

const PH = CONFIG.physiology;

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
    this.lastHitTime = -99;
    this.lastHitPart = null;
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
  bulletHit(partName, o, d, energy) {
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
    part.tissue = Math.max(0, part.tissue - tissueDmg);
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
    const canSever = !isTorso;
    const boneGone = anat.bones.some((b) => this.bones[b.id].integrity <= 0);
    if (canSever && part.attached && (part.tissue <= 0 || (boneGone && frac < 0.35))) {
      res.dismember = true;
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
  sever(partName) {
    const list = [partName, ...descendants(partName)];
    for (const n of list) this.parts[n].attached = false;
    const p = this.parts[partName];
    this.log(`${p.label} severed`);
    this.rawPain += partName === 'head' ? 0 : 45;
    const big = partName.startsWith('thigh') ? 26 : partName.startsWith('upperArm') ? 12 : partName === 'head' ? 40 : 6;
    // Stump wound on the parent: heavy arterial bleed.
    this.wounds.push({ part: PART_BY_NAME[partName].parent, pos: null, joint: PART_BY_NAME[partName].joint.name, normal: null, rate: big, arterial: true, stump: true, exit: false, age: 0 });
    if (partName === 'head') { this.decapitated = true; this.log('Decapitated'); }
    return list;
  }

  /** Blunt trauma from impacts (falls, being thrown into things). */
  impact(partName, speed) {
    if (speed < 6) return;
    const dmg = (speed - 6) * 6;
    const part = this.parts[partName];
    part.tissue = Math.max(0, part.tissue - dmg * 0.3);
    this.rawPain += dmg * 0.4;
    if (partName === 'head') this.consciousness -= dmg * 1.5;
  }

  // ---------------------------------------------------------------- Capabilities
  partCap(name) {
    const p = this.parts[name];
    if (!p.attached) return 0;
    let c = clamp(0.25 + 0.75 * (p.tissue / p.maxTissue));
    for (const b of ANATOMY[name].bones) if (this.bones[b.id].fractured) c *= this.bones[b.id].integrity <= 0 ? 0.02 : 0.15;
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
  update(dt) {
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
    this.blood = Math.max(0, this.blood - loss);
    const lossFrac = 1 - this.bloodFrac;

    // Lungs / airway
    const lungs = ((o.lungL.hp + o.lungR.hp) / 200);
    const brainHp = o.brain.hp / 100;
    const breathing = this.alive && !this.decapitated && brainHp > 0.05 && this.brainDeath < 1;
    const lungFn = breathing ? clamp(0.15 + 0.85 * lungs, 0, 1) * (lungs < 0.05 ? 0 : 1) : 0;
    this.breathRate += ((breathing ? 14 + lossFrac * 30 + this.pain * 0.1 - (lungs < 0.5 ? -8 : 0) : 0) - this.breathRate) * clamp(dt * 1.5);

    // Heart
    const heartHp = o.heart.hp / 100;
    if (!this.cardiacArrest && this.alive) {
      if (heartHp <= 0) { this.cardiacArrest = true; this.log('Cardiac arrest: heart destroyed'); }
      else if (lossFrac > 0.45) { this.cardiacArrest = true; this.log('Cardiac arrest: blood loss'); }
      else if (this.o2 < 45) { this.cardiacArrest = true; this.log('Cardiac arrest: hypoxia'); }
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
    const o2Target = 98 * lungFn * (0.35 + 0.65 * circulation) + (1 - lungFn) * 30;
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
    const felt = (this.rawPain + fracturePain + tissuePain) * (1 - this.adrenaline * 0.4);
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
    if (this.cardiacArrest || this.decapitated || !this.alive) cTarget = 0;
    if (this.time - this.lastHitTime < 0.4 && this.lastHitPart === 'head') cTarget -= 50;
    cTarget = clamp(cTarget, 0, 100);
    const was = this.consciousness;
    const rate = cTarget < this.consciousness ? 2.2 : 0.12;
    this.consciousness += (cTarget - this.consciousness) * clamp(dt * rate);
    if (was >= 25 && this.consciousness < 25 && this.alive) this.log('Lost consciousness', 'warn');
    if (was < 25 && this.consciousness >= 25 && this.alive) this.log('Regained consciousness', 'info');
  }

  // ---------------------------------------------------------------- Readouts
  get stateLabel() {
    if (!this.alive) return 'Dead';
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
