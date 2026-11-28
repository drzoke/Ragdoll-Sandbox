import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { buildM1911, muzzleFlashTexture } from '../weapon/model1911.js';
import { buildGadget } from '../weapon/grab.js';
import { buildRemington870 } from '../weapon/model870.js';
import { buildSniper, buildMusket } from '../weapon/modelRifles.js';
import { buildGrenade } from '../weapon/grenadeModel.js';
import { buildMachete, buildMedkit, buildPaddle, buildAED } from '../weapon/modelsMedical.js';
import { ARM_MATERIALS } from '../weapon/arms.js';
import { trackMaterials } from '../materials.js';
import { buildRifle, buildSMG, buildCombatShotgun } from '../weapon/modelAuto.js';
import { buildMine, buildSentry } from '../mode/gadgets.js';

const W = 240, H = 180;

/**
 * Spinning 3D previews of the toolbox items, drawn by one small offscreen renderer and copied
 * into each card's canvas.
 *  medium – the model spins
 *  high   – plus the item's own effects (pistol cycles and flashes, the grab tool pulses and
 *           fires short energy bursts), a soft contact shadow and rim lighting
 *  ultra  – plus a glossy reflection under the model and a moving highlight
 */
export class ItemPreview {
  constructor() {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.setSize(W, H, false);
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 0.95;
    this.scene = new THREE.Scene();
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environmentIntensity = 0.7;
    this.camera = new THREE.PerspectiveCamera(30, W / H, 0.05, 20);
    this.camera.position.set(0, 0.3, 2.1);
    this.camera.lookAt(0, -0.1, 0);
    this.scene.add(new THREE.HemisphereLight(0xeef2f6, 0x4a4d52, 1.2));
    const key = new THREE.DirectionalLight(0xffffff, 2.2); key.position.set(1, 2, 1.5); this.scene.add(key);
    this.rim = new THREE.DirectionalLight(0xbfd8ff, 0); this.rim.position.set(-1.5, 0.8, -1.5); this.scene.add(this.rim);
    this.sweep = new THREE.PointLight(0xffffff, 0, 3, 2); this.scene.add(this.sweep);

    // contact shadow (high+)
    const sh = document.createElement('canvas'); sh.width = sh.height = 64;
    const g = sh.getContext('2d'); const grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    grd.addColorStop(0, 'rgba(0,0,0,0.55)'); grd.addColorStop(1, 'rgba(0,0,0,0)'); g.fillStyle = grd; g.fillRect(0, 0, 64, 64);
    this.shadow = new THREE.Mesh(new THREE.PlaneGeometry(1.4, 0.7).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(sh), transparent: true, depthWrite: false }));
    this.shadow.position.y = -0.33;
    this.scene.add(this.shadow);
    // glossy floor that the reflection shows through (ultra)
    const fc = document.createElement('canvas'); fc.width = fc.height = 128;
    const fg = fc.getContext('2d'); const fgr = fg.createRadialGradient(64, 64, 0, 64, 64, 64);
    // alphaMap reads the green channel: grey levels = opacity
    fg.fillStyle = '#000'; fg.fillRect(0, 0, 128, 128);
    fgr.addColorStop(0, 'rgb(150,150,150)'); fgr.addColorStop(0.55, 'rgb(130,130,130)'); fgr.addColorStop(1, 'rgb(0,0,0)');
    fg.fillStyle = fgr; fg.fillRect(0, 0, 128, 128);
    this.floor = new THREE.Mesh(new THREE.PlaneGeometry(1.3, 1.3).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0x1c2128, alphaMap: new THREE.CanvasTexture(fc), transparent: true, depthWrite: false }));
    this.floor.position.y = -0.34;
    this.floor.renderOrder = 1;
    this.scene.add(this.floor);

    this.items = {};
    this.items.M1911 = this.makePistol();
    this.items.Grab = this.makeGrab();
    this.items.Fists = this.makeFists();
    this.items['Remington 870'] = this.makeShotgun();
    this.items['M24 Sniper'] = this.makeSniper();
    this.items['Flintlock Musket'] = this.makeMusket();
    this.items.Grenade = this.makeGrenade();
    this.items.Machete = this.makeMachete();
    this.items.Medkit = this.makeMedkit();
    this.items.Defibrillator = this.makeDefib();
    // VS Undead
    this.items['Assault Rifle'] = this.makeSimple(buildRifle().root, 1.15);
    this.items['Submachine Gun'] = this.makeSimple(buildSMG().root, 1.0);
    this.items['Combat Shotgun'] = this.makeSimple(buildCombatShotgun().root, 1.2);
    this.items['Proximity Mine'] = this.makeSimple(buildMine().root, 0.75, 0.6);
    this.items['Sentry Gun'] = this.makeSimple(buildSentry().root, 0.9, 0);
    this.level = 'medium';
  }

  /** A model that just spins (side on, barrel to the left), with no effects of its own. */
  makeSimple(model, size = 1.05, tilt = null) {
    const root = new THREE.Group();
    root.add(model);
    if (tilt === null) model.rotation.y = Math.PI / 2; else model.rotation.x = tilt;
    const f = this.frame(root, size);
    return { ...f, effects: () => 0 };
  }

  /** Centre and scale a model so it fills the frame; returns { holder, reflection }. */
  frame(model, size = 1.05) {
    const holder = new THREE.Group();
    const inner = new THREE.Group();
    inner.add(model);
    const box = new THREE.Box3().setFromObject(model);
    const c = box.getCenter(new THREE.Vector3()), s = box.getSize(new THREE.Vector3());
    const k = size / Math.max(s.x, s.y, s.z);
    model.position.sub(c);
    inner.scale.setScalar(k);
    holder.add(inner);
    holder.position.y = 0.06;
    holder.visible = false;
    this.scene.add(holder);
    // mirrored copy under the floor
    const refl = holder.clone(true);
    refl.scale.y = -1;
    refl.position.y = 2 * -0.34 - 0.06;
    this.scene.add(refl);
    trackMaterials(model);
    return { holder, refl, inner, k };
  }

  makePistol() {
    const gun = buildM1911();
    gun.root.rotation.y = Math.PI / 2;
    const flash = new THREE.Sprite(new THREE.SpriteMaterial({ map: muzzleFlashTexture(), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }));
    flash.scale.setScalar(0.12); flash.position.set(0, 0, -0.04); flash.visible = false;
    const f = this.frame(gun.root);
    gun.muzzle.add(flash);
    return {
      ...f, effects: (t, on) => {
        // fire every 2.4 s: slide cycles, flash
        const ft = on ? (t % 2.4) : 9;
        let slide = 0;
        if (ft < 0.03) slide = ft / 0.03; else if (ft < 0.1) slide = 1 - (ft - 0.03) / 0.07;
        gun.slide.position.z = 0.03 * slide;
        flash.visible = ft < 0.05;
        flash.material.rotation = t * 7;
        return ft < 0.06 ? 1 : 0;
      },
    };
  }

  makeGrab() {
    const gad = buildGadget();
    gad.root.rotation.y = Math.PI / 2;
    const burst = new THREE.Mesh(new THREE.CylinderGeometry(0.004, 0.012, 0.4, 8, 1, true).rotateX(Math.PI / 2).translate(0, 0, -0.2),
      new THREE.MeshBasicMaterial({ color: 0xe6f3ff, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false }));
    const f = this.frame(gad.root);
    gad.muzzle.add(burst);
    return {
      ...f, effects: (t, on) => {
        const open = on ? 0.5 + 0.5 * Math.sin(t * 2.2) : 0;
        gad.prongs.forEach((h) => { h.children[0].rotation.x = -0.45 * open; });
        const pulse = on ? 0.5 + 0.5 * Math.sin(t * 9) : 0;
        gad.glowMat.emissiveIntensity = 0.8 + open * 2 + pulse * 0.8;
        gad.coils.forEach((c, i) => { c.material.emissiveIntensity = 0.3 + open * (0.8 + 0.6 * Math.sin(t * 18 - i * 1.4)); });
        const b = on ? Math.max(0, Math.sin(t * 2.2)) ** 6 : 0;
        burst.material.opacity = b * 0.9;
        burst.scale.set(1, 1, 0.3 + b);
        return b;
      },
    };
  }

  makeFists() {
    const root = new THREE.Group();
    const fists = [];
    for (const sx of [-1, 1]) {
      const arm = new THREE.Group();
      const hand = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.07, 0.08), ARM_MATERIALS.skin);
      const fore = new THREE.Mesh(new THREE.BoxGeometry(0.062, 0.062, 0.16).translate(0, 0, 0.12), ARM_MATERIALS.skin);
      const cuff = new THREE.Mesh(new THREE.BoxGeometry(0.074, 0.074, 0.03).translate(0, 0, 0.215), ARM_MATERIALS.cuff);
      const sleeve = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.07, 0.12).translate(0, 0, 0.29), ARM_MATERIALS.sleeve);
      // knuckle lines
      for (let i = 0; i < 3; i++) {
        const k = new THREE.Mesh(new THREE.BoxGeometry(0.072, 0.003, 0.004), new THREE.MeshStandardMaterial({ color: 0xb98a63, roughness: 0.8 }));
        k.position.set(0, -0.018 + i * 0.018, -0.0405); arm.add(k);
      }
      arm.add(hand, fore, cuff, sleeve);
      arm.position.set(sx * 0.07, sx * 0.012, 0);
      arm.rotation.set(0.1, sx * 0.18, 0);
      root.add(arm);
      fists.push(arm);
    }
    root.rotation.y = Math.PI / 2;
    const f = this.frame(root, 0.95);
    return {
      ...f, effects: (t, on) => {
        // alternating jabs
        fists.forEach((a, i) => {
          const ph = on ? ((t * 1.2 + i * 0.5) % 1) : 1;
          const k = ph < 0.18 ? Math.sin(ph / 0.18 * Math.PI) : 0;
          a.position.z = -k * 0.09;
        });
        return 0;
      },
    };
  }

  makeShotgun() {
    const gun = buildRemington870();
    gun.root.rotation.y = Math.PI / 2;
    const flash = new THREE.Sprite(new THREE.SpriteMaterial({ map: muzzleFlashTexture(), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }));
    flash.scale.setScalar(0.2); flash.position.set(0, 0, -0.06); flash.visible = false;
    const f = this.frame(gun.root, 1.15);
    gun.muzzle.add(flash);
    return {
      ...f, effects: (t, on) => {
        // fire, then rack the pump
        const ft = on ? (t % 2.6) : 9;
        flash.visible = ft < 0.06;
        flash.material.rotation = t * 5;
        const pr = ft > 0.3 && ft < 0.75 ? Math.sin(((ft - 0.3) / 0.45) * Math.PI) : 0;
        gun.pump.position.z = pr * 0.085;
        return ft < 0.08 ? 1 : 0;
      },
    };
  }

  makeSniper() {
    const gun = buildSniper();
    gun.root.rotation.y = Math.PI / 2;
    const flash = new THREE.Sprite(new THREE.SpriteMaterial({ map: muzzleFlashTexture(), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }));
    flash.scale.setScalar(0.24); flash.position.set(0, 0, -0.06); flash.visible = false;
    const f = this.frame(gun.root, 1.22);
    gun.muzzle.add(flash);
    return {
      ...f, effects: (t, on) => {
        // fire, then work the bolt: up, back, forward, down
        const ft = on ? (t % 3) : 9;
        flash.visible = ft < 0.06;
        flash.material.rotation = t * 5;
        const u = (a, b) => Math.min(1, Math.max(0, (ft - a) / (b - a)));
        gun.handle.rotation.z = (u(0.35, 0.45) - u(0.95, 1.05)) * 1.25;
        gun.bolt.position.z = (u(0.48, 0.62) - u(0.7, 0.85)) * 0.09;
        return ft < 0.08 ? 1 : 0;
      },
    };
  }

  makeMusket() {
    const gun = buildMusket();
    gun.root.rotation.y = Math.PI / 2;
    const flash = new THREE.Sprite(new THREE.SpriteMaterial({ map: muzzleFlashTexture(), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }));
    flash.scale.setScalar(0.34); flash.position.set(0, 0, -0.1); flash.visible = false;
    const pan = new THREE.Sprite(new THREE.SpriteMaterial({ map: muzzleFlashTexture(), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, color: 0xffd27a }));
    pan.scale.setScalar(0.1); pan.visible = false;
    const f = this.frame(gun.root, 1.25);
    gun.muzzle.add(flash); gun.panPoint.add(pan);
    return {
      ...f, effects: (t, on) => {
        // the cock falls, the pan flashes, then the shot; cocked again a while later
        const ft = on ? (t % 3.4) : 9;
        const fell = ft < 2.4;
        gun.cock.rotation.x = fell ? -0.8 : 0;
        gun.frizzen.rotation.x = fell ? -1.1 : 0;
        pan.visible = ft < 0.07;
        flash.visible = ft > 0.17 && ft < 0.24;
        flash.material.rotation = t * 5;
        return ft < 0.25 ? 1 : 0;
      },
    };
  }

  makeGrenade() {
    const gr = buildGrenade();
    const f = this.frame(gr.root, 0.62);
    const pin0 = gr.pinGroup.position.clone(), spoonRot = gr.spoon.rotation.z;
    return {
      ...f, effects: (t, on) => {
        // the pin slides out and back, the ring swings
        const ph = on ? (t % 3) : 9;
        const out = ph > 1.2 && ph < 2.2 ? Math.sin(((ph - 1.2) / 1.0) * Math.PI) : 0;
        gr.pinGroup.position.set(pin0.x - out * 0.03, pin0.y, pin0.z);
        gr.ring.rotation.z = 0.5 + Math.sin(t * 3) * 0.25 * (on ? 1 : 0);
        gr.spoon.rotation.z = spoonRot - out * 0.12;
        return 0;
      },
    };
  }

  makeMachete() {
    const m = buildMachete();
    m.root.rotation.set(0, 0, -Math.PI / 2 + 0.25);
    const f = this.frame(m.root, 1.25);
    return {
      ...f, effects: (t, on) => {
        // a quick chop every 2.5 s, the edge glints
        const ph = on ? t % 2.5 : 9;
        const k = ph < 0.25 ? Math.sin((ph / 0.25) * Math.PI) : 0;
        f.inner.rotation.z = -k * 0.5;
        m.steel.emissive?.setRGB(k * 0.25, k * 0.25, k * 0.28);
        return k;
      },
    };
  }

  makeMedkit() {
    const m = buildMedkit();
    const root = new THREE.Group();
    root.add(m.pouch);
    m.roll.position.set(0.12, -0.03, 0.03); m.roll.rotation.y = 0.5; root.add(m.roll);
    m.injector.position.set(-0.11, -0.04, 0.04); m.injector.rotation.set(0, 0, 1.3); root.add(m.injector);
    const f = this.frame(root, 0.95);
    return {
      ...f, effects: (t, on) => {
        // the bandage roll unrolls a little and bobs
        m.roll.position.y = -0.03 + (on ? Math.sin(t * 2.4) * 0.008 : 0);
        m.roll.rotation.x = on ? t * 2 : 0;
        return 0;
      },
    };
  }

  makeDefib() {
    const unit = buildAED();
    const root = new THREE.Group();
    root.add(unit.root);
    const pr = buildPaddle(1), pl = buildPaddle(-1);
    pr.root.position.set(0.19, -0.02, 0.07); pr.root.rotation.set(0.2, -0.5, -0.3);
    pl.root.position.set(-0.19, -0.02, 0.07); pl.root.rotation.set(0.2, 0.5, 0.3);
    for (const p of [pr, pl]) { p.root.scale.setScalar(1.3); root.add(p.root); }
    const f = this.frame(root, 1.05);
    return {
      ...f, effects: (t, on) => {
        // charge up and zap every 3 s
        const ph = on ? t % 3 : 9;
        const charge = ph < 1.2 ? ph / 1.2 : 0;
        const zap = ph > 1.2 && ph < 1.35 ? 1 : 0;
        unit.screen.emissiveIntensity = 0.5 + charge * 1.2 + zap * 3;
        for (const p of [pr, pl]) p.buttonMat.emissive.setRGB(1, 0.5, 0.15).multiplyScalar(charge * 0.8 + zap);
        return zap;
      },
    };
  }

  setQuality(level) { this.level = level; }

  /** Render one item into a 2D canvas context. */
  draw(name, ctx, t, hovered) {
    const item = this.items[name];
    if (!item) return;
    const fx = this.level === 'high' || this.level === 'ultra';
    const ultra = this.level === 'ultra';
    for (const it of Object.values(this.items)) { it.holder.visible = false; it.refl.visible = false; }
    item.holder.visible = true;
    item.refl.visible = ultra;
    this.shadow.visible = fx && !ultra;
    this.floor.visible = ultra;
    const spin = t * (hovered ? 1.6 : 0.8);
    item.holder.rotation.y = spin;
    item.refl.rotation.y = spin;
    const glow = item.effects(t, fx);
    this.rim.intensity = fx ? 2.2 : 0;
    this.sweep.intensity = ultra ? 1.4 + glow * 3 : glow * 2;
    this.sweep.position.set(Math.sin(t * 1.3) * 0.9, 0.4, 0.8);
    this.renderer.render(this.scene, this.camera);
    ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
    ctx.drawImage(this.renderer.domElement, 0, 0, ctx.canvas.width, ctx.canvas.height);
  }
}
