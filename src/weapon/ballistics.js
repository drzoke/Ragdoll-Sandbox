import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { CONFIG } from '../config.js';
import { settings } from '../settings.js';
import { clamp } from '../core/util.js';

const W = CONFIG.weapon;
const _dir = new THREE.Vector3();

// Tracer streak: bright head fading to a transparent tail (uv.y runs tail -> head).
const tracerMat = new THREE.ShaderMaterial({
  uniforms: { color: { value: new THREE.Color(1.0, 0.62, 0.22) } },
  vertexShader: /* glsl */`varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: /* glsl */`uniform vec3 color; varying vec2 vUv;
    void main() { float a = pow(vUv.y, 1.4); vec3 c = mix(color, vec3(1.0, 0.97, 0.85), a * a); gl_FragColor = vec4(c, a * 0.95); }`,
  transparent: true, depthWrite: false,
});
// soft glow around the slug (so a bullet is visible in slow motion)
const glowTex = (() => {
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const g = c.getContext('2d'); const grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grd.addColorStop(0, 'rgba(255,240,200,1)'); grd.addColorStop(0.25, 'rgba(255,170,70,0.75)'); grd.addColorStop(1, 'rgba(255,120,20,0)');
  g.fillStyle = grd; g.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
})();
const glowMat = new THREE.SpriteMaterial({ map: glowTex, transparent: true, depthWrite: false, fog: false });
const tracerGeo = new THREE.CylinderGeometry(0.008, 0.0025, 1, 6, 1, true).translate(0, -0.5, 0); // head at origin, tail at -Y
const slugGeo = new THREE.CapsuleGeometry(0.0075, 0.012, 3, 8);
const slugMat = new THREE.MeshStandardMaterial({ color: 0xb87333, metalness: 0.9, roughness: 0.3, emissive: 0x331100 });
const UP = new THREE.Vector3(0, 1, 0);

/**
 * Bullets are real projectiles (≈260 m/s, .45 ACP): they travel, drop a little, can be watched in
 * slow motion, and resolve hits along each frame's path segment, including penetration through
 * several body parts.
 */
export class Ballistics {
  constructor({ scene, ragdolls, gore, map, buttons, audio, hud }) {
    this.scene = scene;
    this.ragdolls = ragdolls; this.gore = gore; this.map = map; this.buttons = buttons; this.audio = audio; this.hud = hud;
    this.raycaster = new THREE.Raycaster();
    this.lastTarget = null;
    this.bullets = [];
    this.speed = 260;
  }

  targets() {
    return [
      ...this.ragdolls.meshes(),
      ...this.map.solidMeshes,
      ...this.buttons.flatMap((b) => b.meshes),
      ...this.gore.gibs.map((g) => g.mesh),
      ...(this.explosives ? this.explosives.meshes() : []),
    ];
  }

  /**
   * Fire a projectile from origin along dir. visualFrom = muzzle position for the tracer start.
   * opts: energy (0..1, penetration and damage), impulse (push on the body part), size (visual
   * scale), speed (m/s), pellet (shotgun pellet: blows blood out of the far side), shot (shared
   * object for all pellets of one shot), range, life (s).
   */
  fire(origin, dir, visualFrom, opts = {}) {
    const { energy = 1, impulse = W.impulse, size = 1, speed = this.speed, pellet = false, fragment = false, shot = null, range = W.range, life = 1.5, glowSize = 0.075 } = opts;
    const tracer = new THREE.Mesh(tracerGeo, tracerMat);
    tracer.frustumCulled = false;
    const slug = new THREE.Mesh(slugGeo, slugMat);
    tracer.add(slug);
    const glow = new THREE.Sprite(glowMat);
    glow.scale.setScalar(glowSize);
    slug.add(glow);
    tracer.userData.width = size;
    this.scene.add(tracer);
    this.bullets.push({
      pos: origin.clone(), vel: dir.clone().multiplyScalar(speed), energy, impulse, pellet, fragment, shot, range, life, size, traveled: 0, age: 0, bloody: 0,
      skip: new Set(), offset: visualFrom ? visualFrom.clone().sub(origin) : new THREE.Vector3(), tracer, slug, dead: false,
    });
  }

  /** Avoid stacking a dozen identical sounds in one frame (shotgun pellets, shrapnel). */
  sound(name) {
    const now = performance.now();
    this.soundT = this.soundT || {};
    if (now - (this.soundT[name] || 0) < 25) return;
    this.soundT[name] = now;
    this.audio.play(name);
  }

  /** dt = world (time-scaled) seconds, realDt = wall-clock seconds (for streak length). */
  update(dt, realDt) {
    for (const b of this.bullets) {
      if (b.dead) continue;
      b.age += dt;
      b.lastDt = dt;
      b.vel.y -= 9.81 * dt;
      let remaining = b.vel.length() * dt;
      let guard = 0;
      while (remaining > 1e-5 && !b.dead && guard++ < 6) {
        _dir.copy(b.vel).normalize();
        this.raycaster.set(b.pos, _dir);
        this.raycaster.far = remaining;
        const hit = this.raycaster.intersectObjects(this.targets(), false).find((h) => !b.skip.has(h.object));
        if (!hit) { b.pos.addScaledVector(_dir, remaining); b.traveled += remaining; break; }
        b.pos.copy(hit.point);
        b.traveled += hit.distance;
        remaining -= hit.distance;
        const exit = this.processHit(b, hit, _dir.clone());
        if (!exit) { b.dead = true; break; }
        // penetrated: continue from the exit point with what energy is left
        remaining = Math.max(0, remaining - exit.distanceTo(b.pos));
        b.pos.copy(exit);
        b.vel.multiplyScalar(Math.sqrt(Math.max(0.05, b.energy)));
      }
      if (b.age > b.life || b.traveled > b.range) b.dead = true;
      this.updateVisual(b, realDt);
    }
    for (const b of this.bullets) if (b.dead) this.scene.remove(b.tracer);
    this.bullets = this.bullets.filter((b) => !b.dead);
  }

  updateVisual(b, realDt) {
    // Tracer starts at the muzzle and converges onto the true path over the first few metres.
    const fade = Math.max(0, 1 - b.traveled / 6);
    const head = b.pos.clone().addScaledVector(b.offset, fade);
    const speed = b.vel.length();
    // Streak = motion blur over one world-time frame: long at full speed, a short glowing
    // trail behind the visible slug in slow motion.
    const len = Math.min(b.traveled + 0.01, Math.max(0.14, speed * Math.max(b.lastDt, 1 / 2000) * 0.7), 3);
    b.tracer.position.copy(head);
    b.tracer.quaternion.setFromUnitVectors(UP, _dir.copy(b.vel).normalize());
    const wd = b.size;
    b.tracer.scale.set(wd, len, wd);
    b.slug.scale.set(1, 1 / len, 1); // keep the bullet itself real-size
    b.slug.position.set(0, 0, 0);
  }

  /**
   * A shotgun up close puts most of its pellets into one spot: the wound is one big hole rather
   * than eight small ones. When 4+ pellets of one shot land on the same part from under ~4.5 m,
   * a hand, foot or head is blown apart, an arm or leg is torn off, and the torso is opened up.
   */
  pointBlank(r, partName, part, shot, res) {
    const parts = shot.parts || (shot.parts = new Map());
    const n = (parts.get(part) || 0) + 1;
    parts.set(part, n);
    if (n !== 4 || res.explode) return;
    const h = r.health, hp = h.parts[partName];
    const torso = /chest|abdomen|pelvis/.test(partName);
    h.log(`Point-blank shotgun wound (${hp.label.toLowerCase()})`);
    h.shock = Math.min(100, (h.shock || 0) + 18);
    if (!settings.get('dismemberment')) { if (res.wound) { res.wound.rate += 3; res.wound.arterial = true; } return; }
    if (torso) {
      if (res.wound) { res.wound.rate += 7; res.wound.arterial = true; }
      if (!hp.opened && res.wound) { hp.opened = true; res.opened = true; }
      hp.overkill = (hp.overkill || 0) + 18;
    } else if (partName === 'head' || /hand|foot/.test(partName) || !hp.attached) {
      res.explode = true;
    } else {
      res.dismember = true;
    }
  }

  /** Apply a hit. Returns the exit point if the bullet keeps going, otherwise null. */
  processHit(b, hit, dir) {
    const obj = hit.object;
    const ud = obj.userData;
    if (ud.ragdoll) {
      const r = ud.ragdoll;
      const partName = ud.part;
      const part = r.parts[partName];
      if (!part || part.removed) return null;
      // shotgun pellets and shrapnel shed speed quickly: full power up close, weak at range
      if ((b.pellet || b.fragment) && !b.slowed) {
        b.slowed = true;
        b.energy *= b.pellet ? clamp(1.15 - b.traveled / 30, 0.3, 1.15) : clamp(1.1 - b.traveled / 22, 0.35, 1.1);
      }
      const energy = b.energy;
      const inv = part.group.quaternion.clone().invert();
      const localEntry = hit.point.clone().sub(part.group.position).applyQuaternion(inv);
      const localDir = dir.clone().applyQuaternion(inv);
      const res = r.health.bulletHit(partName, localEntry, localDir, energy, { dismember: settings.get('dismemberment') });
      if (b.pellet && b.shot && b.traveled < 4.5) this.pointBlank(r, partName, part, b.shot, res);
      r.hitImpulse(partName, hit.point, dir, b.impulse * energy);
      this.gore.bulletWound(r, res, hit.point, dir);
      if (b.pellet) {
        this.gore.pelletSpatter(r, partName, hit.point, dir);
        // several pellets into the body at once knock the ragdoll off its feet
        if (b.shot) {
          const n = (b.shot.hits.get(r) || 0) + 1;
          b.shot.hits.set(r, n);
          if (n === 4 && r.brain.state === 'stand') r.brain.fall();
        }
      }
      b.bloody = 1;
      this.sound(res.bones.length ? 'bone' : 'flesh');
      if (b.size >= 0.9 || b.pellet) this.hud.hitMarker(res.organs.length > 0 || res.vessels.length > 0);
      this.lastTarget = r;
      if (res.explode) {
        this.gore.explodePart(r, partName, dir);
        return null;
      }
      if (res.opened) this.gore.openPart(r, partName, res.wound);
      if (res.dismember && r.sever(partName).length) {
        this.gore.onSever(r, partName);
        part.body.applyImpulse(new CANNON.Vec3(dir.x * 6, dir.y * 6 + 2, dir.z * 6));
      }
      if (!res.exit) return null;
      b.energy = res.energyOut;
      b.skip.add(part.mesh); if (part.ball) b.skip.add(part.ball);
      const exitLocal = localEntry.clone().addScaledVector(localDir, res.exitT + 0.005);
      return exitLocal.applyQuaternion(part.group.quaternion).add(part.group.position);
    }
    if (ud.grenade) {
      // a bullet sets off a live grenade
      this.sound('clink');
      this.explosives?.detonate(ud.grenade);
      return null;
    }
    if (ud.button) { ud.button.press(); this.sound('concrete'); return null; }
    if (ud.gib) {
      const gb = ud.gib.body;
      gb.applyImpulse(new CANNON.Vec3(dir.x * 1.5, dir.y * 1.5 + 0.5, dir.z * 1.5));
      this.gore.spray(hit.point, dir, 10, { speed: 2 });
      b.bloody = 1;
      return null;
    }
    const n = hit.face ? hit.face.normal.clone().transformDirection(obj.matrixWorld) : new THREE.Vector3(0, 1, 0);
    this.gore.bulletImpactWorld(hit.point, n);
    if (b.bloody) this.gore.bloodyImpactWorld(hit.point, n, dir, b.pellet ? 0.6 : 1);
    this.sound('concrete');
    return null;
  }

  clear() { for (const b of this.bullets) this.scene.remove(b.tracer); this.bullets = []; }
}
