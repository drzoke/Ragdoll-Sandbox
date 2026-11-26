import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

/**
 * Graphics presets.
 *  low    – no shadows, reduced resolution, fewer blood particles. For school laptops.
 *  medium – the original look: 2048 shadow map, native resolution (capped at 2x).
 *  high   – "ray-traced look": ground-truth ambient occlusion (GTAO, screen-space ray marching
 *           of the depth buffer), soft 4096 shadows, subtle bloom on bright highlights.
 *           Real hardware ray tracing isn't available to web pages, this is the closest substitute.
 */
export class Graphics {
  constructor({ renderer, scene, camera, map, gore }) {
    this.renderer = renderer; this.scene = scene; this.camera = camera; this.map = map; this.gore = gore;
    this.level = null;
    this.composer = null;
  }

  apply(level) {
    if (level === this.level) return;
    const prev = this.level;
    this.level = level;
    const r = this.renderer, sun = this.map.sun;
    const dpr = window.devicePixelRatio || 1;
    r.setPixelRatio(level === 'low' ? Math.min(dpr, 1) * 0.75 : Math.min(dpr, 2));

    const shadows = level !== 'low';
    const size = level === 'high' ? 4096 : 2048;
    const shadowChange = r.shadowMap.enabled !== shadows || sun.shadow.mapSize.x !== size;
    r.shadowMap.enabled = shadows;
    sun.castShadow = shadows;
    sun.shadow.mapSize.set(size, size);
    sun.shadow.radius = level === 'high' ? 2.5 : 1;
    sun.shadow.blurSamples = level === 'high' ? 16 : 8;
    if (sun.shadow.map) { sun.shadow.map.dispose(); sun.shadow.map = null; }
    if (shadowChange && prev) this.scene.traverse((o) => { if (o.material) for (const m of [].concat(o.material)) m.needsUpdate = true; });

    this.gore.particles.spawnScale = level === 'low' ? 0.5 : 1;

    if (level === 'high') this.buildComposer();
    else if (this.composer) { this.composer.dispose(); this.composer = null; this.passes = null; }
    this.resize();
  }

  buildComposer() {
    if (this.composer) return;
    const r = this.renderer;
    const size = r.getDrawingBufferSize(new THREE.Vector2());
    const target = new THREE.WebGLRenderTarget(size.x, size.y, { type: THREE.HalfFloatType, samples: 4 });
    const composer = new EffectComposer(r, target);
    const render = new RenderPass(this.scene, this.camera);
    const gtao = new GTAOPass(this.scene, this.camera, size.x, size.y);
    gtao.output = GTAOPass.OUTPUT.Default;
    gtao.blendIntensity = 1.0;
    gtao.updateGtaoMaterial({ radius: 0.5, distanceExponent: 1.2, thickness: 1.2, scale: 1.1, samples: 16, distanceFallOff: 1, screenSpaceRadius: false });
    gtao.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: 6, radiusExponent: 1, rings: 2, samples: 16 });
    const bloom = new UnrealBloomPass(new THREE.Vector2(size.x, size.y), 0.22, 0.5, 0.92);
    const out = new OutputPass();
    composer.addPass(render);
    composer.addPass(gtao);
    composer.addPass(bloom);
    composer.addPass(out);
    this.composer = composer;
    this.passes = { render, gtao, bloom, out };
  }

  resize() {
    const w = innerWidth, h = innerHeight;
    this.renderer.setSize(w, h, false);
    if (this.composer) {
      this.composer.setPixelRatio(this.renderer.getPixelRatio());
      this.composer.setSize(w, h);
    }
  }

  /** Main scene (with post-processing on High), then the viewmodel on top. */
  render(overlayScene, overlayCamera) {
    const r = this.renderer;
    if (this.composer) {
      r.autoClear = true;
      this.composer.render();
      r.autoClear = false;
    } else {
      r.clear();
      r.render(this.scene, this.camera);
    }
    if (overlayScene) {
      r.clearDepth();
      r.render(overlayScene, overlayCamera);
    }
  }
}
