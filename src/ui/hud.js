import { CONFIG } from '../config.js';
import { clamp } from '../core/util.js';
import { XRayView } from './xray.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const VITALS = [
  { key: 'blood', label: 'Blood volume' }, { key: 'bleed', label: 'Bleeding' },
  { key: 'o2', label: 'SpO₂' }, { key: 'hr', label: 'Heart rate' },
  { key: 'pain', label: 'Pain' }, { key: 'shock', label: 'Shock' },
  { key: 'con', label: 'Consciousness' }, { key: 'resp', label: 'Breathing' },
];

export class HUD {
  constructor(scene) {
    this.el = {
      crosshair: $('crosshair'), hit: $('hitmarker'), prompt: $('prompt'), ammo: $('ammo'),
      mag: $('ammo-mag'), chamber: $('ammo-chamber'), reserve: $('ammo-reserve'), ammoName: $('ammo-name'), debug: $('debug'), toast: $('toast'),
      time: $('timescale'), toolStatus: $('toolstatus'), tsTitle: $('ts-title'), tsSub: $('ts-sub'),
      xray: $('xray'), xrName: $('xr-name'), xrState: $('xr-state'), vitals: $('xr-vitals'), bones: $('xr-bones'), organs: $('xr-organs'), log: $('xr-log'), ecg: $('ecg'),
    };
    this.el.vitals.innerHTML = VITALS.map((v) => `<div class="vital" id="v-${v.key}"><div class="lbl"><span>${v.label}</span><b>-</b></div><div class="bar"><i></i></div></div>`).join('');
    this.vitalEls = Object.fromEntries(VITALS.map((v) => {
      const root = $(`v-${v.key}`);
      return [v.key, { val: root.querySelector('b'), bar: root.querySelector('i') }];
    }));
    this.xrayOpen = false;
    this.xrayView = new XRayView($('xr-view'), scene);
    this.ecgCtx = this.el.ecg.getContext('2d');
    this.ecgX = 0; this.ecgPhase = 0;
    this.listTimer = 0;
    this.toastTimer = 0;
  }

  toggleXray() {
    this.xrayOpen = !this.xrayOpen;
    this.el.xray.classList.toggle('hidden', !this.xrayOpen);
    this.xrayView.first = true;
  }

  hitMarker(organ) {
    const h = this.el.hit;
    h.classList.remove('show', 'organ'); void h.offsetWidth;
    h.classList.add('show'); if (organ) h.classList.add('organ');
  }

  toast(text) { this.el.toast.textContent = text; this.el.toast.classList.add('show'); this.toastTimer = 2; }

  setPrompt(text) {
    if (text) { this.el.prompt.innerHTML = text; this.el.prompt.classList.add('show'); }
    else this.el.prompt.classList.remove('show');
  }

  /** Time-scale badge (slow motion / fast forward). */
  setTimeScale(ts) {
    const el = this.el.time;
    if (Math.abs(ts - 1) < 1e-3) { el.classList.remove('show'); document.body.classList.remove('slowmo', 'fastfwd'); return; }
    el.classList.add('show');
    el.querySelector('b').textContent = `${ts < 1 ? (ts >= 0.1 ? ts.toFixed(2).replace(/0$/, '') : ts.toFixed(2)) : ts.toFixed(1).replace(/\.0$/, '')}×`;
    el.querySelector('span').textContent = ts < 1 ? 'SLOW MOTION' : 'FAST FORWARD';
    document.body.classList.toggle('slowmo', ts < 1);
    document.body.classList.toggle('fastfwd', ts > 1);
  }

