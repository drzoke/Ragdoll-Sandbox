// How bodies, shapes and joints travel between the main thread and the physics worker: plain data
// that can be posted, and rebuilt into cannon-es objects on the other side. Shared by both sides.
import * as CANNON from '../../lib/cannon-es.js';

// Per-body state record: pid, position (3), quaternion (4), velocity (3), angular velocity (3), sleep state
export const STRIDE = 15;

export function writeState(b, out, i) {
  const p = b.position, q = b.quaternion, v = b.velocity, w = b.angularVelocity;
  out[i] = b._pid;
  out[i + 1] = p.x; out[i + 2] = p.y; out[i + 3] = p.z;
  out[i + 4] = q.x; out[i + 5] = q.y; out[i + 6] = q.z; out[i + 7] = q.w;
  out[i + 8] = v.x; out[i + 9] = v.y; out[i + 10] = v.z;
  out[i + 11] = w.x; out[i + 12] = w.y; out[i + 13] = w.z;
  out[i + 14] = b.sleepState;
}

/** Set a body's state from a record (the sleep state is handled by the caller). */
export function readState(b, src, i) {
  b.position.set(src[i + 1], src[i + 2], src[i + 3]);
  b.quaternion.set(src[i + 4], src[i + 5], src[i + 6], src[i + 7]);
  b.velocity.set(src[i + 8], src[i + 9], src[i + 10]);
  b.angularVelocity.set(src[i + 11], src[i + 12], src[i + 13]);
}

const v3 = (v) => [v.x, v.y, v.z];
const q4 = (q) => [q.x, q.y, q.z, q.w];

export function shapeData(shape, offset, orientation) {
  const T = CANNON.Shape.types;
  let d;
  if (shape.type === T.BOX) d = { t: 'box', he: v3(shape.halfExtents) };
  else if (shape.type === T.SPHERE) d = { t: 'sphere', r: shape.radius };
  else if (shape.type === T.PLANE) d = { t: 'plane' };
  else throw new Error(`physics worker: unsupported shape type ${shape.type}`);
  d.off = offset ? v3(offset) : [0, 0, 0];
  d.q = orientation ? q4(orientation) : [0, 0, 0, 1];
  d.cr = shape.collisionResponse;
  return d;
}

export function buildShape(d) {
  let s;
  if (d.t === 'box') s = new CANNON.Box(new CANNON.Vec3(d.he[0], d.he[1], d.he[2]));
  else if (d.t === 'sphere') s = new CANNON.Sphere(d.r);
  else s = new CANNON.Plane();
  s.collisionResponse = d.cr;
  return s;
}

/** The scalar properties the game changes at run time (doors opening change a mask, etc.). */
export const PROPS = ['collisionFilterGroup', 'collisionFilterMask', 'collisionResponse', 'type', 'mass', 'linearDamping', 'angularDamping'];
export const propsOf = (b) => PROPS.map((k) => (typeof b[k] === 'boolean' ? (b[k] ? 1 : 0) : b[k]));

export function bodyData(b) {
  const st = new Float64Array(STRIDE);
  writeState(b, st, 0);
  return {
    pid: b._pid,
    props: propsOf(b),
    mat: b.material ? b.material.name : null,
    fixedRotation: b.fixedRotation, allowSleep: b.allowSleep,
    shapes: b.shapes.map((s, i) => shapeData(s, b.shapeOffsets[i], b.shapeOrientations[i])),
    state: st,
    collide: !!b._reportCollide, contacts: !!b.reportContacts,
  };
}

export function setProps(b, props) {
  const massBefore = b.mass, typeBefore = b.type;
  PROPS.forEach((k, i) => { b[k] = k === 'collisionResponse' ? !!props[i] : props[i]; });
  if (b.mass !== massBefore || b.type !== typeBefore) b.updateMassProperties();
}

export function buildBody(d, materials) {
  const [group, mask, cr, type, mass, ld, ad] = d.props;
  const b = new CANNON.Body({
    mass, type, material: d.mat ? materials[d.mat] || null : null,
    collisionFilterGroup: group, collisionFilterMask: mask, linearDamping: ld, angularDamping: ad,
    fixedRotation: d.fixedRotation, allowSleep: d.allowSleep,
  });
  b.collisionResponse = !!cr;
  for (const s of d.shapes) b.addShape(buildShape(s), new CANNON.Vec3(...s.off), new CANNON.Quaternion(...s.q));
  readState(b, d.state, 0);
  b.sleepState = d.state[14];
  b.previousPosition.copy(b.position);
  b.interpolatedPosition.copy(b.position);
  b.aabbNeedsUpdate = true;
  b._pid = d.pid;
  return b;
}

export function constraintData(c) {
  const d = {
    cid: c._cid, a: c.bodyA._pid, b: c.bodyB._pid,
    pivotA: v3(c.pivotA), pivotB: v3(c.pivotB),
    maxForce: c.equations[0].maxForce,
    cc: c.collideConnected, skip: !!c.skipCollide,
  };
  if (c instanceof CANNON.ConeTwistConstraint) Object.assign(d, { kind: 'cone', axisA: v3(c.axisA), axisB: v3(c.axisB), angle: c.angle, twist: c.twistAngle });
  else if (c instanceof CANNON.PointToPointConstraint) d.kind = 'p2p';
  else throw new Error('physics worker: unsupported constraint');
  return d;
}

export function buildConstraint(d, A, B) {
  const V = (a) => new CANNON.Vec3(a[0], a[1], a[2]);
  let c;
  if (d.kind === 'cone') {
    c = new CANNON.ConeTwistConstraint(A, B, {
      pivotA: V(d.pivotA), pivotB: V(d.pivotB), axisA: V(d.axisA), axisB: V(d.axisB),
      angle: d.angle, twistAngle: d.twist, collideConnected: d.cc, maxForce: d.maxForce,
    });
  } else {
    c = new CANNON.PointToPointConstraint(A, V(d.pivotA), B, V(d.pivotB), d.maxForce);
    c.collideConnected = d.cc;
  }
  c.skipCollide = d.skip;
  c._cid = d.cid;
  return c;
}
