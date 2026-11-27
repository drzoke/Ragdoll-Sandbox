import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { SSRPass } from 'three/addons/postprocessing/SSRPass.js';
import { setMaterialQuality } from './materials.js';
import { IS_TOUCH } from './core/device.js';

/**
 * Graphics presets.
 *  verylow – for weak devices: half resolution, no shadows, far fewer blood particles,
 *            flat materials and pictures instead of 3D previews in the toolbox.
 *  low    – no shadows, reduced resolution, fewer blood particles, flatter materials.
 *  medium – 2048 shadow map, native resolution (capped at 2x).
 *  high   – ambient occlusion (GTAO), soft 4096 shadows, bloom, material grime and wear.
 *  ultra  – ("Very High") high + screen-space reflections on the floor, finer AO,
 *           surface detail normal maps and stronger reflections on every model.
 */
// Effects (beams, tracers, decals, sprites) are transparent and must not end up in the depth /
// normal buffers the AO and reflection passes build, or they show up as dark shapes.
function hideTransparent(scene, cache) {
  scene.traverse((o) => {
    const m = o.material;
    if (o.visible && (o.isPoints || o.isLine || o.isSprite || (m && !Array.isArray(m) && m.transparent))) { o.visible = false; cache.push(o); }
  });
}
function restore(cache) { for (const o of cache) o.visible = true; cache.length = 0; }

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
    r.setPixelRatio(this.pixelRatio(level));

    const shadows = level !== 'low' && level !== 'verylow';
    const post = level === 'high' || level === 'ultra';
    const size = post ? 4096 : 2048;
    const shadowChange = r.shadowMap.enabled !== shadows || sun.shadow.mapSize.x !== size;
    r.shadowMap.enabled = shadows;
    sun.castShadow = shadows;
    sun.shadow.mapSize.set(size, size);
    sun.shadow.radius = level === 'ultra' ? 3 : level === 'high' ? 2.5 : 1;
    sun.shadow.blurSamples = post ? 16 : 8;
    if (sun.shadow.map) { sun.shadow.map.dispose(); sun.shadow.map = null; }
    if (shadowChange && prev) this.scene.traverse((o) => { if (o.material) for (const m of [].concat(o.material)) m.needsUpdate = true; });

    this.gore.particles.spawnScale = level === 'verylow' ? 0.3 : level === 'low' ? 0.5 : 1;

    setMaterialQuality(level);
    if (this.composer) { this.composer.dispose(); this.passes.ssr?.dispose(); this.composer = null; this.passes = null; }
    if (post) this.buildComposer(level === 'ultra');
    this.resize();
  }

  buildComposer(ultra) {
    const r = this.renderer;
    const size = r.getDrawingBufferSize(new THREE.Vector2());
    const target = new THREE.WebGLRenderTarget(size.x, size.y, { type: THREE.HalfFloatType, samples: 4 });
    const composer = new EffectComposer(r, target);
    let render, ssr = null;
    if (ultra) {
      // Screen-space reflections on the floor (the scene is rendered by the SSR pass itself).
      ssr = new SSRPass({ renderer: r, scene: this.scene, camera: this.camera, width: size.x, height: size.y, selects: [this.map.floor].filter(Boolean) });
      ssr.thickness = 0.02; ssr.maxDistance = 6; ssr.opacity = 0.32;
      ssr.infiniteThick = false; ssr.fresnel = true; ssr.distanceAttenuation = true; ssr.blur = true; ssr.bouncing = false;
      render = ssr;
    } else render = new RenderPass(this.scene, this.camera);
    if (ssr) {
      const cache = [];
      for (const fn of ['_renderOverride', '_renderMetalness']) {
        const orig = ssr[fn].bind(ssr);
        ssr[fn] = (...a) => { hideTransparent(this.scene, cache); try { orig(...a); } finally { restore(cache); } };
      }
    }
    const gtao = new GTAOPass(this.scene, this.camera, size.x, size.y);
    gtao._overrideVisibility = () => hideTransparent(this.scene, gtao._visibilityCache);
    gtao.output = GTAOPass.OUTPUT.Default;
    gtao.blendIntensity = 1.0;
    gtao.updateGtaoMaterial({ radius: 0.5, distanceExponent: 1.2, thickness: 1.2, scale: 1.1, samples: ultra ? 24 : 16, distanceFallOff: 1, screenSpaceRadius: false });
    gtao.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: ultra ? 8 : 6, radiusExponent: 1, rings: 2, samples: ultra ? 24 : 16 });
    const bloom = new UnrealBloomPass(new THREE.Vector2(size.x, size.y), ultra ? 0.3 : 0.22, 0.5, 0.9);
    const out = new OutputPass();
    composer.addPass(render);
    composer.addPass(gtao);
    composer.addPass(bloom);
    composer.addPass(out);
    this.composer = composer;
    this.passes = { render, ssr, gtao, bloom, out };
  }

  /**
   * Resolution: the screen's pixel ratio, but capped to a pixel budget per preset, so a Retina
   * laptop or a 4K monitor doesn't render 2-4x the pixels of a 1080p screen (post-processing
   * cost grows with every pixel). Phones get a slightly lower cap.
   */
  pixelRatio(level = this.level) {
    const dpr = window.devicePixelRatio || 1;
    if (level === 'verylow') return Math.min(dpr, 1) * (IS_TOUCH ? 0.6 : 0.55);
    if (level === 'low') return Math.min(dpr, IS_TOUCH ? 1.25 : 1) * 0.75;
    const budget = { medium: 4.2e6, high: 3.2e6, ultra: 3.8e6 }[level] || 4e6;   // pixels
    const fit = Math.sqrt(budget / Math.max(1, innerWidth * innerHeight));
    const max = IS_TOUCH ? (level === 'medium' ? 1.5 : 1.75) : 2;
    return Math.max(Math.min(1, dpr), Math.min(dpr, max, fit));
  }

  resize() {
    const w = innerWidth, h = innerHeight;
    if (this.level) this.renderer.setPixelRatio(this.pixelRatio());
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
