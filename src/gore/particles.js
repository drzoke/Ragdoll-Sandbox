import * as THREE from 'three';

// GPU point particles with CPU integration. Used for blood droplets and impact dust.
// Each particle: position, velocity, life, size, colour, kind (0 = blood -> makes splats when it lands, 1 = dust).
export class Particles {
  constructor(scene, max, colliders) {
    this.max = max;
    this.colliders = colliders;
    this.pos = new Float32Array(max * 3);
    this.vel = new Float32Array(max * 3);
    this.col = new Float32Array(max * 3);
    this.size = new Float32Array(max);
    this.alpha = new Float32Array(max);
    this.life = new Float32Array(max);
    this.kind = new Uint8Array(max);
    this.vol = new Float32Array(max);
    this.free = [];
    for (let i = max - 1; i >= 0; i--) this.free.push(i);
    this.alive = new Set();
    this.onLand = null;
    this.spawnScale = 1; // < 1 on the Low graphics preset // (x, y, z, volume, size) for blood

    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('color', new THREE.BufferAttribute(this.col, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('size', new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('alpha', new THREE.BufferAttribute(this.alpha, 1).setUsage(THREE.DynamicDrawUsage));
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e5);
    this.material = new THREE.ShaderMaterial({
      uniforms: { scale: { value: 500 } },
      vertexShader: /* glsl */`
        attribute float size; attribute float alpha; attribute vec3 color;
        uniform float scale; varying vec3 vColor; varying float vAlpha;
        void main() {
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * mv;
          gl_PointSize = max(1.5, size * scale / -mv.z);
          vColor = color; vAlpha = alpha;
        }`,
      fragmentShader: /* glsl */`
        varying vec3 vColor; varying float vAlpha;
        void main() {
          vec2 c = gl_PointCoord - 0.5; float d = length(c);
          if (d > 0.5) discard;
          float a = smoothstep(0.5, 0.3, d) * vAlpha;
          vec3 col = vColor * (1.0 + 0.35 * smoothstep(0.25, 0.0, length(c - vec2(-0.12, -0.12))));
          gl_FragColor = vec4(col, a);
        }`,
      transparent: true, depthWrite: false,
    });
    this.points = new THREE.Points(g, this.material);
    this.points.frustumCulled = false;
    scene.add(this.points);
    this.geometry = g;
  }

  spawn(x, y, z, vx, vy, vz, { size = 0.02, life = 3, color = [0.42, 0.02, 0.02], kind = 0, volume = 1 } = {}) {
    if (this.spawnScale < 1 && kind === 0) {
      if (Math.random() > this.spawnScale) return;
      volume /= this.spawnScale; size *= 1.2;
    }
    const i = this.free.pop();
    if (i === undefined) return;
    const i3 = i * 3;
    this.pos[i3] = x; this.pos[i3 + 1] = y; this.pos[i3 + 2] = z;
    this.vel[i3] = vx; this.vel[i3 + 1] = vy; this.vel[i3 + 2] = vz;
    this.col[i3] = color[0]; this.col[i3 + 1] = color[1]; this.col[i3 + 2] = color[2];
    this.size[i] = size; this.alpha[i] = 1; this.life[i] = life; this.kind[i] = kind; this.vol[i] = volume;
    this.alive.add(i);
  }

  kill(i) {
    this.size[i] = 0; this.alpha[i] = 0;
    this.alive.delete(i); this.free.push(i);
  }

  surfaceHeight(x, y, z) {
    let h = 0;
    for (const c of this.colliders) {
      if (x > c.min.x && x < c.max.x && z > c.min.z && z < c.max.z && y > c.min.y && y <= c.max.y + 0.05) h = Math.max(h, c.max.y);
    }
    return h;
  }

  update(dt, camera, viewportHeight) {
    this.material.uniforms.scale.value = viewportHeight / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2));
    const P = this.pos, V = this.vel;
    for (const i of this.alive) {
      const i3 = i * 3;
      const k = this.kind[i];
      if (k === 0) { V[i3 + 1] -= 9.81 * dt; const drag = 1 - 0.4 * dt; V[i3] *= drag; V[i3 + 2] *= drag; }
      else { V[i3 + 1] -= 0.6 * dt; const drag = 1 - 2.5 * dt; V[i3] *= drag; V[i3 + 1] *= drag; V[i3 + 2] *= drag; this.size[i] += dt * 0.12; }
      P[i3] += V[i3] * dt; P[i3 + 1] += V[i3 + 1] * dt; P[i3 + 2] += V[i3 + 2] * dt;
      this.life[i] -= dt;
      if (k === 1) this.alpha[i] = Math.min(0.55, this.life[i]) ;
      if (k === 0 && V[i3 + 1] < 0) {
        const h = this.surfaceHeight(P[i3], P[i3 + 1], P[i3 + 2]);
        if (P[i3 + 1] <= h + 0.003) {
          this.onLand?.(P[i3], h, P[i3 + 2], this.vol[i], this.size[i]);
          this.kill(i);
          continue;
        }
      }
      if (this.life[i] <= 0 || P[i3 + 1] < -1) this.kill(i);
    }
    const g = this.geometry;
    g.attributes.position.needsUpdate = true;
    g.attributes.size.needsUpdate = true;
    g.attributes.alpha.needsUpdate = true;
    g.attributes.color.needsUpdate = true;
  }

  clear() { for (const i of [...this.alive]) this.kill(i); }
}