  update(dt, { pistol, tool, player, target, viewerPos, debugText }) {
    // Crosshair: each tool can widen it (shotgun pattern, recoil) or hide it while aiming
    const isPistol = tool === pistol;
    const ch = isPistol ? { gap: Math.max(0, 0.11 - pistol.fireT) * 120, ads: pistol.ads > 0.6 } : tool.crosshair?.() || { grab: true };
    const spread = 6 + clamp(player.speed2D / CONFIG.player.walkSpeed) * 10 + (player.onGround ? 0 : 10) + (ch.gap || 0);
    this.el.crosshair.style.setProperty('--gap', `${spread.toFixed(1)}px`);
    this.el.crosshair.classList.toggle('ads', !!ch.ads);
    this.el.crosshair.classList.toggle('grab', !!ch.grab);
    this.el.crosshair.classList.toggle('dot', !!ch.dot);
    this.el.crosshair.classList.toggle('holding', !!ch.grab && !!tool.held);

    // Ammo (guns) or a status line (other tools)
    const am = isPistol
      ? { mag: pistol.mag, chamber: pistol.chambered ? '+1' : '+0', reserve: CONFIG.weapon.infiniteReserve ? '∞' : pistol.reserve, name: 'M1911 · .45 ACP', low: pistol.mag <= 2 }
      : tool.ammo?.() || null;
    this.el.ammo.classList.toggle('hidden', !am);
    const st = am ? null : tool.status();
    this.el.toolStatus.classList.toggle('hidden', !st);
    if (st) { this.el.tsTitle.textContent = st.title; this.el.tsSub.textContent = st.sub; }
    if (am) {
      this.el.mag.textContent = am.mag;
      this.el.chamber.textContent = am.chamber;
      this.el.reserve.textContent = am.reserve;
      if (this.el.ammoName.textContent !== am.name) this.el.ammoName.textContent = am.name;
      this.el.ammo.classList.toggle('low', !!am.low);
    }

    if (this.toastTimer > 0) { this.toastTimer -= dt; if (this.toastTimer <= 0) this.el.toast.classList.remove('show'); }
    if (debugText !== null) { this.el.debug.classList.add('show'); this.el.debug.textContent = debugText; }
    else this.el.debug.classList.remove('show');

    if (!this.xrayOpen) return;
    this.xrayView.render(target, viewerPos, dt);
    this.drawEcg(dt, target);
    if (!target) {
      this.el.xrName.textContent = 'No target';
      this.el.xrState.textContent = 'Look at a ragdoll';
      return;
    }
    target.xray?.update(performance.now() / 1000);
    const h = target.health;
    this.el.xrName.textContent = target.name;
    this.el.xrState.textContent = `${h.stateLabel} · ${target.brain.activity}`;

    const bloodPct = h.bloodFrac * 100;
    const bleedMin = h.bleedRate * 60;
    this.vital('blood', `${Math.round(h.blood)} ml`, bloodPct, bloodPct < 60 ? '#ff5e4e' : bloodPct < 80 ? '#ffb340' : '#e0414f');
    this.vital('bleed', `${bleedMin.toFixed(0)} ml/min`, clamp(bleedMin / 600) * 100, bleedMin > 200 ? '#ff5e4e' : '#ff8f6a');
    this.vital('o2', `${h.o2.toFixed(0)}%`, h.o2, h.o2 < 85 ? '#ff5e4e' : h.o2 < 93 ? '#ffb340' : '#5ec8ff');
    this.vital('hr', h.heartRate < 1 ? 'Flatline' : `${h.heartRate.toFixed(0)} bpm`, clamp(h.heartRate / 180) * 100, h.heartRate < 1 || h.heartRate > 140 ? '#ff5e4e' : '#7ee08a');
    this.vital('pain', `${h.pain.toFixed(0)}%`, h.pain, h.pain > 70 ? '#ff5e4e' : h.pain > 35 ? '#ffb340' : '#ffd86a');
    this.vital('shock', h.shockLabel, h.shock, h.shock > 55 ? '#ff5e4e' : '#c58bff');
    this.vital('con', `${h.consciousness.toFixed(0)}%`, h.consciousness, h.consciousness < 25 ? '#ff5e4e' : h.consciousness < 55 ? '#ffb340' : '#9fe3ff');
    this.vital('resp', h.breathRate < 1 ? 'Apnoea' : `${h.breathRate.toFixed(0)} /min`, clamp(h.breathRate / 40) * 100, h.breathRate < 1 ? '#ff5e4e' : '#8fd0ff');

    this.listTimer -= dt;
    if (this.listTimer <= 0) { this.listTimer = 0.25; this.renderLists(h); }
  }

