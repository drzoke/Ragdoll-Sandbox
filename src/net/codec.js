// Turning game objects into network data and back.
//
//  - encode()/decode(): arguments of the calls the host's game makes that friends replay (a bullet
//    wound, a blood spray, a severed arm). Ragdolls go by their network id, wounds, organs and
//    bones by where they sit in that ragdoll's Health, vectors as arrays, materials by name.
//  - healthSections()/applyHealth(): a ragdoll's Health (pure data) in a few sections, so only the
//    sections that changed are sent again.
//  - Writer/Reader: little binary buffers for the many-times-a-second position updates.
import * as THREE from 'three';
import { Health } from '../ragdoll/health.js';

// ------------------------------------------------------------------ call arguments
const MATERIALS = new Map();      // name -> material
const MATERIAL_NAMES = new Map(); // material -> name
/** Materials that may appear in replayed calls (gib and organ materials). */
export function registerMaterials(obj, prefix = '') {
  for (const [k, m] of Object.entries(obj)) { MATERIALS.set(prefix + k, m); MATERIAL_NAMES.set(m, prefix + k); }
}

const isRagdoll = (o) => o && typeof o === 'object' && o.parts && o.health && o.root && 'netId' in o;

/** Encode a list of call arguments (host side). ctx: the ragdoll they're about, if any. */
export function encode(args) {
  const ctx = args.find(isRagdoll) || null;
  return args.map((a) => enc(a, ctx, 0));
}

function enc(v, ctx, depth) {
  if (v === null || v === undefined) return null;
  const t = typeof v;
  if (t === 'number') return Number.isFinite(v) ? Math.round(v * 1e5) / 1e5 : 0;
  if (t === 'string' || t === 'boolean') return v;
  if (t !== 'object') return null;
  if (v.isVector3) return { $v: [r5(v.x), r5(v.y), r5(v.z)] };
  if (v.isQuaternion) return { $q: [r5(v.x), r5(v.y), r5(v.z), r5(v.w)] };
  if (v.isMaterial) return { $m: MATERIAL_NAMES.get(v) || null };
  if (isRagdoll(v)) return { $r: v.netId };
  if (ctx) {
    const h = ctx.health;
    const wi = h.wounds.indexOf(v);
    if (wi >= 0) return { $w: wi, d: woundData(v) };
    if (v.id && h.organs[v.id] === v) return { $o: v.id };
    if (v.id && h.bones[v.id] === v) return { $b: v.id };
    if (v.id && h.vessels[v.id] === v) return { $vs: v.id };
  }
  if (depth > 3) return null;
  if (Array.isArray(v)) return v.map((x) => enc(x, ctx, depth + 1));
  if (v instanceof Map || v instanceof Set || v.isObject3D) return null;
  const o = {};
  for (const k of Object.keys(v)) {
    if (k[0] === '_' || typeof v[k] === 'function') continue;
    o[k] = enc(v[k], ctx, depth + 1);
  }
  return o;
}
const r5 = (x) => Math.round(x * 1e5) / 1e5;

/** Decode call arguments (friend's side). ragdollById(id) finds the local copy. */
export function decode(args, ragdollById) {
  const ctxId = args.find((a) => a && a.$r !== undefined)?.$r;
  const ctx = ctxId !== undefined ? ragdollById(ctxId) : null;
  return args.map((a) => dec(a, ctx, ragdollById));
}

function dec(v, ctx, byId) {
  if (v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map((x) => dec(x, ctx, byId));
  if (v.$v) return new THREE.Vector3(v.$v[0], v.$v[1], v.$v[2]);
  if (v.$q) return new THREE.Quaternion(v.$q[0], v.$q[1], v.$q[2], v.$q[3]);
  if ('$m' in v) return MATERIALS.get(v.$m) || MATERIALS.get('meat') || null;
  if ('$r' in v) return byId(v.$r) || null;
  if ('$w' in v) return ctx ? woundAt(ctx.health, v.$w, v.d) : woundFrom(v.d);
  if ('$o' in v) return ctx?.health.organs[v.$o] || { id: v.$o, hp: 0 };
  if ('$b' in v) return ctx?.health.bones[v.$b] || { id: v.$b };
  if ('$vs' in v) return ctx?.health.vessels[v.$vs] || { id: v.$vs };
  const o = {};
  for (const k of Object.keys(v)) o[k] = dec(v[k], ctx, byId);
  return o;
}

// ------------------------------------------------------------------ wounds
// Wounds are only ever added to a Health's list, never taken out, so a wound's place in the list is
// its identity on every computer. Gore keeps its decals by wound object, so the friend's copy keeps
// the same object at each place and only updates what's in it.
const WOUND_SKIP = new Set(['age', 'acc', 'spurt']);   // ticking or drawing-only: not sent
export function woundData(w) {
  const d = {};
  for (const k of Object.keys(w)) {
    if (WOUND_SKIP.has(k)) continue;
    const x = w[k];
    if (x && x.isVector3) d[k] = [r5(x.x), r5(x.y), r5(x.z)];
    else if (typeof x === 'number') d[k] = Math.round(x * 1000) / 1000;
    else if (x === null || typeof x === 'string' || typeof x === 'boolean') d[k] = x;
  }
  return d;
}
function setWound(w, d) {
  for (const k of Object.keys(d)) {
    const x = d[k];
    if (Array.isArray(x) && x.length === 3) {
      if (w[k] && w[k].isVector3) w[k].set(x[0], x[1], x[2]); else w[k] = new THREE.Vector3(x[0], x[1], x[2]);
    } else w[k] = x;
  }
  return w;
}
const woundFrom = (d) => setWound({ age: 0 }, d || {});
/** The wound at index i of h.wounds, made (with any missing before it) if needed, filled from d. */
export function woundAt(h, i, d) {
  while (h.wounds.length <= i) h.wounds.push({ part: d?.part || 'chest', pos: null, normal: null, rate: 0, arterial: false, exit: false, age: 0 });
  const w = h.wounds[i];
  if (d) setWound(w, d);
  return w;
}

// ------------------------------------------------------------------ health
const PRISTINE = new Health();
const ENTRIES = ['parts', 'bones', 'organs', 'vessels'];
const SECTION_OF = { parts: 'p', bones: 'b', organs: 'o', vessels: 'vs' };
const round = (x) => (Math.abs(x) >= 100 ? Math.round(x) : Math.abs(x) >= 1 ? Math.round(x * 100) / 100 : Math.round(x * 1000) / 1000);

/**
 * A Health as sections of plain data: v (vitals and flags), p/b/o/vs (body parts, bones, organs,
 * vessels: only what differs from an unhurt body), w (wounds), e (event log).
 */
export function healthSections(h) {
  const out = {};
  const v = {};
  for (const k of Object.keys(h)) {
    const x = h[k];
    if (typeof x === 'number') v[k] = round(x);
    else if (typeof x === 'boolean' || typeof x === 'string') v[k] = x;
  }
  v.pressing = h.pressing ? h.wounds.indexOf(h.pressing) : -1;
  out.v = v;
  for (const name of ENTRIES) {
    const src = h[name], base = PRISTINE[name], sec = {};
    for (const id of Object.keys(src)) {
      const e = src[id], b = base[id];
      let d = null;
      for (const f of Object.keys(e)) {
        const x = e[f];
        if (typeof x !== 'number' && typeof x !== 'boolean' && typeof x !== 'string') continue;
        if (b && b[f] === x) continue;
        (d ??= {})[f] = typeof x === 'number' ? round(x) : x;
      }
      if (d) sec[id] = d;
    }
    out[SECTION_OF[name]] = sec;
  }
  out.w = h.wounds.map(woundData);
  out.e = h.events.map((e) => [round(e.t), e.text, e.severity]);
  return out;
}

/** Put received sections into a Health (friend's side). Missing entries mean "as unhurt". */
export function applyHealth(h, s) {
  if (s.v) {
    for (const k of Object.keys(s.v)) if (k !== 'pressing') h[k] = s.v[k];
    if ('pressing' in s.v) h.pressing = s.v.pressing >= 0 ? woundAt(h, s.v.pressing) : null;
  }
  for (const name of ENTRIES) {
    const sec = s[SECTION_OF[name]];
    if (!sec) continue;
    const dst = h[name], base = PRISTINE[name];
    for (const id of Object.keys(dst)) {
      const e = dst[id], b = base[id], d = sec[id];
      for (const f of Object.keys(e)) {
        const x = e[f];
        if (typeof x !== 'number' && typeof x !== 'boolean' && typeof x !== 'string') continue;
        e[f] = d && f in d ? d[f] : b ? b[f] : x;
      }
      if (d) for (const f of Object.keys(d)) if (!(f in e)) e[f] = d[f];
    }
  }
  if (s.w) for (let i = 0; i < s.w.length; i++) woundAt(h, i, s.w[i]);
  if (s.e) h.events = s.e.map(([t, text, severity]) => ({ t, text, severity }));
}

// ------------------------------------------------------------------ binary
export class Writer {
  constructor(size = 4096) { this.buf = new ArrayBuffer(size); this.dv = new DataView(this.buf); this.o = 0; }
  need(n) {
    if (this.o + n <= this.buf.byteLength) return;
    let size = this.buf.byteLength * 2;
    while (size < this.o + n) size *= 2;
    const nb = new ArrayBuffer(size);
    new Uint8Array(nb).set(new Uint8Array(this.buf, 0, this.o));
    this.buf = nb; this.dv = new DataView(nb);
  }
  u8(x) { this.need(1); this.dv.setUint8(this.o, x); this.o += 1; }
  u16(x) { this.need(2); this.dv.setUint16(this.o, x, true); this.o += 2; }
  u32(x) { this.need(4); this.dv.setUint32(this.o, x >>> 0, true); this.o += 4; }
  i16(x) { this.need(2); this.dv.setInt16(this.o, Math.max(-32767, Math.min(32767, Math.round(x))), true); this.o += 2; }
  f32(x) { this.need(4); this.dv.setFloat32(this.o, x, true); this.o += 4; }
  f64(x) { this.need(8); this.dv.setFloat64(this.o, x, true); this.o += 8; }
  /** Unit quaternion in 8 bytes. */
  quat(q) { const s = q.w < 0 ? -32767 : 32767; this.i16(q.x * s); this.i16(q.y * s); this.i16(q.z * s); this.i16(q.w * s); }
  /** The bytes written so far (a copy, safe to send). */
  done() { return this.buf.slice(0, this.o); }
}

export class Reader {
  constructor(buf) { this.dv = new DataView(buf); this.o = 0; this.end = buf.byteLength; }
  get left() { return this.end - this.o; }
  u8() { const x = this.dv.getUint8(this.o); this.o += 1; return x; }
  u16() { const x = this.dv.getUint16(this.o, true); this.o += 2; return x; }
  u32() { const x = this.dv.getUint32(this.o, true); this.o += 4; return x; }
  i16() { const x = this.dv.getInt16(this.o, true); this.o += 2; return x; }
  f32() { const x = this.dv.getFloat32(this.o, true); this.o += 4; return x; }
  f64() { const x = this.dv.getFloat64(this.o, true); this.o += 8; return x; }
  /** Into out[i..i+3] (x, y, z, w), normalized. */
  quat(out, i) {
    let x = this.i16() / 32767, y = this.i16() / 32767, z = this.i16() / 32767, w = this.i16() / 32767;
    const l = Math.hypot(x, y, z, w) || 1;
    out[i] = x / l; out[i + 1] = y / l; out[i + 2] = z / l; out[i + 3] = w / l;
  }
}