  vital(key, text, pct, color) {
    const v = this.vitalEls[key];
    v.val.textContent = text;
    v.bar.style.width = `${clamp(pct, 0, 100)}%`;
    v.bar.style.background = color;
  }

  renderLists(h) {
    const bones = Object.values(h.bones).map((b) => {
      const gone = !h.parts[b.part].attached;
      const status = gone ? 'Severed' : b.integrity <= 0 ? 'Shattered' : b.fractured ? `Fractured ${b.integrity.toFixed(0)}%` : `${b.integrity.toFixed(0)}%`;
      const cls = gone ? 'gone' : b.integrity <= 0 || b.fractured ? 'bad' : b.integrity < 100 ? 'warn' : '';
      return { name: b.name, status, cls, sev: gone ? 3 : b.fractured ? 2 : b.integrity < 100 ? 1 : 0 };
    });
    const organs = Object.values(h.organs).map((o) => {
      const gone = !h.parts[o.part].attached;
      const status = gone ? 'Lost' : o.hp <= 0 ? 'Destroyed' : `${o.hp.toFixed(0)}%`;
      const cls = gone ? 'gone' : o.hp <= 0 ? 'bad' : o.hp < 100 ? 'warn' : '';
      return { name: o.name, status, cls, sev: gone ? 3 : o.hp <= 0 ? 2 : o.hp < 100 ? 1 : 0 };
    });
    this.el.bones.innerHTML = listHtml(bones, 6);
    this.el.organs.innerHTML = listHtml(organs, 6);
    this.el.log.innerHTML = h.events.slice(0, 4).map((e) => `<li class="${e.severity}"><span>${esc(e.text)}</span><span>${e.t.toFixed(1)}s</span></li>`).join('') || '<li class="info"><span>No injuries yet</span></li>';
  }

  drawEcg(dt, target) {
    const c = this.ecgCtx, W = this.el.ecg.width, H = this.el.ecg.height;
    const hr = target ? target.health.heartRate : 0;
    const steps = Math.max(1, Math.round(dt * 120));
    for (let s = 0; s < steps; s++) {
      this.ecgPhase += (hr / 60) / 120;
      const p = this.ecgPhase % 1;
      let y = 0;
      if (hr > 1) {
        if (p < 0.08) y = Math.sin(p / 0.08 * Math.PI) * 0.12;
        else if (p > 0.16 && p < 0.19) y = -0.15;
        else if (p >= 0.19 && p < 0.23) y = 0.95;
        else if (p >= 0.23 && p < 0.27) y = -0.35;
        else if (p > 0.4 && p < 0.55) y = Math.sin((p - 0.4) / 0.15 * Math.PI) * 0.22;
      }
      y += (Math.random() - 0.5) * 0.03;
      const x = this.ecgX;
      c.clearRect(x, 0, 6, H);
      c.fillStyle = hr > 1 ? '#7ee08a' : '#ff5e4e';
      c.fillRect(x, H * 0.62 - y * H * 0.5, 2, 2);
      this.ecgX = (x + 1) % W;
    }
  }
}

function listHtml(items, max) {
  const sorted = [...items].sort((a, b) => b.sev - a.sev);
  const shown = sorted.filter((i) => i.sev > 0).slice(0, max);
  const intact = items.length - shown.length;
  return shown.map((i) => `<li class="${i.cls}"><span>${esc(i.name)}</span><span>${esc(i.status)}</span></li>`).join('') +
    (intact > 0 ? `<li><span>${shown.length ? 'Other' : 'All'} ${intact} intact</span><span>100%</span></li>` : '');
}
